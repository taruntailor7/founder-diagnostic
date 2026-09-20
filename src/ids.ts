/**
 * Prefixed, zero-padded ids, per SPEC.md section 4.
 *
 * Ids are derived from what is already in the ledger rather than from a counter
 * held in memory, so a resumed run continues the sequence instead of colliding
 * with it.
 */

const WIDTH = {
  subj: 3,
  src: 4,
  clm: 4,
  ev: 4,
  og: 3,
} as const;

export type IdPrefix = keyof typeof WIDTH;

export function makeId(prefix: IdPrefix, n: number): string {
  return `${prefix}_${String(n).padStart(WIDTH[prefix], "0")}`;
}

/** Highest sequence number currently used for a prefix, or 0 if none. */
export function highest(prefix: IdPrefix, ids: readonly string[]): number {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (!m?.[1]) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Sequential id allocator seeded from existing ids.
 *
 *   const next = sequence("src", sources.map(s => s.id));
 *   next(); // "src_0005" when src_0004 was the highest
 */
export function sequence(
  prefix: IdPrefix,
  existing: readonly string[],
): () => string {
  let n = highest(prefix, existing);
  return () => makeId(prefix, ++n);
}
