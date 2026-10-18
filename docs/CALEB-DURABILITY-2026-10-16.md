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

## 6. Live checks after the reported correction (2026-10-16 21:41Z–23:27Z)

Brain's own daily checks came due first. Three operator probes followed, one
for each Routine, in healthy time and one at a time. A person's probe buys a
fresh budget, so none of this spends one.

| Routine | probe | started (UTC) | result |
|---|---|---|---|
| 3-C | automatic `crp_…` | 21:41 | AMBIGUOUS: Brain unavailable (restarts 21:55–22:13). No evidence either way. |
| Factory 3 | automatic | 21:57 | AMBIGUOUS: Brain unavailable. No evidence either way. |
| 3-B | automatic | 22:15 | **NO_MCP**: Claude started the session; nothing reached Brain in 15 min. |
| 3-C | operator `crp_d2479a89…` | 22:38 | **NO_MCP**: session `cse_01K6XWh9…` started; nothing reached Brain. |
| 3-C | automatic `crp_33f115d8…` | 22:54 | **NO_MCP**: session `cse_01DSBcJN…`. |
| 3-D | operator `crp_0052b65c…` | 23:11 | **NO_MCP**. |

Brain recorded no incident between 22:14Z and 23:27Z.

In the same three hours, 3-A was fired 22 times and arrived 16 times, every
time as worker-04, through the same connector `cnr_34c90326…`. So the
connector authenticates. What does not happen is that 3-B, 3-C or 3-D call
Brain at all. That is the Claude Routine's configuration:
- its Brain connector is not attached or not enabled; or
- the Routine fails before any tool call.

Brain cannot read either.

Verdicts on 2026-10-16:

| Routine | verdict | basis |
|---|---|---|
| 3-A | **Working** | 30 right-worker arrivals on 10-16, real bins and audits completed, hourly refresh, no auth refusal in 96 h |
| 3-B | **Broken** | NO_MCP in healthy time after the reported correction |
| 3-C | **Broken** | NO_MCP twice in healthy time after the reported correction |
| 3-D | **Broken** | NO_MCP in healthy time after the reported correction |
| Factory 3 | **Broken** (connection); Factory execution **untested** | No Brain connector in Caleb's account authorizes as worker-10. None was registered in the last 72 h. Its last arrival was as worker-04. |

## 7. Monitoring

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

## 8. 24-hour reading (2026-10-17 21:00Z–21:32Z, revision `f377811`)

| Routine | state | fires (26 h) | right-worker arrivals | wrong-worker | real no-shows | probes |
|---|---|---|---|---|---|---|
| 3-A | QUARANTINED 20:59Z, then **lifted by Brain's own probe 21:15Z** | 113 | 32 (none from 02:28Z to 21:15Z) | 0 | 3 (06:17Z, 14:27Z, 20:59Z) | 1 HEALTHY |
| 3-B | QUARANTINED (unchanged) | 0 | 0 | 0 | 0 | 1 NO_MCP |
| 3-C | QUARANTINED (unchanged) | 0 | 0 | 0 | 0 | 6 NO_MCP, 1 AMBIGUOUS (outage) |
| 3-D | QUARANTINED (unchanged) | 0 | 0 | 0 | 0 | 5 NO_MCP, 1 AMBIGUOUS (outage) |
| Factory 3 | QUARANTINED WRONG_WORKER (unchanged) | 0 | 0 | 0 | 0 | 1 AMBIGUOUS (outage) |

- **3-A went silent for about 19 hours.** From 02:28Z to 21:15Z it was fired
  about 35 times and not one session checked in. Only 3 of those fires were
  charged as no-shows; the rest were bins other sessions took. In the last
  12 h, worker-04 made **no tool call at all**.
- **Yet the connector kept authenticating the whole time**: an hourly refresh
  on `brnc_a5768acc…` (latest 20:23Z) and an authentication at 20:56Z. So
  Caleb's sessions were reaching Brain's door and doing nothing there. That is
  Claude-side behaviour Brain cannot see the cause of.
- Brain's automatic probe at 21:14Z read HEALTHY and lifted the quarantine.
  3-A arrived again at 21:27Z and 21:32Z. Nobody acted.
- Brain recorded no incident of its own in that window. The only MCP
  authentication refusals are EXPIRED, around the 10-16 restarts, and none
  since 00:29Z.
- 3-B, 3-C and 3-D: every probe in healthy time still reads NO_MCP. Factory 3
  has no connector for worker-10.

Compared with the baseline: **worse for 3-A** (one 19-hour silence and a
quarantine, recovered automatically), and **unchanged for the other four**
(still need Caleb).

## 9. 48-hour reading (2026-10-18 21:20Z, revision `6da7f5b`)

The report's own run (`39167432587`) covers 26 h of history.

| Routine | state | fires | right-worker arrivals | wrong-worker | real no-shows | probes |
|---|---|---|---|---|---|---|
| 3-A | QUARANTINED: **operator hold** ("54 consecutive fired sessions never checked in") | 22 | 15, all 10-17 21:15Z–22:17Z | 0 | 1 | 1 HEALTHY (10-17 21:15Z) |
| 3-B | QUARANTINED (unchanged) | 0 | 0 | 0 | 0 | 1 NO_MCP |
| 3-C | **lifted by Brain's probe 10-18 15:56Z**, re-quarantined 17:54Z | 16 | 14, 15:56Z–16:45Z | 0 | 2 (at re-quarantine) + earlier | HEALTHY 15:56Z; NO_MCP 18:10Z and 19:10Z |
| 3-D | QUARANTINED (unchanged) | 0 | 0 | 0 | 0 | 1 NO_MCP |
| Factory 3 | QUARANTINED WRONG_WORKER (unchanged) | 0 | 0 | **1, as worker-04** (10-17 21:58Z) | 0 | 1 AMBIGUOUS |

- Every Caleb session that reached Brain arrived as worker-04. The only
  wrong-worker arrival was Factory 3 again, through `/mcp`. No refused
  authentication or refresh came from this account, and the connector kept
  refreshing hourly.
- **The pattern across Caleb's Routines is bursts, then silence.** 3-A worked
  for an hour on 10-17 and then answered nothing. 3-C worked for 50 minutes on
  10-18 for the first time since 10-12, and then answered nothing. Brain's own
  probes caught both bursts, which is the automatic recovery working.
- What stops the sessions in between is on the Claude side, where Brain
  cannot see:
  - the sessions do not call Brain at all;
  - nothing in Brain's rows names a cause;
  - it is consistent with a usage limit on the account, or with Routines being
    edited, but neither is established.
- 3-A is now held by an operator. Brain will not lift that hold by itself.

Compared with the 24-hour reading: 3-C showed it *can* work and then stopped
again, 3-A moved from automatic recovery to an operator hold, and 3-B, 3-D and
Factory 3 are unchanged.
