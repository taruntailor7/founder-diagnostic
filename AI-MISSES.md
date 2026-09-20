# Where the AI was confidently wrong

A running log, kept from the first hour. Every entry records what the model actually
said, what turned out to be true, and how the error was caught. Verbatim output, not
paraphrase.

This file exists because the model is not the weak point on its own. Confident,
specific, plausible wrongness is, and that is the failure mode this whole project is
built to catch.

---

## 1. A bypass that does not bypass anything

**Date:** 2026-09-20
**Stage:** subject research, before any code
**Class:** false positive on tool reachability

A research agent investigating UAE registers reported, unprompted and as a
recommendation:

> `dfsa.ae` and `adgm.com` both sit behind Cloudflare and block naive fetchers. DFSA
> register pages return clean HTML to a normal browser user-agent via plain HTTP;
> ADGM blocks that but serves its register through a JSON/PDF API endpoint
> (`adgm.com/api/FSRAC_FirmPdf/GenerateFirmProfilePdf?FirmId=...`). **Worth building
> into your tool.**

The endpoint is real and the URL is correctly formed, which is what made it
convincing. Checked directly:

```
$ curl -sS -L -A "Mozilla/5.0 ... Chrome/120 Safari/537.36" \
    "https://www.adgm.com/api/FSRAC_FirmPdf/GenerateFirmProfilePdf?FirmId=165820"
http=403 size=5814 type=text/html; charset=UTF-8
<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
```

Same Cloudflare interstitial as the ordinary register page. The agent could reach it
because its fetch tool runs on infrastructure that clears the challenge. It never
distinguished "I can read this" from "a plain HTTP client can read this", and the
recommendation to build on it would have put an endpoint that always 403s into the
harvest path.

**Caught by:** running the exact URL from the client that would actually be doing the
fetching, rather than trusting a report of success.
**Consequence for the build:** `adgm.com` stays classified `primary` but is expected
to fail, routing through the human-paste fallback and landing in the ledger as
`degraded: true` with a `blocked` fetch event.

---

## 2. The same class of error, inverted

**Date:** 2026-09-20
**Stage:** subject research
**Class:** false negative on tool reachability

A second agent, working the venture-capital pool in parallel, concluded the opposite
about the same domain:

> One methodology note: `dfsa.ae` is behind Cloudflare and blocks most automated
> fetches. Individual firm pages at `/public-register/firms/<slug>` *do* sometimes
> load. I got Nuwa's through; **I could not get MEVP's DFSA page to load across three
> attempts**, so I've marked that as unverified rather than guessing.

It then flagged that unverified item as "the single most valuable open question" in
its report. There was no block:

```
$ curl -sS -L -A "Mozilla/5.0 ... Chrome/120 Safari/537.36" -o /dev/null -w '%{http_code}' \
    https://www.dfsa.ae/public-register/firms/mevp-capital-limited
200
```

Every DFSA page tried during this session returned 200 with clean server-rendered
HTML. The failure was almost certainly a wrong slug or a missing user-agent, but it
was reported as a property of the site.

**Caught by:** the first agent's contradictory claim about the same domain. Two
independent reports disagreeing is exactly the signal the two-pass verifier is built
around, and here it worked on the researchers themselves before any code existed.

**What the pair of them together shows.** Both errors are about whether a resource is
reachable, both were stated with specific technical detail, and they point in
opposite directions. Neither model was hedging. Each generalised from its own
environment to a claim about the world, and the giveaway in both cases was the
absence of the qualifier "from here". This is the same shape as predicate drift: a
true observation attached to a wider population than it supports.

---

## 3. Textbook boilerplate removal that deleted the evidence

**Date:** 2026-09-20
**Stage:** harvest, `src/sources/extract.ts`
**Class:** conventional code that is wrong for this specific job

Asked to turn HTML into plain text, the model wrote the standard recipe, and the
standard recipe is this:

```js
const STRIP = ["script", "style", "noscript", "nav", "header",
               "footer", "aside", "form", "iframe", "svg", ...].join(",");
$(STRIP).remove();
```

Every tutorial on article extraction says to drop navigation and footers as
boilerplate. On the Wamda author page, which is the single most important cadence
artifact for this subject, it did this:

```
raw body text:                        5833 chars
after stripping nav/header/footer/aside: 863 chars
```

Wamda renders its dated post list inside markup that pattern classifies as chrome.
The two publication dates, 25 February 2016 and 21 March 2019, and the stale
`khaled@wamdacapital.com` contact were all inside the deleted region.

A second bug compounded it: the selector loop took `$("article").first()`, and that
page has two `article` elements where the first is a 123-character teaser card.

Nothing would have failed. `extract()` would have returned 127 characters of real
text, the harvest would have succeeded, the cadence gap would have quietly computed
over an empty date set, and the diagnostic would have reported no publishing gap for
a man who has not published in seven years.

**Caught by:** a smoke test that printed character counts per URL before anything was
built on top, and looked wrong.
**Fixed by:** stripping only `script`, `style`, `noscript`, `form`, `iframe` and
`svg`; taking the longest candidate container rather than the first; and falling back
to the whole page when the chosen container is not clearly better than its
surroundings. Recall beats tidiness here. Surplus navigation text costs a few tokens.
Missing body text costs a claim, and silently breaks the verbatim quote check that
catches hallucinations.

**The general lesson,** and the reason this one is worth recording: the code was not
sloppy. It was the conventional, well-reviewed answer to a slightly different
question. The model optimised for clean article text; this tool needs complete
evidence. Failures like this do not announce themselves, because every stage
downstream reports success.

---

## 4. A gate that could never fail

**Date:** 2026-09-20
**Stage:** render, `src/render/diagnostic.ts` and `bin/render.ts`
**Class:** a safety check rendered inert by the code it was meant to check

The approval gate is the scored promise of this project: nothing reaches a client
without a recorded human sign-off. The model wrote both halves of it, and they
cancelled out.

Document assembly selected claims like this:

```ts
const approved = claims.filter(
  (c) => publishable(c) && decisions.get(c.id)?.decision === "approve",
);
```

The gate then checked that every claim referenced by a footnote carried an approval.

Read together: assembly had already removed every unapproved claim, so no footnote
could ever reference one, so the gate had nothing to find. Given a ledger of entirely
unapproved claims the renderer did not fail. It emitted a document with an empty body
and exited zero, reporting success.

Both pieces are individually reasonable. "Only publish approved claims" is a sensible
line of code. "Verify nothing unapproved is published" is a sensible check. Together
they produce a system that silently ships a hollow document instead of refusing.

**Caught by:** writing the gate test to run the real `bin/render.ts` as a subprocess
against a temporary ledger and assert a non-zero exit, rather than unit-testing the
gate function. The function was correct. The build was not.

**Fixed by:** assembling the body from everything *publishable* by status, with
approval applied only at the gates. The document now fails loudly and names the
offending claim ids.

**Why this one matters most of the four.** The others produced visibly wrong output.
This one produced a green build, a clean exit code, and a plausible-looking file,
while the single guarantee the system exists to make was not being enforced at all. A
test asserting "render succeeds when everything is approved" would have passed
throughout.

---

## 5. A model chosen on the right metrics, for the wrong reasons

**Date:** 2026-09-20
**Stage:** first live run
**Class:** correct evidence, wrong inference

The extraction and confirming models were chosen by querying OpenRouter's model API
and filtering on capability, which looked rigorous:

```
deepseek/deepseek-v4-flash-0731:free   ctx 1048576   json yes   tools yes
```

The reasoning was that a 1M context window means whole articles need no chunking, and
declared JSON support means reliable structured output. Both facts are true. Both are
stated in the provider's own metadata. The conclusion was still wrong.

The first real extraction call returned this:

```
http: 200
finish_reason: length
usage: { completion_tokens: 4000,
         completion_tokens_details: { reasoning_tokens: 4000 } }
content length: 1
reasoning length: 16847
```

It is a reasoning model. It spent the entire completion budget thinking, emitted a
single space as its answer, and took 100 seconds to do it. On nineteen sources plus
two verification passes per claim, that is hours of wall-clock time producing nothing.

Nothing in the capability metadata says "reasoning model". `context_length` and
`supported_parameters` were real signals about real properties, and neither is the
property that mattered. The model was selected on attributes that were accurate and
irrelevant, which is the same failure the verifier exists to catch: right number,
wrong predicate.

**Caught by:** the run failing outright with "model returned an empty response", then
printing the raw API envelope instead of guessing at the cause. `finish_reason:
length` with `reasoning_tokens: 4000` named the problem immediately.

**Fixed by:** benchmarking six free models against the actual extraction prompt
rather than against their spec sheets. Three answered. `nemotron-3-super-120b`
returned five claims in 3.6 seconds with zero reasoning tokens and became the
extraction and confirming model; `nex-n2.5-pro`, a different vendor, became the
disconfirming model so cross-family independence survived the change.

The client now also sends `reasoning: { enabled: false }`, falls back to the reasoning
trace when it contains JSON, and reports `finish_reason: length` as what it actually
is rather than as an empty response.

**A second thing this exposed.** OpenRouter returns upstream provider failures as
HTTP 200 with an error object in the body, so a provider-side 429 arrives looking like
a successful call. The retry logic was checking `res.status` and would have treated
every throttled request as a hard failure. Now the body is inspected too.

---

## 6. Treating the symptom: a correct fix for the wrong problem

**Date:** 2026-09-20
**Stage:** first full run
**Class:** plausible diagnosis, never verified against the actual error

The first complete run produced 1,130 rate-limit events, exhausted its 400-call
budget on retries, and verified almost nothing: 67 claims, 0 verified, 64 refused.

The reasoning went: 429 means too many requests per unit time, we are bursting,
therefore pace the client. That is a textbook response and it is what I built. A
token-bucket limiter, 12 requests per minute, with a comment explaining why staying
under a limit beats retrying after it.

It helped, visibly. Throttles fell from 1,130 to 110. That apparent improvement is
the trap: a partial fix that moves the number looks like the right fix.

So I tightened it to 6 per minute. Throttles kept coming. Only then did I print the
actual response body:

```json
{"error":{"message":"Rate limit exceeded: free-models-per-day.
   Add 10 credits to unlock 1000 free model requests per day",
  "metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0"},
  "limit_source":"openrouter_free_tier_daily"}}}
```

A **daily** cap of 50 requests, fully consumed. Pacing cannot help with a daily quota.
Spreading 140 calls more evenly across an hour does nothing when the allowance is 50
calls across a day. The throttle count fell from 1,130 to 110 only because slower
pacing meant fewer total attempts before the budget ran out, not because more requests
were succeeding.

I had spent an hour building, testing and documenting a rate limiter for a limit that
was never the constraint.

**Caught by:** eventually reading the error instead of reasoning about it. The message
names the exact cause, the exact limit and the exact remedy, and it was in every one
of those 1,130 responses from the first minute onward.

**The lesson, which is the same one the whole project is about.** I had a real signal
(HTTP 429), drew a reasonable inference (we are sending too fast), and acted on it
without checking what the number actually measured. The response body said
`free-models-per-day`. I assumed per-minute. Right status code, wrong predicate.

The pacing code stays, incidentally. It is correct, it is genuinely needed on
providers that do throttle per minute, and it made the eventual diagnosis cleaner.
Being useful is not the same as being the answer to the question I was asking.

---

## 7. A prompt that routed around the one thing it was written for

**Date:** 2026-09-20
**Stage:** verification prompt, `prompts/confirm.md`
**Class:** instruction that was correct in general and wrong in the case that mattered

This project exists to catch predicate drift. The confirming prompt contained this,
which reads like good practice and is:

> If you cannot find a sentence that establishes the claim, the answer is
> `not_found` with an empty quote. That is a useful, correct answer.

Run the brief's own claim through it, against a document that carries the underlying
study:

```
claim:  71% of B2B buyers research a founder's personal profile before engaging
source: "... 71% of hidden buyers said thought leadership is more effective than
         conventional sales materials ..."

stance      not_found
value       silent
measures    silent
population  silent
reasoning   "The document does not mention the claim."
```

Rule 6 fired. `NO_PRIMARY`. Thin sourcing.

The model was not wrong. No sentence in that document establishes the claim, so by
the instruction it was given, `not_found` is the right answer. But `not_found` leaves
every `predicate_match` field null, and rule 2 needs an explicit `false` to fire. The
instruction quietly made the headline refusal unreachable.

The figure was in the text we sent. The model read it and discarded it, because I had
told it that the absence of a matching sentence ends the enquiry.

**Fixed by** making the figure check a mandatory first step rather than an exception
buried in prose: if the claim carries a figure and that figure appears in the
document, `not_found` is not an available answer. Quote the sentence, set
`value: true`, and record what it actually measures.

With that, both models tested get it right:

```
stance      supports
value       matches
measures    DOES NOT MATCH
population  DOES NOT MATCH
rule 2 fired -> UNVERIFIED, PREDICATE_DRIFT
```

**Why this is the most uncomfortable entry here.** The deterministic labelling was
never broken. Rule 2 was correct, tested, and had a passing case for exactly this
scenario. The test passed because it fed the rule the evidence the rule needed. In
production the model never produced that evidence, because a reasonable-sounding
sentence in a prompt told it not to.

A rule can only be as good as the evidence reaching it, and unit tests that construct
their own evidence cannot tell you whether the real pipeline produces it. Only the
end-to-end run on the real claim surfaced this, and I nearly shipped without doing it,
since by then everything was green.

---

## 8. The machine leaked into the artifact

**Date:** 2026-09-20
**Stage:** deployment
**Class:** environment captured as configuration, breaking the headline promise

The README leads with the claim that matters most to a reviewer:

> `npm install && npm run demo` works on a clean clone with no API key.

It did not. Deploying surfaced it:

```
==> Running build command 'npm ci --omit=dev'...
npm error code E401
npm error Incorrect or missing password.
```

All 105 entries in the committed `package-lock.json` resolved to
`gdartifactory1.jfrog.io`, an internal corporate npm mirror, because that is what
this machine's npm is configured for. `npm install` wrote those hostnames into the
lockfile and the lockfile was committed.

Three consequences, in increasing order of seriousness. The deploy could not
authenticate. Anyone cloning the repository would have hit the identical error, so
the one instruction the README puts at the top was broken for every reader outside
one private network. And a public repository attached to a job application published
an employer's internal infrastructure hostname.

**Caught by:** deploying. Nothing local could have found it. Every check I ran used
the same machine with the same npm configuration, so `npm install` worked perfectly
every time, including on what I thought was a clean-clone test. The clone was clean;
the environment was not.

**Fixed by** an `.npmrc` pinning `registry.npmjs.org` and regenerating the lockfile.
A clean clone now installs from the public registry and reproduces the diagnostic
exactly.

**Note:** earlier commits still contain the old lockfile, so the hostname remains in
git history. It is an internal hostname rather than a credential, and JFrog is not a
secret, but it is there and removing it would need a history rewrite.

**What I would take from this.** I verified reproducibility eight times and every
check passed, because every check inherited the assumption I was trying to test.
"Works on a clean clone" cannot be established from the machine that built it. The
same mistake shape as entry 1: a true observation, generalised past what it supports.
