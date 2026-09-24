# Four-account fleet — software acceptance, and what only people can finish

**What this is.** The acceptance and defect-closeout pass on the four-account
fleet software, taken against the production tip `533463f3` (which already
contains the fleet integration through `ba5c0b2f`). It separates two things
that must not be read as one: whether the *software* is complete, and whether
four *real* Claude accounts have been commissioned. The first is settled here.
The second has not happened, and nothing in this file claims it has.

**The four people.** The owner, friend 1, friend 2, friend 3 — four Claude
accounts, four identity boundaries.

`docs/FLEET-FOUR-ACCOUNTS-HANDOFF.md` is the earlier lane's record and still
stands. Its §8 is now the record of the release (deploy 323, `901a42db`) and its
§9 records this lane and qualifies its own §8.4 eligible count by D2 below —
the deployed `routeBin` cannot subtract a surface whose bound worker is
disabled, so that count can only overstate until this lands.

---

## 1. What was found, and fixed

The lane proved one worker identity served by several accounts. The four people
this fleet is for each hold their *own* connector, so their own worker — and
testing that shape found four defects of the lane's own class: correct
machinery, a false sentence about it. Each was reproduced first; each
regression was run against the unfixed code and seen to fail.

| # | Defect | Where | Regression |
|---|---|---|---|
| D1 | `capacityReading` counted any routing *candidate* (= secret deployed) as eligible. A **QUARANTINED** surface with an old proof read **HEALTHY**; a disabled account, a disabled worker and an archived one all counted as capacity the router would never fire. | `services/fleet/capacity.ts` | `fleetFourAccountAcceptance` — *a surface out of routing is never counted as capacity* (4 cases) |
| D2 | A Routine bound to a **DISABLED** worker was routable. Archiving revokes memberships so it was already refused; disabling keeps them, so each fire went to a session certain to be refused at sign-in, until three no-shows quarantined it. | `services/dispatch/router.ts`, `candidates.ts` | *never fires a surface whose bound worker is disabled, and fails over to the others* — six decisions rotate across the three others, never the fourth |
| D3 | An arrival was credited to whichever Routine the bin was fired at, **whoever arrived**. A friend's session that finished its own bin and took the next one — fired at another person's Routine — was written into `worker_sessions` under the **other person's account**, first observation winning for ever. That is the lineage `executor_account_id` and every audit separation tier is read from. The same happened for a pooled worker's sibling account (per-account connector ⇒ per-account credential). | `repos/bins.ts` `creditDispatchArrival` | *an arrival is credited to the surface that actually sent it* (3 cases) and *a pooled Factory worker is still four accounts* |
| D4 | Three more readers of "usable" disagreed with the router: the Fleet page (`usability`) never asked about the deployed secret, the bound worker or its project; `verify-pool` let a past proof stand over a **disabled** worker (it named archived only); `separationCapacity` counted a quarantined **account**, and a worker id resolving to no worker, toward account separation. | `services/fleet/view.ts`, `lab.ts`, `dispatch/pool.ts`, `research/auditAdmission.ts` | *three readers of "usable" give one answer*; `factoryPool` *does not let a past proof erase a disabled worker either*; `adaptiveSeparation` *does not count an account out of routing, or a worker that cannot authenticate* |

**The shape of the fix.** `surfaceIneligibility` in `router.ts` is now the one
bin-independent answer to *could this surface take work at all* — account and
Routine ENABLED, bound to a worker that can authenticate, that worker holding a
project. The router asks it first; the capacity reading and the Fleet page ask
the same function. The arrival rule is fail-closed: a different identity is
credited only when its reported provider session matches the one Brain fired;
two named sessions that differ are never credited; unknown stays uncredited.
Nothing about the assignment itself changed — who may *take* a bin is the
admission decision it always was, and `BIN_ASSIGNED` still records who did.

**Fixtures corrected, not weakened.** Four fixtures described shapes production
cannot produce and passed only because of D1/D3/D4: a Routine bound to a worker
id that is not a worker row (`adaptiveSeparation`, `laborKernel`,
`laborFrontierAudit`), a worker with no project membership counted as capacity
(`cashOpportunityStandard`), and a "first arrival" that was a stranger to the
Routine's bound worker (`fleet`). Each now uses the real shape; no assertion
was loosened.

**No schema change. No workflow, deployment or policy file touched.**

### 1a. The second pass — integration, and the whole Factory path

Integrating onto production `d59a46a` (a clean merge: nothing this lane touched
had moved) and then walking the whole hosted Factory path for several people at
once found seven more. Same class, same treatment: reproduced, fixed, regression
seen to fail on the unfixed code.

| # | Defect | Where | Regression |
|---|---|---|---|
| D5 | Five more readers answered "can this surface run work" from a Routine's state column: a goal's blocker told a person the dispatcher *would* route to an ENABLED surface bound to a disabled worker; Who (and Home's capacity line) called it **Healthy** and the project **READY**; a member's contributed capacity counted it **usable**; Build → Repositories read **READY** over a disabled worker, an unavailable account or a missing secret; the cowork executor probe and the self-model's CONNECTED likewise. All now read `routingRefusalByRoutine`, a per-Routine view of `surfaceIneligibility` that also answers for a missing secret. | `goals/model.ts`, `russell/who.ts`, `capacity/contribution.ts`, `factory/onboard.ts`, `executors/cowork.ts`, `selfmodel/observe.ts` | `goalOwnership`, `readLayer`, `claudeConnectionLifecycle`, `factoryOnboarding` |
| D6 | **Concurrency.** A dispatch tick that lost a fire slot to a concurrent dispatcher kept routing the rest of its burst at the same surface from its stale snapshot and lost every time. Two ticks over eight bins and four idle accounts: the losing tick fired **none** of its five, and one account was never reached. | `dispatch/loop.ts` | `fleetFourAccountAcceptance` — *four accounts at once* (racing ticks, four simultaneous arrivals, one hand-over per bin, no cross-credit, four concurrent completions) |
| D7 | A reviewer that reported no `session_ref` was admitted on the dispatched session and then refused at ingest for "recording no session", because the lease stored only the reported value. The bin was COMPLETE, which the stage ceiling never counted, so a fresh review bin was **fired every tick** and one more `UNIT_REFUSED` row written per old bin per tick. An implementer omitting it was absent from the set its reviewer must be independent of. | `repos/bins.ts`, `factory/remoteLoop.ts` | `factoryExecutionPlane` — *records the fired session on the lease*; *a review Brain refused spends the stage* |
| D8 | A worker's empty `brain_check_in` ticked **every** live campaign in the Brain (and the outcome pass, with its forge calls) inside that worker's MCP call; `brain_bin_complete` fired a fleet-wide dispatch. One person's call paid for everybody's under a client timeout Brain does not choose. | `bins/service.ts`, `factory/remoteLoop.ts` | `factoryExecutionPlane` — *an empty check-in derives only the caller's campaigns* |
| D9 | A second person asking for the same change in their own thread was handed the first person's software request: told it was "already waiting", with the card, the authorization and the pull request in somebody else's (possibly private) thread. Now one card per thread, authorized onto one shared change request and campaign. | `russell/software.ts` | `russellSoftwareJourney` — two tests |
| D10 | A registered fleet whose deployment secrets were all missing read as "nothing registered" and fired every bin — anyone's — at the environment Routine with no router, scope or fire slot. | `dispatch/loop.ts` | `fleet` — *does not fire the environment trigger when every registered secret is missing* |
| D11 | Two people's live campaigns could both continue one open pull request's head branch, each moving the other's integration base. A second one now opens its own branch. | `factory/remote.ts` | `factoryExecutionPlane` — *does not let a second live campaign write onto the branch another continues* |

One residual is stated rather than hidden: D11's check runs before the campaign
row exists, so two approvals in the same instant can both pass it; closing that
for good needs the repository on the campaign row — a schema change, not made
here.

---

## 2. Software verdict

| Requirement | Verdict |
|---|---|
| **1. Account model** — four distinct accounts at once; stable unique identity (`UNIQUE (provider, name)`, unique `routine_ref`, secret name and token digest refused on reuse); Routine/account/worker identity cannot silently cross (`bindRoutineWorker` refuses overwrite, `repoint` is guarded and audited); state persists; disabled / archived / uncommissioned / unhealthy / unavailable represented truthfully | **PROVEN**, with **DEFECT FIXED** D1/D4 for *truthfully represented* |
| **2. Routing** — only eligible accounts; never busy (targets), disabled, rate-limited, mismatched (family / repository / project / capability) or unavailable; deterministic and explained (`considered[]`, pure over a snapshot); assignment persisted (`bin_dispatch.routine_id`, `DISPATCH_ROUTED`); session attributed to the account that performed it | **PROVEN**, **DEFECT FIXED** D2 (disabled worker) and D3 (attribution) |
| **3. Capacity** — whole pool; one account's health never the pool's; archived/bound worker cannot widen it; configuration ≠ proven (`CONFIGURING` vs `HEALTHY`, `UNPROVEN` vs `PROVEN`); partial availability stays usable | **DEFECT FIXED** D1/D4, now **PROVEN** — *three readers give one answer* holds the page, the reading and the router to the same single surface out of four |
| **4. Failover** — busy (target), refused (rate limit ⇒ `retry_at`, not misconduct), no-show (`DISPATCH_NO_SHOW` ⇒ quarantine at 3, forgiven only on the way out), unhealthy (AUTH/NOT_FOUND/PAUSED ⇒ quarantine that surface, burst continues, bin not charged), unavailable, capability mismatch (`NO_CAPABLE_SURFACE` is per-bin, not fleet-wide), multiple eligible (headroom, then least-recently-fired) — without duplicating a job (one intent per bin×generation, fire-slot CAS), losing ownership (lease generation fencing), double-charging (surface refusals do not charge the bin; eligibility before accounting), switching identity mid-session (session = authenticated credential) or stranding work (deferrals re-armed by fleet writes) | **PROVEN** (`factoryPool`, `dispatchAuthQuarantine`, `dispatchDeferral`, `admissionAccounting`, `exhaustedBinLifecycle`, `fleet`) and **DEFECT FIXED** D2 (fail over *away from* a disabled worker) |
| **5. Isolation / security** — secrets are names + digests and cannot collide silently; account A not mistaken for B (D3); session ownership enforced (fencing, per-credential session, pinned probes answerable only by the fired session); per-account state stays per-account (no-show ledger per Routine); wrong / guessed credentials fail with one refusal; one user's credentials cannot reach another project's work (`claudeConnectionParity`, `projectRouting`, `workerRoutingBoundaries`, `cashFourAccounts`) | **PROVEN**, **DEFECT FIXED** D3 |
| **6. Operator truth** — `fleet show`, `verify-surface`, `verify-pool`, Fleet page, People / capacity, Build card, lab health | **DEFECT FIXED** D1/D4; the rest **PROVEN** by the lane's own guards |
| **7. Production-current proof** — the puzzle/kernel merge (`ba5c0b2..533463f`) touched no fleet, dispatch, bin, routing, identity or capacity file; its only migrations are `089` / pg `080` (`puzzle_kernel`), additive, after the fleet's `088` / `079` | **PROVEN** — see §3 |
| **8. Real accounts** | **HUMAN COMMISSIONING REQUIRED** — §4 |

---

## 3. Evidence

Every figure is from a run on the tree named beside it. The local runs used
Node 22.22.2; the local Postgres cluster was PostgreSQL 16 with
`max_locks_per_transaction = 1024`.

| Gate | Tree | Result |
|---|---|---|
| Fleet-related suites, SQLite, **before any change** | `533463f` (production) | 22 files, **462 passed** |
| Same suites, **PostgreSQL 16**, before any change | `533463f` | 22 files, **462 passed** |
| New regressions against the unfixed code | `533463f` + tests only | **5 failed** as expected (D1 ×4, D4 separation); D2 router guard and D3 pooled guard each shown failing with only that guard removed |
| Full suite, SQLite | `602f968` | 214 files passed / 1 skipped, **4597 passed**, 44 skipped, **0 failed** |
| Fleet, pool, dispatch, capacity, separation, labor, cash, attribution, step12b suites, **PostgreSQL 16** (local) | `602f968` | 29 files, **752 passed** |
| **Postgres suite, CI run 367** (`postgres-suite.yml`, clean `npm ci`) | `602f968` | **215 files, 4641 passed, 0 failed**, typecheck clean — <https://github.com/Peyday007/V5/actions/runs/35834630022> |
| Tests that read the repository's docs | `602f968` + docs | 8 files, **355 passed** |
| `npm run typecheck`, `npm run build` | `602f968` | clean; `index-T4sTcb6M.js` |

4597 + 44 = 4641: the SQLite skips are exactly the tests that need the other
backend, and the CI Postgres run has none.

**Production-current compatibility.**

* `ba5c0b2..533463f` (the puzzle kernel) touched no file under
  `server/services/dispatch/`, `server/services/fleet/`, `server/repos/fleet.ts`,
  `server/repos/bins.ts`, `server/services/bins/`, identity or capacity. Its
  only migrations are `089_puzzle_kernel.sql` / pg `080_puzzle_kernel.sql`,
  additive and numbered after the fleet lane's `088` / `079`. The unchanged
  fleet suites passing on both backends at `533463f` is the proof that it did
  not alter fleet semantics.
* Production then advanced again to `901a42d` (the audit round-trip fix:
  `repos/audits.ts`, `repos/extraction.ts`, `services/audit/context.ts`,
  `stateEngine.ts`), touching no fleet file and no migration. It is merged into
  this branch without conflict. It then advanced to `662d337` (documentation,
  `scripts/manufacturing.ts`, `tests/laborSurface.test.tsx` — again no fleet
  file and no migration), merged the same way.
* **Merged tree, full SQLite:** `fe0ebb0` (with `901a42d`) — 215 files passed /
  1 skipped, **4600 passed**, 44 skipped, **0 failed**. The +3 over `602f968`
  are production's own new tests. CI Postgres runs on the merged commits are
  listed in the handoff message that accompanies the final SHA.
* **Live, read-only:** `Fleet` run 280, `verify-pool --repository Peyday007/V5`
  against production `533463f` — `FLEET: OK verify-pool peyday007/v5 VERIFIED
  surfaces=1` (§4 carries the output). This change adds no migration, so the
  deployed schema needs nothing to accept it.


---

## 4. Commissioning — the steps only people can take

Nothing below can be done by Brain, by design: a consent screen is where a
person chooses which worker a connector authorizes; a Cowork Routine and its
trigger token exist only inside that person's Claude account; and the trigger
token becomes a deployment secret that no route, tick or command in this
repository can write (`fire.ts` reads `process.env[secretName]`).
**No secret is requested here, and none may be pasted into a chat, an issue, a
repository or a Brain field.**

The runbook is `docs/workers/CONNECTING-THE-FACTORY-WORKER.md`; step numbers
below are its steps. The pool is **one logical worker on four accounts**. Do one
account completely before starting the next.

**What production already holds** — read, not assumed: `Fleet` run 280,
`verify-pool --repository Peyday007/V5` on `533463f`, 2026-09-23 08:25Z:

```
POOL  peyday007/v5  as worker-10
  accounts   1
  surfaces   1
  PROVEN   Factory surface 1  (Brain Research A)
    ref       trig_01JN1h6UdhvR3bMpWFvaRbD2
    eligible  yes      headroom  0/4 in flight
    fires     18 fired, 0 refused
    proven    fired 2026-09-22T13:25:44Z, arrived, assigned and completed bin_fb9239718e6440c79952
  NOTE      Only one surface is registered for this repository, so nothing here is pooled
FLEET: OK verify-pool peyday007/v5 VERIFIED surfaces=1
```

`worker-10` is the *label* reports print for the worker named
**`factory-brain`** (`workerIdentity` is label, else name), so the runbook's
`bind-worker --worker factory-brain` is right. And **one of the four accounts is
already commissioned and proven** — the account registered as *Brain Research
A*. If that is the owner's Claude account, the owner's row below is done and
only the three friends remain; if it is not, the owner's row is still owed. Which
person *Brain Research A* belongs to is a fact only the owner can state.

### Where the four people stand — read from production, 2026-09-24

`admin people foundation` (run 35940369010) and `fleet show` (run 35941567806)
on the live Brain name the four people, and every line below is a row, not an
inference:

| Person | Sign-in | Claude connection | Factory surface |
|---|---|---|---|
| **Peyton** (Brain administrator) | PIN set — signs in | PROVEN (adopted research surface; that surface now QUARANTINED for no-shows) | **Factory surface 1**, account *Brain Research A*, bound to `factory-brain` — onboarded by `usr_1443…` (Peyton), PROVEN |
| **Airyn** | **blocked** — holds a passkey and no PIN; the sign-in screen takes only a PIN | not started | none (four legacy research Routines *Airyn 2-A…D* are bound to the shared research worker and QUARANTINED) |
| **Caleb** | **blocked** — passkey only, same as Airyn | not started | none (four research Routines *Caleb 3-A…D*, ENABLED, bound to an unowned worker) |
| **Vince** | **blocked** — holds no credential at all | not started | none |

*Brain Research A* is the Fleet account holding the Step 10 trigger
`trig_01CBLu5o…` and the surface Peyton adopted, and `factory-brain`'s routing
row says it was onboarded by Peyton — so the rows point to it being Peyton's
own Claude account. No row can prove whose Claude subscription an account is;
that is recorded here as strongly indicated, not established.

**What each blocked person needs, in order** (each an existing product path;
nothing here needs a database step):

1. **Sign-in.** Peyton → People & capacity → *issue a recovery link* for Airyn
   and for Caleb, and an *enrollment link* for Vince; send each link to its
   person. Redeeming it ends in setting a PIN.
2. **Factory connector.** Peyton → Build → Repositories → *Onboard* `brain`
   again for each friend, and send them the fresh link; they follow the table
   below from "That person, in their own browser".
3. **Surface.** Each friend creates `Factory_surface_N` in their own Cowork and
   hands Peyton the trigger id; the bearer token goes to Peyton out of band and
   Peyton sets `BRAIN_ROUTINE_TOKEN_FACTORY_N` with `fly secrets set`. The
   Fleet workflow steps after that (register, bind, `verify-surface --probe`)
   need no further human action.

### Once, by the owner

1. **Already done in production** — `brain` is onboarded and its worker
   (`factory-brain`, shown as `worker-10`) has a routing row and a proven surface. Pressing **Build →
   Repositories → Onboard `brain`** again is how each further person gets a
   fresh invitation link (runbook step 1); it reuses the same worker and
   revokes only unspent invitations.

### Per person — owner (N=1), friend 1 (N=2), friend 2 (N=3), friend 3 (N=4)

| Who | Action | Record / state that should appear | Probe that proves it |
|---|---|---|---|
| **Owner** | Press **Onboard** again for this person and send them the fresh link (skip for any account already PROVEN). The rotation revokes unspent invitations only, never a connector already authorized. | A new `worker_invitations` row for the pool worker | — |
| **That person, in their own browser** | Open the link first (step 2), then in *their* Claude account add connector **`Factory Brain`** at `https://northline-brain.fly.dev/mcp/factory` and approve **`Factory · peyday007/v5`** (step 3). | An `oauth_tokens` row for the pool worker minted through their consent; the invitation marked spent | — |
| **That person** | In Cowork, create Routine **`Factory_surface_N`** — repository `Peyday007/V5` on `production`, connectors **`Factory Brain` only**, no schedule, API trigger on, the prompt verbatim (step 4). Hand the `trig_…` id to the owner; hand the bearer token to the owner **out of band**, never in chat. | nothing in Brain yet | — |
| **Owner (Fly)** | `fly secrets set BRAIN_ROUTINE_TOKEN_FACTORY_N=<token> --app northline-brain` (step 5). One name per person; never shared. | Machine restarts; nothing in flight lost | — |
| **Owner (Fleet workflow)** | `register-account name=<their account name>`; `register-routine account=… ref=trig_… secret=BRAIN_ROUTINE_TOKEN_FACTORY_N name=Factory_surface_N capabilities=repository,repository-write`; `bind-worker ref=trig_… extra="--worker factory-brain"` (step 6). A reused secret name or token is **refused by name** — that refusal *is* the isolation check. | `fleet_accounts` row (distinct name), `fleet_routines` row with its own `token_digest`, `worker_id` = the pool worker | `fleet show`: surface `ENABLED`, `unanswered=0`, secret present |
| **Owner** | `verify-surface ref=trig_… extra=--probe`, then `verify-surface ref=trig_…` (step 7). | A pinned `DETERMINISTIC_CHECK` bin; `DISPATCH_SENT` to this Routine; `worker_sessions` row with this person's account; bin `COMPLETE` | **Usable:** `VERIFIED` — fired → arrived as the pool worker → assigned → completed. **Isolation:** the arrival's account is *this* person's account and no other Routine's chain names this credential; a `FAULT` "authenticated as a different worker" means the wrong connector was selected in Cowork |

### After all four

`verify-pool repository=Peyday007/V5` (step 8) must read **`accounts 4`,
`surfaces 4`**, every surface **PROVEN**, and `ok`. Anything less names which
surface and why.

---

## 5. Final live acceptance — once all four are connected

Run in this order against the deployed image, through the existing workflows.
Every expectation is a row Brain wrote; none is a worker's say-so. Record each
output verbatim beside the commit it ran on.

1. **Simultaneous membership and identity isolation.**
   `fleet verify-pool --repository Peyday007/V5` → `accounts 4`, `surfaces 4`,
   four `PROVEN`, four distinct `ref=trig_…`, four distinct secret names, one
   bound worker (`factory-brain`, printed `worker-10`), `FLEET: OK … VERIFIED surfaces=4`. Then `fleet show` → four `ENABLED`
   surfaces under four distinct accounts, `unanswered=0` on each.
2. **Routing across the pool, and persistence of assignment.** With the fleet
   target at ≥ 4, submit and approve one campaign on `brain` whose plan has
   ≥ 4 independent units. Then for each unit bin, `step10 trace <bin>`:
   `DISPATCH_ROUTED … SELECTED Factory_surface_N on <account>` and
   `DISPATCH_SENT` naming that Routine. *Pass:* at least three distinct
   accounts carry work while the units overlap (`factory status` concurrency
   > 1), and no bin has two `SENT` intents at one generation.
3. **Ownership and attribution.** For every completed bin, the
   `worker_sessions` row (`step10 audit-lineage` / `packet-report` for research
   bins) names the account whose Routine that session was **fired from** — and
   no credential appears under two accounts. The review stage's recorded
   independence tier is the one the lineage supports (`ACCOUNT_SEPARATED` only
   if author and reviewer sessions are on different accounts).
4. **Fallback — refusal.** One person, in their own Claude account, pauses
   their Routine (or revokes its API trigger). The next fire at it is refused:
   `fleet show` → that surface `QUARANTINED` with the provider's words in
   `state_reason`; the same burst routes the bin to another account;
   `bin_events` shows no attempt charged for the refusal. Capacity reads 3
   eligible, not 4 and not "fleet down".
5. **Fallback — no-show.** With the Routine re-enabled but its connector
   removed from the Routine's connectors in Cowork (so a fired session cannot
   reach Brain), three fires go unanswered: `DISPATCH_NO_SHOW` rows name that
   Routine, it is quarantined at the third, and the others keep draining.
   Restore the connector, `fleet set-state --kind routine --to ENABLED`, and
   `verify-surface --probe` returns it to `PROVEN` — the forgiveness boundary
   means it is not re-quarantined on the old rows.
6. **Persistence across a restart.** Deploy (or restart) mid-campaign. After
   it, every leased bin is still owned at the same generation or taken over at
   generation + 1 with the attempt charged exactly once; no bin is stranded
   (`packet-report` / `factory status` name no un-deliverable stage).
7. **Truthful capacity throughout.** At each step above, People → capacity,
   the Fleet page and `fleet show` agree on the eligible count, and a surface
   is `HEALTHY` only when it is eligible *and* proven.

**Pass condition:** every step's expectation met, on the deployed commit,
with the four accounts still `PROVEN` at the end. Until then the honest
statement is: *the software is complete; the four-account pool is not yet
commissioned.*
