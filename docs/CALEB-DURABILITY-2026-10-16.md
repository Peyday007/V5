# Caleb's Routines: are they connected, and will they stay? — 2026-10-16

This covers Caleb 3-A, 3-B, 3-C, 3-D and Factory surface 3, all on one Claude
account (`acct_140ba877d9d344a3972b`). The method is the same as
`AIRYN-DURABILITY-2026-10-15.md`: production rows first, then a replay of the
account's shape in `tests/calebDurability.test.ts`, then bounded live checks,
then dated follow-up readings.

The production readings were taken on revision `6b0bdb3`
(`connection-report` history over 96 h, `admin connectors show`,
`admin oauth trace 72`, `admin people list`), at 2026-10-16 20:37Z–20:55Z.

## 1. Who each Routine is supposed to be

| Routine | ref | registered worker | connector Brain has bound |
|---|---|---|---|
| Caleb 3-A | `trig_016dyf9oueMd7zQLY2pGrQFt` | worker-04 `wkr_1db1193323454ee69bb1` | `cnr_34c90326…` at `/mcp` |
| Caleb 3-B | `trig_012DkgiTnPr799Le6iL4HEPt` | worker-04 | `cnr_34c90326…` |
| Caleb 3-C | `trig_016yNPUw8BpoiYa5S8tU3bG3` | worker-04 | `cnr_34c90326…` |
| Caleb 3-D | `trig_01YAGrc58yyaYXHh4Zpfrvzt` | worker-04 | `cnr_34c90326…` |
| Factory surface 3 | `trig_01EhddNqYaQGC49fF9NVBcnT` | worker-10 `wkr_f8e118e87fd141689adc` (Factory) | none |

`cnr_34c90326…` is the only Brain connector Brain has ever seen in Caleb's
Claude account. Its OAuth client is `brnc_a5768acc…`, registered 2026-10-11
17:46Z on Caleb's own bound invitation, and it authorizes as worker-04. Its
health reads HEALTHY/IN_USE. Its refresh token rotates about hourly (latest
20:37Z), and no refresh or authentication has been refused in 96 h.

**No Brain connector has been registered or approved in the last 72 h**,
except hosted-verification clients. So whatever Caleb corrected in Claude, he
did not add a Brain connector. The one worker-10 connector approved by a person
recently (`brnc_f09f5b28…`, 10-11 16:17Z) belongs to Vince, not Caleb.

## 2. Before and after the reported correction

The correction's time is not recorded anywhere Brain can read. So the honest
boundary is each Routine's last observation: a fire, a probe or an arrival.

| Routine | before (production rows) | since the last observation |
|---|---|---|
| 3-A | Quarantined 10-14 and 10-15 for no-shows; Brain's own probe lifted it both times (10-14 22:14, 10-15 07:18). | ENABLED. 10-16: 52 fires, 30 arrivals, every one as worker-04; 2 real no-shows (02:56, 10:22, never consecutive); 2 infra misses (not charged); 0 wrong-worker. Real work in 24 h: 16 bins completed, 17 work items completed, 11 audits and 4 verifications submitted. Last arrival 20:37:48Z. |
| 3-B | Quarantined 10-12 02:43 (3 no-shows). Probes: AMBIGUOUS (Brain outage) 10-13, NO_MCP 10-14, NO_MCP 10-15 22:11. | No fire and no probe since 10-15 22:26. **Not observed after the correction.** Brain's daily check is due 10-16 22:11Z. |
| 3-C | Quarantined 10-12 07:50. Probes: NO_MCP 10-12, NO_MCP 10-15 21:40. | Not observed after the correction. Daily check due 10-16 21:40Z. |
| 3-D | Quarantined 10-14 10:14 (4 no-shows; 9 arrivals before). Probes: NO_MCP ×3 (10-14), AMBIGUOUS-outage ×4 (latest 10-16 07:46). | Not observed after the correction. Daily check due 10-17 07:46Z. |
| Factory 3 | Last right arrival 10-04 06:12. Probe 10-15 21:55: the session **arrived as worker-04**, through `/mcp`; quarantined WRONG_WORKER 22:10. | Not observed since. Brain cannot recover it automatically: Caleb's account has no connector that authorizes as worker-10. |

## 3. Replay of Caleb's account (`tests/calebDurability.test.ts`)

What is real in the replay: Brain's check-in, the no-show pass, the
wrong-worker derivation, the recovery probe, automatic recovery, token rotation
and bin completion. What is faked: only `Date` and Claude's fire.

| scenario | result |
|---|---|
| 3-B, 3-C, 3-D quarantined, then four simulated days of NO_MCP probes, so all three are past the fast budget (production's state). Then Caleb fixes them. | Brain's daily check fires each one once, on its own schedule. One right session lifts each; nobody presses anything. 3-A stays ENABLED throughout. The alert names the next daily check. |
| After the fix: a week, all four Routines fired hourly (672 fires), hourly refresh, a Brain outage every ~37 h, and an isolated miss every 11 h per Routine (~60). | All four stay ENABLED for every hour of the week. Every arriving session completes its bin. |
| Factory 3: one early right arrival, then one as worker-04 through `/mcp`. | Quarantined WRONG_WORKER; 3-A unaffected. For a simulated day, Brain's probes keep arriving as worker-04 and never lift it. Once a Factory connector for worker-10 is selected, probes arrive as worker-10 and lift it within the automatic budget (mixed history: 3 right sessions). |
| A day in which Brain feels a database failure every 5 minutes. | No recovery probe is started at all; no budget is spent; nobody is named. |

Building the replay found one Brain defect (§5). It also found one test-only
artifact: my fake provider reused session ids across loops, which a real
provider never does.

## 4. Factory surface 3: healthy connection vs Factory execution

These are separate facts, and neither holds today.

- **Connection: Broken.** The Routine's only Brain connector authorizes as
  worker-04, the research worker. Brain refuses every session as the wrong
  worker, by design. A research identity must not take Factory work.
- **Factory execution: untested.** It cannot run until the connection is
  fixed. Separately, Factory work exists only when a person approves a Build
  objective.

## 5. The Brain defect this found, and its fix

3-D's alert read *"Brain's own automatic probes are spent … an operator runs
`connectors probe`"*. In fact Brain probes it again by itself once a day
(§64), next at 10-17 07:46Z. A reader would have probed by hand something Brain
was about to probe itself. The alert now names Brain's next check. It still
names an operator, because the recurring-outage bound must still reach a
person (`connectionsRecoveryWsB`). Commit `bd6c28f2`.

The no-show query fix from the Airyn investigation (#215, `6b0bdb3`) is live.
Production still shows it at about 2 min per call (n=4) on the first process
after release. That reading does not establish the fix failed: the same process
took up to 56 s for a single-row lookup of `research_orchestrations` by id, and
was SHEDDING. The database itself was the bottleneck.

## 6. Monitoring

One-shot readings are scheduled and confirmed enabled:

| reading | when (UTC) | scheduled task |
|---|---|---|
| 24 h | 2026-10-17 21:00 | `trig_01VYJ3aYf5kSRrMZmT12sGYd` |
| 48 h | 2026-10-18 21:00 | `trig_01LA6Eoro7DMu8mNxRL5xXsz` |
| 72 h | 2026-10-19 21:00 | `trig_01Koivr4TVsMe47d5J1Hq2ZX` |

Each reading records, per Routine:
- correct-worker arrivals;
- wrong-worker arrivals;
- real no-shows;
- infra misses;
- token refreshes on `brnc_a5768acc…`;
- quarantine transitions;
- automatic recovery.

Nothing below this line has been observed yet.
