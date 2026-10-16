# Airyn's four Routines: will they stay connected? — 2026-10-15

This covers Airyn 2-A, 2-B, 2-C and 2-D only. All four belong to one Claude
account (`acct_a5bac7f8350840f9bdbc`). Each is registered for the research
worker `wkr_9826789954a34b338620` (worker-12), and the intended connector is
`cnr_4d76d22152814b318fca` at `/mcp/factory`.

The other Brain connector in that account is `/mcp`. It authorizes as the
factory worker `wkr_f8e118e87fd141689adc` (worker-10), which is the wrong
worker for these Routines.

Everything below is read from production rows on revision `15c8381` or produced
by the simulation in `tests/airynDurability.test.ts`. Each claim says which.

## 1. What actually disconnected them

| mechanism | when | whose | evidence |
|---|---|---|---|
| Routine selected the wrong connector | 09-23 to 10-11; 115+ fires each | **Claude Routine configuration** | every session authenticated as worker-10 |
| No-show quarantine of sessions that had in fact arrived | 09-23 | **Brain** (fixed 10-11, §59) | arrivals were credited only when a bin was taken |
| Mixed connectors: Routine held both and picked one per session | 10-11 to 10-14 | **Claude Routine configuration** | 2-C: 405 right and 53 wrong arrivals in a week, interleaved; 2-B, 2-D: right then wrong |
| Isolated misses accumulating toward quarantine across arrivals | until 10-15 | **Brain** (fixed today, #204) | count reset only when a credential took a bin |
| Recovery budget spent on genuine wrong-worker probes | 2-B, 2-D since 10-12 | by design | 4 AMBIGUOUS probes each; Brain stops and names a person |
| Brain database outages | 10-08, 10-12, 10-14, 10-15 | **Brain's infrastructure** | 4 infra misses on 2-A in 30h, none charged |
| Burst of unanswered fires | 2-A, 10-15 03:44–03:53 | **Claude side** | 7 fires in 10 minutes, none started a session that reached Brain |

Token refresh was not a cause at any point. Nothing in the rows shows a
refused refresh or expired consent on this connector.

## 2. Simulated durability (`tests/airynDurability.test.ts`)

What is real in the simulation: Brain's check-in, no-show pass, wrong-worker
logic, token rotation, recovery probe, automatic recovery and bin completion.
What is faked: only the clock and Claude's fire.

| scenario | result |
|---|---|
| 7 days, 4 Routines, hourly fires (672) | 26+ isolated misses, a 2-hour database outage, a restart and hourly refreshes. All four stay ENABLED throughout; the miss count never exceeds 1; every arriving session completes its bin; outage misses are charged to nobody. |
| Same 7 days, before #204 | Fails: 2-C reaches 2 counted misses by hour 18 though sessions arrived in between. This was a real drift. |
| Two sessions present the same refresh token | Both get the same successor; all four keep working. |
| 35 days of hourly refreshes | The refresh token keeps renewing; no person is needed. |
| One Routine's sessions stop for 3 hours | That Routine alone is quarantined. Brain probes it back, and its siblings stay ENABLED. |
| 12 hours of database outage | No quarantine, no recovery probe spent, every miss charged to infrastructure. |
| Mixed history, then corrected | Lifts after exactly 3 right sessions in a row, within the automatic budget. Then a simulated day of fires with no re-quarantine. |
| A silent Routine whose bins its siblings take | Charged late (3 of 6 silent fires), still quarantined. Detection is slower, not missed. |

The simulation establishes that Brain's own state does not drift and that it
recovers what it can. It does **not** establish that Claude keeps starting
Airyn's sessions with the right connector for a week. Only elapsed production
time can show that.

## 3. Live checks (bounded: one recovery probe per Routine)

- **2-A** (not probed; already ENABLED). In 30h, about 298 fires led to 274
  right-worker arrivals and **0 wrong**. One burst of 7 misses (03:44–03:53)
  quarantined it; Brain's automatic probe lifted it at 04:01 with nobody
  involved.
- **2-C**. Probe `crp_4c2a7fff…` at 17:41: the session arrived as the research
  worker only, with no wrong-worker arrival. It is still quarantined: its
  mixed history needs 3 right sessions in a row. Brain's automatic follow-ups
  started at 18:06.
- **2-B**. Probe `crp_29ffa62a…` at 17:50: **NO_MCP**. Claude started the
  session and nothing reached Brain within 15 minutes. 2-C's probe through
  the same connector reached Brain nine minutes earlier, so Brain was
  answering.
  Brain's automatic follow-up at 18:06 (`crp_e20fdd0a…`) also read
  **NO_MCP**. Two separate sessions started by Claude never reached Brain.
  This is 2-B's Claude Routine: it has no working Brain connector attached.
- **2-D**. Probe `crp_8e433e81…` at 18:44: **AMBIGUOUS, BRAIN_UNAVAILABLE**.
  Brain's database was failing while the session would have arrived. Nothing
  was concluded or charged, and Brain re-probes it by itself once healthy.
  Correct behavior, and no evidence about 2-D's configuration yet.

## 3a. Later the same evening: every Routine arrives as the right worker

Read at 19:30Z, revision `15c8381`:

- **2-C**: right-worker sessions at 17:43 and 18:22; a third probe fired at
  19:28.
- **2-D**: right at 19:00. This was Brain's own re-probe after the
  BRAIN_UNAVAILABLE one.
- **2-B**: right at 19:28, after its two NO_MCP probes.

Every one of these arrivals authenticated as `wkr_9826…`. No session has
arrived as the factory worker since 2026-10-14 16:02. So the corrected
configuration is proven from session identities, on all four Routines.

## 3b. Root causes of the remaining interruptions

**2-B, NO_MCP at 17:50 and 18:06, then right at 19:28.** Claude started both
sessions. Neither reached Brain, while 2-C reached Brain through the same
account connector at 17:43 and 18:22. A Claude connector belongs to the
account, so neither the connector nor its tokens can be the cause. The
difference is 2-B's own Routine, and it cleared without anything changing on
Brain's side.

**The most likely explanation is Brain, not Claude.** Brain failed check-ins at
17:43–17:46 (pool checkout timeouts). At the time its authentication ran at
p95 15 s, max 40 s, and its token refresh at p95 53 s
(`docs/CONNECTION-DURABILITY-2026-10-15.md`). Claude's MCP client gives a
connector about 30 s to connect; after that the session runs without Brain's
tools and never calls Brain. #207 fixes this: the connector handshake answers
from a recent proof instead of waiting on the database, and a slow answer is
recorded as Brain's incident, so the miss is not charged. The other
possibility is that Airyn was editing 2-B's Routine during that window.
The NO_MCPs fall in the hour his correction was being made. This cannot be
proven from Brain. What would settle it is in Claude:
- 2-B's run history for sessions `cse_01PmJGpLwHGNWjDn28FDTdzY` (17:50Z) and
  `cse_01VfESiXDJAzNgbEqEVUCphL` (18:06Z);
- when the Routine was last edited.

**2-A, 02:55–03:23 on 10-15: account-level.** Claude accepted 13 fires and
returned sessions, and none of them reached Brain. Four sessions had arrived
at 02:51 within one second. Over the same window, Research Routines on a
different Claude account kept arriving. That pattern fits a Claude
account-level limit, such as a usage window or a cap on concurrent sessions. It is not settled.
In the same window Research A took 106 s from fire to arrival, so Brain may
have been answering slowly. Before #207 a slow-but-successful authentication
left no record, so this cannot be decided after the fact; next time it will be.
Brain was firing 2-A in bursts of 3–4 within seconds, because it was Airyn's
only enabled Routine. Recovery by Brain's probe at 04:01 needed nobody. The
same evidence lives in Claude: Airyn's run history for 2-A between 02:55 and
03:25 UTC.

**Brain-side defects found and fixed:**

1. The no-show quarantine count ignored arrivals that took no bin (#204,
   deployed). Isolated misses accumulated across days into false quarantines.
   The 7-day simulation fails without the fix.
2. A right-worker probe on a corrected Routine with mixed history counted as a
   *failed* probe (#206). Recovery took about 16 hours and sat one miss away
   from needing a person; now it takes under an hour. The simulation
   reproduces both figures.
3. A request reaching `/mcp` with no token left no trace (this branch). A
   NO_MCP probe could not tell "never called" from "called with no token". The
   connection report now prints a per-process tally by endpoint and client
   family.

**What Brain cannot fix:** a Claude Routine whose connector selection is wrong,
a Claude account that stops running sessions, and a Routine that is edited
while it runs. Brain detects all three, stops spending activations on them,
recovers by itself once they clear, and names the account owner only when
recovery is exhausted.

## 4. Monitoring

One-shot readings are scheduled for 2026-10-16, 10-17 and 10-18 at 17:50Z.
Their results will be appended here. None of them has happened yet.

## 5. After the fixes were released (21:33Z, revision `1c61b18`)

`1c61b18` was released at about 21:25Z. It contains #204, #206, #207 (connector
handshake answered from a recent proof, slow answers recorded as Brain's
incident) and #208 (calls that arrive without a token are counted). The first
reading on that revision:

- Two new processes, both `pressure NORMAL`, with no infrastructure failures
  felt and no requests without a token since they started. The last process on
  the old revision `15c8381` had recorded authenticate at p95 15.2 s (max
  40.6 s) and token refresh at p95 39.2 s (max 52.6 s), with 29 control-plane
  connections lost. Those are the numbers #207 targets.
- Even so, slow statements are still present at boot: a 40 s scan of
  `research_orchestrations` and a 50 s `design_surfaces` update. The database
  is still slow at times. #207 means a connector handshake no longer waits on
  it.
- 2-A is ENABLED. 2-B, 2-C and 2-D are QUARANTINED for mixed workers, judged
  from their seven-day history. The newest wrong-worker arrivals were on 10-12
  (2-B, 2-D) and 10-13 22:20Z (2-C). Each needs 3 right sessions in a row to
  lift: 2-B and 2-D have 1, and 2-C has 0. With #206, Brain now probes every
  15 minutes after each right-worker probe, and runs one slow probe a day after
  the fast budget is spent. Lifting needs nobody, as long as Claude keeps
  starting sessions that reach Brain.

Not yet observed on `1c61b18`: an Airyn session arriving through the new
handshake path, and a quarantine lifting. The scheduled readings below will
record both or their absence.

## 6. 24-hour reading (2026-10-16 ~18:20Z, revision `f02318e`)

Taken by the scheduled reading. The first two attempts failed at 17:51Z:
`could not reach aws-0-us-east-2.pooler.supabase.com`. The serving process
had restarted at 17:44Z and recovered by 17:49Z (`pressure NORMAL`).

Since the baseline (2026-10-15 17:45Z):

| Routine | state now | lifted | fires | arrived as worker-12 | arrived as worker-10 | real no-shows | infra misses |
|---|---|---|---|---|---|---|---|
| 2-A | ENABLED | — | 110 | 75 | 0 | 0 | 1 |
| 2-B | ENABLED | 10-15 22:47Z, by Brain's probe | 80 | 61 | 0 | 0 | 3 |
| 2-C | ENABLED | 10-15 22:30Z, by Brain's probe | 80 | 57 | 0 | 0 | 2 |
| 2-D | ENABLED | 10-15 23:48Z, by Brain's probe | 73 | 52 | 0 | 0 | 1 |

- Probe outcomes since the baseline: 2-B had 2 NO_MCP (17:50Z and 18:06Z),
  then 3 HEALTHY. 2-C had 1 NO_MCP (19:28Z), then HEALTHY. 2-D had 3
  AMBIGUOUS (Brain was unavailable at the time) and 1 NO_MCP (22:31Z), then 3
  HEALTHY. Every probe after the release of `1c61b18` was HEALTHY except one
  NO_MCP on 2-D at 22:31Z.
- Fires minus arrivals is not a count of no-shows. An arrival is recorded only
  when the session reports the provider session it was fired as, and every
  fire that went unanswered is accounted for in the infra column.
- The infra misses were charged to nobody. Seven Brain-side incidents
  (`CHECK_IN_BUDGET`, `POOL_CHECKOUT_TIMEOUT`, and two restarts at 07:00Z and
  07:18Z) excused them, as designed.
- EARLY WARNING lists nothing for Airyn. Its only `SIBLING_DOWN` line is for
  Caleb's connector, which is out of scope here.
- No Airyn Routine has fired since 14:22Z, and neither has any other Routine
  in the fleet. Nothing in the rows says Airyn's connection is the reason;
  whether there was no ready work is not read here.

Compared with the baseline, the change is for the better: the wrong-worker
quarantines lifted by themselves within about six hours, and nobody acted.

One Brain defect is visible in this reading. `unansweredFiresByRoutine` is the
database's costliest statement on the serving process: 70 calls, mean about
55 s, max 124 s. It runs three correlated subqueries for every
`DISPATCH_NO_SHOW` row ever written. That is load on the same database whose
slowness causes the remaining misses.
