/**
 * Ledger persistence. JSON files for collections, JSONL for append-only logs.
 *
 * Writes go to a temporary file and are then renamed over the target. Rename is
 * atomic within a filesystem, so a crash mid-write leaves the previous ledger
 * intact rather than a truncated one. SPEC.md section 1: a crash must never
 * lose the ledger.
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.ts";

export type LedgerFile =
  | "subject.json"
  | "sources.json"
  | "claims.json"
  | "evidence.json"
  | "gaps.json";

export type LedgerLog = "approvals.jsonl" | "fetch-events.jsonl";

const at = (name: string): string => path.join(paths.ledger, name);

async function ensureDir(): Promise<void> {
  await fs.mkdir(paths.ledger, { recursive: true });
}

// --- JSON collections ---------------------------------------------------------

export async function readJson<T>(file: LedgerFile, fallback: T): Promise<T> {
  const target = at(file);
  if (!existsSync(target)) return fallback;
  const raw = await fs.readFile(target, "utf8");
  if (raw.trim() === "") return fallback;
  return JSON.parse(raw) as T;
}

export async function writeJson<T>(file: LedgerFile, data: T): Promise<void> {
  await ensureDir();
  const target = at(file);
  // Same directory, so the rename stays on one filesystem and remains atomic.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

// --- Append-only logs ---------------------------------------------------------

export async function readJsonl<T>(file: LedgerLog): Promise<T[]> {
  const target = at(file);
  if (!existsSync(target)) return [];
  const raw = await fs.readFile(target, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/**
 * Append one line. Never rewrites, never deletes. `approvals.jsonl` is an audit
 * log: later lines supersede earlier ones for the same claim, and the history
 * of a reversed decision stays visible.
 */
export async function appendJsonl<T>(file: LedgerLog, row: T): Promise<void> {
  await ensureDir();
  await fs.appendFile(at(file), JSON.stringify(row) + "\n", "utf8");
}

export function ledgerPath(file: LedgerFile | LedgerLog): string {
  return at(file);
}
