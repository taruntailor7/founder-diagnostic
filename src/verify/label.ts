/**
 * Deterministic labelling. No model involvement, by design.
 *
 * SPEC.md section 6.2, thirteen rules evaluated in order, first match wins.
 *
 * This is the answer to "what happens when it is wrong". A model that scores
 * its own confidence will be confidently wrong. A model that supplies evidence
 * into a rule it cannot influence can only be wrong about the evidence, and
 * these rules then catch thin evidence regardless of how certain the prose
 * around it sounded.
 *
 * Pure function. Same inputs, same label, every time, and every branch is
 * covered by test/label.test.ts.
 */

import { Tier } from "../types.ts";
import type {
  Claim,
  ClaimStatus,
  Evidence,
  PredicateMatch,
  RefusalCode,
  Source,
} from "../types.ts";
import {
  independentSources,
  isCircular,
  maxTier,
  uniqueDomains,
} from "./independence.ts";

/** A supporting source older than this stops supporting a present-tense role. */
const STALE_YEARS = 5;

export interface LabelInput {
  claim: Claim;
  evidence: readonly Evidence[];
  sourcesById: ReadonlyMap<string, Source>;
  /**
   * Sources considered for this claim, including ones that could not be read.
   * Needed to tell "nothing supports this" from "nothing could be opened".
   */
  candidateSources?: readonly Source[];
  /** Independent corroborations that sources refer to this person, not a namesake. */
  identityCorroborations: number;
  /** Defaults to now. Injectable so STALE is testable without freezing time. */
  now?: Date;
}

export interface LabelResult {
  status: ClaimStatus;
  refusal_code: RefusalCode | null;
  note: string | null;
  /** Which numbered rule decided this, for the audit trail and the review UI. */
  rule: number;
  independent_source_ids: string[];
  domains: string[];
}

type NetStance = "supports" | "contradicts" | "none";

/** SPEC.md 8.3. Contradiction dominates: one credible denial outweighs assent. */
export function netStance(evidence: readonly Evidence[]): NetStance {
  if (evidence.some((e) => e.stance === "contradicts")) return "contradicts";
  if (evidence.some((e) => e.stance === "supports")) return "supports";
  return "none";
}

/**
 * `false` means the source addressed this aspect and disagreed. `null` means
 * the source was silent, which is not agreement but is not a conflict either.
 * Only an explicit `false` blocks.
 */
const hasFalse = (m: PredicateMatch, keys: (keyof PredicateMatch)[]): boolean =>
  keys.some((k) => m[k] === false);

const anyFieldFalse = (m: PredicateMatch): boolean =>
  hasFalse(m, ["value", "measures", "population", "time"]);

function yearsBetween(from: string, to: Date): number {
  const then = new Date(from).getTime();
  if (Number.isNaN(then)) return 0;
  return (to.getTime() - then) / (365.25 * 24 * 60 * 60 * 1000);
}

export function label(input: LabelInput): LabelResult {
  const {
    claim,
    evidence,
    sourcesById,
    candidateSources = [],
    identityCorroborations,
    now = new Date(),
  } = input;

  const supporting = evidence.filter((e) => e.stance === "supports");
  const contradicting = evidence.filter((e) => e.stance === "contradicts");

  const S = independentSources(evidence, sourcesById);
  const domains = uniqueDomains(S);
  const top = maxTier(S);
  const circular = isCircular(evidence, sourcesById);

  const done = (
    rule: number,
    status: ClaimStatus,
    refusal_code: RefusalCode | null,
    note: string | null = null,
  ): LabelResult => ({
    status,
    refusal_code,
    note,
    rule,
    independent_source_ids: S.map((s) => s.id),
    domains,
  });

  // 1. Identity first. If we cannot establish that the sources are about this
  //    person rather than a namesake, nothing downstream is worth evaluating.
  if (identityCorroborations < 2) {
    return done(
      1,
      "UNVERIFIED",
      "IDENTITY_AMBIGUOUS",
      `only ${identityCorroborations} independent identity corroboration(s); two are required`,
    );
  }

  // 2. Predicate drift. The figure may be real and the source may exist while
  //    the number measures something else, or covers a different population.
  //    This is checked before source counting on purpose: no amount of
  //    corroboration rescues a claim the sources do not actually make.
  const drifted = supporting.find((e) =>
    hasFalse(e.predicate_match, ["measures", "population"]),
  );
  if (drifted) {
    const which = [
      drifted.predicate_match.measures === false ? "measures" : null,
      drifted.predicate_match.population === false ? "population" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return done(
      2,
      "UNVERIFIED",
      "PREDICATE_DRIFT",
      `source ${drifted.source_id} supports the figure but not its ${which}`,
    );
  }

  // 3. The two passes reached opposite conclusions. Escalate to a human rather
  //    than picking a winner automatically.
  const net1 = netStance(evidence.filter((e) => e.pass === 1));
  const net2 = netStance(evidence.filter((e) => e.pass === 2));
  const opposed =
    (net1 === "supports" && net2 === "contradicts") ||
    (net1 === "contradicts" && net2 === "supports");
  if (opposed) {
    return done(
      3,
      "UNVERIFIED",
      "PASSES_DISAGREE",
      `confirming pass returned ${net1}, disconfirming pass returned ${net2}`,
    );
  }

  // 4. Something credible contradicts it.
  if (contradicting.length > 0) {
    return done(
      4,
      "UNVERIFIED",
      "CONFLICTING_VALUES",
      `${contradicting.length} source(s) contradict this claim`,
    );
  }

  // 5. Nothing supports it because nothing could be read. Distinct from
  //    nothing supporting it on the merits, and the distinction is the
  //    public-sources-only rule showing up in the output.
  if (S.length === 0 && candidateSources.length > 0) {
    const allUnreadable = candidateSources.every((s) => s.blocked);
    if (allUnreadable) {
      return done(
        5,
        "UNVERIFIED",
        "PAYWALLED_UNREADABLE",
        `all ${candidateSources.length} candidate source(s) were paywalled or blocked`,
      );
    }
  }

  // 6. Nothing supports it.
  if (S.length === 0) {
    return done(6, "UNVERIFIED", "NO_PRIMARY", "no supporting source found");
  }

  // 7. Aggregators only. Recycled or user-editable material establishes nothing.
  if (S.every((s) => s.tier === Tier.AGGREGATOR)) {
    return done(
      7,
      "UNVERIFIED",
      circular ? "CIRCULAR_SOURCING" : "NO_PRIMARY",
      circular
        ? "several aggregators carry this, but they trace to one origin"
        : "every supporting source is an aggregator",
    );
  }

  // 8. The subject describing themselves. Kept as self-description, never
  //    promoted to established fact.
  if (S.every((s) => s.tier === Tier.SELF_REPORTED)) {
    return done(
      8,
      "PARTIALLY_VERIFIED",
      "SELF_REPORTED_ONLY",
      "the only source is the subject describing themselves",
    );
  }

  const noConflictedFields = !supporting.some((e) =>
    anyFieldFalse(e.predicate_match),
  );

  /**
   * A figure, where the claim makes one, must be affirmatively matched rather
   * than merely not contradicted.
   *
   * Conditional on the claim actually carrying a figure. Requiring
   * `value === true` unconditionally silently barred every claim without a
   * number from ever reaching VERIFIED, including "Nuwa Capital Limited is a
   * DIFC Company" backed by the regulator's own register, because there was no
   * value for a source to affirm.
   */
  const claimHasValue = claim.predicate.value !== null;
  const valueAffirmed =
    !claimHasValue || supporting.some((e) => e.predicate_match.value === true);

  // 9. The only route to VERIFIED: two independent domains, a primary record
  //    among them, nothing contradicting, and no predicate field disputed.
  if (
    domains.length >= 2 &&
    top === Tier.PRIMARY &&
    contradicting.length === 0 &&
    noConflictedFields &&
    valueAffirmed
  ) {
    const verified = done(9, "VERIFIED", null);
    return applyStale(verified, claim, S, now);
  }

  // 10. Corroborated across domains, but no first-hand record behind it.
  if (domains.length >= 2 && top === Tier.SECONDARY) {
    return done(
      10,
      "PARTIALLY_VERIFIED",
      circular ? "CIRCULAR_SOURCING" : "NO_PRIMARY",
      circular
        ? "multiple outlets carry this, but they trace to one origin"
        : "corroborated across outlets, but no primary record establishes it",
    );
  }

  // 11. A primary record, but only one. Authoritative and uncorroborated.
  //
  // SPEC.md 6.2 assigns NO_PRIMARY here. That is the one place the spec
  // contradicts itself: the rule fires precisely because a primary source
  // exists, and printing "no primary source establishes this" beneath a
  // regulator citation is simply false. UNCORROBORATED says the true thing,
  // which is that nothing independent stands beside it.
  if (domains.length === 1 && top === Tier.PRIMARY) {
    return done(
      11,
      "PARTIALLY_VERIFIED",
      "UNCORROBORATED",
      "a primary record establishes this, but no independent source corroborates it",
    );
  }

  // 12. The substance holds and only the date is disputed.
  const timeOnly = supporting.find(
    (e) =>
      e.predicate_match.time === false &&
      e.predicate_match.value !== false &&
      e.predicate_match.measures !== false &&
      e.predicate_match.population !== false,
  );
  if (timeOnly) {
    return done(
      12,
      "PARTIALLY_VERIFIED",
      "CONFLICTING_VALUES",
      "value agrees, date does not",
    );
  }

  // 13. Everything else fails closed.
  return done(
    13,
    "UNVERIFIED",
    circular ? "CIRCULAR_SOURCING" : "NO_PRIMARY",
    "evidence does not meet any verification rule",
  );
}

/**
 * A role or affiliation held five years ago is not evidence that it is held
 * now. Downgrades VERIFIED rather than refusing, because the claim was true
 * and may still be; what is missing is anything current.
 */
function applyStale(
  result: LabelResult,
  claim: Claim,
  S: readonly Source[],
  now: Date,
): LabelResult {
  if (result.status !== "VERIFIED") return result;
  if (claim.kind !== "role" && claim.kind !== "affiliation") return result;

  const dates = S.map((s) => s.published_at).filter(
    (d): d is string => typeof d === "string" && d.length > 0,
  );
  if (dates.length === 0) return result;

  const newest = dates.reduce((a, b) => (a > b ? a : b));
  if (yearsBetween(newest, now) <= STALE_YEARS) return result;

  return {
    ...result,
    status: "PARTIALLY_VERIFIED",
    refusal_code: "STALE",
    note: `newest supporting source is from ${newest}, more than ${STALE_YEARS} years old, and nothing current corroborates it`,
  };
}

/** SPEC.md 6.3. UNVERIFIED claims never reach the document body. */
export function publishable(claim: Pick<Claim, "status">): boolean {
  return claim.status === "VERIFIED" || claim.status === "PARTIALLY_VERIFIED";
}

/** SPEC.md 6.4. Printed in the refusal ledger on the diagnostic itself. */
export const REFUSAL_EXPLANATION: Record<RefusalCode, string> = {
  NO_PRIMARY:
    "Every supporting source is secondary or an aggregator. No filing, register entry or first-hand record establishes this.",
  SELF_REPORTED_ONLY:
    "The only source is the subject describing themselves. Retained as self-description, never as established fact.",
  CIRCULAR_SOURCING:
    "Several outlets carry this, but they trace to one origin, usually a press release. That is one source, not several.",
  CONFLICTING_VALUES:
    "Credible sources disagree on the value or date, and nothing authoritative settles it.",
  PREDICATE_DRIFT:
    "The figure is real and the cited study exists, but the figure measures something other than what the claim asserts.",
  IDENTITY_AMBIGUOUS:
    "Could not establish that the source refers to this person rather than someone sharing the name.",
  PAYWALLED_UNREADABLE:
    "The only source sits behind a paywall or login, so it was not accessed, per the public-sources-only rule.",
  PASSES_DISAGREE:
    "The confirming pass and the disconfirming pass reached opposite conclusions. Escalated rather than resolved automatically.",
  STALE:
    "The supporting source is old enough that the claim may no longer hold, and nothing current corroborates it.",
  UNCORROBORATED:
    "A primary record establishes this, and nothing independent stands beside it. Retained, but resting on a single source.",
};
