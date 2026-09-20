/**
 * Hand-rolled shape checks. No schema library.
 *
 * These run on anything the model produces before it reaches the ledger. The
 * important one is `validateClaim`: a statistic without `measures` and
 * `population` cannot be checked for predicate drift, so it is rejected at the
 * boundary rather than quietly stored as uncheckable.
 */

import type { Claim, Evidence, Stance } from "../types.ts";

const CLAIM_KINDS = new Set([
  "role",
  "event",
  "credential",
  "statistic",
  "affiliation",
  "award",
]);

const STANCES = new Set<Stance>([
  "supports",
  "contradicts",
  "neutral",
  "not_found",
]);

export class ValidationError extends Error {
  readonly problems: string[];
  constructor(what: string, problems: string[]) {
    super(`${what}: ${problems.join("; ")}`);
    this.name = "ValidationError";
    this.problems = problems;
  }
}

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/**
 * Validates a claim as returned by extraction, before an id is assigned.
 * Returns the list of problems; empty means valid.
 */
export function claimProblems(claim: Partial<Claim>): string[] {
  const problems: string[] = [];

  if (!nonEmpty(claim.text)) problems.push("text is empty");

  // A claim has to be readable on its own. "Khaled Talhouni authored the
  // article." names no article, so nobody can check it and a reader on the page
  // learns nothing. Extraction produces these from listing pages.
  if (
    nonEmpty(claim.text) &&
    /\bthe (article|piece|post|episode|report|study|paper|interview)\b/i.test(claim.text) &&
    !/["\u201c\u2018]/.test(claim.text)
  ) {
    problems.push("refers to an unnamed document, so it cannot be checked or read on its own");
  }
  if (!claim.kind || !CLAIM_KINDS.has(claim.kind)) {
    problems.push(`kind ${JSON.stringify(claim.kind)} is not a known kind`);
  }

  const p = claim.predicate;
  if (!p) {
    problems.push("predicate is missing");
    return problems;
  }

  if (!nonEmpty(p.action)) problems.push("predicate.action is empty");
  if (!nonEmpty(p.object)) problems.push("predicate.object is empty");

  // The PREDICATE_DRIFT defence. A statistic whose measures or population are
  // missing cannot be distinguished from a statistic that means something else
  // entirely, which is the exact failure this system exists to catch.
  if (claim.kind === "statistic") {
    if (!nonEmpty(p.measures)) {
      problems.push("kind is statistic but predicate.measures is empty");
    }
    if (!nonEmpty(p.population)) {
      problems.push("kind is statistic but predicate.population is empty");
    }
    if (!p.value || !nonEmpty(p.value.raw)) {
      problems.push("kind is statistic but predicate.value.raw is empty");
    }
  }

  return problems;
}

export function assertClaim(claim: Partial<Claim>): void {
  const problems = claimProblems(claim);
  if (problems.length > 0) {
    throw new ValidationError(
      `claim ${claim.id ?? "(unassigned)"} rejected`,
      problems,
    );
  }
}

export function evidenceProblems(ev: Partial<Evidence>): string[] {
  const problems: string[] = [];

  if (!ev.stance || !STANCES.has(ev.stance)) {
    problems.push(`stance ${JSON.stringify(ev.stance)} is not a known stance`);
  }

  // A supporting row without a quote is an assertion, not evidence. The
  // verbatim substring check against the cached source happens separately in
  // the verification stage; this only enforces that there is something to check.
  if (ev.stance === "supports" && !nonEmpty(ev.quote)) {
    problems.push("stance is supports but quote is empty");
  }

  if (ev.pass !== 1 && ev.pass !== 2) {
    problems.push(`pass ${JSON.stringify(ev.pass)} is not 1 or 2`);
  }

  return problems;
}

export function assertEvidence(ev: Partial<Evidence>): void {
  const problems = evidenceProblems(ev);
  if (problems.length > 0) {
    throw new ValidationError(
      `evidence ${ev.id ?? "(unassigned)"} rejected`,
      problems,
    );
  }
}
