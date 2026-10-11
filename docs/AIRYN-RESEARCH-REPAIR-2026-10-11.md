# Airyn's Research Routines — diagnosis and repair, 2026-10-11

Read from production on the serving revision `034737c` through the operator
workflows (`connectors show`, `fleet show`, `fleet attribution`, `oauth trace`,
`connection-report`, `dispatch-diagnose`, `access show`). Nothing was forged,
no credential was created, and no OAuth step was bypassed.

## What was wrong

| Routine | trigger | was bound to | state |
|---|---|---|---|
| Airyn 2-A | `trig_01ENEHuzuUxyLbmpL6iJ767u` | worker-05 `wkr_1cdd82cf…` | QUARANTINED since 2026-10-05 |
| Airyn 2-B | `trig_01VGQsTjpZYy4yXaUmtrUQbH` | worker-05 | QUARANTINED |
| Airyn 2-C | `trig_013FTeBmCpwF6eJkXgcWh4Db` | worker-05 | QUARANTINED |
| Airyn 2-D | `trig_01RXR12DwWgavd1XJ7uQAMCa` | worker-05 | QUARANTINED |

worker-05 is the Brain Research A identity. Its only live credential is client
`brnc_d9a8a340…` in the Brain Research A account (`cnr_8ee38427…`). **Airyn's
Claude account holds no worker-05 credential.** None of the other four worker-05
clients has had token activity in seven days.

Airyn's account holds two Brain connectors. Both refresh in the same
millisecond, which places them in one account: 03:24:27.49Z, and again 6 s
after each probe fire.

| endpoint | client | worker | what it is |
|---|---|---|---|
| `/mcp` | `brnc_e9f31f79…` (`cnr_4d4c969c…`) | worker-10 `wkr_f8e118e8…` | Factory, families `[FACTORY]`, repo `peyday007/v5`. Healthy, used by Factory surface 2. |
| `/mcp/factory` | `brnc_d15dc823…` (unattributed) | worker-12 `wkr_98267899…` | Research scopes on Cash Mode 1 only. Approved 2026-10-07 13:47Z (`inv_df48d976…`). |

## Proof

Two recovery probes were fired at Airyn 2-A:

- `crp_ea55db36…` (05:00:50Z), with the Routine bound to worker-05;
- `crp_7d45e67f…` (05:43:51Z), after repointing it to worker-12.

Both fires were accepted by the provider, so the trigger and secret are fine.
Both settled NO_MCP: nothing took the Research probe bin, and the bin records
no refusal. In each window the session used worker-12's credential first (+7 s)
and worker-10's credential last (+10 s / +14 s). After that, nothing was used
for the rest of the 15 minutes.

That is a session whose Brain calls go through the `/mcp` connector. That
connector is worker-10, Factory-only, so it is offered no Research work, and
the session stops. That is also how the quarantine accumulated after Airyn's
`/mcp` connector was re-consented as worker-10 on 2026-10-04 02:23Z.

## Repaired (Brain side)

`fleet repoint-worker` on all four Routines, worker-05 → worker-12. Each change
was guarded on the current binding and audited as `REPOINT_ROUTINE_WORKER`.
worker-12 is the research identity that actually lives in Airyn's account.

Not changed:
- the Factory connector, worker-10 and Factory surface 2;
- every quarantine. A quarantine lifts only after a proven check-in.

## The one action Airyn takes

In Claude, open each of the Routines **Airyn 2-A, 2-B, 2-C and 2-D**. Set its
Brain connector to the one whose URL ends in **`/mcp/factory`**, and remove the
one whose URL ends in just **`/mcp`** from these four Routines only.

Leave the `/mcp` connector itself, and the Factory Routine, exactly as they
are. No sign-in or approval is needed: that connector is already authorized.

## After that (operator, no Airyn)

Run Admin → `connectors probe` → `trig_01ENEHuzuUxyLbmpL6iJ767u`.

A HEALTHY outcome then does three things:
- attributes client `brnc_d15dc823…` to a new connector (Airyn, `/mcp/factory`, worker-12);
- lifts 2-A's quarantine;
- binds 2-B, 2-C and 2-D from the same evidence. The dispatch tick lifts their
  no-show quarantines because the connector's consent (10-07) postdates them.

Probe any of B/C/D that is still quarantined afterwards. Then confirm one
dispatched Research bin reaches COMPLETE.

worker-12 is a member of Cash Mode 1 only. Before this, Airyn's surfaces served
every project worker-05 does. Widening that is a separate `access grant`
decision and was not taken here.
