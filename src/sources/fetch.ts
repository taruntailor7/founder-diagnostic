/**
 * The fetch layer. SPEC.md section 7.
 *
 * Every attempt, successful or not, appends a row to fetch-events.jsonl. That
 * file is the evidence for the failure-handling criterion, so it has to record
 * what actually happened rather than only what worked. Degradation is logged,
 * never silent.
 *
 * Budgets stop a stage cleanly rather than crashing, leaving the ledger
 * resumable. Offline mode never touches the network under any circumstances.
 */

import { budgets, http, OFFLINE } from "../config.ts";
import { log } from "../log.ts";
import { appendJsonl } from "../ledger/store.ts";
import type { FetchEvent, FetchOutcome } from "../types.ts";
import * as cache from "./cache.ts";
import { domainOf } from "./tiers.ts";

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
  fromCache: boolean;
  /** True for anything that did not arrive by a clean automated fetch. */
  degraded: boolean;
  blocked: boolean;
  outcome: FetchOutcome;
}

export class BudgetExceededError extends Error {
  constructor(what: string, limit: number) {
    super(`${what} budget of ${limit} reached; stopping this stage cleanly`);
    this.name = "BudgetExceededError";
  }
}

// --- Counters -----------------------------------------------------------------

const spent = { fetches: 0, searches: 0 };

export const budgetState = () => ({
  fetches: spent.fetches,
  maxFetches: budgets.maxFetches,
  searches: spent.searches,
  maxSearches: budgets.maxSearches,
});

export function countSearch(): void {
  if (spent.searches >= budgets.maxSearches) {
    throw new BudgetExceededError("search", budgets.maxSearches);
  }
  spent.searches++;
}

// --- Concurrency --------------------------------------------------------------
// One in-flight request per domain and four globally. Politeness, and it keeps
// us off rate limits that would otherwise be self-inflicted.

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly limit: number;

  // Written out rather than as a parameter property: type stripping only
  // erases syntax, and a parameter property would need real code emitted.
  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

const globalGate = new Semaphore(http.globalConcurrency);
const domainGates = new Map<string, Semaphore>();

function gateFor(domain: string): Semaphore {
  let gate = domainGates.get(domain);
  if (!gate) {
    gate = new Semaphore(http.perDomainConcurrency);
    domainGates.set(domain, gate);
  }
  return gate;
}

// --- robots.txt ---------------------------------------------------------------

const robotsCache = new Map<string, string[]>();

/** Disallow rules that apply to us, from `User-agent: *` and our own token. */
async function disallowedPaths(origin: string): Promise<string[]> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let rules: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": http.userAgent },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      let applies = false;
      for (const raw of (await res.text()).split("\n")) {
        const line = raw.split("#")[0]?.trim() ?? "";
        const [field, ...rest] = line.split(":");
        const key = field?.trim().toLowerCase();
        const value = rest.join(":").trim();

        if (key === "user-agent") {
          applies = value === "*" || http.userAgent.toLowerCase().includes(value.toLowerCase());
        } else if (key === "disallow" && applies && value !== "") {
          rules.push(value);
        }
      }
    }
  } catch {
    // No robots.txt, or it could not be read. Absence is permission.
    rules = [];
  }

  robotsCache.set(origin, rules);
  return rules;
}

async function robotsAllows(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.pathname === "/robots.txt") return true;

  const rules = await disallowedPaths(u.origin);
  return !rules.some((rule) => u.pathname.startsWith(rule));
}

// --- Helpers ------------------------------------------------------------------

const PAYWALL_MARKERS = [
  "subscribe to continue",
  "this article is for subscribers",
  "subscribers only",
  "create an account to continue reading",
  "you have reached your article limit",
  "register to continue reading",
];

function looksPaywalled(body: string): boolean {
  const head = body.slice(0, 6000).toLowerCase();
  return PAYWALL_MARKERS.some((m) => head.includes(m));
}

function outcomeFor(status: number): FetchOutcome {
  if (status === 429) return "rate_limited";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 200 && status < 300) return "ok";
  return "blocked";
}

async function record(event: Omit<FetchEvent, "ts">): Promise<void> {
  await appendJsonl<FetchEvent>("fetch-events.jsonl", {
    ts: new Date().toISOString(),
    ...event,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffFor(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const base = http.backoffMs[attempt - 1] ?? http.backoffMs.at(-1) ?? 16_000;
  return base + Math.floor(Math.random() * http.jitterMs);
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - Date.now()) / 1000));
}

function headersToObject(headers: Headers): Record<string, string> {
  const keep = ["content-type", "last-modified", "date", "etag"];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = headers.get(k);
    if (v) out[k] = v;
  }
  return out;
}

// --- The public surface -------------------------------------------------------

/**
 * Fetches a URL, or replays it from the committed cache.
 *
 * Never throws on an HTTP failure. A page that cannot be read comes back with
 * `blocked: true` so the labeller can tell "nothing supports this" from
 * "nothing could be opened", which is the difference between NO_PRIMARY and
 * PAYWALLED_UNREADABLE.
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
  const cached = await cache.read(url);
  if (cached) {
    return {
      url: cached.url,
      status: cached.status,
      body: cached.body,
      headers: cached.headers,
      fromCache: true,
      degraded: false,
      blocked: cached.status >= 400,
      outcome: outcomeFor(cached.status),
    };
  }

  if (OFFLINE) throw new cache.CacheMissError(cache.cacheKey(url), url);

  if (spent.fetches >= budgets.maxFetches) {
    throw new BudgetExceededError("fetch", budgets.maxFetches);
  }

  if (!(await robotsAllows(url))) {
    log.warn("robots.txt disallows this path, skipping", { url });
    await record({
      url,
      outcome: "blocked",
      http_status: null,
      attempt: 0,
      retry_after_s: null,
      degraded_to: null,
      note: "disallowed by robots.txt",
    });
    return {
      url,
      status: 0,
      body: "",
      headers: {},
      fromCache: false,
      degraded: true,
      blocked: true,
      outcome: "blocked",
    };
  }

  const releaseGlobal = await globalGate.acquire();
  const releaseDomain = await gateFor(domainOf(url)).acquire();
  spent.fetches++;

  try {
    let lastStatus = 0;

    for (let attempt = 1; attempt <= http.maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "user-agent": http.userAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(http.timeoutMs),
        });

        lastStatus = res.status;
        const retryAfter = parseRetryAfter(res.headers);

        if (res.ok) {
          const body = await res.text();
          const paywalled = looksPaywalled(body);
          const outcome: FetchOutcome = paywalled ? "paywall" : "ok";

          await record({
            url,
            outcome,
            http_status: res.status,
            attempt,
            retry_after_s: null,
            degraded_to: null,
            note: paywalled ? "paywall markers detected in body" : null,
          });

          if (!paywalled) {
            await cache.write(url, {
              url,
              status: res.status,
              headers: headersToObject(res.headers),
              body,
              fetched_at: new Date().toISOString(),
            });
          }

          return {
            url,
            status: res.status,
            body: paywalled ? "" : body,
            headers: headersToObject(res.headers),
            fromCache: false,
            degraded: paywalled,
            blocked: paywalled,
            outcome,
          };
        }

        const outcome = outcomeFor(res.status);
        const retryable = res.status === 429 || res.status >= 500;

        await record({
          url,
          outcome,
          http_status: res.status,
          attempt,
          retry_after_s: retryAfter,
          degraded_to: null,
          note: retryable ? "will retry" : "not retryable",
        });

        if (!retryable || attempt === http.maxAttempts) break;

        const wait = backoffFor(attempt, retryAfter);
        log.warn("retrying", { url, status: res.status, attempt, waitMs: wait });
        await sleep(wait);
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        await record({
          url,
          outcome: timedOut ? "timeout" : "blocked",
          http_status: null,
          attempt,
          retry_after_s: null,
          degraded_to: null,
          note: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });

        if (attempt === http.maxAttempts) break;
        await sleep(backoffFor(attempt, null));
      }
    }

    // Retries exhausted. Mark it blocked rather than guessing at content.
    log.warn("giving up, marking blocked", { url, status: lastStatus });
    return {
      url,
      status: lastStatus,
      body: "",
      headers: {},
      fromCache: false,
      degraded: true,
      blocked: true,
      outcome: outcomeFor(lastStatus || 0),
    };
  } finally {
    releaseDomain();
    releaseGlobal();
  }
}

/**
 * Stores text a human pasted in for a page automated fetching cannot reach,
 * such as the DIFC and ADGM registers, which sit behind bot protection.
 *
 * Recorded as `human_paste` and `degraded: true` so the ledger shows how the
 * content arrived. The alternative, quietly treating it as a clean fetch,
 * would make the provenance trail a lie at exactly the point it matters most.
 */
export async function storePaste(url: string, text: string): Promise<void> {
  await cache.write(url, {
    url,
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: text,
    fetched_at: new Date().toISOString(),
  });

  await record({
    url,
    outcome: "human_paste",
    http_status: null,
    attempt: 0,
    retry_after_s: null,
    degraded_to: "human_paste",
    note: `${text.length} characters supplied by a human`,
  });
}
