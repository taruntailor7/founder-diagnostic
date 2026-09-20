/**
 * Environment, budgets and the offline switch.
 *
 * `.env` is read with Node's built-in loader rather than `dotenv`, keeping the
 * dependency count at two. A missing `.env` is not an error: `npm run demo`
 * runs offline from fixtures on a clean clone with no key.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Where the ledger, fixtures and output live. Overridable with FD_ROOT so the
 * gate test can run the real renderer against a controlled ledger instead of
 * the repo's own, which would make the test destructive.
 */
export const ROOT = process.env.FD_ROOT
  ? path.resolve(process.env.FD_ROOT)
  : PACKAGE_ROOT;

const envPath = path.join(PACKAGE_ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const str = (key: string, fallback: string): string =>
  process.env[key]?.trim() || fallback;

const int = (key: string, fallback: number): number => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const PIPELINE_VERSION = "1.0.0";

/** Serve only from fixtures. A cache miss throws instead of hitting the network. */
export const OFFLINE =
  process.env.OFFLINE === "1" || process.argv.includes("--replay");

export const FORCE = process.argv.includes("--force");

export const paths = {
  // Data. Moves with FD_ROOT, so a run can be pointed at a scratch ledger.
  ledger: path.join(ROOT, "ledger"),
  httpCache: path.join(ROOT, "fixtures", "http"),
  llmCache: path.join(ROOT, "fixtures", "llm"),
  out: path.join(ROOT, "out"),

  // Code. Prompts are part of the program and always load from the package,
  // never from FD_ROOT. Relocating them meant every extraction failed with
  // ENOENT the moment a run used a scratch ledger.
  prompts: path.join(PACKAGE_ROOT, "prompts"),
} as const;

export const llm = {
  apiKey: str("LLM_API_KEY", ""),
  baseUrl: str("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
  /**
   * Confirm and disconfirm run on different model families on purpose. Domain
   * independence stops two passes reading the same source; model independence
   * stops them sharing a training blind spot. Pointing both at one model
   * silently weakens the verifier while everything still appears to work.
   *
   * Reasoning models are unusable here and were removed after testing. Given a
   * claim-extraction prompt, deepseek-v4-flash spent all 4000 completion tokens
   * on reasoning_tokens, returned content of length 1, and took 100 seconds to
   * do it. The two chosen models answer directly.
   */
  modelExtract: str("MODEL_EXTRACT", "openai/gpt-oss-20b"),
  modelConfirm: str("MODEL_CONFIRM", "openai/gpt-oss-20b"),
  modelDisconfirm: str("MODEL_DISCONFIRM", "qwen/qwen3.8-27b"),
  /** Client-side pacing. Free tiers throttle hard; staying under is faster than retrying. */
  requestsPerMinute: int("LLM_RPM", 4),
  temperature: 0,
} as const;

/**
 * Discovery. Keyless search works from a laptop and not from a server, so a
 * hosted instance needs an API key. Free tiers are sufficient.
 */
export const search = {
  tavilyKey: str("TAVILY_API_KEY", ""),
} as const;

/** Exceeding a budget stops that stage cleanly and leaves the ledger resumable. */
export const budgets = {
  maxFetches: int("MAX_FETCHES", 150),
  maxSearches: int("MAX_SEARCHES", 25),
  maxLlmCalls: int("MAX_LLM_CALLS", 200),
} as const;

export const http = {
  userAgent:
    "founder-diagnostic/1.0 (+https://github.com/taruntailor7/founder-diagnostic) public-sources-only research tool",
  timeoutMs: 25_000,
  maxAttempts: 3,
  /** 1s, 4s, 16s, each with up to 500ms of jitter. */
  backoffMs: [1_000, 4_000, 16_000],
  jitterMs: 500,
  perDomainConcurrency: 1,
  globalConcurrency: 4,
} as const;

/** Read lazily: only the review server requires it, and it refuses to start without it. */
export const reviewer = (): string => str("REVIEWER", "");
