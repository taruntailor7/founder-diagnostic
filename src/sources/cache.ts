/**
 * Content-addressed cache for fetched pages.
 *
 * This is what makes `npm run demo` work on a clean clone with no API key. The
 * cache is committed, so a replay reads exactly the bytes the live run read,
 * and the diagnostic reproduces rather than being regenerated.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.ts";

export interface CachedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetched_at: string;
}

export class CacheMissError extends Error {
  readonly key: string;
  readonly url: string;
  constructor(key: string, url: string) {
    super(
      `Offline, and no fixture for ${url}\n` +
        `  expected: fixtures/http/${key}.json\n` +
        `  Run without OFFLINE=1 to fetch it, or add the fixture.`,
    );
    this.name = "CacheMissError";
    this.key = key;
    this.url = url;
  }
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Strips the noise that makes the same page look like different URLs:
 * scheme, `www.`, tracking parameters, trailing slash and fragment. Two URLs
 * that canonicalise the same share a cache entry and count once as a source.
 */
export function canonicalise(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.trim().toLowerCase();
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  const drop = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !drop.test(k))
    .sort(([a], [b]) => a.localeCompare(b));

  const query =
    params.length > 0
      ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&")
      : "";

  const pathname = u.pathname.replace(/\/+$/, "") || "";
  return `${host}${pathname}${query}`;
}

export function cacheKey(url: string): string {
  return sha256(canonicalise(url));
}

export function cachePath(url: string): string {
  return path.join(paths.httpCache, `${cacheKey(url)}.json`);
}

/** Repo-relative, for the `cache_path` field in the source ledger. */
export function relativeCachePath(url: string): string {
  return `fixtures/http/${cacheKey(url)}.json`;
}

export async function read(url: string): Promise<CachedResponse | null> {
  const target = cachePath(url);
  if (!existsSync(target)) return null;
  return JSON.parse(await fs.readFile(target, "utf8")) as CachedResponse;
}

export async function write(
  url: string,
  response: CachedResponse,
): Promise<void> {
  await fs.mkdir(paths.httpCache, { recursive: true });
  const target = cachePath(url);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(response, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

export function has(url: string): boolean {
  return existsSync(cachePath(url));
}
