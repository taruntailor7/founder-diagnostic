#!/usr/bin/env node
/**
 * A worked example of the failure this system exists to catch.
 *
 *   npm run demo:drift
 *
 * The claim below is not invented. It appeared in the brief that commissioned
 * this project:
 *
 *   "A widely cited 2025 study found that 71% of B2B buyers research a
 *    founder's personal profile before engaging the company."
 *
 * Every superficial check passes. The figure is real, the study is real, the
 * year is right. A verifier that matches the number marks it true.
 *
 * What the Edelman and LinkedIn 2025 B2B Thought Leadership Impact Report
 * actually reports is that 71% of *hidden buyers* say they have little
 * interaction with sales. Different measure, different population, same number.
 *
 * This runs the real confirming pass against the real Edelman page and the real
 * labelling function. Nothing here is mocked. The only thing supplied is the
 * claim itself.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { llm, paths } from "../src/config.ts";
import { log } from "../src/log.ts";
import { fetchUrl } from "../src/sources/fetch.ts";
import { extract } from "../src/sources/extract.ts";
import { classify, domainOf, tierLabel, publisherFrom } from "../src/sources/tiers.ts";
import { canonicalise, relativeCachePath, sha256 } from "../src/sources/cache.ts";
import { runPass } from "../src/verify/pass.ts";
import { label, REFUSAL_EXPLANATION } from "../src/verify/label.ts";
import type { Claim, Evidence, Source } from "../src/types.ts";

/**
 * Edelman's own pages return 403 to any automated client, so the report is read
 * through a trade publication that carries its findings in detail.
 *
 * This makes the demonstration stronger rather than weaker. The source lands in
 * the aggregator tier, and predicate drift is rule 2, evaluated before source
 * quality is considered at all. The claim is refused on what the number means,
 * not on where it was found.
 */
const SOURCE_URL =
  "https://www.marketing-interactive.com/report-over-40-of-b2b-deals-stall-due-to-hidden-buyers";

const CLAIM: Claim = {
  id: "clm_drift_001",
  subject_id: "subj_demo",
  text: "71% of B2B buyers research a founder's personal profile before engaging the company",
  kind: "statistic",
  predicate: {
    action: "research",
    object: "a founder's personal profile before engaging the company",
    value: { raw: "71%", amount: 71, unit: "percent" },
    measures: "share who research a founder's personal profile before engaging",
    population: "B2B buyers",
    time: { raw: "2025", start: "2025-01-01", end: "2025-12-31" },
  },
  derived_from_source_id: "src_drift_001",
  status: "pending",
  refusal_code: null,
  refusal_note: null,
  evidence_ids: [],
  footnote_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function rule(title: string): void {
  process.stdout.write(`\n${title}\n${"-".repeat(Math.max(20, title.length))}\n`);
}

async function main(): Promise<void> {
  rule("The claim");
  process.stdout.write(`  ${CLAIM.text}\n\n`);
  process.stdout.write(`  value       ${CLAIM.predicate.value?.raw}\n`);
  process.stdout.write(`  measures    ${CLAIM.predicate.measures}\n`);
  process.stdout.write(`  population  ${CLAIM.predicate.population}\n`);

  rule("The source");
  const fetched = await fetchUrl(SOURCE_URL);
  if (!fetched.body) {
    log.error("could not read the source", { url: SOURCE_URL, outcome: fetched.outcome });
    process.exit(1);
  }

  const meta = extract(fetched.body, SOURCE_URL);
  const tier = classify(SOURCE_URL);
  const source: Source = {
    id: "src_drift_001",
    url: SOURCE_URL,
    url_canonical: canonicalise(SOURCE_URL),
    domain: domainOf(SOURCE_URL),
    publisher: meta.publisher || publisherFrom(SOURCE_URL),
    title: meta.title,
    tier,
    tier_label: tierLabel(tier),
    published_at: meta.publishedAt,
    accessed_at: new Date().toISOString(),
    content_sha256: sha256(fetched.body),
    cache_path: relativeCachePath(SOURCE_URL),
    fetch_method: "http",
    degraded: fetched.degraded,
    origin_group: "og_001",
    blocked: fetched.blocked,
    notes: null,
  };
  process.stdout.write(`  ${source.publisher} (${source.tier_label})\n  ${source.url}\n`);

  rule("Confirming pass");
  const outcome = await runPass({
    claim: CLAIM,
    source,
    text: meta.text,
    model: llm.modelConfirm,
    promptName: "confirm.md",
  });

  if (!outcome.evidence) {
    process.stdout.write(`  Evidence discarded: the quote did not appear in the source.\n  ${outcome.miss}\n`);
    process.exit(0);
  }

  const evidence: Evidence = {
    ...outcome.evidence,
    id: "ev_drift_001",
    created_at: new Date().toISOString(),
  };

  const m = evidence.predicate_match;
  const mark = (v: boolean | null) => (v === true ? "matches" : v === false ? "DOES NOT MATCH" : "silent");
  process.stdout.write(`  stance      ${evidence.stance}\n`);
  process.stdout.write(`  value       ${mark(m.value)}\n`);
  process.stdout.write(`  measures    ${mark(m.measures)}\n`);
  process.stdout.write(`  population  ${mark(m.population)}\n`);
  if (evidence.quote) process.stdout.write(`\n  quote, verified verbatim against the cached page:\n    "${evidence.quote}"\n`);
  process.stdout.write(`\n  ${evidence.reasoning}\n`);

  rule("Deterministic label");
  const result = label({
    claim: CLAIM,
    evidence: [evidence],
    sourcesById: new Map([[source.id, source]]),
    candidateSources: [source],
    identityCorroborations: 2,
  });

  process.stdout.write(`  rule ${result.rule} fired\n`);
  process.stdout.write(`  status  ${result.status}\n`);
  process.stdout.write(`  code    ${result.refusal_code}\n`);
  if (result.refusal_code) {
    process.stdout.write(`\n  ${REFUSAL_EXPLANATION[result.refusal_code]}\n`);
  }

  rule("Why this matters");
  process.stdout.write(
    `  The figure is real. The study is real. The year is right.\n` +
      `  A verifier that checks only the number marks this claim true.\n\n` +
      `  Splitting the statistic into value, measures and population is what\n` +
      `  makes the mismatch visible, and the label is decided by a rule the\n` +
      `  model cannot influence.\n`,
  );

  await fs.mkdir(paths.out, { recursive: true });
  await fs.writeFile(
    path.join(paths.out, "predicate-drift.json"),
    JSON.stringify(
      { claim: { ...CLAIM, status: result.status, refusal_code: result.refusal_code, refusal_note: result.note }, source, evidence, label: result },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  process.stdout.write(`\n  Ledger rows written to out/predicate-drift.json\n\n`);
}

main().catch((err: unknown) => {
  log.error("drift demo failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
