/**
 * Structured logging to stderr, so stdout stays clean for piped output.
 */

type Level = "debug" | "info" | "warn" | "error";

const COLOUR: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";
const useColour = process.stderr.isTTY === true;
const showDebug = process.env.DEBUG === "1";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (level === "debug" && !showDebug) return;

  const tag = level.toUpperCase().padEnd(5);
  const head = useColour ? `${COLOUR[level]}${tag}${RESET}` : tag;
  const tail = fields
    ? " " +
      Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";

  process.stderr.write(`${head} ${msg}${tail}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),

  /** Stage banners, so a long run is readable while it happens. */
  stage: (name: string) => {
    const bar = "-".repeat(Math.max(0, 68 - name.length));
    process.stderr.write(`\n${name} ${bar}\n`);
  },
};
