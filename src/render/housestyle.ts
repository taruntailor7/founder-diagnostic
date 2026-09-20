/**
 * The house-style linter. SPEC.md section 11.
 *
 * Four house rules, enforced as a build failure rather than a review comment:
 * no em dashes, no hashtags, no AI filler vocabulary, and no number published
 * without a source.
 *
 * The last one does the real work. Every numeral in the body must sit in a
 * sentence carrying a footnote marker, every marker must resolve to a
 * definition, every definition must name a claim id, and that claim must be
 * both publishable and approved by a human. A number cannot reach the page
 * without a chain back to a signed-off ledger row.
 */

import type { Approval, Claim } from "../types.ts";

export type LintRule =
  | "NO_EM_DASH"
  | "NO_HASHTAG"
  | "NO_FILLER"
  | "NUMBER_NEEDS_FOOTNOTE"
  | "FOOTNOTE_UNDEFINED"
  | "FOOTNOTE_NO_PROVENANCE"
  | "FOOTNOTE_CLAIM_MISSING"
  | "FOOTNOTE_CLAIM_UNPUBLISHABLE"
  | "FOOTNOTE_CLAIM_UNAPPROVED"
  | "FOOTNOTE_SOURCE_MISSING"
  | "FOOTNOTE_SOURCE_UNREADABLE"
  | "FOOTNOTE_ORPHAN";

export interface Violation {
  rule: LintRule;
  line: number;
  column: number;
  message: string;
  excerpt: string;
}

/**
 * Words that signal a machine wrote the sentence. Matched whole-word and
 * case-insensitively.
 */
export const FILLER = [
  "delve",
  "leverage",
  "robust",
  "seamless",
  "landscape",
  "game-changer",
  "game changer",
  "testament to",
  "navigate the complexities",
  "in today's fast-paced",
  "moreover",
  "furthermore",
  "elevate",
  "unlock",
  "harness",
  "cutting-edge",
  "holistic",
  "synergy",
  "paradigm",
  "tapestry",
  "dive into",
  "it's worth noting",
  "at the end of the day",
] as const;

const FOOTNOTE_MARKER = /\[\^([^\]]+)\]/g;
const FOOTNOTE_DEF_LINE = /^\[\^([^\]]+)\]:(.*)$/;
const URL_PATTERN = /https?:\/\/\S+/g;
/**
 * A footnote resolves to one of two kinds of provenance, and the distinction
 * is deliberate.
 *
 * `claim:` is an assertion about the subject, taken from a document. It must be
 * publishable and carry a human approval.
 *
 * `source:` is a measurement this tool computed over the ledger, such as the
 * longest gap between datable artifacts. Nobody asserted it, so there is no
 * claim to approve; what it needs is the specific sources it was computed from,
 * and they must be ones we could actually read. Routing these through `claim:`
 * would mean inventing claims nobody made, and exempting them would mean
 * printing numbers with no provenance at all.
 */
const CLAIM_TOKEN = /claim:(\S+)/;
const SOURCE_TOKEN = /source:(\S+)/;

/**
 * The house rule is "no number published without a source". A numeral is
 * sourced in exactly three ways, and these are the other two.
 *
 * A refusal code on the same line means the document is asserting the opposite
 * of a claim: this figure circulates and we could not establish it. Demanding a
 * footnote there would be incoherent, since a refused claim has nothing to
 * footnote to.
 *
 * An inline URL means the line carries its own provenance, which is what the
 * sources appendix is.
 */
const REFUSAL_CODE_TOKEN =
  /`(NO_PRIMARY|SELF_REPORTED_ONLY|CIRCULAR_SOURCING|CONFLICTING_VALUES|PREDICATE_DRIFT|IDENTITY_AMBIGUOUS|PAYWALLED_UNREADABLE|PASSES_DISAGREE|STALE)`/;

interface Position {
  line: number;
  column: number;
}

/** Character offset to 1-based line and column. */
function positionAt(text: string, offset: number): Position {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}

/**
 * Regions excluded from the prose rules, computed once before anything runs.
 * Front matter is metadata, definition lines are machine-readable provenance,
 * and URLs and markers legitimately contain digits, dashes and hashes.
 */
function buildExemptMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const cover = (start: number, end: number) => {
    for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) {
      mask[i] = true;
    }
  };

  // Front matter: everything between the first two `---` lines.
  const lines = text.split("\n");
  if (lines[0]?.trim() === "---") {
    let offset = lines[0].length + 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "---") {
        cover(0, offset + line.length);
        break;
      }
      offset += line.length + 1;
    }
  }

  // Footnote definition lines.
  let offset = 0;
  for (const line of lines) {
    if (FOOTNOTE_DEF_LINE.test(line)) cover(offset, offset + line.length);
    offset += line.length + 1;
  }

  for (const m of text.matchAll(URL_PATTERN)) {
    if (m.index !== undefined) cover(m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(FOOTNOTE_MARKER)) {
    if (m.index !== undefined) cover(m.index, m.index + m[0].length);
  }

  return mask;
}

/**
 * Sentence segmentation by splitting on terminal punctuation followed by
 * whitespace. Naive, and its limits are named in the README: an abbreviation
 * such as "Dr. Smith" splits into two sentences, which can only ever make the
 * number rule stricter, never laxer.
 */
function sentencesOf(text: string, from: number): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let start = 0;
  const re = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index + 1), offset: from + start });
    start = m.index + 1;
  }
  if (start < text.length) {
    out.push({ text: text.slice(start), offset: from + start });
  }
  return out;
}

export interface LintContext {
  claimsById: ReadonlyMap<string, Pick<Claim, "id" | "status">>;
  approvals: readonly Approval[];
  /** Present when the document cites computed observations. */
  sourcesById?: ReadonlyMap<string, { id: string; blocked: boolean }>;
}

/** Latest decision wins, per SPEC.md 4.5. */
export function latestDecisions(
  approvals: readonly Approval[],
): Map<string, Approval> {
  const out = new Map<string, Approval>();
  for (const a of approvals) out.set(a.claim_id, a);
  return out;
}

export function lint(markdown: string, ctx: LintContext): Violation[] {
  const violations: Violation[] = [];
  const mask = buildExemptMask(markdown);
  const lines = markdown.split("\n");

  const add = (rule: LintRule, offset: number, message: string) => {
    const { line, column } = positionAt(markdown, offset);
    const excerpt = (lines[line - 1] ?? "").trim().slice(0, 100);
    violations.push({ rule, line, column, message, excerpt });
  };

  const exempt = (i: number) => mask[i] === true;

  // --- Prose rules ------------------------------------------------------------

  for (let i = 0; i < markdown.length; i++) {
    if (exempt(i)) continue;
    const ch = markdown[i];

    if (ch === "\u2014") {
      add("NO_EM_DASH", i, "em dash (U+2014); rewrite the sentence or use a comma");
    } else if (
      ch === "\u2013" &&
      /\s/.test(markdown[i - 1] ?? "") &&
      /\s/.test(markdown[i + 1] ?? "")
    ) {
      add("NO_EM_DASH", i, "spaced en dash (U+2013) used as an em dash");
    } else if (markdown.startsWith(" -- ", i)) {
      add("NO_EM_DASH", i, "double hyphen used as an em dash");
    }
  }

  for (const m of markdown.matchAll(/(^|\s)(#[A-Za-z0-9_]+)/gm)) {
    if (m.index === undefined) continue;
    const at = m.index + (m[1]?.length ?? 0);
    if (exempt(at)) continue;
    add("NO_HASHTAG", at, `hashtag ${m[2]} is not house style`);
  }

  for (const word of FILLER) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundaries only where the term starts and ends with a word char,
    // so multi-word phrases and hyphenated terms still match correctly.
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "gi");
    for (const m of markdown.matchAll(re)) {
      if (m.index === undefined || exempt(m.index)) continue;
      add("NO_FILLER", m.index, `"${m[0]}" is on the filler blocklist`);
    }
  }

  // --- Numbers must resolve to a footnote -------------------------------------

  let offset = 0;
  for (const line of lines) {
    const isDefinition = FOOTNOTE_DEF_LINE.test(line);
    const isFrontMatter = exempt(offset) && line.trim() !== "";
    // A line carrying a refusal code or its own URL is already sourced.
    const selfSourced = REFUSAL_CODE_TOKEN.test(line) || URL_PATTERN.test(line);
    URL_PATTERN.lastIndex = 0;

    if (!isDefinition && !isFrontMatter && !selfSourced) {
      for (const sentence of sentencesOf(line, offset)) {
        let hasBareNumber = false;
        let numberAt = -1;
        for (let i = 0; i < sentence.text.length; i++) {
          const abs = sentence.offset + i;
          if (exempt(abs)) continue;
          if (/\d/.test(sentence.text[i] ?? "")) {
            hasBareNumber = true;
            numberAt = abs;
            break;
          }
        }
        if (hasBareNumber && !FOOTNOTE_MARKER.test(sentence.text)) {
          add(
            "NUMBER_NEEDS_FOOTNOTE",
            numberAt,
            "a numeral appears in a sentence with no footnote marker",
          );
        }
        FOOTNOTE_MARKER.lastIndex = 0;
      }
    }
    offset += line.length + 1;
  }

  // --- Footnote integrity -----------------------------------------------------

  const definitions = new Map<string, { body: string; offset: number }>();
  offset = 0;
  for (const line of lines) {
    const m = FOOTNOTE_DEF_LINE.exec(line);
    if (m?.[1]) definitions.set(m[1], { body: m[2] ?? "", offset });
    offset += line.length + 1;
  }

  const referenced = new Set<string>();
  FOOTNOTE_MARKER.lastIndex = 0;
  for (const m of markdown.matchAll(FOOTNOTE_MARKER)) {
    if (m.index === undefined) continue;
    // A marker inside a definition line is the definition's own label.
    const { line } = positionAt(markdown, m.index);
    if (FOOTNOTE_DEF_LINE.test(lines[line - 1] ?? "")) continue;

    const id = m[1] as string;
    referenced.add(id);
    if (!definitions.has(id)) {
      add("FOOTNOTE_UNDEFINED", m.index, `footnote [^${id}] has no definition`);
    }
  }

  const decisions = latestDecisions(ctx.approvals);

  for (const [id, def] of definitions) {
    if (!referenced.has(id)) {
      add("FOOTNOTE_ORPHAN", def.offset, `footnote [^${id}] is defined but never referenced`);
    }

    const claimMatch = CLAIM_TOKEN.exec(def.body);
    const sourceMatch = SOURCE_TOKEN.exec(def.body);

    if (!claimMatch?.[1] && !sourceMatch?.[1]) {
      add(
        "FOOTNOTE_NO_PROVENANCE",
        def.offset,
        `footnote [^${id}] names neither a claim id nor a source id`,
      );
      continue;
    }

    // A computed observation: check the sources it was measured from exist and
    // were readable. There is no claim to approve.
    if (!claimMatch?.[1] && sourceMatch?.[1]) {
      const sourceId = sourceMatch[1];
      const source = ctx.sourcesById?.get(sourceId);
      if (!source) {
        add(
          "FOOTNOTE_SOURCE_MISSING",
          def.offset,
          `footnote [^${id}] references ${sourceId}, which is not in sources.json`,
        );
      } else if (source.blocked) {
        add(
          "FOOTNOTE_SOURCE_UNREADABLE",
          def.offset,
          `footnote [^${id}] is computed from ${sourceId}, which was blocked and never read`,
        );
      }
      continue;
    }

    const claimId = claimMatch?.[1] as string;
    const claim = ctx.claimsById.get(claimId);
    if (!claim) {
      add(
        "FOOTNOTE_CLAIM_MISSING",
        def.offset,
        `footnote [^${id}] references ${claimId}, which is not in claims.json`,
      );
      continue;
    }

    if (claim.status === "UNVERIFIED" || claim.status === "pending") {
      add(
        "FOOTNOTE_CLAIM_UNPUBLISHABLE",
        def.offset,
        `footnote [^${id}] references ${claimId}, whose status is ${claim.status}`,
      );
    }

    if (decisions.get(claimId)?.decision !== "approve") {
      const actual = decisions.get(claimId)?.decision ?? "no decision recorded";
      add(
        "FOOTNOTE_CLAIM_UNAPPROVED",
        def.offset,
        `footnote [^${id}] references ${claimId}, which has ${actual} rather than an approval`,
      );
    }
  }

  return violations.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `  ${String(v.line).padStart(4)}:${String(v.column).padEnd(3)} ${v.rule.padEnd(30)} ${v.message}\n` +
        `       ${v.excerpt}`,
    )
    .join("\n");
}
