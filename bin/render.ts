#!/usr/bin/env node
/**
 * Renders the diagnostic, behind two gates. SPEC.md section 12.2.
 *
 *   npm run render
 *   npm run lint:doc     # gates only, writes nothing
 *
 * Gate one is the house-style linter. Gate two independently re-checks that
 * every claim a footnote points at carries a human approval.
 *
 * Gate two duplicates a linter rule on purpose. The guarantee that nothing
 * unapproved reaches a client should not rest on a single check, and the two
 * read the ledger by different routes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../src/config.ts";
import { readJson } from "../src/ledger/store.ts";
import { log } from "../src/log.ts";
import { readApprovals, latestByClaim } from "../src/review/audit.ts";
import { build } from "../src/render/diagnostic.ts";
import type { GapProse } from "../src/render/diagnostic.ts";
import { lint, formatViolations } from "../src/render/housestyle.ts";
import { toHtml } from "../src/render/template.ts";
import { REFUSAL_EXPLANATION } from "../src/verify/label.ts";
import type { Claim, GapObservation, Source, Subject } from "../src/types.ts";

const LINT_ONLY = process.argv.includes("--lint-only");

function refusalsMarkdown(claims: readonly Claim[]): string {
  const refused = claims.filter((c) => c.status === "UNVERIFIED");
  const out = [
    "# What this system refused to publish",
    "",
    "Every claim below was extracted from a public source and then refused. None",
    "of them appears in the diagnostic body. The refusal, not the verification, is",
    "the point: these are things said in public about this person that could not be",
    "established from a source worth defending.",
    "",
  ];

  if (refused.length === 0) {
    out.push("Nothing was refused in this run.");
    return out.join("\n") + "\n";
  }

  for (const claim of refused) {
    out.push(`## ${claim.text}`);
    out.push("");
    out.push(`- **Code:** \`${claim.refusal_code ?? "UNVERIFIED"}\``);
    if (claim.refusal_code) {
      out.push(`- **Why:** ${REFUSAL_EXPLANATION[claim.refusal_code]}`);
    }
    if (claim.refusal_note) out.push(`- **Detail:** ${claim.refusal_note}`);
    out.push(`- **Claim id:** \`${claim.id}\``);
    out.push("");
  }

  return out.join("\n") + "\n";
}

/** Gate two: the approval check, run independently of the linter. */
function unapprovedReferences(
  markdown: string,
  claims: readonly Claim[],
  approvals: Awaited<ReturnType<typeof readApprovals>>,
): string[] {
  const decisions = latestByClaim(approvals);
  const byId = new Map(claims.map((c) => [c.id, c]));
  const failures: string[] = [];

  for (const m of markdown.matchAll(/^\[\^[^\]]+\]:.*?claim:(\S+)/gm)) {
    const id = m[1];
    if (!id) continue;

    const claim = byId.get(id);
    if (!claim) {
      failures.push(`${id} is referenced by a footnote but is not in claims.json`);
      continue;
    }
    if (decisions.get(id)?.decision !== "approve") {
      const actual = decisions.get(id)?.decision ?? "no decision recorded";
      failures.push(`${id} has ${actual}, not an approval`);
    }
    if (claim.status === "UNVERIFIED" || claim.status === "pending") {
      failures.push(`${id} is ${claim.status} and cannot be published`);
    }
  }

  return failures;
}

async function main(): Promise<void> {
  const [subject, claims, sources, gaps, approvals] = await Promise.all([
    readJson<Subject | null>("subject.json", null),
    readJson<Claim[]>("claims.json", []),
    readJson<Source[]>("sources.json", []),
    readJson<GapObservation[]>("gaps.json", []),
    readApprovals(),
  ]);

  if (!subject) {
    log.error("no subject.json; run the pipeline first with: npm start -- --linkedin <url>");
    process.exit(1);
  }

  const prosePath = path.join(paths.ledger, "gap-prose.json");
  const gapProse = await fs
    .readFile(prosePath, "utf8")
    .then((raw) => JSON.parse(raw) as GapProse[])
    .catch(() => [] as GapProse[]);

  const markdown = build({ subject, claims, sources, approvals, gaps, gapProse });

  // Gate one.
  const violations = lint(markdown, {
    claimsById: new Map(claims.map((c) => [c.id, c])),
    sourcesById: new Map(sources.map((s) => [s.id, s])),
    approvals,
  });

  if (violations.length > 0) {
    process.stderr.write(
      `\nHouse style check failed: ${violations.length} violation(s).\n\n` +
        formatViolations(violations) +
        `\n\nNothing was written.\n\n`,
    );
    process.exit(1);
  }

  // Gate two.
  const unapproved = unapprovedReferences(markdown, claims, approvals);
  if (unapproved.length > 0) {
    process.stderr.write(
      `\nApproval gate failed. The document references claims that are not approved:\n\n` +
        unapproved.map((f) => `  - ${f}`).join("\n") +
        `\n\nRun: npm run review\nNothing was written.\n\n`,
    );
    process.exit(1);
  }

  if (LINT_ONLY) {
    process.stderr.write("\nBoth gates passed. Nothing written (--lint-only).\n\n");
    return;
  }

  await fs.mkdir(paths.out, { recursive: true });
  await fs.writeFile(path.join(paths.out, "diagnostic.md"), markdown, "utf8");
  await fs.writeFile(path.join(paths.out, "diagnostic.html"), toHtml(markdown), "utf8");
  await fs.writeFile(path.join(paths.out, "refusals.md"), refusalsMarkdown(claims), "utf8");

  const refused = claims.filter((c) => c.status === "UNVERIFIED").length;
  process.stderr.write(
    `\nWrote out/diagnostic.html, out/diagnostic.md and out/refusals.md\n` +
      `  ${claims.length} claims, ${refused} refused and printed on the page.\n` +
      `  For the PDF: open out/diagnostic.html in a browser and print to PDF.\n\n`,
  );
}

main().catch((err: unknown) => {
  log.error("render failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
