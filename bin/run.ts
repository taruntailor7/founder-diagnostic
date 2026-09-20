#!/usr/bin/env node
/**
 * The pipeline.
 *
 *   npm start -- --linkedin <url> --name "First Last" --company "Firm" [--seed <url>]
 *   npm run demo                      # replays committed fixtures, no key needed
 *
 * Every stage skips work already in the ledger unless --force, so a run
 * interrupted by a rate limit or a budget can be resumed without paying for
 * what it already did.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { FORCE, OFFLINE, PIPELINE_VERSION, llm, paths } from "../src/config.ts";
import { log } from "../src/log.ts";
import { sequence } from "../src/ids.ts";
import { readJson, writeJson } from "../src/ledger/store.ts";
import { planResolution, corroborate, independentCorroborationCount } from "../src/identity/resolve.ts";
import { fetchUrl, BudgetExceededError } from "../src/sources/fetch.ts";
import { extract } from "../src/sources/extract.ts";
import { search } from "../src/sources/search.ts";
import { classify, domainOf, tierLabel } from "../src/sources/tiers.ts";
import { groupByOrigin } from "../src/sources/origin.ts";
import { canonicalise, relativeCachePath, sha256 } from "../src/sources/cache.ts";
import { extractClaims } from "../src/claims/extract.ts";
import { dedupe } from "../src/claims/dedupe.ts";
import { confirm } from "../src/verify/confirm.ts";
import { disconfirm } from "../src/verify/disconfirm.ts";
import { label } from "../src/verify/label.ts";
import { observeAll, topThree } from "../src/gaps/observe.ts";
import { analyze } from "../src/gaps/analyze.ts";
import { LlmBudgetError, MissingKeyError, recordedMisses } from "../src/llm/client.ts";
import type { Claim, Evidence, GapObservation, Source, Subject } from "../src/types.ts";

// --- Arguments ----------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function argAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) {
      out.push(process.argv[i + 1] as string);
    }
  }
  return out;
}

/** Seeds from a committed file, so a run is reproducible from the repo. */
async function seedsFromFile(file: string | undefined): Promise<string[]> {
  if (!file) return [];
  const raw = await fs.readFile(path.resolve(file), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// --- Harvest ------------------------------------------------------------------

const textBySourceId = new Map<string, string>();

async function harvest(
  urls: readonly string[],
  existing: readonly Source[],
  selfDomains: readonly string[],
): Promise<Source[]> {
  const sources = [...existing];
  const nextId = sequence("src", sources.map((s) => s.id));
  const seen = new Set(sources.map((s) => s.url_canonical));

  for (const source of sources) {
    const cached = await fetchUrl(source.url).catch(() => null);
    if (!cached?.body) continue;
    const meta = extract(cached.body, source.url);
    textBySourceId.set(source.id, meta.text);
    // Re-derive presentation metadata each run so a parsing improvement reaches
    // sources harvested before it existed.
    source.publisher = meta.publisher;
    source.title = meta.title;
    source.published_at = meta.publishedAt ?? source.published_at;
  }

  for (const url of urls) {
    const canonical = canonicalise(url);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    let result;
    try {
      result = await fetchUrl(url);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn("fetch budget reached, stopping harvest cleanly", { at: url });
        break;
      }
      log.warn("skipping url", { url, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const meta = result.body ? extract(result.body, url) : null;
    const tier = classify(url, { selfDomains });
    const id = nextId();

    sources.push({
      id,
      url,
      url_canonical: canonical,
      domain: domainOf(url),
      publisher: meta?.publisher ?? domainOf(url),
      title: meta?.title ?? "",
      tier,
      tier_label: tierLabel(tier),
      published_at: meta?.publishedAt ?? null,
      accessed_at: new Date().toISOString(),
      content_sha256: sha256(result.body),
      cache_path: relativeCachePath(url),
      fetch_method: result.outcome === "human_paste" ? "human_paste" : "http",
      degraded: result.degraded,
      origin_group: null,
      blocked: result.blocked,
      notes: result.blocked ? `not read: ${result.outcome}` : null,
    });

    if (meta?.text) textBySourceId.set(id, meta.text);
    log.info("harvested", { id, tier: tierLabel(tier), blocked: result.blocked, url });
  }

  // Group near-duplicates so recycled copy counts once.
  const groups = groupByOrigin(
    sources
      .filter((s) => textBySourceId.has(s.id))
      .map((s) => ({ id: s.id, text: textBySourceId.get(s.id) as string })),
  );
  for (const source of sources) {
    source.origin_group = groups.get(source.id) ?? source.origin_group;
  }

  return sources;
}

// --- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const linkedin = arg("linkedin");
  const existingSubject = await readJson<Subject | null>("subject.json", null);

  if (!linkedin && !existingSubject) {
    process.stderr.write(
      "Usage: npm start -- --linkedin <url> [--name \"First Last\"] [--company \"Firm\"] [--seed <url>]\n" +
        "       npm run demo    replays committed fixtures with no API key\n",
    );
    process.exit(2);
  }

  log.stage("identity");

  const plan = planResolution(linkedin ?? (existingSubject as Subject).linkedin_url, {
    name: arg("name") ?? existingSubject?.name,
    company: arg("company") ?? existingSubject?.company,
  });

  const company = arg("company") ?? existingSubject?.company ?? "";
  const role = arg("role") ?? existingSubject?.role ?? "";
  const selfDomains = [
    ...(existingSubject?.self_domains ?? []),
    ...argAll("self-domain"),
  ];

  // --- Harvest ---------------------------------------------------------------
  log.stage("harvest");

  let sources = await readJson<Source[]>("sources.json", []);
  const seeds = [...argAll("seed"), ...(await seedsFromFile(arg("seeds-file")))];

  let discovered: string[] = [];
  if (!OFFLINE || sources.length === 0) {
    for (const query of plan.searchQueries) {
      const results = await search(query, 8).catch(() => []);
      discovered.push(...results.map((r) => r.url));
    }
  }

  sources = await harvest([...seeds, ...discovered], sources, selfDomains);
  await writeJson("sources.json", sources);
  log.info("sources", {
    total: sources.length,
    readable: sources.filter((s) => !s.blocked).length,
    blocked: sources.filter((s) => s.blocked).length,
  });

  // --- Identity corroboration ------------------------------------------------
  const corroborations = corroborate(
    sources.map((s) => ({ source: s, text: textBySourceId.get(s.id) ?? "" })),
    { name: plan.name, role, company },
  );
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  const identityCount = independentCorroborationCount(corroborations, sourcesById);

  const subject: Subject = {
    id: "subj_001",
    name: plan.name,
    linkedin_url: linkedin ?? (existingSubject as Subject).linkedin_url,
    role,
    company,
    company_domain: selfDomains[0] ?? null,
    self_domains: selfDomains,
    location: arg("location") ?? existingSubject?.location ?? null,
    identity_corroborations: corroborations,
    assessed_at: new Date().toISOString(),
    pipeline_version: PIPELINE_VERSION,
  };
  await writeJson("subject.json", subject);
  log.info("identity corroboration", {
    independentDomains: identityCount,
    required: 2,
  });

  // --- Claim extraction ------------------------------------------------------
  log.stage("claims");

  let claims = await readJson<Claim[]>("claims.json", []);
  const alreadyExtracted = new Set(claims.map((c) => c.derived_from_source_id));
  const nextClaimId = sequence("clm", claims.map((c) => c.id));
  const misses: string[] = [];

  // Strongest sources first, so a budget or a rate limit costs us the least
  // valuable material rather than whatever happened to be last.
  const extractionOrder = [...sources]
    .filter((s) => !s.blocked)
    .sort((a, b) => b.tier - a.tier || a.id.localeCompare(b.id));

  log.info("extraction inputs", {
    readableSources: extractionOrder.length,
    withUsableText: extractionOrder.filter(
      (s) => (textBySourceId.get(s.id)?.length ?? 0) >= 200,
    ).length,
    alreadyDone: alreadyExtracted.size,
  });

  try {
    for (const source of extractionOrder) {
      if (!FORCE && alreadyExtracted.has(source.id)) continue;
      const text = textBySourceId.get(source.id);
      if (!text || text.length < 200) continue;

      let found;
      let rejected;
      try {
        ({ claims: found, rejected } = await extractClaims(
          source,
          text,
          { id: subject.id, name: subject.name, company: subject.company },
          llm.modelExtract,
        ));
      } catch (err) {
        if (err instanceof LlmBudgetError || err instanceof MissingKeyError) throw err;
        // One source failing must not cost us the sources already processed.
        // The run continues and the failure is recorded rather than thrown away.
        const reason = err instanceof Error ? err.message : String(err);
        misses.push(
          `${new Date().toISOString()} extraction failed for ${source.id} (${source.domain}): ${reason}`,
        );
        log.warn("extraction failed for one source, continuing", {
          source: source.id,
          error: reason,
        });
        continue;
      }

      for (const r of rejected) {
        misses.push(
          `${new Date().toISOString()} ${llm.modelExtract} produced an invalid claim from ${source.id}: ` +
            `${r.problems.join("; ")}. Text: "${r.text.slice(0, 120)}"`,
        );
      }

      const now = new Date().toISOString();
      for (const c of found) {
        claims.push({ ...c, id: nextClaimId(), created_at: now, updated_at: now });
      }
      log.info("extracted", {
        source: source.id,
        tier: source.tier_label,
        kept: found.length,
        rejected: rejected.length,
      });
      await writeJson("claims.json", claims);
    }
  } catch (err) {
    if (err instanceof MissingKeyError) throw err;
    if (err instanceof LlmBudgetError) log.warn(err.message);
    else throw err;
  }

  const { claims: deduped } = dedupe(claims);

  /**
   * Cap what goes forward to verification, strongest source first.
   *
   * Verification is the expensive stage and the page is one page. Carrying
   * eighty claims through would mean either exhausting the budget partway and
   * refusing the remainder for lack of evidence we never went looking for,
   * which reads as a finding and is not one, or printing a refusal ledger
   * nobody can read. Everything extracted stays in claims.json either way.
   */
  const MAX_VERIFIED_CLAIMS = 60;
  const tierOf = (c: Claim) => sourcesById.get(c.derived_from_source_id)?.tier ?? 0;

  /**
   * Round-robin across sources rather than straight tier order.
   *
   * Sorting purely by tier filled the whole budget with register minutiae and
   * company boilerplate, because the two primary pages and the company site
   * between them produced more claims than the cap allowed. Everything from the
   * press was deferred, which is exactly the material worth checking: the
   * numbers that circulate and disagree. Taking one claim per source in turn,
   * strongest source first, gives every document a voice on the page.
   */
  const bySource = new Map<string, Claim[]>();
  for (const claim of deduped) {
    const key = claim.derived_from_source_id;
    const bucket = bySource.get(key);
    if (bucket) bucket.push(claim);
    else bySource.set(key, [claim]);
  }

  const queues = [...bySource.entries()]
    .sort(([a], [b]) => (sourcesById.get(b)?.tier ?? 0) - (sourcesById.get(a)?.tier ?? 0) || a.localeCompare(b))
    .map(([, group]) => group);

  const ranked: Claim[] = [];
  for (let round = 0; ranked.length < deduped.length; round++) {
    let addedThisRound = false;
    for (const queue of queues) {
      const next = queue[round];
      if (!next) continue;
      ranked.push(next);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
  }

  claims = ranked.slice(0, MAX_VERIFIED_CLAIMS);
  const deferred = ranked.slice(MAX_VERIFIED_CLAIMS);
  log.info("verification set", {
    sourcesRepresented: new Set(claims.map((c) => c.derived_from_source_id)).size,
    topTier: tierOf(claims[0] as Claim),
  });
  if (deferred.length > 0) {
    log.warn("claims deferred beyond the verification cap", {
      verifying: claims.length,
      deferred: deferred.length,
    });
  }

  await writeJson("claims.json", [...claims, ...deferred]);
  log.info("claims", { total: deduped.length, verifying: claims.length });

  // --- Verification ----------------------------------------------------------
  log.stage("verify");

  let evidence = await readJson<Evidence[]>("evidence.json", []);
  const nextEvidenceId = sequence("ev", evidence.map((e) => e.id));
  const alreadyVerified = new Set(evidence.map((e) => e.claim_id));

  try {
    for (const claim of claims) {
      if (!FORCE && alreadyVerified.has(claim.id)) continue;

      const pass1 = await confirm(claim, sources, textBySourceId, {
        surname: plan.surname,
        company: subject.company,
      });
      const pass2 = await disconfirm(claim, pass1.evidence, sources, textBySourceId, {
        surname: plan.surname,
        company: subject.company,
      });

      misses.push(...pass1.misses, ...pass2.misses);

      const now = new Date().toISOString();
      for (const e of [...pass1.evidence, ...pass2.evidence]) {
        evidence.push({ ...e, id: nextEvidenceId(), created_at: now });
      }

      // Persist after each claim so a crash or rate limit loses at most one.
      await writeJson("evidence.json", evidence);
    }
  } catch (err) {
    if (err instanceof LlmBudgetError) log.warn(err.message);
    else throw err;
  }

  // --- Labelling, deterministic ----------------------------------------------
  log.stage("label");

  for (const claim of claims) {
    const forClaim = evidence.filter((e) => e.claim_id === claim.id);
    const result = label({
      claim,
      evidence: forClaim,
      sourcesById,
      candidateSources: sources,
      identityCorroborations: identityCount,
    });

    claim.status = result.status;
    claim.refusal_code = result.refusal_code;
    claim.refusal_note = result.note;
    claim.evidence_ids = forClaim.map((e) => e.id);
    claim.updated_at = new Date().toISOString();

    log.debug("labelled", { claim: claim.id, rule: result.rule, status: result.status });
  }

  // Deferred claims keep status `pending`: neither published nor presented as
  // refused, because nothing was checked. They stay in the ledger, visible.
  await writeJson("claims.json", [...claims, ...deferred]);

  const tally = {
    verified: claims.filter((c) => c.status === "VERIFIED").length,
    partial: claims.filter((c) => c.status === "PARTIALLY_VERIFIED").length,
    refused: claims.filter((c) => c.status === "UNVERIFIED").length,
  };
  log.info("labelled", tally);

  // --- Gaps ------------------------------------------------------------------
  log.stage("gaps");

  const observed = observeAll({ claims, sources, textBySourceId });
  const leading = topThree(observed);
  await writeJson<GapObservation[]>("gaps.json", leading);

  try {
    const prose = await analyze(leading, claims, subject);
    await fs.mkdir(paths.ledger, { recursive: true });
    await fs.writeFile(
      path.join(paths.ledger, "gap-prose.json"),
      JSON.stringify(prose, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    log.warn("gap prose unavailable, the computed observations still stand", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --- Record what the model got wrong ---------------------------------------
  const allMisses = [...misses, ...recordedMisses()];
  if (allMisses.length > 0) {
    const file = path.join(paths.ledger, "model-misses.log");
    await fs.appendFile(file, allMisses.join("\n") + "\n", "utf8");
    log.warn("model misses recorded", {
      count: allMisses.length,
      file: "ledger/model-misses.log",
    });
  }

  process.stderr.write(
    `\nDone. ${claims.length} claims: ${tally.verified} verified, ` +
      `${tally.partial} partially verified, ${tally.refused} refused.\n` +
      `Next: npm run review, then npm run render.\n\n`,
  );
}

main().catch((err: unknown) => {
  if (err instanceof MissingKeyError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  log.error("pipeline failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error && err.stack && process.env.DEBUG === "1") {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
