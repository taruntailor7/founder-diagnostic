/**
 * Counting how many genuinely independent sources support a claim.
 *
 * "Independent" means one per origin group, not one per URL. Five outlets
 * carrying the same wire copy collapse to a single representative, so a claim
 * cannot reach VERIFIED on the strength of one press release travelling well.
 */

import type { Evidence, Source } from "../types.ts";

/**
 * Picks the representative for an origin group: highest tier first, then the
 * earliest publication date.
 *
 * Highest tier because if a regulator and a blog carry the same text, the
 * regulator is the origin. Earliest date because among equals the first to
 * publish is the one the others copied.
 */
export function pickRepresentative(group: readonly Source[]): Source | null {
  if (group.length === 0) return null;

  return group.reduce((best, candidate) => {
    if (candidate.tier !== best.tier) {
      return candidate.tier > best.tier ? candidate : best;
    }
    // Undated sources never displace a dated one.
    if (!candidate.published_at) return best;
    if (!best.published_at) return candidate;
    return candidate.published_at < best.published_at ? candidate : best;
  });
}

/**
 * Independent sources backing the supporting evidence for one claim.
 *
 * Sources with no origin group are treated as their own group, which is the
 * safe reading: an ungrouped source has not been shown to duplicate anything.
 */
export function independentSources(
  evidence: readonly Evidence[],
  sourcesById: ReadonlyMap<string, Source>,
): Source[] {
  const supporting = evidence.filter((e) => e.stance === "supports");

  const byGroup = new Map<string, Source[]>();
  for (const e of supporting) {
    const source = sourcesById.get(e.source_id);
    if (!source) continue;
    const key = source.origin_group ?? `__ungrouped__${source.id}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(source);
    else byGroup.set(key, [source]);
  }

  const out: Source[] = [];
  for (const group of byGroup.values()) {
    const rep = pickRepresentative(group);
    if (rep) out.push(rep);
  }

  // Stable order: highest tier first, then id, so labelling is deterministic.
  out.sort((a, b) => b.tier - a.tier || a.id.localeCompare(b.id));
  return out;
}

/**
 * True when the supporting evidence spans more than one URL but collapses to a
 * single origin. This is the signal that distinguishes CIRCULAR_SOURCING from
 * simply having one source.
 */
export function isCircular(
  evidence: readonly Evidence[],
  sourcesById: ReadonlyMap<string, Source>,
): boolean {
  const supporting = evidence.filter((e) => e.stance === "supports");
  const distinctSources = new Set(supporting.map((e) => e.source_id));
  if (distinctSources.size < 2) return false;
  return independentSources(evidence, sourcesById).length === 1;
}

export function uniqueDomains(sources: readonly Source[]): string[] {
  return [...new Set(sources.map((s) => s.domain))].sort();
}

export function maxTier(sources: readonly Source[]): number {
  return sources.reduce((max, s) => Math.max(max, s.tier), 0);
}
