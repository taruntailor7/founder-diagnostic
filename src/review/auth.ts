/**
 * A password gate, used only when this is reachable from somewhere other than
 * the machine it runs on.
 *
 * The tool was built to bind to 127.0.0.1, where the operating system is the
 * access control and no password is needed. Putting it on a public host removes
 * that, and an open instance means anyone holding the URL can start runs and
 * spend the token budget.
 *
 * This is deliberately modest: one shared password over HTTP basic auth, which
 * is adequate for a demonstration behind TLS and is not a user system. It is
 * not a substitute for the localhost default, and the README says so.
 */

import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

/** Constant-time compare, so the response time cannot be used to guess. */
function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function passwordGate(password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Health checks must answer before auth or the host marks the service down.
    if (req.path === "/healthz") {
      next();
      return;
    }

    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");

    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const supplied = decoded.slice(decoded.indexOf(":") + 1);
      if (matches(supplied, password)) {
        next();
        return;
      }
    }

    res
      .status(401)
      .set("WWW-Authenticate", 'Basic realm="founder-diagnostic", charset="UTF-8"')
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Sign in</title>` +
          `<body style="font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;` +
          `max-width:34rem;margin:18vh auto;padding:0 1.5rem;color:#13161a">` +
          `<h1 style="font-size:17px;margin:0 0 6px">founder-diagnostic</h1>` +
          `<p style="color:#5b6672;font-size:13px">This instance is password protected. ` +
          `Leave the username blank.</p></body>`,
      );
  };
}
