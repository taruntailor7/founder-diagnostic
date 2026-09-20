# Hours

Real time spent, logged as it happens. Not an estimate, not rounded in my favour.

| Date | Hours | Work |
|---|---|---|
| Sat 2026-09-19 | 4.0 | Read the brief, researched and chose the subject, wrote the plan and the implementation spec, verified the three UAE registers were reachable before committing to the design |
| Sun 2026-09-20 | 4.0 | Built and ran it: ledger and tiering, the labelling rules and their tests, fetch layer, extraction and the two verification passes, review server, renderer and gates, live run, run page, deployment |

**Total: 8 hours**

## Notes

- Register reachability was checked before any code was written, because the whole
  `primary` tier depends on it and finding out later would have invalidated the
  labelling rules.
- Subject selection took longer than planned. It is the one decision that cannot be
  changed cheaply once the ledger has real data in it.
- The labelling rules were mutation-tested rather than just run: disabling the
  predicate-drift check and relaxing the "silence is not agreement" condition each
  broke exactly one test. A suite that stays green when you break the code is not
  evidence of anything.
- Roughly a third of the second session went on provider limits rather than on the
  problem: a model that spent its whole token budget reasoning and never answered,
  a daily request cap on one provider, a daily token cap on the next. All of it is
  in AI-MISSES.md. None of it is interesting engineering, and pretending the time
  went elsewhere would defeat the point of keeping this file.
