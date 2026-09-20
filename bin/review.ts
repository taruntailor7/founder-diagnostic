#!/usr/bin/env node
/**
 * Starts the approval queue on localhost.
 *
 *   npm run review
 *
 * Binds to 127.0.0.1 explicitly. This is an internal operator tool handling an
 * unpublished assessment of a named private individual; it has no business
 * listening on a network interface.
 */

import { createServer } from "../src/review/server.ts";
import { ReviewerRequiredError } from "../src/review/audit.ts";
import { log } from "../src/log.ts";

const PORT = Number.parseInt(process.env.PORT ?? "5173", 10);
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  const app = await createServer();
  app.listen(PORT, HOST, () => {
    process.stderr.write(
      `\nReview queue: http://${HOST}:${PORT}\n` +
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
