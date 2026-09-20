import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { groupByOrigin, jaccard, normalise, shingles } from "../src/sources/origin.ts";

// The same announcement as three outlets would carry it: light edits around an
// identical quoted core. This is the shape of circular sourcing in the wild.
const WIRE = `Dubai, UAE: Nuwa Capital, the early stage venture capital firm, announced today
that it has closed its first fund at 100 million dollars. The fund will invest across
the Middle East, Turkey and Pakistan. Khaled Talhouni, Managing Partner, said the
firm remains committed to backing founders through the entire lifecycle.`;

const REPRINT_A = `Nuwa Capital, the early stage venture capital firm, announced today that it
has closed its first fund at 100 million dollars. The fund will invest across the
Middle East, Turkey and Pakistan. Khaled Talhouni, Managing Partner, said the firm
remains committed to backing founders through the entire lifecycle. Reporting by staff.`;

const REPRINT_B = `Gulf Business reports: Nuwa Capital, the early stage venture capital firm,
announced today that it has closed its first fund at 100 million dollars. The fund will
invest across the Middle East, Turkey and Pakistan. Khaled Talhouni, Managing Partner,
said the firm remains committed to backing founders through the entire lifecycle.`;

const UNRELATED = `The Dubai Financial Services Authority has published its annual report for
the year, setting out supervisory priorities for authorised firms in the centre. The
regulator said it would focus on conduct risk and client asset protection over the
coming period, and would consult on changes to its rulebook.`;

describe("normalise", () => {
  test("lowercases, strips punctuation and collapses whitespace", () => {
    assert.equal(normalise("  The   FUND, at $100M!  "), "the fund at 100m");
  });

  test("folds smart quotes so a typographic reprint still matches", () => {
    assert.equal(normalise("\u201cquoted\u201d"), "quoted");
  });
});

describe("shingles", () => {
  test("produces overlapping five-word sequences", () => {
    const s = shingles("one two three four five six");
    assert.deepEqual([...s], ["one two three four five", "two three four five six"]);
  });

  test("text shorter than the window yields a single shingle", () => {
    assert.deepEqual([...shingles("one two")], ["one two"]);
  });
});

describe("jaccard", () => {
  test("identical sets score 1", () => {
    assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  });

  test("disjoint sets score 0", () => {
    assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  });

  test("half overlap scores one third", () => {
    assert.equal(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  });
});

describe("groupByOrigin", () => {
  test("near-duplicate press releases group together", () => {
    const groups = groupByOrigin([
      { id: "src_0001", text: WIRE },
      { id: "src_0002", text: REPRINT_A },
      { id: "src_0003", text: REPRINT_B },
    ]);

    assert.equal(new Set(groups.values()).size, 1, "three reprints should be one origin");
  });

  test("unrelated articles do not group", () => {
    const groups = groupByOrigin([
      { id: "src_0001", text: WIRE },
      { id: "src_0002", text: UNRELATED },
    ]);

    assert.notEqual(groups.get("src_0001"), groups.get("src_0002"));
    assert.equal(new Set(groups.values()).size, 2);
  });

  test("grouping is transitive: A~B and B~C puts A and C together", () => {
    // Built so A and C share little directly, but both match B strongly.
    const head = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const tail = "kilo lima mike november oscar papa quebec romeo sierra tango";
    const a = `${head} ${head} ${head}`;
    const b = `${head} ${head} ${head} ${tail} ${tail} ${tail}`;
    const c = `${tail} ${tail} ${tail}`;

    const direct = jaccard(shingles(a), shingles(c));
    assert.equal(direct, 0, "A and C must not match directly, or the test proves nothing");

    const groups = groupByOrigin(
      [
        { id: "a", text: a },
        { id: "b", text: b },
        { id: "c", text: c },
      ],
      0.4,
    );

    assert.equal(groups.get("a"), groups.get("c"), "transitivity should link A and C via B");
  });

  test("assigns stable padded ids in order of first appearance", () => {
    const groups = groupByOrigin([
      { id: "src_0001", text: WIRE },
      { id: "src_0002", text: UNRELATED },
    ]);
    assert.equal(groups.get("src_0001"), "og_001");
    assert.equal(groups.get("src_0002"), "og_002");
  });

  test("empty input yields no groups", () => {
    assert.equal(groupByOrigin([]).size, 0);
  });
});
