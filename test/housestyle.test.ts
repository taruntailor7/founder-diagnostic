import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lint, latestDecisions } from "../src/render/housestyle.ts";
import type { LintContext, LintRule } from "../src/render/housestyle.ts";
import type { Approval, Claim, ClaimStatus } from "../src/types.ts";

function ctx(
  claims: Array<{ id: string; status: ClaimStatus }> = [],
  approvals: Approval[] = [],
): LintContext {
  return {
    claimsById: new Map(claims.map((c) => [c.id, c as Pick<Claim, "id" | "status">])),
    approvals,
  };
}

const approved = (claim_id: string): Approval => ({
  ts: "2026-09-20T00:00:00Z",
  claim_id,
  decision: "approve",
  reviewer: "Tarun Tailor",
  note: null,
});

/** A minimal document that passes everything, used as the base for negatives. */
const GOOD = `He is a licensed director.[^1]

[^1]: claim:clm_0001 | https://www.dfsa.ae/public-register/individuals/x | DFSA Public Register, primary, published 2020-11-19, accessed 2026-09-20`;

const GOOD_CTX = ctx([{ id: "clm_0001", status: "VERIFIED" }], [approved("clm_0001")]);

const rules = (md: string, c: LintContext = GOOD_CTX): LintRule[] =>
  lint(md, c).map((v) => v.rule);

describe("a clean document passes", () => {
  test("no violations", () => {
    assert.deepEqual(lint(GOOD, GOOD_CTX), []);
  });
});

describe("NO_EM_DASH", () => {
  test("an em dash fails", () => {
    assert.ok(rules("He is a director \u2014 and a partner.").includes("NO_EM_DASH"));
  });

  test("a spaced en dash used as an em dash fails", () => {
    assert.ok(rules("He is a director \u2013 and a partner.").includes("NO_EM_DASH"));
  });

  test("a double hyphen fails", () => {
    assert.ok(rules("He is a director -- and a partner.").includes("NO_EM_DASH"));
  });

  test("an en dash inside a range is left alone", () => {
    assert.ok(!rules("The period 2016\u20132019 is covered.[^1]").includes("NO_EM_DASH"));
  });

  test("an ordinary hyphen is fine", () => {
    assert.ok(!rules("A well-known co-founder.").includes("NO_EM_DASH"));
  });
});

describe("NO_HASHTAG", () => {
  test("a hashtag fails", () => {
    assert.ok(rules("Great news #fintech").includes("NO_HASHTAG"));
  });

  test("a markdown heading is not a hashtag", () => {
    assert.ok(!rules("# Heading\n\n## Subheading").includes("NO_HASHTAG"));
  });
});

describe("NO_FILLER", () => {
  test("blocklisted words fail", () => {
    assert.ok(rules("We leverage a robust and seamless approach.").includes("NO_FILLER"));
    assert.ok(rules("Moreover, this is a testament to his work.").includes("NO_FILLER"));
  });

  test("matching is case insensitive", () => {
    assert.ok(rules("DELVE into the detail.").includes("NO_FILLER"));
  });

  test("a word merely containing a blocklisted term is not flagged", () => {
    // "unlock" is blocked; "unlocked" as part of a longer word should not fire
    // on the hyphen-and-word-char boundary.
    assert.ok(!rules("The relocated office moved.").includes("NO_FILLER"));
  });

  test("clean prose passes", () => {
    assert.ok(!rules("He founded the firm and it holds a licence.").includes("NO_FILLER"));
  });
});

describe("NUMBER_NEEDS_FOOTNOTE", () => {
  test("a bare numeral with no footnote fails", () => {
    assert.ok(rules("The fund closed at 100 million dollars.").includes("NUMBER_NEEDS_FOOTNOTE"));
  });

  test("the same numeral with a footnote passes", () => {
    assert.ok(!rules(GOOD.replace("He is a licensed director.", "The fund closed at 100 million dollars.")).includes("NUMBER_NEEDS_FOOTNOTE"));
  });

  test("digits inside a URL do not need their own footnote", () => {
    const md = `See the register.[^1]

[^1]: claim:clm_0001 | https://www.dfsa.ae/public-register/2020/11/19 | DFSA, primary`;
    assert.ok(!rules(md).includes("NUMBER_NEEDS_FOOTNOTE"));
  });

  test("digits in front matter are exempt", () => {
    const md = `---
pipeline_version: 1.0.0
assessed_at: 2026-09-20
---

He is a licensed director.[^1]

[^1]: claim:clm_0001 | https://example.com/x | DFSA, primary`;
    assert.ok(!rules(md).includes("NUMBER_NEEDS_FOOTNOTE"));
  });

  test("the digits inside a footnote marker do not themselves need a footnote", () => {
    assert.ok(!rules(GOOD).includes("NUMBER_NEEDS_FOOTNOTE"));
  });
});

describe("footnote integrity", () => {
  test("FOOTNOTE_UNDEFINED: a marker with no definition fails", () => {
    assert.ok(rules("He is a director.[^9]", GOOD_CTX).includes("FOOTNOTE_UNDEFINED"));
  });

  test("FOOTNOTE_ORPHAN: a definition nothing references fails", () => {
    const md = `${GOOD}
[^2]: claim:clm_0001 | https://example.com/y | Other, secondary`;
    assert.ok(rules(md).includes("FOOTNOTE_ORPHAN"));
  });

  test("FOOTNOTE_NO_PROVENANCE: a definition naming neither a claim nor a source fails", () => {
    const md = `He is a director.[^1]

[^1]: https://example.com/x | DFSA Public Register, primary`;
    assert.ok(rules(md).includes("FOOTNOTE_NO_PROVENANCE"));
  });

  test("FOOTNOTE_CLAIM_MISSING: a claim id absent from the ledger fails", () => {
    const md = `He is a director.[^1]

[^1]: claim:clm_9999 | https://example.com/x | DFSA, primary`;
    assert.ok(rules(md).includes("FOOTNOTE_CLAIM_MISSING"));
  });

  test("FOOTNOTE_CLAIM_UNPUBLISHABLE: pointing at an UNVERIFIED claim fails", () => {
    const c = ctx([{ id: "clm_0001", status: "UNVERIFIED" }], [approved("clm_0001")]);
    assert.ok(rules(GOOD, c).includes("FOOTNOTE_CLAIM_UNPUBLISHABLE"));
  });

  test("FOOTNOTE_CLAIM_UNPUBLISHABLE: pointing at a pending claim fails", () => {
    const c = ctx([{ id: "clm_0001", status: "pending" }], [approved("clm_0001")]);
    assert.ok(rules(GOOD, c).includes("FOOTNOTE_CLAIM_UNPUBLISHABLE"));
  });

  test("FOOTNOTE_CLAIM_UNAPPROVED: no approval recorded fails", () => {
    const c = ctx([{ id: "clm_0001", status: "VERIFIED" }], []);
    assert.ok(rules(GOOD, c).includes("FOOTNOTE_CLAIM_UNAPPROVED"));
  });

  test("FOOTNOTE_CLAIM_UNAPPROVED: a rejection fails", () => {
    const c = ctx(
      [{ id: "clm_0001", status: "VERIFIED" }],
      [{ ...approved("clm_0001"), decision: "reject" }],
    );
    assert.ok(rules(GOOD, c).includes("FOOTNOTE_CLAIM_UNAPPROVED"));
  });

  test("a later approval supersedes an earlier rejection", () => {
    const c = ctx(
      [{ id: "clm_0001", status: "VERIFIED" }],
      [
        { ...approved("clm_0001"), decision: "reject", ts: "2026-09-20T00:00:00Z" },
        { ...approved("clm_0001"), ts: "2026-09-20T01:00:00Z" },
      ],
    );
    assert.deepEqual(lint(GOOD, c), []);
  });
});

describe("computed observations cite sources, not claims", () => {
  const withSources = (blocked: boolean): LintContext => ({
    claimsById: new Map(),
    approvals: [],
    sourcesById: new Map([["src_0002", { id: "src_0002", blocked }]]),
  });

  const COMPUTED = `The longest silence was 37 months.[^g1]

[^g1]: source:src_0002 | computed by this tool from the ledger, CADENCE_GAP | 2 dated sources`;

  test("a computed observation needs no approval, only a real source", () => {
    assert.deepEqual(lint(COMPUTED, withSources(false)), []);
  });

  test("FOOTNOTE_SOURCE_MISSING: a source id absent from the ledger fails", () => {
    const ctxMissing: LintContext = {
      claimsById: new Map(),
      approvals: [],
      sourcesById: new Map(),
    };
    assert.ok(rules(COMPUTED, ctxMissing).includes("FOOTNOTE_SOURCE_MISSING"));
  });

  test("FOOTNOTE_SOURCE_UNREADABLE: measuring from a blocked source fails", () => {
    // A number computed from a page we never managed to read is not evidence.
    assert.ok(rules(COMPUTED, withSources(true)).includes("FOOTNOTE_SOURCE_UNREADABLE"));
  });
});

describe("latestDecisions", () => {
  test("the last line for a claim wins", () => {
    const decisions = latestDecisions([
      { ...approved("clm_0001"), decision: "hold" },
      { ...approved("clm_0001"), decision: "approve" },
    ]);
    assert.equal(decisions.get("clm_0001")?.decision, "approve");
  });
});

describe("violations report a usable location", () => {
  test("line, column and excerpt are populated", () => {
    const md = `First line is clean.\nThe fund closed at 100 million.`;
    const [v] = lint(md, GOOD_CTX);
    assert.ok(v);
    assert.equal(v.line, 2);
    assert.ok(v.column > 0);
    assert.match(v.excerpt, /The fund closed/);
  });
});
