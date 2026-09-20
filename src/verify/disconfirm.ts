/**
 * Pass two: look for reasons the claim is wrong. SPEC.md section 8.2.
 *
 * Independence is enforced by filtering the input, not by asking the model
 * nicely. Every domain and every origin group that pass one relied on is
 * removed from the pool before this pass runs, so agreement between the passes
 * cannot come from reading the same page twice.
 *
 * It also runs on a different model family from pass one. SPEC.md 15.6 listed
 * single-provider verification as a known weakness, on the grounds that two
 * passes through one model can share a blind spot. Splitting the models closes
 * that: independence now holds on source and on model at the same time.
 */

import { llm } from "../config.ts";
import { log } from "../log.ts";
import type { Claim, Evidence, Source } from "../types.ts";
import { candidatesFor, runPass } from "./pass.ts";

const MAX_SOURCES_PER_CLAIM = 2;

export interface DisconfirmResult {
  evidence: Omit<Evidence, "id" | "created_at">[];
  misses: string[];
  poolWasEmpty: boolean;
}

export async function disconfirm(
  claim: Claim,
  pass1: readonly Omit<Evidence, "id" | "created_at">[],
  sources: readonly Source[],
  textById: ReadonlyMap<string, string>,
  subject: { surname: string; company: string },
): Promise<DisconfirmResult> {
  const sourcesById = new Map(sources.map((s) => [s.id, s]));

  const usedDomains = new Set<string>();
  const usedOrigins = new Set<string>();
  for (const e of pass1) {
    if (e.stance !== "supports") continue;
    const source = sourcesById.get(e.source_id);
    if (!source) continue;
    usedDomains.add(source.domain);
    if (source.origin_group) usedOrigins.add(source.origin_group);
  }

  const pool = candidatesFor(sources, textById, subject).filter(
    (s) =>
      !usedDomains.has(s.domain) &&
      !(s.origin_group && usedOrigins.has(s.origin_group)),
  );

  // An empty pool is itself a finding, and an important one: nothing
  // independent of pass one exists to check this against. Recording it as
  // not_found keeps that visible in the ledger instead of leaving a silent
  // absence that looks like agreement.
  if (pool.length === 0) {
    log.info("no independent sources remain for the disconfirming pass", {
      claim: claim.id,
      excludedDomains: [...usedDomains].join(",") || "(none)",
    });

    return {
      evidence: [
        {
          claim_id: claim.id,
          source_id: pass1[0]?.source_id ?? "",
          pass: 2,
          stance: "not_found",
          quote: "",
          reasoning:
            "No source independent of the confirming pass was available. Every remaining candidate shared a domain or an origin group with pass one.",
          predicate_match: { value: null, measures: null, population: null, time: null },
          model: llm.modelDisconfirm,
        },
      ],
      misses: [],
      poolWasEmpty: true,
    };
  }

  const evidence: DisconfirmResult["evidence"] = [];
  const misses: string[] = [];

  for (const source of pool.slice(0, MAX_SOURCES_PER_CLAIM)) {
    const text = textById.get(source.id);
    if (!text) continue;

    try {
      const outcome = await runPass({
        claim,
        source,
        text,
        model: llm.modelDisconfirm,
        promptName: "disconfirm.md",
      });

      if (outcome.miss) misses.push(outcome.miss);
      if (outcome.evidence) evidence.push(outcome.evidence);
    } catch (err) {
      log.warn("disconfirm pass failed for one source", {
        claim: claim.id,
        source: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { evidence, misses, poolWasEmpty: false };
}
