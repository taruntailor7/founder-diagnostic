#!/usr/bin/env node
/**
 * Starts the approval queue.
 *
 *   npm run review
 *
 * Binds to 127.0.0.1 by default. This is an internal operator tool handling an
 * unpublished assessment of a named private individual, and on a laptop the
 * operating system is the access control.
 *
 * A hosted instance has no such boundary, so binding wider requires a password.
 * The server refuses to listen on a public interface without one rather than
 * letting a deployment quietly become an open endpoint that anyone can spend
 * tokens through.
 */

import { createServer } from "../src/review/server.ts";
import { ReviewerRequiredError } from "../src/review/audit.ts";
import { log } from "../src/log.ts";

const PORT = Number.parseInt(process.env.PORT ?? "5173", 10);

/**
 * Hosts route to the container rather than to loopback, so a deployed instance
 * has to listen on 0.0.0.0. Detected by HOST rather than assumed.
 */
const HOST = process.env.HOST ?? "127.0.0.1";
const isPublic = HOST !== "127.0.0.1" && HOST !== "localhost";
const password = (process.env.APP_PASSWORD ?? "").trim();

async function main(): Promise<void> {
  if (isPublic && password === "") {
    process.stderr.write(
      `\nRefusing to listen on ${HOST} without APP_PASSWORD set.\n` +
        `  This tool has no user accounts. On a public interface that means\n` +
        `  anyone with the URL can start runs and spend your token budget.\n` +
        `  Set APP_PASSWORD, or leave HOST unset to bind to localhost.\n\n`,
    );
    process.exit(1);
  }

  const app = await createServer({ password: isPublic ? password : "" });

  app.listen(PORT, HOST, () => {
    process.stderr.write(
      `\nReview queue: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}\n` +
        (isPublic
          ? `Listening publicly on ${HOST}, password protected.\n`
          : `Bound to localhost only.\n`) +
        `Approvals append to ledger/approvals.jsonl. Nothing renders without one.\n\n`,
    );
  });
}

main().catch((err: unknown) => {
  if (err instanceof ReviewerRequiredError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  log.error("review server failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
