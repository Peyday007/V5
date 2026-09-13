# Two branches, one canonical branch, and the order they land in

Two workstreams are open against `production` at the same time. Both are wanted,
neither supersedes the other, and they touch one shared contract that will refuse
to boot if it is got wrong. This file is the decided order and the work each side
owns, written down so that it is not a thing anybody has to rediscover.

| | |
| --- | --- |
| **First** | **PR #2** — Step 12B, `claude/zealous-hypatia-78a2yp` |
| **Second** | **PR #1** — Software Factory, `claude/pensive-bell-dr81a4` |

The order is the owner's decision, recorded here rather than inferred from
timestamps.

---

## What they collide on

**Migration numbers, and nothing else that a normal text merge does not settle.**

| chain | Step 12B (PR #2) | Software Factory (PR #1) |
| --- | --- | --- |
| SQLite | `049_design_approvals.sql`, `050_project_invitations.sql` | `049_software_from_conversation.sql` |
| Postgres | `040_design_approvals.sql`, `041_project_invitations.sql` | `040_software_from_conversation.sql` |

`production` is at SQLite **048** / Postgres **039**. Neither branch's migrations
are applied anywhere, so neither is checksum-locked and renumbering one costs
nothing.

`loadMigrationFiles` refuses a duplicate version rather than applying one and
skipping the other, so a collision is **a boot failure with a sentence in it**
rather than a schema quietly missing half of itself. That is the whole reason the
numbering is checked at load time, and §25 records it happening once already, at
035, between these same two workstreams.

## What PR #2 owes

Nothing to PR #1. It is a fast-forward onto `production` as it stands, its
migrations take the next free numbers in both chains, and it leaves
`production` at SQLite 050 / Postgres 041.

## What PR #1 owes, before it merges

Four things, and none of them is the owner's to do.

1. **Reconcile against updated `production`** — merge the new `production` into
   `claude/pensive-bell-dr81a4` (not the other way round, and never by checking
   `production` out; see §28).
2. **Renumber its own unapplied migrations** to the next free number in each
   chain — SQLite `049_software_from_conversation.sql` → **051**, Postgres
   `040_software_from_conversation.sql` → **042** — and change nothing else
   inside them. An unapplied migration has no checksum to break.
3. **Preserve both workstreams.** Both branches touch `CLAUDE.md`,
   `client/src/russell/Views.tsx`, `scripts/visual-qa.ts` and
   `server/routes/russell.ts`. Those are ordinary text merges and every
   hunk from both sides is wanted; a merge that resolves by taking one side
   wholesale loses work that passed its own suites.
4. **Verify the combined tree**, not either half: `npm run typecheck`,
   `npm test`, and `npm test` against Postgres — the second backend is the only
   thing that tells you a repository layer over two databases is true rather
   than merely compiling, and this merge touches repositories on both sides.

**Done, on `claude/pensive-bell-dr81a4`.** `production` was merged in at
`dd1f9be`; the three conflicts — `Views.tsx`, `visual-qa.ts` and
`routes/russell.ts` — were resolved by keeping every hunk from both sides rather
than either wholesale; and the two migrations are renumbered to
`051_software_from_conversation.sql` and `042_software_from_conversation.sql`
with nothing inside them changed. The combined tree leaves `production` at
SQLite **051** / Postgres **042** once it merges.

`tests/deploymentOwnership.test.ts` is the mechanism rather than the reminder: it
names a file each workstream owns and fails if a merge dropped one, and it walks
both migration chains for a gap or a collision. **It will fail the merge that
skips step 2**, which is the point.

## Deploying

Pushing and deploying are two decisions (`deploy.yml` is `workflow_dispatch`
only), and only `production` may be deployed — `.github/CANONICAL_BRANCH`, the
`canonical` job, and the `production` environment's deployment branch policy each
enforce that independently. Neither branch deploys itself; neither dispatches
`Deploy` on its own ref. See `docs/DEPLOYMENT.md` and §28, which is written from
damage: a feature branch reaching production put a deleted surface back twice.

One deploy after **each** merge is fine, and one after the second is enough. What
is not fine is deploying between the merge of PR #2 and the reconciliation of
PR #1 from inside PR #1's branch.
