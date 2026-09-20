import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extract, quoteAppearsIn, normaliseForQuoteMatch } from "../src/sources/extract.ts";
import { canonicalise, cacheKey } from "../src/sources/cache.ts";

const page = (head: string, body = "<article><p>Body text goes here.</p></article>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("canonicalise", () => {
  test("drops scheme, www, trailing slash and fragment", () => {
    assert.equal(canonicalise("https://www.Example.com/a/b/#top"), "example.com/a/b");
  });

  test("strips tracking parameters but keeps meaningful ones", () => {
    assert.equal(
      canonicalise("https://example.com/a?utm_source=x&id=7&fbclid=y"),
      "example.com/a?id=7",
    );
  });

  test("sorts parameters so ordering does not create a second cache entry", () => {
    assert.equal(
      canonicalise("https://example.com/a?b=2&a=1"),
      canonicalise("https://example.com/a?a=1&b=2"),
    );
  });

  test("two spellings of the same page share a cache key", () => {
    assert.equal(
      cacheKey("https://www.dfsa.ae/public-register/firms/nuwa-capital-limited/"),
      cacheKey("http://dfsa.ae/public-register/firms/nuwa-capital-limited?utm_source=x"),
    );
  });
});

describe("extract: publication dates", () => {
  test("reads an article:published_time meta tag", () => {
    const { publishedAt } = extract(
      page(`<meta property="article:published_time" content="2021-02-16T08:00:00Z">`),
      "https://example.com/a",
    );
    assert.equal(publishedAt, "2021-02-16");
  });

  test("reads a time element", () => {
    const { publishedAt } = extract(
      page("", `<article><time datetime="2019-03-21">21 March 2019</time><p>x</p></article>`),
      "https://example.com/a",
    );
    assert.equal(publishedAt, "2019-03-21");
  });

  test("reads datePublished from JSON-LD", () => {
    const ld = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2023-09-15T10:00:00Z"}
    </script>`;
    assert.equal(extract(page(ld), "https://example.com/a").publishedAt, "2023-09-15");
  });

  test("parses the DFSA register's 19-Nov-2020 style", () => {
    const { publishedAt } = extract(
      page(`<meta name="date" content="19-Nov-2020">`),
      "https://www.dfsa.ae/x",
    );
    assert.equal(publishedAt, "2020-11-19");
  });

  test("a page with no date yields null rather than today", () => {
    assert.equal(extract(page(""), "https://example.com/a").publishedAt, null);
  });

  test("a yearless date is refused rather than silently given the current year", () => {
    // Real case: a podcast page showing "Sep 20" with no year. Date.parse would
    // happily return this year, inventing a publication date that then feeds
    // the cadence gap and the STALE rule.
    const { publishedAt } = extract(
      page(`<meta name="date" content="Sep 20">`),
      "https://example.com/a",
    );
    const thisYear = new Date().getUTCFullYear();
    assert.notEqual(publishedAt, `${thisYear}-09-20`);
  });

  test("an implausible year is refused", () => {
    assert.equal(
      extract(page(`<meta name="date" content="1823-01-01">`), "https://example.com/a").publishedAt,
      null,
    );
  });
});

describe("extract: title, publisher and body", () => {
  test("prefers og:title and og:site_name", () => {
    const result = extract(
      page(
        `<meta property="og:title" content="Nuwa aims to close $100m fund">
         <meta property="og:site_name" content="The National">`,
      ),
      "https://www.thenationalnews.com/x",
    );
    assert.equal(result.title, "Nuwa aims to close $100m fund");
    assert.equal(result.publisher, "The National");
  });

  test("falls back to the domain for publisher", () => {
    assert.equal(extract(page(""), "https://www.thenationalnews.com/x").publisher, "Thenationalnews");
  });

  test("removes scripts and styles", () => {
    const html = page(
      "",
      `<article><p>The firm closed its first fund.</p></article>
       <script>var tracking = 1;</script>
       <style>.a{color:red}</style>`,
    );
    const { text } = extract(html, "https://example.com/a");
    assert.match(text, /closed its first fund/);
    assert.doesNotMatch(text, /var tracking/);
    assert.doesNotMatch(text, /color:red/);
  });

  test("keeps content that sits inside chrome-like markup", () => {
    // Wamda's author page puts its dated post list inside markup that the
    // conventional nav/header/footer strip would delete, taking the cadence
    // evidence with it. Surplus navigation text is cheap; a lost date is not.
    const html = page(
      "",
      `<article>teaser</article>
       <aside>
         <a>The anatomy of an exit</a><span>21 March, 2019</span>
         <a>Sharing our way out of malaise</a><span>25 February, 2016</span>
       </aside>`,
    );
    const { text } = extract(html, "https://www.wamda.com/en/author/x");
    assert.match(text, /21 March, 2019/);
    assert.match(text, /25 February, 2016/);
  });

  test("prefers the longest candidate container, not the first", () => {
    const html = page(
      "",
      `<article>short teaser</article>
       <article><p>${"the substantive body of the piece ".repeat(20)}</p></article>`,
    );
    const { text } = extract(html, "https://example.com/a");
    assert.match(text, /substantive body/);
  });
});

describe("quoteAppearsIn: the hallucination catch", () => {
  const source = `Khaled  Talhouni,  Managing Partner, said the firm
remains committed to backing founders throughout their lifecycle.`;

  test("a genuine quote is found despite whitespace differences", () => {
    assert.equal(
      quoteAppearsIn("Khaled Talhouni, Managing Partner, said the firm remains committed", source),
      true,
    );
  });

  test("smart quotes and dashes are folded before matching", () => {
    assert.equal(quoteAppearsIn("\u2018Managing Partner\u2019", "the 'Managing Partner' said"), true);
    assert.equal(quoteAppearsIn("a \u2014 b", "a - b"), true);
  });

  test("a plausible sentence the source never contained is rejected", () => {
    assert.equal(
      quoteAppearsIn("Talhouni said the fund had closed at $100 million.", source),
      false,
    );
  });

  test("an empty quote is never a match", () => {
    assert.equal(quoteAppearsIn("", source), false);
    assert.equal(quoteAppearsIn("   ", source), false);
  });

  test("matching is case insensitive", () => {
    assert.equal(quoteAppearsIn("MANAGING PARTNER", source), true);
  });
});

describe("normaliseForQuoteMatch", () => {
  test("collapses whitespace and lowercases", () => {
    assert.equal(normaliseForQuoteMatch("  The   FUND  "), "the fund");
  });
});
