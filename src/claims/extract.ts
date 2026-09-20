/**
 * Claim extraction. The model decomposes text into atomic assertions; it never
 * says whether any of them is true.
 *
 * Extraction output is validated before it reaches the ledger. A statistic
 * missing `measures` or `population` is rejected outright, because a statistic
 * whose meaning was never captured cannot be checked for predicate drift, and
 * storing it would create a claim that looks checkable and is not.
 */

import { log } from "../log.ts";
import { callJson, loadPrompt } from "../llm/client.ts";
import { claimProblems } from "../ledger/validate.ts";
import type { Claim, Predicate, Source } from "../types.ts";

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? "");
}

interface ExtractedClaim {
  text?: string;
  kind?: Claim["kind"];
  predicate?: Partial<Predicate>;
}

export interface ExtractionResult {
  claims: Omit<Claim, "id" | "created_at" | "updated_at">[];
  rejected: { text: string; problems: string[] }[];
}

/** Keeps a very long page inside the model's useful attention span. */
function trim(text: string, limit = 24_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated at ${limit} characters]`;
}

/**
 * Ceiling on claims taken from any one page.
 *
 * Aggregator profile pages are lists, and asked for claims they return
 * everything: every board seat, every tag, every portfolio line. One returned
 * 28. Verifying each costs up to seven model calls, so a single low-value page
 * can consume more budget than every primary source combined, and none of it
 * reaches a one-page document. Documented rather than tuned silently.
 */
export const MAX_CLAIMS_PER_SOURCE = 4;

function normalisePredicate(raw: Partial<Predicate> | undefined): Predicate {
  const value = raw?.value;
  const time = raw?.time;

  return {
    action: raw?.action?.trim() ?? "",
    object: raw?.object?.trim() ?? "",
    value:
      value && typeof value.raw === "string" && value.raw.trim() !== ""
        ? {
            raw: value.raw.trim(),
            amount: typeof value.amount === "number" ? value.amount : null,
            unit: typeof value.unit === "string" ? value.unit : null,
          }
        : null,
    measures: raw?.measures?.trim() || null,
    population: raw?.population?.trim() || null,
    time:
      time && typeof time.raw === "string" && time.raw.trim() !== ""
        ? {
            raw: time.raw.trim(),
            start: typeof time.start === "string" ? time.start : null,
            end: typeof time.end === "string" ? time.end : null,
          }
        : null,
  };
}

export async function extractClaims(
  source: Source,
  text: string,
  subject: { id: string; name: string; company: string },
  model: string,
): Promise<ExtractionResult> {
  const template = await loadPrompt("claim-extraction.md");
  const prompt = fill(template, {
    SUBJECT_NAME: subject.name,
    SUBJECT_COMPANY: subject.company,
    SOURCE_PUBLISHER: source.publisher,
    SOURCE_URL: source.url,
    SOURCE_TEXT: trim(text),
  });

  const { data } = await callJson<{ claims?: ExtractedClaim[] }>({
    model,
    system:
      "You extract atomic factual claims and return one JSON object. You never judge whether a claim is true.",
    user: prompt,
    // Providers meter reserved output tokens against the per-minute budget, so
    // an oversized reservation throttles the run without producing anything.
    maxTokens: 4000,
  });

  const claims: ExtractionResult["claims"] = [];
  const rejected: ExtractionResult["rejected"] = [];
  const now = new Date().toISOString();

  for (const raw of data.claims ?? []) {
    const candidate = {
      subject_id: subject.id,
      text: raw.text?.trim() ?? "",
      kind: raw.kind ?? ("event" as const),
      predicate: normalisePredicate(raw.predicate),
      derived_from_source_id: source.id,
      status: "pending" as const,
      refusal_code: null,
      refusal_note: null,
      evidence_ids: [],
      footnote_id: null,
    };

    const problems = claimProblems({ ...candidate, created_at: now, updated_at: now });
    if (problems.length > 0) {
      rejected.push({ text: candidate.text || "(no text)", problems });
      continue;
    }

    claims.push(candidate);
  }

  if (rejected.length > 0) {
    log.warn("claims rejected at the boundary", {
      source: source.id,
      rejected: rejected.length,
      kept: claims.length,
    });
  }

  if (claims.length > MAX_CLAIMS_PER_SOURCE) {
    log.warn("capping claims from one source", {
      source: source.id,
      returned: claims.length,
      kept: MAX_CLAIMS_PER_SOURCE,
    });
    return { claims: claims.slice(0, MAX_CLAIMS_PER_SOURCE), rejected };
  }

  return { claims, rejected };
}
