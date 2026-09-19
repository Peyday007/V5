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

## Phase 2 — six fresh pinned probes, and what they found

One probe per provable surface, created by `fleet verify-surface --ref … --probe`
between 08:50:25Z and 08:53:29Z. Each carries its own nonce (`createProbeBin`
stamps `new Date().toISOString()` into the manifest unit's input), belongs to no
campaign, and forbids every external effect.

| Surface | Probe bin | What happened |
| --- | --- | --- |
| Brain Research A | `bin_94a474cb442544ee85d0` | fired 08:50:33.784Z, session `cse_01Ua47ZP4RFB6K4N2TWrKX5N`, **COMPLETE** |
| Brain Research 1-B | `bin_2b38a27698094e238b16` | fired 08:51:13.616Z, session `cse_01QdhMUPWWFRvriFpcA47wdr`, **COMPLETE** |
| Brain Research 1-C | `bin_8b0e06410d6d4bf1a199` | fired 08:51:53.483Z, session `cse_01NHKxvEWmtqBAvNxuLWcr1t`, **COMPLETE** |
| Brain Research 1-D | `bin_16c5e13d832a44cfb7f7` | **never fired.** Claimed by 1-C's session — see below |
| Caleb 3-C | `bin_f2eec76c517943d5bdf0` | fired 08:52:52Z → provider `AUTH 401`, surface quarantined |
| Caleb 3-D | `bin_09b669a94726494da139` | fired 08:53:32Z → provider `AUTH 401`, surface quarantined |

### Caleb: all four secrets are wrong, and now all four are proven wrong

3-A and 3-B had 401'd overnight. 3-C and 3-D had **never been fired in their
lives** (`fires=0`), so nothing had ever tested them. These two probes did, and
the provider refused both in the same words:

```
Caleb 3-C  row written 2026-09-19T08:52:52.685Z
  AUTH: 401 {"error":{"message":"Token is not authorized for this routine",
             "type":"authentication_error"},"request_id":"req_011CfCWoygitxXsnxBrRiUNU"}
Caleb 3-D  row written 2026-09-19T08:53:32.722Z
  … "request_id":"req_011CfCWrvrA7bYjiFNSy3ZjS"
```

So the reading is no longer "two of Caleb's surfaces are broken". It is **all
four of Caleb's deployment secrets hold a token that is not authorized for the
trigger it is registered against.** Brain did the right thing four times: fired
once, quarantined by name at the first `AUTH`, recorded the provider's own
words, and spent nothing further.

Not a Brain defect and not repairable from here. `calebworker1` holds 46 minted
OAuth tokens of which 23 have been used, so Caleb's *connector* authenticates
to Brain perfectly well — it is the four *trigger* tokens Brain fires **with**
that are wrong. Correcting one means holding its value, and a Routine's token
is only visible in the Claude account that owns it.

### The defect: a pin bounded the fire and not the claim

`step10 trace bin_16c5e13d832a44cfb7f7`:

```
BIN bin_16c5e13d832a44cfb7f7  COMPLETE  gen 2
  title      Surface self-test for Brain Research 1-D
  ready      2026-09-19T08:52:20.721Z
  completed  2026-09-19T08:52:30.532Z
  terminal   DETERMINISTIC_UNITS_V1 v1 evaluated true.

  DISPATCH
                            <- empty
  EVENTS
    08:52:22.159Z  BIN_ASSIGNED  worker wkr_1cdd82cfb2a54faf8edd
                                 session claude-code-session_01NHKxvEWmtqBAvNxuLWcr1t
```

`cse_01NHKxvEWmtqBAvNxuLWcr1t` is the session Brain fired at **1-C** at
08:51:53. It finished its own probe, checked in again, and was handed 1-D's —
1.4 seconds after that bin went READY and before the dispatcher's next tick
could fire 1-D at all.

`bins.pinned_routine_id` was read by `routeBin` and by nothing else:
`assignNextBin` never consulted it. So on an account whose four Routines share
one Claude connector, a pinned probe is taken by whichever sibling is awake.
And because `proveSurface` reads the sessions `creditDispatchArrival`
attributed to *that Routine's own* dispatches, the substituted probe leaves the
pinned surface's chain open for ever — which is exactly why 1-B and 1-D read
**35 fires, arrivals, and no closed chain** while being perfectly healthy.

Fixed in this branch; see the entry under Phase 3.

## Phase 3 — the durable fix

`server/domain/sessionRef.ts` + a guard in `assignNextBin`: a pinned bin is
offered only to the session Brain actually fired at that Routine, read from
`bin_dispatch`. Fails closed, restrictive only, skipped ahead of the accounting
so a refusal costs no attempt. `tests/pinnedProbeClaim.test.ts` reproduces the
production sequence; five of its nine assertions were run against a neutered
guard first, and failed.

## Phase 4 — the overnight backlog

`admin research start`, one packet and one bin per `SEARCH_BUCKET`, auto-
approved inside `RUSSELL_CASH_DISCOVERY_V1`, attributed to
`rosserpeyton@gmail.com`.

| Project | Layer | Result |
| --- | --- | --- |
| `cash-mode-2` | `lyr_fb5743c000d045059555` | 10 started, 0 repaired |
| `cash-mode-3` | `lyr_f6f526f93fe34f0db759` | 10 started, 0 repaired |
| `cash-mode-4` | `lyr_…` (created in the same run) | 10 started, 0 repaired |

**Thirty substantive research bins**, none overlapping another: ten bounded
questions per operation, and the three operations are separate private projects.

Each bin carries a bounded discovery question, published-source-only evidence
requirements, its own orchestration, and prohibitions on buying, contacting,
advertising and paid overage.

### What the backlog actually produced, within ten minutes

`brain_list_work` on `cash-mode-2` at 09:17Z, read through the MCP connector:

- **10 of 10 `RESEARCH_PLAN` items SUCCEEDED.** Every bucket decomposed into
  bounded fragments with declared evidence lanes.
- `RESEARCH_FRAGMENT` items running and finishing with sourced claims —
  `wki_3510b3976e154338b10b` submitted ten (`clm_05d8edeb…` and nine more):
  two open Algora.io GitHub-issue bounties with their amounts, and the ARC
  Prize Milestone #2 with its closing date; Topcoder and Bugcrowd recorded as
  **unresolved** because their listings were unreachable or JavaScript-only,
  rather than dropped or inferred.
- `RESEARCH_VERIFY` passes accepting *and rejecting* on evidence:
  *"Verified all 6 submitted claims against their source articles (re-fetched
  raw HTML to confirm verbatim quotes) … 4 accepted / 2 rejected; Legacy
  Plumbing's 2 claims failed scope match on population/definitions since the
  source doesn't establish independent ownership."*

That is substantive, source-backed, persisted research, produced by the
deployed loops with nothing in this conversation driving it.

### One packet in ten parked, and it is explained rather than stuck

`orc_35c546339ab145d59b92` ("Which openings are about to close") is
`NEEDS_HUMAN` at `pass PLAN`, with the reason recorded verbatim:

> The proposed plan falls outside the preauthorized envelope: fragment
> `"us-federal-grant-deadlines-closing"` accepts *"Linked agency Notice of
> Funding Opportunity (NOFO) PDF documents (primary)"*, which this envelope
> does not admit.

The plan itself is well-formed — three fragments, declared lanes, primary
sources — and a federal NOFO published on Grants.gov is an official government
record, which is the envelope's own first admitted category. `CASH_SOURCE_TYPES`
simply carries no alternative matching *agency*, *notice*, *funding
opportunity* or *document*. It is the same shape this file records four times
already: **a list with the rule right and the alphabet short.**

It is **not** fixed here, deliberately. Nine of ten packets planned and are
researching, so this is not what stops the fleet working, and widening an
approval envelope is a change with its own reasoning that does not belong
riding on a dispatch fix. The answering transition exists and is documented:
`NEEDS_HUMAN` is in `startPacket`'s `DEAD` set, so re-running
`admin research start` on the project starts a corrected packet beside it with
every row of the refused one preserved.
