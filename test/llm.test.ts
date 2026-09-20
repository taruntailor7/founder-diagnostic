import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/llm/client.ts";
import { numbersIn, unsourcedNumbers } from "../src/gaps/analyze.ts";
import { claimKey, dedupe } from "../src/claims/dedupe.ts";
import { makeClaim } from "./helpers.ts";

describe("extractJson: surviving weaker models", () => {
  test("plain JSON parses", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  test("a fenced block is unwrapped", () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  test("an unlabelled fence is unwrapped", () => {
    assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  });

  test("a leading reasoning paragraph is discarded", () => {
    // Free models routinely narrate before answering, which is the single most
    // common reason a response fails to parse.
    const raw = 'Sure. Here is the analysis you asked for:\n\n{"stance":"supports"}\n\nHope that helps.';
    assert.deepEqual(extractJson(raw), { stance: "supports" });
  });

  test("braces inside string values do not end the object early", () => {
    const raw = '{"quote":"he said {this} plainly","stance":"supports"}';
    assert.deepEqual(extractJson(raw), { quote: "he said {this} plainly", stance: "supports" });
  });

  test("escaped quotes inside strings are handled", () => {
    const raw = '{"quote":"he said \\"yes\\" once"}';
    assert.deepEqual(extractJson(raw), { quote: 'he said "yes" once' });
  });

  test("nested objects survive", () => {
    const raw = 'text {"predicate_match":{"value":true,"time":null}} more';
    assert.deepEqual(extractJson(raw), { predicate_match: { value: true, time: null } });
  });

  test("a response with no JSON throws rather than guessing", () => {
    assert.throws(() => extractJson("I could not determine an answer."), SyntaxError);
  });
});

describe("number guarding in gap prose", () => {
  test("numbersIn finds each distinct numeric token", () => {
    // Dates split into their parts, which is what we want: citing just the year
    // from a date already in the ledger is legitimate, inventing a new one is not.
    assert.deepEqual(
      [...numbersIn("37 months across 2 artifacts since 2019-03-21")].sort(),
      ["03", "2", "2019", "21", "37"].sort(),
    );
  });

  test("a year drawn from a fuller date in the input is allowed", () => {
    assert.deepEqual(unsourcedNumbers("quiet since 2019", "between 2016-02-25 and 2019-03-21"), []);
  });

  test("a year that appears nowhere in the input is caught", () => {
    assert.deepEqual(unsourcedNumbers("quiet since 2020", "between 2016-02-25 and 2019-03-21"), ["2020"]);
  });

  test("a figure present in the input is allowed", () => {
    assert.deepEqual(unsourcedNumbers("the silence ran 37 months", "longest gap 37 months"), []);
  });

  test("a figure the model invented is caught", () => {
    // The characteristic failure: asked not to compute, the model helpfully
    // converts 37 months into 3 years, and 3 traces to nothing in the ledger.
    assert.deepEqual(unsourcedNumbers("about 3 years", "longest gap 37 months"), ["3"]);
  });

  test("prose with no numbers is always fine", () => {
    assert.deepEqual(unsourcedNumbers("the record goes quiet for years", "37"), []);
  });
});

describe("dedupe", () => {
  test("identical claims from different sources merge", () => {
    const a = makeClaim({ id: "clm_0001", derived_from_source_id: "src_0001" });
    const b = makeClaim({ id: "clm_0002", derived_from_source_id: "src_0002" });

    const { claims } = dedupe([a, b]);
    assert.equal(claims.length, 1);
  });

  test("claims disagreeing on the figure are kept apart", () => {
    // $24M and $25M for the same round is precisely the disagreement
    // CONFLICTING_VALUES exists to surface. Merging would erase it.
    const a = makeClaim({ id: "clm_0001" });
    const b = makeClaim({
      id: "clm_0002",
      predicate: {
        ...a.predicate,
        value: { raw: "$25M", amount: 25_000_000, unit: "USD" },
      },
    });

    assert.notEqual(claimKey(a), claimKey(b));
    assert.equal(dedupe([a, b]).claims.length, 2);
  });

  test("claims with a figure differing only in measures are kept apart", () => {
    // "closed $100M" and "targeting $100M" carry the same figure and mean
    // different things.
    const a = makeClaim({ id: "clm_0001" });
    const b = makeClaim({
      id: "clm_0002",
      predicate: { ...a.predicate, measures: "capital the firm was aiming to raise" },
    });

    assert.equal(dedupe([a, b]).claims.length, 2);
  });

  test("claims with no figure merge on the sentence, however the predicate is worded", () => {
    // Extraction phrases the predicate differently per page. With no number
    // present there is nothing to conflict over, and leaving them apart put the
    // same sentence in the body and the refusal ledger at once.
    const base = makeClaim({
      id: "clm_0001",
      kind: "affiliation",
      text: "Nuwa Capital Limited is a company established in the DIFC",
      predicate: { action: "is", object: "a DIFC company", value: null, measures: null, population: null, time: null },
    });
    const other = makeClaim({
      id: "clm_0002",
      kind: "affiliation",
      text: "Nuwa Capital Limited is a company established in the DIFC",
      predicate: { action: "established", object: "in the DIFC", value: null, measures: "legal establishment", population: null, time: null },
    });

    assert.equal(dedupe([base, other]).claims.length, 1);
  });

  test("the fuller phrasing is kept when two merge", () => {
    const short = makeClaim({ id: "clm_0001", text: "Closed a fund" });
    const long = makeClaim({
      id: "clm_0002",
      text: "Closed its first fund at one hundred million dollars in 2023",
    });

    const { claims } = dedupe([short, long]);
    assert.equal(claims.length, 1);
    assert.match(claims[0]?.text ?? "", /first fund/);
    assert.equal(claims[0]?.id, "clm_0001", "the surviving row keeps the original id");
  });

  test("punctuation and casing differences do not prevent a merge", () => {
    const a = makeClaim({ id: "clm_0001" });
    const b = makeClaim({
      id: "clm_0002",
      predicate: { ...a.predicate, action: "Closed,", object: "First Fund" },
    });

    assert.equal(dedupe([a, b]).claims.length, 1);
  });
});
