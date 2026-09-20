/**
 * Merges claims that say the same thing.
 *
 * The same fact appears across many sources, and each extraction produces its
 * own row. Left alone, one fact restated five times would look like five facts,
 * and the diagnostic would repeat itself while the refusal ledger inflated.
 *
 * Merging is conservative. Two claims merge only when they agree on the action,
 * the object and the figure. Claims that differ on a number are kept apart
 * deliberately: that disagreement is the signal CONFLICTING_VALUES exists to
 * surface, and collapsing them would destroy it.
 */

import type { Claim } from "../types.ts";

const norm = (s: string | null | undefined): string =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Identity of a claim for merging purposes.
 *
 * The figure is part of the key, so "$24M raised" and "$25M raised" stay
 * separate and reach the labeller as a conflict rather than being silently
 * reconciled into one.
 */
export function claimKey(claim: Pick<Claim, "kind" | "predicate">): string {
  const p = claim.predicate;
  return [
    claim.kind,
    norm(p.action),
    norm(p.object),
    norm(p.value?.raw),
    norm(p.measures),
    norm(p.population),
  ].join("|");
}

export interface DedupeResult {
  claims: Claim[];
  /** Claim id to the ids it absorbed, so provenance is not lost. */
  merged: Map<string, string[]>;
}

/**
 * Secondary key: the claim sentence itself, normalised.
 *
 * Extraction phrases the predicate differently for the same fact depending on
 * the page, so predicate-keyed merging alone left four copies of "Nuwa Capital
 * Limited is regulated by the DFSA..." on the page, one of them labelled
 * VERIFIED and three PARTIALLY_VERIFIED. Identical sentences are one claim.
 */
export function textKey(claim: Pick<Claim, "kind" | "text" | "predicate">): string {
  /**
   * Claims carrying a figure keep that figure, and what it measures, in the
   * key. Two identical sentences with different numbers are two claims and one
   * of them is wrong; merging them would erase the disagreement that
   * CONFLICTING_VALUES and PREDICATE_DRIFT exist to surface.
   *
   * Claims with no figure key on the sentence alone. There is nothing to
   * conflict over, and extraction words the predicate differently for each
   * page, which previously let one sentence survive as several claims. The
   * visible symptom was "Nuwa Capital Limited is a company established in the
   * DIFC..." appearing on the page as a published claim and in the refusal
   * ledger at the same time.
   */
  const hasFigure = claim.predicate.value !== null;
  // `kind` is deliberately absent from the figureless key. The same sentence
  // came back as kind "event" from one page and "credential" from another, so
  // keying on kind published one copy and refused the other. The sentence is
  // the claim; how the model categorised it is not part of its identity.
  return hasFigure
    ? [claim.kind, norm(claim.text), norm(claim.predicate.value?.raw), norm(claim.predicate.measures)].join("|")
    : norm(claim.text);
}

export function dedupe(claims: readonly Claim[]): DedupeResult {
  const byKey = new Map<string, Claim>();
  const merged = new Map<string, string[]>();
  const seenText = new Map<string, string>();

  for (const claim of claims) {
    const tKey = textKey(claim);
    const priorKey = seenText.get(tKey);
    const key = priorKey ?? claimKey(claim);
    if (!priorKey) seenText.set(tKey, key);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, claim);
      continue;
    }

    // Keep the longer text: extraction phrasing varies and the fuller sentence
    // is usually the one a reader can evaluate without the source open.
    const keep = claim.text.length > existing.text.length
      ? { ...claim, id: existing.id, derived_from_source_id: existing.derived_from_source_id }
      : existing;

    byKey.set(key, keep);
    merged.set(existing.id, [...(merged.get(existing.id) ?? []), claim.id]);
  }

  return { claims: [...byKey.values()], merged };
}
