/**
 * Pass one: look for support. SPEC.md section 8.1.
 */

import { llm } from "../config.ts";
import { log } from "../log.ts";
import type { Claim, Evidence, Source } from "../types.ts";
import { candidatesFor, runPass } from "./pass.ts";

/** Four is enough to establish independence and keeps the call budget survivable. */
const MAX_SOURCES_PER_CLAIM = 3;

export interface ConfirmResult {
  evidence: Omit<Evidence, "id" | "created_at">[];
  misses: string[];
  /** Everything considered, including what was blocked, for rule 5. */
  candidates: Source[];
}

export async function confirm(
  claim: Claim,
  sources: readonly Source[],
  textById: ReadonlyMap<string, string>,
  subject: { surname: string; company: string },
): Promise<ConfirmResult> {
  const candidates = candidatesFor(sources, textById, subject, claim.derived_from_source_id);
  const evidence: ConfirmResult["evidence"] = [];
  const misses: string[] = [];

  for (const source of candidates.slice(0, MAX_SOURCES_PER_CLAIM)) {
    const text = textById.get(source.id);
    if (!text) continue;

    try {
      const outcome = await runPass({
        claim,
        source,
        text,
        model: llm.modelConfirm,
        promptName: "confirm.md",
      });

      if (outcome.miss) misses.push(outcome.miss);
      if (outcome.evidence) evidence.push(outcome.evidence);
    } catch (err) {
      // A failed call leaves the claim with less evidence, which the labeller
      // handles. It must not abort the run and lose everything already done.
      log.warn("confirm pass failed for one source", {
        claim: claim.id,
        source: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { evidence, misses, candidates };
}
