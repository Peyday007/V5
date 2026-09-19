# Fleet-12 activation — production evidence log

**Objective.** Three authorized Claude subscription accounts, four Routines each,
twelve working Routines, fleet concurrency 12 and per-account concurrency 4 —
each Routine proven individually by a *fresh pinned* probe, then all twelve
proven together in one wave, then every one of them completing substantive
research, with the deployed loops sustaining the work unattended.

**This file records readings, not intentions.** Every line below resolves to a
production row, a workflow run, or a timestamp taken from one. Where something
is not known it says so; where it is blocked on a person it names the person and
the exact action.

---

## Phase 0 — the authoritative inventory

Taken from `fleet show` on the deployed image, commit `5e9aed6`, at
**2026-09-19T08:41:41Z** ([run 35432675675](https://github.com/Peyday007/V5/actions/runs/35432675675)),
and from `admin workers list` at **08:43:35Z**
([run 35432762655](https://github.com/Peyday007/V5/actions/runs/35432762655)).

### What the fleet actually holds

`accounts 5, routines 13` — but three of the five accounts and five of the
thirteen Routines are not part of this mission and are excluded by name:

| Excluded | Why |
| --- | --- |
| `friend-2` / `V2` (`trig_01HR74TmLtm8L21sh2Xryqhq`) | QUARANTINED, *"sessions complete without checking in operator hold"*; legacy surface the mission excludes explicitly |
| `Brain Research A` / `V1-oak` ×2 (`trig_0137jBhBj9fwHCM13Aaf7DTN`, `trig_01YJpttXm67Nft6gcUUnXQAS`) | RETIRED — Oakwood factory proof, `docs/OAKWOOD-RETIREMENT.md` |
| `verify-hosted-account-a` / `-b` | `scripts/verify-hosted.ts` fixtures. Their `MISSING SECRET VERIFY_HOSTED_NEVER_SET` is by design and is not a fault |

### The intended three accounts

**Account 1 — `Brain Research A`** (ENABLED, `plan=Max`, account target 4).
Bound worker `airynworker2` / `wkr_1cdd82cfb2a54faf8edd` for all four. The worker
name is a historical artifact of the first connector this Brain ever had; the
four Routines are owned by the Claude account whose trigger list contains them.

| Routine | Trigger ref | Secret | fires | refusals | no-shows | State |
| --- | --- | --- | --- | --- | --- | --- |
| Brain Research A | `trig_01CBLu5oCZziEwznw5q9xU7g` | `BRAIN_ROUTINE_TOKEN` | 327 | 2 | 0 | ENABLED |
| Brain Research 1-B | `trig_01TT7u3m4T6JW14vjwsK9qHm` | `BRAIN_ROUTINE_TOKEN_1_B` | 35 | 0 | 0 | ENABLED |
| Brain Research 1-C | `trig_01QbxS8dWTcqV3zoEhx9wBen` | `BRAIN_ROUTINE_TOKEN_1_C` | 36 | 0 | 0 | ENABLED |
| Brain Research 1-D | `trig_015aYoUwidycXymZ2xxWBC5B` | `BRAIN_ROUTINE_TOKEN_1_D` | 35 | 0 | 0 | ENABLED |

**Account 2 — `Caleb`** (ENABLED). Bound worker `calebworker1` /
`wkr_1db1193323454ee69bb1` for all four.

| Routine | Trigger ref | Secret | fires | refusals | State |
| --- | --- | --- | --- | --- | --- |
| Caleb 3-A | `trig_016dyf9oueMd7zQLY2pGrQFt` | `BRAIN_ROUTINE_TOKEN_CALEB_3_A` | 1 | 1 | **QUARANTINED** |
| Caleb 3-B | `trig_012DkgiTnPr799Le6iL4HEPt` | `BRAIN_ROUTINE_TOKEN_CALEB_3_B` | 1 | 1 | **QUARANTINED** |
| Caleb 3-C | `trig_016yNPUw8BpoiYa5S8tU3bG3` | `BRAIN_ROUTINE_TOKEN_CALEB_3_C` | 0 | 0 | ENABLED, never fired |
| Caleb 3-D | `trig_01YAGrc58yyaYXHh4Zpfrvzt` | `BRAIN_ROUTINE_TOKEN_CALEB_3_D` | 0 | 0 | ENABLED, never fired |

Both quarantines carry the provider's own words, recorded on the row:

> `AUTH: 401 {"error":{"message":"Token is not authorized for this routine","type":"authentication_error"},"request_id":"req_011CfByZEUhHGkUCLMxsiGoE"}` — 3-A, row written 2026-09-19T02:03:01.191Z
> `… "request_id":"req_011CfBym2TiQoudqLrT2PJpC"` — 3-B, row written 2026-09-19T02:05:41.178Z

**Account 3 — `Airyn`: not registered.** There is no `fleet_accounts` row named
Airyn and no Routine bound to any Airyn-owned worker. `admin workers list`
returns ten workers and the only two Airyn-shaped names are `airynworker1`
(ARCHIVED, 0 projects) and `airynworker2`, which is account 1's worker. So this
is an **absence**, not a misconfiguration: four of the twelve Routines have never
existed in this Brain.

### Reading

Registered and potentially provable today: **6 of 12** — account 1's four, and
Caleb 3-C/3-D which have a credential name and have never been fired. Blocked on
a credential: Caleb 3-A/3-B. Absent entirely: Airyn ×4.

---

## Phase 1 — targets

| Change | Before | After | Evidence |
| --- | --- | --- | --- |
| FLEET concurrency target | 4 | **12** | `FLEET: OK set-target FLEET 4 -> 12 version=4 actor=operator:fleet-cli` @ 2026-09-19T08:48:23Z, [run 35432981525](https://github.com/Peyday007/V5/actions/runs/35432981525) |
| `Brain Research A` account target | 4 | 4 (already correct) | `fleet show` @ 08:41:41Z |
| `Caleb` account target | not set | **4** | pending |

---

## Current phase

Phase 1 — targets, then fresh pinned probes on the six provable surfaces.

## Next executable action

`fleet verify-surface --ref trig_01CBLu5oCZziEwznw5q9xU7g --probe`, then the same
for `trig_01TT7u3m4T6JW14vjwsK9qHm`, `trig_01QbxS8dWTcqV3zoEhx9wBen`,
`trig_015aYoUwidycXymZ2xxWBC5B`, `trig_016yNPUw8BpoiYa5S8tU3bG3`,
`trig_01YAGrc58yyaYXHh4Zpfrvzt`; capture each probe's bin id and prove it with
`step10 trace <bin>`.
