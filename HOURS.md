# Hours

Real time spent, logged as it happens. Not an estimate, not rounded in my favour.

| Date | Start | End | Hours | Work |
|---|---|---|---|---|
| 2026-09-20 | 00:49 | 01:22 | 0.55 | Read the brief, verified the three UAE registers are reachable, shortlisted and locked the subject, settled the stack |
| 2026-09-20 | 01:22 | 01:42 | 0.35 | Scaffold, ledger types and store, then the deterministic core: tiering, origin grouping, independence, the thirteen labelling rules, the house-style linter, 91 tests |
| 2026-09-20 | 01:42 | 02:20 | 0.65 | Fetch layer: cache, backoff, budgets, robots, degradation log, offline replay, cheerio extraction, paste fallback |
| 2026-09-20 | 02:20 | 02:55 | 0.60 | Review server, audit log, five gap metrics, renderer and both gates, gate test running the real binary |
| 2026-09-20 | 02:55 | 03:12 | 0.30 | Model client, four prompts, extraction, both verification passes, gap prose with number guarding, pipeline wiring |

**Running total: 2.45 h**

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
