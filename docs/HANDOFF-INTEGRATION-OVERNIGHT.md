# Overnight integration run, 2026-10-02

The open-PR backlog on `Peyday007/V5` converted into integration trains. This
document records rows rather than intent: every branch, SHA and number below
was read from git or GitHub when it was written. **Nothing was merged to
`production` and nothing was deployed.** Base for every train:
`production` @ `0041975`.

## Open PR audit

56 open PRs were seen. #88 and #89 are the active revenue stack. They were read
for compatibility, nothing was added to them, and they are not counted below.

| class | count | PRs |
|---|---|---|
| ABSORBED_IN_TRAIN (unchanged `--no-ff` merge) | 41 | 40 factory PRs into #90–#93 (lists below), and #36 into #94 |
| ABSORBED_WITH_PORT (semantic port onto current production) | 4 | #23 → #96, #37 → #95, #30 + #35 → #97 (partial) |
| CONTAINED_IN_ACTIVE_STACK (head is an ancestor of #88 and #89) | 8 | #42 #43 #44 #45 #46 #48 #69 #71 |
| MOSTLY_OBSOLETE, residue ported | 1 | #3 → #98 |
| UNKNOWN | 0 | — |

Each of the 54 backlog PRs carries a comment naming the train that supersedes it. None
was closed, because closing them is a person's call.

## Integration trains

| PR | branch | head | absorbs | depends on |
|---|---|---|---|---|
| #90 | `integration/documents-2026-10-02` | `3d293e3` | #54 #57 #60 #62 #64 #65 #76 #79 #80 #86 #87 | — |
| #91 | `integration/research-2026-10-02` | `9f93304` | #59 #61 #67 #70 #72 #75 #77 #81 #84 #85 | — |
| #92 | `integration/russell-2026-10-02` | `5742a38` | #40 #41 #53 #55 #58 #66 #78 #82 #83 | — |
| #93 | `integration/surfaces-2026-10-02` | `7ca7a3b` | #47 #49 #50 #51 #52 #56 #63 #68 #73 #74 | — |
| #94 | `integration/russell-delivery-2026-10-02` | `c50bffd` | #36 (migration 100 / pg 091) | — |
| #95 | `integration/human-work-2026-10-02` | `1ad1b46` | #37 (101 / pg 092) | #94 |
| #96 | `integration/commerce-kernel-2026-10-02` | `1c83dcf` | #23 (102 / pg 093) | #95 |
| #97 | `integration/kernels-residue-2026-10-02` | `d27b04d` | #30, #35 residue (103 / pg 094) | #96 |
| #98 | `integration/step12b-residue-2026-10-02` | `49494a3` | #3 residue | — |
| #99 | `integration/pin-lockout-flake-2026-10-02` | `bf25706` | flake fix (no old PR) | — |

#94 to #97 are a linear stack. Each PR's base is the branch below it, so each
PR shows only its own diff.

## Integration defects fixed

1. **#81's test hardcoded `/home/user/V5`.** It passes only in a checkout at
   that path and fails in CI's checkout. The fixture now derives the root (#91).
2. **#47, #50, #51 and #52 conflicted pairwise in `router.ts` and
   `RussellShell.tsx`.** I resolved it as a union. The mechanical union dropped
   comment openers, which I fixed. A new
   `tests/shellSurfaceComposition.test.ts` checks the composed shell and was
   seen to fail when a rendering branch is deleted (#93).
3. **#36's release-decision message was written once.** A rate-limited forge
   compare made it read "0 files" for ever. It is now written only after a
   successful compare (#94, found by the delivery worker).
4. **Migration collisions.** #37 (094/085), #23 (082/073) and #35 (090/081)
   all used numbers production had already taken. They are renumbered to
   101/092, 102/093 and 103/094, and stacked so the chain has no gap at any
   branch tip.
5. **CLAUDE.md section collisions.** #36, #37 and #23 each wrote a §51. The
   rule applied is uniqueness over precedence (§47), giving §51 delivery, §52
   human work and §53 commerce. Code comments citing them moved too.
6. **#23's Postgres migration lacked the four CHECK constraints its SQLite
   twin carries** (the §45 defect). They are added as named constraints (#96).
7. **`commerce.yml` shared the deploy's concurrency group**, so it could evict
   a queued deploy (§47). It now has its own group and runs `await-release`
   (#96).
8. **#30's `openAsks` transaction duplicated #43, which is already inside
   #88.** I found this when composing with #89. I removed it from #97 so that
   #43 is the single writer.
9. **#54 and #55 both claimed test ports 8200–8299.** `deploymentOwnership`
   refused the pair in the full combined run. #55 now uses 8300 (#92).
10. **`pinAuth` "holds the lockout across a restart" fails 3/3 on clean
    production.** It raced a 5-second cooldown against a 4.7-second reboot. It
    now forces the hour-long lock deterministically: 10/10 passing, and it
    still catches an in-memory lockout (#99).
11. **#3's shell took `projects[0]`** rather than the open thread's project.
    `shellProject` is ported (#98).

## Migrations

- SQLite: production ends at `099`. The stack adds `100`, `101`, `102` and
  `103`, and is contiguous at each tip of #94 to #97.
- Postgres: production ends at `090`. The stack adds `091` to `094`.
- No other train carries a migration. Nothing applied was edited.
- I verified the chain on a local Postgres 16 at the stack tip. Seven suites,
  237 tests, passed: `deploymentOwnership`, `commerceKernel`, `humanWork`,
  `softwareDelivery`, `puzzleKernel`, `laborKernel` and the labor orphan suite
  (since removed as a duplicate of #43's).

## Tests

| scope | result |
|---|---|
| #90 impacted (SQLite) | 343 passed, 29 skipped |
| #91 impacted (SQLite) | 456 passed (after fix 1) |
| #92 impacted (SQLite) | 3099 passed, 2 skipped |
| #93 impacted (SQLite) | 435 passed, plus the composition suite 4/4 |
| #94 impacted (SQLite) | 1577 passed |
| #95 impacted (SQLite) | 1462 passed (one load timeout, which passes alone) |
| #96 impacted (SQLite) | 2554 passed |
| #99 `pinAuth` | 10/10 runs |
| **full suite, #89 + #90–#93 + #98 (SQLite)** | **5292 passed, 1 failed**; the failure was the port collision, fixed as defect 9 |
| full suite, #89 + every train (SQLite) | running at handoff; result recorded in a follow-up commit |

Every train typechecks clean. So does the full composition of #89 with every
train, and that composition merges textually clean once fix 8 is in.

## Journey tests

- `softwareDelivery.test.ts` (from #36, in #94) covers a conversation request
  through to a change request, a campaign, the release decision, merge, the
  live check, and an answer in the same conversation.
- `shellSurfaceComposition.test.ts` (new, #93) checks that every operator
  surface the menu offers renders and round-trips.
- `humanWorkBrowserToDatabase.test.ts` (from #37) runs screen to route to row.
- `puzzleIntegrationPass.test.ts` additions (from #35) cover a seeded format
  through to a promoted product.

## Merge order

The trains are independent of each other except within the migration stack.
This order is derived from the code:

1. #99, #91, #90, #92, #93, #98. Any order works. They have no migrations,
   compose cleanly with each other and with #89, and none needs #88.
2. #88, then #89, the active revenue stack. It owns #42 to #48, #69 and #71.
3. #94, #95, #96, #97, strictly in that order (migrations 100 to 103). They
   compose cleanly with #89 and may also go before step 2, but not out of
   order with each other. #97's labor change relies on #43 (inside #88) for
   the ask/round transaction. Before #88 lands, labor keeps production's
   behaviour, and nothing breaks.

Each merge is a person's decision, as is the deploy after it (§28: deploy only
from `production`).

## Remaining blockers

- **Person: merge approval** for every train, and closing the 54 superseded
  PRs.
- **Person: decide on #3's unported parts.** These are the Step 12B
  acceptance-harness rewrite (about 1,650 lines), the bounded capacity
  measurement (a new dispatch-path mechanism that fires real Routines), and the
  `BRAIN_REPOSITORY` stamp.
- **CI:** the Postgres suite workflow runs on the canonical branch after each
  merge. Locally, Postgres covered only the stack's suites.
- **Production evidence:** none of the ported kernels (commerce, human work)
  has been exercised by a real fleet worker. That needs a deploy and a fire.
