/**
 * Prose around numbers the model was handed.
 *
 * `observe.ts` computes every figure. This stage only writes sentences. The
 * output is then checked: any number appearing in the prose that was not in the
 * input is stripped out along with the sentence carrying it, because a figure
 * the model produced is a figure nobody sourced.
 */

import { llm } from "../config.ts";
import { log } from "../log.ts";
import { callJson, loadPrompt } from "../llm/client.ts";
import { fill } from "../claims/extract.ts";
import type { Claim, GapObservation, Subject } from "../types.ts";
import type { GapProse } from "../render/diagnostic.ts";

/** Every distinct numeric token in a string, as written. */
export function numbersIn(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\d[\d,.]*/g)]
      .map((m) => m[0].replace(/[.,]$/, ""))
      .filter((n) => n !== ""),
  );
}

/**
 * Numbers in `output` that do not appear anywhere in `allowed`.
 *
 * Deliberately strict. A model asked not to compute will still helpfully turn
 * "37 months" into "three years", and the rounded figure is one nobody can
 * trace to the ledger.
 */
export function unsourcedNumbers(output: string, allowed: string): string[] {
  const permitted = numbersIn(allowed);
  return [...numbersIn(output)].filter((n) => !permitted.has(n));
}

function describe(gap: GapObservation): string {
  const metrics = Object.entries(gap.metrics)
    .map(([k, v]) => `    ${k}: ${v ?? "none"}`)
    .join("\n");
  return `- id: ${gap.id}\n  observation: ${gap.observation}\n  metrics:\n${metrics}`;
}

export async function analyze(
  gaps: readonly GapObservation[],
  claims: readonly Claim[],
  subject: Subject,
): Promise<GapProse[]> {
  if (gaps.length === 0) return [];

  const observations = gaps.map(describe).join("\n\n");
  const publishable = claims
    .filter((c) => c.status === "VERIFIED" || c.status === "PARTIALLY_VERIFIED")
    .map((c) => `- ${c.text}`)
    .join("\n");

  const template = await loadPrompt("gap-analysis.md");
  const prompt = fill(template, {
    SUBJECT_NAME: subject.name,
    SUBJECT_ROLE: subject.role,
    SUBJECT_COMPANY: subject.company,
    OBSERVATIONS: observations,
    PUBLISHABLE_CLAIMS: publishable || "(none)",
  });

  const { data } = await callJson<{ gaps?: Partial<GapProse>[] }>({
    model: llm.modelExtract,
    system:
      "You write prose around figures that have already been computed. You never introduce a number. You return one JSON object.",
    user: prompt,
    maxTokens: 1500,
  });

  const allowed = `${observations}\n${publishable}`;
  const out: GapProse[] = [];

  for (const gap of gaps) {
    const written = data.gaps?.find((g) => g.id === gap.id);
    if (!written) {
      log.warn("no prose returned for gap, falling back to the computed observation", {
        gap: gap.id,
      });
      out.push({
        id: gap.id,
        title: gap.id.replace(/_/g, " ").toLowerCase(),
        observation: gap.observation,
        cost: "Not described.",
        fix: "Not described.",
      });
      continue;
    }

    const clean = (text: string | undefined, field: string): string => {
      const value = (text ?? "").trim();
      if (value === "") return "Not described.";
      const invented = unsourcedNumbers(value, allowed);
      if (invented.length === 0) return value;

      log.warn("model introduced a figure that is not in the ledger, dropping it", {
        gap: gap.id,
        field,
        numbers: invented.join(", "),
      });
      // Drop only the sentences carrying an unsourced figure, keeping the rest.
      const kept = value
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => unsourcedNumbers(sentence, allowed).length === 0);
      return kept.join(" ").trim() || "Not described.";
    };

    out.push({
      id: gap.id,
      // The title must not carry a number, so it never needs a footnote.
      title: (written.title ?? gap.id).replace(/\d[\d,.]*/g, "").trim() || gap.id,
      observation: gap.observation,
      cost: clean(written.cost, "cost"),
      fix: clean(written.fix, "fix"),
    });
  }

  return out;
}
