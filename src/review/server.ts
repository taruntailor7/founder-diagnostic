/**
 * The human gate. SPEC.md section 12.1.
 *
 * Bound to 127.0.0.1 only, never 0.0.0.0. There is no delete route and no edit
 * route; the only write is an append. The server refuses to start without a
 * named reviewer, so the audit log cannot contain an anonymous approval.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import type { Request, Response } from "express";
import { paths, ROOT } from "../config.ts";
import { readJson } from "../ledger/store.ts";
import { log } from "../log.ts";
import { cancel, currentJob, isRunning, start, validate } from "./jobs.ts";
import { passwordGate } from "./auth.ts";
import { REFUSAL_EXPLANATION } from "../verify/label.ts";
import { TIER_LABEL } from "../types.ts";
import type { Claim, Decision, Evidence, Source, Subject } from "../types.ts";
import {
  latestByClaim,
  pendingReview,
  readApprovals,
  recordDecision,
  requireReviewer,
} from "./audit.ts";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const STYLE = `
:root { --ink:#13161a; --muted:#5b6672; --line:#dfe4ea; --bg:#f7f8fa;
        --ok:#0d7a4a; --part:#8a6100; --no:#a4243b; }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--ink);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
header { background:#fff; border-bottom:1px solid var(--line); padding:18px 28px; position:sticky; top:0; z-index:5 }
h1 { font-size:17px; margin:0 0 3px }
.sub { color:var(--muted); font-size:13px }
main { max-width:1040px; margin:0 auto; padding:24px 28px 80px }
.claim { background:#fff; border:1px solid var(--line); border-radius:8px; margin-bottom:18px; overflow:hidden }
.claim > .head { padding:14px 18px; border-bottom:1px solid var(--line) }
.claim > .body { padding:14px 18px }
.text { font-size:15px; font-weight:600; margin:0 0 8px }
.meta { font-size:12px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
.badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px;
         font-weight:700; letter-spacing:.04em; text-transform:uppercase; margin-right:8px }
.VERIFIED { background:#e2f4ea; color:var(--ok) }
.PARTIALLY_VERIFIED { background:#fdf0d5; color:var(--part) }
.UNVERIFIED { background:#fbe3e7; color:var(--no) }
.pending { background:#eceff3; color:var(--muted) }
.refusal { background:#fffaf0; border-left:3px solid var(--part); padding:10px 14px; margin:10px 0; font-size:13px }
.refusal code { font-weight:700 }
.ev { border-top:1px dashed var(--line); padding:12px 0; font-size:13px }
.ev:first-of-type { border-top:0 }
blockquote { margin:6px 0; padding:8px 12px; background:var(--bg); border-left:3px solid var(--line);
             font-style:italic; white-space:pre-wrap }
.pm span { display:inline-block; margin-right:10px; font-size:11px; font-family:ui-monospace,Menlo,monospace }
.t { color:var(--ok) } .f { color:var(--no); font-weight:700 } .n { color:var(--muted) }
.claim form { display:flex; gap:8px; align-items:center; margin-top:14px; flex-wrap:wrap }
.claim input[type=text] { flex:1; min-width:240px; padding:8px 10px; border:1px solid var(--line); border-radius:6px; font:inherit }
button { padding:8px 16px; border:1px solid var(--line); border-radius:6px; background:#fff;
         font:inherit; font-weight:600; cursor:pointer }
button.approve { background:var(--ok); color:#fff; border-color:var(--ok) }
button.reject { background:var(--no); color:#fff; border-color:var(--no) }
.empty { background:#fff; border:1px solid var(--line); border-radius:8px; padding:40px; text-align:center; color:var(--muted) }
a { color:#1a5fb4 }
.tier { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted) }
nav { display:flex; gap:18px; margin-top:10px; font-size:13px }
nav a { color:var(--muted); text-decoration:none; padding-bottom:3px; border-bottom:2px solid transparent }
nav a.on { color:var(--ink); font-weight:600; border-bottom-color:var(--ink) }
.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:22px 24px; margin-bottom:18px }
form.run { display:block }
.field { margin-bottom:16px; min-width:0 }
.field label { display:block; font-size:12px; font-weight:600; margin-bottom:5px; line-height:1.35; min-height:2.7em }
.field .hint { display:block; font-weight:400; color:var(--muted); font-size:11px; margin-top:1px }
.field input { display:block; width:100%; padding:10px 12px; border:1px solid var(--line);
               border-radius:6px; font:inherit; background:#fff }
.field input:focus { outline:2px solid var(--ink); outline-offset:-1px }
.row { display:grid; grid-template-columns:1fr 1fr; gap:0 16px }
.row-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:0 16px }
.actions { margin-top:6px; padding-top:18px; border-top:1px solid var(--line) }
.primary { background:var(--ink); color:#fff; border-color:var(--ink); padding:10px 22px }
.errors { background:#fbe3e7; color:var(--no); border-radius:6px; padding:10px 14px; margin-bottom:14px; font-size:13px }
.errors li { margin-left:16px }
pre.logs { background:#13161a; color:#d7dde4; border-radius:8px; padding:14px 16px; font:12px/1.5 ui-monospace,Menlo,monospace;
           max-height:420px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin:0 }
.state { display:inline-block; padding:3px 10px; border-radius:99px; font-size:11px; font-weight:700;
         text-transform:uppercase; letter-spacing:.04em }
.running { background:#fdf0d5; color:var(--part) }
.finished { background:#e2f4ea; color:var(--ok) }
.failed { background:#fbe3e7; color:var(--no) }
.steps { counter-reset:s; list-style:none; padding:0; margin:0 0 6px }
.steps li { counter-increment:s; padding:6px 0 6px 30px; position:relative; font-size:13px; color:var(--muted) }
.steps li::before { content:counter(s); position:absolute; left:0; top:5px; width:20px; height:20px; border-radius:50%;
                    background:var(--line); color:var(--ink); font-size:11px; font-weight:700; display:grid; place-items:center }
.steps li.done { color:var(--ink) }
.steps li.done::before { background:var(--ok); color:#fff }
.notice { background:#fffaf0; border:1px solid #f0e0c0; border-left:3px solid var(--part);
          border-radius:6px; padding:14px 16px; margin-bottom:18px; font-size:13px; line-height:1.55 }
.notice h3 { margin:0 0 6px; font-size:13px; color:var(--part) }
.notice table { border-collapse:collapse; margin:8px 0 6px; font-size:12px }
.notice td { padding:2px 16px 2px 0; vertical-align:top }
.notice td:first-child { color:var(--muted) }
.notice code { background:#f3ede0; padding:1px 5px; border-radius:3px;
               font:11px ui-monospace,Menlo,monospace }
`;

/**
 * Shown wherever someone might start a run or wait on one.
 *
 * The free tier is slow for a reason that has nothing to do with how the
 * pipeline is written, and a reader who does not know that will conclude the
 * tool is slow. Naming the limit, the arithmetic and the fix is cheaper than
 * letting them guess.
 */
const FREE_TIER_NOTICE = `
<div class="notice">
  <h3>Running on free models, which is why this takes minutes rather than seconds</h3>
  <p style="margin:0 0 4px">
    The models are Groq's free tier. The constraint is tokens per minute, not
    compute: each verification call is roughly 2,000 tokens against an 8,000
    token minute, so four calls a minute is the ceiling. One profile needs about
    160 calls.
  </p>
  <table>
    <tr><td>Free tier</td><td><strong>about 40 minutes</strong> per profile, and the 200,000 token daily cap is not enough to finish one</td></tr>
    <tr><td>Paid tier</td><td><strong>3 to 5 minutes</strong>, at roughly 5 to 10 cents per profile</td></tr>
  </table>
  <p style="margin:4px 0 0">
    Switching is one line in <code>.env</code>: the provider and the three model
    names are configuration, not code. Nothing else changes.
  </p>
</div>`;

/**
 * The committed ledger is a worked example, not a fixture the tool is tied to.
 *
 * Shipping it means Review and Diagnostic hold real content the moment the site
 * opens, rather than three empty tabs and a forty minute wait. Unlabelled, that
 * reads as the tool being hardcoded to one person.
 */
/**
 * A previous assessment is offered, not presented.
 *
 * Opening straight into somebody else's claims reads as though the tool is tied
 * to that person. It is a worked example, committed so there is something real
 * to read without running anything, and it should be something you choose to
 * look at.
 */
const PRIOR_ASSESSMENT = (
  name: string,
  where: "review" | "doc",
  counts: { verified: number; partial: number; refused: number; total: number },
): string => `
<div class="card">
  <div class="meta" style="margin-bottom:6px">Previous assessment</div>
  <p class="text" style="margin-bottom:10px">${esc(name)}</p>
  <div class="counts" style="margin-bottom:14px">
    <span>claims <b>${counts.total}</b></span>
    <span class="v">verified <b>${counts.verified}</b></span>
    <span class="p">partially verified <b>${counts.partial}</b></span>
    <span class="r">refused <b>${counts.refused}</b></span>
  </div>
  <a href="${where === "review" ? "/?open=1" : "/diagnostic?open=1"}">
    <button type="button" class="primary">
      ${where === "review" ? "Open the claims and evidence" : "Open the diagnostic"}
    </button>
  </a>
  <a href="/run"><button type="button">Analyse someone else</button></a>
  <p class="meta" style="margin:12px 0 0">
    A worked example committed to the repository. Analysing someone else archives
    it and starts clean.
  </p>
</div>`;

function nav(active: "run" | "review" | "doc", counts: { queue: number }): string {
  const item = (href: string, key: string, label: string) =>
    `<a href="${href}" class="${active === key ? "on" : ""}">${label}</a>`;
  return `<nav>
    ${item("/run", "run", "1. Analyse")}
    ${item("/", "review", `2. Review${counts.queue > 0 ? ` (${counts.queue})` : ""}`)}
    ${item("/diagnostic", "doc", "3. Diagnostic")}
  </nav>`;
}

function page(title: string, sub: string, navHtml: string, body: string, refresh = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
${refresh ? '<meta http-equiv="refresh" content="4">' : ""}
<style>${STYLE}</style></head>
<body>
<header><h1>${esc(title)}</h1><div class="sub">${sub}</div>${navHtml}</header>
<main>${body}</main>
</body></html>`;
}

function predicateMatchHtml(ev: Evidence): string {
  const cell = (key: string, v: boolean | null) => {
    const cls = v === true ? "t" : v === false ? "f" : "n";
    const mark = v === true ? "yes" : v === false ? "NO" : "silent";
    return `<span class="${cls}">${key}: ${mark}</span>`;
  };
  const m = ev.predicate_match;
  return `<div class="pm">${cell("value", m.value)}${cell("measures", m.measures)}${cell("population", m.population)}${cell("time", m.time)}</div>`;
}

function evidenceHtml(ev: Evidence, source: Source | undefined): string {
  return `
    <div class="ev">
      <div class="meta">
        pass ${ev.pass} &middot; ${esc(ev.stance)} &middot; model ${esc(ev.model)}
        ${source ? `&middot; <span class="tier">${esc(TIER_LABEL[source.tier])}</span>` : ""}
      </div>
      ${ev.quote ? `<blockquote>${esc(ev.quote)}</blockquote>` : ""}
      <div>${esc(ev.reasoning)}</div>
      ${predicateMatchHtml(ev)}
      ${
        source
          ? `<div class="meta"><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.publisher)}</a>
             ${source.published_at ? `&middot; published ${esc(source.published_at)}` : "&middot; undated"}
             ${source.degraded ? "&middot; DEGRADED" : ""}</div>`
          : ""
      }
    </div>`;
}

function claimHtml(
  claim: Claim,
  evidence: readonly Evidence[],
  sourcesById: ReadonlyMap<string, Source>,
  current: Decision | undefined,
): string {
  const rows = evidence.filter((e) => e.claim_id === claim.id);
  const explanation = claim.refusal_code
    ? REFUSAL_EXPLANATION[claim.refusal_code]
    : null;

  return `
  <section class="claim">
    <div class="head">
      <p class="text">${esc(claim.text)}</p>
      <span class="badge ${esc(claim.status)}">${esc(claim.status)}</span>
      <span class="meta">${esc(claim.id)} &middot; ${esc(claim.kind)}${current ? ` &middot; currently ${esc(current)}` : ""}</span>
      ${
        explanation
          ? `<div class="refusal"><code>${esc(claim.refusal_code)}</code> &mdash; ${esc(explanation)}
             ${claim.refusal_note ? `<br><span class="meta">${esc(claim.refusal_note)}</span>` : ""}</div>`
          : ""
      }
    </div>
    <div class="body">
      ${rows.length > 0 ? rows.map((e) => evidenceHtml(e, sourcesById.get(e.source_id))).join("") : `<div class="meta">No evidence rows.</div>`}
      <form method="post" action="/decide">
        <input type="hidden" name="claim_id" value="${esc(claim.id)}">
        <input type="text" name="note" placeholder="Note, for example: checked the DFSA entry myself">
        <button class="approve" name="decision" value="approve">Approve</button>
        <button name="decision" value="hold">Hold</button>
        <button class="reject" name="decision" value="reject">Reject</button>
      </form>
    </div>
  </section>`;
}

const run = promisify(execFile);

/** Renders via the same bin/render.ts the command line uses, gates included. */
async function renderDocument(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stderr } = await run(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", path.join(ROOT, "bin", "render.ts")],
      { cwd: ROOT, env: process.env },
    );
    return { ok: true, output: stderr };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, output: e.stderr || e.message || "render failed" };
  }
}

export interface ServerOptions {
  /** Empty on localhost, where the operating system is the access control. */
  password?: string;
}

export async function createServer(
  options: ServerOptions = {},
): Promise<express.Express> {
  const who = requireReviewer();
  const app = express();

  // Health check answers before the gate, or the host marks the service down.
  app.get("/healthz", (_req: Request, res: Response) => res.type("text").send("ok"));

  if (options.password) app.use(passwordGate(options.password));
  app.use(express.urlencoded({ extended: false }));

  const queueSize = async (): Promise<number> => {
    const [claims, approvals] = await Promise.all([
      readJson<Claim[]>("claims.json", []),
      readApprovals(),
    ]);
    return pendingReview(claims, approvals).filter(
      (c) => c.status === "VERIFIED" || c.status === "PARTIALLY_VERIFIED",
    ).length;
  };

  // --- 1. Analyse -------------------------------------------------------------

  app.get("/run", async (_req: Request, res: Response) => {
    const job = currentJob();
    const counts = { queue: await queueSize() };

    if (job) {
      const done = job.state !== "running";
      const body = `
        ${job.state === "running" ? FREE_TIER_NOTICE : ""}
        <div class="card">
          <span class="state ${esc(job.state)}">${esc(job.state)}</span>
          <span class="meta">&nbsp; ${esc(job.request.name)} &middot; ${esc(job.request.linkedin)}</span>
          ${
            done
              ? `<form method="post" action="/run/clear" style="margin-top:14px">
                   <button class="primary">${job.state === "finished" ? "Continue to review" : "Start over"}</button>
                 </form>`
              : `<form method="post" action="/run/cancel" style="margin-top:14px"><button>Stop</button></form>`
          }
        </div>
        <div class="card"><pre class="logs">${esc(job.lines.slice(-200).join("\n")) || "starting..."}</pre></div>`;
      res.type("html").send(
        page(
          "Analyse a profile",
          done
            ? job.state === "finished"
              ? "Finished. Every claim now needs a human decision before anything can be rendered."
              : `Stopped with exit code ${esc(job.exitCode)}. The ledger keeps whatever completed; running again resumes.`
            : "Researching, extracting claims and verifying each one twice. This takes several minutes.",
          nav("run", counts),
          body,
          !done,
        ),
      );
      return;
    }

    const body = `
      ${FREE_TIER_NOTICE}
      <div class="card">
        <ol class="steps">
          <li>Paste a public LinkedIn profile URL and confirm who the person is.</li>
          <li>Approve or reject each claim the system extracted.</li>
          <li>Render the one-page diagnostic.</li>
        </ol>
      </div>
      <form method="post" action="/run" class="card run">
        <div class="field">
          <label>LinkedIn profile URL
            <span class="hint">Used only to identify the person. Never fetched, because reading a profile needs a login.</span>
          </label>
          <input name="linkedin" placeholder="https://www.linkedin.com/in/their-handle" required>
        </div>

        <div class="row">
          <div class="field">
            <label>Full name
              <span class="hint">Required. First and last.</span>
            </label>
            <input name="name" placeholder="First Last" required>
          </div>
          <div class="field">
            <label>Company
              <span class="hint">Helps the search find the right person.</span>
            </label>
            <input name="company" placeholder="Their firm">
          </div>
        </div>

        <div class="row-3">
          <div class="field">
            <label>Role
              <span class="hint">As they describe it.</span>
            </label>
            <input name="role" placeholder="Founder and CEO">
          </div>
          <div class="field">
            <label>Their own website
              <span class="hint">So their words are not counted as independent.</span>
            </label>
            <input name="selfDomain" placeholder="theirfirm.com">
          </div>
          <div class="field">
            <label>Location
              <span class="hint">Optional.</span>
            </label>
            <input name="location" placeholder="Dubai, United Arab Emirates">
          </div>
        </div>

        <div class="actions">
          <button class="primary">Analyse</button>
          <span class="meta">&nbsp; Takes a few minutes. You can leave this page open.</span>
        </div>
      </form>`;

    res.type("html").send(
      page(
        "Analyse a profile",
        "Public sources only. Nobody is contacted, and nothing leaves this machine.",
        nav("run", counts),
        body,
      ),
    );
  });

  app.post("/run", async (req: Request, res: Response) => {
    if (isRunning()) {
      res.redirect("/run");
      return;
    }

    const request = {
      linkedin: String(req.body?.linkedin ?? ""),
      name: String(req.body?.name ?? ""),
      company: String(req.body?.company ?? ""),
      role: String(req.body?.role ?? ""),
      selfDomain: String(req.body?.selfDomain ?? ""),
      location: String(req.body?.location ?? ""),
    };

    const problems = validate(request);
    if (problems.length > 0) {
      const counts = { queue: await queueSize() };
      res.type("html").send(
        page(
          "Analyse a profile",
          "That did not look right.",
          nav("run", counts),
          `<div class="errors"><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
           <div class="card"><a href="/run">Back to the form</a></div>`,
        ),
      );
      return;
    }

    start(request);
    log.info("run started from the browser", { name: request.name });
    res.redirect("/run");
  });

  app.post("/run/cancel", (_req: Request, res: Response) => {
    cancel();
    res.redirect("/run");
  });

  app.post("/run/clear", (_req: Request, res: Response) => {
    res.redirect(currentJob()?.state === "finished" ? "/" : "/run");
  });

  // --- 3. Diagnostic ----------------------------------------------------------

  app.post("/render", async (_req: Request, res: Response) => {
    const result = await renderDocument();
    if (result.ok) {
      res.redirect("/diagnostic");
      return;
    }
    const counts = { queue: await queueSize() };
    res.type("html").send(
      page(
        "Diagnostic",
        "The document was not written. Both gates have to pass first.",
        nav("doc", counts),
        `<div class="card"><pre class="logs">${esc(result.output)}</pre></div>`,
      ),
    );
  });

  app.get("/diagnostic", async (req: Request, res: Response) => {
    const file = path.join(paths.out, "diagnostic.html");
    const counts = { queue: await queueSize() };
    const subject = await readJson<Subject | null>("subject.json", null);
    const opened = req.query["open"] === "1";

    /**
     * A rendered document on disk is not necessarily this subject's document.
     * Checked against the ledger rather than assumed, so a stale file cannot be
     * served under a new subject's name.
     */
    if (existsSync(file) && subject) {
      const html = await fs.readFile(file, "utf8");
      if (!html.includes(subject.name)) {
        res.type("html").send(
          page(
            "Diagnostic",
            "The document on disk is for a different subject.",
            nav("doc", counts),
            `<div class="card">
               <p>A rendered diagnostic exists, but it does not name
                  <strong>${esc(subject.name)}</strong>. It belongs to an earlier
                  assessment and will not be shown here.</p>
               <form method="post" action="/render"><button class="primary">Render for ${esc(subject.name)}</button></form>
             </div>`,
          ),
        );
        return;
      }
    }

    if (!existsSync(file)) {
      res.type("html").send(
        page(
          "Diagnostic",
          "Not rendered yet.",
          nav("doc", counts),
          `<div class="card">
             <p>The renderer refuses to write a document containing a claim nobody approved.
                ${counts.queue > 0 ? `<strong>${counts.queue}</strong> still need a decision.` : "Everything publishable is approved."}</p>
             <form method="post" action="/render"><button class="primary">Render the diagnostic</button></form>
           </div>`,
        ),
      );
      return;
    }

    if (!opened && subject) {
      const claims = await readJson<Claim[]>("claims.json", []);
      res.type("html").send(
        page(
          "Diagnostic",
          "A rendered assessment is available.",
          nav("doc", counts),
          PRIOR_ASSESSMENT(subject.name, "doc", {
            total: claims.length,
            verified: claims.filter((c) => c.status === "VERIFIED").length,
            partial: claims.filter((c) => c.status === "PARTIALLY_VERIFIED").length,
            refused: claims.filter((c) => c.status === "UNVERIFIED").length,
          }),
        ),
      );
      return;
    }

    res.type("html").send(
      page(
        "Diagnostic",
        "Rendered. Print this to PDF from your browser.",
        nav("doc", counts),
        `<div class="card">
           <form method="post" action="/render" style="display:inline"><button>Re-render</button></form>
           <a href="/diagnostic/raw" target="_blank"><button type="button">Open full page</button></a>
         </div>
         <div class="card" style="padding:0;overflow:hidden">
           <iframe src="/diagnostic/raw" style="width:100%;height:80vh;border:0"></iframe>
         </div>`,
      ),
    );
  });

  app.get("/diagnostic/raw", async (_req: Request, res: Response) => {
    const file = path.join(paths.out, "diagnostic.html");
    if (!existsSync(file)) {
      res.status(404).send("not rendered yet");
      return;
    }
    res.type("html").send(await fs.readFile(file, "utf8"));
  });

  app.get("/", async (req: Request, res: Response) => {
    const [subject, claims, evidence, sources, approvals] = await Promise.all([
      readJson<Subject | null>("subject.json", null),
      readJson<Claim[]>("claims.json", []),
      readJson<Evidence[]>("evidence.json", []),
      readJson<Source[]>("sources.json", []),
      readApprovals(),
    ]);

    const sourcesById = new Map(sources.map((s) => [s.id, s]));
    const decisions = latestByClaim(approvals);
    const queue = pendingReview(claims, approvals);

    const approvedCount = claims.filter(
      (c) => decisions.get(c.id)?.decision === "approve",
    ).length;

    const opened = req.query["open"] === "1";
    if (!opened && subject && claims.length > 0) {
      res.type("html").send(
        page(
          "Review",
          "Nothing renders without a decision recorded here.",
          nav("review", { queue: queue.filter((c) => c.status === "VERIFIED" || c.status === "PARTIALLY_VERIFIED").length }),
          PRIOR_ASSESSMENT(subject.name, "review", {
            total: claims.length,
            verified: claims.filter((c) => c.status === "VERIFIED").length,
            partial: claims.filter((c) => c.status === "PARTIALLY_VERIFIED").length,
            refused: claims.filter((c) => c.status === "UNVERIFIED").length,
          }),
        ),
      );
      return;
    }

    const body = `
${
  queue.length === 0
    ? `<div class="empty">
         ${claims.length === 0
            ? `Nothing analysed yet. <a href="/run">Start with a LinkedIn URL</a>.`
            : `Every publishable claim has a decision. <a href="/diagnostic">Render the diagnostic</a>.`}
       </div>`
    : queue
        .map((c) => claimHtml(c, evidence, sourcesById, decisions.get(c.id)?.decision))
        .join("")
}`;

    res.type("html").send(
      page(
        `Review${subject ? ` \u00b7 ${esc(subject.name)}` : ""}`,
        `Reviewer <strong>${esc(who)}</strong> &middot; ${queue.length} awaiting a decision &middot; ` +
          `${approvedCount} approved &middot; ${claims.length} claims. ` +
          `Refusals are listed first so they get read. Nothing renders without an approval recorded here.`,
        nav("review", { queue: queue.filter((c) => c.status === "VERIFIED" || c.status === "PARTIALLY_VERIFIED").length }),
        body,
      ),
    );
  });

  // Land on the form when the ledger is empty, so a first-time operator sees
  // somewhere to paste a URL rather than an empty queue.
  app.get("/start", async (_req: Request, res: Response) => {
    const claims = await readJson<Claim[]>("claims.json", []);
    res.redirect(claims.length === 0 ? "/run" : "/");
  });

  app.post("/decide", async (req: Request, res: Response) => {
    const claimId = String(req.body?.claim_id ?? "");
    const decision = String(req.body?.decision ?? "") as Decision;
    const note = String(req.body?.note ?? "");

    if (!claimId || !["approve", "reject", "hold"].includes(decision)) {
      res.status(400).send("claim_id and a valid decision are required");
      return;
    }

    const entry = await recordDecision(claimId, decision, note);
    log.info("decision recorded", {
      claim: claimId,
      decision,
      reviewer: entry.reviewer,
    });
    res.redirect("/");
  });

  // No PUT, PATCH or DELETE anywhere. The log is append only.
  return app;
}
