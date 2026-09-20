/**
 * Identity resolution. The LinkedIn URL is an anchor, never a data source.
 *
 * Nothing behind a login may be touched, so the URL is treated purely as an
 * identity string: it tells us who we are researching and nothing else. Role,
 * company and every subsequent fact come from the open web.
 *
 * Two independent corroborations are required before anything downstream is
 * trusted. Without that, a namesake's press coverage would be harvested,
 * verified and published under the wrong person's diagnostic, and every
 * individual claim would look perfectly well sourced.
 */

import { log } from "../log.ts";
import { domainOf } from "../sources/tiers.ts";
import type { IdentityCorroboration, Source } from "../types.ts";

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

/** Extracts the profile handle. No request is ever made to LinkedIn. */
export function handleFrom(linkedinUrl: string): string {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(linkedinUrl);
  if (!m?.[1]) {
    throw new IdentityError(
      `Not a LinkedIn profile URL: ${linkedinUrl}\n` +
        `  Expected something of the form https://www.linkedin.com/in/<handle>`,
    );
  }
  return decodeURIComponent(m[1]).toLowerCase();
}

/**
 * A readable name guess from the handle, used only to seed searching.
 * Handles carry trailing id fragments and dropped spaces, so this is a hint
 * for the operator to confirm, never an assertion about the person.
 */
export function nameGuessFrom(handle: string): string {
  return handle
    .replace(/-?[0-9a-f]{6,}$/i, "")
    .replace(/-\d+$/, "")
    .split(/[-_.]+/)
    .filter((part) => part.length > 0 && !/^\d+$/.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();
}

function surnameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? (parts.at(-1) as string) : name.trim();
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** True when the text plausibly refers to this person, not merely this name. */
function mentionsSubject(text: string, name: string): boolean {
  const body = norm(text);
  if (body.includes(norm(name))) return true;

  // Allow for middle names and reordering: require every name part present.
  const parts = norm(name).split(" ").filter((p) => p.length > 2);
  return parts.length > 1 && parts.every((p) => body.includes(p));
}

export interface CorroborationInput {
  source: Source;
  text: string;
}

/**
 * Finds sources that independently confirm the subject's role and company.
 *
 * A corroboration requires the name and the attribute in the same document.
 * Corroborations from one domain count once: two pages of the same company
 * site agreeing with each other is one claim about identity, not two.
 */
export function corroborate(
  candidates: readonly CorroborationInput[],
  subject: { name: string; role: string; company: string },
): IdentityCorroboration[] {
  const found: IdentityCorroboration[] = [];
  const seen = new Set<string>();

  for (const { source, text } of candidates) {
    if (source.blocked || text.trim() === "") continue;
    if (!mentionsSubject(text, subject.name)) continue;

    const body = norm(text);

    for (const [attribute, value] of [
      ["company", subject.company],
      ["role", subject.role],
    ] as const) {
      if (value.trim() === "") continue;
      if (!body.includes(norm(value))) continue;

      const key = `${domainOf(source.url)}:${attribute}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({ source_id: source.id, attribute, value });
    }
  }

  return found;
}

/**
 * Corroborations that come from genuinely different domains.
 *
 * This is the number the labeller's rule 1 compares against two. Counting raw
 * corroborations instead would let one well-linked site corroborate itself.
 */
export function independentCorroborationCount(
  corroborations: readonly IdentityCorroboration[],
  sourcesById: ReadonlyMap<string, Source>,
): number {
  const domains = new Set<string>();
  for (const c of corroborations) {
    const source = sourcesById.get(c.source_id);
    if (source) domains.add(source.domain);
  }
  return domains.size;
}

export interface ResolveResult {
  name: string;
  handle: string;
  surname: string;
  /** Queries for the harvest stage, most specific first. */
  searchQueries: string[];
}

export function planResolution(
  linkedinUrl: string,
  hints: { name?: string; company?: string } = {},
): ResolveResult {
  const handle = handleFrom(linkedinUrl);
  const name = hints.name?.trim() || nameGuessFrom(handle);

  if (name.split(/\s+/).length < 2) {
    throw new IdentityError(
      `Could not derive a full name from the handle "${handle}".\n` +
        `  Pass one explicitly: --name "First Last"`,
    );
  }

  const company = hints.company?.trim() ?? "";
  const queries = [
    company ? `"${name}" "${company}"` : `"${name}"`,
    `"${name}" DIFC OR ADGM founder OR "managing partner"`,
    `"${name}" interview OR podcast`,
    company ? `"${company}" DFSA OR FSRA register` : `"${name}" register`,
  ].filter(Boolean);

  log.info("identity anchor", { handle, name, company: company || "(unknown)" });

  return { name, handle, surname: surnameOf(name), searchQueries: queries };
}
