/**
 * Factories for building ledger rows in tests.
 *
 * Every field has a defensible default so a test only states the thing it is
 * actually about. A test for rule 7 should read as "all sources are
 * aggregators", not as thirty lines of scaffolding.
 */

import { Tier, TIER_LABEL } from "../src/types.ts";
import type {
  Claim,
  ClaimKind,
  Evidence,
  PredicateMatch,
  Source,
  Stance,
  TierValue,
} from "../src/types.ts";

export function makeSource(over: Partial<Source> & { id: string }): Source {
  const tier = over.tier ?? Tier.SECONDARY;
  const domain = over.domain ?? "example.com";

  const defaults: Source = {
    id: over.id,
    url: `https://${domain}/article`,
    url_canonical: `${domain}/article`,
    domain,
    publisher: domain,
    title: "Article",
    tier,
    tier_label: TIER_LABEL[tier],
    published_at: "2024-01-01",
    accessed_at: "2026-09-20T00:00:00Z",
    content_sha256: "0".repeat(64),
    cache_path: "fixtures/http/0.json",
    fetch_method: "http",
    degraded: false,
    origin_group: null,
    blocked: false,
    notes: null,
  };

  // tier_label is derived, never passed in, so it cannot drift from tier.
  return { ...defaults, ...over, tier, tier_label: TIER_LABEL[tier] };
}

/** Shorthand: a source at a given tier and domain. */
export function src(
  id: string,
  tier: TierValue,
  domain: string,
  over: Partial<Source> = {},
): Source {
  return makeSource({ id, tier, domain, ...over });
}

export const MATCH_ALL_TRUE: PredicateMatch = {
  value: true,
  measures: true,
  population: true,
  time: true,
};

export const MATCH_SILENT: PredicateMatch = {
  value: null,
  measures: null,
  population: null,
  time: null,
};

export function makeEvidence(
  over: Partial<Evidence> & { id: string; source_id: string },
): Evidence {
  return {
    claim_id: "clm_0001",
    pass: 1,
    stance: "supports",
    quote: "a verbatim sentence from the source",
    reasoning: "it states the claim directly",
    predicate_match: MATCH_ALL_TRUE,
    model: "test-model",
    created_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

/** Shorthand: one evidence row against one source. */
export function ev(
  id: string,
  source_id: string,
  stance: Stance,
  pass: 1 | 2 = 1,
  predicate_match: PredicateMatch = MATCH_ALL_TRUE,
): Evidence {
  return makeEvidence({ id, source_id, stance, pass, predicate_match });
}

export function makeClaim(over: Partial<Claim> = {}): Claim {
  const kind: ClaimKind = over.kind ?? "event";
  return {
    id: "clm_0001",
    subject_id: "subj_001",
    text: "The firm closed a fund at 100 million dollars",
    kind,
    predicate: {
      action: "closed",
      object: "first fund",
      value: { raw: "$100M", amount: 100_000_000, unit: "USD" },
      measures: "capital closed in the firm's first fund",
      population: "the firm, one fund",
      time: { raw: "2023", start: "2023-01-01", end: "2023-12-31" },
    },
    derived_from_source_id: "src_0001",
    status: "pending",
    refusal_code: null,
    refusal_note: null,
    evidence_ids: [],
    footnote_id: null,
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

export function byId(sources: readonly Source[]): Map<string, Source> {
  return new Map(sources.map((s) => [s.id, s]));
}
