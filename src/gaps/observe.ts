/**
 * Gap metrics, computed from the ledger. No model involvement.
 *
 * SPEC.md section 10. Each observer returns a score between 0 and 1 and the
 * raw numbers behind it. The model is later handed these numbers and asked to
 * write prose around them; it never computes one. The rendered figures must
 * match these byte for byte, and that is asserted before the document is
 * written.
 */

import { Tier } from "../types.ts";
import type { Claim, GapObservation, Source } from "../types.ts";

export interface ObserveInput {
  claims: readonly Claim[];
  sources: readonly Source[];
  /** Cached page text by source id, for topic comparison. */
  textBySourceId: ReadonlyMap<string, string>;
  now?: Date;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// --- PROOF_GAP ----------------------------------------------------------------

/**
 * Claims that circulate publicly but cannot be substantiated.
 *
 * This is the gap that reframes the refusal ledger as the subject's own risk:
 * these are things said about them in public that a diligent counterparty
 * cannot verify. It leads the diagnostic when it holds up, because it is
 * exactly what Growpido sells.
 */
function proofGap(input: ObserveInput): GapObservation {
  const sourcesById = new Map(input.sources.map((s) => [s.id, s]));

  const unverified = input.claims.filter((c) => {
    if (c.status !== "UNVERIFIED") return false;
    const origin = sourcesById.get(c.derived_from_source_id);
    return !origin || origin.tier <= Tier.SECONDARY;
  });

  const total = input.claims.length;
  const share = total > 0 ? unverified.length / total : 0;

  return {
    id: "PROOF_GAP",
    score: clamp01(unverified.length / 5),
    observation:
      `${unverified.length} of ${total} extracted claims circulate in secondary or ` +
      `aggregator coverage without a primary source behind them`,
    metrics: {
      unverified_in_circulation: unverified.length,
      total_claims: total,
      share_unverified: Number(share.toFixed(3)),
    },
    evidence_source_ids: [
      ...new Set(unverified.map((c) => c.derived_from_source_id)),
    ],
    caveat: null,
  };
}

// --- NARRATIVE_OWNERSHIP_GAP --------------------------------------------------

function narrativeOwnershipGap(input: ObserveInput): GapObservation {
  const readable = input.sources.filter((s) => !s.blocked);
  const own = readable.filter((s) => s.tier === Tier.SELF_REPORTED);
  const thirdParty = readable.filter((s) => s.tier !== Tier.SELF_REPORTED);

  const ratio = own.length > 0 ? thirdParty.length / own.length : thirdParty.length;

  return {
    id: "NARRATIVE_OWNERSHIP_GAP",
    score: clamp01(ratio / 6),
    observation:
      `${thirdParty.length} of ${readable.length} public sources are written by ` +
      `third parties, against ${own.length} the subject controls`,
    metrics: {
      third_party_sources: thirdParty.length,
      self_authored_sources: own.length,
      ratio: Number(ratio.toFixed(2)),
    },
    evidence_source_ids: thirdParty.slice(0, 6).map((s) => s.id),
    caveat: null,
  };
}

// --- TOPIC_GAP ----------------------------------------------------------------

const STOPWORDS = new Set(
  ("the a an and or but of to in for on at by with from as is are was were be been " +
    "it its this that these those he she they we you i his her their our your my " +
    "said says say will would can could has have had not no yes new more most other " +
    "about into over under after before than then them him us who whom which what " +
    "when where why how all any both each few many some such only own same so too very")
    .split(" "),
);

function keywordsOf(text: string, limit = 40): Set<string> {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (raw.length < 5 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word]) => word),
  );
}

/** Subjects journalists associate with the person that the person never raises. */
function topicGap(input: ObserveInput): GapObservation {
  const textFor = (predicate: (s: Source) => boolean): string =>
    input.sources
      .filter((s) => !s.blocked && predicate(s))
      .map((s) => input.textBySourceId.get(s.id) ?? "")
      .join("\n");

  const coverage = keywordsOf(textFor((s) => s.tier === Tier.SECONDARY));
  const own = keywordsOf(textFor((s) => s.tier === Tier.SELF_REPORTED), 200);

  const missing = [...coverage].filter((word) => !own.has(word));
  const share = coverage.size > 0 ? missing.length / coverage.size : 0;

  return {
    id: "TOPIC_GAP",
    score: clamp01(share),
    observation:
      `${missing.length} of the ${coverage.size} topics that recur in independent ` +
      `coverage do not appear anywhere in the subject's own published material`,
    metrics: {
      topics_in_coverage: coverage.size,
      topics_absent_from_own_material: missing.length,
      share_absent: Number(share.toFixed(3)),
      examples: missing.slice(0, 8).join(", "),
    },
    evidence_source_ids: input.sources
      .filter((s) => s.tier === Tier.SECONDARY && !s.blocked)
      .slice(0, 5)
      .map((s) => s.id),
    caveat: null,
  };
}

// --- CADENCE_GAP --------------------------------------------------------------

const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;

/**
 * Publishing rhythm across datable open-web artifacts.
 *
 * Not LinkedIn cadence. Post history requires a login and the rules forbid it,
 * so this measures what is actually observable: dated articles, register
 * entries, bylined posts, podcast episodes. The caveat travels with the number
 * into the rendered document rather than being dropped in a footnote.
 */
function cadenceGap(input: ObserveInput): GapObservation {
  const now = input.now ?? new Date();

  const dated = input.sources
    .filter((s) => !s.blocked && s.published_at)
    .map((s) => ({ id: s.id, at: new Date(s.published_at as string) }))
    .filter((d) => !Number.isNaN(d.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (dated.length < 2) {
    return {
      id: "CADENCE_GAP",
      score: 0,
      observation: `only ${dated.length} datable public artifact(s) were found, too few to measure a rhythm`,
      metrics: { datable_artifacts: dated.length },
      evidence_source_ids: dated.map((d) => d.id),
      caveat:
        "Measured across datable open-web artifacts, not LinkedIn activity, because post history requires a login.",
    };
  }

  let longest = 0;
  let longestFrom = "";
  let longestTo = "";
  let overThreeMonths = 0;

  for (let i = 1; i < dated.length; i++) {
    const prev = dated[i - 1];
    const cur = dated[i];
    if (!prev || !cur) continue;
    const months = (cur.at.getTime() - prev.at.getTime()) / MONTH_MS;
    if (months > 3) overThreeMonths++;
    if (months > longest) {
      longest = months;
      longestFrom = prev.at.toISOString().slice(0, 10);
      longestTo = cur.at.toISOString().slice(0, 10);
    }
  }

  const newest = dated.at(-1) as { id: string; at: Date };
  const sinceLast = (now.getTime() - newest.at.getTime()) / MONTH_MS;

  return {
    id: "CADENCE_GAP",
    score: clamp01(Math.max(longest, sinceLast) / 24),
    observation:
      `across ${dated.length} datable public artifacts the longest silence was ` +
      `${Math.round(longest)} months, between ${longestFrom} and ${longestTo}`,
    metrics: {
      datable_artifacts: dated.length,
      longest_gap_months: Math.round(longest),
      longest_gap_from: longestFrom,
      longest_gap_to: longestTo,
      gaps_over_three_months: overThreeMonths,
      months_since_most_recent: Math.round(sinceLast),
    },
    evidence_source_ids: dated.map((d) => d.id).slice(0, 8),
    caveat:
      "Measured across datable open-web artifacts, not LinkedIn posting. Post history requires a login, which this tool does not use.",
  };
}

// --- DISCOVERABILITY_GAP ------------------------------------------------------

function discoverabilityGap(input: ObserveInput): GapObservation {
  const readable = input.sources.filter((s) => !s.blocked);
  const count = (tier: number) => readable.filter((s) => s.tier === tier).length;

  const self = count(Tier.SELF_REPORTED);
  const aggregator = count(Tier.AGGREGATOR);
  const total = readable.length || 1;
  const aggregatorShare = aggregator / total;

  return {
    id: "DISCOVERABILITY_GAP",
    score: clamp01(aggregatorShare * 1.5),
    observation:
      `${aggregator} of ${total} discoverable sources are aggregator profiles the ` +
      `subject does not control, against ${self} they do`,
    metrics: {
      aggregator_sources: aggregator,
      self_controlled_sources: self,
      secondary_sources: count(Tier.SECONDARY),
      primary_sources: count(Tier.PRIMARY),
      aggregator_share: Number(aggregatorShare.toFixed(3)),
    },
    evidence_source_ids: readable
      .filter((s) => s.tier === Tier.AGGREGATOR)
      .slice(0, 5)
      .map((s) => s.id),
    caveat: null,
  };
}

// --- Entry point --------------------------------------------------------------

export function observeAll(input: ObserveInput): GapObservation[] {
  return [
    proofGap(input),
    narrativeOwnershipGap(input),
    topicGap(input),
    cadenceGap(input),
    discoverabilityGap(input),
  ];
}

/**
 * The three that lead the diagnostic.
 *
 * PROOF_GAP is promoted when it has any substance at all, because it is the
 * one that reframes the refusal ledger as the subject's own exposure and it is
 * the reason this document is worth reading.
 */
export function topThree(gaps: readonly GapObservation[]): GapObservation[] {
  const ranked = [...gaps].sort((a, b) => {
    const weight = (g: GapObservation) => g.score + (g.id === "PROOF_GAP" ? 0.15 : 0);
    return weight(b) - weight(a);
  });
  return ranked.slice(0, 3);
}
