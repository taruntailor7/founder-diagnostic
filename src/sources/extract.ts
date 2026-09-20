/**
 * HTML to plain text and metadata, via cheerio.
 *
 * The publication date matters as much as the body here. It feeds the cadence
 * gap and the STALE rule, and a wrong date is worse than no date, so a date
 * that cannot be parsed confidently comes back null rather than guessed.
 */

import * as cheerio from "cheerio";
import { publisherFrom } from "./tiers.ts";

export interface Extracted {
  title: string;
  text: string;
  publishedAt: string | null;
  publisher: string;
}

/**
 * Only non-content elements are removed.
 *
 * Deliberately does NOT strip nav, header, footer or aside. The conventional
 * boilerplate recipe cut Wamda's author page from 5,833 characters to 863,
 * taking the dated post list with it, because their listing sits inside markup
 * that looks like chrome. For this tool recall beats tidiness: surplus
 * navigation text costs a few tokens, whereas missing body text costs a claim
 * and breaks the verbatim quote check that catches hallucinations.
 */
const STRIP = ["script", "style", "noscript", "form", "iframe", "svg"].join(",");

/** Candidate containers for the main body. */
const CONTENT_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  ".article-body",
  ".post-content",
  ".entry-content",
  "#content",
];

/**
 * A parse landing outside a plausible publishing window is a misinterpretation,
 * not a date. Applied to every path, including the ISO fast path, so a
 * well-formed but absurd value cannot skip the check.
 */
function plausible(iso: string): string | null {
  const year = Number.parseInt(iso.slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
  return iso;
}

/** ISO date, or null. Never a guess. */
function normaliseDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Already ISO-ish.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (iso?.[1]) return plausible(iso[1]);

  // Formats like 19-Nov-2020, as the DFSA register uses.
  const dmy = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/.exec(trimmed);
  if (dmy) {
    const parsed = Date.parse(`${dmy[1]} ${dmy[2]} ${dmy[3]} UTC`);
    if (!Number.isNaN(parsed)) {
      return plausible(new Date(parsed).toISOString().slice(0, 10));
    }
  }

  // A bare "Sep 20" parses to the current year, which would invent a
  // publication date. Require a four-digit year to be present somewhere.
  if (!/\d{4}/.test(trimmed)) return null;

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;

  return plausible(new Date(parsed).toISOString().slice(0, 10));
}

function fromJsonLd($: cheerio.CheerioAPI): string | null {
  for (const el of $("script[type='application/ld+json']").toArray()) {
    const raw = $(el).text();
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (typeof node !== "object" || node === null) continue;
        const record = node as Record<string, unknown>;
        const graph = record["@graph"];
        const candidates = Array.isArray(graph) ? graph : [record];
        for (const c of candidates) {
          if (typeof c !== "object" || c === null) continue;
          const value = (c as Record<string, unknown>)["datePublished"];
          if (typeof value === "string") {
            const date = normaliseDate(value);
            if (date) return date;
          }
        }
      }
    } catch {
      // Malformed JSON-LD is common and not worth failing over.
    }
  }
  return null;
}

export function extract(html: string, url: string): Extracted {
  const $ = cheerio.load(html);

  const meta = (selector: string, attr = "content"): string | null =>
    $(selector).first().attr(attr) ?? null;

  const title =
    meta("meta[property='og:title']") ??
    meta("meta[name='twitter:title']") ??
    $("title").first().text().trim() ??
    "";

  const publishedAt =
    normaliseDate(meta("meta[property='article:published_time']")) ??
    normaliseDate(meta("meta[name='article:published_time']")) ??
    normaliseDate(meta("meta[property='og:published_time']")) ??
    normaliseDate(meta("meta[name='date']")) ??
    normaliseDate(meta("meta[name='pubdate']")) ??
    normaliseDate(meta("meta[itemprop='datePublished']")) ??
    normaliseDate($("time[datetime]").first().attr("datetime")) ??
    fromJsonLd($) ??
    null;

  /**
   * Page titles carry a masthead tail: "Individuals | DFSA | THE INDEPENDENT
   * REGULATOR OF FINANCIAL SERVICES". Keep the shortest recognisable segment so
   * the sources appendix reads as a publisher, not a slogan.
   */
  const rawPublisher = meta("meta[property='og:site_name']")?.trim() ?? "";
  const publisher =
    rawPublisher
      .split(/\s*[|\u2013\u2014]\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length > 1 && part.length < 40)
      .sort((a, b) => a.length - b.length)[0] ||
    publisherFrom(url);

  $(STRIP).remove();

  // Take the longest candidate rather than the first match. A page can have
  // several <article> elements where the first is a teaser card, which is how
  // the Wamda listing page reduced to 123 characters.
  let body = "";
  for (const selector of CONTENT_SELECTORS) {
    for (const el of $(selector).toArray()) {
      const text = $(el).text();
      if (text.length > body.length) body = text;
    }
  }

  // Fall back to the whole page whenever the container found is not clearly
  // better than everything around it.
  const whole = $("body").text();
  if (body.trim().length < Math.max(200, whole.trim().length * 0.25)) {
    body = whole;
  }

  const text = body
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

  return { title: title.trim(), text, publishedAt, publisher };
}

/** Whitespace-normalised, for the verbatim quote check. */
export function normaliseForQuoteMatch(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the quote genuinely appears in the source.
 *
 * SPEC.md 4.4 calls this the single most effective hallucination catch in the
 * system, and it is: a model can invent a plausible sentence, but it cannot
 * make that sentence appear in text we already hold on disk.
 */
export function quoteAppearsIn(quote: string, sourceText: string): boolean {
  if (quote.trim() === "") return false;
  return normaliseForQuoteMatch(sourceText).includes(
    normaliseForQuoteMatch(quote),
  );
}
