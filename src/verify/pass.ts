/**
 * Shared machinery for the two verification passes.
 *
 * The verbatim quote check lives here and is the most valuable single guard in
 * the system. A model can produce a fluent, plausible sentence and attribute it
 * to a source; it cannot make that sentence appear in text already sitting on
 * our disk. Anything that fails the check is discarded rather than downgraded,
 * and the discard is recorded.
 */

import { log } from "../log.ts";
import { callJson, loadPrompt } from "../llm/client.ts";
import { fill } from "../claims/extract.ts";
import { quoteAppearsIn } from "../sources/extract.ts";
import type { Claim, Evidence, PredicateMatch, Source, Stance } from "../types.ts";

export interface PassContext {
  claim: Claim;
  source: Source;
  text: string;
  model: string;
  promptName: "confirm.md" | "disconfirm.md";
}

export interface PassOutcome {
  evidence: Omit<Evidence, "id" | "created_at"> | null;
  /** Populated when a quote failed the verbatim check. */
  miss: string | null;
}

interface RawVerdict {
  stance?: string;
  quote?: string;
  reasoning?: string;
  predicate_match?: Partial<Record<keyof PredicateMatch, unknown>>;
}

const STANCES = new Set<Stance>(["supports", "contradicts", "neutral", "not_found"]);

/** Anything that is not an explicit boolean becomes null: silence, not agreement. */
function tristate(v: unknown): boolean | null {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

function normaliseMatch(raw: RawVerdict["predicate_match"]): PredicateMatch {
  return {
    value: tristate(raw?.value),
    measures: tristate(raw?.measures),
    population: tristate(raw?.population),
    time: tristate(raw?.time),
  };
}

/**
 * Verification needs the sentence that bears on the claim, not the whole page.
 *
 * Groq meters tokens per minute rather than requests, and at 20,000 characters
 * a single verification call could exceed the whole minute's budget on its own.
 * Ten thousand is still several times the length of any passage a verdict
 * actually rests on.
 */
function trim(text: string, limit = 10_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[truncated]`;
}

export async function runPass(ctx: PassContext): Promise<PassOutcome> {
  const { claim, source, text, model, promptName } = ctx;

  const template = await loadPrompt(promptName);
  const prompt = fill(template, {
    CLAIM_TEXT: claim.text,
    CLAIM_PREDICATE: JSON.stringify(claim.predicate, null, 2),
    SOURCE_PUBLISHER: source.publisher,
    SOURCE_DATE: source.published_at ?? "undated",
    SOURCE_URL: source.url,
    SOURCE_TEXT: trim(text),
  });

  const system =
    promptName === "confirm.md"
      ? "You report what one source says about one claim, with a verbatim quote. You return one JSON object."
      : "You look for reasons a claim is wrong, using only the supplied source. You return one JSON object.";

  const { data } = await callJson<RawVerdict>({ model, system, user: prompt, maxTokens: 700 });

  const stance = STANCES.has(data.stance as Stance)
    ? (data.stance as Stance)
    : "not_found";
  const quote = (data.quote ?? "").trim();
  const pass = promptName === "confirm.md" ? 1 : 2;

  // The hallucination catch. A stance that rests on a quote the source does not
  // contain is discarded entirely; it is not softened into "neutral", because
  // the model's reasoning about a sentence that does not exist is worthless.
  if ((stance === "supports" || stance === "contradicts") && !quoteAppearsIn(quote, text)) {
    const miss =
      `${new Date().toISOString()} ${model} pass ${pass} claimed ${stance} for ${claim.id} ` +
      `against ${source.id} (${source.domain}) with a quote absent from the source: ` +
      `"${quote.slice(0, 160).replace(/\s+/g, " ")}"`;

    log.warn("quote not found in source, discarding evidence", {
      claim: claim.id,
      source: source.id,
      model,
      pass,
    });

    return { evidence: null, miss };
  }

  return {
    evidence: {
      claim_id: claim.id,
      source_id: source.id,
      pass,
      stance,
      quote: stance === "supports" || stance === "contradicts" ? quote : "",
      reasoning: (data.reasoning ?? "").trim().slice(0, 400),
      predicate_match: normaliseMatch(data.predicate_match),
      model,
    },
    miss: null,
  };
}

/**
 * Sources worth asking about this claim: ones that actually mention the person
 * or the company, strongest first.
 *
 * Asking a model about a document that never mentions the subject invites it to
 * reason from prior knowledge rather than from the text, which is exactly the
 * behaviour the verbatim check exists to prevent. Cheaper to not ask.
 */
export function candidatesFor(
  sources: readonly Source[],
  textById: ReadonlyMap<string, string>,
  subject: { surname: string; company: string },
  /** The source the claim was extracted from, always checked first. */
  originSourceId?: string,
): Source[] {
  const surname = subject.surname.toLowerCase();
  const company = subject.company.toLowerCase();

  const eligible = sources
    .filter((s) => {
      if (s.blocked) return false;
      const body = (textById.get(s.id) ?? "").toLowerCase();
      if (body === "") return false;
      return body.includes(surname) || (company !== "" && body.includes(company));
    })
    .sort((a, b) => b.tier - a.tier || a.id.localeCompare(b.id));

  /**
   * The document a claim was read from goes first, whatever its tier.
   *
   * Without this, tier ranking decides the candidate list and the originating
   * source can fall outside it: a funding claim taken from a news article gets
   * checked against two register pages that never mention funding, both return
   * not_found, and the claim is refused for lack of support that was sitting in
   * the document it came from. That is not a finding, it is a failure to look.
   */
  if (!originSourceId) return eligible;

  const origin = eligible.find((s) => s.id === originSourceId);
  if (!origin) return eligible;
  return [origin, ...eligible.filter((s) => s.id !== originSourceId)];
}
