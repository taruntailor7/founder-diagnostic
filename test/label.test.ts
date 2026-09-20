/**
 * One case per rule in SPEC.md 6.2, in order, plus the STALE downgrade.
 *
 * Each case is built so that exactly one rule can fire. If an earlier rule
 * started matching by accident the expected rule number would change, so this
 * table also pins the ordering, not just the outcomes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { label, netStance, publishable, REFUSAL_EXPLANATION } from "../src/verify/label.ts";
import type { LabelInput } from "../src/verify/label.ts";
import { Tier } from "../src/types.ts";
import type { ClaimStatus, Evidence, RefusalCode, Source } from "../src/types.ts";
import { byId, ev, makeClaim, MATCH_ALL_TRUE, MATCH_SILENT, src } from "./helpers.ts";

interface Case {
  rule: number;
  name: string;
  sources: Source[];
  evidence: Evidence[];
  status: ClaimStatus;
  refusal: RefusalCode | null;
  identityCorroborations?: number;
  candidateSources?: Source[];
  kind?: "role" | "event" | "affiliation" | "statistic";
  now?: Date;
}

const PRIMARY = src("src_0001", Tier.PRIMARY, "dfsa.ae");
const SECONDARY_A = src("src_0002", Tier.SECONDARY, "reuters.com");
const SECONDARY_B = src("src_0003", Tier.SECONDARY, "thenationalnews.com");
const AGGREGATOR = src("src_0004", Tier.AGGREGATOR, "crunchbase.com");
const SELF = src("src_0005", Tier.SELF_REPORTED, "nuwacapital.io");

const CASES: Case[] = [
  {
    rule: 1,
    name: "identity not corroborated twice refuses before anything else is considered",
    // Deliberately given perfect evidence, to prove identity is checked first.
    sources: [PRIMARY, SECONDARY_A],
    evidence: [ev("ev_0001", "src_0001", "supports"), ev("ev_0002", "src_0002", "supports")],
    identityCorroborations: 1,
    status: "UNVERIFIED",
    refusal: "IDENTITY_AMBIGUOUS",
  },
  {
    rule: 2,
    name: "predicate drift: the figure is supported but measures something else",
    // The 71% case. Two primary-grade domains agreeing on the number is not
    // enough when the number counts a different thing.
    sources: [PRIMARY, SECONDARY_A],
    evidence: [
      ev("ev_0001", "src_0001", "supports", 1, {
        value: true,
        measures: false,
        population: false,
        time: true,
      }),
      ev("ev_0002", "src_0002", "supports"),
    ],
    status: "UNVERIFIED",
    refusal: "PREDICATE_DRIFT",
  },
  {
    rule: 3,
    name: "the two passes reached opposite conclusions",
    sources: [SECONDARY_A, SECONDARY_B],
    evidence: [
      ev("ev_0001", "src_0002", "supports", 1),
      ev("ev_0002", "src_0003", "contradicts", 2),
    ],
    status: "UNVERIFIED",
    refusal: "PASSES_DISAGREE",
  },
  {
    rule: 4,
    name: "a credible source contradicts, with no opposing pass to escalate",
    sources: [SECONDARY_A],
    evidence: [ev("ev_0001", "src_0002", "contradicts", 1)],
    status: "UNVERIFIED",
    refusal: "CONFLICTING_VALUES",
  },
  {
    rule: 5,
    name: "nothing supports it because every candidate was blocked or paywalled",
    sources: [],
    evidence: [],
    candidateSources: [
      src("src_0006", Tier.PRIMARY, "adgm.com", { blocked: true }),
      src("src_0007", Tier.SECONDARY, "ft.com", { blocked: true }),
    ],
    status: "UNVERIFIED",
    refusal: "PAYWALLED_UNREADABLE",
  },
  {
    rule: 6,
    name: "nothing supports it on the merits",
    sources: [],
    evidence: [],
    status: "UNVERIFIED",
    refusal: "NO_PRIMARY",
  },
  {
    rule: 7,
    name: "aggregators only establish nothing",
    sources: [AGGREGATOR],
    evidence: [ev("ev_0001", "src_0004", "supports")],
    status: "UNVERIFIED",
    refusal: "NO_PRIMARY",
  },
  {
    rule: 8,
    name: "the subject describing themselves is kept, but not as fact",
    sources: [SELF],
    evidence: [ev("ev_0001", "src_0005", "supports")],
    status: "PARTIALLY_VERIFIED",
    refusal: "SELF_REPORTED_ONLY",
  },
  {
    rule: 9,
    name: "two independent domains with a primary record and nothing disputed",
    sources: [PRIMARY, SECONDARY_A],
    evidence: [ev("ev_0001", "src_0001", "supports"), ev("ev_0002", "src_0002", "supports")],
    status: "VERIFIED",
    refusal: null,
  },
  {
    rule: 10,
    name: "corroborated across outlets, but nothing first-hand behind it",
    sources: [
      src("src_0002", Tier.SECONDARY, "reuters.com", { origin_group: "og_001" }),
      src("src_0003", Tier.SECONDARY, "thenationalnews.com", { origin_group: "og_002" }),
    ],
    evidence: [ev("ev_0001", "src_0002", "supports"), ev("ev_0002", "src_0003", "supports")],
    status: "PARTIALLY_VERIFIED",
    refusal: "NO_PRIMARY",
  },
  {
    rule: 11,
    name: "one primary record, authoritative but uncorroborated",
    sources: [PRIMARY],
    evidence: [ev("ev_0001", "src_0001", "supports")],
    status: "PARTIALLY_VERIFIED",
    // Not NO_PRIMARY: a primary record is exactly what fired this rule.
    refusal: "UNCORROBORATED",
  },
  {
    rule: 12,
    name: "the substance holds and only the date is disputed",
    sources: [SECONDARY_A],
    evidence: [
      ev("ev_0001", "src_0002", "supports", 1, {
        value: true,
        measures: true,
        population: true,
        time: false,
      }),
    ],
    status: "PARTIALLY_VERIFIED",
    refusal: "CONFLICTING_VALUES",
  },
  {
    rule: 13,
    name: "anything that matches no rule fails closed",
    sources: [SECONDARY_A],
    evidence: [ev("ev_0001", "src_0002", "supports", 1, MATCH_ALL_TRUE)],
    status: "UNVERIFIED",
    refusal: "NO_PRIMARY",
  },
];

describe("label: one case per rule, in order", () => {
  for (const c of CASES) {
    test(`rule ${c.rule}: ${c.name}`, () => {
      const input: LabelInput = {
        claim: makeClaim({ kind: c.kind ?? "event" }),
        evidence: c.evidence,
        sourcesById: byId([...c.sources, ...(c.candidateSources ?? [])]),
        candidateSources: c.candidateSources ?? c.sources,
        identityCorroborations: c.identityCorroborations ?? 2,
        now: c.now ?? new Date("2026-09-20T00:00:00Z"),
      };

      const result = label(input);

      assert.equal(result.rule, c.rule, `expected rule ${c.rule}, got ${result.rule}: ${result.note}`);
      assert.equal(result.status, c.status);
      assert.equal(result.refusal_code, c.refusal);
    });
  }
});

describe("STALE downgrade", () => {
  const stale = (kind: "role" | "affiliation" | "event") =>
    label({
      claim: makeClaim({ kind }),
      evidence: [ev("ev_0001", "src_0001", "supports"), ev("ev_0002", "src_0002", "supports")],
      sourcesById: byId([
        src("src_0001", Tier.PRIMARY, "dfsa.ae", { published_at: "2018-01-01" }),
        src("src_0002", Tier.SECONDARY, "reuters.com", { published_at: "2018-06-01" }),
      ]),
      identityCorroborations: 2,
      now: new Date("2026-09-20T00:00:00Z"),
    });

  test("a role verified only by sources over five years old is downgraded", () => {
    const result = stale("role");
    assert.equal(result.status, "PARTIALLY_VERIFIED");
    assert.equal(result.refusal_code, "STALE");
  });

  test("affiliations are downgraded on the same basis", () => {
    assert.equal(stale("affiliation").refusal_code, "STALE");
  });

  test("a dated event is not stale: it happened, and it stays happened", () => {
    const result = stale("event");
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.refusal_code, null);
  });

  test("a recent role is not downgraded", () => {
    const result = label({
      claim: makeClaim({ kind: "role" }),
      evidence: [ev("ev_0001", "src_0001", "supports"), ev("ev_0002", "src_0002", "supports")],
      sourcesById: byId([
        src("src_0001", Tier.PRIMARY, "dfsa.ae", { published_at: "2025-01-01" }),
        src("src_0002", Tier.SECONDARY, "reuters.com", { published_at: "2025-06-01" }),
      ]),
      identityCorroborations: 2,
      now: new Date("2026-09-20T00:00:00Z"),
    });
    assert.equal(result.status, "VERIFIED");
  });
});

describe("circular sourcing changes the explanation, not the verdict", () => {
  test("many outlets tracing to one origin is reported as CIRCULAR_SOURCING", () => {
    const sources = [
      src("src_0001", Tier.SECONDARY, "bloomberg.com", { origin_group: "og_001" }),
      src("src_0002", Tier.SECONDARY, "thenationalnews.com", { origin_group: "og_001" }),
      src("src_0003", Tier.SECONDARY, "zawya.com", { origin_group: "og_001" }),
    ];
    const result = label({
      claim: makeClaim(),
      evidence: sources.map((s, i) => ev(`ev_000${i + 1}`, s.id, "supports")),
      sourcesById: byId(sources),
      identityCorroborations: 2,
      now: new Date("2026-09-20T00:00:00Z"),
    });

    assert.equal(result.refusal_code, "CIRCULAR_SOURCING");
    assert.equal(result.independent_source_ids.length, 1);
  });
});

describe("netStance", () => {
  test("contradiction dominates agreement", () => {
    assert.equal(
      netStance([ev("ev_0001", "src_0001", "supports"), ev("ev_0002", "src_0002", "contradicts")]),
      "contradicts",
    );
  });

  test("support wins over silence", () => {
    assert.equal(
      netStance([ev("ev_0001", "src_0001", "not_found"), ev("ev_0002", "src_0002", "supports")]),
      "supports",
    );
  });

  test("nothing found is none", () => {
    assert.equal(netStance([ev("ev_0001", "src_0001", "not_found")]), "none");
    assert.equal(netStance([]), "none");
  });
});

describe("silence is not agreement", () => {
  test("a source that says nothing about the predicate cannot verify it", () => {
    const result = label({
      claim: makeClaim(),
      evidence: [
        ev("ev_0001", "src_0001", "supports", 1, MATCH_SILENT),
        ev("ev_0002", "src_0002", "supports", 1, MATCH_SILENT),
      ],
      sourcesById: byId([PRIMARY, SECONDARY_A]),
      identityCorroborations: 2,
      now: new Date("2026-09-20T00:00:00Z"),
    });

    assert.notEqual(result.status, "VERIFIED");
  });
});

describe("publishability and refusal explanations", () => {
  test("UNVERIFIED never reaches the document body", () => {
    assert.equal(publishable({ status: "UNVERIFIED" }), false);
    assert.equal(publishable({ status: "pending" }), false);
    assert.equal(publishable({ status: "VERIFIED" }), true);
    assert.equal(publishable({ status: "PARTIALLY_VERIFIED" }), true);
  });

  test("every refusal code a rule can emit has a plain-English explanation", () => {
    const emitted = new Set<RefusalCode>();
    for (const c of CASES) if (c.refusal) emitted.add(c.refusal);
    emitted.add("STALE");
    emitted.add("CIRCULAR_SOURCING");

    for (const code of emitted) {
      const text = REFUSAL_EXPLANATION[code];
      assert.ok(text && text.length > 20, `${code} needs an explanation a non-technical reader can use`);
    }
  });
});
