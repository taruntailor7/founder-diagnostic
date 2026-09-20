# founder-diagnostic

Given a LinkedIn URL, this researches a person from public sources, verifies every
factual claim twice against independent evidence, and produces a one-page diagnostic
of how they currently show up in public. Labels are decided by tested rules in code,
never by a language model. Nothing reaches the document without a recorded human
approval, and the claims it refused to publish are printed on the page.

## Run it

```bash
npm install
npm run demo
```

`npm run demo` works on a clean clone **with no API key and no `.env` file**. It
replays the committed fixtures offline and reproduces the exact diagnostic in
`out/`. If a fixture is missing it fails loudly and names the cache key rather than
quietly reaching for the network.

```bash
npm test          # the rule suite: every labelling rule, the linter, the render gate
npm run lint:doc  # run both gates against the current ledger, write nothing
npm run demo:drift  # the worked example below, end to end
```

### The worked example

`npm run demo:drift` runs one claim through the real confirming pass and the real
labelling function. The claim is not invented; it appeared in the brief that
commissioned this project.

> A widely cited 2025 study found that 71% of B2B buyers research a founder's
> personal profile before engaging the company.

The figure is real, the study is real, the year is right. What the Edelman and
LinkedIn 2025 report actually says is that 71% of **hidden buyers** rate thought
leadership above conventional sales materials. Different measure, narrower
population, same number.

```
stance      supports
value       matches
measures    DOES NOT MATCH
population  DOES NOT MATCH

quote, verified verbatim against the cached page:
  "In addition, 71% of hidden buyers said thought leadership is more effective
   than conventional sales materials in demonstrating a vendor's potential value..."

rule 2 fired -> UNVERIFIED, PREDICATE_DRIFT
```

Note the source tier: aggregator. Predicate drift is rule 2 and is evaluated before
source quality is considered at all, so the claim is refused on what the number means
rather than on where it was found.

## Read it without running anything

Everything the system decided is committed as JSON and readable in the browser:

- [`ledger/claims.json`](ledger/claims.json) — every claim, its status, its refusal
  code and the reasoning behind it
- [`ledger/sources.json`](ledger/sources.json) — every source with its tier,
  publisher, publication date and whether it was readable at all
- [`ledger/evidence.json`](ledger/evidence.json) — every verdict from both passes,
  with the verbatim quote it rests on and which model produced it
- [`ledger/approvals.jsonl`](ledger/approvals.jsonl) — the append-only audit log of
  human decisions
- [`ledger/fetch-events.jsonl`](ledger/fetch-events.jsonl) — every fetch attempt,
  including the failures, the retries and the refusals

## The one design decision that matters

**The label is decided by code, not by the model.**

The model does two jobs: pull atomic claims out of text, and read one source and
report whether it supports a claim, with a verbatim quote. It never decides whether
something is verified.

The label comes from a pure function over the evidence: how many independent sources,
across how many domains, at what tier, whether the predicate matched, whether the two
passes agreed. That function is plain TypeScript, it is unit tested one case per
rule, and its rules are printed below.

This is the answer to "what happens when it is wrong". A model that scores its own
confidence will be confidently wrong. A model that supplies evidence into a rule it
cannot influence can only be wrong about the evidence, and the rules then catch thin
evidence regardless of how certain the prose around it sounded.

The same principle governs the gap analysis: the numbers are computed in code, and
the model only writes sentences around figures it was handed. Any number in its
output that is not in its input is stripped out.

### Predicate decomposition

Every statistic is split into three fields, and verification must match all three:

| Field | Question it answers |
|---|---|
| `value` | What is the number? |
| `measures` | What does the number count? |
| `population` | What group is it counted over? |

This exists because of a specific failure. Consider: *"A 2025 study found that 71% of
B2B buyers research a founder's personal profile before engaging the company."*

The number is real. The study is real. The year is right. And the study says
something else: 71% of **hidden buyers** report little interaction with sales. A
verifier that checks only the value marks that claim verified. Checking `measures`
and `population` catches it, and the refusal code is `PREDICATE_DRIFT`.

A statistic extracted without `measures` and `population` is rejected before it
reaches the ledger, because a claim whose meaning was never captured cannot be
checked.

## How a claim gets its label

Evaluated in order, first match wins. `S` is the set of independent supporting
sources after near-duplicate collapse.

| # | Condition | Result |
|---|---|---|
| 1 | Identity corroborated fewer than twice | UNVERIFIED · `IDENTITY_AMBIGUOUS` |
| 2 | Any supporting evidence has `measures` or `population` false | UNVERIFIED · `PREDICATE_DRIFT` |
| 3 | Pass 1 and pass 2 reached opposite conclusions | UNVERIFIED · `PASSES_DISAGREE` |
| 4 | Credible evidence contradicts the claim | UNVERIFIED · `CONFLICTING_VALUES` |
| 5 | `S` empty and every candidate source was blocked or paywalled | UNVERIFIED · `PAYWALLED_UNREADABLE` |
| 6 | `S` empty | UNVERIFIED · `NO_PRIMARY` |
| 7 | Every source in `S` is an aggregator | UNVERIFIED · `NO_PRIMARY` or `CIRCULAR_SOURCING` |
| 8 | Every source in `S` is self-reported | PARTIALLY_VERIFIED · `SELF_REPORTED_ONLY` |
| 9 | Two or more domains, a primary source present, nothing contradicting, no predicate field disputed | **VERIFIED** |
| 10 | Two or more domains, best source is secondary | PARTIALLY_VERIFIED · `NO_PRIMARY` |
| 11 | One domain, primary source | PARTIALLY_VERIFIED · `UNCORROBORATED` |
| 12 | Only the date is disputed | PARTIALLY_VERIFIED · `CONFLICTING_VALUES` |
| 13 | Anything else | UNVERIFIED · `NO_PRIMARY` |

A `VERIFIED` role or affiliation whose newest supporting source is more than five
years old is downgraded to PARTIALLY_VERIFIED with `STALE`.

Only VERIFIED and PARTIALLY_VERIFIED claims can appear in the document body.
UNVERIFIED claims appear only in the refusal ledger, which stays printed on the page.

### Refusal codes

| Code | What it means |
|---|---|
| `NO_PRIMARY` | Every supporting source is secondary or an aggregator. No filing, register entry or first-hand record establishes this. |
| `SELF_REPORTED_ONLY` | The only source is the subject describing themselves. Retained as self-description, never as established fact. |
| `CIRCULAR_SOURCING` | Several outlets carry this, but they trace to one origin, usually a press release. That is one source, not several. |
| `CONFLICTING_VALUES` | Credible sources disagree on the value or date, and nothing authoritative settles it. |
| `PREDICATE_DRIFT` | The figure is real and the cited study exists, but the figure measures something other than what the claim asserts. |
| `IDENTITY_AMBIGUOUS` | Could not establish that the source refers to this person rather than someone sharing the name. |
| `PAYWALLED_UNREADABLE` | The only source sits behind a paywall or login, so it was not accessed, per the public-sources-only rule. |
| `PASSES_DISAGREE` | The confirming pass and the disconfirming pass reached opposite conclusions. Escalated rather than resolved automatically. |
| `STALE` | The supporting source is old enough that the claim may no longer hold, and nothing current corroborates it. |
| `UNCORROBORATED` | A primary record establishes this, and nothing independent stands beside it. Retained, but resting on a single source. |

### Source tiers

Classification is by domain, and **anything unrecognised is an aggregator**. Unknown
sources earn trust by being identified, not by default, so an incomplete list fails
safe.

| Tier | Meaning | Examples |
|---|---|---|
| `primary` | First-hand record | DFSA and ADGM public registers, DIFC, SCA, Central Bank of the UAE, Companies House, SEC |
| `self_reported` | The subject describing themselves | Their company site, personal site |
| `secondary` | Independent journalism | Reuters, Bloomberg, FT, The National, Khaleej Times, Wamda, MENAbytes, TechCrunch, Forbes Middle East, AGBI |
| `aggregator` | Recycled or user-editable | Crunchbase, PitchBook, Tracxn, MAGNiTT, Wikipedia, Medium, PR wire services |

## Two-pass verification

Pass one looks for support. Pass two is told to find reasons the claim is false,
imprecise, out of date, or about a different person.

Independence is enforced **by filtering the input, not by asking the model nicely**.
Every domain and every origin group pass one relied on is removed from pass two's
candidate pool before it runs. If the pool ends up empty, that is recorded as a
finding in its own right: nothing independent exists to check the claim against.

The two passes also run on **different model families**. Domain independence stops
them reading the same page twice; model independence stops them sharing a training
blind spot.

Near-duplicate sources are collapsed before any counting happens. Five outlets
carrying one press release are grouped by five-word shingle overlap above a Jaccard
threshold of 0.6, with union-find so grouping is transitive, and count as one source.

### The verbatim quote check

Any verdict of `supports` or `contradicts` must carry a quote that appears character
for character in the cached source text, after whitespace and typographic
normalisation. If it does not, the evidence is discarded entirely rather than
downgraded, and the miss is recorded.

This is the most effective single guard in the system. A model can produce a fluent,
plausible sentence and attribute it to a source. It cannot make that sentence appear
in text already sitting on disk.

## The human gate

```bash
npm run review    # http://127.0.0.1:5173
```

The queue lists every claim without an approval, UNVERIFIED first, so refusals are
reviewed deliberately rather than scrolled past. Each row shows the claim, its
refusal code in plain English, and every evidence row with its quote, source, tier,
pass number and which model produced it.

Each claim gets one of three decisions:

| Decision | Leaves queue | In diagnostic |
|---|---|---|
| Approve | Yes | Yes |
| Reject | Yes | No |
| Hold | No, stays | No (blocks render) |

- Bound to `127.0.0.1` only, never `0.0.0.0`
- Refuses to start without `REVIEWER` set, so the log cannot record an anonymous approval
- Append only. No update route, no delete route. A reversed decision is a new line,
  and the history stays readable
- `npm run render` exits non-zero and names the claim ids if the document references
  anything unapproved

The approval check runs twice, once inside the linter and once independently in the
renderer. The guarantee that nothing unapproved reaches a client should not rest on a
single check.

## No send capability, by design

There is no mail transport, no webhook, no LinkedIn integration, no outreach surface
of any kind. The only outbound request the system makes other than fetching public
pages is to the model API.

The honest answer to "who approves before anything reaches a client" is: a human,
because the machine cannot reach one. It has no capability to.

## Public sources only

No authenticated request is ever made. No request is made to any LinkedIn endpoint;
the URL is treated purely as an identity string. `robots.txt` is fetched and honoured
per domain, and disallowed paths are skipped and logged. **No person was contacted at
any point.**

Pages that cannot be read automatically, such as the DIFC and ADGM registers which
sit behind bot protection, can be supplied by hand:

```bash
npm run paste -- <url>   # paste the page text, then Ctrl-D
```

These are stored with `fetch_method: "human_paste"` and `degraded: true`, and a fetch
event records the degradation. The point is not that degradation is avoided. It is
that it is never silent.

## Limitations

**LinkedIn is an identity anchor, not a data source.** Post history, engagement and
follower counts all require a login, which this tool does not use. So it does not
measure LinkedIn cadence. It measures publishing rhythm across datable open-web
artifacts: articles, register entries, bylined posts, podcast episodes. The rendered
document says so wherever that number appears, rather than implying otherwise.

**Verification independence is structural, not adversarial.** The two passes use
different model families and disjoint source pools, which is stronger than one model
reading everything twice, but both are still language models and could in principle
share a blind spot.

**Sentence segmentation in the linter is naive.** It splits on terminal punctuation
followed by whitespace, so "Dr. Smith" becomes two sentences. This can only make the
number rule stricter, never laxer.

**The tier lists are hand-curated and incomplete.** An unlisted domain is treated as
an aggregator, so the failure mode is under-trusting an unknown source rather than
over-trusting one.

**Dates are frequently unavailable.** Many pages carry no machine-readable
publication date. A date that cannot be parsed confidently is recorded as null rather
than guessed, which means the cadence measurement sees fewer artifacts than exist.

**Free models are weaker at instruction following** than frontier models,
particularly at returning strict JSON and at filling `measures` and `population`
carefully. The client repairs and retries, and the guards catch what gets through,
but extraction quality would improve on a stronger model. Changing that is an `.env`
edit.

## Running it live

```bash
cp .env.example .env     # add LLM_API_KEY
npm start -- --linkedin "https://www.linkedin.com/in/<handle>" \
             --name "First Last" \
             --company "Firm Name" \
             --role "Founder and CEO" \
             --self-domain "firm.com" \
             --seed "https://<a primary source you already know about>"
npm run review
npm run render
```

Every stage skips work already in the ledger, so a run stopped by a rate limit or a
budget resumes without repeating itself. Pass `--force` to redo a stage.

| Setting | Default | Purpose |
|---|---|---|
| `MAX_FETCHES` | 150 | Page fetches before the harvest stops cleanly |
| `MAX_SEARCHES` | 25 | Search queries |
| `MAX_LLM_CALLS` | 200 | Model calls |
| `OFFLINE` | `0` | `1` serves only from fixtures and never touches the network |
| `REVIEWER` | none | Required by the review server |

Exceeding a budget stops that stage and leaves the ledger resumable. It is not a
crash.

The PDF is produced by opening `out/diagnostic.html` in a browser and printing to
PDF, rather than adding a headless browser as a dependency.

## Stack

Node 22 and TypeScript with **no build step**: Node strips types natively, so
`tsconfig.json` sets `erasableSyntaxOnly` and the source runs directly.

Two runtime dependencies, `cheerio` and `express`. Everything else is built in:
native `fetch` for HTTP and the model API, `node:test` for tests, `node:crypto` for
content addressing, `process.loadEnvFile` instead of `dotenv`, template literals
instead of a template engine. No database, no ORM, no bundler, no headless browser,
and nothing requiring native compilation.

## What is deliberately not here

**Voice and tone profiling.** Learning how someone writes and matching it is the
natural next stage, and it is what makes this useful for drafting rather than only
for diagnosis. It was not part of the brief and is not built.

**Anything that sends.** See above. That is a design choice, not an omission.
