# CLAUDE.md — operating instructions for Brain

Brain is a local-first research-operations platform. This file tells any agent working
on or through this repository how to behave. **It is not the database.** It records
rules, not state. Never write project state (which documents exist, which layers are
frozen) into this file — that lives in SQLite.

---

## How to work here: the engineering connector, and milestone-only reporting

Brain decides how much rigor a change has earned; a session does not invent its
own. The policy is `server/domain/engineering.ts`, served to every coding worker
as MCP tools and on a terminal as `npm run engineering`:

| before you… | ask | terminal |
|---|---|---|
| start a task | `brain_engineering_preflight` | `npm run engineering -- preflight --objective … --paths … --root-cause … --proposal …` |
| prove anything | `brain_evidence_lookup` | `npm run engineering -- lookup --repo owner/name --key …` |
| run tests | `brain_test_policy` | `npm run engineering -- policy --paths a,b [--sha S --repo R]` |
| build a scheduler, queue, verifier, auth, retry or orchestration mechanism | `brain_duplicate_mechanism_check` | `npm run engineering -- duplicate --proposal …` |
| stop, wait, or ask a person | `brain_next_engineering_action` / `brain_engineering_blocker` | `npm run engineering -- next --outcome … --reached …` |

The rules it applies, in one line each:

1. Root cause known, fix reversible, blast radius small → the smallest root-cause fix first, then retry the real journey. No schema, migration, service or proof system before that retry fails.
2. Real evidence first. A property real work already proved is not re-proved, and never synthetically.
3. No redundant full suites: typecheck + `test:impacted` while developing; the full gate once, in CI, on the released SHA; never again on a SHA that already passed it.
4. Watch an observable process to termination (background it and do independent work if it is long). Never "check back in 15 minutes" on something you can watch.
5. Done is the user's outcome. A plan, branch, green test or PR is not done when the outcome is production working.
6. Extend the existing owner. A new mechanism needs a stated reason extension cannot work.
7. Do not ask a person what the repo, git, the database, Brain records, GitHub, workflow logs or configuration can answer.
8. Independent work (no dependency, disjoint paths, separate branches) runs in parallel.
9. Executable work beside idle capacity is a defect; the watchdog records it and the dispatch tick continues it.
10. Production broken → restore the journey first, harden after.
11. **Decide, don't ask.** Peyton's standing order: make the best call for the Brain, record it, and run to done. Stop for a person only on `SPEND_OVER_CEILING`, `IRREVERSIBLE_PRODUCTION_LOSS`, `LEGAL_RISK`, `SECRET_EXPOSED` or `MAJOR_NEWS` (a big win or a big failure), or a secret/login only he holds (`MISSING_AUTHORITY`). `brain_engineering_blocker` refuses any other question. Needs from him that do not block other work go in the end report, not mid-run.

`.claude/hooks/engineering-guard.mjs` enforces the two hard edges (a full suite on
an intermediate commit; a delayed check-in under 45 minutes) and names the way
past each. What the policy refused is in `engineering_interventions`; `npm run
engineering -- report` prints it with the metrics.

**Report milestones, not activity.** Conversation output is for the final
report, `BLOCKED` (rule 11 reasons only), an important defect, or a meaningful
status change. Do not narrate "reading X", "now checking Y", "waiting", "let me
inspect Z" — tool activity is already in the tool log and Brain's records.

The final report opens with exactly one status word, and the word must be true:

- **DONE** — every completion requirement in the owner's message is met and
  verified. Not most of them; not "built, awaiting merge"; not "live, proof
  pending".
- **NOT DONE** — anything else. List each unmet requirement and the exact
  reason it is unmet. "Waiting for a deploy / CI / research" is not a reason to
  write this report: keep watching (see *Finishing an assignment*).

Then, as needed: **DECIDED** (calls you made, one line each), **YOU DO** (only
what needs Peyton's hands — logins, payments, a secret only he holds — or
"nothing"; never a merge, a deploy, or a decision rule 11 says is yours),
**BIG NEWS** (only a big win — never a failure, a defect or a bad finding; leave
it out when there is none).

---

## Finishing an assignment

Measured from the owner's own sessions, 2026-10-08 to 11-02
(`docs/CLAUDE-CODE-INCOMPLETE-ASSIGNMENTS-2026-11-02.md`): assignments stopped
short because sessions reported DONE on a subset, handed the owner a merge or a
routine decision, ended to "wait" with no notification armed, backed off when a
parallel session touched the same area, or lost the assignment's own words to
compaction. These rules answer each of those.

1. **The owner's message is the contract, and a program checks it.** The
   `UserPromptSubmit` hook copies each requirement verbatim into a ledger and
   arms the Ralph Loop plugin, which refuses every stop until
   `npm run finish -- check` — running the evidence, git and the GitHub API
   itself — returns DONE, WAITING, BLOCKED or STALLED. Your written status is not
   read. How to work under it: `.claude/skills/finish-the-job/SKILL.md`.
2. **Stop only when** every requirement is met, or every remaining one is blocked
   by a rule-11 reason. A blocker on one requirement is not a reason to stop the
   others.
3. **Merge and release your own work.** Owner's standing order, 2026-11-01:
   *"Always merge it on your own, never make me merge it. Remember this always."*
   A direct session merges its own PR into the canonical branch, dispatches
   `Deploy` there (§28 in the record), and verifies the outcome on production.
   A PR, a green test or "ready for review" is never the end.
4. **Waiting is not stopping.** Background a long process and keep doing
   independent work. End a turn only when a notification is armed (a background
   task, a Monitor, a subscribed PR) that will wake you, and then continue the
   assignment when it fires — do not write the final report on a pending result.
5. **A parallel session is not a stop reason.** If another session changed the
   same area, rebase onto its work and finish yours; if it already delivered one
   of your requirements, verify that on production and close the requirement
   with that evidence.
6. **Do not narrow scope.** Never declare done on part of a list, never hand
   remaining executable work to the owner or to "Session X", and never end with
   an optional offer ("I can watch it if you'd like") instead of doing it.
7. **After a compaction or resume**, `.claude/hooks/restore-objective.mjs`
   re-injects the owner's messages verbatim (full text in `owner-words.md`
   beside the transcript). Re-read them and reconcile the task list before
   deciding anything is done.
8. **Keep this file small.** It is loaded into every session's context. Detail
   goes in `docs/ARCHITECTURE-RECORD.md`; `tests/claudeMdBudget.test.ts` refuses
   a CLAUDE.md over budget.

---

## 1. Query project state. Never guess it.

The authoritative operational state is:

```
DATABASE  (data/brain.db, or Postgres in cloud mode)
    +
DOCUMENT STORE  (data/projects/<slug>/documents/..., or the bucket)
    =
authoritative state
```

Which of the two it is depends on configuration, and **no code above
`server/db/` or `server/services/storage/` may care.** Read rows through the
repositories and bytes through the storage layer, and the same code is correct
in both modes. A path built by hand is correct in exactly one of them.

AI memory is **not** authoritative. Never state that a document exists because you
remember seeing it in a conversation. Verify first.

To read state without touching SQL:

- `GET /api/projects/:id` — project, layers, derived state, plan
- `GET /api/projects/:id/plan` — the Master Planner (NOW / NEXT / LATER / BLOCKED)
- `GET /api/projects/:id/next-action` — the single next best action
- `GET /api/layers/:id` — documents, runs, audits, dependencies, history
- `data/runtime/project-state.json` — a concise machine-readable snapshot, regenerated
  automatically whenever project state changes

The runtime JSON file is **derived state**. SQLite remains authoritative. If the two
disagree, the JSON is stale — re-run a recompute, do not edit the JSON.

If a document's database row exists but its file is gone, that is `INCONSISTENT STATE`.
If a file exists on disk but has no database row, that is an `UNREGISTERED FILE`.
Neither is "the document exists". Run **SCAN & RECONCILE**
(`POST /api/projects/:id/reconcile`) and resolve it.

## 2. Never ask the user to touch SQL.

No manual SQL, no pasted migrations, no database console, no manually added columns, no
hand-populated state rows. The user's loop is: change code → refresh/restart → the
database updates itself → the app loads. If you find yourself about to write "now run
this SQL", you have a bug to fix instead.

## 3. Every schema change requires a migration.

Schema lives in `server/db/migrations/NNN_name.sql` (SQLite) and
`server/db/pg-migrations/NNN_name.sql` (Postgres), applied automatically on boot,
in order, each in its own transaction, with the applied version recorded in
`schema_migrations`.

- To change the schema, **add a new numbered migration file**. Never edit an applied one.
- Applied migrations are checksum-locked. Editing `001_initial.sql` after it has run
  makes the application refuse to boot with an explicit error — that is deliberate.
- Update the matching `*Row` type in `server/domain/types.ts` and the repository mapper
  in the same change, or the type contract silently drifts from the database.
- **A schema change is not done until both chains have it.** The Postgres
  baseline is generated from the SQLite schema
  (`node scripts/generate-pg-baseline.mjs > server/db/pg-migrations/001_baseline.sql`)
  so the two cannot drift into describing different things; a later change adds
  a numbered file to each. The two chains are numbered independently and their
  versions do not mean the same thing.
- The four deliberate differences between them are listed in `docs/CLOUD.md`.
  There must be no fifth that is not written down.

## 4. Every research artifact must be registered.

A PDF sitting in the project folder is not a document. It becomes one only when it has a
row in `documents` with a canonical name, a version, a type, and a filesystem path.
Import through `server/services/importer.ts` (or `POST /api/projects/:id/import`), never
by copying a file into place by hand.

The **platform** owns the filename. The model's report title is never trusted:
`buildNames(layerName, version)` in `server/domain/naming.ts` is the single source of
truth for `canonical_name`, `conversation_title` and `filename`.

## 5. Preserve lineage. Never destroy history.

- A failed run is never overwritten, edited, or deleted. A redo creates a **new** run
  with `parent_run_id`, an incremented `attempt_number`, and a `redo_reason`.
- Superseded documents keep their rows and their files; they are the layer's provenance.
- `project_events` is append-only. Current state may mutate; history does not.
- Automatic redo loops stop at `versionPolicy.maxAutoRedos` (default 2), after which the
  run is marked as needing human review rather than looping.

## 6. Update state after every meaningful action.

The event that changes reality is the event that updates the database. Any code path
that imports a document, completes a run, records an audit, freezes or reopens a layer
must finish by calling `recomputeProject(projectId)` (or `recomputeLayer`) from
`server/services/stateEngine.ts`, which re-derives file state → dependencies → layer
status → next action → the runtime JSON.

There must be no workflow where the user has to remember "now go update the database".

## 7. Respect the project invariants.

1. No manual SQL in ordinary operation.
2. No manual migrations.
3. No important action without a `project_events` row.
4. No synthesis with missing dependencies unless the user explicitly overrides.
5. No redo that destroys failed-attempt history.
6. No frozen layer without a canonical artifact.
7. No AI state claim without querying current state.
8. No file treated as registered solely because it exists on disk.
9. No database record treated as healthy if its referenced file disappeared.
10. No generated prompt without recording the exact prompt and required attachments.
11. No audit result stored only as prose — always the structured record too.
12. No project state dependent on one chat transcript.
13. No research into a requirement the archive already answers.
14. No fixed fragment count; the gaps decide it.
15. No claim judged by a standard that does not fit what it claims.
16. No repair that repeats a strategy an earlier attempt already tried.
17. No new evidence silently overwriting old evidence.
18. No money spent without the user turning paid overages on themselves.
19. No expensive run started from the browser without a plan a person approved.
20. No synthesis over a packet that does not cover the goal's mandatory part.
21. No request served without an authenticated principal and an explicit
    authorization decision.
22. No secret stored in a form it can be recovered from, and no credential in a
    log, an audit row, a response, an error or a URL.
23. No resource refused in a way that distinguishes "you may not" from "it is
    not there" — including the body of the refusal, not only its status.
24. No two workers holding a valid lease on one work item, and no queue-state
    change without proving current ownership in the same statement that makes it.
25. No claim treated as permission to perform an effect that is unsafe to
    repeat, and no effect performed outside the class whose guarantee it can
    actually keep.
26. No timeout, reset or late error treated as evidence that an effect did not
    happen; an unknown outcome is recorded as unknown and never auto-retried.
27. No idempotency scope built from anything the caller sent, and no logical
    effect key that changes between attempts.
28. No capability exposed remotely that is not already an authorized operation
    locally, and no tool list treated as an access control.
29. No protocol version advertised that is not served, and no result carrying
    fields from a revision its reader did not ask for.
30. No remote refusal that distinguishes absent from forbidden, and no remote
    error carrying a payload, an argument, a credential or an identifier the
    caller did not already hold.
31. No field with two masters: a connected site owns its operational fields and
    Brain owns what Brain derives, and neither writes the other's.
32. No delivery accepted that cannot be ordered, and none allowed to regress a
    newer one — the guard is on the source's own version, in the statement that
    makes the change.
33. No storage threshold that stops Brain work, and no figure reported that was
    not measured.
34. No scope asserted about a subject that no row and no question stated —
    a jurisdiction is read from the record, and not knowing it is an answer.
35. No administration page: a decision a person makes belongs on the surface
    they already use, and everything else is a terminal where reaching the
    shell is the authentication.
36. No production deployment from a branch that is not the canonical one named
    in `.github/CANONICAL_BRANCH`, and none from a checkout behind it.
37. No money figure that is not derived from an append-only entry, and no cost
    subtracted twice — what has already left the account is gone from the
    balance, and only what has not left reduces what may be deployed.
38. No money committed outside a ceiling a person set first, no commitment
    released by a clock, and no retry counted as a second commitment.
39. No unknown read as a favourable assumption: an unanswered fact is a task,
    and it may never make something ready, and never rank it higher.
40. No temporary section's off switch that stops work it does not own — winding
    a sprint down ends new discovery and never a customer's obligation.
41. No identity shared between two private operations, and no credential that
    resolves a project its holder was not connected to.
42. No capability a machine is said to teach recorded as one this company
    holds — what producing something requires is established by research, what
    this company can do is established by a person, and nothing derives the
    second from the first.
43. No research question without a decision that consumes its answer, no example
    read as a boundary, and no depth allocation that lowers a bar — a question is
    retired when it stops bearing on the decision and never when it stops being
    convenient.
44. No human role kept without naming which reason makes it necessary, and no
    work given to Brain on a question nobody answered — the burden is on
    justifying the person, and an absence justifies neither.
45. No state stored about work whose rows can be read, and no claim about the
    world outside this Brain without somebody attesting to it — a register says
    where work has got to by reading, or it says nobody has said.
46. No identity two live accounts answer to, and no account made unreachable by
    a row nobody can sign into — a name is a credential's other half, and the
    refusal that protects it must still be legible to whoever can correct it.
47. No possibility discarded for ranking poorly — a rank is a view of the space
    and never the space, simplification happens in the presentation, and what
    is not in the top five is not thereby worthless.

## 8–102. The architecture record

Sections 8 onward — why each subsystem is shaped as it is, and the production
defects that shaped it — are in **`docs/ARCHITECTURE-RECORD.md`**, verbatim and
under the same numbers, so every `§N` reference in code, tests and docs still
resolves. Read the section for the area you are changing before you change it
(`grep -n "^## 27\." docs/ARCHITECTURE-RECORD.md`). The repository map is
`docs/REPOSITORY-MAP.md`.

- §8. Model prose never mutates project state.
- §9. An audit reads extracted evidence, never raw bytes.
- §10. Every conclusion must resolve to a passage.
- §11. A filename is a hint. Only the contents are understanding.
- §12. Breadth comes from fragments. Correctness is enforced inside each one.
- §13. Research what the archive does not already answer.
- §14. What counts as evidence depends on what is being claimed.
- §15. A repair is planned. A retry is not a repair.
- §16. Execution is bounded by the user's allowance and their approval.
- §17. Every request has a principal, and the server decides what it may do.
- §18. Configuration is a request. Only a real operation is a fact.
- §19. Ownership of queued work is decided by the database, in one statement.
- §20. A retry is not a second effect.
- §21. The protocol is a door, not a second set of rules.
- §22. A worker signs in. It does not hold a pasted key.
- §23. The fleet is rows, and a slot is claimed rather than computed.
- §24. Russell is a way in, not a second brain.
- §25. A website is a window. Brain is what it looks at.
- §26. An administration page is not a workflow, and Brain has none.
- §27. The factory is an entrance to the same machinery, and its evidence is the repository.
- §28. One branch owns production.
- §29. A product is what a person can do, and every number in it is a row.
- §30. Cash Mode is a section, not the definition of Brain.
- §31. A validated finding belongs to the Brain. Everything else belongs to its project.
- §32. A member is a device, and readiness is a count of rows.
- §33. A pipeline is what actually ran, not what each stage would do if it were reached.
- §34. Discovery is shared. Execution is private. People and capacity are neither.
- §35. The setup is one screen, and a screen two accounts cannot compare is two screens.
- §36. A permission decides what is inside a section. It never decides which sections there are.
- §37. A definition is not an implementation, and Brain must never say it is.
- §38. A mechanism says how money is reachable. It never says where.
- §39. A capability a machine teaches is not a capability this company holds.
- §40. Research is a decision about what to learn, and Brain had no place to make it.
- §41. Brain is the default producer. That is a burden of proof, not an assumption.
- §42. A render is the interface. Code is a claim about it.
- §43. A register stores an intent. Everything else about it is derived.
- §44. A person is set up or they are not, and nothing could answer that.
- §45. A deal has two sides, and everything hard about it lives between them.
- §46. A name is the other half of a credential.
- §47. A real row is not an answer to a question it never answered.
- §48. A generated grid is not a puzzle until a solver that did not generate it has proved it.
- §49. A discovery has many ways of being paid. Recording one destroys the rest.
- §50. A goal is owned when a person's decision about it reaches the work.
- §51. A refresh is a state, a connector is an identity, and an auth failure is not a no-show.
- §52. A research goal is approved once, and its ceilings are what remain.
- §53. A credential nobody judged was not refused, and Brain's outage is nobody's no-show.
- §54. A provider is a deployment secret and an effect class, never a boolean.
- §55. After the buyer says yes there is one model, and each fact has one owner.
- §56. One autonomous chain, and every link of it has one owner.
- §57. The product is six destinations, and each one answers a question a person asks.
- §58. An approved objective ends live and verified, or at one named blocker.
- §59. A session that arrived is an answer, and who it arrived as is the first question.
- §60. A simulation compares decisions on the same worlds, and never calls coverage a probability.
- §61. The database is the shared dependency, and its load is measured rather than guessed.
- §62. Five repair batches are one release, and a merged PR is not a closed finding.
- §63. Under database pressure Brain defers optional work by itself, and says when it stopped.
- §64. A connector opens once, and Brain answers within the time it waits.
- §65. A dead end is a watch, not a verdict, and research spends where an answer can change a decision.
- §66. Brain runs the marketplace work itself, or it does not take the job.
- §67. A category is offered because its proof passed, and the files are Brain's own.
- §68. A surface that cannot reach the web still does the work that needs none, and each account is one card.
- §69. Work another session must do is handed back by Brain, never waited on.
- §70. A qualified opening becomes one job, and a job says exactly what stops it.
- §71. A finished packet is the measure, and an audit role is fired where it can be taken.
- §72. Research goes where an answer can make work executable, and a marketplace job is a job.
- §73. A play is a kind of buyer for something Brain can make, and it names what it needs produced.
- §74. A job is dealt to one person, and every person gets an even mix.
- §75. A low-cost email play qualifies on who pays and that Brain can deliver.
- §76. The freelance-marketplace operation is gone, and its leftovers are put away.
- §77. A number a person reads is one of a checked model's numbers, or it is not shown.
- §78. A throttle binds only while capacity is contended, and a goal's search grows with the idle fleet.
- §79. A number nobody published is reconstructed from the mechanism, and says how far it travelled.
- §80. A research park the standing grant already covers is Brain's to answer, and audits are bounded by accounts, not Routines.
- §81. Brain constructs mechanisms nobody published, and never assumes a second sale.
- §82. Brain learns why an arrangement makes money, and builds new ones from that.
- §83. Focus keeps one search: an approved cash goal's constructed arrangements.
- §84. Claude routines are reserved for Brain improvement until the owner says otherwise.
- §85. Displaced work names a replacement that is doing it, and commercial research is the free lane's.
- §86. The free lane's concurrency is a controller's output, and a quote is copied, never retyped.
- §87. Brain improves itself through one loop, from a weakness in the rows to a measured decision.
- §88. A complete system is mapped before it is debugged, and a gap is read from production, never from code.
- §89. A goal's research is measured at its plan, and a search that does not reach the plan is asked differently.
- §90. Independent work does not wait for unrelated work, and evidence reaches the plan when it arrives.
- §91. The owner does no physical work; selling, brokering and small repeat sales are still the search.
- §92. An industry is constructed from positions and evidence, and the decision is Brain's.
- §93. A goal is reasoned backward into transactions, and a partial opening is completed, not discarded.
- §94. Buyer outreach goes through the owner's Instantly workspace, and its replies are measurements.
- §95. A candidate is not an accepted plan: a cash goal is met at a defensible 90%, never at a point reading.
- §96. A specification is the authority, and a program is DONE only when every requirement it states is verified on production.
- §97. A specification grows by releases, and a program's order is when, never whether.
- §98. Every pool of capacity is fed: idle capacity beside waiting work is a fault Brain finds and corrects itself.
- §99. A plan short of its requirement is reconstructed, not re-read, and a result keeps the context it was measured in.
- §100. A change is recognized where it happens, and the work it enables resumes without a person restating it.
- §101. A goal is examined from many directions, and the ways of reasoning that work are learned.
- §102. A plan's variables are swept by ordinary code, and only the strongest strategies cost an engine read.

## Conventions

- TypeScript ESM. **Relative imports include the `.ts` / `.tsx` extension.**
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` and `noUncheckedIndexedAccess` are on.
- SQLite parameters are positional `?` only, so both drivers behave identically.
- **An `ORDER BY` must be sayable in both dialects.** Postgres refuses an
  expression that is not in the select list of a `SELECT DISTINCT`, so name the
  aggregate and order by the alias — `SELECT DISTINCT … ORDER BY MAX(x)` passes
  the SQLite suite and throws on the database production runs.
- **A migration may not carry a dollar-quoted body, and the refusal is in a
  gate rather than in a deploy.** `splitStatements` and `toPostgresSql` both
  walk a script character by character and neither knows what `$$ … $$` is, so
  the first `;` inside one ends the statement and the migration fails with
  `unterminated dollar-quoted string` — on the backend the SQLite suite cannot
  see. Write the statement plainly: a migration applies exactly once, in its
  own transaction, with its checksum recorded, so a `DO $$ … END $$;` existence
  guard is asking the runner for a guarantee it already gives. Teaching both
  scanners about it is a code change somebody reviews, and `toPostgresSql` runs
  on every statement the application issues, so it is deliberately not made for
  a construct one file wanted.
- Booleans are `0`/`1` in the database and real booleans in view types; repositories are
  the only place the two representations meet.
- **A suite that drives a real server owns a port range no other suite can
  reach.** `/healthz` is deliberately unauthenticated, so a collision does not
  fail loudly: the second suite's readiness probe finds the first suite's
  server, waits happily for it, and then signs in against a Brain with a
  different bootstrap administrator — which reports `401` and reads as a broken
  sign-in. Three suites once held the identical range. It is the migration
  collision one floor down, and `deploymentOwnership` refuses both.
- Timestamps are ISO-8601 UTC strings.

## Checks before you call a change done

**While developing — every intermediate commit:**

```
npm run typecheck
npm run test:impacted
```

`test:impacted` runs the tests that import a changed file directly (a type-only
import does not count, because it runs no code), every test file the change
edited, and the structural guards no module graph reaches — the deployment
ownership walk, the workflow rules, and both migration chains whenever either
moved. If the change touched persistence, run the same selection against the
other backend:

```
npm run test:pg        # the same selection on a throwaway local Postgres
```

`--list` prints the selection without running it; `--transitive` widens it to
everything the module graph reaches, for a change whose reach genuinely is that
wide. **Do not run the full suite on intermediate commits, on either backend**,
and do not add a feature branch to `postgres-suite.yml`'s push trigger:
`tests/testingWorkflow.test.ts` refuses it.

**The full cross-system gate is paid once, on the SHA that is integrated and
released:** the `Postgres suite` workflow runs the whole suite against Postgres
on every push to the canonical branch — as four `vitest --shard` jobs, each with
its own cluster, and a verdict job that fails unless every shard passed and
their own reports show every test file ran exactly once — and `Deploy`'s own test job runs it
against SQLite on the commit it releases. A merge is not done until the first is
green, and a release is not done until the second is. Both stay dispatchable by
hand for a deliberate full run.

Then verify the two boot paths that matter: migrating from an empty database, and
restarting against an existing one.
