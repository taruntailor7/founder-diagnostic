import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, domainOf, hostOf, tierLabel } from "../src/sources/tiers.ts";
import { Tier } from "../src/types.ts";

describe("domainOf", () => {
  test("strips www and collapses to the registrable domain", () => {
    assert.equal(domainOf("https://www.thenationalnews.com/business/x"), "thenationalnews.com");
    assert.equal(domainOf("https://bloomberg.com/news"), "bloomberg.com");
  });

  test("keeps three labels for registry suffixes so service.gov.uk is not collapsed", () => {
    assert.equal(domainOf("https://service.gov.uk/thing"), "service.gov.uk");
    assert.equal(domainOf("https://register.fca.org.uk/x"), "fca.org.uk");
    assert.equal(domainOf("https://adgm.gov.ae/x"), "adgm.gov.ae");
  });

  test("handles deep subdomains", () => {
    assert.equal(domainOf("https://a.b.c.example.com/x"), "example.com");
  });

  test("tolerates a bare hostname", () => {
    assert.equal(domainOf("dfsa.ae"), "dfsa.ae");
  });
});

describe("hostOf", () => {
  test("preserves the full host for long primary registers", () => {
    assert.equal(
      hostOf("https://find-and-update.company-information.service.gov.uk/company/123"),
      "find-and-update.company-information.service.gov.uk",
    );
  });
});

describe("classify", () => {
  test("regulators and registers are primary", () => {
    assert.equal(classify("https://www.dfsa.ae/public-register/individuals/mr-khaled-talhouni"), Tier.PRIMARY);
    assert.equal(classify("https://www.adgm.com/public-registers/fsra/firms/x"), Tier.PRIMARY);
    assert.equal(classify("https://www.difc.ae/public-register"), Tier.PRIMARY);
  });

  test("a long primary host matches even though it collapses to a shorter domain", () => {
    assert.equal(
      classify("https://find-and-update.company-information.service.gov.uk/company/123"),
      Tier.PRIMARY,
    );
  });

  test("named journalism is secondary", () => {
    assert.equal(classify("https://www.reuters.com/x"), Tier.SECONDARY);
    assert.equal(classify("https://www.wamda.com/en/author/khaledtalhouni"), Tier.SECONDARY);
  });

  test("recycled and user-editable sources are aggregators", () => {
    assert.equal(classify("https://www.crunchbase.com/organization/x"), Tier.AGGREGATOR);
    assert.equal(classify("https://en.wikipedia.org/wiki/X"), Tier.AGGREGATOR);
    assert.equal(classify("https://www.prnewswire.com/news-releases/x"), Tier.AGGREGATOR);
  });

  test("an unknown domain defaults to aggregator, never to trusted", () => {
    assert.equal(classify("https://some-blog-nobody-has-heard-of.example/x"), Tier.AGGREGATOR);
  });

  test("selfDomains override every other list", () => {
    const opts = { selfDomains: ["nuwacapital.io", "reuters.com"] };
    assert.equal(classify("https://www.nuwacapital.io/insights", opts), Tier.SELF_REPORTED);
    // Even a normally secondary outlet is self-reported if the subject owns it.
    assert.equal(classify("https://www.reuters.com/x", opts), Tier.SELF_REPORTED);
  });

  test("selfDomains matching is case insensitive", () => {
    assert.equal(
      classify("https://NuwaCapital.io/x", { selfDomains: ["nuwacapital.io"] }),
      Tier.SELF_REPORTED,
    );
  });
});

describe("tierLabel", () => {
  test("maps every tier to its ledger label", () => {
    assert.equal(tierLabel(Tier.PRIMARY), "primary");
    assert.equal(tierLabel(Tier.SELF_REPORTED), "self_reported");
    assert.equal(tierLabel(Tier.SECONDARY), "secondary");
    assert.equal(tierLabel(Tier.AGGREGATOR), "aggregator");
  });
});
