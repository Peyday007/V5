# Factory run record — 2026-09-25, Airyn-first

This records one operator session. It is not project state: Brain is
authoritative, and every claim below names the reading or code location it
comes from.

## Routing override (temporary, still in force)

- **Change:** `fleet set-target --scope ROUTINE --ref trig_01JN1h6UdhvR3bMpWFvaRbD2 --target 0`
  — Factory surface 1, under account *Brain Research A*. This is policy
  version 1 for that Routine (actor `operator:fleet-cli`, 2026-09-25T17:58:09Z),
  with the reason recorded on the row.
- **Read back:** `factory allocation` → `next task -> Airyn`, *Selected Factory
  surface 2 on Airyn*.
- **Airyn's surface:** `verify-pool` reports PROVEN (it completed
  `bin_ed2fd51d47fb46c29670`).
- **Scope:** no lease was touched and no research routing was changed.
- **This is Airyn-only, not Airyn-first-with-fallback.** The router has no
  preferred-account setting. Its only other ordering input is a person's
  allowance report, and it would be false to enter one that nobody made.
- **To remove:** run the `Fleet` workflow with `set-target`, `scope=ROUTINE`,
  `ref=trig_01JN1h6UdhvR3bMpWFvaRbD2`, `target=4`, and a reason. Before the
  override the Routine had no Routine-level policy and was bounded by its
  account target of 4, so this restores the old behaviour.

## Unfinished code builds in V5 — inventory

This lists software builds only. Research backlog was used as evidence and is
not counted as a build. Sources: three read-only code surveys, `cash-report`,
`goals show`, `capability packets`, `fleet show`, and a direct reading of the
cited files.

| # | Build | Health | What is missing (code) | Magnitude | Disposition | Factory now? |
|---|---|---|---|---|---|---|
| 1 | Ideas map privacy | broken (live) | `ideaMapForProject` (russell/ideas.ts) lists every candidate. `requireCandidate` (routes/russell.ts:199) refuses PRIVATE ideas from threads the caller cannot read. The map therefore shows other members' private idea titles and statements. | small | FINISH | **yes — objective filed** |
| 2 | Work-register attestation integrity | broken (live) | The link route stores the caller's `detail`. `readAttested` trusts `attestedBy/attestedAt/merged/verifiedLive` from it (register/resolve.ts:333), so anyone with write access can make a workstream read VERIFIED_LIVE and a goal read delivered. | small | FINISH | **yes — objective filed** |
| 3 | Atomic kernel round opening | broken (latent) | Six places create a Russell candidate and then insert a round with `ON CONFLICT DO NOTHING`. A losing insert leaves a paid, launched candidate that no round reads: industry, manufacturing, dealflow, puzzle and labor `expand.ts`, plus cash discovery. | small–medium | FINISH | **yes — objective filed** |
| 4 | Bridge bearer authority scope | working, over-broad (security) | A `brnc_` key resolves to a full HUMAN principal with every project role (authenticate.ts:276). It can therefore approve Factory objectives and releases, grant authority, and issue site credentials. | small | NEEDS DECISION (which routes a chat key may reach) | no — `server/services/identity/**` is forbidden to Factory; a person must make this change |
| 5 | Cash: the "Brain acts" branch records unperformed effects | broken (latent) | `advanceWithinAuthority` (cash/operate.ts:636) writes `performedBy: BRAIN, "Reached …"` as soon as a capability reads PRESENT, with no external call and no `services/effects` receipt. That violates invariants 25–26. It is latent only because all five integrations read MISSING. | medium | FINISH | yes (needs a `perform` hook plus UNCERTAIN handling) |
| 6 | Cash: commercial actions after execution | partial | `recordAction` has one caller: the first action inside `beginExecution`. `QUOTE_AND_INVOICE` and the others cannot be recorded later, so dealflow's QUOTING stage is unreachable. | small–medium | FINISH | yes |
| 7 | Cash: controls missing for existing server routes | partial | No client calls commit/settle a spend commitment (routes/cash.ts:955, 992), `reoffer`/`exhaust`/`archive` (:847–895), or monetization SEED/LINK/MERGE/UNMERGE/SPLIT/compare (:1653, :1939–2028). LINK is the only writer of a blocking edge. | small each | FINISH | yes (one objective per group) |
| 8 | Bridge UI | partial | Every bridge route exists; `BridgeApi` (registerApi.ts:95) has no caller. The docs tell the owner to mint a credential with a raw POST. | small | FINISH **after #4** (a UI minting over-broad keys amplifies #4) | blocked on #4 |
| 9 | Russell: ideas parked for missing authority never resume | partial | `unjudged()` requires `priority IS NULL` (russell/loop.ts:2770). Only Cash and the person-override path re-judge. Recorded in STEP-12B-BACKLOG.md:311. | small | FINISH | yes |
| 10 | Fleet auto-scale switch | broken (declared, unreachable) | `fleet_policy.auto_scale` is written. `proposeScale` is read only by `fleet scale-advice`, which prints. The dispatch loop never applies it. | medium | NEEDS DECISION (wire it, or refuse the flag) | no |
| 11 | Kernel operator surfaces (puzzle, industry, dealflow, design) | partial | Routes exist under `/cash/{puzzles,industries,dealflow}`, but no client calls them; the design kernel has no route. Labor and Machines already closed this same gap. | medium each | FINISH (puzzle first) | yes |
| 12 | Capability realization state mover | partial / stalled | `packet.advance` has no production caller, so every packet stays DRAFT for ever. Gap readings are terminal-only. | medium | NEEDS DECISION (terminal semantics are explicitly undecided, §37) | no |
| 13 | Research Intelligence reader | working, no reader | `GET /research/:id/intelligence` is read only by verify-hosted. | small | FINISH | yes |
| 14 | PR #36 — software change delivered back into the conversation | coded, unmerged | The Authorize card sent no acceptance conditions, so every Authorize was refused. Its fix and delivery-back live on the branch. | done (review + merge) | NEEDS DECISION (person merges) | n/a |
| 15 | PR #37 — human work coordination | coded, unmerged | Migration 094 / pg 085 collides with production; section number collides with #36. | small (renumber) + merge | MERGE after #36 | yes (renumber) |
| 16 | PR #35 — puzzle kernel production fixes | coded, unmerged | `puzzle_rounds_unique` keys on nullable columns (the defect is still in production at 089:511); migration number collides. | small | FINISH (port) | yes |
| 17 | PR #23 — commerce kernel | abandoned | 4,400 lines on a branch with no merge base; overlaps Cash and monetization. | large | NEEDS DECISION (default PAUSE) | no |
| 18 | In-process provider research path | superseded in production | orchestrator/queue/runDynamicAudit/findings are reachable only with a provider, which production lacks. | — | NEEDS DECISION (keep for local mode or delete) | no |
| 19 | Puzzle typesetting | missing | Every physical route is behind `TYPESET_FOR_PRINT`. | medium | NEEDS DECISION (output format, PDF library) | no |
| — | PR #3, PR #30 | superseded | Branches with no merge base. #30's one unique fix is folded into #3 above. | — | KILL | — |

### Priority order and why

1. **#1 ideas-map privacy.** A live leak of other members' private content in a
   Brain that now has several members. The rule already exists one route over,
   so nothing is invented.
2. **#2 register attestation.** A live integrity hole in the control plane that
   is meant to become the first-class build and goal record. A goal can read
   delivered on a typed claim.
3. **#3 atomic kernel rounds.** A latent correctness defect that spends research
   allowance on questions whose answers are discarded. It unblocks trust in six
   kernels at once.
4. **#5, #6, #7** Cash code (honest effects, then later actions, then controls).
   Their current leverage is limited: production has 0 of 40 openings
   qualified, so there is nothing ready for these controls to act on yet.
5. **#9, #11, #13, #16**, then the NEEDS DECISION items.

**Decisions only the owner can make:** #4 (bridge key scope — the most severe
item, outside Factory's permitted paths), #10, #12, #14 (merge PR #36), #17, #18
and #19.

## Factory state

| Time (UTC) | Event |
|---|---|
| 09-25 20:27–21:00 | Deploy 351 released `acbe345`; the post-restart proof passed |
| 09-26 01:19 | `factory submit` of objective #1 created `fcr_8390e40c3ea14eceb22b`, pinned to `acbe345`, project Deal Dispatch |
| 09-26 01:21 | Approved under the owner's standing authorization; this created campaign `fcp_11e2e481b79d4a948049` |
| 09-26 01:23 | Plan bin `bin_9bf63d096c0d45c4ab36` was fired at **Airyn's Factory surface 2** (`trig_01H6Ngiv7NbPjva5mtz2zPWD`). Session `cse_0156a7HaFqipzXdFSu4p6cCg` arrived and holds the lease (gen 1) |

| 09-26 ~01:50 | Units bin `bin_ea21df767f104e04b5f2` exhausted its attempts. Airyn's surface committed twice and never pushed: no `factory/fcp_11e2e481…` branch reached origin. Surface 1 was at target 0 under the override, so nothing else could take it |
| 09-26 ~02:10 | Override narrowed rather than dropped. Surface 1 was restored to target 4. Airyn's capabilities went to `repository` only (it may still review; it cannot be sent a push bin), with the reason recorded on the row. The bin was answered `surface-blocked`, raising its ceiling to 4 |
| 09-26 02:19 | Objective #2 was submitted and approved, creating campaign `fcp_8878eedce08547b382af` |
| 09-26 02:31 | `ae510f8` (the factory line) went to production; Deploy 352 dispatched |

## The autonomous-loop fault (Phase 1)

**What stopped the first build** was not the Brain-side stage loop. A completed
bin already ticks its campaign and dispatches what that creates, with a 20 s
remote tick as the fallback. The stop had two causes:

1. **A surface that could not push.** Airyn's surface was the only
   write-capable target under the override, and it could not push. Each
   release of the units bin still spent an attempt, so the bin exhausted and
   the stage parked at NEEDS_HUMAN.
2. **Nothing between campaigns.** When a campaign finished or parked, nothing
   started the next approved objective. Somebody had to run `approve`, and in
   practice that somebody was a reminder in this session.

**Fixed in code:**

- `ae510f8`: the factory line.
  - A queue entry is a person's approval given in advance (`factory queue`).
  - Admission runs on the remote loop's own tick. It starts queued objectives in priority order while fewer than the admission limit are working (default 1; `factory admission --max-active N`).
  - BLOCKED, AWAITING_RELEASE and COMPLETE campaigns hold no slot, so a PR waiting for a merge does not idle the line.
  - Executable work beside a free surface with nothing leased or arriving for 2 min is written to the ledger as `FACTORY_IDLE_STARTED`, and closed with `FACTORY_IDLE_ENDED`.
  - `factory burnin` reads per-stage executable, fired, arrived and completed timestamps back from `bin_events`.
- `b68f19a`: a working-state campaign whose only stage bin is parked at NEEDS_HUMAN now holds no slot either. Build opens with the production line panel.

**Still open:**

- **Surface failures still spend bin attempts.** A release caused by a surface failure still charges an attempt. Worse, the router may fire the same failing surface again, because nothing yet routes a retry away from the surface that just failed it. This is the next loop defect.
- **Needs You (owner): grant Airyn's Factory surface push access to Peyday007/V5.** Then restore `repository-write` on `trig_01H6Ngiv7NbPjva5mtz2zPWD`. Until then Airyn reviews and surface 1 writes.

Next up: #3 (atomic kernel rounds) goes in the queue once the line is live, so
it starts by itself when a slot frees.
