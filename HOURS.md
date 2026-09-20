# Hours

Real time spent, logged as it happens. Not an estimate, not rounded in my favour.

| Date | Start | End | Hours | Work |
|---|---|---|---|---|
| 2026-09-20 | 00:49 | 01:22 | 0.55 | Read the brief, verified the three UAE registers are reachable, shortlisted and locked the subject, settled the stack |
| 2026-09-20 | 01:22 | 01:42 | 0.35 | Scaffold, ledger types and store, then the deterministic core: tiering, origin grouping, independence, the thirteen labelling rules, the house-style linter, 91 tests |
| 2026-09-20 | 01:42 | 02:20 | 0.65 | Fetch layer: cache, backoff, budgets, robots, degradation log, offline replay, cheerio extraction, paste fallback |
| 2026-09-20 | 02:20 | 02:55 | 0.60 | Review server, audit log, five gap metrics, renderer and both gates, gate test running the real binary |
| 2026-09-20 | 02:55 | 03:12 | 0.30 | Model client, four prompts, extraction, both verification passes, gap prose with number guarding, pipeline wiring |
| 2026-09-20 | 17:37 | 19:20 | 1.70 | Live runs. Diagnosed and replaced a reasoning model, moved provider after hitting a daily cap, fixed the origin-source verification bug and the valueAffirmed bug, dedupe, render fixes |
| 2026-09-20 | 19:20 | 20:40 | 1.35 | Predicate-drift demo on the brief's own claim, run page on the review server, README, submission draft, push |

**Running total: 5.50 h**

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
