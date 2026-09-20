/**
 * Near-duplicate grouping, so recycled press releases count once.
 *
 * Five outlets running the same announcement look like five independent
 * corroborations to anything that counts sources naively. They are one. This
 * groups them before the labeller ever sees them, which is why
 * CIRCULAR_SOURCING can be detected rather than merely asserted.
 */

const SHINGLE_SIZE = 5;
export const JACCARD_THRESHOLD = 0.6;

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Set of n-word sequences. Word order matters, so paraphrase scores low. */
export function shingles(text: string, n: number = SHINGLE_SIZE): Set<string> {
  const words = normalise(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length > 0) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i <= words.length - n; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const s of small) if (large.has(s)) intersection++;

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Union-find, so grouping is transitive ------------------------------------
// If A matches B and B matches C, all three are one origin even when A and C
// fall below the threshold against each other. A press release rewritten in
// stages still traces back to one origin.

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    // Path compression.
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur] as number;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface Groupable {
  id: string;
  text: string;
}

/**
 * Assigns an `og_NNN` id to each input. Inputs that share substantially the
 * same body share a group.
 */
export function groupByOrigin(
  items: readonly Groupable[],
  threshold: number = JACCARD_THRESHOLD,
): Map<string, string> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;

  const fingerprints = items.map((item) => shingles(item.text));
  const uf = new UnionFind(items.length);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = fingerprints[i];
      const b = fingerprints[j];
      if (!a || !b) continue;
      if (jaccard(a, b) >= threshold) uf.union(i, j);
    }
  }

  // Number groups by first appearance, so ids are stable across runs given
  // stable input order.
  const rootToGroup = new Map<number, string>();
  let next = 0;
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    let group = rootToGroup.get(root);
    if (!group) {
      group = `og_${String(++next).padStart(3, "0")}`;
      rootToGroup.set(root, group);
    }
    const item = items[i];
    if (item) result.set(item.id, group);
  }

  return result;
}
