/**
 * The render gate, tested end to end by running the real binary.
 *
 * Unit-testing the gate function would prove the function works. This proves
 * the *build* refuses, which is the actual promise: a claim without a human
 * approval cannot become a document, whatever the calling code does.
 *
 * FD_ROOT points the renderer at a temporary ledger so the repo's own is never
 * touched.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Approval, Claim, Source, Subject } from "../src/types.ts";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let root = "";

const SUBJECT: Subject = {
  id: "subj_001",
  name: "Khaled Talhouni",
  linkedin_url: "https://www.linkedin.com/in/khaledtalhouni/",
  role: "Founder and Managing Partner",
  company: "Nuwa Capital",
  company_domain: "nuwacapital.io",
  self_domains: ["nuwacapital.io"],
  location: "Dubai, United Arab Emirates",
  identity_corroborations: [
    { source_id: "src_0001", attribute: "role", value: "Founder and Managing Partner" },
    { source_id: "src_0002", attribute: "company", value: "Nuwa Capital" },
  ],
  assessed_at: "2026-09-20T00:00:00Z",
  pipeline_version: "1.0.0",
};

const SOURCES: Source[] = [
  {
    id: "src_0001",
    url: "https://www.dfsa.ae/public-register/individuals/mr-khaled-talhouni",
    url_canonical: "dfsa.ae/public-register/individuals/mr-khaled-talhouni",
    domain: "dfsa.ae",
    publisher: "DFSA Public Register",
    title: "Individuals",
    tier: 4,
    tier_label: "primary",
    published_at: "2020-11-19",
    accessed_at: "2026-09-20T00:00:00Z",
    content_sha256: "a".repeat(64),
    cache_path: "fixtures/http/a.json",
    fetch_method: "http",
    degraded: false,
    origin_group: "og_001",
    blocked: false,
    notes: null,
  },
];

const CLAIM: Claim = {
  id: "clm_0001",
  subject_id: "subj_001",
  text: "He is a Licensed Director and Senior Executive Officer of Nuwa Capital Limited",
  kind: "role",
  predicate: {
    action: "holds",
    object: "Licensed Director and Senior Executive Officer",
    value: null,
    measures: null,
    population: null,
    time: { raw: "from 2020-11-19", start: "2020-11-19", end: null },
  },
  derived_from_source_id: "src_0001",
  status: "PARTIALLY_VERIFIED",
  refusal_code: null,
  refusal_note: null,
  evidence_ids: [],
  footnote_id: null,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
};

async function writeLedger(approvals: Approval[], claims: Claim[] = [CLAIM]) {
  const dir = path.join(root, "ledger");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "subject.json"), JSON.stringify(SUBJECT));
  await fs.writeFile(path.join(dir, "sources.json"), JSON.stringify(SOURCES));
  await fs.writeFile(path.join(dir, "claims.json"), JSON.stringify(claims));
  await fs.writeFile(path.join(dir, "evidence.json"), JSON.stringify([]));
  await fs.writeFile(path.join(dir, "gaps.json"), JSON.stringify([]));
  await fs.writeFile(
    path.join(dir, "approvals.jsonl"),
    approvals.map((a) => JSON.stringify(a)).join("\n") + (approvals.length ? "\n" : ""),
  );
}

async function render(): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "bin/render.ts"],
      { cwd: REPO, env: { ...process.env, FD_ROOT: root } },
    );
    return { code: 0, stderr };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? "" };
  }
}

describe("the render gate", () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fd-gate-"));
  });

  after(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  test("refuses to render when the referenced claim has no approval", async () => {
    await writeLedger([]);
    const { code, stderr } = await render();

    assert.notEqual(code, 0, "render must exit non-zero");
    assert.match(stderr, /clm_0001/);
    assert.doesNotMatch(stderr, /Wrote out\//);

    const wrote = await fs
      .access(path.join(root, "out", "diagnostic.html"))
      .then(() => true)
      .catch(() => false);
    assert.equal(wrote, false, "no document may be written when the gate fails");
  });

  test("refuses when the latest decision is a rejection", async () => {
    await writeLedger([
      { ts: "2026-09-20T00:00:00Z", claim_id: "clm_0001", decision: "approve", reviewer: "T", note: null },
      { ts: "2026-09-20T01:00:00Z", claim_id: "clm_0001", decision: "reject", reviewer: "T", note: "withdrawn" },
    ]);
    const { code, stderr } = await render();

    assert.notEqual(code, 0);
    assert.match(stderr, /clm_0001/);
  });

  test("a human approval cannot promote an UNVERIFIED claim into the body", async () => {
    // Approval is necessary but not sufficient. The rules refused this claim,
    // so it belongs in the refusal ledger whatever a reviewer clicked. The
    // render succeeds; the claim simply never reaches the body.
    await writeLedger(
      [{ ts: "2026-09-20T00:00:00Z", claim_id: "clm_0001", decision: "approve", reviewer: "T", note: null }],
      [{ ...CLAIM, status: "UNVERIFIED", refusal_code: "NO_PRIMARY" }],
    );

    const { code, stderr } = await render();
    assert.equal(code, 0, `expected a clean render, got:\n${stderr}`);

    const md = await fs.readFile(path.join(root, "out", "diagnostic.md"), "utf8");
    const [bodyText = "", refusalSection = ""] = md.split("## What we refused to publish");

    assert.doesNotMatch(bodyText, /Licensed Director/, "refused claim must not reach the body");
    assert.match(refusalSection, /Licensed Director/, "refused claim must appear in the refusal ledger");
    assert.match(refusalSection, /NO_PRIMARY/);

    const refusals = await fs.readFile(path.join(root, "out", "refusals.md"), "utf8");
    assert.match(refusals, /NO_PRIMARY/);
  });

  test("renders once a genuine approval exists", async () => {
    await writeLedger([
      {
        ts: "2026-09-20T00:00:00Z",
        claim_id: "clm_0001",
        decision: "approve",
        reviewer: "Tarun Tailor",
        note: "Checked the DFSA entry myself",
      },
    ]);
    const { code, stderr } = await render();

    assert.equal(code, 0, `render should succeed, got:\n${stderr}`);

    const html = await fs.readFile(path.join(root, "out", "diagnostic.html"), "utf8");
    assert.match(html, /Khaled Talhouni/);
    assert.match(html, /Licensed Director/);
    assert.match(html, /dfsa\.ae/);
  });

  test("a later approval reinstates a previously rejected claim", async () => {
    await writeLedger([
      { ts: "2026-09-20T00:00:00Z", claim_id: "clm_0001", decision: "reject", reviewer: "T", note: null },
      { ts: "2026-09-20T02:00:00Z", claim_id: "clm_0001", decision: "approve", reviewer: "T", note: "resolved" },
    ]);
    const { code } = await render();
    assert.equal(code, 0);
  });
});
