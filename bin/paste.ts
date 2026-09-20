#!/usr/bin/env node
/**
 * Human-paste fallback for pages automated fetching cannot reach.
 *
 *   npm run paste -- <url>   # then paste the page text, then Ctrl-D
 *
 * The DIFC register sits behind a Vercel bot checkpoint and ADGM behind
 * Cloudflare, both of which require JavaScript. Both are primary sources, so
 * losing them would mean losing the strongest evidence available. Pasting them
 * in keeps the evidence and records exactly how it arrived: `human_paste` and
 * `degraded: true`, with a fetch event naming the degradation.
 *
 * The point is not that degradation is avoided. It is that it is never silent.
 */

import { storePaste } from "../src/sources/fetch.ts";
import { log } from "../src/log.ts";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Paste the page text, then press Ctrl-D:\n\n");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    process.stderr.write(
      "Usage: npm run paste -- <url>\n" +
        "  Reads the page text from stdin and stores it as a degraded source.\n",
    );
    process.exit(2);
  }

  const text = await readStdin();
  if (text.trim().length < 50) {
    log.error("refusing to store an almost-empty paste", {
      url,
      characters: text.trim().length,
    });
    process.exit(1);
  }

  await storePaste(url, text);
  log.info("stored as human_paste", { url, characters: text.length });
  process.stderr.write(
    "\nRecorded with fetch_method=human_paste and degraded=true.\n" +
      "It will appear in the sources appendix marked as such.\n",
  );
}

main().catch((err: unknown) => {
  log.error("paste failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
