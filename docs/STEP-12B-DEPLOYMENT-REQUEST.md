# Step 12B — the one deployment decision that is the owner's

Everything Step 12B can establish without changing what is running is
established. What remains needs a deployed Brain, and this session cannot
produce one: the command that advances the canonical branch was **refused** by
the environment's own guard, and the refusal is correct.

This file is the consolidated request: what was rejected, why it should not be
worked around, what a person can do instead, and exactly what becomes provable
the moment they do it.

---

## 1. The rejected action

    git push origin HEAD:production

Refused by this session's permission classifier, labelled **[Production
Deploy]**. It was not retried, not reworded, and not routed around — no second
workflow, no `flyctl deploy`, no dispatch of `Deploy` on a feature branch.
§28 is explicit that the last three are how a deleted surface came back twice,
and the guard refusing this session is the same class of control working
as intended.

**Nothing about that refusal is a bug to report or a setting to change.** A
session that could advance `production` on its own reasoning is precisely what
`.github/CANONICAL_BRANCH`, the `canonical` job and the `production`
environment's deployment branch policy exist to prevent.

## 2. What is waiting on it

One pull request, and four conditions in the acceptance matrix.

| | |
| --- | --- |
| Branch | `claude/zealous-hypatia-78a2yp` |
| Base | `production` |
| Relationship | **fast-forward** — 0 behind, ahead by the Step 12B work |
| Verification | `npm run typecheck` clean; full suite green on SQLite and on Postgres |

The four conditions are the ones that name `PRODUCTION` as what they need, and
they are open rather than exempt — see §2 of
`docs/STEP-12B-GATE-RECONCILIATION.md` on why a self-granted exemption was
removed:

- **L** — a mission completed and the project believes something because of it,
  and the conclusion cites the document and the audit. A finished mission needs
  a worker that reached the sources, which a checkout does not have.
- **L** — the deployed loop is running and error-free, and its cursor moved
  between two readings taken either side of the report.
- **P** — the hosted pre/post-restart check, which is the `Deploy` workflow's
  own record and is keyed to an exact revision. A reporter cannot attest to a CI
  run it did not observe, so the condition is open until a deploy of *this*
  revision produces one. **The record is never committed**: Deploy uploads it as
  the `step12b-hosted-verification` artifact and the acceptance workflow fetches
  it from that run. An earlier version of this file said the deploy "writes
  `docs/evidence/step12b-hosted/verification.json`" into the tree — it does not,
  it never did, and a hand-transcribed copy of it was the defect; see
  `docs/STEP-12B-REMAINING.md` §2.
- **A, B, E, M, N, Q** — each carries at least one condition that only rows in a
  Brain that has actually run can answer. `scripts/step12b-combine.ts` joins the
  container reading with the checkout reading **at the condition level**, which
  is what turns two PARTIALs into an answer.

## 3. The supported approval path

Any one of these is sufficient. They are listed strongest-first in the sense of
"fewest new powers granted".

1. **Merge the pull request on GitHub.** A merge performed by the owner in a
   browser is not a push from this session, and it lands the same fast-forward.
2. **Advance the branch from the owner's own shell**, which is what §28
   prescribes and why it prescribes it:

       git fetch origin
       git merge-base --is-ancestor origin/production origin/claude/zealous-hypatia-78a2yp
       git push origin origin/claude/zealous-hypatia-78a2yp:production

   Never by checking `production` out — §28 records a scratch worktree that had
   it checked out with a whole session's reversal staged in its index, one
   `git commit -am` away from putting a deleted surface back on production for
   the third time.
3. **Grant this session that one command.** Narrower than it looks: the
   deployment branch policy on the `production` environment still refuses any
   ref but the canonical one, and the `canonical` job still refuses a checkout
   behind its own remote.

Then, separately — because pushing and deploying are two decisions, which is
why `deploy.yml` is `workflow_dispatch` only:

4. **Run the `Deploy` workflow on `production`.** That is the action that
   changes what is running, and its first job refuses any other ref.

## 4. What happens after, in order

1. `Deploy` runs the suites, builds the image, deploys it, and runs the hosted
   verification either side of a real restart — uploading
   `step12b-hosted-verification` stamped with the deployed revision. That closes
   **P**'s last condition, with no commit anywhere: step 2 fetches it.
2. `Step 12B acceptance` finds that `Deploy` run through the API, checks it
   succeeded and that its artifact names the run's own `head_sha`, ships the
   record into the container, runs the reporter there and brings back
   `step12b-production.json`, carrying conditions rather than a verdict.
3. `scripts/step12b-combine.ts` joins that with a checkout run **by condition
   name**, and prints the A–Q matrix with every condition resolved to the
   environment that could answer it.
4. The three renders — desktop, intermediate, phone — go to the owner for the
   design decision at **O**, which is the one condition nothing in `scripts/`
   can write and which a test enforces by refusing any import of the writer
   outside `admin.ts`.

**O is not "the only thing left", and this document does not claim it is.**
Until step 3 has run, every condition above is open.

## 5. The other branch, and the one thing whoever merges second must do

`claude/pensive-bell-dr81a4` (PR #1, the Software Factory's conversational
entrance) is concurrent work against the same base, and it must be preserved.
It is not a competitor to this one and neither supersedes the other.

**They collide on exactly one shared contract: migration numbers.**

| chain | this branch | PR #1 |
| --- | --- | --- |
| SQLite | `049_design_approvals.sql`, `050_project_invitations.sql` | `049_software_from_conversation.sql` |
| Postgres | `040_design_approvals.sql`, `041_project_invitations.sql` | `040_software_from_conversation.sql` |

Production is at SQLite 048 / Postgres 039, so neither is applied yet and
neither is checksum-locked. `loadMigrationFiles` refuses a duplicate version
rather than applying one and skipping the other, so the collision is a boot
failure with a sentence in it rather than a schema quietly missing half of
itself — which is the whole reason the numbering is checked at load time
(§25, which records this happening once already at 035).

**Whichever merges second renumbers its own files**, to the next free number in
each chain, and updates nothing else: an unapplied migration has no checksum to
break. `tests/deploymentOwnership.test.ts` walks both chains for a gap or a
collision and will fail the merge that does not.

Nothing else about the two branches conflicts in a way that a normal merge does
not settle; both touch `CLAUDE.md`, `client/src/russell/Views.tsx`,
`scripts/visual-qa.ts` and `server/routes/russell.ts`, and those are ordinary
text merges.
