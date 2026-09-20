/**
 * Source tiering, per SPEC.md section 5.
 *
 * The governing rule is the last one: anything unrecognised is an aggregator.
 * Unknown sources earn trust by being identified, not by default. Getting this
 * backwards would let an unknown domain carry a claim to VERIFIED.
 */

import { Tier, TIER_LABEL } from "../types.ts";
import type { TierValue, TierLabel } from "../types.ts";

/**
 * Second-level domains that are registry suffixes rather than registrable
 * names, so `service.gov.uk` is not collapsed to `gov.uk`.
 */
const REGISTRY_SLD = new Set(["gov", "co", "com", "org", "ac", "net", "edu"]);

/** Lowercase hostname, `www.` stripped, collapsed to the registrable domain. */
export function domainOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Tolerate a bare hostname, which is what the tier lists contain.
    host = url.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  }

  host = host.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  const secondToLast = labels[labels.length - 2];
  const keep = secondToLast && REGISTRY_SLD.has(secondToLast) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Full hostname with `www.` stripped, for exact matches against long hosts. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]?.replace(/^www\./, "") ?? "";
  }
}

// --- Tier lists ---------------------------------------------------------------
// Hand-curated and therefore incomplete. That limitation is stated in the
// README rather than hidden, because an incomplete list fails safe: an
// unlisted domain lands in AGGREGATOR and cannot carry a claim to VERIFIED.

/** First-hand records: regulators, registers, filings, courts. */
export const PRIMARY_DOMAINS = new Set([
  // UAE
  "difc.ae",
  "difc.com",
  "dfsa.ae",
  "adgm.com",
  "adgm.gov.ae",
  "sca.gov.ae",
  "centralbank.ae",
  "economy.gov.ae",
  "u.ae",
  "dubaided.gov.ae",
  // Elsewhere
  "sec.gov",
  "find-and-update.company-information.service.gov.uk",
  "register.fca.org.uk",
  "mca.gov.in",
]);

/** Independent journalism under a masthead with named editorial responsibility. */
export const SECONDARY_DOMAINS = new Set([
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "thenationalnews.com",
  "gulfnews.com",
  "khaleejtimes.com",
  "arabianbusiness.com",
  "zawya.com",
  "wamda.com",
  "menabytes.com",
  "techcrunch.com",
  "forbesmiddleeast.com",
  "agbi.com",
  "dealstreetasia.com",
  "vccircle.com",
  "incarabia.com",
]);

/**
 * Listed explicitly so the README can show them, even though an unlisted
 * domain would land here anyway. Naming them makes the classification
 * auditable rather than merely defaulted.
 */
export const AGGREGATOR_DOMAINS = new Set([
  "crunchbase.com",
  "tracxn.com",
  "pitchbook.com",
  "magnitt.com",
  "owler.com",
  "zoominfo.com",
  "rocketreach.co",
  "wikipedia.org",
  "medium.com",
  "substack.com",
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "getlatka.com",
  "cbinsights.com",
]);

export interface ClassifyOptions {
  /** The subject's own domains. Populated before harvest, from identity resolution. */
  selfDomains?: readonly string[];
}

/**
 * Both the full host and the registrable domain are checked against each list,
 * so a long primary host such as
 * `find-and-update.company-information.service.gov.uk` matches even though it
 * collapses to `service.gov.uk`.
 */
function inList(list: Set<string>, host: string, domain: string): boolean {
  return list.has(host) || list.has(domain);
}

export function classify(url: string, opts: ClassifyOptions = {}): TierValue {
  const host = hostOf(url);
  const domain = domainOf(url);

  const self = new Set((opts.selfDomains ?? []).map((d) => d.toLowerCase()));
  // Self-reported wins over everything. A company's own newsroom is the company
  // talking about itself regardless of how well designed the site is.
  if (inList(self, host, domain)) return Tier.SELF_REPORTED;

  if (inList(PRIMARY_DOMAINS, host, domain)) return Tier.PRIMARY;
  if (inList(SECONDARY_DOMAINS, host, domain)) return Tier.SECONDARY;

  return Tier.AGGREGATOR;
}

export function tierLabel(tier: TierValue): TierLabel {
  return TIER_LABEL[tier];
}

/** Human-readable publisher guess from the domain, overridden by page metadata when present. */
export function publisherFrom(url: string): string {
  const domain = domainOf(url);
  const base = domain.split(".")[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
