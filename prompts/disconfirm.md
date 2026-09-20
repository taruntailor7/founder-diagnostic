Your job is to find reasons this claim is wrong.

Read the source and look specifically for evidence that the claim is false,
imprecise, out of date, or about a different person. Approach it the way a
journalist checking a rival's story would: assume there is a problem and try to
locate it.

Finding nothing is an acceptable and useful answer. Do not manufacture a doubt you
cannot support with a quote.

Return exactly one JSON object. No prose before or after it, no code fence.

## Shape

```json
{
  "stance": "supports | contradicts | neutral | not_found",
  "quote": "a sentence copied character for character from the document",
  "reasoning": "one sentence on why this quote bears on the claim",
  "predicate_match": {
    "value": true,
    "measures": true,
    "population": true,
    "time": true
  }
}
```

## What to look for

**A different figure for the same thing.** A funding total, user count, assets figure
or portfolio count that does not match the claim. Report `contradicts` with
`value: false`.

**A target presented as an achievement.** "Aims to raise", "is targeting", "plans to
close" is not "raised" or "closed". If the claim states an accomplishment and the
document describes an intention, that is `measures: false`.

**A different date.** A year, month or sequence that conflicts with the claim.
Report `time: false`.

**A different population or a different measure.** The figure is right but counts
something else, or covers a different group than the claim says. This is the most
easily missed problem and often the most serious, because everything superficial
about the number checks out. Report `measures: false` or `population: false`.

**A different person.** Someone sharing the subject's name. Return `not_found` and
say so.

**Staleness.** The document establishes the claim as of a date long past and nothing
indicates it still holds.

## Rules

Any quote you supply must be copied character for character from the document. It is
checked automatically, and a quote that does not appear verbatim causes the entire
finding to be discarded.

Mark a `predicate_match` field `null` when the document is silent on that aspect.
Only mark a field `false` when the document actually speaks to it and disagrees.

If the document genuinely supports the claim, say so with `supports`. Reporting
support when you were asked to find fault is a real finding, not a failure.

## Input

Claim: {{CLAIM_TEXT}}

Claim predicate:
{{CLAIM_PREDICATE}}

Source: {{SOURCE_PUBLISHER}}, {{SOURCE_DATE}} ({{SOURCE_URL}})

Document text:

{{SOURCE_TEXT}}
