/**
 * The ledger shapes from SPEC.md section 4, as compile-time contracts.
 *
 * No enums anywhere: Node strips types rather than compiling them, so only
 * erasable syntax is allowed. Const objects plus union types give the same
 * safety and survive erasure.
 */

// --- Source tiering -----------------------------------------------------------

export const Tier = {
  AGGREGATOR: 1,
  SECONDARY: 2,
  SELF_REPORTED: 3,
  PRIMARY: 4,
} as const;

export type TierValue = (typeof Tier)[keyof typeof Tier];

export const TIER_LABEL = {
  1: "aggregator",
  2: "secondary",
  3: "self_reported",
  4: "primary",
} as const satisfies Record<TierValue, string>;

export type TierLabel = (typeof TIER_LABEL)[TierValue];

// --- Claims -------------------------------------------------------------------

export type ClaimKind =
  | "role"
  | "event"
  | "credential"
  | "statistic"
  | "affiliation"
  | "award";

/** `pending` until the deterministic labeller has run over the evidence. */
export type ClaimStatus =
  | "pending"
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "UNVERIFIED";

export type RefusalCode =
  | "NO_PRIMARY"
  | "SELF_REPORTED_ONLY"
  | "CIRCULAR_SOURCING"
  | "CONFLICTING_VALUES"
  | "PREDICATE_DRIFT"
  | "IDENTITY_AMBIGUOUS"
  | "PAYWALLED_UNREADABLE"
  | "PASSES_DISAGREE"
  | "STALE"
  | "UNCORROBORATED";

export interface ClaimValue {
  raw: string;
  amount: number | null;
  unit: string | null;
}

export interface ClaimTime {
  raw: string | null;
  start: string | null;
  end: string | null;
}

/**
 * The three-way split that makes PREDICATE_DRIFT detectable.
 *
 * `measures` and `population` are what separate "71% of hidden buyers have
 * little interaction with sales" from "71% of B2B buyers research a founder's
 * profile". Same number, same study, different assertion. A verifier that only
 * matches `value` marks the second one true.
 */
export interface Predicate {
  action: string;
  object: string;
  value: ClaimValue | null;
  /** What the number counts. Mandatory for kind `statistic`. */
  measures: string | null;
  /** The group it is counted over. Mandatory for kind `statistic`. */
  population: string | null;
  time: ClaimTime | null;
}

export interface Claim {
  id: string;
  subject_id: string;
  text: string;
  kind: ClaimKind;
  predicate: Predicate;
  derived_from_source_id: string;
  status: ClaimStatus;
  refusal_code: RefusalCode | null;
  refusal_note: string | null;
  evidence_ids: string[];
  footnote_id: string | null;
  created_at: string;
  updated_at: string;
}

// --- Sources ------------------------------------------------------------------

export type FetchMethod = "http" | "search" | "human_paste";

export interface Source {
  id: string;
  url: string;
  url_canonical: string;
  domain: string;
  publisher: string;
  title: string;
  tier: TierValue;
  tier_label: TierLabel;
  published_at: string | null;
  accessed_at: string;
  content_sha256: string;
  cache_path: string;
  fetch_method: FetchMethod;
  /** True for anything that did not arrive by a clean automated fetch. */
  degraded: boolean;
  origin_group: string | null;
  blocked: boolean;
  notes: string | null;
}

// --- Evidence -----------------------------------------------------------------

export type Stance = "supports" | "contradicts" | "neutral" | "not_found";

/**
 * Each field is true only when the source affirmatively matches that aspect,
 * false when the source addresses it and disagrees, and null when the source
 * is silent on it. The null case matters: silence is not agreement.
 */
export interface PredicateMatch {
  value: boolean | null;
  measures: boolean | null;
  population: boolean | null;
  time: boolean | null;
}

export interface Evidence {
  id: string;
  claim_id: string;
  source_id: string;
  /** 1 = confirming pass, 2 = disconfirming pass on a domain-filtered pool. */
  pass: 1 | 2;
  stance: Stance;
  /** Must appear verbatim in the cached source text. Checked in code. */
  quote: string;
  reasoning: string;
  predicate_match: PredicateMatch;
  /** Which model produced this row, so the two passes stay auditable. */
  model: string;
  created_at: string;
}

// --- Subject ------------------------------------------------------------------

export interface IdentityCorroboration {
  source_id: string;
  attribute: string;
  value: string;
}

export interface Subject {
  id: string;
  name: string;
  linkedin_url: string;
  role: string;
  company: string;
  company_domain: string | null;
  /** Feeds tier classification. Must be populated before harvest. */
  self_domains: string[];
  location: string | null;
  identity_corroborations: IdentityCorroboration[];
  assessed_at: string;
  pipeline_version: string;
}

// --- Append-only logs ---------------------------------------------------------

export type Decision = "approve" | "reject" | "hold";

export interface Approval {
  ts: string;
  claim_id: string;
  decision: Decision;
  reviewer: string;
  note: string | null;
}

export type FetchOutcome =
  | "ok"
  | "rate_limited"
  | "forbidden"
  | "not_found"
  | "timeout"
  | "paywall"
  | "blocked"
  | "human_paste";

export interface FetchEvent {
  ts: string;
  url: string;
  outcome: FetchOutcome;
  http_status: number | null;
  attempt: number;
  retry_after_s: number | null;
  degraded_to: FetchMethod | null;
  note: string | null;
}

// --- Gaps ---------------------------------------------------------------------

export type GapId =
  | "PROOF_GAP"
  | "NARRATIVE_OWNERSHIP_GAP"
  | "TOPIC_GAP"
  | "CADENCE_GAP"
  | "DISCOVERABILITY_GAP";

/**
 * Computed in code, never by the model. The model is handed these numbers and
 * writes prose around them; the rendered values must match byte for byte.
 */
export interface GapObservation {
  id: GapId;
  score: number;
  observation: string;
  metrics: Record<string, number | string | null>;
  evidence_source_ids: string[];
  caveat: string | null;
}
