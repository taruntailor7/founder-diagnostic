/**
 * The approval audit log. Append only, no exceptions.
 *
 * There is no update path and no delete path, here or in the server. A
 * reversed decision is a new line, so the history of what was approved and
 * later withdrawn stays readable. An audit log you can edit is not an audit
 * log.
 */

import { reviewer } from "../config.ts";
import { appendJsonl, readJsonl } from "../ledger/store.ts";
import type { Approval, Claim, Decision } from "../types.ts";

export class ReviewerRequiredError extends Error {
  constructor() {
    super(
      "REVIEWER is not set.\n" +
        "  Add REVIEWER to .env before starting the review server.\n" +
        "  Approvals are attributable by design: the log must never record an anonymous one.",
    );
    this.name = "ReviewerRequiredError";
  }
}

export function requireReviewer(): string {
  const name = reviewer();
  if (name.trim() === "") throw new ReviewerRequiredError();
  return name.trim();
}

export async function readApprovals(): Promise<Approval[]> {
  return readJsonl<Approval>("approvals.jsonl");
}

export async function recordDecision(
  claim_id: string,
  decision: Decision,
  note: string | null,
): Promise<Approval> {
  const entry: Approval = {
    ts: new Date().toISOString(),
    claim_id,
    decision,
    reviewer: requireReviewer(),
    note: note?.trim() ? note.trim() : null,
  };
  await appendJsonl<Approval>("approvals.jsonl", entry);
  return entry;
}

/** Later lines supersede earlier ones for the same claim. */
export function latestByClaim(
  approvals: readonly Approval[],
): Map<string, Approval> {
  const out = new Map<string, Approval>();
  for (const a of approvals) out.set(a.claim_id, a);
  return out;
}

export function isApproved(
  claimId: string,
  approvals: readonly Approval[],
): boolean {
  return latestByClaim(approvals).get(claimId)?.decision === "approve";
}

/**
 * Claims still awaiting a decision, UNVERIFIED first.
 *
 * Refusals are listed first on purpose. They are the ones a reviewer is most
 * tempted to skip and the ones most worth reading, since a wrongly refused
 * claim is invisible in the output unless someone looks.
 */
export function pendingReview(
  claims: readonly Claim[],
  approvals: readonly Approval[],
): Claim[] {
  const decisions = latestByClaim(approvals);
  const order: Record<string, number> = {
    UNVERIFIED: 0,
    PARTIALLY_VERIFIED: 1,
    VERIFIED: 2,
    pending: 3,
  };

  return claims
    .filter((c) => decisions.get(c.id)?.decision !== "approve")
    .sort(
      (a, b) =>
        (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
        a.id.localeCompare(b.id),
    );
}
