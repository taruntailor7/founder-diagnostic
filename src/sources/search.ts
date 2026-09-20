/**
 * Discovery. Two providers, tried in order.
 *
 * DuckDuckGo's HTML endpoint needs no key and works from a laptop. It does not
 * work from a server: datacenter addresses get a challenge page rather than
 * results, and the same is true of Bing, Mojeek and every public SearXNG
 * instance tested. A hosted instance therefore needs a search API, and Tavily's
 * free tier is enough for this.
 *
 * Whichever provider answers, nothing it returns is trusted. Every URL is
 * fetched, tiered and verified exactly as a hand-supplied seed would be. Search
 * decides what gets looked at, never what gets believed.
 */

import * as cheerio from "cheerio";
import { http, llm, OFFLINE, search as searchConfig } from "../config.ts";
import { log } from "../log.ts";
import * as cache from "./cache.ts";
import { countSearch, BudgetExceededError } from "./fetch.ts";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

const cacheUrlFor = (query: string): string =>
  `search://${encodeURIComponent(query)}`;

// --- Tavily, used when a key is present ---------------------------------------

interface TavilyResponse {
  results?: { url?: string; title?: string; content?: string }[];
}

async function viaTavily(query: string, limit: number): Promise<SearchResult[] | null> {
  if (!searchConfig.tavilyKey) return null;

  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${searchConfig.tavilyKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(http.timeoutMs),
  });

  if (!res.ok) {
    log.warn("tavily search failed", { status: res.status, query });
    return null;
  }

  const payload = (await res.json()) as TavilyResponse;
  return (payload.results ?? [])
    .filter((r): r is { url: string; title?: string; content?: string } =>
      typeof r.url === "string",
    )
    .map((r) => ({
      url: r.url,
      title: (r.title ?? "").trim(),
      snippet: (r.content ?? "").trim().slice(0, 300),
    }));
}

// --- DuckDuckGo, keyless, works from a laptop ---------------------------------

/** DuckDuckGo wraps outbound links in a redirect carrying the real URL in `uddg`. */
function unwrap(href: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com")) {
      const inner = u.searchParams.get("uddg");
      return inner ? decodeURIComponent(inner) : null;
    }
    return u.protocol.startsWith("http") ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseDuckDuckGo(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  $(".result__a, .results_links a.result__a").each((_, el) => {
    const url = unwrap($(el).attr("href") ?? "");
    if (!url) return;
    const canonical = cache.canonicalise(url);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push({
      url,
      title: $(el).text().trim(),
      snippet: $(el).closest(".result").find(".result__snippet").text().trim(),
    });
  });

  return out;
}

async function viaDuckDuckGo(query: string): Promise<SearchResult[]> {
  const res = await fetch(DDG_ENDPOINT, {
    method: "POST",
    headers: {
      "user-agent": http.userAgent,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(http.timeoutMs),
  });

  // 202 is not a refusal here. DuckDuckGo answers with it routinely and the body
  // carries real results; a challenge page also arrives as 202 but parses to
  // nothing. Whether it worked is decided by what came back, not by the status.
  if (!res.ok) return [];
  return parseDuckDuckGo(await res.text());
}

// --- Entry point --------------------------------------------------------------

export async function search(query: string, limit = 10): Promise<SearchResult[]> {
  const pseudoUrl = cacheUrlFor(query);

  const cached = await cache.read(pseudoUrl);
  if (cached) return (JSON.parse(cached.body) as SearchResult[]).slice(0, limit);

  if (OFFLINE) throw new cache.CacheMissError(cache.cacheKey(pseudoUrl), pseudoUrl);

  try {
    countSearch();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      log.warn("search budget reached, skipping", { query });
      return [];
    }
    throw err;
  }

  let results: SearchResult[] = [];
  let provider = "none";

  try {
    const tavily = await viaTavily(query, limit);
    if (tavily && tavily.length > 0) {
      results = tavily;
      provider = "tavily";
    }
  } catch (err) {
    log.warn("tavily errored, falling back", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (results.length === 0) {
    try {
      results = await viaDuckDuckGo(query);
      if (results.length > 0) provider = "duckduckgo";
    } catch (err) {
      log.warn("duckduckgo errored", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (results.length === 0) {
    log.warn("no search results", {
      query,
      hint: searchConfig.tavilyKey
        ? "both providers returned nothing"
        : "no TAVILY_API_KEY set, and keyless search does not work from hosted environments",
    });
    return [];
  }

  // Cached as JSON so a replay does not depend on which provider answered.
  await cache.write(pseudoUrl, {
    url: pseudoUrl,
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(results),
    fetched_at: new Date().toISOString(),
  });

  log.info("search", { query, provider, results: results.length });
  return results.slice(0, limit);
}

export const searchProviderAvailable = (): boolean =>
  Boolean(searchConfig.tavilyKey) || !llm.baseUrl.includes("__never__");
