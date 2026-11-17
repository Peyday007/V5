# Completion cost assessment — finishing Brain's commercial planning capability (2026-11-17, 00:00Z deadline)

Sources:
- Measured windows today:
  - report 44195685485, H200, 22:20–23:15Z: 12 accepted claims for $4.41, $0.37 each, at 6 GPU slots, NORMAL pressure;
  - report 44174859590: 14 claims for $3.53;
  - free report hours=3, run 44197766863: TRACE 7, stored 0, in_plan 0, retained 7.
- Goal plan at 22:50Z: reach 51% against 90% required.
- `major-run-decision-2026-11-17.md` and `surge-readiness-plan-2026-11-17.md` for the RunPod ledger.
- `git log production`: 309 PRs over 11-10 to 11-17, about 42 a day.
- `resource-utilization-2026-11-15.md`: engineering labour is subscription-covered (§84, §109).

## Bottom-up cost (incremental cash only)

| Item | Basis | Low | Working | High |
|---|---|---|---|---|
| Engineering: 7 unfinished capabilities | Subscription-covered (Claude accounts, Factory, Routines). No per-PR cash cost is recorded. | $0 | $0 | $0 |
| Verification windows (capped GPU, 1 per fix batch) | 6–14 windows at the measured $4.41–$7.32 each | $26 | $50 (10 × ~$5) | $102 |
| The proposed 12-hour research run | 12.25 h × $5.29 (H200, measured) or × $7.99 (B200) | $64.80 | $64.80 | $97.88 |
| Completion demonstration on 2 unfamiliar objectives | Free lane at $0; or one GPU research run per objective | $0 | $64.80 (one extra run) | $195.76 (two runs at $7.99) |
| **Total additional** | | **$91** | **$180** | **$396** |

- **Existing usable funds:** RunPod balance $120.77. Under the $250 ceiling, about $155.78 is spent and about $94.22 remains.
- **New cash at the working estimate:** $180 − $120.77, so about **$59**. The $250 ceiling would also have to rise to about $336 ($155.78 + $180).
- **Not included** (recurring, already paid, unpriced in the repo): Fly performance-2x 4 GB, Supabase, Instantly, the Claude subscriptions.
