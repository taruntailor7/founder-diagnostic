/**
 * Running the pipeline from the browser.
 *
 * One job at a time, deliberately. Two concurrent runs would write the same
 * ledger files and interleave their claim ids, and the append-only audit log
 * would end up describing a state that never existed. A single slot is the
 * honest constraint for a local operator tool, and it is enforced here rather
 * than left to whoever clicks fastest.
 *
 * The child runs the same `bin/run.ts` the command line uses. There is no
 * second code path, so the button cannot drift from the documented behaviour.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { ROOT } from "../config.ts";

export type JobState = "running" | "finished" | "failed";

export interface JobRequest {
  linkedin: string;
  name: string;
  company: string;
  role: string;
  selfDomain: string;
  location: string;
  /**
   * Starting URLs, one per line.
   *
   * Required in practice on a hosted instance. Search engines refuse requests
   * from datacenter addresses, so discovery returns nothing and the harvest has
   * no pages to read. Supplying starting points is not a workaround for a
   * missing feature; it is how an operator points the tool at the register
   * entry and the coverage they already know about.
   */
  seeds: string;
}

export interface Job {
  id: string;
  state: JobState;
  request: JobRequest;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  /** Newest last. Capped, because a long run produces thousands of lines. */
  lines: string[];
}

const MAX_LINES = 400;

let current: Job | null = null;
let child: ChildProcess | null = null;

export const currentJob = (): Job | null => current;
export const isRunning = (): boolean => current?.state === "running";

export function validate(req: Partial<JobRequest>): string[] {
  const problems: string[] = [];

  const url = (req.linkedin ?? "").trim();
  if (!/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+/i.test(url)) {
    problems.push(
      "LinkedIn URL should look like https://www.linkedin.com/in/their-handle",
    );
  }

  if ((req.name ?? "").trim().split(/\s+/).length < 2) {
    problems.push("Full name is required, first and last");
  }

  // The company name goes into search queries verbatim. A pasted LinkedIn
  // headline such as "Working as a SDE 2 at GoDaddy" matches nothing and the
  // harvest silently returns no results.
  const company = (req.company ?? "").trim();
  if (company.split(/\s+/).length > 5 || /\b(working|at|senior|engineer|manager)\b/i.test(company)) {
    problems.push(
      `Company should be the organisation name on its own, for example "GoDaddy" rather than a job title or headline`,
    );
  }

  for (const line of parseSeeds(req.seeds ?? "")) {
    if (!/^https?:\/\/\S+$/.test(line)) {
      problems.push(`Not a URL: ${line.slice(0, 60)}`);
    }
  }

  return problems;
}

/**
 * The subject's own domains decide what counts as self-reported rather than
 * independent, so a typo here silently promotes the company's own site to a
 * corroborating source. Normalised rather than trusted as typed.
 */
function normaliseDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";
}

/** One URL per line, blanks and comments ignored. */
export function parseSeeds(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function start(req: JobRequest): Job {
  if (isRunning()) throw new Error("a run is already in progress");

  const args = [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    path.join(ROOT, "bin", "run.ts"),
    "--linkedin", req.linkedin.trim(),
    "--name", req.name.trim(),
  ];

  if (req.company.trim()) args.push("--company", req.company.trim());
  if (req.role.trim()) args.push("--role", req.role.trim());
  if (req.location.trim()) args.push("--location", req.location.trim());

  const domain = normaliseDomain(req.selfDomain);
  if (domain) args.push("--self-domain", domain);

  for (const seed of parseSeeds(req.seeds)) args.push("--seed", seed);

  const job: Job = {
    id: `job_${Date.now()}`,
    state: "running",
    request: { ...req, selfDomain: domain },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    lines: [],
  };

  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const absorb = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const text = line.trimEnd();
      if (text === "") continue;
      job.lines.push(text);
      if (job.lines.length > MAX_LINES) job.lines.shift();
    }
  };

  // The pipeline logs progress to stderr and keeps stdout clean, so both are
  // captured and stderr is the interesting one.
  proc.stdout?.on("data", absorb);
  proc.stderr?.on("data", absorb);

  proc.on("close", (code) => {
    job.state = code === 0 ? "finished" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    child = null;
  });

  proc.on("error", (err) => {
    job.state = "failed";
    job.lines.push(`failed to start: ${err.message}`);
    job.finishedAt = new Date().toISOString();
    child = null;
  });

  current = job;
  child = proc;
  return job;
}

export function cancel(): boolean {
  if (!child || !isRunning()) return false;
  child.kill("SIGTERM");
  return true;
}
