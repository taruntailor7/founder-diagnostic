/**
 * Model client. OpenAI-compatible JSON over native fetch, no SDK.
 *
 * Every call is recorded to fixtures/llm/ keyed on model plus prompt plus
 * input, so `npm run demo` replays the exact responses the live run received
 * with no API key. In offline mode a miss throws rather than falling through
 * to the network.
 *
 * The model is never asked whether a claim is true. It extracts claims and
 * reports what a source says, with a quote that is checked against text we
 * already hold. Everything it returns is evidence fed into rules it cannot
 * influence.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { budgets, http, llm, OFFLINE, paths } from "../config.ts";
import { log } from "../log.ts";

export interface CallOptions {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}

export interface CallResult<T> {
  data: T;
  model: string;
  fromCache: boolean;
  raw: string;
}

export class LlmCacheMissError extends Error {
  constructor(key: string, model: string) {
    super(
      `Offline, and no recorded response for this call\n` +
        `  model:    ${model}\n` +
        `  expected: fixtures/llm/${key}.json\n` +
        `  Run without OFFLINE=1 to record it.`,
    );
    this.name = "LlmCacheMissError";
  }
}

export class LlmBudgetError extends Error {
  constructor(limit: number) {
    super(`model call budget of ${limit} reached; stopping this stage cleanly`);
    this.name = "LlmBudgetError";
  }
}

export class MissingKeyError extends Error {
  constructor() {
    super(
      "LLM_API_KEY is not set.\n" +
        "  Copy .env.example to .env and add an OpenRouter key.\n" +
        "  Not needed for `npm run demo`, which replays committed fixtures.",
    );
    this.name = "MissingKeyError";
  }
}

let calls = 0;
export const llmCallCount = (): number => calls;

/**
 * Client-side pacing, so we stay under the provider's limit instead of
 * discovering it.
 *
 * The first full run produced 1,130 throttle events and burned its entire call
 * budget on backoff, verifying almost nothing. Retrying politely after being
 * refused is still worse than not being refused: every 429 costs a request, a
 * wait, and a retry. One request every few seconds is dramatically faster in
 * wall-clock terms than bursting and backing off.
 */
const minIntervalMs = Math.ceil(60_000 / llm.requestsPerMinute);
let nextSlot = 0;

async function takeSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + minIntervalMs;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Records where the model returned something unusable, for AI-MISSES.md. */
const misses: string[] = [];
export const recordedMisses = (): readonly string[] => misses;

function keyFor(opts: CallOptions): string {
  return createHash("sha256")
    .update(`${opts.model}\u0000${opts.system}\u0000${opts.user}`, "utf8")
    .digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pulls a single JSON object out of a response.
 *
 * Free models are markedly worse than Claude at "return only JSON": they wrap
 * it in prose, fence it, or prepend a reasoning paragraph. Repairing that here
 * is cheaper than a retry, and a retry still happens when repair fails.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fall through to repair.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Keep going.
    }
  }

  // Outermost balanced braces, ignoring braces inside strings.
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new SyntaxError("no JSON object found in the response");
}

async function readFixture(key: string): Promise<string | null> {
  const file = path.join(paths.llmCache, `${key}.json`);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { content: string };
  return parsed.content;
}

async function writeFixture(
  key: string,
  opts: CallOptions,
  content: string,
): Promise<void> {
  await fs.mkdir(paths.llmCache, { recursive: true });
  const file = path.join(paths.llmCache, `${key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(
      { model: opts.model, system: opts.system, user: opts.user, content, recorded_at: new Date().toISOString() },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.rename(tmp, file);
}

async function post(opts: CallOptions): Promise<string> {
  if (!llm.apiKey) throw new MissingKeyError();

  for (let attempt = 1; attempt <= http.maxAttempts; attempt++) {
    await takeSlot();
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${llm.apiKey}`,
        "content-type": "application/json",
        // OpenRouter asks for these to attribute traffic.
        "http-referer": "https://github.com/taruntailor7/founder-diagnostic",
        "x-title": "founder-diagnostic",
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: llm.temperature,
        max_tokens: opts.maxTokens ?? 4000,
        // Reasoning traces are charged against the completion budget and can
        // consume all of it before the answer is emitted. OpenRouter accepts a
        // switch for that; Groq rejects the unknown property with a 400, so it
        // is sent only where it is understood.
        // Provider-specific controls for reasoning models. Both exist for the
        // same reason: reasoning tokens are charged against the completion
        // budget, and a model that thinks until the budget is gone never
        // answers. OpenRouter takes a switch; Groq takes an effort level and
        // rejects the OpenRouter form outright.
        ...(llm.baseUrl.includes("openrouter") ? { reasoning: { enabled: false } } : {}),
        ...(llm.baseUrl.includes("groq") ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const wait =
        (http.backoffMs[attempt - 1] ?? 16_000) +
        Math.floor(Math.random() * http.jitterMs);
      log.warn("model call throttled, backing off", {
        model: opts.model,
        status: res.status,
        attempt,
        waitMs: wait,
      });
      if (attempt === http.maxAttempts) {
        throw new Error(`model call failed after ${attempt} attempts: ${res.status}`);
      }
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      throw new Error(`model call failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string; reasoning?: string };
      }[];
      error?: { message?: string; code?: number };
    };

    // OpenRouter reports upstream provider failures as HTTP 200 with an error
    // body, so a 429 from the provider arrives looking like success.
    if (payload.error) {
      const upstream = payload.error.code;
      if (upstream === 429 || upstream === 503) {
        const wait =
          (http.backoffMs[attempt - 1] ?? 16_000) +
          Math.floor(Math.random() * http.jitterMs);
        log.warn("upstream provider throttled, backing off", {
          model: opts.model,
          attempt,
          waitMs: wait,
        });
        if (attempt === http.maxAttempts) {
          throw new Error(`provider unavailable after ${attempt} attempts: ${payload.error.message}`);
        }
        await sleep(wait);
        continue;
      }
      throw new Error(`model returned an error: ${payload.error.message}`);
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? "";

    if (content.trim() !== "") return content;

    // A reasoning model that ran out of budget mid-thought. The answer may be
    // inside the trace; if not, say plainly what happened rather than
    // reporting an unhelpful "empty response".
    const reasoning = choice?.message?.reasoning ?? "";
    if (reasoning.includes("{")) return reasoning;

    throw new Error(
      choice?.finish_reason === "length"
        ? `${opts.model} exhausted its token budget on reasoning and never answered; it is not usable for this task`
        : "model returned an empty response",
    );
  }

  throw new Error("model call failed: retries exhausted");
}

/**
 * One call returning parsed JSON.
 *
 * On a parse failure the call is retried once with the parse error appended,
 * which is usually enough. A second failure is recorded and surfaced to the
 * caller, which leaves the claim pending rather than inventing a result.
 */
export async function callJson<T>(opts: CallOptions): Promise<CallResult<T>> {
  const key = keyFor(opts);

  const cached = await readFixture(key);
  if (cached !== null) {
    return { data: extractJson(cached) as T, model: opts.model, fromCache: true, raw: cached };
  }

  if (OFFLINE) throw new LlmCacheMissError(key, opts.model);
  if (calls >= budgets.maxLlmCalls) throw new LlmBudgetError(budgets.maxLlmCalls);

  calls++;
  const raw = await post(opts);

  try {
    const data = extractJson(raw) as T;
    await writeFixture(key, opts, raw);
    return { data, model: opts.model, fromCache: false, raw };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("model returned unparseable JSON, retrying once", {
      model: opts.model,
      reason,
    });

    calls++;
    const repairPrompt: CallOptions = {
      ...opts,
      user:
        `${opts.user}\n\n---\nYour previous response could not be parsed as JSON: ${reason}\n` +
        `Return one JSON object and nothing else. No prose, no code fence.`,
    };

    const second = await post(repairPrompt);
    try {
      const data = extractJson(second) as T;
      await writeFixture(key, opts, second);
      return { data, model: opts.model, fromCache: false, raw: second };
    } catch (finalErr) {
      misses.push(
        `${new Date().toISOString()} ${opts.model} returned unparseable JSON twice: ` +
          `${finalErr instanceof Error ? finalErr.message : String(finalErr)}. ` +
          `First 200 chars: ${second.slice(0, 200).replace(/\s+/g, " ")}`,
      );
      throw new Error(`model returned unparseable JSON twice (${opts.model})`);
    }
  }
}

const promptCache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  const cached = promptCache.get(name);
  if (cached) return cached;
  const text = await fs.readFile(path.join(paths.prompts, name), "utf8");
  promptCache.set(name, text);
  return text;
}
