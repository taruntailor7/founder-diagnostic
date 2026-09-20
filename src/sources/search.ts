/**
 * Web search without an API key.
 *
 * SPEC.md assumed Claude's server-side search tool. Free models have no such
 * tool, so discovery runs through DuckDuckGo's HTML endpoint instead, which
 * needs no key and keeps `npm run demo` honest about having no credentials.
 *
 * Search is discovery only. Nothing found here is trusted: every result still
 * has to be fetched, tiered and verified like any other URL. A failed search
 * degrades the harvest, it does not fail the run, because the seed list in
 * identity resolution already covers the sources that matter most.
 */

import * as cheerio from "cheerio";
import { http, OFFLINE } from "../config.ts";
import { log } from "../log.ts";
import * as cache from "./cache.ts";
import { countSearch, BudgetExceededError } from "./fetch.ts";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

const ENDPOINT = "https://html.duckduckgo.com/html/";

/** Search results are cached under a pseudo-URL so offline replay works. */
const cacheUrlFor = (query: string): string =>
  `search://duckduckgo/${encodeURIComponent(query)}`;

/** DuckDuckGo wraps outbound links in a redirect carrying the real URL in `uddg`. */
function unwrap(href: string): string | null {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      const u = new URL(href);
      if (u.hostname.endsWith("duckduckgo.com")) {
        const inner = u.searchParams.get("uddg");
        return inner ? decodeURIComponent(inner) : null;
      }
      return href;
    } catch {
      return null;
    }
  }
  if (href.startsWith("//duckduckgo.com/l/") || href.startsWith("/l/")) {
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const inner = u.searchParams.get("uddg");
      return inner ? decodeURIComponent(inner) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parse(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  $(".result__a, .results_links a.result__a").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const url = unwrap(href);
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

export async function search(query: string, limit = 10): Promise<SearchResult[]> {
  const pseudoUrl = cacheUrlFor(query);

  const cached = await cache.read(pseudoUrl);
  if (cached) return parse(cached.body).slice(0, limit);

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

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "user-agent": http.userAgent,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(http.timeoutMs),
    });

    if (!res.ok) {
      log.warn("search failed, continuing with seeds only", {
        query,
        status: res.status,
      });
      return [];
    }

    const body = await res.text();
    await cache.write(pseudoUrl, {
      url: pseudoUrl,
      status: res.status,
      headers: { "content-type": "text/html" },
      body,
      fetched_at: new Date().toISOString(),
    });

    const results = parse(body);
    log.info("search", { query, results: results.length });
    return results.slice(0, limit);
  } catch (err) {
    log.warn("search errored, continuing with seeds only", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
