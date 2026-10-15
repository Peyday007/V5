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
- **2-D**. Probed after 2-C's automatic probe settled (see below).

## 4. Monitoring

One-shot readings are scheduled for 2026-10-16, 10-17 and 10-18 at 17:50Z.
Their results will be appended here. None of them has happened yet.
