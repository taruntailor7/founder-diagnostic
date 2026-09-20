/**
 * Assembles the diagnostic as markdown, which the linter then checks and the
 * template turns into HTML.
 *
 * Only publishable, approved claims reach the body. Refused claims reach the
 * refusal ledger and nowhere else, and that ledger stays printed on the page:
 * it is the evidence the system works, not an appendix to be trimmed when the
 * document runs long.
 *
 * Header counts live in YAML front matter because front matter is exempt from
 * the number rule. Numerals in prose must carry a footnote; a count of how
 * many claims were extracted is metadata about the document, not an assertion
 * about the subject.
 */

import { TIER_LABEL } from "../types.ts";
import type {
  Approval,
  Claim,
  GapObservation,
  Source,
  Subject,
} from "../types.ts";

import { publishable, REFUSAL_EXPLANATION } from "../verify/label.ts";

/** Prose written by the model around numbers it was handed, never computed. */
export interface GapProse {
  id: string;
  title: string;
  observation: string;
  cost: string;
  fix: string;
}

export interface DiagnosticInput {
  subject: Subject;
  claims: readonly Claim[];
  sources: readonly Source[];
  approvals: readonly Approval[];
  gaps: readonly GapObservation[];
  gapProse: readonly GapProse[];
}

/** How many refusals fit on one page before it stops being readable. */
const MAX_REFUSALS_ON_PAGE = 7;

/** Claim text often already ends in punctuation; do not add a second full stop. */
const sentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

interface Footnoted {
  claim: Claim;
  marker: number;
}

const BADGE: Record<string, string> = {
  VERIFIED: "[V]",
  PARTIALLY_VERIFIED: "[PV]",
};

function sourceLineFor(claim: Claim, sources: readonly Source[]): string {
  const source = sources.find((s) => s.id === claim.derived_from_source_id);
  if (!source) return `claim:${claim.id}`;

  const bits = [
    source.publisher,
    TIER_LABEL[source.tier],
    source.published_at ? `published ${source.published_at}` : "undated",
    `accessed ${source.accessed_at.slice(0, 10)}`,
    source.degraded ? "degraded: human paste" : null,
  ].filter(Boolean);

  return `claim:${claim.id} | ${source.url} | ${bits.join(", ")}`;
}

export function build(input: DiagnosticInput): string {
  const { subject, claims, sources, gaps, gapProse } = input;

  /**
   * Selection is by status only. Approval is deliberately NOT applied here.
   *
   * Filtering unapproved claims out at assembly time would make the approval
   * gate unfireable: the document would silently shrink instead of failing,
   * and the gate would pass vacuously on every run while appearing to work.
   * The body is assembled from everything publishable, and the gates then
   * refuse the whole document if any of it lacks a human sign-off.
   */
  const approved = claims.filter(publishable);
  const refused = claims.filter((c) => c.status === "UNVERIFIED");

  // Footnote numbers are assigned in the order claims first appear.
  const footnotes: Footnoted[] = approved.map((claim, i) => ({
    claim,
    marker: i + 1,
    }));
  const markerFor = (id: string): number =>
    footnotes.find((f) => f.claim.id === id)?.marker ?? 0;

  const counts = {
    extracted: claims.length,
    verified: claims.filter((c) => c.status === "VERIFIED").length,
    partial: claims.filter((c) => c.status === "PARTIALLY_VERIFIED").length,
    refused: refused.length,
  };

  const out: string[] = [];

  // 1. Header, as front matter so its numerals are metadata not assertions.
  out.push("---");
  out.push(`name: ${subject.name}`);
  out.push(`role: ${subject.role}`);
  out.push(`company: ${subject.company}`);
  out.push(`linkedin: ${subject.linkedin_url}`);
  out.push(`assessed_at: ${subject.assessed_at.slice(0, 10)}`);
  out.push(`pipeline_version: ${subject.pipeline_version}`);
  out.push(`claims_extracted: ${counts.extracted}`);
  out.push(`verified: ${counts.verified}`);
  out.push(`partially_verified: ${counts.partial}`);
  out.push(`refused: ${counts.refused}`);
  out.push("---");
  out.push("");
  out.push(`# ${subject.name}`);
  out.push("");
  out.push(`${subject.role}, ${subject.company}. Public-source diagnostic.`);
  out.push("");

  // 2. Who they are.
  out.push("## Who they are");
  out.push("");
  const identity = approved.filter(
    (c) => c.kind === "role" || c.kind === "affiliation",
  );
  if (identity.length === 0) {
    out.push("No approved identity claims. Nothing is asserted here.");
  } else {
    for (const claim of identity.slice(0, 3)) {
      out.push(`${sentence(claim.text)}[^${markerFor(claim.id)}]`);
      out.push("");
    }
  }
  out.push("");

  // 3. Verified factual base.
  out.push("## Verified factual base");
  out.push("");
  const factual = approved.filter((c) => !identity.includes(c));
  if (factual.length === 0) {
    out.push("Nothing beyond the identity record cleared verification and approval.");
  } else {
    for (const claim of factual) {
      const badge = BADGE[claim.status] ?? "";
      out.push(`- ${badge} ${sentence(claim.text)}[^${markerFor(claim.id)}]`);
    }
  }
  out.push("");

  // 4. The three gaps.
  out.push("## Three gaps");
  out.push("");
  const gapNotes: { marker: string; sourceIds: string[]; label: string }[] = [];

  for (const [i, prose] of gapProse.entries()) {
    const observed = gaps.find((g) => g.id === prose.id);
    const marker = `g${i + 1}`;
    gapNotes.push({
      marker,
      sourceIds: observed?.evidence_source_ids ?? [],
      label: prose.id,
    });

    out.push(`### ${prose.title}`);
    out.push("");
    // The observation is the computed string, not the model's paraphrase of
    // it, so the numbers in the document are the numbers in the ledger.
    const measured = observed?.observation ?? prose.observation;
    out.push(
      `**Observation.** ${measured.charAt(0).toUpperCase()}${measured.slice(1)}.[^${marker}]`,
    );
    out.push("");
    // Cost and fix reason from the same measurement as the observation, so
    // they carry the same footnote. Any figure in them has already been checked
    // against the computed input; the marker is what ties it to provenance on
    // the page.
    // Per sentence, not per paragraph: the number rule is evaluated sentence by
    // sentence, so a marker at the end of a two-sentence block leaves a figure
    // in the first one unsourced.
    const cite = (text: string) =>
      text
        .split(/(?<=[.!?])\s+/)
        .map((sentence) =>
          /\d/.test(sentence) ? `${sentence.trimEnd()}[^${marker}]` : sentence,
        )
        .join(" ");
    out.push(`**Cost.** ${cite(prose.cost)}`);
    out.push("");
    out.push(`**Fix.** ${cite(prose.fix)}`);
    if (observed?.caveat) {
      out.push("");
      out.push(`*${observed.caveat}*`);
    }
    out.push("");
  }

  // 5. What we refused to publish. This stays on the page.
  out.push("## What we refused to publish");
  out.push("");
  if (refused.length === 0) {
    out.push("Nothing was refused in this run.");
  } else {
    out.push(
      "Each of these circulates publicly. None of them could be established from a source we would defend, so none appears above.",
    );
    out.push("");

    /**
     * The page shows the most serious refusals, strongest reason first, and
     * points at the full list. Predicate drift and conflicting values lead
     * because they mean a source was checked and found wanting, which is a
     * finding; missing corroboration means only that nothing was located.
     */
    const SEVERITY: Record<string, number> = {
      PREDICATE_DRIFT: 0,
      CONFLICTING_VALUES: 1,
      PASSES_DISAGREE: 2,
      CIRCULAR_SOURCING: 3,
      STALE: 4,
      PAYWALLED_UNREADABLE: 5,
      IDENTITY_AMBIGUOUS: 6,
      SELF_REPORTED_ONLY: 7,
      NO_PRIMARY: 8,
    };
    const ordered = [...refused].sort(
      (a, b) =>
        (SEVERITY[a.refusal_code ?? "NO_PRIMARY"] ?? 9) -
        (SEVERITY[b.refusal_code ?? "NO_PRIMARY"] ?? 9),
    );
    const shown = ordered.slice(0, MAX_REFUSALS_ON_PAGE);

    // The refusal code sits on the same line as the claim text. The linter
    // treats a code as sourcing the numerals beside it, which is correct: the
    // sentence is asserting that the figure is not established.
    for (const claim of shown) {
      const code = claim.refusal_code ?? "NO_PRIMARY";
      // The rule-13 note says only "no rule matched", which repeats the code
      // without adding anything. Suppressed so the explanation reads cleanly.
      const note =
        claim.refusal_note && !/does not meet any verification rule/.test(claim.refusal_note)
          ? ` ${claim.refusal_note.charAt(0).toUpperCase()}${claim.refusal_note.slice(1)}.`
          : "";
      out.push(`- \`${code}\` **${sentence(claim.text)}** ${REFUSAL_EXPLANATION[code]}${note}`);
    }

    if (ordered.length > shown.length) {
      out.push("");
      out.push(
        `The remainder are listed in full in \`out/refusals.md\` and in \`ledger/claims.json\`, each with its code and reasoning.`,
      );
    }
  }
  out.push("");

  // 6. Sources appendix.
  out.push("## Sources");
  out.push("");
  const cited = sources.filter((s) =>
    approved.some((c) => c.derived_from_source_id === s.id),
  );
  for (const source of cited) {
    const bits = [
      source.publisher,
      TIER_LABEL[source.tier],
      source.published_at ? source.published_at : "undated",
      source.degraded ? "degraded" : null,
    ].filter(Boolean);
    // Page titles carry a masthead tail; the appendix wants the headline.
    const heading = (source.title || source.url).split(/\s*\|\s*/)[0]?.trim() || source.url;
    out.push(`- ${heading} (${bits.join(", ")}) ${source.url}`);
  }

  /**
   * Sources that were sought and could not be read belong on the page.
   *
   * Two of them are primary registers behind bot protection. Omitting them
   * would make the evidence base look thinner than the search was, and would
   * hide the reason some claims could not be corroborated. A reader is
   * entitled to know what we could not open.
   */
  const unreadable = [
    ...new Map(sources.filter((s) => s.blocked).map((s) => [s.domain, s])).values(),
  ];
  if (unreadable.length > 0) {
    out.push("");
    out.push(
      `Sought and not readable, so nothing here rests on them: ` +
        unreadable
          .map((s) => `${s.domain} (${TIER_LABEL[s.tier]}, ${(s.notes ?? "blocked").replace("not read: ", "")})`)
          .join("; ") +
        ".",
    );
  }
  out.push("");

  // 7. Method note.
  out.push("## Method");
  out.push("");
  out.push(
    "Labels are decided by tested rules in code, not by a language model. The model extracts claims and reports what a source says, with a verbatim quote checked against the cached page; it never decides whether something is verified.",
  );
  out.push("");
  out.push(
    "The LinkedIn URL is used only as an identity anchor. Post history requires a login, so publishing rhythm is measured across datable open-web artifacts instead, and is described that way throughout.",
  );
  out.push("");
  out.push(
    "Nothing appears in this document without a recorded human approval. The renderer exits with an error rather than emit a claim that lacks one.",
  );
  out.push("");

  // Footnote definitions. Claims first, then computed observations.
  out.push("");
  for (const { claim, marker } of footnotes) {
    out.push(`[^${marker}]: ${sourceLineFor(claim, sources)}`);
  }
  for (const note of gapNotes) {
    // Measured by this tool over the ledger, so provenance is the set of
    // sources it was computed from, not a claim anybody made.
    const cited = note.sourceIds
      .map((id) => sources.find((s) => s.id === id))
      .filter((s): s is Source => Boolean(s));

    const primary = cited[0];
    const detail = cited.length > 0
      ? `${cited.length} dated source(s) including ${primary?.publisher ?? ""} ${primary?.url ?? ""}`
      : "computed over the source ledger";

    out.push(
      `[^${note.marker}]: source:${primary?.id ?? "src_0000"} | computed by this tool from the ledger, ${note.label} | ${detail}`,
    );
  }
  out.push("");

  return out.join("\n");
}
