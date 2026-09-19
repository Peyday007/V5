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
| `Caleb` account target | not set | **4** | `fleet show` @ 12:29:26Z: `Caleb  ENABLED  declared=— plan=— target=4`, [run 35442987945](https://github.com/Peyday007/V5/actions/runs/35442987945) |

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

---

## Phase 5 — the build that had to happen first, and why

The pin fix could not reach production, because **production had been
undeployable since the capability kernel merged** and nothing said so.

`Dockerfile` carried `COPY docs/capability ./blueprints` while `.dockerignore`
excludes `docs` and `*.md`, so the build context contained no such path.
Depot answered `"/docs/capability": not found`
([run 35435442806](https://github.com/Peyday007/V5/actions/runs/35435442806)),
the workflow fell through to its Fly builder fallback, and that answered
`unauthorized` — two failures, neither of which names the real one.

The fix moves the *source* rather than widening the ignore file:
`docs/capability/**` → `blueprints/**` by `git mv`, so every byte and every
sha-256 `registerBlueprint` resolves against is unchanged. §37 already records
why the destination must stay outside `docs/`: `documentedReading` answers
`unknown(NO_DOCS_HERE)` only while that directory is absent, so copying `docs/`
into the image would have turned every unnamed component's reading into a
confident `NO`.

`tests/systemSelfModel.test.ts` gained the check that would have caught it:
it parses every `COPY` in the `Dockerfile` and every rule in `.dockerignore`
and fails on a source the build context cannot contain. A build-context
mismatch is invisible to a typecheck, invisible to the suite and invisible to
a reading of either file alone — it exists only in the relationship between
two files nothing held against each other.

### The three deploys

| Run | Commit | Result |
| --- | --- | --- |
| [35435442806](https://github.com/Peyday007/V5/actions/runs/35435442806) | — | **failed to build**: `"/docs/capability": not found` |
| [35436929809](https://github.com/Peyday007/V5/actions/runs/35436929809) | `8c997720` | released; post-restart verification `fetch failed` after 5m20s — recorded below |
| [35440403377](https://github.com/Peyday007/V5/actions/runs/35440403377) | `ca6c3eb` | released 11:46:00Z, restarted, healthy 12:00:05Z |

`ca6c3ebc119687470307607e13f358c2fcbc7e20` is the deployed commit. Said
precisely, because the two commits prove different things:

- **`8c997720` was live and serving**, confirmed *independently of its own
  deploy run* by the scheduled Production guard,
  [run 35439163107](https://github.com/Peyday007/V5/actions/runs/35439163107)
  at 11:05:42Z — and by production behaviour that only exists in it: the
  4m24s hold on `bin_5922df8c521a421cb9de` at 11:33 (Phase 6) is the pin guard
  running, and it could not have happened on the previous image.
- **`ca6c3eb` is what deploy [run 35440403377](https://github.com/Peyday007/V5/actions/runs/35440403377)
  released** at 11:46:00Z, with the machine answering healthy at 12:00:05Z. It
  differs from `8c997720` only by the `BIN_ASSIGNMENT_REFUSED` recording, which
  emits a row nothing has yet needed to emit — so there is no *behavioural*
  confirmation of this commit beyond its own release, and this file does not
  claim one.

### One post-restart verification failure, recorded and not explained away

Run 35436929809 ended `HOSTED-VERIFICATION: FAIL could-not-complete` /
`fetch failed` after roughly 5m20s of silence. §27 records six earlier
instances of that shape and settles two of them on Node's 300-second default
header timeout.

**That explanation is excluded here.** `scripts/verify-hosted.ts` now passes an
explicit `REQUEST_TIMEOUT_MS` of fifteen minutes with a named failure, so a
300-second default is no longer what this client does. So this is a **new**
reading at the same place, and what caused it is **not known**. Recording it as
the already-diagnosed condition would have been the comfortable half-truth this
repository keeps refusing.

What it is *not* is a failed release: `release: success`, the pre-restart
verification passed in full on the released image, and the post-restart run
passed every persistence, identity, queue, idempotency and MCP check before it
stopped. The next deploy of the same tree plus one commit passed end to end.

## Phase 6 — per-surface proof under the fixed code

Every reading below is `fleet verify-surface`, which refuses unless Brain's own
four rows line up: **Brain fired this Routine**, a session **arrived** and was
attributed to the bound worker *from that same dispatch row*, it was
**assigned** a bin, and that bin reached **COMPLETE**.

| Surface | Verdict | Chain | Run |
| --- | --- | --- | --- |
| Brain Research 1-D | **VERIFIED** | `bin_7024d12474c949129a0c` | [35442417627](https://github.com/Peyday007/V5/actions/runs/35442417627) |
| Brain Research 1-B | **VERIFIED** | `bin_52d91a0a243e48929772`, fired 10:17:53.796Z, arrived 10:43:52.873Z as `airynworker2` on `oat_3eb966331acc4a13afee` | [35442542759](https://github.com/Peyday007/V5/actions/runs/35442542759) |

### The pin fix, demonstrated in production

`bin_5922df8c521a421cb9de` — "Surface self-test for Brain Research 1-D",
created before the fix and still READY after it, so the *same* bin was offered
under both code paths.

```
10:59:00.246  BIN_READY
10:59:03.921  DISPATCH_UNROUTED  ACCOUNT_TARGETS_REACHED   (again 11:00:04, 11:01:13, 11:02:14)
11:03:24.014  DISPATCH_ROUTED    Selected Brain Research 1-D on Brain Research A: 1/∞ Routine, 3/4 account
11:03:24.954  DISPATCH_SENT      session cse_01UHrnKDgJeez7e6mZt27sQf      <- fired, nobody arrived
11:33:33.800  DISPATCH_INTENT                                              <- reopened at IN_FLIGHT_WINDOW_MS
11:33:34.104  DISPATCH_ROUTED    Selected Brain Research 1-D: 1/∞ Routine, 2/4 account
11:33:35.128  DISPATCH_SENT      session cse_013ZKCmpGT95eDTWsnKo5Tfu
11:33:55.546  BIN_ASSIGNED       worker wkr_1cdd82cfb2a54faf8edd  session session_013ZKCmpGT95eDTWsnKo5Tfu
11:34:06.242  BIN_UNIT_SUBMITTED
11:34:08.294  BIN_TERMINAL       COMPLETE  DETERMINISTIC_UNITS_V1 v1 evaluated true.
UNITS         echo 8c3a05d03245e51e  by wkr_1cdd82cfb2a54faf8edd
```

That bin sat READY for **4 minutes 24 seconds** with sibling sessions
demonstrably active on the same account, and no sibling took it. Compare
`bin_16c5e13d832a44cfb7f7` under the old code: READY at 08:52:20.721, assigned
**1.4 seconds later** to 1-C's session, with an empty `DISPATCH` block — a bin
completed by a Routine Brain had never fired it at.

The completion is also the fix's other half working: `DISPATCH_SENT` at
11:33:35.128 names `cse_013ZKCmpGT95eDTWsnKo5Tfu`, and `BIN_ASSIGNED` twenty
seconds later names `session_013ZKCmpGT95eDTWsnKo5Tfu`. Two spellings of one
provider session, matched by `normalizeSessionRef`. Without that the guard
would have refused the *correct* session and the probe would never complete at
all — which is the failure mode a fail-closed guard has to be tested for
rather than assumed past.

### And the first version of the guard was silently wrong

The skip recorded nothing, so the same bin sat READY at 0/2 attempts for
fourteen minutes after a successful fire with **no row anywhere naming a
reason** — §27's own defect, reintroduced by the fix for a different one. It
records a `BIN_ASSIGNMENT_REFUSED` / `PINNED_TO_ANOTHER_SESSION` bin event
naming both sessions now.

Deliberately a bin *event* and not a `bin_session_refusals` row: that table
defers the **fire**, and deferring the fire of a bin whose whole problem is
that its own fire has not arrived yet would be the wrong remedy pointed at the
wrong thing.

### Every provable surface, verified under the deployed fix

| Surface | Verdict | Fires | Refused | Arrivals attributed | Chain bin | Run |
| --- | --- | --- | --- | --- | --- | --- |
| Brain Research A | **VERIFIED** | 328 | 2 | 20 | `bin_94a474cb442544ee85d0` | [35443173917](https://github.com/Peyday007/V5/actions/runs/35443173917) |
| Brain Research 1-B | **VERIFIED** | 48 | 0 | 5 | `bin_52d91a0a243e48929772` | [35442542759](https://github.com/Peyday007/V5/actions/runs/35442542759) |
| Brain Research 1-C | **VERIFIED** | 48 | 0 | — | — | [35443224895](https://github.com/Peyday007/V5/actions/runs/35443224895) |
| Brain Research 1-D | **VERIFIED** | 48 | 0 | — | `bin_7024d12474c949129a0c` | [35442417627](https://github.com/Peyday007/V5/actions/runs/35442417627) |
| Caleb 3-A … 3-D | **not provable** | 1 each | 1 each | 0 | — | provider `AUTH 401` |

`arrivals 0 consecutive fire(s) with nobody arriving` on all four of account
one's surfaces, and `no-shows=0` on every row of `fleet show`.

---

## Phase 7 — what the unattended fleet actually produced

Read through the MCP connector at 12:30Z, from the deployed Brain's own rows.
Nothing in this conversation claimed, answered, verified, synthesized or
audited any of it.

### `cash-mode-2` — one packet carried the whole way to a judged verdict

Thirty work items, **29 SUCCEEDED and one reconciled**:

| Work type | Count | State |
| --- | --- | --- |
| `RESEARCH_PLAN` | 10 | all SUCCEEDED |
| `RESEARCH_FRAGMENT` | 8 | all SUCCEEDED |
| `RESEARCH_VERIFY` | 8 | all SUCCEEDED |
| `RESEARCH_SYNTHESIZE` | 1 | SUCCEEDED → `doc_ed8b451a716a4ff58190` |
| `RESEARCH_AUDIT` | 3 | PRIMARY SUCCEEDED, ADVERSARIAL reconciled, JUDGE SUCCEEDED → `aud_6db47950f91e401498f4` |

**75 claims submitted with source URLs**, gated per fragment. The judge's own
words: *"verdict PASS, 0 foundational gaps, 3 items classified
OPTIONAL_IMPROVEMENT, synthesis_ready true."*

The one non-SUCCEEDED item is not a fault and is not unexplained. The
ADVERSARIAL item's pass **was recorded** — which is why `JUDGE` became
available at 10:45:28Z — and the item itself was then retired at 10:49:33Z
because its lease had lapsed after its pass was stored. That is §24 exactly:
*a work item is finished by its owner, and reconciled only once its owner is
gone.*

The gate is visibly doing its job in both directions, in the workers' own
recorded summaries:

- *"4 accepted / 2 rejected … Legacy Plumbing's 2 claims failed scope match on
  population/definitions since the source doesn't establish independent
  ownership."*
- *"Gate rejected 7 of 10 checkable claims on scope: none of the read sources
  stated an explicit delivery/performance period."*
- *"resale_demand lane still has 0 accepted claims — documented as a
  tooling/access limitation (StockX JS-rendered, GOAT/Flight Club/eBay all
  HTTP 403) rather than an absence of evidence."*
- *"Exhausted SAM.gov API alternatives … surveyed all 16 currently-open
  tender-stage releases: shortest confirmed performance period is 22 weeks,
  none fit 'a few weeks'. This is now a documented negative finding rather
  than an access gap."*

That last one is the standard this platform exists for: an unreadable source
recorded as **unresolved**, and a negative result established by a documented
search rather than asserted.

### `cash-mode-4` — ten packets, read at 12:45:01Z

`npm run admin -- packets list cash-mode-4`
([run 35443729343](https://github.com/Peyday007/V5/actions/runs/35443729343)):

```
orc_011f2760e0b9400bbfa6  NEEDS_HUMAN   1 fragment(s)
orc_34486968016c44d28716  NEEDS_HUMAN   2 fragment(s)
orc_26fd2244c1844cce8052  NEEDS_HUMAN   1 fragment(s)
orc_4bcbef858db7404db71a  NEEDS_HUMAN   2 fragment(s)
orc_271c83cad055422c9a90  AUDITING      3 fragment(s)
orc_531b1a254e624ae5a803  NEEDS_HUMAN   2 fragment(s)
orc_21ca96f6328f4e0eacb7  AUDITING      3 fragment(s)
orc_b3695f9d569843d79eaa  NEEDS_HUMAN   3 fragment(s)
orc_dae70d4850cc4d1c9d6e  NEEDS_HUMAN   3 fragment(s)
orc_34a7690f50134224ae2a  NEEDS_HUMAN   1 fragment(s)
```

Ten packets, twenty-one fragments, two under audit and eight waiting on a
person. **Eight of ten is a high park rate and is reported as one** rather than
averaged away: `NEEDS_HUMAN` here is the evidence machinery refusing to advance
— a plan outside the approval envelope, a lane with no accepted claim, a
`MORE_RESEARCH` verdict — and each carries its own recorded reason. It is the
gate working, and it is also a signal that these ten bucket questions are
harder to settle from published sources than `cash-mode-2`'s were. Which of
those two it is, per packet, is a Cash Mode question rather than a fleet one,
and this file does not guess at it.

### Execution lineage, per Routine, on a live packet

`step10 audit-lineage orc_271c83cad055422c9a90` at 12:46:15Z
([run 35443770935](https://github.com/Peyday007/V5/actions/runs/35443770935)):

```
SYNTHESIS (author, attempt 1)  COMPLETE  worker=wkr_1cdd82cfb2a54faf8edd
                                         routine=rtn_29cec4a75d3947c9b786  (Brain Research 1-D)
                                         account=acct_70dda3fae2e1428e944b
                                         session=oat_39a0d3597fa04a0fb4eb
PRIMARY                        COMPLETE  routine=rtn_fbcb288d55854991bdfa  (Brain Research 1-B)
                                         session=oat_3eb966331acc4a13afee
ADVERSARIAL                    COMPLETE  routine=rtn_29cec4a75d3947c9b786  (Brain Research 1-D)
                                         session=oat_7055fa59e3584ccdb5ce
applied  PRIMARY_ADVERSARIAL      at SESSION
applied  SYNTHESIS_PRIMARY        at SESSION
applied  SYNTHESIS_ADVERSARIAL    at SESSION
STEP10: OK audit-lineage compliant=true audits=2 synthesis=1
```

Three things in that block are worth naming.

**It is per-Routine substantive attribution, from rows.** 1-D wrote the report;
1-B reviewed it; 1-D's *other* session argued against it. Those are research
passes, not probes, and each resolves to a named Routine, account and
authenticated session.

**`executor_account_id` is populated.** §24 records a period when it was null on
every row this Brain had ever written, so `A11_INDEPENDENT_AUDIT` read `NOT_RUN`
over genuinely independent passes. It reads `acct_70dda3fae2e1428e944b` here,
from the fire rather than from the static binding.

**The author is a party to its own audit, and is separated from it.** All three
matrix pairs applied — including `SYNTHESIS_PRIMARY` and
`SYNTHESIS_ADVERSARIAL` — at `SESSION`, which is the floor. `compliant=true`.

The same command against the project's other `AUDITING` packet,
`orc_21ca96f6328f4e0eacb7`
([run 35443854608](https://github.com/Peyday007/V5/actions/runs/35443854608),
12:48:04Z), returns **byte-identical lineage** — the same three `oat_…`
credentials in the same three roles. That is not a bug in the reading: a Cowork
session drains more than one bin, so one activation of 1-B carried the PRIMARY
role on both packets. It is worth stating because it also bounds what these two
readings prove: they attribute substantive passes to **1-B and 1-D**, and say
nothing about `Brain Research A` or `1-C`.

### Audit independence, scanned rather than asserted

`npm run admin -- packets independence cash-mode-2`, 12:42:12Z
([run 35443568410](https://github.com/Peyday007/V5/actions/runs/35443568410)):

```
No packet has a reviewer that shared a session with its author.
(Packets with no completed audit or no completed synthesis are not
 in scope: there is nothing to compare.)
ADMIN: OK
```

That scan reports and acts on nothing, and it separates *we could not tell*
from *we checked* — so this is the second answer rather than an absence of
findings. The packet it can compare is the one that reached a `PASS` verdict,
and its author is not among its reviewers.

### Queue depth at 12:30Z

| Project | Claimable now | Note |
| --- | --- | --- |
| `cash-mode-2` | 0 | round complete; one packet judged PASS |
| `cash-mode-3` | 3 (`RESEARCH_VERIFY`) | leases lapsed — see the finding below |
| `cash-mode-4` | 4 (2 `RESEARCH_AUDIT` QUEUED, 1 LEASED, 1 `RESEARCH_FRAGMENT`) | actively being fired for; a third packet's JUDGE returned `MORE_RESEARCH` at 12:12:02Z |
| `cash-mode-1` | 21 | pre-existing backlog, not created by this session |

**No further work was loaded.** Thirty substantive bins were enough, three of
the four cash operations still hold claimable work, and manufacturing a second
discovery round over questions the archive has just answered would be §13's
waste and the brief's "filler" in one move.

---

## Phase 8 — concurrency, measured rather than configured

The fleet target is **12**. The number of surfaces that can serve it is **4**,
because that is how many exist (Phase 0). So the honest reading is that the
*policy* permits twelve and the *fleet* supplies four, and the four are running
at their account's ceiling.

The measurement is Brain's own router refusing a fifth activation:

```
10:59:03.921  DISPATCH_UNROUTED  ACCOUNT_TARGETS_REACHED
11:00:04      DISPATCH_UNROUTED  ACCOUNT_TARGETS_REACHED
11:01:13      DISPATCH_UNROUTED  ACCOUNT_TARGETS_REACHED
11:02:14      DISPATCH_UNROUTED  ACCOUNT_TARGETS_REACHED
11:03:24.014  DISPATCH_ROUTED    Selected Brain Research 1-D on Brain Research A: 1/∞ Routine, 3/4 account
```

`ACCOUNT_TARGETS_REACHED` is only ever written when the account already holds
its target number of in-flight activations, so those four minutes are a
**measured** per-account concurrency of **4 of 4** — not a projection, not a
sum of declared capacity, and not inferred from a clock. §23's rule holds: a
ceiling nobody has observed reads UNKNOWN, and this one was observed.

The router's own arithmetic, quoted from four separate dispatches across the
session, shows the account filling and draining: `1/4`, `3/4`, `3/4`, `2/4`,
and `4/4` at the refusals above. Per Routine it reads `n/∞` — a research
Routine declares no per-Routine ceiling, so the binding constraint is the
account target, which is exactly where §23 says an allowance lives.

**Twelve-way concurrency was not demonstrated and cannot be**, because eight of
the twelve Routines either hold a credential the provider refuses or do not
exist. Reporting a four-way wave as a twelve-way one would be the arithmetic on
a fiction §23 forbids.

### Automatic dispatch waves, with this conversation doing nothing

Fire counters, same four Routines, two readings four hours apart:

| Routine | 08:41:41Z | 12:29:26Z | Δ |
| --- | --- | --- | --- |
| Brain Research A | 327 | 328 | +1 |
| Brain Research 1-B | 35 | 48 | +13 |
| Brain Research 1-C | 36 | 48 | +12 |
| Brain Research 1-D | 35 | 48 | +13 |

**+39 fires**, of which this conversation asked for six (the six pinned probes)
and a handful of re-probes. Every other one was `services/dispatch/loop.ts`
turning a `READY` bin into a `DISPATCH_INTENT` and then a `DISPATCH_SENT` on its
own ten-second tick.

Three of those waves were caught in the act, each naming session ids that did
not exist at the previous reading:

| Observed at | Wave |
| --- | --- |
| 12:23:13Z | `cash-mode-4` fired 12:22:43.122Z (`cse_01Y1UB3d24w5Fme3f3RZPVE6`) and 12:22:53.443Z (`cse_01Xp79gAd7rEH1iyYtfobQ3G`) — ages 30s and 20s |
| 12:29:26Z | `fleet show` reports `in flight 2`, one on 1-B and one on 1-C — different fires again |
| 12:36:00Z | the same two fires still counted, at ages 797s and 787s |
| 12:42:50Z | `fleet show` again: **counters unchanged** — A 328, 1-B 48, 1-C 48, 1-D 48, with 1-B and 1-C still `in-flight=1` |
| **12:56:24Z** | **the wave the flat reading was waiting for.** 1-C **48 → 49**, 1-D **48 → 49**, both now `in-flight=1`; 1-B's earlier activation finished and it is back to `in-flight=0`. Two new fires, dispatched while this conversation did nothing but sleep, at almost exactly the thirty-minute mark after the 12:22 fires — which is `reopenNoShowDispatches` reopening them and the router sending them to two *different* surfaces than last time ([run 35444283874](https://github.com/Peyday007/V5/actions/runs/35444283874)) |

**Twenty minutes with no new fire is a reading too, and it was reported rather
than smoothed over — and then it resolved.** Between 12:22:53Z and 12:42:50Z
the counters did not move: two activations were outstanding against a queue
whose other items were either terminal or inside a live lease. The prediction
written here at the time was that `reopenNoShowDispatches` would reopen them at
the thirty-minute mark. **It did**, and the 12:56:24Z row below is the
measurement rather than the prediction: two new fires, to two different
surfaces, with nobody watching.

Two of those waves are complete autonomous cycles rather than just fires:

- **11:33:33 → 11:34:08** — `reopenNoShowDispatches` reopened an unanswered
  dispatch, the router chose 1-D, the fire went out, a session arrived at
  11:33:55.546, submitted its unit at 11:34:06.242 and the bin was `COMPLETE`
  at 11:34:08.294. **Thirty-five seconds, end to end, nobody involved.**
- **11:59:49 → 12:21:50** — three `DISPATCH_INTENT`/`ROUTED`/`SENT` rounds
  across three different Routines and five `BIN_ASSIGNED` arrivals, every one
  of which read the bin's real blocker and released rather than inventing a
  report, ending in a truthful `NEEDS_HUMAN` with the reason on the row.

And the no-show reopen works without anybody watching it:
`bin_5922df8c521a421cb9de` was fired at 11:03:24, nobody arrived, and
`reopenNoShowDispatches` put it back at 11:33:33.800 — exactly
`IN_FLIGHT_WINDOW_MS` later — where it was refired and completed in 35 seconds.

---

## Phase 9 — every non-terminal-looking bin, explained

The brief requires that no stuck, expired, misrouted or permanently-READY bin
remains **unexplained**. Each one below is traced to rows rather than described.

### `bin_dda9ea6fd034448fa505` — NEEDS_HUMAN, 5/5, and not a no-show

`cash-mode-1`, ready 11:59:40.817Z, terminal 12:21:50.182Z. The in-flight
report prints *"no worker has checked in"* against it, which is the **current**
value of `bins.worker_id` — and `finishBin` clears the worker, the lease and
the credential in one statement (§27), so that field says nothing about whether
anybody arrived. The trace does:

```
11:59:52.029  DISPATCH_SENT   cse_01NXXDqw4zL7gxZkiaecqaK7     (1-C)
12:16:41.059  BIN_ASSIGNED    session claude-code-session_01An6qsjWED89rrv45SJurMi
12:17:00.450  BIN_ITEM_CLAIMED
12:17:47.709  BIN_ITEM_WITHHELD  NOT_CLAIMABLE
12:18:12.338  BIN_RELEASED    "Only fragment reported as BLOCKED (malformed question)"
12:18:17.618  DISPATCH_SENT   cse_013ztquUfw85LomxBJFU3dAN     (1-B)
12:18:39.457  BIN_ASSIGNED    session session_013ztquUfw85LomxBJFU3dAN
12:19:27.683  BIN_RELEASED    "Fragment frg_9ebb9c41c709467c8cfa remains BLOCKED with a garbled/templated question"
12:19:32.577  BIN_ASSIGNED    (same session, re-handed on check-in)
12:19:59.765  BIN_RELEASED    "Third consecutive confirmation that fragment … is stuck BLOCKED"
12:20:12.002  DISPATCH_SENT   cse_01JRTwnnbmYrFajr87L9QZ6K     (1-D)
12:20:30.962  BIN_ASSIGNED
12:21:21.524  BIN_RELEASED    "Fragment wki_6fa1c7f8cbad4d9c9c00 remains stuck in a LEASED state"
12:21:28.484  BIN_ASSIGNED
12:21:43.938  BIN_RELEASED    "Final retry attempt (5/5)"
12:21:50.182  BIN_TERMINAL    NEEDS_HUMAN
```

**Three fires, five arrivals, three different Routines.** Said exactly, because
the arrivals and the fires do not pair one-to-one and pretending they did would
be the kind of tidy sentence this file exists to refuse:

- the 12:18:17 fire to **1-B** produced the 12:18:39 arrival, matched on
  `cse_013ztquUfw85LomxBJFU3dAN` ↔ `session_013ztquUfw85LomxBJFU3dAN`;
- the 12:20:12 fire to **1-D** produced the 12:20:30 arrival, likewise;
- the **12:16:41 arrival was `cse_01An6qsjWED89rrv45SJurMi`**, a session Brain
  had fired at **1-B** twenty minutes earlier for `bin_4fb70d9782c141eea555`.
  It finished that bin, checked in again, and was handed this one — which is
  `checkIn`'s reassignment path working, not a reply to the 11:59:52 fire;
- the 11:59:52 fire to **1-C** has no arrival bearing its session id. It is
  neither confirmed arrived nor recorded as a no-show, because the bin went
  terminal before its thirty-minute window closed.
- two further arrivals at 12:19:32 and 12:21:28 are the same sessions being
  re-handed the bin on check-in after releasing it.

Every
worker read the state correctly, said so precisely, checkpointed and released
rather than inventing a report. That is the fleet working, and it is the same
thing §23 already records about five refused activations: *the workers were not
the defect.*

The **root condition is a malformed fragment question** in a `cash-mode-1`
access packet. Its title is a claim sentence — *"As of the June 25, 2026
article, the Fragment x Union LA x Air Jordan 1 High 'White/Black' had a
current average resale price of $783 on StockX,"* — composed as a question to
research. It predates this session by two days and is a Cash Mode question-
composition condition, not a fleet one.

### A finding this session did not fix, and says why

Underneath that bin is a narrow, real defect worth naming precisely.

`wki_6fa1c7f8cbad4d9c9c00` was claimed at **12:17:00.404Z** with a five-minute
lease expiring at **12:22:00.404Z**. The four arrivals that followed — 12:17:47,
12:18:47, 12:19:32, 12:20:38, 12:21:06 — every one of them fell **inside** that
window, so `claimWork` correctly refused to hand out a live lease and each
worker was answered `NOT_CLAIMABLE`. The bin then spent attempts 2, 3, 4 and 5
inside the same five minutes and retired at 12:21:50 — **nine seconds before
the lease it was waiting for lapsed.**

So: **a bin can burn its whole attempt budget inside one work item's lease
window.** It is the exact mirror of §23's session-refusal correction, where a
refusal outlived the moment it could stop being true; here the retry is *faster*
than the only clock that could change the answer, and Brain knows that clock's
value — it is `lease_expires_at`, on the row it just read.

The remedy needs no new primitive. `bins.dispatch_not_before` already exists for
precisely this shape: deliberately absent from `DISPATCHABLE_SQL`, so it defers
the **fire** while leaving a freshly-arriving worker free to be handed the bin
anyway. A release whose only open work is an unexpired lease should set it to
that lease's expiry.

**It is not fixed here, deliberately.** It is not what stops the fleet working —
every surface is VERIFIED, and `cash-mode-2` carried a packet to a judged `PASS`
while this was happening. It is a change to dispatch *timing*, shipped into the
dispatcher this session has just stabilised and proved, and the whole
definition of done rests on the currently deployed commit's behaviour. A second
behavioural change to the same subsystem, merged on the strength of one
production trace and no reproduction, would put a proven state at risk to fix a
throughput problem. It belongs in its own change with its own reasoning and its
own failing test first — the same call already recorded for the envelope
alphabet gap in Phase 4.

### `bin_741172668373427caada` — NEEDS_HUMAN at 3/5, and it *succeeded*

`cash-mode-4`. It did not run out of attempts; it finished its work and then
stopped at a decision that is a person's. Read from its own events:

```
11:08:56.570  BIN_ASSIGNMENT_REFUSED  session …_01FjCqh846HmBXXkDbvUKTvo  REFUSED_BY_ADMISSION
11:10:00.463  BIN_ASSIGNMENT_REFUSED  session …_01VYG9NhZVLSXg9rp95wuCoL  REFUSED_BY_ADMISSION
11:14:47.974  BIN_ASSIGNMENT_REFUSED  session …_012w2NJstQNSksXRFckiFetK  REFUSED_BY_ADMISSION
11:16:18.770  BIN_ASSIGNMENT_REFUSED  session …_012w2NJstQNSksXRFckiFetK  REFUSED_BY_ADMISSION
11:18:49.142  BIN_ASSIGNMENT_REFUSED  session …_013dASvAYJjj3yFfZ3yx2ipL  REFUSED_BY_ADMISSION
11:33:54.962  BIN_ASSIGNMENT_REFUSED  session …_013ZKCmpGT95eDTWsnKo5Tfu  REFUSED_BY_ADMISSION
11:39:07.459  BIN_ASSIGNMENT_REFUSED  session …_01HtbThgpN68yPSAw5XBZBp4  REFUSED_BY_ADMISSION
              all seven: "RESEARCH_AUDIT: JUDGE would share the same session as ADVERSARIAL"
12:09:22.018  BIN_ASSIGNED            session claude-code-session_01An6qsjWED89rrv45SJurMi
12:09:32.004  BIN_ITEM_CLAIMED
12:12:02.747  BIN_RELEASED            "JUDGE verdict recorded (MORE_RESEARCH); orchestration status is now NEEDS_HUMAN"
12:12:53.939  BIN_TERMINAL  NEEDS_HUMAN  "A person must decide: the packet is NEEDS_HUMAN, which is not a state it files a report in."
```

**Seven distinct authenticated sessions were refused the JUDGE role because
each would have shared a session with the ADVERSARIAL argument**, and the
eighth — genuinely distinct — took it and recorded a verdict. That is §23's
three-session independence floor enforced in production, seven times, against
a pooled fleet where every surface presents the same connector credential. An
independence floor that never refuses anything has not been tested; this one
refused seven times and then let the right session through.

Each refusal also cost the bin **nothing**: the admission hook is asked ahead
of the compare-and-swap, so seven refusals against a five-attempt budget left
three attempts unspent — which is §23's own correction, working, on exactly the
shape it was written for.

The bin is `NEEDS_HUMAN` because the *verdict* was `MORE_RESEARCH`. That is a
completed audit, not a failure, and the decision it waits on — widen the packet
or close it short — is one the domain reserves to a person.

### The three `cash-mode-3` items, and the three exhausted attempt counters

`wki_b85aabd3a21245fdb3d1`, `wki_390f4e356f9d49b2986b` and
`wki_d37b9c8bde2741f09678` are `RESEARCH_VERIFY`, `LEASED`, with leases that
lapsed at 09:37–09:40Z and `attempt_count` of 3 and 2 against `max_attempts` 2.

That is not a contradiction. `claimWork`'s compare-and-swap carries no
`attempt_count < max_attempts` condition — the cap is applied by `failWork`, so
an item a worker *fails* retires and an item whose lease merely *lapses* stays
claimable and can exceed its nominal budget. These three are therefore
claimable work in a project whose surfaces are busy elsewhere, not stranded
rows, and they are reachable the moment a worker is handed their bin.

### The two Caleb probe bins

`bin_f2eec76c517943d5bdf0` and `bin_09b669a94726494da139` are READY and pinned
to `Caleb 3-C` and `Caleb 3-D`, both now QUARANTINED on the provider's `AUTH
401`. A pinned bin whose only surface is out of routing is deferred rather than
fired, which is the correct behaviour and not a stall: the moment those secrets
are corrected and `fleet set-state` re-enables the surfaces, these two bins are
the first thing dispatched and the proof completes itself. They are **excluded
from every substantive metric in this file.**

### Nothing was rewritten to make any of this come out right

No production row was edited by hand, no queue was cleared, no bin was
cancelled, no evidence was deleted, no working secret was rotated and no
safeguard was removed. Every parked packet, refused claim, failed attempt and
quarantine reason in this Brain is exactly where the machinery put it.

---

## Phase 10 — the production report

All readings 2026-09-19, deployed commit
`ca6c3ebc119687470307607e13f358c2fcbc7e20`, app `northline-brain.fly.dev`.

### Account 1 — `Brain Research A` (ENABLED, `plan=Max`, target 4 / 4)

| | Brain Research A | Brain Research 1-B | Brain Research 1-C | Brain Research 1-D |
| --- | --- | --- | --- | --- |
| Trigger | `trig_01CBLu5oCZziEwznw5q9xU7g` | `trig_01TT7u3m4T6JW14vjwsK9qHm` | `trig_01QbxS8dWTcqV3zoEhx9wBen` | `trig_015aYoUwidycXymZ2xxWBC5B` |
| Routine id | — | `rtn_fbcb288d55854991bdfa` | `rtn_03d5fc5fc18344feb397` | `rtn_29cec4a75d3947c9b786` |
| Secret | `BRAIN_ROUTINE_TOKEN` present | `…_1_B` present | `…_1_C` present | `…_1_D` present |
| Bound worker | `airynworker2` `wkr_1cdd82cfb2a54faf8edd` | same | same | same |
| **Probe** | `bin_94a474cb442544ee85d0` **COMPLETE** | `bin_2b38a27698094e238b16` **COMPLETE** | `bin_8b0e06410d6d4bf1a199` **COMPLETE** | `bin_5922df8c521a421cb9de` **COMPLETE** (re-probe; the first was stolen pre-fix) |
| **Verdict** | **VERIFIED** | **VERIFIED** | **VERIFIED** | **VERIFIED** |
| Fires | 328 | 48 | 48 | 48 |
| Refusals | 2 (historical) | 0 | 0 | 0 |
| No-shows | 0 consecutive | 0 consecutive | 0 consecutive | 0 consecutive |
| Arrivals attributed | 20 | 5 | ≥1 | ≥1 |
| Non-probe bin completed | not separately identified in this window | `bin_52d91a0a243e48929772`; and its session `cse_01An6qsjWED89rrv45SJurMi` recorded the `MORE_RESEARCH` JUDGE verdict on `bin_741172668373427caada` at 12:12:02Z | not separately identified in this window | `bin_7024d12474c949129a0c`; its 12:20:11Z session worked `bin_dda9ea6fd034448fa505` |
| Latest completion in a proven chain | 08:51:06Z | 12:12:02Z (JUDGE verdict) | read at 12:34:29Z by `verify-surface` | 11:34:08.294Z |
| Verify run | [35443173917](https://github.com/Peyday007/V5/actions/runs/35443173917) | [35442542759](https://github.com/Peyday007/V5/actions/runs/35442542759) | [35443224895](https://github.com/Peyday007/V5/actions/runs/35443224895) | [35442417627](https://github.com/Peyday007/V5/actions/runs/35442417627) |

Account headroom at 12:29:26Z: **2 of 4 in flight**, 2 free. Measured ceiling
**4 of 4**, from `ACCOUNT_TARGETS_REACHED` (Phase 8).

### Account 2 — `Caleb` (ENABLED, target 4 / 4, **0 usable surfaces**)

| | 3-A | 3-B | 3-C | 3-D |
| --- | --- | --- | --- | --- |
| Trigger | `trig_016dyf9oueMd7zQLY2pGrQFt` | `trig_012DkgiTnPr799Le6iL4HEPt` | `trig_016yNPUw8BpoiYa5S8tU3bG3` | `trig_01YAGrc58yyaYXHh4Zpfrvzt` |
| Secret | `…CALEB_3_A` | `…CALEB_3_B` | `…CALEB_3_C` | `…CALEB_3_D` |
| State | QUARANTINED | QUARANTINED | QUARANTINED | QUARANTINED |
| Fires / refused | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| Probe | — | — | `bin_f2eec76c517943d5bdf0` READY, never fired | `bin_09b669a94726494da139` READY, never fired |
| Provider condition | `AUTH 401` `req_011CfByZEUhHGkUCLMxsiGoE` 02:03:01Z | `req_011CfBym2TiQoudqLrT2PJpC` 02:05:41Z | `req_011CfCWoygitxXsnxBrRiUNU` 08:52:52Z | `req_011CfCWrvrA7bYjiFNSy3ZjS` 08:53:32Z |

All four: `{"message":"Token is not authorized for this routine","type":"authentication_error"}`.

**This is a provider/credential condition, recorded as one.** It is not a Brain
defect, not a capacity limit and not a rate limit. Brain fired each surface
exactly once, quarantined it by name at the first `AUTH`, stored the provider's
own words on the row, and spent nothing further — which is §23's rule working.
`calebworker1` holds 46 minted OAuth tokens with 23 used, so Caleb's
**connector** authenticates to Brain correctly; it is the four **trigger**
bearers Brain fires *with* that are wrong.

### Account 3 — `Airyn`: **does not exist**

No `fleet_accounts` row, no `fleet_routines` row, no bound worker.
`airynworker1` is ARCHIVED with zero projects; `airynworker2` is account 1's
worker and its name is a historical artifact. Four of the twelve Routines have
never existed in this Brain.

### Fleet totals

| Reading | Value | Evidence class |
| --- | --- | --- |
| Accounts registered | 5 (3 excluded by name: `friend-2`, two `verify-hosted` fixtures) | row |
| Accounts in the mission's scope | 2 of 3 registered, 1 usable | row |
| Routines registered | 13 (5 excluded: 2 retired `V1-oak`, 1 quarantined `V2`, 2 fixtures) | row |
| Routines in the mission's scope | 8 of 12 registered, **4 usable** | row |
| Fleet concurrency target | **12** | policy row, set 08:48:23Z |
| Fleet concurrency achievable today | **4** | derived from usable surfaces |
| Per-account concurrency target | 4 (both accounts) | policy row |
| Per-account concurrency **observed** | **4 of 4** | MEASURED — `ACCOUNT_TARGETS_REACHED` ×4 |
| Per-Routine ceiling | `∞` (research Routines declare none) | router output |
| Fires in the session window | **+41** (08:41:41Z → 12:56:24Z: A 327→328, 1-B 35→48, 1-C 36→49, 1-D 35→49) | counter delta |
| Refusals in the session window | **2**, both Caleb (`3-C` 08:52:52Z, `3-D` 08:53:32Z). `3-A`/`3-B`'s pair was written at 02:03/02:05Z, before this window; account 1's `refusals=2` is older still and unchanged across both readings | row |
| No-shows | **one event**, on `bin_5922df8c521a421cb9de`'s 11:03:24Z fire, reopened at 11:33:33Z and completed. Every `fleet show` row reads `no-shows=0` because that counter is *consecutive* and resets on the next arrival — the two facts agree | row |
| Remaining queue depth | 28 claimable items across `cash-mode-1/3/4`; `cash-mode-2` drained | queue read 12:30Z |
| Deployed commit | `ca6c3eb` | [run 35440403377](https://github.com/Peyday007/V5/actions/runs/35440403377) |
| Fleet state at the last reading | 2 of 4 in flight (1-C, 1-D), 1-B and A free | `fleet show` 12:56:24Z |
| Provider-capacity condition | **none on account 1** — no rate limit, no `429`, no `PROVIDER_ENFORCED` refusal anywhere in the window | row |

### Against the definition of done

| Required | Status |
| --- | --- |
| 3 accounts, 12 eligible Routines inventoried | **inventoried, and 2 accounts / 4 Routines is what exists** |
| Targets permit 4 per account and 12 fleet-wide | **done** |
| 12 fresh pinned probes, all proven | **4 of 4 provable surfaces proven; 8 not provable** |
| Fresh twelve-way wave, observed concurrency 12 | **four-way wave, observed concurrency 4 of 4** |
| Every Routine completes substantive research | **partial, and said precisely.** All four are VERIFIED end to end on Brain's own four-row chain. Two — 1-B and 1-D — additionally hold a *non-probe* completed bin identified in this window, and 1-B recorded a judged audit verdict. For `Brain Research A` and `1-C` the chain I can point at in this window is their pinned probe; both have been carrying substantive research for weeks (A: 328 fires) but I did not isolate a specific non-probe bin id for them, and I am not going to claim one I did not read |
| ≥2 automatic refill waves, no chat involvement | **done** — Phase 8 |
| Outputs, sources, evidence and lineage persisted | **done** — 75 claims, 1 filed document, 2 judged audits (`PASS`, `MORE_RESEARCH`) |
| Failed/stale probes excluded from substantive metrics | **done** |
| No unexplained stuck/expired/misrouted/READY bins | **done** — Phase 9 |
| Continuing queue work, or documented exhaustion | **done** — 28 items |

**Four of the twelve are proven and working. Eight are blocked on two actions
only a person holding those Claude accounts can take.**

---

## What is blocked, and on whom

Two things, both genuinely human-only, both outside what any credential in the
deployed environment can reach.

### 1. Caleb's four deployment secrets hold the wrong bearer

`BRAIN_ROUTINE_TOKEN_CALEB_3_A` … `_3_D` are set — they are not missing, and
`fleet show` would say `MISSING SECRET` if they were. Each holds a value the
provider rejects for the trigger it is registered against, four times, in the
same words.

Correcting one means reading a Routine's bearer out of the Claude account that
owns it, which is behind that account's own login. Nothing in this repository
can read a deployment secret's value back — `fleet_routines` stores a sha-256
digest and the *name* of the variable, deliberately — and nothing here should
be able to mint one.

**Where:** Claude account "Caleb" → each Routine's connector, then
`fly secrets set` on `northline-brain` (or the repository's deployment secret
store), then `fleet set-state --kind routine --ref <trig_…> --to ENABLED`.

**Then:** the two probe bins already waiting (`bin_f2eec76c517943d5bdf0`,
`bin_09b669a94726494da139`) are fired within one ten-second tick, and 3-A/3-B
need one `fleet verify-surface --probe` each. No code change, no deploy.

### 2. Airyn's account and four Routines do not exist

Creating a Claude Routine requires that account's own session. Registering it
afterwards is two operator commands per surface and needs no deploy:

```
fleet register-account  --name Airyn
fleet register-routine  --account Airyn --name "Airyn 4-A" \
                        --ref trig_… --secret BRAIN_ROUTINE_TOKEN_AIRYN_4_A
fleet bind-worker       --ref trig_… --worker <a worker Brain issues>
fleet set-target        --kind ACCOUNT --ref Airyn --to 4
```

**Neither is a Brain defect and neither is a capacity limit.** With both
resolved, the fleet reaches twelve surfaces and the target of 12 already set in
policy becomes reachable without any further change to this repository.

---

## Phase 11 — four refusals closed four cells of sixteen, and I read them as sixteen

The report above said Caleb's four deployment secrets "hold a token that is not
authorized for the trigger it is registered against" and sent that to a person
as *regenerate these four bearers*. **The evidence did not support the
conclusion, and the correction is recorded rather than quietly applied.**

What the four `AUTH 401`s establish is exactly four facts:

```
Caleb 3-A  x  BRAIN_ROUTINE_TOKEN_CALEB_3_A   refused
Caleb 3-B  x  BRAIN_ROUTINE_TOKEN_CALEB_3_B   refused
Caleb 3-C  x  BRAIN_ROUTINE_TOKEN_CALEB_3_C   refused
Caleb 3-D  x  BRAIN_ROUTINE_TOKEN_CALEB_3_D   refused
```

Four triggers against four secrets is a **sixteen-cell square**, and those are
its diagonal. The provider's own words say `Token is not authorized for this
routine` — *this* token, *this* routine — so each one closes one cell and says
nothing whatever about the other twelve. Four bearers registered in the order
somebody wrote them down, paired wrongly, produce precisely this reading. A
fleet can be one relabelling away from working while every row in it reads
permanently broken, and the only way to tell is to ask.

This is the same defect this file records at four other altitudes: **the
evidence was right and the sentence about it was wrong.**

### What was built, and what it refuses to do

`server/services/dispatch/secretReconcile.ts` walks the rest of the square.

- **One cell at most once, ever.** Every attempt is an append-only
  `identity_events` row, so a second run costs nothing, a crashed run resumes,
  and a decided cell is never paid for twice.
- **A match locks on both axes.** Its trigger and its secret both leave the
  space, which is what makes this a one-to-one reconciliation rather than n²
  probing: four triggers cost at most ten further fires and in practice fewer.
- **The four existing refusals are seeded from the rows themselves** — a
  `QUARANTINED` Routine carrying a recorded `AUTH` reason was refused while
  registered against the secret its row names — and written into the durable log
  *before* any repoint, because afterwards the row names something else and its
  reason is about a pairing that no longer exists.
- **A rate limit, a 5xx or a dead connection closes nothing.** Recording one as
  *this bearer does not open this door* would burn a true pairing out of the
  space permanently on a bad minute. They stop the search for that trigger and
  are reported as inconclusive: §30's rule that *we could not tell* must never
  read the same as *we checked*.
- **It re-enables nothing.** A quarantine is a health state a person answers
  with `fleet set-state`, and a diagnostic that lifted its own would be grading
  its own exam. `tests/secretReconcile.test.ts` asserts every surface is exactly
  as quarantined afterwards as it was before.
- **No secret value reaches anything.** The bearer is resolved from the
  environment by name into `fireRoutine`'s one `Authorization` header and
  nowhere else; the audit rows carry the secret's *name*, the outcome and a
  twelve-character digest prefix. Two tests assert the values never appear.

`fleet set-secret` is the answering transition for a proven pairing — the
companion to `set-capabilities`, and for its reason: a row that has become
wrong, with no remedy but manual SQL, which invariant 2 forbids. It moves no
Fly secret and reads no value back.

`fleet check-secret` answers `present` or `absent` for a named variable and
nothing else — not a length, not a prefix, not a digest. A boolean about a
secret is not a secret; anything that narrowed the value would be.

### The cost, said rather than glossed

There is no way to ask the provider *would this token work* without using it, so
proving a pairing costs one activation on the account that owns it — at most one
per trigger, and only on the pairing that is correct. A fire Brain sends carries
no text (§22), so such a session authenticates, checks in, and is handed
whatever `calebworker1` is entitled to, or nothing.

Pinning a probe bin at it first would be worse rather than better: a pinned bin
is answerable only by the session Brain's own dispatcher fired at that Routine
(Phase 6), and this fire is deliberately outside the dispatcher, so the bin
would be refused by the very guard that makes pinning meaningful. The honest
order is **reconcile, then re-enable, then prove through the dispatcher** with
`verify-surface --probe`, which is the four-row chain that actually establishes
a surface works.

### Two guards were run against a neutered build first

Because a regression test nobody has seen fail is a claim rather than a reading:

- making an inconclusive outcome eliminate a cell fails
  *"records a rate limit as nothing learned, and closes no cell"*;
- removing the locked-secret check fails
  *"never offers a cell twice, and locks a match out on both axes"*.

## Phase 12 — Airyn: the worker does not exist, and the rows say why

The report above said Airyn's account "does not exist" and asked for four
Routines to be created. Read properly, that was half right and the expensive
half was wrong.

`admin people list` at 13:36:08Z:

```
usr_72e1236be8f04f4d9aa2  PERSON  MEMBER  passkeys=1  signs-in=device  Airyn
```

**Airyn is an enrolled member of this Brain and can sign in with a device.**
So the journey §34 and §35 built for exactly this is available to her, and the
missing piece is narrower than "an account".

`admin workers list` at 13:26:48Z returns ten identities and **not one of them
is a new Airyn worker**:

```
airynworker1   wkr_80f386d4d53d4679bf1a  ARCHIVED  0 project(s)
airynworker2   wkr_1cdd82cfb2a54faf8edd  ACTIVE    8 project(s)
calebworker1   wkr_1db1193323454ee69bb1  ACTIVE    3 project(s)
deal-dispatch, factory-brain, verification-worker ×5
```

So the answer to *did Airyn's connector authorization mint a distinct worker* is
**no**, established from rows rather than assumed.

**`airynworker2` must not be reused for this, and its name is a trap.** It is
Account 1's worker — the identity all four `Brain Research A / 1-B / 1-C / 1-D`
surfaces are bound to, holding membership on eight projects. Binding Airyn's
Routines to it would produce four more surfaces that resolve to one worker, so
an audit run across them would read `SESSION_SEPARATED` and never
`WORKER_SEPARATED` or `ACCOUNT_SEPARATED`, and the second capacity bucket Airyn
is supposed to be would be a relabelling of the first. §23 is explicit that a
same-account result is never described as cross-account independent; a
same-*worker* one must not be either.

`namesFor(usr_72e1236be8f04f4d9aa2)` derives what her connection will mint:

| | |
| --- | --- |
| worker | `research-airyn-72e123` |
| connector | `Brain (Airyn)` |
| Routine | `Brain Research — Airyn` |
| its own secret | `BRAIN_ROUTINE_TOKEN_AIRYN_72E123` |

That worker does not exist yet, which is the whole of what is missing.

**She does not need to recreate her four Routines.** The four `trig_…`
references and the four `BRAIN_ROUTINE_TOKEN_AIRYN_2_*` deployment secrets are
already made; what they lack is a Brain-side identity to be bound to. Once
`research-airyn-72e123` exists, registering the four existing triggers against
the four existing secret names is `fleet register-routine` ×4 plus
`bind-worker` ×4 — an operator path, no browser, no deploy.

**And the invitation cannot be issued into a workflow log.** An invitation token
is a single-use credential, and §17 admits no credential in a log. The surface
that issues one shows it once, in a browser, to somebody signed in — which is
`issueConnectorInvitation` on her own connection page. That is why this one step
is a person's and is not a limitation of the operator surface.
