import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  independentSources,
  isCircular,
  maxTier,
  pickRepresentative,
  uniqueDomains,
} from "../src/verify/independence.ts";
import { Tier } from "../src/types.ts";
import { byId, ev, src } from "./helpers.ts";

describe("independentSources", () => {
  test("five outlets carrying one release count as one independent source", () => {
    // The exact shape of the Nuwa funding announcement: same wire copy, five
    // mastheads, all in origin group og_001.
    const sources = [
      src("src_0001", Tier.SECONDARY, "bloomberg.com", { origin_group: "og_001" }),
      src("src_0002", Tier.SECONDARY, "thenationalnews.com", { origin_group: "og_001" }),
      src("src_0003", Tier.SECONDARY, "zawya.com", { origin_group: "og_001" }),
      src("src_0004", Tier.AGGREGATOR, "prnewswire.com", { origin_group: "og_001" }),
      src("src_0005", Tier.AGGREGATOR, "crunchbase.com", { origin_group: "og_001" }),
    ];
    const evidence = sources.map((s, i) => ev(`ev_000${i + 1}`, s.id, "supports"));

    const result = independentSources(evidence, byId(sources));

    assert.equal(result.length, 1, "one origin is one source, however many outlets carry it");
  });

  test("distinct origins are counted separately", () => {
    const sources = [
      src("src_0001", Tier.PRIMARY, "dfsa.ae", { origin_group: "og_001" }),
      src("src_0002", Tier.SECONDARY, "reuters.com", { origin_group: "og_002" }),
    ];
    const evidence = [
      ev("ev_0001", "src_0001", "supports"),
      ev("ev_0002", "src_0002", "supports"),
    ];

    assert.equal(independentSources(evidence, byId(sources)).length, 2);
  });

  test("an ungrouped source stands alone rather than merging", () => {
    const sources = [
      src("src_0001", Tier.SECONDARY, "a.com"),
      src("src_0002", Tier.SECONDARY, "b.com"),
    ];
    const evidence = [
      ev("ev_0001", "src_0001", "supports"),
      ev("ev_0002", "src_0002", "supports"),
    ];

    assert.equal(independentSources(evidence, byId(sources)).length, 2);
  });

  test("only supporting evidence counts", () => {
    const sources = [
      src("src_0001", Tier.SECONDARY, "a.com"),
      src("src_0002", Tier.SECONDARY, "b.com"),
    ];
    const evidence = [
      ev("ev_0001", "src_0001", "supports"),
      ev("ev_0002", "src_0002", "contradicts"),
      ev("ev_0003", "src_0002", "not_found"),
    ];

    const result = independentSources(evidence, byId(sources));
    assert.deepEqual(result.map((s) => s.id), ["src_0001"]);
  });
});

describe("pickRepresentative", () => {
  test("the highest tier represents the group", () => {
    const group = [
      src("src_0001", Tier.AGGREGATOR, "prnewswire.com"),
      src("src_0002", Tier.PRIMARY, "dfsa.ae"),
      src("src_0003", Tier.SECONDARY, "reuters.com"),
    ];
    assert.equal(pickRepresentative(group)?.id, "src_0002");
  });

  test("within a tier, the earliest publication wins", () => {
    const group = [
      src("src_0001", Tier.SECONDARY, "a.com", { published_at: "2024-06-01" }),
      src("src_0002", Tier.SECONDARY, "b.com", { published_at: "2024-01-15" }),
    ];
    assert.equal(pickRepresentative(group)?.id, "src_0002");
  });

  test("an undated source never displaces a dated one of equal tier", () => {
    const group = [
      src("src_0001", Tier.SECONDARY, "a.com", { published_at: "2024-06-01" }),
      src("src_0002", Tier.SECONDARY, "b.com", { published_at: null }),
    ];
    assert.equal(pickRepresentative(group)?.id, "src_0001");
  });

  test("an empty group has no representative", () => {
    assert.equal(pickRepresentative([]), null);
  });
});

describe("isCircular", () => {
  test("several URLs collapsing to one origin is circular", () => {
    const sources = [
      src("src_0001", Tier.SECONDARY, "a.com", { origin_group: "og_001" }),
      src("src_0002", Tier.SECONDARY, "b.com", { origin_group: "og_001" }),
    ];
    const evidence = [
      ev("ev_0001", "src_0001", "supports"),
      ev("ev_0002", "src_0002", "supports"),
    ];

    assert.equal(isCircular(evidence, byId(sources)), true);
  });

  test("a single source is thin, not circular", () => {
    const sources = [src("src_0001", Tier.SECONDARY, "a.com")];
    const evidence = [ev("ev_0001", "src_0001", "supports")];

    assert.equal(isCircular(evidence, byId(sources)), false);
  });

  test("genuinely independent sources are not circular", () => {
    const sources = [
      src("src_0001", Tier.SECONDARY, "a.com", { origin_group: "og_001" }),
      src("src_0002", Tier.SECONDARY, "b.com", { origin_group: "og_002" }),
    ];
    const evidence = [
      ev("ev_0001", "src_0001", "supports"),
      ev("ev_0002", "src_0002", "supports"),
    ];

    assert.equal(isCircular(evidence, byId(sources)), false);
  });
});

describe("uniqueDomains and maxTier", () => {
  test("domains are deduplicated and sorted", () => {
    const sources = [
      src("src_0001", Tier.SECONDARY, "b.com"),
      src("src_0002", Tier.SECONDARY, "a.com"),
      src("src_0003", Tier.SECONDARY, "a.com"),
    ];
    assert.deepEqual(uniqueDomains(sources), ["a.com", "b.com"]);
  });

  test("maxTier reports the strongest source present", () => {
    const sources = [
      src("src_0001", Tier.AGGREGATOR, "a.com"),
      src("src_0002", Tier.PRIMARY, "dfsa.ae"),
    ];
    assert.equal(maxTier(sources), Tier.PRIMARY);
  });

  test("maxTier of nothing is zero", () => {
    assert.equal(maxTier([]), 0);
  });
});
