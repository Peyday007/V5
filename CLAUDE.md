# CLAUDE.md — operating instructions for Brain

Brain is a local-first research-operations platform. This file tells any agent working
on or through this repository how to behave. **It is not the database.** It records
rules, not state. Never write project state (which documents exist, which layers are
frozen) into this file — that lives in SQLite.

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

## 8. Model prose never mutates project state.

The dynamic audit engine (`server/services/audit/`) runs three separate roles —
primary auditor, adversarial critic, final judge — and only the judge's
**validated structured output** may reach `recordAudit`.

- Enums are matched exactly. No substring matching, no negation handling, no
  "closest verdict", no template placeholders, no inferred approval.
- The judge's counts are cross-checked against the gaps it classified, and an
  advancing verdict is refused outright while a foundational gap is open.
- An invalid response, a provider error, a timeout or an unreadable artifact is
  an **audit failure**: nothing is recorded and no state moves. The failure and
  the raw response are still persisted, because a verdict you cannot trace is
  not auditable.
- `parseAuditJson` in `auditEngine.ts` is the older, forgiving path for audits a
  human pastes in and reads first. `services/audit/schema.ts` is the path a
  model's own output takes, and it is deliberately stricter. Do not merge them.

Project-specific audit criteria live in `server/domain/auditProfile.ts`, one
profile per project. Never scatter `if (layer === 'Discovery')` through pipeline
logic — add to the profile instead.

## 9. An audit reads extracted evidence, never raw bytes.

A file on disk is not something Brain has read. `server/services/documents/`
turns a stored file into an **extraction run**: pages, ordered blocks, raw text
beside normalized text, a quality verdict, and chunks with page anchors.

- Only a run that reached `READY` or `READY_WITH_WARNINGS` is evidence. A
  `BLOCKED`, `FAILED` or `INTERRUPTED` document is something the auditor does
  **not** have, and every code path must say so rather than treating an empty
  extraction as an empty document.
- One unreadable member blocks a whole packet audit. A layer verdict that
  quietly skipped a document is the false confidence this engine exists to
  prevent.
- Extraction runs are append-only. Reprocessing creates a new run and marks the
  old one superseded (`supersedePreviousRuns`), so an audit recorded months ago
  still resolves to the text it actually read. Exactly one run is current.
- OCR is a local capability Brain discovers, version-checks at startup and
  reports. Only pages with no usable text layer are recognised, and a recognised
  page carries its provenance: the engine, its version, the sha-256 of the exact
  rendered image, the resolution, and a confidence per page and per block. With
  no engine installed, pages that need one are reported unreadable — never passed
  on as empty content, and never sent anywhere else to be read.
- A recognised page below `ocrConfidenceFloor` counts as unread. Confidence is
  evidence, so it gates: a document must not become READY merely because OCR
  returned some characters.
- A document that is registered and present but unreadable is not evidence, so
  its layer is BLOCKED and the plan says to reprocess or replace it. A layer that
  reads AUDIT_READY while its only document cannot be read is a lie the planner
  must never tell.
- Normalization may only remove extraction artifacts. `raw_text` is kept beside
  `normalized_text` on every block, so cleanup can never be the only copy of the
  evidence.

## 10. Every conclusion must resolve to a passage.

`retrieveEvidence` answers a question from the extracted text and returns three
things, all of which matter: the passages, the documents it searched, and the
documents it could not read. An empty result over an unread document means "not
read", not "not present" — and only Brain can tell those apart.

- `recordAuditEvidence` attaches passages to each gap after a verdict is
  recorded, retrieved from the text rather than quoted by the model. A citation
  is therefore a fact about the document, not a claim about it.
- Structured findings (`services/documents/findings.ts`) are an index over a
  document, never a replacement for it. A finding whose quote cannot be located
  in the extracted source is discarded, and the page number comes from the block
  the quote was found in — never from the model.
- Findings are never derived from the mock provider. Inventing an index is worse
  than having none.

## 11. A filename is a hint. Only the contents are understanding.

Some sources belong to the project rather than to a layer: a master chat
transcript, a working log, a pasted session. `documents.scope` says which —
`LAYER`, or `PROJECT_MASTER_TRANSCRIPT` / `PROJECT_SOURCE` for the rest. A
project-wide source is registered with `layer_id = NULL` on purpose, and that is
not an orphan; forcing it into one layer would file most of its content under the
wrong heading.

- Storing a file is not reading it. `services/sources/ingest.ts` extracts,
  normalizes, chunks, segments, classifies and reports, and nothing counts as
  ingested until that has run. "It is in the folder" is invariant 8 again.
- Segments follow the text's own boundaries — speaker, timestamp, heading,
  separator, topic — not a fixed character count. Chunks are for finding text;
  segments are for understanding it. A segment carries the block range and the
  character offsets it came from, so every claim about a transcript resolves to
  a passage in it.
- Classification reads the passage, against the layer vocabulary the project's
  own audit profile already declares. `classification_source` records which:
  `FILENAME` is a hint, `CONTENT` is understanding, and the difference must be
  visible in the UI rather than implied.
- One segment may link to several layers and versions. Every link carries a
  confidence and a rationale, is created as `PROPOSED`, and becomes evidence only
  when a person accepts it. Re-reading the file replaces the proposals and keeps
  the decisions — they are re-anchored by the passage's content hash, because a
  decision belongs to the text rather than to a row.
- Imported text is untrusted data. A passage that reads like an instruction is
  detected, flagged in the ingestion report and stored as ordinary text. Nothing
  found inside a file is ever executed, and none of it may move project state.
- Never send a whole transcript to a provider. `selectRelevantSegments` picks the
  passages that bear on one question inside a character budget.

## 12. Breadth comes from fragments. Correctness is enforced inside each one.

One conversation is not responsible for a broad subject, and one giant prompt is
not deep research. `services/research/` decomposes an assignment into bounded
fragments — as many as the gaps require and no more, with no fixed range —
researches each as its own job, and lets only the fragments that clear their
evidence gate contribute anything.

- A fragment declares what it is: one bounded question, the evidence lanes it
  needs, acceptable and excluded source types, its geography, timeframe,
  population and definitions, completion criteria, the minimum independent
  sources, and the fragments it depends on. Those declarations are what the gate
  is applied against, so a fragment with none of them cannot be judged and is
  refused at the planning pass.
- Seven conditions decide whether a claim may be synthesized: a canonical source
  URL; a source that directly supports it; the exact passage or locator; scope,
  date, geography and definitions matching the fragment's; contradictions
  resolved or explicitly retained; the fragment's lanes covered and its
  independent-source minimum met; and any calculation resting on inputs that are
  themselves accepted claims. `services/research/gate.ts` applies all seven.
- Two of those are judgements only a reader of the source can make — whether it
  supports the claim, and whether the scope lines up — so a separate verification
  pass answers them per claim and Brain records the answer. Brain's part is to
  insist the answer exists and to apply it without exception, never to infer it.
- A rejected claim keeps its rejection reason forever, and a rejected fragment
  contributes nothing at all. Acceptance is decided once, at the gate, so nothing
  can re-enter through a later attempt's synthesis.
- A failed fragment is repaired, narrowed, or re-run with a different search
  strategy chosen from what actually failed — up to `MAX_FRAGMENT_ATTEMPTS`, and
  every attempt stays in the table as failure history.
- The synthesis reads the accepted ledgers only, and the filed report carries the
  ledger inside it so every sentence resolves to a claim id, a URL and a passage.
  Then the existing primary / adversarial / judge audit runs on the packet.
- Every pass is written down before the provider is called and completed after
  it, with the exact prompt, its sha-256 and the raw reply. That is what makes a
  crash survivable: `recoverInterruptedResearch` closes what a dead process left
  open, and a completed pass is never bought twice.
- The engine's readiness and the worker's readiness are separate answers with
  separate remedies, and the UI shows both. A provider that returns placeholder
  content declares `placeholder: true` and is refused for staged research
  outright — a report of invented citations is the worst thing this platform
  could produce.

## 13. Research what the archive does not already answer.

The default is not to research. Before any job runs, `services/reconcile/`
extracts the claims the project already holds, maps them to the goal's
requirements, and decides per requirement whether the archive settles it:
SATISFIED, PARTIALLY_SATISFIED, PRESENT_BUT_UNVERIFIED, STALE, CONTRADICTED,
DEFINITION_MISMATCH, SUPERSEDED, OWNED_ELSEWHERE, NOT_REQUIRED or MISSING.

- A fragment exists only for a genuine external-research gap. Researching a
  requirement the archive already answers spends the user's allowance to learn
  something the project knew, and it is the same waste as never reading the
  archive at all.
- A gap that is real but is not research — another layer's job, an
  implementation detail, an empirical validation, a tuning decision — is
  reported as such and never becomes a fragment.
- The boundary contract is the goal's own terms: question, decision, audience,
  inclusions, exclusions, geography, timeframe, population, definitions,
  expected output, completion standard, and what the assignment did not settle.
  Everything downstream is judged against it, so an ambiguity in it becomes its
  own fragment before anything else runs.

## 14. What counts as evidence depends on what is being claimed.

"Two independent sources" is right for a disputed market estimate and wrong for
everything else. `services/research/standards.ts` picks the standard per claim
type and the gate applies it per claim; there is no general minimum.

- One directly inspected primary source settles a statutory fact. An
  organisation's own site is conclusive about what it says and worth nothing as
  independent confirmation. A forecast is never a fact whatever supports it. A
  claim that something does not exist is established by a documented search of
  the places it would be, or not at all.
- Sources that are really one source are counted as one: two pages on a site, a
  press release carried by three wires, three publishers restating one upstream
  estimate. The duplicates are reported rather than quietly collapsed, because
  "four sources agree" reads differently once three are the same release.
- A disagreement is classified before it is called a contradiction. A different
  definition, timeframe, geography or population explains it completely and is
  settled by choosing the scope the assignment asked for. Incompatible figures
  are never averaged to produce an answer.

## 15. A repair is planned. A retry is not a repair.

`services/research/repair.ts` builds the plan behind a second attempt: what
failed, which claims were rejected and why, which source ecosystems were already
searched, what to search instead, the terminology the sources themselves used,
and how much budget is left. Strategies come from a named ladder and are
filtered against every earlier attempt, so no two attempts can be the same
search twice; when the ladder or the budget runs out the honest outcome is
"unresolved", recorded as such.

- Splitting comes before repair: a fragment that is really two questions would
  otherwise be repaired as a whole, re-researching the half that already worked.
- A repaired fragment carries its requirements, scope and evidence bar forward.
  A repair that loses them answers an easier question than the one that failed.
- Accepted evidence replans the run. What it confirms, strengthens, updates,
  narrows or contradicts is recorded per claim, coverage moves, and queued work
  the new evidence made unnecessary is cancelled with its reason — but new
  evidence never overwrites old evidence, and both claims keep their rows.

## 16. Execution is bounded by the user's allowance and their approval.

A fragment is a logical evidence unit; a job is an execution container. Compatible
fragments share one job — same scope, same source ecosystem, no dependency
between them — while keeping entirely separate claims, verdicts and repair
histories. Output that cannot be split back apart by fragment key is discarded
rather than untangled.

- Order follows what the work depends on: boundaries and definitions,
  foundational evidence, calculation inputs, contradiction resolution, mandatory
  synthesis inputs, supporting context, optional enrichment.
- Running out of quota is an ordinary event. The run pauses, keeps every
  accepted fragment and every queued one, and resumes when the allowance comes
  back. It is never a reason to lower the evidence bar, and paid overages are
  off until the user turns them on themselves.
- Research started from the browser is planned in full and then stops: the user
  sees the goal as Brain read it, what the archive answers, the genuine gaps and
  the jobs proposed, and approves before anything is spent. Automatic execution
  changes when approval is asked for, never whether the plan can be inspected.
- **A plan may be approved without a person only inside limits a person set
  first.** `services/research/approvalEnvelope.ts` is the whole of it, and four
  properties are what make it safe rather than a loophole: the envelope lives in
  code and a packet names it by id, so nobody supplies the limits their own plan
  is judged against; the check is a pure function over rows, so no model is ever
  asked whether its plan fits; it decides only whether research may *start*, and
  leaves the evidence gate, the verification pass, the synthesis check and all
  three audit roles exactly as they are; and anything outside the envelope stops
  at `NEEDS_HUMAN` with every reason recorded, never narrowed and never retried.
  An automatic approval records the envelope, the authorization and the
  validator version, because "Brain approved this" is auditable only if you can
  tell which rules it applied. This is not a policy engine and must not become
  one — a second envelope is a code change somebody reviews.
- Before synthesis the packet is checked against the whole goal — mandatory
  coverage, consistent scope, verified calculation inputs, investigated
  counterarguments, nothing load-bearing on a single source. A failure produces
  fragments for exactly what is missing, never a re-run of what worked.
- The research engine, archive ingestion, and the real Antigravity worker are
  reported separately. The engine passing its tests against a scripted provider
  says nothing about whether the tool works on this machine, and the worker is
  UNVERIFIED until a real job has actually run there.

## 17. Every request has a principal, and the server decides what it may do.

Since Step 4 there are no anonymous callers. A person signs in and holds a
server-side session; a worker presents a Brain-issued credential. Both resolve to
a principal built from rows the server owns, and nothing the caller sent about
itself contributes to it — not a header naming a user, not a body field naming a
project, not an id in a path.

- **Authorization is deterministic server code at execution time.** A hidden
  button, an omitted tool schema, a route guard in the browser and an
  instruction in a prompt are not authorization. The model is never the
  security boundary.
- One policy module decides (`services/identity/policy.ts`) and the resolvers in
  `routes/helpers.ts` are where it is applied, because they were already called
  by every route that addresses a project-scoped resource. Do not write a role
  check into a route handler; add to the policy instead.
- **A resource the caller may not have is reported as one that does not exist.**
  The same 404 as a real miss. A distinguishable refusal is an oracle for
  enumerating a Brain you have no access to.
- Deny by default, and fail closed. A missing principal, an unknown project, an
  unreachable database — all refusals. Never a downgrade to anonymous, local,
  test or administrator identity.
- **Nothing stores a secret.** A password becomes a scrypt verifier; a session
  and a worker credential become a sha-256 digest. A worker credential is shown
  exactly once at issue and is not recoverable afterwards by anyone, including
  an administrator. No credential may appear in a log, an audit row, an API
  response, an error message, a URL or a test snapshot.
- Membership and scopes are read on every request rather than baked into a
  token, so revoking access takes effect on the next request rather than at the
  next sign-in.
- A Brain worker identity is not a Claude account. Brain issues the worker a
  Brain credential; it never stores a provider password, session, cookie or
  token.
- Identity mutations are audited to `identity_events`, which is append-only, has
  no foreign keys — an audit row a cascade can delete is not an audit row — and
  records denial *categories* rather than what was tried.

Step 4 is identity and authorization only. Concurrency safety is Step 5's
claiming and leases and Step 6's idempotency; see `docs/ROADMAP.md`.

## 18. Configuration is a request. Only a real operation is a fact.

Brain can keep its state locally or in the cloud, and the second one is only
worth having if it is honest about which it is doing.

- **Cloud mode never falls back to local.** A Postgres that cannot be reached or
  a bucket that does not answer stops the boot with the reason. A server that
  fell back would look healthy, accept research, write it where nobody else can
  see it, and report itself as cloud-backed the whole time — and nobody would
  find out until they looked for the work from somewhere else.
- Having the environment variables set is not the same fact as the database
  answering. Boot runs a real query and a real bucket listing, and only then may
  anything say cloud mode is active.
- Secrets are server-side. The connection string and the service-role key appear
  in the Postgres connection and one `Authorization` header, and nowhere else —
  not in a log line, not in an API response, not in the frontend bundle. A
  diagnostic names the host, the database or the bucket; never the credential.
- A request never chooses a location. Storage keys are built from Brain's own
  identifiers, a caller-supplied filename is sanitised to a leaf and kept as
  metadata, and a key that is absolute or climbs is refused rather than
  normalised into something that happens to be safe.
- In cloud mode `data/runtime/project-state.json` is not written at all, and
  `readProjectState` returns null whatever is on that disk. It is a local
  convenience for a single machine; several instances each keeping their own
  copy of shared truth is worse than none of them keeping one. `data/brain.db`,
  `data/projects/…` and `data/backups/…` are not authoritative there either.
- The migration into the cloud is a copy. It never writes to the local source,
  never deletes it, and success triggers no cleanup — the local Brain stays the
  recoverable original until a person archives it themselves.

## 19. Ownership of queued work is decided by the database, in one statement.

Step 5's queue (`server/repos/workQueue.ts`, `docs/QUEUE.md`) hands work to
authenticated workers across more than one Brain instance. Its whole design is
one sentence: **a claim is a compare-and-swap on `lease_generation`.**

- Two workers may both read generation 7 and both try to take the item. The
  `UPDATE` says `WHERE lease_generation = 7`, so exactly one matches. A losing
  claim is an ordinary outcome, not an error.
- The generation is also the fencing token. Heartbeat, complete, fail and
  release are each a single guarded `UPDATE` carrying the whole proof — item,
  lease id, generation, the worker id **from the authenticated principal**, the
  `LEASED` state, and an unexpired lease. Never read-then-write; there is no
  window for a race to live in.
- Never infer ownership from a worker saying it owns something. A body field
  naming a worker is ignored.
- An expired lease is claimable work, so recovery never depends on one process
  staying alive. The sweeper is for metrics; delete it and nothing breaks.
- Cancellation advances the generation, which is what makes it win. A late
  completion from the previous owner matches nothing.
- A lease exists **iff** the item is `LEASED`, enforced by a CHECK constraint,
  and a generation is issued once per item, enforced by a UNIQUE index. The
  invariants the comments rely on are impossible, not merely untested.
- Lease decisions use the Brain's clock through `queueNow()` — never a worker's.
  The assumption is written down there and nowhere else.

**The queue is at-least-once, not exactly-once.** A lease can expire after a
worker performed an effect and before it recorded completion, so the item is
redelivered and the effect repeats. Fencing protects queue state; protecting the
effect is Step 6. Until Step 6 exists the only registered work type is
`SYNTHETIC_ECHO`, and a successful claim is not permission to perform an
unprotected external effect. A queue item describes Brain-authorized work; there
is no work type meaning "run this".

## 20. A retry is not a second effect.

Step 5's queue is at-least-once and says so. Step 6
(`server/services/effects/`, `docs/EFFECTS.md`) is what stops that meaning
"twice". The whole mechanism is one constraint:

    UNIQUE (scope_hash, key_fingerprint)

A logical operation reserves itself with `INSERT ... ON CONFLICT DO NOTHING`.
Exactly one caller inserts; every other equivalent caller reads the row it
collided with and replays, waits, or is refused. The arbiter is the database,
never a process-local lock.

- **There is no universal exactly-once**, and claiming it would be a lie about
  at least one provider. The guarantee is per effect class: same-database
  commits once transactionally; a native-idempotent provider gets one stable
  key; a reconcilable one is asked rather than repeated; an opaque one stops at
  `UNCERTAIN` and waits for a person.
- **A timeout is not evidence.** Neither is a connection reset, nor an error
  from a provider that already accepted the work. The only evidence is a
  receipt or the provider's own answer. An unknown outcome is recorded as
  unknown and is never automatically resent.
- **A key arrives in a header, never a query string**, and a key in the query
  is refused rather than ignored — ignoring it leaves the caller believing they
  have a property they do not.
- **The scope is built from server-controlled facts only.** Nothing the caller
  sent contributes, so a key is never a way to reach another project.
- **A queue effect's key is derived from the work item**, never from the lease,
  attempt, generation, credential, request or clock. A key that changes on the
  retry is not an idempotency key.
- **Inputs identify an operation; outputs do not.** Putting a result into a
  fingerprint makes a reclaimed item's new owner look like a conflicting
  request and blocks legitimate recovery.
- **The fence is at the commit boundary**, as a guarded write inside the
  effect's own transaction — not a `SELECT`, which would leave a window.
- **A replay re-reads and re-authorizes.** No response body is stored, so a
  principal who lost access cannot be handed the result. One-time credentials
  are never replayable, and worker credential issuance is permanently outside
  this mechanism.
- Deleting an operation record must never make a successful effect silently
  repeatable.


## 21. The protocol is a door, not a second set of rules.

Step 7 (`server/mcp/`, `docs/MCP.md`) puts one endpoint on the outside of
Brain — `POST /mcp` — and everything about it is arranged so that it adds a
way in without adding a way around.

- **Nothing is exposed that was not already an authorized operation.** Every
  tool is a thin wrapper over a service that already existed, with the scope it
  already required. A remote protocol that grows its own back door is a second
  security model, and the second one is always the weaker.
- **The tool list is not an access control.** Every caller sees the same
  `tools/list`; which tools a caller may *succeed* with is decided at execution
  time by `services/identity/policy.ts`, the same module every HTTP route uses.
  Filtering the list per principal would make it a permission oracle and would
  leave the real check one forgotten filter away from being skipped. There is no
  MCP policy module and there must never be one.
- **Brain is a dual-era server, and that is forced rather than chosen.** The
  current revision is `2026-07-28`; the official SDK's latest release speaks
  `2025-11-25` and contains no reference to the newer one. Every client that
  exists is therefore a legacy client, and the specification's own matrix marks
  legacy-client-against-modern-server as failing with no fall-forward. So the
  modern era is implemented against the published schema and the legacy era is
  served by the SDK, from one registry.
- **There is no session, in either era.** `2026-07-28` removed sessions and the
  `initialize` handshake outright, and the legacy front-end runs stateless by
  choice. So every request re-authenticates and re-authorizes from current rows,
  revocation lands on the next call, and a restart has nothing to restore.
- **Authentication is a bearer credential — never a cookie.** A session cookie
  is refused here even when valid: a browser is not an MCP client, and a cookie
  on a mutating JSON-RPC endpoint is a CSRF surface. `Origin` is validated and
  no CORS headers are emitted.

  Step 7 accepted exactly one bearer, the Step 4 worker credential, and
  advertised no OAuth — on the reasoning that a discovery pointer to a facade
  that cannot issue a usable token is worse than a plain refusal. **Step 8 built
  the flow, so the pointer is now real and is emitted.** See §22. The half of
  that sentence which still holds is the half worth keeping: never advertise a
  mechanism that is not served.
- **A refusal names nothing.** Absent and forbidden are one message, and it is
  the same *body* both times — invariant 23 again, at a new boundary.
- **Every mutation goes through Step 6**, keyed from the work item and the
  operation. An `Idempotency-Key` header is refused rather than ignored: here it
  would name a POST, and a POST is a transport frame rather than an effect.
- **A tool's own failure is a result, not a protocol error.** The schema is
  explicit, and the reason is practical: a refusal delivered as a transport
  failure is one the consumer cannot see or react to.

Step 7 is the gateway only. Connecting a real worker is Step 8, and proving the
first is not evidence for the second — the same separation Step 3 drew between
the research engine passing its tests and a real job having actually run.



## 22. A worker signs in. It does not hold a pasted key.

Step 8 (`server/routes/oauth.ts`, `server/routes/pages.ts`,
`docs/workers/`) connects the first real Claude worker, and the shape of it was
decided by one fact about the outside world: **Claude's custom connector has no
field for a static `Authorization` header.** Its only authentication affordance
is OAuth. A Brain that cannot speak OAuth cannot be connected to Claude at all,
however correct its bearer design is.

- **The operator authenticates; the worker is authorized.** A person signs in to
  the Brain on a Brain-hosted consent screen, sees which named worker is being
  connected and exactly what it can reach, and approves. What the client
  receives is a token whose principal is **that worker**.
- **A token resolves to the worker, never to the approver.** The human is
  recorded on the authorization code, for the audit, and is deliberately absent
  from the token. There is no column on `oauth_tokens` that could make an
  approver into a principal by accident. Everything downstream —
  `decideProjectAccess`, scopes, fencing, audit attribution — only ever sees a
  `Principal` of type `WORKER`, so this is a third *way in* rather than a third
  kind of principal.
- **Step 7's reasoning about OAuth was wrong, and the correction is recorded
  rather than hidden.** It argued there was no resource owner to redirect. There
  is one — the operator, in a browser, at the moment the connector is
  registered. The mistake was conflating that moment with the later tool calls,
  which genuinely have nobody present. OAuth is built for exactly that shape: a
  human authorizes once, a machine acts many times.
- **The bearer credential was not replaced.** `brnw_` still works, for a client
  that cannot do OAuth. Nothing about Step 7's contract was withdrawn.
- **Nothing about the Claude account enters the Brain.** Not a password, a
  cookie, a session or an Anthropic token. Brain stores a token it minted
  itself, against a worker it owns, on the authority of a human it
  authenticated. A Brain worker identity is still not a Claude account.
- **Secrets are digests.** Client secrets, authorization codes and tokens are
  all sha-256. Codes are single-use, redeemed by a guarded `UPDATE` so two
  requests carrying the same intercepted code cannot both succeed. PKCE is S256
  only — `plain` makes the challenge equal to the verifier. Redirect URIs match
  exactly, and an invalid one renders rather than redirects, because bouncing an
  error to an unvalidated URI is how an open redirector is built.
- **Registration is unauthenticated, and confers nothing.** The connector makes
  client credentials optional, so a client given neither must be able to
  register itself. A registered client cannot read, call a tool, or obtain a
  token without a human approving it in a browser.
- **The operator console was server-rendered and had no JavaScript, and it no
  longer exists.** Its argument was that it is the surface you need when the
  client bundle is broken or access has to be repaired — and that argument was
  wrong in a way worth keeping rather than deleting. "It works when the bundle
  is broken" is a reason for a **recovery** to exist; it is not a reason for the
  recovery to be a public browser page. See §26.
- **A worker cannot create its own work.** Enqueueing is a project write and no
  worker scope grants it, so `decideProjectAccess` refuses a worker principal
  however its membership is configured. The console had the button instead,
  because a machine that could create its own work could also create work nobody
  asked for; it is `npm run admin` now. The same reasoning put project creation there: the only project that
  existed held real research, and a test worker's first bounded run must not be
  able to write into work somebody depends on.

  **That reasoning is about machines, and I over-read it once; the correction is
  recorded rather than quietly applied.** Step 12A's standing-authority grant
  was built onto this console on the strength of the sentence above — and a
  person deciding what Russell may spend on their own project is not a machine
  creating its own work. It sent the one decision Russell most obviously needs
  from a person out of Russell and into the surface §24 had deliberately taken
  off the normal route. It now lives at `POST
  /api/russell/projects/:projectId/authority`, behind `requirePerson` and
  `decideProjectAccess` — which is a *stronger* guard than this console's
  administrator-plus-same-site pair, because a worker principal is refused there
  by type. What stayed there was the reading and the revoke, on the argument
  that both are worth having when the client bundle will not load — and §26
  removed those too, for the reason that argument turned out to be wrong.

Step 8 connects **one** worker and proves a bounded cycle. The first production
research packet is Step 9, scheduling is Step 10, and a second worker is
Step 11.

### The worker runs in Cowork. This is settled.

**Cowork is the selected Claude Max worker execution surface.** It connects to
the deployed Brain through the OAuth flow of §22 — the same `/mcp` endpoint, the
same 24 tools, the same `WORKER` principal. Nothing about the surface reaches the
Brain, which sees a bearer token and rows.

**Ordinary Claude chat is not the standard worker workflow.** It can hold the
connector, and the Brain cannot tell the difference; that is exactly why the
distinction has to be written down rather than enforced. It is a fallback for a
one-off, never what a runbook or a step assumes.

`STEP-8-PLAN.md` §1 selects "Claude on the web" and is **superseded**. It was
Branch A's reasoning, Branch A was not built, and its sole objection to Cowork —
no static request headers — is void under OAuth. The operative decision is
*Selected surface: Cowork*, further down that same file.

**A worker writes its results into the Brain and nowhere else.** Claims,
verdicts, contradictions, checkpoints and documents all arrive through the
tools. A conversation transcript is not a result, and the terminal state of any
packet is rows plus stored bytes.

**No human relays research between Claude conversations.** If a session ever
asks an operator to paste a worker's findings back into Claude Code, that
session has lost the architecture. The only thing worth reporting by hand is how
a session ended — items completed, queue empty or allowance exhausted — and even
that is a convenience, not a mechanism.

**Step 9 uses manually initiated Cowork sessions**, with one authorized
exception in force. A person decides when a worker runs. That is the honest
description of where this is, and the measured cost of it is real: the largest
single block of elapsed time in Step 9 was a packet sitting in a queue waiting
for somebody to say go.

> **Authorized exception — one temporary hourly Cowork scheduled task.**
> Granted by the operator to finish Step 9's packet without repeatedly starting
> sessions by hand. Its bounds: it claims only work already queued and
> authorized; it creates no goal, packet, budget or approval; no paid overages
> and no external consequential action; it checkpoints and releases unfinished
> items; and it is paused or deleted by the operator once the packet is
> terminal. It uses Cowork's built-in scheduling — **no scheduler was built and
> no application code changed for it.**
>
> Four of those bounds are enforced by the Brain rather than by the task's
> prompt: a `WORKER` principal cannot enqueue, approve a plan, start a packet or
> widen its own reach, whatever it is told. That is why the exception is safe to
> grant to an unattended session at all.
>
> **This is not Step 10 and does not close it.** It is a temporary operational
> measure and, if it holds up, evidence toward a mechanism — recorded as
> evidence only after an unattended run has actually happened, never before.
>
> **Spent and withdrawn, 2026-09-11.** Brain fires on demand now, so an hourly
> timer is no longer the thing that starts a worker — and a timer is the wrong
> answer to a question somebody is asking right now. Both hourly Cowork
> schedules are disabled: the Oakwood one and the generic Factory one. What
> remains is `trig_01CBLu5oCZziEwznw5q9xU7g`, which carries no cron at all. See
> `docs/OAKWOOD-RETIREMENT.md`.

**Step 10 must implement and prove automatic worker activation or scheduling.**
It has implemented it, and it has proven activation, draining, takeover,
recovery, a measured concurrency ceiling, and a filed and audited document from
real research.

That last one took two goes, and both are worth keeping. On the first, the
worker's execution environment had no network egress to the primary sources, so
the evidence gate refused its ungrounded claims, the fragment used its repair
budget and was blocked with the reason recorded, and everything depending on it
stayed queued. **A worker that cannot reach the sources is a worker that must
produce nothing**, and that is what happened. The operator then opened the
surface, and the *same* packet — not a replacement — ran to a filed report.

Three rules came out of the second go, and they are the durable part:

- **"Blocked" is four facts, and they lead to different actions.** The
  environment refusing a host, the host refusing this client, a robots policy,
  and a 5xx are not the same event. `SURFACE_PROBE_V1` makes a worker record
  which one, per host, from a closed vocabulary — and **Brain does not judge
  whether the probe succeeded**, only that a reading exists, because deciding
  from a worker's prose whether a network is open would be model output as
  state.
- **A fragment blocked by the surface may be recovered; one blocked by its own
  evidence may not.** `services/research/surfaceRecovery.ts` requires the
  recorded reason to name a surface condition, refuses ordinary insufficiency by
  name, requires a `RETRIEVED` probe reading dated *after* the block, raises the
  attempt ceiling instead of resetting the counter, and refuses a terminal
  packet outright. Every failed attempt keeps its row and its reason.
- **The authorized source class is not the same thing as a reachable
  publisher.** After the surface was open, `legislature.mi.gov` still answered
  503 to automation on every attempt, so the statutory text came from mirrors of
  the same MCL sections. The judge saw it and said so; it is recorded as
  unresolved. Broadening the class was available and was not taken.

**Brain now reaches out to Claude.** A bin becoming `READY` writes a durable
dispatch intent, and a ten-second tick turns intents into a fire against the
worker's routine — measured in production at 4.7 seconds from ready to fired,
with nobody involved. An earlier version of this paragraph said the mechanism
was unbuilt and undecided. That was true when it was written and is not true
now; the correction is recorded rather than quietly deleted, the same way §22
records Step 7's wrong reasoning about OAuth.

**A fired worker acts.** On 2026-09-01 at 07:41:45Z Brain fired three seconds
after a bin went `READY`; the activation ran 107 seconds and drained seven bins
end to end — assigned, executed, validated by Brain, terminal — with nobody
watching. Two of them were takeovers from a dead worker's expired lease. Zero
completion refusals.

An earlier version of this section said the fired worker stopped at a permission
prompt and named the routine's tool allowlist as the cause. **The prompt was
real; the diagnosis was wrong.** Both the blocked routine and the working one
carry an `allowed_tools` list with no `mcp__*` entry, so the allowlist cannot be
what separates them. What separates them is that the working routine has the
repository attached: its worker checks out the branch, reads
`.claude/settings.json`, and finds `permissions.allow` pre-approving the
connector's tools. The remedy was the documented project-scope permission rule
all along, waiting on a precondition nobody had checked.

The split it establishes still holds, and is the durable rule:

> **Brain owns dispatch. The surface owns whether a worker may act.** A worker
> identity that can authorize non-interactively is granted where the worker
> runs, not where the work is held. No amount of Brain-side code substitutes
> for it, and Brain must never mint its own workers or choose their permissions
> to get around it.

**A state that says "waiting for a person" which that person cannot resolve is
not waiting; it is stuck.** Step 10 met this three times at three altitudes, and
it is the same defect each time. A packet stopped at `NEEDS_HUMAN` needing an
authorization, and granting the authorization did nothing because the outcome
was derived once and never re-read. A bin parked at `NEEDS_HUMAN` after a
correct `HUMAN` refusal, and the state machine's only edges out of it were
`CANCELLED` and `FAILED` — both of which destroy the work rather than finish it.
So: **every escalation must have an answering transition, and that transition
must be guarded rather than absent.** The bin's is one source state, a
compare-and-swap on the generation, a fence, a budget check, and an append-only
row naming who answered it and on what evidence — never a reset, and never a
widening of a narrower control that already exists for a different reason.

What that grant turned out to be, here, is a checked-in settings file plus a
routine configured to check the repository out. Both are the operator's to set.

**CF-8 is closed.** Live token refresh was the last thing Step 8 could not say,
and it is now read from rows: `rotated=85 used=85 roots=0`. Eighty-five access
tokens were minted by the rotation grant rather than by an authorization code
and every one of them was then used, so a client refreshed and carried on. It
took no longer-lived token and no permanent one.

So: one unattended worker has completed bins end to end, and the concurrency
ramp has since run six rungs — 1, 2, 5, 10, 20, 30 — on an unblocked fleet.
Rungs 1 to 20 completed every bin, with zero duplicate activations, zero fenced
stale writes and zero stranded bins across all of them. **"Brain runs a fleet of
ten on one routine" is accurate.**

**The ceiling is a per-routine fire limit, not the subscription allowance**, and
an earlier report of mine said the opposite. Rung 20 finished twenty bins from
thirteen activations because a worker that finishes one asks for another; rung
30 had every dispatch refused, and Brain paused, kept every bin and resumed by
itself. A throttled fleet therefore loses throughput rather than work, and more
capacity means more routines rather than more allowance. **The recommended
operating ceiling is 10 concurrent bins on one routine.**

## 23. The fleet is rows, and a slot is claimed rather than computed.

Step 11 (`server/repos/fleet.ts`, `server/services/dispatch/`,
`docs/STEP-11-PLAN.md`) turns Step 10's one Routine into a fleet Brain can be
told about without a deployment. The whole of it rests on one distinction and
one primitive.

**An account is not a Routine.** An account holds a subscription allowance; a
Routine is a fire surface. A second Routine under one account doubles how fast
Brain can *start* sessions and changes nothing about how much that account may
*do*. Step 10 measured a fire ceiling and was explicit that it had not measured
an allowance — so `fleet_accounts` and `fleet_routines` are separate tables with
separate targets, and `declared_plan_power` is a **label** the router never does
arithmetic on. Sizing a fleet by multiplying "20x" is sizing it on a fiction.

**Routing is a decision; a slot is an exclusion.** `services/dispatch/router.ts`
is a pure function over a snapshot, kept apart from `candidates.ts` which
fetches the numbers, so "why did this bin go to that account" is answerable from
a recorded input rather than from a re-run against a database that has moved.
Being pure also makes it useless as a safety mechanism: two dispatchers both
compute correctly that a surface has headroom and both fire it. So selection
claims the surface with a compare-and-swap on `fleet_routines.fire_generation`,
guarded on state and `retry_at` as well, and the loser is refused rather than
retried — the mechanism can under-fire and cannot over-fire. **That is the third
time this codebase has needed the same sentence: a compare-and-swap has to be on
a value the claimant does not supply.**

- **Policy is rows.** Raising a target, boosting for an hour, pausing the fleet
  are all INSERTs into `fleet_policy` carrying an actor and a reason, so they
  need no deployment and the previous value is still there to revert to. A boost
  expires by being compared to the clock rather than by anything running.
- **A row never holds a credential.** `fleet_routines` holds the *name* of the
  deployment secret and a sha-256 of the value taken once at registration. A
  Routine whose secret is not present is left out of routing and reported as
  such, rather than spending a fire discovering it.
- **A worker binding is observed, and correcting it is a separate decision.**
  `bindRoutineWorker` fills `fleet_routines.worker_id` from the dispatch row
  that produced an arriving session and refuses to overwrite one that is set,
  because an observation that silently re-pointed a row would hide a surface
  wearing someone else's identity. Repairing a wrong binding is
  `repointRoutineWorker`: guarded on the binding the operator names, refusing a
  Routine that has none, and audited to `identity_events` with both ends of the
  move. Every escalation needs an answering transition — a refusal with no
  remedy is not waiting, it is stuck.
- **The capacity ledger is `bin_events`, not a second table.** It gained
  `account_id`, `routine_id`, `evidence_class` and `workload_class`. Two tables
  that must agree about the same fires is a design where the one nobody reads is
  the one that drifts. `evidence_class` is the honesty requirement of the step:
  a refusal the provider issued is `PROVIDER_ENFORCED`, a duration Brain timed is
  `MEASURED`, and a ceiling nobody has observed is `UNKNOWN` and stays `UNKNOWN`.

  **That sentence was true of the design and false of the running code, and the
  correction is recorded rather than quietly applied.** `DISPATCH_ROUTED`
  carried the account. `DISPATCH_SENT` — the row the ledger counts as an
  *activation* — was written inside `markDispatchSent` from the dispatch row
  alone, which knows its bin and not its project, account, Routine or class. So
  in production the ledger read `activations: 124` against a single
  `perAccount` entry of `{accountId: null}`, and every project-scoped capacity
  question answered zero. `BinEvent` did not carry the four columns either, so
  even the routed rows that had an account were invisible to anything reading
  through `listBinEvents`. **A column nothing can read is not a ledger entry,
  and an activation nobody can attribute is not one either.** Both halves are
  fixed forward; `tests/dispatchLedger.test.ts` pins the attribution and the
  regression that hid it.
- **A refusal is not misconduct.** Rate limits advance the retry point and leave
  the failure streak alone, so an account at its ceiling is never quarantined for
  being busy. Only failures and no-shows quarantine, and never a refusal however
  many arrive.

  **An authentication failure is not a refusal, and treating it as one stopped
  every dispatch in the fleet.** A token that does not authorize a Routine will
  not start authorizing it on the next tick, so `AUTH` is a fact about *that
  surface* rather than capacity — but the dispatcher ended the whole burst on any
  non-retryable failure, on reasoning that was true when the fleet was one
  Routine. Production measured the cost: eighteen consecutive
  `AUTH 401 "Token is not authorized for this routine"` against one registered
  Routine, the healthy Routine beside it never tried, every surface still
  `ENABLED` because the only thing a failed fire advanced was a counter nothing
  acts on, and a factory bin sitting `READY` with its dispatch `PENDING`. **This
  is the same correction the rate-limit branch already carries, one category
  along.** The surface is quarantined by name at the first `AUTH`, `NOT_FOUND` or
  `PAUSED` — not a tuning decision, which is why it is the dispatcher's and not a
  proposal in `scaler.ts`, and the same rule `fleet_routines` already applies to a
  Routine whose secret is *absent*: left out of routing and reported, rather than
  spending a fire discovering it. The burst then continues, because the next
  routing decision is a different one, and the intent's backoff is short for the
  same reason. `fleet set-state` is the answering transition once the secret is
  fixed. Only `NOT_CONFIGURED` is genuinely fleet-wide.

  **And a fix deployed after the damage does not undo the damage, which is its own
  defect.** The backoff that correction shortened is a *timestamp*, so every intent
  already written kept its twenty-four-hour wall — in production a factory review
  bin sat `READY` with its only intent deferred until the following day, and no
  transition anywhere could answer it. A remedy that cannot reach the state it
  exists for is not a remedy. `rearmSurfaceDeferredIntents` derives the condition
  instead of scheduling it: an intent deferred on `AUTH`, `NOT_FOUND` or `PAUSED` is
  put back when any Routine row has been written since that intent was — an operator
  correcting a secret, re-enabling a surface, declaring a capability or registering
  a Routine are all that same fact. It is self-limiting, because the re-arm stamps
  the intent; it never revives an abandoned one, never touches an intent deferred
  for another reason, and never changes an attempt count.

  **The same sentence is true one level down, about bins, and it was not.**
  `assignNextBin` charged a bin an attempt in the very statement that handed it
  over, so a session refused by the audit independence guard still cost the bin
  one of its assignments. In production one bin spent seventy-one of a hundred
  that way — on arrivals Brain itself refused — and retired with its audit a
  single role from done. **Eligibility is asked before the accounting now**,
  through an injected `admit` hook exactly like `claimWork`'s, and a refusal
  skips the candidate as cheaply as losing the compare-and-swap does: no
  attempt, no lease, no generation. `bin_session_refusals` remembers the pairing
  so the same session is not offered the same bin on a loop, and
  `bins.dispatch_not_before` defers the *fire* — deliberately absent from
  `DISPATCHABLE_SQL`, so the assigner ignores it and a fresh eligible session is
  still handed the bin the moment it asks. None of it is a ceiling: nothing is
  ever refused because of those rows, and the independence floor is untouched.

  **And a refusal must not outlive the moment it can stop being true.** The
  session dimension is the credential a request authenticated with, the Cowork
  connector presents one OAuth access token, and `ACCESS_TOKEN_TTL_MS` is an
  hour — so two activations of one Routine inside one hour are the same session
  and the second is correctly refused the next audit role. What was wrong is
  what happened next: the ladder walked to half-hourly polls and nothing in it
  knew the answer could not change until the token aged out. Production measured
  it on `bin_aa20917c0c1a418895cd` — six recorded session refusals, and
  consecutive roles completing 53, 57, 36 and 61 minutes apart on work that
  takes minutes. **The 53 is the ladder to the digit**: `1 + 2 + 5 + 15 + 30`.
  The token's hour bounds when a distinct session can first *exist*; the ladder
  decides when Brain next *asks*, and only the second is Brain's to fix — a
  session that became distinct at minute twelve was not asked about until minute
  fifty-three. So `recordSessionRefusal` takes an upper bound and clamps the
  rung to it: the ladder, the refusal and every comparison are untouched, the
  bound exists only for a session-dimension refusal on a credential that
  actually expires, and it can only ever move a retry *earlier*, never later.
  **The two tempting fixes are refused and the refusal is the point.** Brain
  issued the token and could revoke it on refusal, and the connector would
  refresh in seconds — which would let the one model context Brain had just
  refused a role come back under a second session id and take it. Shortening
  the token's life is the same hole reached more slowly: a lifetime short enough
  to guarantee a fresh session per activation is short enough to expire *inside*
  one, and then the identity the matrix compares stops identifying a context.
  **Brain cannot manufacture a second simultaneous identity** — §22's "the
  surface owns whether a worker may act" is about *who* a worker is as much as
  what it may do — so what it does instead is stop waiting longer than it has
  to. See `services/research/sessionWindow.ts`.
- **Audit independence is execution lineage, not a role name.**
  `research_passes` records which worker, Routine, account and session produced
  each pass, and `services/research/independence.ts` checks the recorded lineage.
  Unknown lineage is a violation, never a pass — an audit whose independence
  cannot be established did not establish it.
- **Simulated output is structurally labelled and can never be production
  evidence.** `services/dispatch/simulate.ts` results carry a required literal
  `simulated: true` and a content-addressed trace id, so a projection cannot be
  read back as a measurement.

**Audit independence is a rule Brain applies before it hands work out**, and
its floor is **three distinct authenticated sessions** — one each for PRIMARY,
ADVERSARIAL and JUDGE, with no session holding two roles on one orchestration
and the judge beginning only after both arguments are settled and immutable.
`services/research/auditEligibility.ts` holds the minimum per pair as a
constant, because a caller that could choose the level is a caller that could
lower it, and **no count of accounts, workers or Routines appears anywhere in
it.**

**The author of the report is a party to its own audit, and for a long time it
was not. The correction is recorded rather than quietly applied.**
`lineageFromPasses` has always returned `{ synthesis, audits }` — the intent
written down, in a field labelled and typed — and **every caller destructured
`{ audits }` and dropped the other half**, while the separation matrix had no
entry a synthesis could be compared under. So the three reviewers were
separated from each other and **none of them was separated from the session
that wrote the thing they were reviewing**. §23's own sentence states the
threat exactly — *one model context reviewing its own work* — and a session
that files the synthesis and then files the PRIMARY audit on it is the literal
instance of it. `independence.ts` does hold a self-audit rule; it is called by
tests and by nothing in production, which is the fourth time this file has had
to write that **a mechanism nothing calls is not a mechanism**.

Three matrix entries became six — `SYNTHESIS_PRIMARY`, `SYNTHESIS_ADVERSARIAL`
and `SYNTHESIS_JUDGE`, all three named because an adversarial critic of its own
report and a judge of its own report are the same defect one step along. The
**level did not move**: every pair is still `SESSION` and still names no
topology, so the correction that removed the two-account requirement is not
reintroduced by this one — the same account may still review its own author's
work from a different activation, which is what keeps the floor reachable on a
one-Routine fleet. What changed is the set of parties, not the bar.

Two readers had to change with it or the entries would have been enforced by
nothing: `auditMatrixVerdict` looks each party up in a map, so a matrix key
naming `SYNTHESIS` with no row for it would `continue` past both new pairs
silently. And the two things that could *answer* the question could not: `step10
audit-lineage` filtered to `passKey === 'AUDIT'` one line before the matrix
could have used the author's row, and `packet-report` read the synthesis pass
only for its cited claim ids. Both print the author beside the reviewers now.
`independenceEvidence.ts` gained the pair as a per-packet condition
(`AUTHOR_IS_NOT_A_REVIEWER`) and a live probe of the refusal, because a
strengthened constant that nothing exercises is a claim rather than a reading.

**A rule that arrives after the fact needs a way to correct what it found, and
that is a second reason a round may begin rather than a second use of the
first.** The matrix stops the pairing happening again and changes no recorded
row; the packet it found was already `COMPLETE` with a `PASS` verdict. The
obvious instrument was to hand: `auditRound.ts` starts a round from an
`OTHER_LAYER` handoff and makes three roles outstanding again without editing
anything. It is the wrong one — a handoff asserts that a document moved layers,
and **making the rows say something untrue to get a lookup to come out right is
what that module was written to refuse.** So `services/audit/integrityReaudit.ts`
is its own event, `AUDIT_ROUND_REOPENED`, with its own append-only record.

- **It destroys nothing.** The superseded audit keeps its row, its verdict, its
  gaps and its `created_at`; every pass keeps its raw response, its lineage and
  its timestamps; the document keeps its bytes, version, hash and storage key.
  What moves is a boundary in *time*, which is why neither reason has to edit
  history to work.
- **The reservation is bound to the bytes, and the key is server facts only** —
  the orchestration, the document, its content hash, the finding. §20's shape at
  a smaller scale: `UNIQUE (request_key)` makes a duplicate request, a retry
  after a lost response and a restart mid-request one outcome, and a document
  whose bytes changed is a *different operation* rather than a repeat. An open
  reopen whose document no longer hashes the same is `SUPERSEDED_BY_VERSION` and
  never `RESOLVED`: nothing re-audited anything, and the two words must not mean
  the same thing.
- **A replay re-reads and re-authorizes.** The stored requester is a record of
  who asked, never a credential, so revoked access is refused at the retry from
  current rows — in the same words a non-member gets. A worker cannot reach it
  at all, by principal type.
- **Which roles rerun is derived from lineage, never chosen.** A role is carried
  forward only if its session authored nothing, no role it is built from is
  being rerun, and it has a completed pass to carry. The dependency closure is
  read from `auditBriefFor`, which composes the adversarial prompt out of the
  primary's own output and the judge's out of both — so a replaced PRIMARY
  reruns everything after it, and **an old JUDGE verdict can never validate a
  replacement PRIMARY**. The packet's `verdict` and `audit_id` pointers are
  cleared while the `audits` row stays exactly as written, and the reopen
  settles only on an audit id that differs from the superseded one *and* a judge
  pass completed after the boundary.
- **Carrying a role forward is not copying it.** `auditRoundFor` returns the
  boundary and the carried ordinals together, because a reader that took the two
  from different events would offer a role as satisfied against a boundary that
  postdates it. Three readers share it — the brief, the runner and the admission
  check — for the reason the boundary itself has four.
- **A transition that reopens work must also enqueue it, and this one did not
  — the correction is recorded rather than quietly applied.** The first real
  reopen ran in production on 2026-09-12 and did everything it was supposed to:
  a reservation bound to `v1E`, three roles to rerun, the previous round's items
  cancelled, the packet back to `AUDITING` with its verdict cleared, a bin
  READY. Brain fired fifteen seconds later and a worker arrived fifteen seconds
  after that — and released at 13:34:17 saying **"No open work item exists yet
  for this reopened audit round"**, because nothing had called `advancePacket`.
  It was fired again immediately. Left alone that is a loop which looks like
  progress and ends with the bin's attempts spent against a packet whose own
  state said a worker should be working. `advancePacket` is what turns AUDITING
  into a claimable item and **every other reopening transition calls it** —
  `startPacket`, `reissue`, `surfaceRecovery`, `needsHuman`, the launch and the
  submit tools. §24's sentence at a fifth altitude, and §27's beside it: a stage
  becomes fireable when something makes it fireable, and the reopen is that
  something. Ahead of the bin, so there is no window where the fire exists and
  the work does not. **The fixture is why reading did not find it**: it had a
  filed document and no fragments, which production cannot produce, and with no
  fragment `advancePacket` walks to the planning branch instead of the audit
  one — so the tests pin the queue an arriving worker sees rather than the call.
  **The replay had to assert it too**, which is the same mistake one move along:
  the advance went on the winning path only, so re-running the command against a
  round already opened would have answered "nothing was opened twice" and left it
  empty. **Idempotency means the effect is present after either call, not that
  the second call does nothing.** Safe to repeat for the same reason it is safe
  at all — idempotent by the round, not by a flag. Cancelling the previous
  round's items and building a bin stay on the winning path, because those are
  not.
  **And the round already in that state needed somewhere to run, which is the
  third move of the same mistake.** Those five refused activations spent the
  bin's five attempts, so it retired at `NEEDS_HUMAN` — and a live round whose
  only bin is terminal is a packet nothing can be sent for. A replay reuses the
  bin while it can still deliver and builds a new one when it cannot; the spent
  one keeps its row, its attempts and its events. The five workers were not the
  defect and are worth recording as the opposite: each read the state correctly,
  said so precisely, and released rather than inventing a report.
  **And one reader lied about the corrected round.** `binForOrchestration` was a
  `SELECT` with no `ORDER BY`, fine while a packet had one bin and wrong the
  moment a reopened round gave it a second: it returned the spent bin while the
  live one was running the replacement review, so `packet-report` printed *"1
  claimable item(s) and the bin is COMPLETE: nothing can be sent for this
  packet"* about a packet being worked on at that instant. **A warning that
  cries wolf is worse than no warning** — it teaches a reader to stop believing
  the one place that says a packet is genuinely stranded. The paragraph directly
  above it already named the defect and the neighbour was left standing; it
  orders a deliverable bin ahead of a spent one now, newest as the tiebreak,
  deterministic in both dialects.
- **The independent round reached a different answer, which is the point.** It
  ran on its own: PRIMARY 15:51:53, ADVERSARIAL 16:26:36, JUDGE 17:30:08, in
  three sessions distinct from each other and from both synthesis sessions, the
  judge's stamp after both arguments. `air_fdf0af5981c0404389e6` is RESOLVED on
  `aud_b057009fcf5a4c8f8692`, which differs from the superseded
  `aud_b84704fe7b3542a7a184`; both audit rows and all ten passes stand. **The
  verdict is `PATCH`, not `PASS`** — an `OTHER_LAYER` gap that handed the
  document to Execution Playbooks, and a `PATCH` gap saying the summary
  overclaims Oakland County's e-recording status as verified-current. The round
  the author reviewed passed the report; the round it could not reach did not.
  An independence floor that never changes an outcome has not been tested.
- **A mission is not the only thing that can ask a packet a question.** Four
  hours after the reopen, `concludeAbandonedParks` cancelled the packet saying
  *"The mission that asked this question is DONE, so nobody is going to answer
  the decision this packet stopped at."* `PATCH` does not advance, so
  `NEEDS_HUMAN` was right; the mission had finished that morning; and the sweep
  reads the mission as the only possible asker. The asker was the reopen, an
  administrator asked at 13:31:53, and it was waiting for that exact answer. The
  guard names the two row shapes that say otherwise — an OPEN reopen, or a
  RESOLVED one whose audit *is* the packet's current verdict — and
  `restoreWronglyConcludedParks` reaches the packet already cancelled, because a
  fix deployed after the damage does not undo the damage. The cancellation stays
  on the history and `RESEARCH_PARK_RESTORED` says why it came back.
- **Attribution is not authentication, and `047` said it was.** It called
  `requested_by_id` "the authenticated principal". `--admin <email>` resolves an
  enabled administrator from `users`: that establishes such a person exists and
  may authorize this, and nothing about who typed the command. Reaching the
  shell is what authenticated it (§26) — here a GitHub Actions job holding the
  deployment credential, running `flyctl ssh console`, dispatched by an agent on
  a recorded instruction. **Recording that as a browser approval would be
  undetectable afterwards**, so it is two columns: `requested_by_id` is whose
  authority it carries, `authority_channel` is how the call got in, and
  `executed_by_ref` is whatever the caller claimed, read back as reported. The
  channel defaults to the weaker, unverifiable value, because Brain cannot check
  a channel and must never assume the stronger one — unknown lineage failing
  closed, at a new column. Every reader prints both.
- **The scan reports and does not act.** `npm run admin -- packets independence`
  names every packet whose reviewer shared a session with an author, and opens
  none of them, because that decision is a person's. It reports a packet whose
  sessions were never recorded **separately** from one where the author
  demonstrably reviewed: *we could not tell* is not the same fact as *we
  checked*, which is this whole repair in one column.

**This is a recorded correction to the original two-account requirement, not a
silent weakening.** The threat an independent audit exists to defeat is *one
model context reviewing its own work*. Three separate sessions defeat it. Two
accounts also defeated it, and additionally made a finished product unfinished
whenever one particular subscription was unavailable — a completion dependency
on temporary fleet topology, which account and Routine counts are. So the
requirement moved to the property that actually does the work, and the stronger
property became an optional tier.

- **The preference is a ladder, strongest first: account > worker > Routine >
  session.** `services/research/auditAdmission.ts` ranks the surfaces that
  could take a waiting role and reaches for the strongest, which is a
  *preference* and never the authorization — the arriving session is judged on
  its own recorded lineage, so the allocator is free to be optimistic.
- **`ROUTINE` is a tier of its own, not a synonym for worker.** One account may
  hold several Routines and one worker may be bound to several; conflating them
  would report a separation the fleet does not have.
- **What was achieved is recorded, never rounded up.** `SESSION_SEPARATED`,
  `ROUTINE_SEPARATED`, `WORKER_SEPARATED`, `ACCOUNT_SEPARATED` — and a
  same-account result is never described as cross-account independent.
- **A mission may ask for a stronger tier, and asking costs only that mission.**
  If the fleet cannot supply it the mission parks with the exact missing
  capability, nothing is reserved or created, and the next tick launches it by
  itself once the missing account, worker or Routine is registered. It never
  makes anything else incomplete.
- **`future:<routineId>` is a prediction and never evidence.** It is how the
  allocator reasons about an activation that has not happened, which is what
  makes the session floor reachable on a single Routine. Final evidence must
  carry three real authenticated session references, and the predicted form is
  refused by name.
- **A fleet with nowhere to run an audit says so in those words.** The blocker
  is `NO_HEALTHY_EXECUTION_SURFACE` — an operational fact with an operational
  remedy — never a missing account and never a named person.

- **The decision happens before the lease.** `claimWork` takes an injected
  `admit` hook and asks it *inside* the claim loop, ahead of the
  compare-and-swap. A refused worker consumes no lease, no attempt, no
  generation and no history — indistinguishable from losing the race. Checked
  after the claim instead, every ineligible glance would burn one of an audit
  item's two attempts against the rule meant to protect it.
- **It is asked at every entrance** — the MCP tool, the bin service and the HTTP
  route — because a guard on one entrance is not a guard. And again at the
  judge before storage, because a lease can expire and be retaken, so eligible
  at claim time is not eligible at submit time.
- **Nothing asks a Routine to police itself.** The worker comes from the
  authenticated principal, the Routine and account from
  `fleet_routines.worker_id`, and the session from the credential the request
  authenticated with. No body field contributes, so a Routine cannot declare
  itself independent.
- **Unknown lineage fails closed.** A worker bound to no registered Routine has
  no resolvable account and is refused, because "we could not tell" must never
  read the same as "we checked".
- **A surface serves a workload family, or it is not fired for one.** The fire
  router reads the same `worker_routing` row the admission hook reads (§27) and
  refuses by name — `NO_SURFACE_SERVES_THIS_FAMILY` — rather than reporting the
  nearest available refusal, because "no capable surface" sends an operator to
  look at capabilities when the answer is a scope. A Routine whose worker has no
  recorded scope is *eligible*, not refused: a scope Brain has not been told is
  unknown rather than empty, and this is the half of the decision that can only
  waste a fire. The half that could record something false — a claim — fails
  closed at the admission hook instead.

**Never infer fleet capacity from account count.** Throughput is measured per
account, Routine, workload class and reset period, or it is reported as unknown.

**Two accounts are registered live with distinct credential digests, and Brain
has fired both.** `primary` / `V1` runs the same trigger Step 10 used;
`friend-2` / `V2` is registered under its own deployment secret. As of
2026-09-04 the ledger reads V1 fires=15 and V2 fires=9 with **zero refusals on
either**, and the production independence evaluator's distinct-credential
condition passes — so the two rows are not one subscription registered twice.
Routing, distribution and failover across accounts are therefore proven in
production, in addition to the tests on both backends. Ready to routed measured
5.2s and ready to terminal 44.5s.

**What is not proven is cross-account audit *diversity*, and that is a
different thing.** Both Routines are currently bound to one worker identity, so
an audit run across them resolves to one worker and the achieved tier is
`SESSION_SEPARATED`. Under the corrected contract that is a complete,
passing audit at the floor — reported truthfully at the tier it earned, never
labelled cross-account. **Cross-account diversity is an optional stronger
assurance tier and a later Capability Lab measurement. It is not a completion
dependency of Step 11 or of Step 12A.** Binding a second worker to `friend-2`
raises the achieved tier with no code change and no deployment.

**Step 11 is closed.**

Running it found a defect reading alone had not. Every successful fire advanced
`consecutive_no_shows`, nothing in production ever recorded a session arriving,
and `bindRoutineWorker` documented a check-in path that did not exist — so a
healthy Routine walked toward quarantine while its workers were plainly turning
up. **A counter that only goes one way is not a health signal.** The arrival is
now credited from the dispatch row that produced the worker, never from anything
the worker says about itself, and a takeover of an expired lease credits nothing
because that session genuinely did not finish.

## 24. Russell is a way in, not a second brain.

Step 12A (`server/services/russell/`, `client/src/russell/`,
`docs/STEP-12A-PLAN.md`) turns the smallest genuine Russell on: a conversation
that grounds itself in a project, forms its own opinion about what is worth
doing, checks the archive before it spends anything, takes a cheap look or
refuses, launches one mission through the pipeline that already exists, and
tells a person what happened in words. Everything it adds is a new *entrance*
to machinery Steps 4 to 11 already built, and none of it is a second set of
rules.

- **A model proposes; the server decides.** `services/russell/proposal.ts` is
  §8's rule applied to a conversation. Actions come from a closed set matched
  exactly, an unknown field refuses the *whole* proposal, and every project
  reference is re-resolved with `decideProjectAccess` against the authenticated
  principal. Injection-shaped text is flagged and stored verbatim, never
  filtered: removing it destroys the evidence somebody tried, and the actual
  control is that nothing found inside text is ever executed.

  The same shape decides deduplication by meaning, which nothing could do
  before: `fingerprintOf` is exact and cannot see a rewording, so the worker
  that read the conversation names the idea it believes this repeats — and
  `capture` re-resolves that id **in scope**, refuses one already merged, and
  holds the two statements to `SEMANTIC_MERGE_FLOOR` before merging anything.
  Neither half is sufficient: the claim alone would let a confident model fold
  unrelated ideas into one, and the floor alone cannot recognise a rewording. It
  is a guard, never the decision, and it only ever *refuses* — which is why the
  merge is reversible with `splitCandidate` and both rows stay readable.
- **A turn is validated against the conversation owner's authority, never the
  worker's.** The effects land in the owner's scope, so a worker that could
  widen a thread's reach by answering in it would be escalating through a chat
  box. Memberships are read at the moment the effect happens.
- **Claim, then act.** `resolveMessage` and `claimWriteback` are
  compare-and-swaps, and the effect belongs on the far side of them. The queue
  is at-least-once, so an effect performed before the guard is an effect that
  repeats on every redelivery. The crash window this opens loses an effect and
  shows the answer, which is the right way round when the effect is a capture a
  person can simply repeat.
- **Brain chooses where a probe looks.** `probeEnvelope.ts` is §16's approval
  envelope at a smaller scale and for the identical reason: nobody supplies the
  limits their own work is judged against. A proposal supplies a question, and
  it is carried as an encoded query value into a URL Brain wrote — never a
  host, a path, a scheme or a redirect. A redirect off the allowlist is refused
  rather than followed, the observations table *is* the lookup budget rather
  than a log of it, and a probe's verdict is a claim about presence, never
  about truth. Widening that envelope is a code change somebody reviews.
- **Every escalation has an answering transition.** A turn whose bin ends
  `FAILED` or `CANCELLED` is closed with a truthful message; `NEEDS_HUMAN` is
  deliberately left alone because it has its own guarded way out. A launch
  interrupted between its steps is finished by re-entering `completeLaunch` —
  the specification is read back from the candidate's own recorded judgment,
  which is the identical source the loop launches from — and one that genuinely
  cannot be rebuilt is reported as **orphaned** rather than marked finished.
  Visibly stuck is recoverable; silently complete is a mission nobody looks at
  again.

  **That guarded way out was itself half a transition, and the correction is
  recorded rather than quietly applied.** Answering a Needs You request flipped
  the mission back to `RUNNING` and marked the request resumed — while the
  *packet* underneath stayed at `NEEDS_HUMAN`, so the next tick would have
  parked it again. A person could have answered the same question every time it
  reappeared and never learned that their decision was recorded and ignored.
  That is §24's own sentence at a third altitude, and it survived because
  nothing ever produced the park: `askHuman` had no caller and nothing wrote a
  mission into `NEEDS_HUMAN`, so the test that proved the resume built its own
  starting state. `services/russell/needsHuman.ts` is both halves —
  **Brain derives the park from the packet's own recorded status**, never from a
  worker saying it needs one, and every choice offered is one something
  implements. An answer this version cannot carry out stays visible rather than
  being marked resumed.
- **A mechanism nothing calls is not a mechanism.** Walking the whole journey
  found five transitions that existed, were tested, and could be reached by
  nothing: a semantic merge, a person's override, the decision a settled probe
  is *for*, the automatic follow-on, and the park above. Every one of them was
  invisible to a test that arranged its own starting state, which is why
  `tests/russellIntegrationPass.test.ts` walks the journey once from a person's
  first message and simulates only the worker and the network.
- **A link is a fact about now, and non-null is not the same fact as current.**
  A mission's `document_id`, `audit_id` and `layer_id` are a projection of its
  packet, and the writeback reads all three — `recordKnowledge` files the
  conclusion under the layer and attaches the document and the audit as its
  provenance — so those three columns decide what the project ends up believing
  and under which heading. `linkFiledWork` filled them once and returned early
  whenever both were set, which is correct exactly while a packet is audited
  once; §22's `OTHER_LAYER` handoff is the case where it is not. Its lookup
  failed in the same direction: it took the *last* element of a newest-first
  list, so with two audits in one run it chose the older one every time. In
  production a packet that passed a compliant second round wrote back citing the
  first round's `MORE_RESEARCH` verdict — the one that said the work belonged
  somewhere else — filed under the layer it had left. **The correction is
  recorded rather than quietly applied**, because nothing about it looked like a
  failure: the mission read DONE, the packet COMPLETE, the report filed and
  audited, and only the ids disagreed.

  `services/russell/completionLinks.ts` is one derivation with two readers — the
  link taken before a writeback, and the reconciliation of a mission that
  already took one — for the reason `auditRound.ts` is one module: a rule
  applied by one of two readers is worse than none, because the two would
  disagree about the same mission. The handoff moves all three ownership rows
  itself rather than leaving the third to whichever consumer notices. And a
  mission that already wrote back is corrected **in place**: the pointer and the
  projection move, every audit, pass, claim, document, message and id stays
  exactly as written, and an append-only `RUSSELL_LINKS_RECONCILED` row carries
  every before and after. A superseding knowledge row was the obvious
  alternative and would have asserted a change of belief that never happened —
  the conclusion and the evidence were right all along; only the citation was
  wrong.
- **A compiler cannot judge whether a look is worth it; it can read whether
  there is something to look at.** Mutation 29 replaced the planning worker
  with a deterministic compiler and recorded the visible consequence honestly:
  an idea could no longer be sent to `EXPLORE` because a look would be cheap,
  since nothing could form that view. That was true of a *semantic* view and it
  left the automatic probe path reachable only when the archive positively
  contradicts an idea — so Brain had, in practice, lost the ability to look
  cheaply before spending a packet. **The correction is recorded rather than
  quietly applied**, because half of that sentence still stands: nothing here
  assesses what settling a question is *worth*, and `expectedValue` is still
  `NOT_ASSESSED`.

  What changed is that "would a cheap look settle this" turned out to have a
  form that is not semantic. `PRESENT_BUT_UNVERIFIED` and `STALE` are two of
  the ten coverage statuses and both say the same thing: the project already
  holds a candidate answer that nothing supports, or one that was true outside
  the timeframe asked about. Confirming or refuting it is a *presence*
  question — the only kind `GENERAL_LIGHT_PROBE_V1` answers — and a full packet
  is the wrong instrument. So `judgeCandidate` derives `cheapToReduce` from
  those rows and from nothing else: no unverified or stale claim, no probe. It
  is narrow by construction rather than by tuning, forms no opinion about
  value, reads no prose, and cannot lower any evidence bar. It is forced false
  on the pass *after* a probe, and that is load-bearing now rather than
  incidental — the archive does not change when a probe settles, so
  re-deriving it there would send the idea round for another look for ever.

- **A pass records the account it executed under, and that comes from the fire
  rather than from the wiring.** `research_passes.executor_account_id` has
  existed since Step 11 and was null on every row this Brain ever wrote, so
  `A11_INDEPENDENT_AUDIT` read `NOT_RUN` over three genuinely independent
  passes. `lineageForWorker` resolved the account from the static
  worker → Routine binding, and production binds two Routines under two
  accounts to one worker identity; two candidates is ambiguous, and ambiguity
  fails closed. **The attribution was missing, never the independence.**

  The account was never ambiguous. Brain fired one Routine for one bin, and the
  session that arrived and took that bin is that fire's session. `worker_sessions`
  is that observation, written at arrival from the same `bin_dispatch` row
  `creditDispatchArrival` already credits the arrival from — never from
  anything the worker says about itself, first observation winning, and nothing
  written at all when the Routine does not resolve to an account. The static
  binding stays as the fallback for a worker that reached Brain without an
  assignment, and it still fails closed: "we could not tell" must never read
  the same as "we checked".

- **A packet that has finished holds nothing a worker can be sent for.**
  `advancePacket` retires outstanding work, and only something *advancing* a
  packet calls it — which nothing does once a packet is terminal. So a packet
  that ended while items were outstanding kept them claimable for ever, and the
  first production one did: `COMPLETE`, filed and audited, with two
  `RESEARCH_AUDIT` items still `LEASED`. An expired lease is claimable work
  (§19), so that is a worker Brain can still send for a settled question. It is
  reconciled from rows on the durable tick, fleet-wide rather than
  Russell-scoped, and cancelling is not destroying: the fencing generation
  advances, so a late completion matches nothing, and every row keeps its id,
  its attempts and the reason it stopped.

- **What a person is shown about coverage is what the auditor read.**
  `reconcileAcceptedFragment` moves a requirement's coverage when a fragment
  clears all seven gate conditions, and it had exactly one caller — the
  in-process orchestrator, not the worker-driven runner production uses. So a
  requirement whose evidence was accepted still read `MISSING`, on a packet
  that was `COMPLETE`. It now runs from `gateFragment`, which is the single
  place a fragment becomes `ACCEPTED`, because a guard on one entrance is not a
  guard. It changes no evidence: nothing there accepts, rejects or re-judges a
  claim.

- **An attribution that only observes forwards leaves history unreadable, and
  the remedy is rows rather than another run.** `worker_sessions` records which
  fire produced a session at the moment that session arrives, which is the right
  place and the wrong direction for everything already written: every audit pass
  from before it carries no account, and a gate reading those rows cannot tell a
  missing attribution from a missing audit. The recovery is
  `services/dispatch/lineageRecovery.ts` and it is only honest because of what
  it refuses — it walks the credential to the bin to the dispatch Brain sent to
  the Routine's account, never the static worker binding; a session two Routines
  could have started is left unresolved and said to be; a dispatch at or above
  the lease's own generation belongs to a later assignment; and every write is
  guarded on the column still being null, so a recovered value can never replace
  a recorded one. §5 at a column.

- **The compiler runs before the judgment, so an idea Brain cannot specify is
  never assessed for whether a cheap look would settle it.** That ordering is
  right — a bounded look is not a remedy for an unspecifiable question — and it
  means the probe path is reachable only for questions the standing envelope can
  carry. A question naming a jurisdiction outside it is refused there and parks,
  even when it names that jurisdiction to *exclude* it: `jurisdictionFor` matches
  state names and must not start inferring intent from the words around them,
  because a compiler that read intent would be the model judgment §8 keeps out of
  state. What changes in that case is the question, never the compiler.

- **A fire nobody answers strands its bin for ever, because the intent table
  cannot hold a second row for it.** `bin_dispatch` is `UNIQUE (bin_id,
  lease_generation)` with `ensureDispatchIntent` as `ON CONFLICT DO NOTHING`;
  `claimDispatchIntent` sees only `PENDING` and `SENDING`; and the generation
  advances when a worker **takes a lease**. A session that never arrives takes
  no lease, so no generation, so no intent, so no second fire — which is
  verbatim the state `services/dispatch/loop.ts` opens by saying it exists to
  prevent. `reopenNoShowDispatches` derives it: a `SENT` intent whose bin is
  still `READY` **at the very generation that intent names** has had nothing
  handed out since, and past `IN_FLIGHT_WINDOW_MS` it is reopenable — the same
  constant `inFlightByRoutine` counts by, passed rather than restated, so
  ceasing to count as an activation and becoming reopenable are one instant and
  a double fire has no window to live in. It gives up out loud at
  `max_attempts` rather than quietly: five unanswered fires is a surface problem
  a person must fix, and a bin visibly out of attempts is worth more than one
  silently waiting.

- **A mission going terminal does not finish the packet it owned, and a park
  nobody will be asked about keeps its work claimable.** Seven production
  packets sat at `NEEDS_HUMAN` under a terminal mission, one of them holding a
  `RESEARCH_FRAGMENT` at attempt 3 of 2 on an expired lease — claimable work
  (§19) for a question abandoned three attempts earlier, and
  `reconcileTerminalPackets` could not see it because `NEEDS_HUMAN` is not a
  terminal status. Both halves are wrong on their own: the status says a person
  must decide when nobody will ever be asked, and the queue keeps offering the
  work. It is **not** the fail path's defect — a person answering STOP leaves
  the identical state — so the remedy is derived from rows
  (`concludeAbandonedParks`) rather than hooked to the moment a mission ends,
  because a hook fixes one entrance and the rows reach every entrance plus the
  ones already stranded. `CANCELLED` rather than `FAILED`: the packet's own
  recorded reason stands untouched, and what changed is that the thing which
  asked the question stopped wanting the answer.

- **A packet's work reaches a worker inside a bin, so a live packet whose bin
  cannot deliver is a packet nothing can be sent for.** Two ways in: a bin
  parked at `NEEDS_HUMAN` on a condition that has since been resolved, and a
  bin that legitimately *completed* before its packet was put back to work by a
  handoff. Neither shows in any state column — the queue says the items are
  claimable and every row reads as healthy — so `packet-report` prints the bin
  and says so in words. The remedies are the ones already there: the guarded
  reopen for the first, the launch's own bin for the second, with the spent bin
  keeping its row. Both are derived from the bin's *current* budget and state
  rather than from catching the moment a condition changed, which is the third
  time that has been the difference between a fix that reaches production and
  one that does not. Neither adds a ceiling: the work items' own attempt
  counters are the bound, and a packet whose items are spent goes terminal by
  itself.

- **`COMPLETE_WITH_GAPS` is a verdict about the report, not a fragment that
  failed** — the judge asked for more, nothing could be repaired, and a person
  authorized filing short. So the question such a packet leaves behind is the
  one the *judge* named, read from `audit_gaps`: a classification the domain
  already says may keep research open, and a bounded question the judge
  actually wrote. A finding with no question stated is a finding, and composing
  one from its prose is exactly the model-prose-as-state §8 forbids. The
  requirement route still runs first; it simply cannot fire for a compiled
  mission, because the compiler makes one fragment per idea and a packet that
  files at all has that fragment accepted.

- **A work item is finished by its owner, and reconciled only once its owner is
  gone.** An audit item hands out one role and the pass is that role's whole
  output, so an item still leased after its pass is recorded is a role that will
  be argued again the moment the lease lapses — production argued one three
  times while the judge waited, correctly, for both arguments to be *settled*.
  Brain retires such an item from its own rows, in the packet runner and never
  in the tool: finishing somebody's item inside `brain_submit_audit` makes their
  own `brain_complete_work` fail its ownership proof, and the queue is right to
  refuse that. Neither that reconciliation nor the terminal-packet one may touch
  an item whose lease is still live — the condition they exist for is an
  *expired* lease on work claimable again for a settled question, and a packet
  goes terminal while its judge is still holding the item it just used.

- **The capture gate held every hedged way of asking for work and not the plain
  one.** `should we`, `worth checking` and `look into` were markers; *"Please
  check something for me… Go and see whether that holds"* was not, and had no
  question mark either, so Brain declined a direct request with "nothing here
  proposes work". The widening is narrow by construction — the verb is asked of
  somebody, or followed by the thing to establish — because the list's failure
  mode must stay *missing* a candidate rather than inventing one: a past-tense
  report and a bare "please look at this" still decline. Rewording the question
  to hit an existing keyword was the alternative and would have been gaming the
  list rather than fixing it.

- **The capture list's rule was right and its alphabet was short, three times
  over.** It held every hedged form and not the plain one; then it held
  `check` and `see` and not `establish` — the verb in its own stated rule,
  *"asked of somebody, or followed by the thing to be established"* — so
  production declined *"Please go and establish, county by county for
  Michigan…"* with "nothing here proposes work" eighty-six seconds after asking.
  Each widening is two verbs and no more, and the failure mode is what the tests
  pin rather than the successes: a past-tense report still matches nothing,
  because the word boundary excludes it and nobody is being asked. The question
  that found the gap is never reworded to fit the list — rewording is gaming the
  list, and what changes is Brain.

- **A coverage score whose denominator is the question measures how the question
  was asked.** `relevance` is `hits / wanted.size` over the *requirement's*
  vocabulary, so a longer requirement scores lower against the identical claim.
  That is right for what `coverBeforeWork` was built for — the compiler writes
  one bounded, term-dense declaration per fragment — and wrong for the free
  prose `askArchive` feeds it: a 454-character statement carries forty terms
  against a claim sentence's fifteen, so a perfect subject match cannot reach
  the floor and the archive reads `MISSING` because the question was asked at
  length. §13 then fails in the expensive direction, spending the allowance to
  learn what the project had already written down. **The remedy is to ask about
  the question in every form Brain holds it, never to tune what "about" means**
  — the candidate's title is the third reading and the only short one, and
  `relevance` is untouched, so no other caller changes. Neither direction lowers
  a bar: `fullyAnswered` needs every reading to agree, `unverified` is a union,
  and a probe still requires a real unverified or stale claim row.

- **A row is not a decision, and a card must not argue with itself.** The park
  condition was `fragments.length > 0` — a row count standing in for "there is
  something to decide" — so a packet holding one refused fragment, no claims and
  nothing accepted parked, and `choicesFor` then offered exactly one answer while
  the card's own explanation said the honest answers were *"to stop it or to ask
  a narrower question"*. **The condition is the offer**: park only where more
  than one thing can be chosen between, which is the module's own rule applied
  where it is true rather than where a proxy agreed with it. Nothing is
  abandoned quietly — the mission is `FAILED` with the packet's own words, the
  event is on the project's history, every refusal keeps its row and its reason,
  and `redoable()` may offer another try. The same defect lived one door along:
  `reopenAnswered` re-derived the **choices** and left the **words**, so a
  request opened when the bar was nearly met could come back carrying only STOP
  and still explain that the bar was nearly met. The words move with the
  choices, from the same shape and the same functions.

- **`A13_AUTO_NEXT` is downstream of `A14_HUMAN_RESUME`, and that is the rules
  holding rather than a gap.** The compiler declares no follow-on, so a compiled
  mission's only route is `unresolvedFollowOn`, which requires
  `COMPLETE_WITH_GAPS`, which requires `unresolved_gap_policy = 'RECORD_GAPS'`,
  which only `recordGaps` writes — the RECORD_GAPS answer to a Needs You
  request. A follow-on therefore exists only for a packet that filed short, and
  filing short is a decision the domain reserves to a person. One decision
  closes both conditions, and neither can be closed without it.

- **Acceptance is a small declared suite, not one overloaded chain.** One
  conversation was right while the acceptance was one journey, and stopped
  being right the moment that journey succeeded — because a cheap look taken
  *instead* of a packet, a question the evidence could not settle, and the
  decision that follows it are all branches success does not take. Requiring
  one packet to exhibit them would be requiring it to finish badly, and a
  packet that truthfully settles everything must keep producing no follow-on
  and no park. So `ACCEPTANCE_SUITE` names each scenario, its purpose written
  down before it ran, and its own chain. **No gate is relaxed**: each still
  requires its complete original evidence, walked from a declared anchor
  through real foreign keys, and the union is three conversations rather than a
  database. A scenario declared by title resolves only on an exact, unique
  match — an anchor somebody could add to is not a declaration.

- **Two boundaries meet at the HTTP surface and they are not the same
  boundary.** A project is guarded by `decideProjectAccess`; a conversation is
  guarded by its owner, plus read access to the attached project for a shared
  thread. **A Brain administrator is not entitled to somebody's private
  thread.** Both refuse with the same 404 *and the same body*, because a status
  code that matches while the body differs is still an oracle. A worker
  principal is refused at the conversation routes by principal type: no
  membership configuration turns a machine into a person.
- **Translation may simplify; it may not invent.** Progress is milestone-backed
  or non-numeric, and there is no code path that turns a feeling into a
  percentage. A briefing answers what changed, why it matters, what is next and
  whether a person is needed, in that order. Layer names reach a person through
  one tested mapping.
- **The decision that lets Russell act is a proposal to approve, not a form to
  fill in.** Moving the grant into Russell was half the correction; the other
  half is that it still asked a person to configure machinery. The card arrives
  prefilled — the purpose derived from the project, the one limit from the
  server's own suggestion, the bounded rollout expiry as a fixed instant that
  never rolls forward on a refresh — and offers one **Approve**. *Change
  details* reveals the detailed controls, which start hidden. Reading the card
  creates nothing.

  **The status around it has to agree with it.** The briefing said "You are not
  needed" directly above an approval that had to be given before anything could
  run, and the nav badge showed nothing, because both counted
  `russell_human_requests` rows and an ungranted project has none. A status that
  contradicts the control beside it is worse than no status: it teaches a person
  to stop reading it. An outstanding approval is now the decision it is, named
  first because nothing else can proceed until it is answered.
- **The decision that lets Russell act is made in Russell.** A standing
  authority names the project, the class of work, how much may run at once, and
  an expiry, and `services/russell/authority.ts` renders all of it as sentences
  the server composed — a screen that paraphrased a permission would eventually
  paraphrase it wrongly. It sits in **Needs You**, because that is exactly what
  it is: the one thing Russell cannot decide for itself and cannot proceed
  without. The limits travel down with the view rather than being duplicated in
  the client, so the contract a person is shown and the contract the validator
  enforces are one object — the manifest lesson, applied to a form.

  **Nothing about the enforcement moved with the surface.** `checkAuthority` and
  `reserve` are untouched, `owner_user_id` still comes from the principal and
  from no field, the prohibitions are still the constant nobody supplies, and
  every ceiling that still exists is spent through the same compare-and-swap. A
  live grant is not silently replaced — two active grants would make "the limits
  you set" ambiguous and `checkAuthority`'s choice an accident of ordering — and
  withdrawing one keeps it, with its reason.

- **Authorized work does not run out; it is bounded by what may run at once.**
  The grant carried four numbers and three of them — missions, fragments,
  probes — were lifetime quotas: reaching one stopped Russell until a person
  topped it up. Nothing was scarce. The subscription behind the work is already
  paid for, so those numbers measured a starting point and then became a
  permanent ceiling, which the original specification had already said must not
  happen. **The correction is recorded rather than quietly applied**, because
  the machinery built on top of them was real: a raise route, a raise control, a
  briefing line telling a person to replenish, and a per-packet
  `maxFragments: 1` in the acceptance envelope.

  What replaced them is an explicit policy on the grant rather than an enormous
  number pretending to be unlimited. `russell_goals.work_policy` is `UNCAPPED`
  for everything the product issues; `ceilingsFor` returns `null` for those
  three kinds; `reserve` skips a null ceiling. `CAPPED` is what grants that have
  already **ended** carry, because saying what actually governed a decision is
  the difference between recording history and rewriting it — it is not a
  policy this product offers, and no live grant has it.

  Four things did **not** move, and the removal is only safe because of them:
  **concurrency**, which is real provider capacity rather than an allowance and
  still refuses the second simultaneous mission; **the reservation rows**, which
  are still written, still counted and still shown as *used so far* with no
  denominator — removing the stopping rule is not removing the evidence; **the
  evidence standards**, the gate, the verification pass, the three audit roles
  and the approval envelope's scope conditions, every one of which applies per
  fragment, so a broader decomposition is more fragments to refuse rather than
  more room to hide in; and **the prohibitions**, so paid overages stay off,
  `max_external_spend` stays 0, and nothing here authorizes a purchase, an
  outreach or a publication.

  There is therefore no "Raise this limit" anywhere in normal operation, and
  changing concurrency is what it always should have been: withdraw the grant
  and make a new one, deliberately. That used to destroy the spend history,
  which is why the raise existed; it no longer matters, because the history no
  longer stops anything.
- **The interface is never optimistic.** A message appears because the server
  stored it; a pending turn carries the server's own reason; a failed send
  keeps the words. Loading, empty, forbidden and error are four different
  screens, and the forbidden one does not claim the work is absent — the server
  cannot distinguish absent from forbidden, and the last hop must not invent an
  answer either.
- **A pending state that cannot become wrong is not an explanation.** The
  sentence stored on a pending turn is written before anything has happened, so
  it stays reassuring however long the turn waits and whatever goes wrong with
  it. `services/russell/pending.ts` derives what the turn is waiting for *now*,
  on the read path, from the bin and its current-generation dispatch — and the
  case it exists for is the one that must never read as patience: a pending turn
  with no bin, which nothing is ever going to answer. It is a projection, so it
  writes nothing, leaves the stored reason intact as history, and names no bin,
  Routine or session.
- **Russell is the default route; the old console is at `/legacy`.** One click
  away behind a secondary menu, not deleted and not hidden: it is still the
  only place some operations exist. The *operator* console was a different thing
  and is gone entirely — see §26.

**No inference is bought.** The deployed Brain has no `ANTHROPIC_API_KEY` and
no `BRAIN_PROVIDER`, so its only permitted model path is the fixed-subscription
Cowork fleet Steps 10 and 11 already fire. A Russell turn is therefore a bin: it
persists as `PENDING` with its reason, a worker answers it, and the server
validates the answer before anything is stored. That costs latency and buys
crash safety for free — an interrupted turn is a `PENDING` row and a `READY`
bin, both of which the existing machinery already resumes. The mock provider is
refused outright: canned prose presented as a grounded answer is the one thing
Russell's conversation may never be.

**Step 12A is not complete until `npm run step12a:acceptance` exits 0**, which
requires production rows against a deployed commit after a real restart.
`A11_INDEPENDENT_AUDIT` depends on **no particular friend, account count or
Routine count**. It is satisfied by one healthy Routine activated three times,
and it is **derived, fail-closed**, by
`services/research/independenceEvidence.ts` rather than hard-coded.

Two earlier versions of this paragraph were wrong in opposite directions, and
both are recorded rather than quietly deleted — the same way §22 records Step
7's wrong reasoning about OAuth.

The first said the gate was hard-coded `BLOCKED`, on the reasoning that a
database check could be satisfied by writing rows. The concern was right and
the remedy was wrong: a constant cannot become true when the evidence arrives,
so it would have needed a code change and a deployment at exactly the moment
the gate was supposed to be answering.

The second required **two accounts and two distinctly-bound workers**. That is
a stronger assurance and it also made a finished product unfinished whenever a
particular subscription was unavailable. A specific friend, account count or
Routine count cannot be a completion dependency, because those are dynamic
operational facts rather than properties of the system being accepted.

The remedy is a check hostile enough that forging it means reproducing the
whole production shape, expressed in terms of what actually defeats the threat.
`PASS` only when every condition holds: a healthy execution surface exists at
all; three completed audit passes; three session references that each resolve
to a **real credential of the worker that presented it**, so an invented
session separates nobody; those three sessions **distinct**, which is the
floor; **no predicted `future:` session**, which is allocator reasoning rather
than evidence; a judge whose completion stamp is **after both arguments**; a
lineage label that agrees with the binding its worker resolves to, which
decides the *reported tier* and never the verdict; and an orchestration that
filed a document with bytes, because an audit of nothing is not an audit. It
also re-checks the control it is evidence for — the separation minimum is
compared to its expected shape and a **same-session** refusal is exercised
live — so changing the guard in either direction makes the gate report
`BLOCKED`. There is no override, no environment variable and no
caller-supplied label, and an unreadable database is `BLOCKED` rather than a
pass. An audit that simply has not been run yet is `NOT_RUN`, which is a third
answer on purpose: *nothing has happened* and *something is wrong* have
different remedies, and a gate that reads BLOCKED on a healthy fleet names none.
Step 12B's items
(collections, Discovery Frontier, Capability Lab, maps, a mobile-first rebuild,
the full Fleet centre, personalization, advanced math, 3D, social-media
intelligence) are listed in `docs/STEP-12B-BACKLOG.md` and are not built here.

## 25. A website is a window. Brain is what it looks at.

Step 12C (`server/services/connect/`, `server/routes/connect.ts`,
`docs/CONNECT.md`) connects the first real site — Deal Dispatch — and every
decision in it follows from one sentence: **the site keeps being the master of
its own operational fields, and Brain becomes authoritative only for what Brain
derives.**

- **A record is a link plus an idea, not a new kind of object.** There is no
  Opportunity table here, no WorkItem type, no command bus and no second
  identity. `external_records` says *this Brain object is that site's record*,
  and the Brain object is a `russell_candidates` row — the thing this codebase
  already has for "something worth forming an opinion about". Everything after
  that is Steps 4 to 12A unchanged.
- **The version is the whole concurrency design.** A delivery carries the site's
  own `updatedAt`, normalized so string order is time order, and the write is a
  single guarded `UPDATE ... WHERE source_version < ?`. A redelivered, replayed
  or reordered copy matches nothing and is reported `STALE` — an ordinary
  outcome, not an error. That is the same shape as the queue's compare-and-swap
  and the fleet's fire slot, and it is the fourth time this codebase has needed
  it: **the guard is on a value the claimant does not choose.**
- **Identical content is not a write.** The content hash is compared before the
  version is, on both sides, so a poll that finds nothing changed makes no
  request and moves no timestamp. Without that the delta feed would report churn
  it caused itself, and a consumer cannot tell that from a real change.
- **Only what Brain reasons about crosses.** An allow-list, not "everything
  except": the margin, the contacts, the transcripts and the costs are the
  site's and stay there. A field that crossed would be a field with two masters,
  which is the failure this design exists to prevent.
- **The command is an idea, and that is not a technicality.** §22 says a worker
  cannot create its own work, and a site connector is a worker.
  `RESEARCH_FURTHER` captures a candidate — which spends nothing — and Russell's
  own loop then asks the archive first (§13) and launches only inside the
  standing authority a person granted (§24). A person on the site may *ask*;
  only a person in Russell may authorise the spending.
- **The projection is derived on the read path, never stored.** Six answers, and
  the sixth exists because of §24's own defect at a new altitude: a project with
  no standing authority would read `QUEUED` for ever while the actual blocker
  was a decision nobody was being asked for. So the authority is checked and the
  answer is `NEEDS_PERSON`, naming it. **A state that says "waiting" which
  nobody can resolve is not waiting, it is stuck** — for the fourth time.
- **Two authorizations meet at this boundary and neither substitutes for the
  other.** The person is authenticated by their session on the site and
  authorized by their role against a record in their own organisation; the site
  is authenticated by a credential Brain issued it and authorized by
  `services/identity/policy.ts` against one project and one scope. The person's
  name crosses as **attribution** and decides nothing — a name a remote system
  supplied is not an identity, and nothing downstream reads it.
- **A site's identity is made from a constant; only its secret needs a person.**
  A connected site is three things — a worker, a membership on one project, and
  a credential — and exactly one of them is a secret. The membership is the one
  with a wrong answer in it, and the wrong answer is *silent*: grant a site
  `CONNECTOR_SCOPES` and every connector call is refused with the same 404 a
  missing project gives, which is invariant 23 behaving exactly as designed and
  telling nobody anything. So the set is chosen from `SITE_CONNECTOR_SCOPES` in
  `services/connect/sites.ts`, which is the only thing in the repository that
  writes it, rather than from a picker. Because the membership is rewritten from
  the constant every time, connecting is a **repair** as well as a setup — and
  because the credential is revoked before the new one is issued, it is a
  **rotation** too, with never more than one live secret to reason about.

  **Where it runs moved twice, and both are recorded rather than quietly
  applied.** It was three screens on the operator console. Then it was a script
  in the release pipeline, on the argument that a constant beats a form — true,
  and it still left the console standing as a second way to get it wrong. It is
  now one action in Russell under **Connected sites**, behind `requirePerson`
  and `decideProjectAccess` at `ADMIN`, which is the level every other
  membership change already carries. A worker principal is refused by type: a
  machine that could issue itself a site credential is precisely what §22 was
  protecting against.

- **There is no connect policy module and there must never be one.** Every route
  resolves through `requireProject`, and absent and forbidden are the same 404
  with the same body — invariant 23 at a new door.
- **The site connector's scopes are their own composed set.** `project:read` and
  `external:sync`, and `tests/oauth.test.ts` withholds `external:sync` from the
  research connector deliberately: a research credential that could also
  register records and command them would widen the blast radius of the
  credential most likely to be running unattended, in exchange for nothing.
- **Storage is reported, never enforced.** One reading on the health surface an
  administrator already has. Evidence is counted once per content hash, anything
  unmeasurable is absent rather than estimated, and **no threshold stops any
  Brain work** — no work path calls it, there is no per-project quota and there
  is no per-idea approval. Storage is cheap relative to the business this Brain
  runs; the only thing worth building is the reading that stops it becoming a
  surprise.
- **A jurisdiction is read from the row, never from the sentence about it.**
  The compiler looked for a state in the *question's prose* and fell back to the
  approval envelope's when it found none — so a record whose own column said
  `state: "OH"` compiled as *"Establish, from official Michigan public
  records, … in Westbrook, OH"*, because `OH` is not the word `ohio`. Every row
  around it was healthy and the mission ran; a worker would have researched that
  specification correctly and answered a different question. **The wrong answer
  confidently derived is worse than no answer**, and nothing in the pipeline
  below the compiler could have caught it: the gate judges evidence against the
  fragment's declared scope, and the scope was the thing that was wrong.

  The repair is a boundary, not a patch. `domain/jurisdiction.ts` is the shared
  vocabulary both readers use, and it holds the one rule that matters: a
  two-letter code is authoritative in a **field that means a state** and
  unambiguous in **prose** only as `, OH` in capitals — because `, or`, `, in`,
  `, me` and `, ok` are ordinary English, and the first version of that rule
  read all four as states. `services/russell/subject.ts` is what an idea is
  *about*, resolved from the rows behind it rather than from its own sentence,
  and it answers `null` rather than defaulting — **not knowing is an answer**.

  The compiler then reads three sources in order — the subject's row, the
  question's words, the envelope — refuses when the first two disagree rather
  than choosing which to ignore, and when it reaches the third says so in the
  objective instead of asserting it about the subject. A jurisdiction the
  standing authorization does not cover is refused with a sentence naming both,
  which parks the idea where the person who could authorize it can see it; the
  connector's projection reads that as **Needs a person** rather than as
  finished, because a decision being waited on is not work that ended. No state
  is hard-coded in any of it, and the envelope still decides what is allowed.
- **The migration number was 035 and is 036.** Step 12A's closure landed
  `035_worker_sessions.sql` on the same number while this was being written, and
  `loadMigrationFiles` refuses a duplicate version rather than applying one and
  skipping the other — so the collision was a boot failure with a sentence in it
  rather than a schema quietly missing half of itself. That is the whole reason
  the numbering is checked at load time, and it is the only shared contract two
  parallel workstreams on this repository actually have to reconcile.
- **Running the suite against Postgres earned its place again.** The three new
  tables were created without `seq`, the identity column `dialect.ts` rewrites
  `rowid` to, and every cursor-ordered query failed on the cloud backend while
  passing on SQLite. That is the second time — `012_checkpoint_seq.sql` is the
  first — and it is the argument for the second backend in one line: **a
  repository layer over two databases is true or merely compiling, and only one
  of the two can tell you which.**


## 26. An administration page is not a workflow, and Brain has none.

`/operator` is gone. Not renamed, not unlinked, not kept as break-glass: the
route, the templates, the forms, the navigation entry and the module are
deleted, and the path is refused with the same 404 any other non-route gives —
to an administrator exactly as to an anonymous caller. A page that answered one
of them and not the other would be the same console with an extra step, and a
redirect would be a working link somebody could still be told to follow.

**The argument for it was wrong, and the correction is recorded rather than
quietly applied.** §22 justified it as "the surface you need when the client
bundle is broken or access has to be repaired". That is a reason for a
**recovery** to exist. It is not a reason for the recovery to be a public
browser page, and treating it as one is how a console accumulates: each new
thing arrives because the page is already there.

What decided where each piece went is one sentence: **a decision a person makes
about their own project belongs on the surface they already use; everything
else was internal machinery that should never have had a page.**

- **Connecting a site, its credential, its status, its rotation and its way
  out** are **Connected sites** (§25). One action. Brain makes or reuses the
  identity, writes the fixed scope set, revokes what was there and issues one
  secret, shown once.
- **What Russell may spend** and **approving a plan** are **Needs you** — the
  standing authority and `APPROVE_PLAN`, both already there.
- **Identities, surfaces, capacity and who is on the project** are **Who**.
- **Storage and health** are the health surface an administrator already has.
- **Creating a project, queueing an item, starting a packet by hand, approving
  one outside Russell, reissuing a stranded verification, retrying a fragment,
  granting a research worker a project, disabling or archiving an identity** are
  `npm run admin`, on a terminal. Reaching the shell is the authentication —
  the same reasoning `verify-hosted.ts` and `authorize-gap-policy.ts` already
  run on — and `--admin` is the attribution, resolved against the database
  rather than trusted, because an audit row with no author answers nothing
  later.

**The guard got stronger, not weaker.** The console's gate was a Brain
administrator plus a same-site origin. Connected sites is `requirePerson` plus
`decideProjectAccess` at `ADMIN`, which is the level `/api/projects/:id/members`
already carries because connecting a site *is* a membership grant. A worker
principal is refused by type at every one of these surfaces: no membership
configuration turns a machine into a person.

**`npm run admin` cannot mint a site credential**, and that is deliberate rather
than an omission. Connecting a site is a person's decision and the secret is
shown once, in a browser, to somebody signed in. A terminal that could issue one
would be the console again with fewer witnesses. It does not import
`SITE_CONNECTOR_SCOPES` at all, and a test asserts that exactly one module in
the repository writes that set.

**Nothing that existed was destroyed.** Every worker, membership, credential
digest, token and `identity_events` row is untouched by the removal; the console
was a surface over repositories, and the repositories did not move.

**A deleted page comes back as a link.** So the removal is tested three ways
rather than one: the route is refused for every principal; the client contains
no `/operator` at all; and `tests/operatorConsoleRemoved.test.ts` reads the
repository and fails on any link or any instruction to go there. It
deliberately *classifies* rather than bans — this file records its own
corrections, and a sentence like "it was on the operator console, and that was
wrong" is history worth keeping. What must not exist is somewhere to go.

**"Who is on the project" said membership and had no way to *offer* one.** A
person was **granted** access at `POST /api/projects/:id/members`, by somebody
who already held their user id — so the only people who could ever be added were
people a Brain administrator had already made an account for. Nobody was ever
invited and nobody ever accepted. The one `invitations` table in this repository
was `worker_invitations`, and a worker is not a person: it holds no threads,
reads no project, and what it redeems is an OAuth consent screen. Two acceptance
gates carried "an invitation anybody received" as their unmet condition, and it
could not be closed by waiting, because the mechanism did not exist.

`server/services/identity/invitations.ts` is that mechanism, and it reinvents
none of the worker invitation's safety properties: the token is shown once and
stored as a sha-256 digest, found by an indexed prefix and compared in constant
time, and spent by **one guarded `UPDATE`** carrying every condition that makes
it valid — so two requests holding one intercepted link cannot both come away
with a membership. Issuing is `requirePerson` plus `decideProjectAccess` at
`ADMIN`, the level `/api/projects/:id/members` already carries because inviting
*is* a membership grant, and a worker principal is refused **by type**: a machine
that could invite people would be creating principals nobody asked for.

Three things about it are decisions rather than details.

- **The acceptor chooses neither who they are nor what they get.** The email and
  the role are read from the row; an acceptance carrying `role: OWNER` and
  `isBrainAdmin: true` changes neither. A person who could pick their own role on
  the way in would make the link a way to grant themselves access, which is the
  whole of what the issuing administrator's decision is for.
- **The token is in the URL *fragment*, never the path.** A fragment is not sent
  to any server and is not written to any access log, which is what makes a link
  safe to put in a message — §17's rule that a credential may not appear in a URL
  that gets recorded, and a path segment is recorded by every proxy between here
  and the recipient. The two routes that spend it are the third and fourth
  entries on the guard's unauthenticated allowlist, for `/api/auth/login`'s exact
  reason: an invited person may hold no credential but the one in their hand.
- **Creating an account is `decideBrainAdmin`'s to authorize, and the authority
  is re-read at the moment the effect happens** rather than stored on the
  invitation — §17's rule that authority is read on every request rather than
  baked into a token, applied to the one power this journey needs and does not
  itself hold. An inviter who has since lost `ADMIN` lets nobody in through a
  link they left behind. A refusal for want of that authority **does not spend
  the invitation**, because the remedy is a Brain administrator making the
  account and the link has to keep working afterwards: an escalation with no
  answering transition is stuck rather than waiting, for the sixth time.

Absent, malformed, expired, already accepted and withdrawn are **one body**, and
it names the remedy rather than the reason — invariant 23 at a new door, where
the thing being refused is a secret somebody may be holding legitimately. An
invitation *id* is not an oracle either: to a caller who does not administer the
project, a real id and an invented one are byte-identical.

## 27. The factory is an entrance to the same machinery, and its evidence is the repository.

The Software Factory (`server/services/factory/`, `server/repos/factory.ts`,
`server/repos/factoryFleet.ts`, `docs/FACTORY.md`) converts an approved software
objective into verified, reviewable code. It is the same shape every step since 5
has had — a claim is a compare-and-swap on a generation, a refusal is the same
deny-by-default decision `services/identity/policy.ts` already makes, and the
metrics are one append-only ledger rather than a second table that must agree
with it. **There is no second orchestration universe beside Brain**, and a
factory that grew one would be a second security model with the weaker half
winning.

- **A worker's summary is never evidence.** `IMPLEMENTED` means a branch moved;
  `MERGED` means the diff stayed inside the paths the unit declared *and* the
  repository's own commands passed on the merged tree. A worker that wrote a
  confident report and no code has not done the work, and the branch is how the
  factory knows. Every sentence the factory says about what happened resolves to
  a commit, a diff, an exit code or a row.
- **A unit owns a mutation surface, declared before it runs.** Two units whose
  surfaces intersect are never leased at once, and the check is in the claim loop
  *ahead of* the swap — so a refusal costs no attempt, no lease and no
  generation, exactly as §23's correction requires. A diff that reached outside
  its surface is rejected whole rather than cherry-picked: a diff the unit did
  not declare is a diff nobody reviewed the scope of.
- **A dependency is satisfied by integration, not by implementation.** A worker's
  worktree is pinned to the campaign base or to an explicitly recorded
  integration descendant of it, never to a sibling's unmerged branch. Nothing
  uncommitted is ever a channel between workers.
- **The contract is immutable where it says what success is.** Objective,
  expected outcome and approved acceptance conditions cannot be amended by a
  FACTORY actor at all; a mutation scope may only narrow and a verification
  command may only be added. Every permitted amendment is an append-only row
  carrying both values, the reason, the affected units and whether
  re-verification is required. A factory that could edit its acceptance
  conditions would be grading its own exam.
- **A plan is a proposal.** `planner.ts` refuses the whole plan for an unknown
  field, an invented verification command, a path outside the approved scope, a
  dependency cycle, or a mandatory condition no unit claims to serve. A
  partially-installed plan is a graph with holes in it, and a campaign built on
  one runs happily and produces something nobody asked for.
- **A provider refusal is backpressure, not failure.** The unit is deferred, the
  attempt it spent is refunded, and the worker is marked rate-limited rather than
  quarantined. §23's sentence, one altitude down: an account at its ceiling is
  busy rather than broken, and a refusal recorded as a failure walks a healthy
  unit toward exhaustion against a condition that was never about the work.
- **Review independence is execution lineage.** The floor is a different
  *session* from the one that implemented the work, refused from recorded
  lineage rather than from a role label. Worker and account separation are
  stronger tiers that are reported when the fleet supplies them and never
  rounded up. A reviewer's worktree is detached at the reviewed commit and its
  tool allowance contains no writing tool, so "a reviewer cannot silently mutate
  reviewed work" is a property of the execution rather than a rule in a prompt.
  A verdict is matched exactly; `PASS` alongside a BLOCKER is refused outright
  and nothing is recorded.
- **A finding becomes work without anybody carrying it.** Each one becomes a
  repair unit in the same campaign, exactly once, with ownership derived from the
  reviewer's hint held against the approved scope — a hint can narrow a repair's
  reach and can never widen it. A finding is REPAIRED when its unit integrated
  and the verification passed, never because a worker said so.
- **Adding a worker is a row.** `factory_workers.kind` selects an executor that
  already exists, and a kind nothing implements is refused at registration rather
  than discovered at dispatch. Scaling the fleet is never a factory code change.
  The registry holds the *name* of a secret and a digest taken once; no
  projection recovers a value from one.
- **Lane count is measured, not configured.** `scheduler.ts` is a pure function
  over a recorded snapshot — so "why did this unit go to that worker" is
  answerable afterwards — and being pure makes it useless as a safety mechanism:
  the exclusion is the compare-and-swap, and this can under-assign and cannot
  over-assign. The tuner reads first-pass success, contention and provider
  refusals. A person is never asked for a worker count.
- **Concurrency is reported as what overlapped.** `maxObservedConcurrency` is the
  true maximum overlap of real session intervals; the sum of declared concurrency
  is a projection and is never reported as throughput. A ceiling nobody has
  observed reads UNKNOWN and stays UNKNOWN.
- **No paid model API can be activated by accident.** The local executor removes
  every API-key variable from the child's environment, so the guarantee is the
  spawn rather than a promise in a comment. A worker authenticates the way the
  session that launched it does, against the subscription already in place.
- **Two decisions belong to a person, and the factory has no path around
  either.** Approving the objective, and approving the release. Both are guarded
  single-shot transitions; a worker principal is refused at both by principal
  type. The factory may open a reviewable pull request and may never merge to a
  protected branch or deploy a product change to production. `assemble.ts`
  produces the branch, the patch and the body and **stops** — a function that
  quietly published would make that boundary depend on nobody calling it.
- **Every escalation has an answering transition.** `BLOCKED` names an
  operational fact from a closed vocabulary and a remedy somebody can apply, and
  a blocked campaign is re-examined on the next tick rather than retired.
  `AWAITING_RELEASE` has a guarded answer a route can deliver. A state that says
  "waiting for a person" which that person cannot resolve is not waiting; §24's
  sentence, at a fourth altitude.

### The factory runs where the repository is, not where Brain is.

The deployed Brain has no `.git` and must not acquire one. So the factory has two
planes over one control plane: the contract, the plan, the ownership of a
mutation surface, the independent review and the repair of a finding are
identical in both, and only *where the work happens* differs.
`factory_campaigns.execution_mode` says which, **derived and never chosen** — a
contract pinned from a checkout has a `repositoryRoot`, one pinned through the
forge does not, so the absence of a root *is* the statement that execution is
remote.

- **A stage is a bin, and the fleet is the executor.** Plan, implement,
  integrate, review, deliver — one bin each, at most one live per stage, every
  step idempotent by its own rows rather than by a cursor or a flag. A flag can
  be set by a tick that then dies; rows cannot. Nothing here needed a new
  recovery mechanism, which is the whole reason it is built on Step 10's bins
  rather than beside them.
- **A worker's summary is still never evidence, and the forge is how.** The
  branch is at the commit reported, the files that moved are inside the unit's
  declared paths, the integration commit *contains* each unit branch it names,
  and a pull request exists at the integrated commit — every one of them read
  from the repository's own account of itself. The worker's file list is stored
  and deliberately not used for the decision. A truncated compare fails closed,
  because a capped list cannot prove the one thing the check exists to prove.
- **The tests passing is read rather than taken.** A project whose CI runs on
  every push has already produced an account of the same commit, so it is read.
  Its three answers stay apart: a failure is a refusal, a pending run is *not
  yet*, and **no check at all is an absence** recorded as `UNKNOWN` — never as a
  pass.
- **The campaign's head moves in one place.** A unit confirmed on its own branch
  is `IMPLEMENTED` and never `INTEGRATED`, so a dependency is still satisfied by
  integration; the head advances only when an integration is confirmed, and a
  failed verification leaves the branch exactly where it was. An integrator is
  told not to push a tree the contract rejects, which is the remote shape of the
  local integrator rolling the merge back.
- **A campaign pinned at a branch that is already an open pull request's head
  continues that request.** Derived from the forge, never supplied: a number in a
  request body would be a caller choosing which open request the factory writes
  into. Continuing one means landing the work on the branch it already points at.
  The factory may retarget the base of a request it opened and never of one it is
  continuing.
- **Brain holds no credential for any repository, and that is the mechanism
  rather than a promise.** The manifest names a remote and never a secret, and
  every bin's first authorized action says the access is granted where the worker
  runs. There is nothing on this side to leak into a prompt, a log, a row or a
  browser. `services/factory/repositoryEnvelope.ts` is the other half: the
  repositories the factory may be *pointed at*, in code, named by id, for
  §24's reason — nobody supplies the limits their own work is judged against. It
  is not a security boundary and cannot grant or revoke access; it stops a
  campaign being created against a repository nobody authorized, which is when
  the decision is cheap. **`V5` is deliberately absent:** a campaign that could
  rewrite the machinery executing it is the one whose failure mode is not
  contained by declining a pull request.
- **Review independence is derived from lineage and enforced twice.** The review
  bin is refused at assignment to any session that implemented part of the
  campaign — before the lease, so the refusal costs no attempt — and the verdict
  is checked again before storage, because a lease can expire and be retaken. The
  session is the *credential the request authenticated with*, never the
  `session_ref` a worker sends: that field is telemetry and its own tool says so,
  and deciding on it would be a worker declaring itself independent. The tier
  recorded is the one the lineage supports and is never rounded up; unknown
  lineage is a refusal. An earlier version of the remote ingest recorded
  `SESSION_SEPARATED` unconditionally, which is a claim rather than a reading —
  recorded here rather than quietly applied. Two capabilities, `repository` and
  `repository-write`, exist for exactly this: a reviewer needs to read and run,
  and only the bins that push need a surface that can push, so a one-pushing-
  surface fleet does not make the reviewer the implementer.
- **A capability gates the fire, and nothing gates the assignment — after two
  corrections, both recorded rather than quietly applied.**
  `requiredCapabilities` decides which Routine Brain *fires*. Reading it again to
  decide which bin an arriving worker may be *handed* is tempting, because any
  authenticated worker is offered the oldest ready bin in its scopes and so a
  surface fired for one bin can be handed another it cannot do. It was added, it
  refused the only surface that could do the work, twice, for two different
  reasons — and the second reason is why it cannot exist.

  Failing closed on unknown lineage made it unreachable: an arrival has no lineage
  until it takes a bin, which is the thing being gated. Then reading the *static*
  worker → Routine binding attributed the arrival to whichever Routine is enabled,
  which in a fleet sharing one worker identity is the wrong one. And reading the
  *observed* lineage does not help either, because **`worker_sessions` is keyed by
  the credential and the credential is per-connector rather than per-session** —
  every session an account fires presents the same one, so the row describes the
  fleet and cannot describe the arrival.

  So Brain cannot tell which surface has turned up before it hands out work. The
  cost of admitting one that cannot push is a fire and an attempt, and the worker
  reports BLOCKED naming the operation that was refused, which every stage
  handles. The cost of refusing wrongly was a campaign that could never move.
  **Between a gate that sometimes wastes a fire and one that sometimes stops all
  work, only the first is tolerable** — and the rule it is an instance of is: fail
  closed when the unknown could let something false be recorded, fail open when it
  could only waste a fire.
- **That paragraph is right about capabilities and wrong about scope, and the
  difference is the subject of the sentence. The correction is recorded rather
  than quietly applied.** Brain cannot tell which *Routine* has arrived, for the
  three reasons above, and nothing about that has changed. But the thing a bin
  must be matched against was never the Routine: it is the **authenticated
  worker**, which is the one identity in the exchange the caller does not supply —
  the property every compare-and-swap in this codebase rests on. Reading a
  worker's own recorded scope is not a guess about a surface; it is a row Brain
  wrote.

  The cost of not having one was not a wasted fire. One worker identity served
  every surface in this fleet and held membership on the research project, so
  Software Factory sessions were handed Deal Dispatch research and audit bins, and
  a research session could be handed a repository implementation bin. Project
  scoping existed the whole time and separated nothing, because both workloads
  were one worker on one project. **A scope that cannot distinguish its callers is
  not a scope.**

  `services/bins/routing.ts` is that one decision, and it is read in the three
  places that must agree or it is not a boundary: the candidate query that decides
  which bins exist for this caller, the admission hook that decides the claim, and
  the fire router that chooses a surface. Every dimension must match — the
  project, the workload family, the repository where the work names one, the
  declared capabilities, the authorization scope, and then, afterwards and
  unchanged, the independence lineage. It is deny-by-default where that matters:
  an explicit row is **exhaustive**, a worker with no row serves what its scopes
  imply, and **no worker without an explicit row may ever be handed repository
  work**. So authorizing a repository is three things — the envelope grant, a
  `worker_routing` row, and access where the worker runs — and any one of them
  missing authorizes nothing.

  The family comes from the bin's **manifest** first and its label second: a
  manifest naming a repository is repository work whatever its `workload_class`
  says, because the manifest is the work and the class is a label somebody wrote.
- **Review independence rests on the reported session, validated against a real
  credential of the presenting worker.** I wrote the opposite first — the
  credential, never the `session_ref`, because a decision on a value the claimant
  supplies is a worker declaring itself independent. The reasoning holds; the
  premise was wrong for the same reason as above. Comparing credentials would make
  every reviewer identical to every implementer and refuse every review for ever.
  §24 settled the same question the same way, and the account and worker identity
  still come from Brain's own dispatch row rather than from anything the worker
  said.
- **A finished bin cannot say who finished it**, because `finishBin` clears the
  worker, the lease and the credential in the same statement. `worker_sessions`
  can, written from Brain's own dispatch row, and that is where the account and
  the worker identity come from.

  **Reading it is the third time an `ORDER BY` has been true in one dialect
  only.** `workerSessionForBin` tiebroke on `rowid`, which `dialect.ts` rewrites
  to `seq`, and `worker_sessions` has no such column on Postgres. Every SQLite
  test passed; in production the statement threw, so the hosted factory's tick
  threw on every pass and a completed bin sat un-ingested with nothing on the
  campaign saying why. `012_checkpoint_seq.sql` was the first instance and §25's
  three connect tables the second. **An `ORDER BY` must be sayable in both
  dialects, and a tiebreak on a column only one of them has is the easiest way to
  write one that is not.**
- **Every stage still has an answering transition, including the new ones.** A
  refused unit report costs an attempt, so the next round is different work
  rather than the same branch over rejected commits — remotely the unit row is
  not claimed until a report is believed, so without that a refusal would cost
  nothing and the loop would offer the identical unit forever. A stage that
  burns through `MAX_BINS_PER_STAGE` blocks the campaign with the reason instead
  of being handed out again, and a blocked campaign is re-examined every tick.
- **A cap that truncates is worse than a cap that refuses.**
  `MAX_UNIT_VALUE_CHARS` sliced a submitted value to 4 000 characters — right for
  the short research answer that was the only thing submitting one when it was
  written, and wrong for a factory plan, which is a decomposition carrying an
  objective, acceptance statements, owned paths and verification commands *per
  unit*. In production a correct three-unit plan was cut mid-JSON, the contract
  then told the worker "no plan was submitted … or it was not valid JSON" — true of
  what was stored and useless about why — and the worker re-submitted the same
  correct plan until the bin retired at `NEEDS_HUMAN`. **Truncation is the one
  outcome a worker cannot recover from, because it is reported as success.** It is
  refused now, with the limit and what arrived, nothing is written, and the attempt
  is still there to spend on a shorter answer. The cap is 64 000, inside
  `MAX_REQUEST_BYTES` so a value that size can actually arrive.
- **A name derived from a mutable counter cannot be the contract.** The branch a
  unit must push to was derived from its attempt, and `acceptUnitReport` claims the
  unit — a claim increments the attempt. So the instant a report was accepted, the
  name Brain expected no longer matched the branch it had just accepted: the next
  tick re-verified the same report, refused it for naming the previous attempt's
  branch, reopened the unit and charged another attempt, and three passes later a
  unit whose work sat correctly on a confirmed commit had retired as FAILED. The
  bin recorded the name when it handed the work out, so the bin is asked — the
  same "read it back from the row Brain wrote" this loop already uses for the base
  commit, and for the same reason. And the ingest acts only on a unit still
  *waiting* for a report; it skipped INTEGRATED alone, which left IMPLEMENTED — the
  state a successful acceptance produces — being judged again.
- **A refusal is recognised, not repeated.** An *accepted* report is idempotent by
  its own effect: the unit is `IMPLEMENTED`, so the next tick skips it. A refused
  one puts the unit back to `READY`, which is the state the next tick offers the
  same completed bin for again — so in production it charged three attempts in one
  pass and retired the unit before any worker had a second go, and the second and
  third refusals were for the branch *name*, which the attempt counter had just
  changed underneath them. The ledger is the guard: `UNIT_FAILED` carries the bin,
  and a bin's report for a unit is refused once however many ticks read it.

  **And an acceptance is not idempotent by its own effect either — believing it
  was is the same mistake one move later, and the correction is recorded rather
  than quietly applied.** "The unit is no longer READY" holds only while nothing
  else can write that state, and a refused integration writes it. The completed
  implementation bin still held the report Brain had believed, so the next tick
  read it again and put the unit straight back to `IMPLEMENTED` at the commit the
  integration had just refused: refuse, re-accept, integrate, refuse, for ever. **A
  loop that looks like progress is worse than a stop.** Both answers are keyed on
  the **bin**, which cannot change, rather than on a state two other transitions
  can write.
- **An honest blocker is a result, and a contract that cannot accept one turns it
  into an exhausted bin.** `headSha` was required of every report, on the reasoning
  that a worker which got far enough to push has a commit. Some do; one blocked
  *before* pushing has nothing to name, and the first hosted integration reported
  `BLOCKED` with the operation its surface had refused, was told to produce a
  40-character commit for a branch it had deliberately not pushed, and retired at
  `NEEDS_HUMAN` having said exactly the right thing on both attempts. Required of
  `IMPLEMENTED`, optional of `BLOCKED`, still refused when present and malformed.
- **A blocker about the surface is not a blocker about the work**, and which one it
  is, is derived from the rows. A conflict, or a command that exited non-zero on
  the merged tree, is a fact about the code and the units go back and are charged
  for it. A blocker with neither means nothing judged the tree, so there is nothing
  for the work to answer: every unit keeps its commit, no attempt is spent, and the
  stage is offered again for a surface that can push — **deferred for a cool-off
  rather than stopped**, because Brain cannot tell which surface will arrive, so a
  hard ceiling counted in surface blocks is reached by the surface that *cannot*
  push before the one that can has had a turn. That is a livelock with a tidy
  blocker row on it, and the first version of this rule had it. A far higher
  ceiling remains and is answered by `FACTORY_STAGE_REAUTHORIZED` — a person saying
  the operational condition is fixed, from which the count and the cool-off are
  both taken, so a condition that was not actually fixed simply defers again. §23's sentence one altitude down: **a refusal is not misconduct.** A
  worker cannot declare itself surface-blocked to escape a failed verification,
  because the exit codes it reported about what it ran are what decide — prose
  never does.
- **A rule applied by one of two runners is worse than none**, and this is the
  third time: `reconcileRepairs` had exactly one caller, the in-process
  orchestrator, and the hosted plane is the other runner — the same shape as
  `reconcileAcceptedFragment` showing `MISSING` on a `COMPLETE` packet. Here it
  showed as a pull request: the repair integrated, its commit became the request's
  head, the repository's own checks passed on it, and the body a person reads still
  listed the finding under *remaining limitations*, because nothing on this plane
  had ever moved it to `REPAIRED`. **The evidence was right and the sentence about
  it was wrong**, which is the failure mode this file cares about most. It changes
  no evidence: a finding is REPAIRED because its unit reached `INTEGRATED`, never
  because a worker said so.
- **A contract that lies about its own inputs refuses work and says nothing.**
  `brain_check_in`'s `session_ref` is an *optional* argument, and its schema said it
  was "never used to decide anything" — while the factory's review-independence
  floor decided on it, because the provider session id is the finest identity the
  surface exposes. A worker that simply omitted the field was therefore refused
  every review, silently: `bin_session_refusals` is keyed by the session, so the
  missing one left no row. In production Brain chose the right surface, fired it,
  the provider created the session, and the review bin sat `READY` at nought
  attempts with nothing anywhere naming a reason. **Brain knew which session it
  had fired the whole time** — it is on the `bin_dispatch` row Brain wrote — so
  that is the fallback, which is §24's own rule rather than a softening of the
  floor: a session identity comes from Brain's record of the fire, never from
  what a worker says about itself. The reported value is still preferred, because
  an arrival Brain did not fire has no such row, and with neither the floor still
  fails closed. The schema now says what the field does.
- **A prohibition in a prompt is not a control, and Brain cannot make one.** Every
  units bin forbids pushing to or moving the campaign's integration branch, names
  it, and says integrating is a separate bin — and a unit worker pushed its commit
  to its own branch *and* fast-forwarded the campaign branch onto it. The content
  was exactly what the unit declared; the route was one nothing reviewed. Push
  access is granted where the worker runs, so Brain cannot prevent it and instead
  **notices**: the branch is read before the stage is handed out, both commits go
  on the ledger as `STALE_BASE_DETECTED`, and the integrator is told. Not a
  refusal — the integration still judges the whole range from Brain's recorded base
  against the declared paths, and delivery still refuses a pull request whose head
  is not the commit Brain integrated.
- **A timer is the wrong place to answer a question somebody is asking right
  now.** A stage becomes available only when a tick reads what the last one
  finished, and the twenty-second loop exists so a stage becoming ready inside an
  activation is taken by the worker still there. The worker did not wait twenty
  seconds: it integrated, pushed, completed its bin, checked in again in the same
  minute, was told there was no work, and ended — so the next stage sat until the
  next hourly activation. An hour per stage for want of twenty seconds. `checkIn`
  derives before it answers — once, scoped to the caller, the same idempotent
  tick, then retries the assignment — and a derivation that creates nothing is
  still "there is none".
- **A unit out of attempts stops the campaign before any review.** `outstanding`
  excludes FAILED, correctly — nothing more is going to happen to it — and the
  effect of that alone was a campaign whose only unit had retired walking into the
  review stage with nothing integrated, asking a reviewer to judge the base commit
  against a contract nothing had implemented. A verdict on that is a verdict about
  the wrong tree. BLOCKED with the unit's own recorded reason, the work intact and
  every attempt still on its row, and the ways out are a person's: amend the
  contract, or stop.
- **`COWORK_ROUTINE` is not an executor, and the earlier claim that the handshake
  was missing is recorded rather than deleted.** An `Executor` is something Brain
  calls and waits on, holding a worktree it can see. A Routine activation is a
  fire that may be refused, may arrive late, may be taken over, and must survive
  a restart — which is a bin, not a promise. The permanent subscription-backed
  executor is the fleet.
- **A refusal that means "setup is missing" is not a refusal that means "this may
  not happen", and treating them alike destroyed the work.** Two of the router's
  refusals — `NO_SURFACE_SERVES_THIS_FAMILY` and `NO_CAPABLE_SURFACE` — name a
  condition an authorized action resolves. They spent one of the bin's five
  dispatch attempts each and abandoned at the fifth, and an abandoned stage counts
  against the campaign's per-stage ceiling, so a campaign submitted before its
  repository was onboarded had destroyed its own planning stage by the time the
  worker existed, for a reason that was never about the work. They are **deferred**
  now. Everything else still exhausts: `NO_ROUTINES_REGISTERED` and
  `ALL_SURFACES_INELIGIBLE` are fleet-wide facts rather than this stage's, and the
  admission refusals — `PROJECT_OUT_OF_SCOPE`, `REPOSITORY_NOT_AUTHORIZED`,
  `SCOPE_MISSING` — are decisions, taken ahead of the compare-and-swap and costing
  nothing. §23's sentence again, one category along: a refusal is not misconduct.
- **Deferred is only honest if something puts it back, and only useful if it puts
  back the right thing.** `rearmSurfaceDeferredIntents` derives the condition
  instead of scheduling it, and it now watches `worker_routing` as well as
  `fleet_routines`, because onboarding writes the first — a repository became
  executable and the work already waiting for it did not notice. It also
  re-checks each candidate with `routeBin` **itself** rather than putting back
  everything: the old behaviour woke every stranded bin in the Brain on any fleet
  write, and a fire spent on work nobody can do is a fire the work that can be
  done did not get. What it decides on is what the *fire* decides on — the family
  and the declared capabilities — and never the repository, which §27 settles at
  admission instead: fail closed where the unknown could record something false,
  fail open where it could only waste a fire. A re-arm is not a retry and never spends an attempt, and it
  stamps the intent, so it is self-limiting.
- **A campaign whose stage has nobody to give it to says so, without lying about
  its state.** A ready stage deferred on one of those two refusals sets
  `blockerKind = NO_HEALTHY_EXECUTION_SURFACE` with the remedy in words; `state`
  is left alone, because the campaign *is* planning and BLOCKED would throw away
  what happens when the surface arrives and then need a guess about which state
  to restore. The blocker clears on the tick after the condition stops holding.
  §24's sentence at the factory, for the fifth time: **a state that says waiting
  which nobody can resolve is not waiting, it is stuck.**
- **Registering a worker for a repository is one action a person takes, not four
  rows an operator composes.** `services/factory/onboard.ts` is `connectSite`'s
  shape for `connectSite`'s reason: the identity, the membership, the fixed scope
  set and the exhaustive routing row are written from the grant and from
  constants, so there is nothing to get silently wrong — and a worker given the
  wrong scopes is refused by every route with the same 404 a missing project
  gives, which tells nobody anything. It lives on the Build surface behind
  `requirePerson` and `decideProjectAccess` at `ADMIN`, the level a membership
  grant already carries, and a worker principal is refused there by type. It
  issues **no credential**: what a Cowork connector needs is not a secret to
  paste but a way for the consent screen to name one worker, so it issues a
  single-use expiring invitation that on its own cannot read anything, call a
  tool or obtain a token — and the invitation *id* is what reaches the audit row.
  Onboarding twice is a repair and a rotation rather than an accumulation.
- **It cannot register the surface, and readiness says which half is missing.**
  Brain that could mint its own execution surfaces is exactly what §22's split
  forbids, so the projection is derived on every read into three answers with
  three different remedies — `NOT_ONBOARDED`, `AWAITING_SURFACE`, `READY` — with
  the remaining steps printed in the order they have to happen. Beside them it
  counts, from rows, **how much work is already waiting on this repository**,
  which is the one thing that makes a setup task worth doing today: the work
  resumes by itself and nothing has to be submitted again.
- **A rendered card is not a passing service test.** Pressing the button reloads
  the list, the reload counted as loading, and loading unmounted the section —
  taking the invitation *shown once* down with it. Every server test passed: the
  rows were written, the invitation was issued, the reply carried the link, and
  the person would never have seen it. A re-read leaves the previous answer up
  until the new one arrives, and the section is keyed by the project so a change
  of project still throws it away.
- **An instruction that cannot be carried out is a defect in the instruction,
  and this one could not be carried out past the client's own dialog.** The
  onboarding step said to add a connector to *"this Brain's /mcp endpoint"* —
  and Claude keys its connector registry by URL, so a second custom connector at
  a URL an existing one already holds is refused outright: *"A connector with
  this URL already exists in your organization."* There is no other field on
  that screen that could tell two connections apart, so a Brain whose research
  connector sits at `/mcp` cannot be connected there twice, however correct its
  credential design is. That is a fact about the client, and the remedy has to
  be one too.

  So `/mcp/factory` is a second **name** for one endpoint, and the whole of its
  safety is that it is nothing else. The same router is mounted at each path,
  behind the same authentication, origin rule, limits, eras, tool registry and
  `services/identity/policy.ts`; the path selects no worker, project, repository
  or scope, and nothing reads it — not the executor, not the policy module, not
  `services/bins/routing.ts`. **A URL must not grant authority by itself**: the
  authenticated credential says who the caller is, and a person choosing a
  worker on the consent screen is what decides that credential. The `resource` a
  client passes is recorded on the token and deliberately not enforced, which is
  the same statement read the other way — a token minted through either
  connector works at either door.

  The set is a **constant** rather than a free-form label, so the discovery
  documents echo nothing a caller supplied and an unregistered sibling is an
  ordinary 404; a refusal is **byte-identical** at every path, because an extra
  door that answered differently would be an oracle (invariant 23 at a new
  boundary); and every mounted path publishes its own
  `/.well-known/oauth-protected-resource<path>` document with the `401` naming
  the door actually addressed, because RFC 9728 puts it there and a connector
  with nothing to discover fails with no message in it. They differ in
  `resource` and in nothing else: one authorization server, one consent flow,
  one refresh grant. Nothing about the research connector, its credential, its
  worker or its routing was touched.

- **"If it offers you a list, the link was opened in the wrong browser" was
  false, and it sent people to fix a condition that did not exist.**
  `/oauth/authorize` looks for a signed-in administrator **before** it looks for
  an invitation, and that ordering is correct rather than a bug: an invitation
  *stands in for* an administrator's approval, so folding the two together would
  be the thing `invitedApproval` warns against, and it would also stop an
  administrator connecting a worker their browser happens to hold a stale
  invitation for. Which means the person who has just pressed **Onboard** —
  signed in, by definition — sees the chooser every single time.

  The defect was the silence, so the fix is words rather than authority. The
  screen reads the held invitation purely to **name it and preselect its
  worker**, the invitation is **not spent** on that path, and the administrator's
  own authority is still what the approval runs on; the invited path, where the
  posted worker id is checked against the invitation and a mismatch refused
  outright, is untouched. `tests/oauth.test.ts` pins both halves — display only,
  and still live afterwards. **A remedy for a condition that was never true is
  worse than no remedy**: it teaches a person that the thing in front of them is
  broken when it is working.

- **A stage becomes fireable when something makes it fireable, not on the hour.**
  A factory bin's completion advances **its own** campaign and dispatches what
  that created, and the twenty-second remote loop dispatches what it created too.
  Advancing every campaign on any factory completion was the first version and
  was wrong for the ordinary reason — it made one bin's completion the whole
  fleet's work. Both paths are idempotent by the same row the design already had:
  one intent per (bin, generation), `ON CONFLICT DO NOTHING`, so a duplicate
  tick, a restart mid-flight and two instances produce exactly one fire.

- **The fire router scoped by family and not by repository, and I argued that
  was right. It was not, and the correction is recorded rather than quietly
  applied.** The reasoning I gave was §27's own: Brain cannot tell which surface
  has *arrived*, because `worker_sessions` is keyed by a per-connector
  credential, so a repository check on an arriving worker is a guess. Every word
  of that is still true and none of it is about the fire. **Choosing which
  Routine to fire is Brain's own decision over rows Brain wrote** —
  `fleet_routines.worker_id` names the worker and that worker's `worker_routing`
  row names its repositories — so there is no unknown to fail open on. With two
  onboarded repositories in one family the router picked between their surfaces
  on headroom, so onboarding A registered a surface Brain would fire for B's
  bin, which the assigner then refused: an activation spent, an attempt charged,
  and B's own surface never tried. `NO_SURFACE_SERVES_THIS_REPOSITORY` is the
  refusal, named rather than reported as the nearest available one, and the
  re-arm inherits it for free because the predicate *is* `routeBin`.
- **Every routing refusal is a wait. There is no third kind, and believing there
  was cost two of them.** `NO_ROUTINES_REGISTERED` and `ALL_SURFACES_INELIGIBLE`
  exhausted a bin's five dispatch attempts and abandoned it — on the reasoning
  that they mean "no surface exists at all", which is exactly the condition
  `fleet register-routine` and `fleet set-state` exist to answer. A campaign must
  not die of a condition whose fix a person is on their way to applying. What
  still exhausts is unchanged and is not a routing refusal: `SUPERSEDED`, and a
  fire the provider refused unretryably. **The permanent refusals are untouched
  and are somewhere else entirely** — `decideRepository` before a campaign
  exists, `services/bins/routing.ts` ahead of the compare-and-swap so it costs
  nothing, `services/identity/policy.ts` with the same 404 a missing project
  gives. None of them produces a `RoutingRefusal`.
- **Two `Set`s that had to be total between them were not, which is how a
  refusal fell into the exhausting branch by default.** `REFUSAL_WAIT` is a
  `Record` keyed by the union, so a refusal added later is a compile error until
  somebody classifies it — and it lives beside the union in `router.ts` rather
  than in the loop, because the re-arm reads the same table to decide which
  deferred intents a fleet write could have answered. The repository layer holds
  no list at all now: `rearmSurfaceDeferredIntents` takes the kinds as a required
  argument. It had its own copy, and the moment the router grew a refusal the two
  disagreed — the loop deferred on a word the filter had never heard of, and the
  intent waited out a wall no write could shorten. **A rule applied by one of two
  readers is worse than none**, for the fourth time.
- **"Considered" has to be recorded, not only "put back".** The re-arm's
  candidate query is `updated_at < watermark`, and only the intents it put back
  were stamped. One it *skipped* therefore matched again on the next tick, and
  the one after — and with the recheck reading a bin per candidate that is up to
  two hundred extra reads and routing decisions every ten seconds, for ever,
  because nothing about skipping one changed a row. **A scan that is
  self-limiting in one direction is not self-limiting.** Stamping a skipped
  candidate says exactly what stamping a re-armed one says — *we asked, against
  this state of the fleet* — and the next operator write is newer than the stamp,
  which is the only moment the answer could have changed. `next_attempt_at` and
  the attempt count are untouched, so nothing about when it would fire moves.

  **I said this had caused three failed deploys, and that claim is withdrawn.**
  Three post-restart hosted verifications failed in a row — twice with an audit
  step running past five minutes and losing the work item's lease
  (`brain_complete_work: FENCE_LOST`), once with a bare `fetch failed` at the
  same point — and the first of them was the deploy that made every routing
  refusal defer, which is what lets these intents accumulate at all. The
  correlation was real and the mechanism is plausible. It is not established:
  the very next deploy, of a tree **without** this fix, passed. So what is true
  is that the unbounded rescan was a defect worth removing on its own terms, and
  that what actually slowed those three runs is **not known**. Recording it as
  the cause would have been the comfortable half-truth this file exists to
  refuse — and the next slow verification would have been debugged against a
  fixed bug.

  **A fourth has since happened, and what is worth recording is how narrow it
  is.** Schema 53's deploy: release success, the hosted verification
  `PASS 174/174` on the released image, then after the restart **156 checks
  passed — including every restart-survival check, the live lease, the fencing
  generation, the attempt history, the factory campaign and its writeback** —
  and it failed at the end with `brain_complete_work: FENCE_LOST` at the judge
  audit step, exactly where the other three did. So the shape is consistent:
  always post-restart, always the judge step, always a long step outrunning the
  work item's five-minute lease. **That is still a reading and not a cause**,
  and no fix is claimed for it — but the narrowing is evidence somebody
  debugging it should have, and the checks that did pass are the ones that say
  the released commit is live and its persistence survived.

  **A fifth has happened, and it put a number on the sentence above.** Run 235,
  `6b44cd5`: release success, the pre-restart hosted verification passed on the
  released image, and after the restart every restart-survival check passed
  again — the live lease, the fencing generation, the attempt history, the
  factory campaign, its three units, the review's verdict and independence tier,
  the writeback — followed by the whole identity, queue, idempotency and MCP
  surface. It then reached the audit roles and recorded, in order:
  `the three audit roles have three sessions across two accounts` at 08:03:35,
  the PRIMARY pass at 08:03:37, the ADVERSARIAL pass at 08:03:39, and then
  nothing until `HOSTED-VERIFICATION: FAIL could-not-complete` / `fetch failed`
  at **08:08:57**. That is **five minutes and eighteen seconds** of silence at
  the judge step, against a work item lease of five minutes.

  So the correlation is now tight enough to state precisely and still not a
  cause. Four of the five ended in `brain_complete_work: FENCE_LOST` and this
  one in a bare `fetch failed`, which is the same event seen from either side of
  a lease that lapsed mid-step — or two different faults that happen to land in
  the same place. **Nothing here establishes which**, and the next person to
  look at it should measure how long the judge pass actually takes before
  assuming the lease is the thing that is wrong.

  What it is *not* is a failed release. The image was released, and the
  verification that ran against it before the restart passed in full, so the
  commit is live and serving. A run that says `release: success`,
  `hosted verification: success`, `after the restart: failure` has proved the
  deployment and failed its own scripted packet, and reading it as "the deploy
  did not work" would send somebody to re-deploy a version that is already
  there.

  **A sixth run failed at the same place in the workflow and for a different
  reason, and calling it the same thing would have buried both.** Run 252,
  `a7e08fa`: release success, `HOSTED-VERIFICATION: PASS 198/198` on the
  released image, and then **the restart step itself** exited 126 —
  `flyctl apps restart` reporting *"failed to wait for health checks to pass:
  context deadline exceeded"* after five minutes of `Waiting for
  811d651c26d948 to become healthy (started, 0/1)`. The next step in the same
  job then answered **`healthy again after 1 attempt(s)`**, about twenty-five
  seconds later. So the machine restarted, came back, and `flyctl`'s own wait
  gave up first; the post-restart verification never ran at all, because the
  step before it had failed, and the verdict correctly refused a `skipped`.

  The distinction is worth keeping. The five above are a *check* that ran and
  failed late, always at the judge step, always consistent with a five-minute
  work-item lease. This is a *restart command* whose health-check deadline is
  shorter than this machine's cold start, with nothing wrong on either side of
  it. Reading the two as one condition would have somebody debugging a lease
  against a `flyctl` timeout. **And re-deploying is the wrong answer to both**,
  for the reason directly above: the image is live, and a re-deploy restarts a
  Brain holding leased work to re-prove something the pre-restart run already
  proved.
- **A fleet that is merely switched off said it had no routing row.** Every
  candidate was refused on its own state and `continue`d before any scope
  question was asked, so the flags those questions set stayed false and the first
  check after the loop claimed the refusal. A quarantined fleet therefore
  reported `NO_SURFACE_SERVES_THIS_FAMILY`, sending an operator to write a
  routing row when the answer was `fleet set-state`. §23's rule about naming the
  right refusal, applied to the one condition that bypasses every test it names.
- **A checkout is not a target, and noticing that a rule's reason is imprecise is
  not authority to reverse the rule.** A fired worker reads
  `.claude/settings.json` from the repository its Routine *attaches*, which is
  what lets it call the connector without stopping for approval — so a research
  Routine attaches `brain-worker-bootstrap` and a factory Routine attaches the
  repository its work is in. That distinction is real, and the retirement
  argument — "the factory's own executor must not be whichever target it last
  proved itself on" — was loosely worded about it. **From which I concluded I
  could put the retired repository back in the envelope, and that was wrong.**
  Oakwood's retirement is a standing operator decision recorded in
  `docs/OAKWOOD-RETIREMENT.md` and in two Routines still carrying *"oakwood
  factory proof complete surface out of active dispatch"*; an imprecise rationale
  is a reason to write the rationale down better, never to widen what the rule
  allows. It is removed again, the campaign created against it was retired
  through the supported transition with every row preserved, and the isolation
  properties it was re-added to demonstrate are proved against a **fixture**
  repository the envelope refuses — which is what they always should have used,
  because nothing about a routing boundary needs a grant. **The envelope now
  holds one checkout and no target at all**, so the factory has a proving ground
  and nowhere to do real work until a person names one. That is the honest state
  rather than a gap to be filled by whatever is nearest. `.claude/**` moved to
  `UNIVERSAL_FORBIDDEN_PATHS`, because a protection copied per repository is one
  that will be missing from one.
- **A second connector name is not a second identity, and a used token does not
  prove which Routine holds it.** The MCP credential is issued **per connector**,
  so one connector is one Brain worker however it is labelled — and the trap is
  the converse: selecting an existing connector in a new Routine hands it the old
  worker, and the routing boundary, keyed on the authenticated worker, then has
  nothing to separate. My first check for this read `fleet_routines.worker_id`
  and whether a token had been minted for that worker and used. **Both are true
  facts and neither is the claim**, which is the correction here: the binding is
  an operator's assertion, and a token is held by a *connector* rather than by a
  Routine, so "registered for worker X" and "X authenticated somewhere" can both
  hold of a Routine whose Cowork configuration selects a different connector
  entirely — the exact mistake the name invites.

  What settles it is a chain of four rows Brain wrote itself, in
  `services/dispatch/surfaceProof.ts`: Brain **fired** this Routine; a session
  **arrived** and was attributed to a worker *from that same dispatch row*, never
  from anything the worker said; it was **assigned** the bin; and the bin reached
  **COMPLETE**. Arrivals with no completion prove a connector and not a surface.
  Arrivals under a different worker are a **fault** rather than a missing proof
  and are named as one. `verify-surface --probe` creates the controlled fire: one
  bounded `DETERMINISTIC_CHECK` bin belonging to no campaign, forbidding every
  repository operation, that exists only to be fired at, answered and finished.
  `CONFIGURED` and `OBSERVED` stay two blocks that must not be confused, and a
  perfect configured block over an empty observed one refuses rather than passing
  — `evidence_class` at an operator's command.

- **The factory had no entrance from a conversation, and Build was not the
  gap — a second pipeline would have been.** A person could describe a change to
  a site in Russell and get a conversation back, because `PROPOSAL_ACTIONS` held
  eight actions and none of them reached the factory. `REQUEST_SOFTWARE_CHANGE`
  is the ninth, and everything about it is arranged so it adds a way in without
  adding a way around: `services/factory/start.ts` is the one approve-and-start
  both entrances call, the contract, the evidence gate, the independent review
  and the two person-only decisions are untouched, and the whole effect a *turn*
  can have is an unauthorized row. **Discussing a change is not asking for one**,
  and that is drawn twice — deterministically on the person's own message, where
  deliberation and past-tense reports lose to any number of execution verbs, and
  structurally by the fact that a capture spends nothing and submits nothing. A
  model never names the repository: an extra field refuses the whole proposal,
  because which repository a project may change is an authorization in rows a
  person wrote, and the reach travels down with the choice they make from the
  list their project was actually given.

- **An optional field defaulting to the widest value is not a boundary, and
  narrowing afterwards cannot correct one.** `mutationScope` was optional and
  defaulted to `['**']`, so the safe answer was the one somebody had to remember
  and the unsafe one was free — and `amendContract` may only *narrow*, so an
  over-broad initial scope is the widest reach that campaign will ever be judged
  against, with the units already planned against it. The boundary is a fact
  recorded before any objective exists, in the action that authorizes the
  repository for that project at all, with **no default**: `scope_kind` records
  whether a person chose the whole repository or named directories, because
  `['**']` has to be a choice and *somebody said so* is a different fact from
  *nobody said anything*. A person names directories and the server writes the
  globs — a glob is a small language and a boundary written in one is a boundary
  somebody widens by accident.

  It is checked **at submission**, which is a strictly stronger question than
  the one routing already asks and is asked when it is cheap. `bins/routing.ts`
  refuses to hand a repository bin to a worker not registered for it, correctly
  and *late* — after a change request, a campaign, a plan and bins exist. This
  asks whether *this project* may change this repository and inside which paths,
  before a row is written. On the remote path only, on the line `execution_mode`
  is already derived from: a local pin is a person at a terminal with the
  checkout in front of them, which is how the bootstrap campaign ran in the one
  repository the envelope deliberately does not grant.

  **Separate repositories and folders in a shared one both work, and choosing
  is not a prerequisite for the first campaign.** Separate: one grant, one
  worker, one surface each, separated by `worker_routing.repositories`. Shared:
  one grant, one worker, one surface, one boundary row per project — and two
  projects holding `sites/v4/**` and `sites/v2/**` cannot reach each other's
  files. The properties are proved against a **fixture** repository the envelope
  refuses, because a routing boundary needs a routing row and a manifest and no
  grant at all, and a test's convenience is never a reason to widen a production
  authorization.

- **Brain is an authorized target now, and that is the operator's decision
  rather than a softening of the argument against it.** An earlier bullet in this
  section ends *"the envelope now holds one checkout and no target at all"*; that was true
  when it was written and is not true now, and it is corrected here rather than
  edited there. `V5`'s absence was mine: the envelope's own comment recorded it
  as a default written by the agent that built this, not a standing operator
  decision. The owner has since named Brain
  as an intended target, improved *through isolated branches, independent review
  and the existing controlled integration process*, with the running Brain's
  authorization and deployment protections preserved.

  The original worry stands and is not waved away — the factory lives in this
  repository, so a campaign here can reach the machinery executing it, and that
  is the one failure mode declining a pull request does not *by itself* contain.
  What changed is that the risk is bounded by rows instead of by absence. **A
  campaign may not edit what authorizes it, what bounds it, or what deploys
  it**, and that is a `forbiddenPaths` list rather than a sentence: the envelope
  and `projectScope.ts`, `services/identity/**` and `bins/routing.ts`, both
  approval envelopes, the whole of `.github/workflows/**` — the directory rather
  than `deploy*`, because §28's own lesson is that a *second* workflow is how the
  guard gets bypassed — plus `CANONICAL_BRANCH`, `fly.toml` and `Dockerfile`.
  They refuse *ownership*, never reading: a unit may read any of it and a
  reviewer must. Around that, unchanged: the campaign stops at a pull request,
  the review is independent by recorded lineage, the deployment branch policy
  refuses every ref but the canonical one, and a person merges.
  `oakwood-junk-removal` stays retired, which is a different decision.

- **A list can have the rule right and the alphabet short, and this is the
  fourth time.** §24 records three in `judgment.ts`. Here it was
  `EXECUTION_MARKERS`: the owner's own three examples were *"Add this feature to
  Brain"*, *"Fix this problem on V4"* and *"Improve this part of the site we're
  discussing"*, and the third came back **"nothing here asks for a change to be
  made"** because `improve` was not in the list. Widened by the verbs actually
  missed and no further, and the failure mode is what the tests pin rather than
  the successes — "we improved it last week" still matches nothing, because the
  word boundary excludes the past tense and nobody is being asked. The sentence
  that found the gap is never reworded to fit the list.

- **A request is filed against a project, and the project decides which code may
  change — so guessing which project is the Westbrook defect at a new
  altitude.** §25 records the original: a compiler read a jurisdiction out of
  prose, produced *"official Michigan public records … in Westbrook, OH"*, and
  every row around it was healthy. Here the same shape is a change request filed
  against the conversation's project while the message names a different one:
  the card would carry a real scope sentence, a person would authorize it, and a
  worker would change the wrong repository correctly.
  `services/russell/softwareTarget.ts` refuses instead of choosing, and the
  three rules are `jurisdiction.ts`'s. **A row outranks prose** — the
  conversation's attachment has provenance and a sentence does not.
  **Disagreement is refused, never resolved** — nothing is captured and the
  answer names both projects, which is the one case where asking is cheaper than
  being wrong. **Not knowing is an answer** — a thread with no project cannot
  resolve a repository, and that is `ASK_WHICH_PROJECT`. It can refuse and it
  can never *redirect*: naming another project never files the request there,
  because that would let a sentence move work into a scope nobody attached it
  to. It reads project rows rather than a list of site names, matches on word
  boundaries so `rAPId` is not `API`, and is skipped entirely for a project the
  asker cannot read — a check that only ever adds a refusal, so losing it loses
  a clarification rather than a control.

- **Fifteen misses in one pass is not a short alphabet; it is the wrong shape.**
  The bullet above records the fourth widening of `EXECUTION_MARKERS`, and each
  of the four added the one word a real message had just been declined for.
  Driving fifty ordinary sentences through the gate found **fifteen more misses
  and two inventions** at once — *"Move the phone number into the header"*,
  *"Turn off the newsletter popup"*, *"Wire the booking button to the calendar
  page"*, and, in the other direction, *"No need to fix the footer"* read as a
  request to fix the footer. Adding fifteen words would have left the sixteenth
  for production. So the structure changed and the vocabulary only came along
  with it, in three ways:

  **A verb is strong or weak, and a weak one counts only in imperative
  position.** `fix` is an instruction wherever it appears; `set`, `move`,
  `handle`, `point` and `link` are ordinary English until they open a sentence or
  follow *please* / *could you* / *let's*. That is what lets the list hold the
  words people actually use without reading *"the address on the contact page is
  wrong"* or *"do you know how the form works"* as instructions.

  **Negation is scoped to the occurrence, not to the message.** Every match is
  examined for a negator in its own clause — back to the sentence boundary, then
  forward past the last contrast marker — and the message asks for a change only
  if **some** occurrence is un-negated. A message-level flag would have declined
  *"Don't touch the pricing page, but do fix the footer"*, which is wrong in the
  expensive direction: the person did ask, and Russell would have looked like it
  ignored them.

  **Anaphora is answered by a row, never by a word.** *"Do that for the contact
  page too"* has no execution verb and cannot get one, because the verb is in the
  sentence before it. It is admitted only when **this conversation already holds
  a software request** — a referent Brain wrote down. The check runs *before* the
  verbs and applies whichever verbs are present, because *"apply the same to the
  quotes page"* holds a weak imperative and still names nothing: a capture there
  would file an objective nobody could act on. A referent from another thread
  does not count.

  **A closed list can never be complete over ordinary English, and that is why
  the failure mode is fixed at *missing*.** A miss costs one more sentence and
  Russell says which one would work; an invention puts an authorization card in
  front of somebody thinking aloud, which teaches them to stop reading the cards
  — §29's damage from a status that contradicts the control beside it. **Build
  never consults this gate**, so there is always an entrance no sentence can be
  mis-read at. The corpus is `tests/softwareRequestPhrasing.test.ts`, declared in
  families with its purpose written down, and the declines are the half that
  matters.

- **The question Brain would not guess past was composed, carried and read by
  nothing.** `softwareTarget.ts` wrote the sentence, `turn.ts` put it on the
  message row as `produced.clarify`, and no projection, route or component ever
  looked at it. So a person whose message named two projects got an ordinary
  reply and no card, with nothing anywhere saying Brain had stopped on purpose or
  what would unstop it — §24's *waiting nobody can resolve* at a new surface, and
  the fifth time this file has had to write that **a mechanism nothing calls is
  not a mechanism**. `softwareClarificationFor` is the reader: a projection in
  `pending.ts`'s shape that writes nothing, reports only the most recent refusal,
  and stops reporting it the moment a request captured *after* it settles the
  question — answered by doing rather than by saying.

  **Only the answerable refusals reach it, and that is the design rather than an
  omission.** *"It weighs a change rather than asking for one"* is a correct
  refusal to a remark; printing a prompt under it would be Brain asking somebody
  to decide something they never raised. What surfaces is the case where they
  *did* ask and the only thing missing is a word only they have — which project,
  or what *that* refers to. The client renders the server's sentence and composes
  none of its own, for the reason the authorization card does.

- **Brain as a target is enforced by the planner, not by the list.** The grant's
  `forbiddenPaths` is a declaration, and `factoryExecutionPlane` asserting it
  contains the right strings proves only that somebody typed them. Each one is
  now put through `validatePlan` as a unit claiming to own it — including a
  *second* deploy workflow under a new name, which is the bypass §28 records and
  which a pattern naming `deploy.yml` would have allowed. Ordinary product code
  still passes, and `requiredContext` may name a forbidden file: the list refuses
  **ownership**, never reading, and a reviewer of a change that has to agree with
  the policy module must be able to open it.

- **A question Brain asks has to be answerable in the words a person answers
  in.** The gate declines *"V4"* — two characters, no verb, nothing to do — and
  it is right to: that is not a change request. But it is the correct answer to
  the question Brain had just displayed, and nothing joined the two, so the only
  way forward was to retype the whole instruction. **A remedy the person cannot
  use is not a remedy**, which is §24's sentence arriving in a conversation.

  The ask Brain refused is kept on the message row it refused it on —
  `pendingAsk`, the three fields `validateProposal` had already accepted that
  turn — with `clarifyChoices`, the projects an answer may name. A later reply
  that names exactly one of them finishes the original request. It resolves
  **before** anything a model proposed and returns, because a worker that has
  read the thread will often restate the change in its own words and a reworded
  objective is a different submission key: one answer would otherwise produce
  two cards for one decision. Nothing else moves — same row, same `PROPOSED`
  state, same card, same person approving it. A reply naming none, or two,
  leaves the question standing, because choosing for somebody who has just said
  they are choosing is the defect this whole path exists to avoid.

- **Mentioning a project is not choosing it, and for a while it was.** In a
  Brain-attached thread, *"Do not change Brain, but fix the broken form in V4"*
  passed the gate correctly — the person did ask for a fix — and then resolved
  to **Brain**, because `resolveSoftwareTarget` treated any mention of the
  attached project as agreement. A card would have been produced for the one
  project the person had ruled out in the same sentence, which is the Westbrook
  defect with the exclusion in plain sight.

  The rule that replaces it is one sentence: **a sentence can rule the row out;
  it can never replace it.** An exclusion is read per mention, from the same
  clause-scoped negation the gate uses, and it only ever *removes* a candidate.
  With the row still standing, naming another project is a disagreement Brain
  refuses rather than resolves — unchanged. With the row ruled out there is no
  row to defer to, so the sentence's own destination decides: exactly one
  readable project named after a preposition of place resolves, and anything
  else is a question. The excluded project is absent from the answers that
  question offers, so it cannot come back through the reply either.

  The exclusion vocabulary is deliberately **wider** than the gate's — it adds
  bare `not`, `except`, `other than`, `apart from` — and the asymmetry is the
  argument: an exclusion can never choose a project, so a false one costs a
  question, while a missed one files work against something somebody said not to
  touch. `negation.ts` holds the half both readers share, in its own module,
  because a rule kept inside one of its two callers is a cycle waiting to be
  found by whichever file loads first.

- **The answer was read for mentions, so "Not Brain" chose Brain.** The
  correction above stopped a *mention* deciding the target in the request; one
  message later the reply was still being read the old way, and the result is
  the worst shape a clarification can fail in — the person was answering a
  direct question and got the project they had just ruled out. A reply is now
  read exactly as a request is: every mention carries whether a negator governs
  it, and an exclusion only ever removes a candidate.

  **Exclusions belong to the request, not to the sentence that carried them.**
  They travel on the question as `clarifyExcluded` and are subtracted before the
  offered list is consulted — *including when that list is empty*. An empty list
  means the question named no candidates; it never means anything goes, and
  treating it as the second is exactly how *"do not change Brain"* handed Brain
  back to the next reply that mentioned it.

  **One candidate left is an answer; two are not.** A reply naming exactly one
  live project resolves it, and a reply that only rules something *out* resolves
  only when one candidate remains — *"not Brain"* against *"Brain or V4?"* is
  V4, while the same words against three candidates narrow rather than choose
  and the question stays open. The bare-pool case is guarded on the reply having
  actually excluded something, so *"whichever you think"* can never be an answer
  just because the pool happens to hold one.

- **Both of those were found by assembling the path, not by reading it.** Each
  helper was correct on its own and the product was not, which is why
  `tests/softwareConversationPath.test.ts` drives `beginTurn` → a scripted worker
  answering the bin → the tick, and asserts on rows and on the displayed
  question. The helper suites stayed; what they could not see is what a person
  types *next*.

- **Onboarding happens when a target needs it, and the ask survives the wait.**
  A person asking for a change in a project with no repository gets it written
  down, plus the sentence naming what is missing and where to do it; the *same*
  row becomes authorizable the moment somebody onboards one, with the reach it
  then has. Nothing is asked for again — the same promise
  `rearmSurfaceDeferredIntents` makes one layer down — which is what keeps the
  product usable before every site's repository arrangement has been settled.

A worktree is the one factory path that is deliberately *not* authoritative
state in either mode: it is execution scratch, the evidence is the commits, the
rows and the artifacts, and retiring one destroys nothing that mattered. It
carries a symlink to the repository's `node_modules` because a worktree that
cannot run the repository's own commands cannot be verified.

## 28. One branch owns production.

`.github/CANONICAL_BRANCH` names it, and it is **`production`**. Step 12A,
Website Connection and the Software Factory merge *into* it and deploy from it;
none of them deploys itself.

**This is a rule written from damage, not from tidiness.** Three branches were
dispatching the one `Deploy` workflow at the same Fly app, and each overwrote
the last. `/operator` came back twice in one evening — nobody re-added it; a
branch that predated its removal simply deployed after the branch that removed
it, and a connector went missing the same way. A feature branch reaching
production is not a mistake somebody makes once. It is the default behaviour of
a dispatchable workflow with no opinion about its ref.

The guard is the first job in `deploy.yml`, everything else `needs:` it, and it
refuses two things rather than one: **a ref that is not canonical**, and **the
canonical branch when the checkout is behind its own remote** — because a re-run
of an older dispatch is the same rollback wearing the right branch name.

- **Say what a workflow guard cannot do.** `workflow_dispatch` runs the workflow
  file *from the ref it is dispatched on*, so a branch whose copy of
  `deploy.yml` predates the guard has no guard. The control that binds every
  ref is GitHub's **deployment branch policy** on the `production` environment:
  it refuses the job before it starts and cannot be edited by the branch being
  deployed. The job is the fast, legible half; that setting is the enforcing
  half. Claiming the first is the whole control would be the kind of comfortable
  half-truth this file exists to refuse — see `docs/DEPLOYMENT.md`.

  **It is set, and it has been exercised rather than assumed.** A branch cut
  from `production` — identical tree, so a fall-through deploy could only be a
  no-op — was given a marker naming itself so the in-workflow guard passed and
  execution reached the deploy job. GitHub refused it: *Branch "guard-probe" is
  not allowed to deploy to production due to environment protection rules*, with
  zero steps and no log, because no runner was ever allocated. The environments
  API is blocked through the agent proxy, so this is the only way the policy can
  be verified from here, and an unverified setting is not a control.

  It binds the *next* deploy, not the last one:
  `claude/zealous-hypatia-78a2yp` released an image at 01:35:30Z on 2026-09-11 —
  after the canonical deploy — and put `/operator` back, because its two-job
  `deploy.yml` predates the guard and the policy did not yet exist. Repaired by
  re-deploying `production`. **That is the damage this rule is written from,
  observed twice.**
- **The branch name lives in one file.** The workflow reads
  `.github/CANONICAL_BRANCH`; it does not restate the name. A second copy is a
  second thing to forget.
- **Converging branches is checked, not assumed.**
  `tests/deploymentOwnership.test.ts` names a file each workstream owns and
  fails if a merge dropped one, and walks both migration chains for a gap or a
  collision. A merge that loses work is otherwise silent until production.
- **A future session inherits this.** Do not dispatch `Deploy` on a feature
  branch, do not add a second workflow that runs `flyctl deploy`, and do not
  "temporarily" deploy a branch to test something — that is precisely what
  happened, twice, and the cost was a deleted surface coming back.
- **A worktree holding the canonical branch is a third way the same damage
  arrives, and one turned up.** A scratch worktree had `production` checked out
  with a *reversal of a whole session* staged in its index: `packets.yml`
  deleted, the committed visual evidence deleted, `CLAUDE.md` and two suites
  reverted — 72 files, 7 850 deletions, against a `HEAD` that was two commits
  stale. Nothing had gone wrong yet, because a worktree deploys nothing by
  itself. One `git commit -am` and a push from inside it would have put a
  deleted surface back on `production` for the third time, and the commit would
  have looked deliberate.

  The remedy that does not depend on noticing it again is to **never advance the
  canonical branch by checking it out**. `git push <verified-branch>:production`
  moves the remote ref by a fast-forward the server itself verifies, touches no
  working tree, and cannot carry a stale index with it. Confirm it with
  `git merge-base --is-ancestor origin/production <branch>` first, so a
  non-fast-forward is refused before it is attempted rather than after.

  **A test cannot catch this**, and saying so is the point: a worktree is
  machine state rather than repository content, so `deploymentOwnership` can
  refuse a migration collision and a port collision and can never see this one.
  What it is, is a reason the push is written down here rather than left to
  whichever command came to hand.


## 29. A product is what a person can do, and every number in it is a row.

Step 12B (`client/src/russell/`, `server/services/russell/`,
`server/services/fleet/`, `docs/STEP-12B-MATRIX.md`) is the product surface over
everything Steps 1 to 12C built. The owner rejected the September 11 interface,
and this section records what was actually wrong with it — because a rejection
is evidence of a problem and not approval of whatever replaces it.

**"0 of 8 settled" was accurate and read as failure.** That is the whole lesson
in one string. The project it described was working: three foundations were
being researched, claims were being accepted, an audit had run. The sentence was
true and it told a person the opposite of the truth. So `progress.ts` now
carries a **milestone state** beside the arithmetic — `DONE`, `WORKING`,
`BLOCKED`, `OPEN` — and a **named denominator**, because eight is not a quantity
until you know eight of what. A project with nothing settled and three
foundations under way is described that way; one with nothing settled and
nothing happening is still told plainly, because §6 forbids dressing that up.
The fraction is still a fact and is still reported; what changed is that it is
no longer the only thing said.

**Content clipped between 822 and 953 pixels because the wrong thing was asked
how wide it was.** A media query asks the *viewport*; the element that was
clipping was a column inside a rail. `container-type: inline-size` asks the
container, so the same component is right on a phone and in a drawer without a
second rule — and the fix is pinned by `tests/step12bResponsive.test.tsx`, which
also refuses any `min-width` wider than a phone and allows only a table, a map
and a tab strip to scroll sideways, each inside its own container.

- **One projection answers every surface.** Progress, status, recent changes,
  next action and decisions come from `home.ts`, `progress.ts` and
  `projections.ts` — never re-derived per page. Two surfaces inferring their own
  status from prose is how a person reads two different answers about one
  project, and the project page is exactly where somebody would write a fresh
  summary and produce one.
- **A collection is a row; a rank is not.** Organization is deterministic and
  invents no category: a thread with a project goes in that project's
  collection, a private one goes in Personal, everything else is unfiled and
  says so. The automatic pass is guarded so it can only ever write over its own
  decisions — `collection_source`, the same shape `attachment_source` already
  gives project routing. Rank is *derived*, because "major and unfinished" is a
  fact about live missions and the last turn, and a stored one would be stale
  the moment a worker answered something.
- **The frontier is a derived reading that is remembered, and that is
  deliberate.** Everything about a project's edges can be re-derived; the table
  exists for the two things a pure derivation cannot do — remember that an area
  *stopped* being on the frontier, and hold a person's statement that one is
  deliberately not required. An item that stops being derived is **resolved,
  never deleted**, because a delete makes a dark spot look like progress.
- **Five discovery lenses are answered and five are asked.** An earlier version
  of this line said four asked, and `LENSES` has always declared five
  (`MISSING_MECHANISM`, `FIXED_VARIABLE`, `TRANSFERABLE_LESSON`,
  `ADJACENT_POSSIBILITY`, `WHAT_THE_MAP_HIDES`). The count is corrected rather
  than a lens removed to match the sentence. Which assumptions
  have nothing supporting them, which findings contradict each other, which
  declared region has no work in it — those are rows. What adjacent possibility
  is absent, what lesson transfers from another project, what the current map
  makes impossible to see — those need a reader. The engine puts them with the
  subject attached and **answers none of them**, because a Brain that filled
  them in from a template would be manufacturing insight, which is §8's rule at
  the one altitude where it is most tempting to break.
- **A map draws only relationships that are recorded.** The money-flow map is
  usually empty here and says so: the margin, the costs and the contacts are the
  connected site's and stay there (§25), so Brain has nothing to draw. An empty
  map for an absent subject is the correct output, and inventing edges to finish
  a diagram is an invented citation one altitude down. Every map carries a
  synchronized outline built in the same pass, so the screen-reader path and the
  picture cannot describe different graphs.
- **Search decides its scope before it queries.** The readable projects come
  from `decideProjectAccess` and every statement is bounded to them, so
  "nothing found" and "nothing you can see" are the same answer — a search that
  fetched broadly and filtered afterwards is one forgotten `.filter()` from a
  disclosure, and the *count* alone is information. A private thread stays its
  owner's whatever their project rights.
- **The fleet reports three numbers that are not each other.** A target somebody
  configured, a capacity the surfaces can serve, and a throughput Brain has
  observed, each with its own evidence label. Whether the backlog fits is
  **null** when nothing has been measured, because a confident yes without a
  measurement is the arithmetic-on-a-fiction §23 already corrected once.
  "Why is this slow" joins the bin's own recorded events and names the largest
  gap from the two events either side of it; no branch consults a clock to
  decide what happened, and none consults a worker's account of itself.
- **The Capability Lab is exact about what it will not do.** A health check
  reads rows and costs nothing — a check that fired a worker to learn whether it
  works would spend the allowance to discover what the rows already say.
  Calibration reads `bin_events`, the only measurement Brain did not
  manufacture. The five pressure modes are declared with a full envelope,
  refused outside an isolated `TECHNICAL` scope, refused without a person
  authorizing the pressure, and refused **by name** when unimplemented rather
  than returning plausible numbers. Both tempting alternatives are recorded and
  refused: simulating them produces figures a reader cannot tell from
  measurements, and running them unattended spends real capacity against a
  ceiling nobody set. **The mechanism is complete and the measurements are not
  taken**, and saying so is the honest report.
- **A preference may never change a fact.** `PREFERENCES` is a closed set of
  presentational keys checked on write, so there is no shape here that could
  hold an evidence floor or an authorization rule. Adding a key is a code change
  somebody reviews, which is where "does this change a fact?" gets asked.
- **Why this matters is quiet by construction.** Every line is a frozen layer, a
  filed report, an accepted conclusion or a closed question with the row behind
  it; it needs two milestones before it surfaces at all; and it has no streak,
  badge, point or confetti in it. It returns null far more often than it returns
  a sentence, because an encouraging screen over an empty project is what makes
  a person stop believing the rest of the product.
- **Needs You reads as the settled state it usually is.** An empty inbox says
  what continues without anybody and folds the standing authority to one line —
  with the whole card still in the document, because a summary that pointed
  somewhere else would move the withdraw control to a page that does not have
  it. The approval a project cannot proceed without is never folded.

  **And the empty list is not the empty page — this page said it was, after the
  briefing and the badge had both been corrected.** A project with no standing
  grant has exactly one decision outstanding, and `AuthorityPanel` correctly
  refuses to fold it; the heading above it still announced *"Nothing needs your
  decision"* while the nav badge beside them read 1. Three readers of one fact,
  two of them fixed and the third left asserting the opposite — which is the
  same defect this section already records, one surface along, and **a status
  that contradicts the control beside it is worse than no status.** It asks the
  same question the badge asks, from the same route, rather than inferring it
  from the list: two places counting one thing is how they come to disagree,
  and is exactly how this happened. While the answer is unknown the
  reassurance is withheld rather than guessed, because an incomplete page is a
  better wrong answer than a false settled one.

**`/legacy` is not `/operator`, and the difference matters.** The operator
console is deleted and stays deleted (§26). The old three-pane *main* console is
one click away and holds seven archive operations — importing, extraction
inspection, manual runs, freeze and reconcile, prompt and packet internals,
provider configuration, ingestion review — every one of which §23 says belongs
*away* from the product surface rather than on it. Ordinary operation happens
entirely in Russell. `docs/STEP-12B-LEGACY-MIGRATION.md` is the inventory, taken
from the code.

**A column nothing reads is not an answer, and this fleet had one.**
`fleet_routines.state_reason` has been written on every quarantine since the
first-`AUTH`-quarantines rule shipped (§23), carrying the provider's own words
for what refused the fire — and it was read by nothing: not `fleet show`, not
the API, not the UI. So the fleet reaching a state with **no usable surface at
all** showed `QUARANTINED` beside a Routine and offered nowhere to find out
what had happened, while the answering transition §23 documents is "`fleet
set-state` once the secret is fixed". **An escalation whose remedy names a
thing to correct is not a remedy while the thing to correct is invisible** —
§24's own sentence, at a column rather than a state machine, and the fifth time
this file has had to write it.

It is two readers of one row, and they are deliberately different. The
category — *held back after a refusal that needs fixing* — is what a person is
owed and does not change. The recorded text is the evidence, and it travels
with the raw identifiers at technical depth, because §14 says technical detail
is what a caller is *owed* rather than what it asks for. A healthy surface's
last recorded reason is history rather than a condition, so neither reader
prints it.

**Reading it is not the same act as clearing it.** A quarantine is a health
state Brain set from something a provider actually did, and lifting one so that
an acceptance gate stops reporting `NO_HEALTHY_EXECUTION_SURFACE` would be
weakening the control to satisfy the evaluator — exactly what
`independenceEvidence.ts` re-checks its own guard to prevent. The gate is
*correct* to say so: it is an operational fact with an operational remedy, and
the remedy is to fix the surface and prove it with a fire that arrives.

**Both halves of that happened, and the surface was right about the cause.**
The recorded reason was `AUTH: 403 {"message":"routines are not available for
this organization","type":"permission_error"}` — an **organization-level
entitlement**, not a credential and not a Brain defect. The same token had
fired that Routine 260 times before it. What had happened outside Brain was a
subscription lapsing to Free for the length of a billing switch away from the
App Store, which is exactly the shape of condition the first-`AUTH`-quarantines
rule exists for: not transient inside a retry window, and not permanent either.

The transition that answered it is the one §23 already documented —
`fleet set-state --kind routine --to ENABLED` — and nothing else was touched.
Not the Routine, not the credential, not the worker identity, and not the
execution path: **a historical `AUTH` is never a reason to rotate a secret or
reach for a paid API**, because doing either would change what the recovery
proves. One transition, one fire, and the evidence is the bin's own trace:

    DISPATCH_ROUTED   SELECTED V1 on primary: 0/2 Routine, 0/2 account
    DISPATCH_SENT     session cse_01XCUQgeYWmMTwUVpyLNihAE
    BIN_TAKEOVER      worker wkr_1cdd82cfb2a54faf8edd, authenticated session
    BIN_ITEM_CLAIMED  ×3
    BIN_ATTEMPT_CREDITED ×2
    BIN_RELEASED      "PRIMARY audit complete and checkpointed"

Ten minutes either side of it are the honest before and after: the same bin
recorded `DISPATCH_DEFERRED NO_SURFACE_SERVES_THIS_FAMILY` at 08:54 and again
at 09:04:06, and routed at 09:04:46. **A recovery is a fire that arrives and
finishes something, never a state column that changed.**

And what the bin did *next* is the floor working rather than a second failure:
`BIN_ASSIGNMENT_REFUSED — ADVERSARIAL would share the same session as PRIMARY`.
The connector presents one OAuth access token per hour, so the adversarial role
waits for a session that is genuinely distinct. That is §23's three-session
minimum refusing to be satisfied by one model context wearing two role names,
and `sessionWindow.ts` is what stops the wait being longer than the token's own
life.

**A branch nothing can reach is not a branch, and a stylesheet can hide one.**
`RussellShell` had a `mode === 'BAR'` arm inside the More menu, written for
phone width, tested, and reachable by nothing — because
`.rs-shell-bar .rs-rail-foot { display: none }` removed the element the menu
lives in at exactly that width. What went with it was not a nicety: Search, the
depth control, Build, Connected sites, Full console and **Sign out**. A person
on a phone could not sign out of Brain. That is the file's own recurring
sentence — *a mechanism nothing calls is not a mechanism* — arriving somewhere
it had not been looked for, because the mechanism was React and the thing that
disabled it was CSS, and no test of either half could see the other. It is
found by driving the product rather than by reading it: the harness asks every
thumb-bar cell and the send button `document.elementFromPoint` at its own
centre, because **a box of the right size in the right place is still not a
control if something else is painted over it** — or if nothing is painted there
at all.

**One continuous journey proves the path; three isolated interactions prove
three controls.** The mobile harness used to open its own address per
interaction, do one thing and stop. §29's J is the path between them, so it is
now one browser, one session and one scroll history, and after the first
address nothing navigates. That change is what surfaced both defects above,
neither of which any single-screen capture could have shown.

**A committed screenshot is evidence of one run at one commit, and says so in
its first paragraph.** `visual-qa.ts` writes to a throwaway directory by
default for the right reason — a stale image that still looks like evidence is
worse than none. One set is committed anyway, because a decision somebody must
run a twenty-minute harness to see is a decision nobody makes, and the approval
§29 asks for is a person's. Deleting the set breaks no test; it drops H, J and
O back to what the code alone can say, which is the correct behaviour rather
than a failure. **The reporter never promotes O to `PASS` however good the
images are** — a reporter that could would be approving its own work.


**A ring cannot seat nine labels on a 316px canvas, and no value of the stagger
makes it — so the narrow arrangement is a different one rather than the same one
squeezed.** The pile-up had been fixed twice by looking: first by spreading eight
nodes on one ellipse, then by staggering every other node onto `0.62` of the
radius. Measured, the second is not imperfect, it is **arithmetically
impossible**: at a 390px viewport the canvas is 316px wide, so the inner ring
lands 59-75px from the centre while a node's half-width alone reaches 73px. An
inner node cannot clear the nucleus at any label size. Below `RING_MIN_CANVAS`
the same graph is drawn as a **spine** — the nucleus at the top, its children in
two grid columns, one connector each running down the gutter between them — and
the difference that matters is not how it looks but what it guarantees: **the
ring is only known not to overlap for the labels this projection produces, while
two nodes in two grid cells are disjoint whatever the label does.** Nothing is
truncated, nothing is abbreviated, and the node count is untouched; the picture
and the outline are still the same graph, and the harness now counts both rather
than assuming it.

**A reading taken at one width is a claim about that width.** The overlap was
asked about once, at 390px, inside the phone journey — so nobody knew whether
the ring seated its labels at 953px or only looked as though it did. It did not:
the intermediate width carried a pair the whole time, at every reading taken.
It is measured at every width now, and `RING_MIN_ARC` is set from what was
measured rather than derived — 179px of arc per node at a desktop canvas holds,
134px at the intermediate one does not — which is why the constant says
"measured" in its own comment. A number chosen by looking is fine; one that
*claims* to be derived is not.

**A render in the wrong typefaces is a picture of a different product.**
`client/index.html` links the Google Fonts stylesheet and the harness's Chromium
has no proxy, so every capture ever taken rendered on the fallback stack — which
the run reported honestly as an environment fact and then carried on. That is
right for a layout check and wrong for the thing these captures are now for: type
sets every label width, and a label width is what an overlap is made of. The two
font hosts are answered from Node, which does have the proxy — the same URLs, the
same bytes, and **no loosening of the browser's trust**, because a harness that
disabled certificate checking to get a picture is a pattern somebody copies
somewhere it matters. The superseded ring measures differently in the two font
sets (9 pairs against 8 at 390px) and both readings are kept, because the claim
is what they agree on rather than either number alone.

**Answering the one decision on a page must change the page.** Driving the
approval found it: pressing **Approve** wrote the grant, and `NeedsYouView` went
on saying what it had said before, because it reads the authority through its own
query and nothing told it to look again — the nav badge beside it counting the
same fact from the same route was equally stale. It is the *under*-claiming
direction, which is the way round §29 asks for, and it is still the defect this
section already records twice: a status that does not agree with the control
beside it teaches a person to stop reading it. The card says when it changed
something and every reader goes back to the server.

**And the harness's own check was wrong in the more expensive direction.** It
waited for the settled sentence on the page around the card, so it reported that
the standing authority *could not be approved* while three later captures showed
it plainly granted. **A false finding costs more than the defect it was looking
for**, because somebody spends an hour on it. It waits for the control the card
itself swaps in now — which is deliberately not the thing the fix above
changed, so it would have passed against the stale build and still fails if the
grant does not land.

## 30. Cash Mode is a section, not the definition of Brain.

Cash Mode (`server/services/cash/`, `server/repos/cash*.ts`,
`client/src/russell/Cash.tsx`, `docs/CASH.md`) is a temporary operating section
inside the broader Brain: it searches broadly, assembles a private portfolio of
cash-producing opportunities for one account, and is meant to be wound down
after a month or two while the income, the customers, the records and the
reusable methods stay. Everything it adds is a new *entrance* to machinery
Steps 4 to 12C already built, and none of it is a second set of rules.

- **It holds the one thing Brain never has: money, and the authority to spend
  it.** There is no second identity model, no second work queue, no second
  policy module and no second orchestration universe here. Privacy is a
  `project_memberships` row read through `decideProjectAccess`; discovery is the
  Russell candidate → judgment → mission path; execution is the fleet. Four
  people means four *projects*.
- **The ceilings here are real, and §24's were not.** That section removed
  `russell_goals`' lifetime quotas because nothing they rationed was scarce —
  the subscription behind a research mission is already paid for, so a count of
  missions measured a starting point and then became a permanent wall. Cash is
  the opposite fact: a dollar committed to one opportunity cannot fund another.
  So `cash_authorities` is genuinely capped, and the cap is spent by
  `INSERT ... ON CONFLICT DO NOTHING` and a running sum through the row's own
  rank — **the sixth time this codebase has needed a compare-and-swap on a value
  the claimant does not supply.** It can under-commit and cannot over-commit.
- **A commitment is never released by time.** No TTL, no sweeper. §20's rule
  that a timeout is not evidence is at its sharpest where being wrong hands back
  spending room for money that may already have gone. A commitment is settled
  when the spend happened or released by a person who knows it did not.
  **A replay is not a new commitment**: the shortfall gate blocks *new*
  discretionary ones, and skipping it on a retry is what lets a caller who lost
  a response find out what happened to their money — the authority check still
  runs, because that is the half a revocation can change.
- **A commercial grant is not a research grant, and merging them would widen
  every mission already running.** A 12A standing authority carries
  `ALWAYS_PROHIBITED` — `NEW_SPENDING`, `PURCHASE`, `CONTACT_PERSON` — and
  `max_external_spend` of zero, because those grants authorize reading published
  sources. So `services/cash/authority.ts` is a separate grant with its own
  actor, its own closed set of `COMMERCIAL_ACTIONS` and its own
  `ALWAYS_PROHIBITED_COMMERCIAL` unioned in at creation. Neither reads the
  other.
- **Every money figure is derived, and a cost is subtracted once.** §5's six
  numbers come from `cash_money_entries` and are stored nowhere; a balance
  column would be a second master and the one nobody reads is the one that
  drifts. A cost leaves the account in *available funds*, so *deployable*
  subtracts only what has not left yet — unpaid bills, held commitments,
  reserves. Subtracting it again understates deployable cash by everything the
  sprint ever spent and **gets worse the better the sprint goes**, which is the
  shape of error nobody notices because it looks like caution. A
  `CUSTOMER_PAYMENT` and a `SETTLEMENT` are two events about the same money and
  only the second is cash; a payment with no verifiable reference is pipeline.
- **An unknown is never a favourable assumption.** The evidence card reports,
  per field, the answer or *the task that would produce it* — a missing phone
  number is an access task, a missing supplier price is a quoting task — and
  nine load-bearing fields must be answered before anything is ready to test. A
  buying signal with **no observation date is not evidence**, because an undated
  signal cannot be told apart from one somebody remembers from March.

  **The ranking had the same rule and broke it, and the correction is recorded
  rather than quietly applied.** `conservativeContribution` treated an unknown
  exposure as zero, so a piece nobody had costed came out at its whole price and
  ranked *above* an identically priced one somebody had costed. The card refused
  the blank and the ranking rewarded it. A blank may never be the reason
  something rises, wherever it is read.
- **No probability is invented.** The order is lexicographic over observable
  facts, in the plan's own sequence, rather than a weighted score: a score needs
  weights, weights are a judgement nobody made, and the number reads like a
  measurement. The disposition of each piece — execute now, run in parallel,
  wait for a named dependency, test a decisive unknown, archived — is derived on
  the read path and stored nowhere, because a row is not a decision and a stored
  label is stale the moment the dependency it waited on settles. **Every wait
  names what it waits on**: another opportunity, the cash, or the capacity.
- **Winding down stops new discovery and nothing else.** `russell_cycle` is a
  singleton whose pause stops the entire Russell tick — writeback, request
  resumption, every other project — so a sprint's off switch wired to it would
  stop the Brain to end one person's sprint, and it would look like it had
  worked. Nothing in Cash Mode references it, and that is **asserted by a test
  that reads the source**, because a Brain whose whole tick was paused would
  pass every behavioural test in that file with nothing else running either. The
  gate is asked at the producer *and* at `nextLaunchable`, because a guard on one
  entrance is not a guard — and there it is a **skip** rather than a refusal, so
  no state moves, no attempt is charged, and the idea launches by itself when
  the sprint is active again. Delivery, collection, settlement, needs and money
  work in all three states, because a sprint ending is not a customer's
  obligation ending, and `ARCHIVED → ACTIVE` exists because archiving destroyed
  nothing.
- **Two decisions are a person's and there is no path around either.**
  Activating the section, and saying what Brain may spend. Both are
  `requirePerson` plus `decideProjectAccess` at `ADMIN`, the level a membership
  change already carries. **No cash route names a worker scope**, so a machine
  is refused at every write by `MISSING_SCOPE`, at the two ADMIN routes by level,
  and at every route including the reads by principal *type* — §22's rule that a
  worker cannot create its own work, at the surface where the work costs
  somebody money.
- **A missing capability is a need with somewhere to go.** `recommended_path`
  and `next_step` are NOT NULL and an empty one is refused, because a need that
  names no remedy is §24's "waiting nobody can resolve" at a seventh altitude.
  An open need stops no unrelated work: nothing reads that table to decide
  whether an opportunity may proceed.

  **A need is answered because something is true, and three things about it
  were promises the table could not keep.** `closeNeed` accepted any non-empty
  sentence, so "done" resolved a need whose capability was still missing —
  `completion_condition` was required at creation and read by nothing. It is
  checked now, and `verified_by` says which happened: Brain read the rows and
  the condition holds, or a person authorized a **manual substitute** and said
  what they are doing instead. The second is a real and common answer and it is
  not the same fact as the first, so the row says so and the capability still
  reads MISSING.

  `request_key` was unique per project and `needForKey` ignored state, so once a
  need was resolved the key was spent: the same capability going missing a month
  later found the old row, was told it had already been raised, and never
  reached the review. `occurrence` makes each return its own row rather than
  rewriting a resolution that was true when it was written.

  And a continuation was **consumed before it succeeded**: `continued_at` was
  written permanently before the attempt ran, so a temporary refusal — no grant
  yet, no free slot, the piece not READY — burned the one chance the need had.
  The ordinary path made that the common case rather than the rare one, because
  a card answered by research leaves the piece at `EVIDENCE_CARD`. A claim is a
  lease now, `continued_at` is written only on a terminal answer, a wait is
  deferred with bounded backoff, and a claim whose tick died expires and is
  retaken — Step 5's rule at a new table, where an expired lease is claimable
  work so recovery never depends on one process staying alive.
- **Which envelope discovery runs under is a person's recorded choice from a
  reviewed set.** The compiler's in-code slug map has no entry for a project an
  operator created, so every idea in all four operations would have been refused
  for ever. `cash_modes.envelope_id` is the second source, validated against
  `SELECTABLE_CASH_ENVELOPES`: a mode may *choose* limits somebody else wrote and
  may never write any, which is §16's property unchanged. The in-code map still
  wins where it has an entry, so activating a sprint on an existing project
  cannot change that project's authorization.

  **`RUSSELL_CASH_DISCOVERY_V1` does not bound geography, and that is stated
  rather than hidden.** Broad discovery across industries and markets is the
  authorized mandate, and an envelope that refused an opening for being in the
  wrong state would refuse precisely the work it exists to permit. What bounds
  it is what it may *do*: published sources only, and a `forbiddenActions` list
  that refuses buying, contacting, advertising, publishing and committing. Every
  effect on the world is a `COMMERCIAL_ACTION` a person grants separately.
- **One identity per site per project, and the correction is recorded rather
  than quietly applied.** `connectSite` derived its worker from a single global
  name, so connecting the same site to a second project reused one identity: the
  second site's credential authenticated against **both** projects, connecting
  the second revoked the first's live credential, and the refusal that would have
  caught a caller reaching across is invariant 23's 404 — which by design tells
  nobody anything. One Brain with one site and one project never sees any of it;
  four private operations each connected to their own site is exactly the
  arrangement that does. A connection made before the fix still reads as
  connected, is resolved **only** where it holds a live membership, says
  `sharedIdentity`, and is retired on the next reconnect by revoking that
  membership — never its credentials, which are worker-wide and would disconnect
  every other project on them as a side effect.
- **The review compresses by shared remedy, and the compression is measured.**
  The same missing field, the same recommended path, the same blocker: answering
  one group releases every underlying item in it, and the count it stands for is
  reported rather than implied. An item with no group is its own group rather
  than dropped off the end of a top-ten list, and the decision nothing can
  proceed without is named first and never folded — §29's rule that a status
  contradicting the control beside it teaches a person to stop reading it.
- **A Brain administrator reaches every project by design, so the four daily
  accounts must not be Brain administrators.** That is a deployment fact rather
  than a code one, and it is written down here because the privacy boundary
  between the four operations depends on it.

- **A sprint had nowhere to get opportunities from, and said discovery had
  started.** Activating wrote a mode row and an event and nothing else — no
  goal, no candidate, no mission, no queued job — and `capture` had exactly two
  production callers, a person pressing a button and the reoffer service. So a
  freshly activated sprint could sit empty indefinitely beside a perfectly
  healthy fleet while the screen said otherwise, which is §24's *waiting nobody
  can resolve* arriving at a section rather than a state machine.

  `services/cash/discovery.ts` is the two halves that were missing and the whole
  of it rests on one rule: **Brain decomposes; it never invents a finding.** The
  plan's own search-bucket table is a closed set of declared places to look, so
  each bucket becomes one captured idea and everything after that is the path
  Steps 4 to 12A already built. No grant is manufactured: a project with no
  standing research authority compiles no specification and the idea parks.
  Turning a finished mission back into openings needs no reader either, because
  **a lane is a row** — `harvest` reads `evidence_lane`, not prose, and what it
  files carries a **blank card**, since a published request is evidence somebody
  asked and is not a payer, a price, an acceptance condition or a delivery path.

  It reads the *citable* set rather than the accepted-fragment one. A bucket
  question is broad by construction, so its fragment will often fall short on
  coverage while every claim passed the gate on its own; discarding them for
  that is the defect `citableClaims` was written for one altitude up.

- **Winding down stopped work nobody had asked it to stop, and the correction
  needed a second column.** The guard read every linked candidate as discovery,
  so it also stopped Brain researching a question needed to *deliver* what a
  customer had already been promised — the off switch reaching past the thing it
  owns, which is the `russell_cycle` mistake one altitude down. An idea about an
  opportunity that is EXECUTING, DELIVERING or COLLECTED is support work.
  `candidate_id` is the idea an opportunity *is*; a bucket is a broad question
  about none of the openings it found, so it goes in
  `discovered_by_candidate_id`. One column for both would have re-opened new
  discovery the moment any single opening started executing.

- **`EXECUTING` meant "the transaction is being pursued" and was written on a
  button press.** No work enqueued, no action performed, nothing anywhere a
  later reader could point at — so a piece could sit there for a week with the
  plan counting it as in flight. The transition is downstream of a
  `cash_actions` row now: append-only, `performed_by` is `BRAIN` or `PERSON` and
  there is no third value because *we think it happened* is not a record, the
  action is one of `COMMERCIAL_ACTIONS`, and the grant is asked about **that**
  action rather than about `CONTACT_BUYER` regardless. The action is written
  before the transition, so a crash between them leaves a piece READY with the
  action on the record — visible and retryable — rather than EXECUTING with
  nothing behind it.

- **A capability is read, never declared, and two answers stay apart.**
  `required_capabilities` was written by the card and consulted by nothing, so a
  piece could declare it needs a payment processor, reach READY against a Brain
  that has none, and never be asked. `readCapability` answers from rows —
  `RESEARCH_A_QUESTION` is `PRESENT` only when the fleet has a healthy execution
  surface, the same reading `auditAdmission` uses — and never from a cache.
  `MISSING` means Brain understands the capability and does not have it;
  `UNKNOWN` means nobody has told Brain what it is. Collapsing them would make an
  unrecognised word read as a settled absence, which is invariant 39 in the
  expensive direction: **we could not tell must never read the same as we
  checked.**

- **A need had no completion condition, no dependent work reference and no
  continuation, so answering one resumed nothing.** A person could answer the
  same need repeatedly and never learn their answer was recorded and ignored.
  `completion_condition` is required, `blocks_state` names the transition
  waiting on it — a *state*, because a continuation that had to read prose to
  know what to resume would be model output deciding a transition — and
  `continued_at` is a compare-and-swap, so two ticks reading one answered need
  produce one resumption. The resumption retries `beginExecution` **without a
  `firstAction`**: a resolved need can unblock work and can never manufacture
  the evidence that work began, which is exactly what the `cash_actions`
  correction is for and what a continuation supplying its own action would undo.

  All of it is derived from rows on the tick rather than hooked to the moment a
  card changed, which is what reaches the needs already stranded — the fourth
  time this repository has needed that distinction. And **none of it gates
  anything**: no pass refuses an opportunity, charges an attempt or stops
  unrelated work.

- **The review claimed answering a group released the work under it, and for
  most groups that was false.** Five cards with no price are five prices — the
  same sitting, not one answer — so `sharedRemedy` says which it is and the
  screen reads *one answer covers* or *the same kind of work on* accordingly. A
  screen that promises five and delivers one teaches a person to stop believing
  the counts, which is §29's defect at a new surface.

  **A shared remedy costs what the remedy costs, once.** Two needs blocked on
  the same small tool were reported at twice its price, because the group summed
  the expected costs of the things it unblocks. The direction matters: an
  over-stated cost makes a cheap unblock look expensive enough to defer. Where
  the members name one figure it is that figure; where they differ Brain says
  the largest and why rather than inventing a total.

  **A fact Brain could look up is not a person's decision.** `evidenceCard`
  marks the payer, the access channel and the buying evidence `discoverable`, so
  `reconcileDiscoverableGaps` raises a need and Brain researches them and they
  never reach the review.

- **And a commercial judgment is not permanently a person's either. The
  correction is recorded rather than quietly applied.** The paragraph above
  used to end by reserving the offer, the price, the acceptance condition and
  who fulfils the work to the owner, because *a researched answer to "what
  should we charge" would be invented judgment wearing a citation*. That
  sentence is true about a **citation** and wrong as a **prohibition**: this
  section is meant to be an operator with high autonomy inside limits somebody
  set, and reserving every commercial judgment to a human makes it a form to
  fill in — which is exactly what §24 already had to correct once about a
  standing authority that "still asked a person to configure machinery".

  So `services/cash/answers.ts` prepares them, and `cash_card_facts.kind` is
  what keeps it honest rather than a rule somebody has to remember:

  * **EVIDENCE** is a gated research claim, so the field resolves to a source,
    a publisher and a date exactly as a report's sentence does.
  * **RECOMMENDATION** is Brain's own proposal and carries its basis, its
    assumptions and what would change it. All three are required to write one,
    so a recommendation with no stated uncertainty cannot exist — and the card
    renders it as a proposal, because one shown the way a source is shown has
    told somebody a guess was checked.
  * **PERSON** is somebody's decision, and nothing automatic replaces one.
    `mayReplace` is that order, and it is about authority rather than recency.

  **It proposes nothing it has no basis for.** A price is proposed only where a
  source states a figure; with none the field stays unknown and says what would
  settle it. Deriving a number and explaining it afterwards is the invented
  judgment the old rule was worried about, and the worry was right about that.

  **It changes no boundary.** The standing commercial authority still decides
  what may be spent, executing still needs a recorded `cash_actions` row, and
  the evidence gate is untouched. What moved is who may form a view, not what
  anyone may do with it.

  **A proposal settles seven things, and the two arithmetic ones refuse rather
  than estimate.** The offer *and its stated edges*, the acceptance condition,
  the price or the range the sources state, the delivery method, who fulfils
  it, the expected margin, and when the cash would arrive. A scope with no
  stated exclusions is the one that gets argued about after the work is done,
  so the edges are part of the proposal rather than a refinement of it. A
  **margin needs a price and a bounded exposure** and is withheld naming which
  half is missing — a margin against an unknown cost fails in the direction
  that makes a piece look worth doing, which is the shape of error nobody
  notices because it looks like ambition. **Unpriced effort stays unpriced**:
  the hours are reported beside the margin rather than multiplied by a rate
  nobody set, which is the same defect one step along. A negative margin is a
  reason to decline rather than a reason to raise the price, and it says so.

  **A price is read, never produced, and `services/cash/figures.ts` is what
  keeps the difference.** It refuses a bare number, because reading the
  sprint's currency into one is the unknown taken as the favourable
  assumption; it refuses `k`/`m` shorthand, because `$1,200k` parses cleanly as
  1,200 and a thousandfold error reported as something somebody published is
  worse than no figure; it refuses a percentage; and it does not read `USD` out
  of `USDT`. Its failure mode is **missing** a figure, never inventing one.
  Where the sources state a range it proposes the low end and says why: the top
  of a range is the number Brain could least defend if asked.

- **And a view nobody acts on is not autonomy — it is the same form with extra
  steps.** `advanceWithinAuthority` takes the two decisions that are actually
  bounded by something a person owns. It **declares a complete card ready to
  test**, where the bound is the card: `markReady` refuses while a load-bearing
  field is unknown, so what changed is who presses the button and never what
  the button checks. And it **begins execution**, where the bound is the
  standing grant, asked through the same `checkCommercialAuthority` an HTTP
  caller goes through. The grant is asked *before* the capability, because
  deny-by-default asks whether this may happen before it asks whether it could.

  **It never manufactures a capability it does not have.** Reaching a buyer
  needs `SEND_A_MESSAGE`, which reads MISSING on this Brain because no
  integration of that kind exists, so what happens today is that pieces reach
  READY by themselves and stop there with the refusal naming it. That is
  reported as withheld rather than as done. A run that said it had contacted
  somebody would be the one lie this section could tell that costs real money.

  **And it is the one thing in Cash Mode that winding down also stops.** Every
  route here keeps working in all three states, because a person may still mark
  a piece ready and still execute one by hand while winding down — those are
  their decisions. What must not happen is *Brain* starting a new obligation
  after somebody has said stop. It is a **skip**, so no state moves, nothing is
  charged, and it resumes by itself if the sprint is made active again.

  **Every item carries a typed answer, and each names an operation that already
  exists.** There is no apply endpoint of the review's own, because a second way
  to do each of those is one forgotten guard away from doing less.
  `NOTHING_TO_PRESS` is a real value rather than an omission: an expiring
  opening is answered by taking it, and a button that marked it read would be a
  control that pretends.

- **Being registered was the bug, and a browser found it.** What decides
  whether a need's completion condition actually holds was an injected reader,
  wired by a side effect of importing `operate.ts` — on the reasoning that the
  readings live in modules that import `needs.ts` and a cycle between them is a
  load-order bug waiting to be found by whichever file loads first. The
  reasoning was right about cycles and wrong about this one: what settles a
  condition is `capabilities.ts`, `card.ts` and `cashPortfolio.ts`, and **none
  of the three imports `needs.ts`**, so there was no cycle here to break. The
  only thing actually crossing was `questionKey`, which is a string builder
  rather than a reading.

  What it cost was real. `operate.ts` is imported by exactly one module in the
  whole server — the Russell tick — so the route a person's browser calls to
  close a need reached `closeNeed` with the **default** reader, which means
  "nothing here can check this", which records the person's word as a
  `PERSON_SUBSTITUTE` rather than refusing. Pressing *Mark this done* with
  "Done." would have resolved a need whose capability was still missing, which
  is exactly what `verified_by` exists to prevent. Every service test passed,
  because they all import `operate.ts`.

  `services/cash/conditions.ts` is a plain function now, with nothing to
  register and nothing to forget, and `questionKey` has one home instead of
  three. It was found by `tests/cashBrowserToDatabase.test.ts`, which mounts
  the real section over the real routes over the real database — the seam
  neither a scripted-`fetch` component suite nor a screenless service suite can
  see, because a control that posts a field the route does not take passes both.

- **A private operation had nowhere to file what it found, and nothing could
  create one.** `standingAuthority` refuses every launch on a project with no
  layer — *"this project having a layer to file the work under"* — and layers
  are written by `server/seed.ts` for the seeded project and by nothing else:
  no route, no `npm run admin` command, nothing. So the documented setup for a
  sprint, which is four people meaning four projects, produced a project that
  could open discovery, capture ideas and **launch nothing, for ever**. Every
  row read as healthy and the portfolio stayed empty. It is §24's *waiting
  nobody can resolve* at a new altitude and worse than the usual case, because
  the remedy did not exist anywhere to be applied.

  `activate` creates it, because activation is the moment a project becomes an
  operation: a person's decision, already refusing everything it cannot honour.
  Only when there is none — a sprint activated on a project that already does
  research files into what that project already has, and nothing here
  reorganizes it.

- **And the project a sprint runs on is not interchangeable, which is
  deliberate and silent.** The compiler reads the in-code project-slug map
  before a cash mode's chosen envelope, so that *nothing about an existing
  project's authorization can be changed by activating a cash mode on it*. The
  consequence is that activating on the seeded `deal-dispatch` project runs
  discovery, launches missions and harvests **nothing** — the buckets compile as
  public-records questions whose lane is `official_source`, and `harvest` reads
  `demand_signal`. Nothing errors. Both of these were found by
  `tests/cashDeploymentSmoke.test.ts`, which is the first thing in this
  repository to set a sprint up the way a person actually would, and both are in
  `docs/CASH-DEPLOYMENT.md` where somebody deploying will read them.

- **Every one of those was a transition that existed, was tested, and could be
  reached by nothing — which is why the acceptance is a walk rather than a
  suite.** `tests/cashIntegrationPass.test.ts` drives one sprint from a person
  activating it through discovery, a harvested opening, the needs Brain raises
  and then answers from the card, the grant, the first recorded action,
  delivery, settlement and winding down. **Only the external edge is
  simulated**: the worker authenticates as a `WORKER` principal, claims a real
  item off the durable queue and submits through `brain_submit_claims` and
  `brain_submit_verification`, so the scope check, the lease and generation
  proof, the lane validation, Step 6's idempotency and Brain's own evidence gate
  all run — and the items are not the test's either, because `approvePlan`
  queues the research and completing it is what makes the verification next. An
  item the test enqueued would only have proved the tools accept a proof the
  test also wrote. What stays fixture is the sentences a worker found and the
  two judgements only a reader of a source can make. **Two things it is not,
  said rather than assumed**: not a live Cowork session — no Routine fired, no
  provider called, no token minted, nothing external read — and the tool
  *layer* rather than the MCP *transport*, since the tools are reached through
  the registry rather than over `POST /mcp` behind a bearer, which
  `tests/mcp.test.ts` and `tests/oauth.test.ts` cover instead. Everything between is the
  real tick, the real compiler, the real card gate, the real authority check and
  the real repositories. §24 records the same lesson at the same altitude: walking the
  journey found five transitions that isolated tests could not see, because a
  test that arranges its own starting state cannot tell a mechanism from a
  function nothing calls.

**What this version does not do, and says so.** It records the authorization and
the money; it does not itself contact a buyer, issue an invoice or move funds. A
missing integration is a `cash_needs` row with a recommended way forward, which
the plan calls a valid execution state — not a silent block. `capabilities.ts`
says so in code rather than only here: every capability but
`RESEARCH_A_QUESTION` reports `MISSING` with the integration it would need
named, and none of them has a reader, because there is nothing to read. Nothing
here forms a view about what settling a question is worth, for the same reason
`judgment.ts` does not.


## 31. A validated finding belongs to the Brain. Everything else belongs to its project.

Four people run four private operations in one Brain, and a market fact one of
them paid to establish is a fact about the world. §13's rule — that the default
is *not* to research — is exactly as true one boundary out as it is inside a
single project, and until now it held only inside one: every claim read in this
codebase is keyed by orchestration, and an orchestration belongs to one project,
so the second person paid again for what the first had already established.

`server/repos/sharedFindings.ts` and `server/services/knowledge/shared.ts` are
the whole of it, and the shape follows from one fact about the graph: **the
evidence is already written down.** `research_claims` holds the statement, the
canonical source, the publisher, the date, the passage, the locator and the
scope fields; it resolves through `research_fragments` to the gate that accepted
it, through `research_orchestrations` to the project that produced it, and
through `research_passes` to the worker and session that executed it. Nothing
about a finding needs re-stating to be reused.

- **`shared_findings` stores no knowledge.** It is a promotion record — a
  pointer to a claim, its origin, and the two facts a claim row cannot carry: a
  person's revocation, and an absolute horizon somebody declared. `knows.ts`
  already gives the reason in its opening paragraph, and this is that reason at
  a new boundary: a copy is a second place for the truth to live, it is the one
  nobody reconciles, and it is precisely what loses a claim's evidence chain. So
  promoting into `russell_knowledge` was the obvious move and is the one thing
  that would have made this a parallel knowledge system.
- **The rule is six conditions over rows, and no model output appears in it.**
  The claim cleared the gate; it resolves to a canonical source that validated
  structurally; nothing contested it; it is not a calculation resting on inputs
  that did not travel with it; its fragment reached `ACCEPTED`; and it resolves
  to an orchestration, so its origin is never unknown. The boundary between
  *unfinished* and *validated* is the fragment rather than the packet,
  deliberately: `gateFragment` is the single place all seven gate conditions are
  applied, and one blocked fragment must not withhold the Brain from questions
  that are already settled.
- **Promotion is a derivation on the tick, not a hook on the moment a fragment
  is accepted.** That is what lets it reach everything already written, survive
  a tick that died halfway, and run on two instances at once — the unique index
  on `claim_id` is the arbiter and a loser is an ordinary outcome. It is the
  fourth time this repository has needed that distinction, and the reason there
  is no backfill: deleting every row returns the Brain exactly to what it did
  before.
- **Only two of the exclusions are rows here.** Revocation and an expired
  horizon. Contradiction, lost acceptance and a fragment leaving `ACCEPTED` are
  re-derived against the live claim on **every read**, so a claim that becomes
  contested disappears from the pool with nothing written anywhere and no pass
  having to notice. That is the whole reason not to snapshot, and
  `ELIGIBLE_SQL` is one string read by both the derivation and the retrieval
  because a rule applied by one of two readers is worse than none.
- **Nothing new decides whether research is needed.** `assessRequirement` is
  untouched: a finding is projected into the `ExistingClaim` shape that
  classifier already reads, and injected at **both** entrances —
  `coverBeforeWork` behind Russell's pre-mission check and `reconcile` behind
  the packet reconciliation a worker's proposed fragments go through. So no bar
  moves. `SATISFIED` is still the only status that stops research and still
  needs two independent publishers, and one shared finding can suppress nothing
  on its own.
- **A projected claim's `documentId` is the finding id, never the document the
  originating packet filed.** That document belongs to another project and its
  id must not leave it — `documentIds` flows onto `requirement_coverage` and out
  to readers. And `projectId` is the **asking** project, because that is what
  the field means to every consumer of an `ExistingClaim`; the origin lives on
  the finding row.
- **The row always records the origin; what a reader is shown is decided against
  their own access.** `decideProjectAccess` at `READ`, the same module every
  route uses — there is no shared-knowledge policy module and there must never
  be one. A reader who may not read the originating project still gets
  everything that makes the finding checkable: the source, the publisher, the
  date, the passage and the locator. **A shared finding is deliberately not a
  project-scoped resource**, so it is not hidden as one; what is withheld is the
  name of somebody else's project, which is invariant 23 pointed at the one part
  of this that is still project-scoped.
- **Withdrawing one belongs to the project that produced it**, at `ADMIN`, the
  level every other change to what a project owns already carries. A consuming
  project that disagrees records a contradiction through the path that already
  exists — and that path already excludes the finding, derived, without anybody
  withdrawing anything. Revocation destroys nothing and the claim underneath is
  never touched: a finding being unsuitable for reuse elsewhere is not the same
  fact as the evidence being wrong.
- **A revoked or expired finding is shown with its reason rather than hidden.**
  Somebody asking "why is this not being reused" must be able to find out, and a
  row that vanished answers nothing. `eligibleFindings` decides what Brain may
  reuse; the pool read widens nothing.
- **Nothing derives a horizon.** Brain holds no row stating how long a fact
  about the world is good for, and inventing one would be a freshness claim
  wearing a citation. Staleness *relative to a question* is a different fact and
  is already decided by the coverage classifier's own timeframe verdict, which
  is why it is not duplicated here.

`tests/sharedKnowledge.test.ts` produces the finding through the real path — a
`WORKER` principal claims a `RESEARCH_FRAGMENT` off the durable queue, submits
through `brain_submit_claims`, and the gate decides acceptance from
`brain_submit_verification` — because the promotion rule reads rows the gate
writes and a fixture that hand-wrote them would be testing the fixture. The
provenance it asserts is therefore Brain's own record of who executed the pass.
It is **not** a live Cowork session and it is the tool layer rather than the MCP
transport, the same two sentences `cashIntegrationPass` already has to say.

## 32. A member is a device, and readiness is a count of rows.

Step 12D (`server/services/identity/webauthn.ts`, `enrollment.ts`,
`passkeyAuth.ts`, `server/routes/passkeys.ts`,
`server/services/cash/readiness.ts`, `client/src/components/Enrol.tsx`) brings
the four people into the Brain and puts one count in front of the button that
starts Cash Mode. It adds a way *in* and no way around: authentication is the
same `Principal` every route already resolves, authorization is the same
`decideProjectAccess`, and the two person-only Cash decisions are untouched.

- **There is no email address and no password, and that is the feature.** An
  address exists to recover a password, and there is no password here to
  recover — so a member slot is a `users` row with `email`, `password_verifier`,
  `password_algorithm` and `password_updated_at` all NULL, and
  `getPasswordVerifierByEmail` answers `null` for it. A passkey account is
  therefore not reachable by the password path *at all*, rather than reachable
  and always refused: the difference is that the second one has a verifier
  somebody could get wrong about.
- **The link is the whole authority, and it is spent by one guarded `UPDATE`.**
  Random, digest-stored, prefix-indexed, compared in constant time, bound to one
  slot, revocable before use, and single-use after — the properties
  `worker_invitations` and §26's person invitation already established, at a
  third door. Two requests holding one intercepted link produce one passkey and
  one ordinary refusal.
- **A refusal is one body.** Absent, malformed, expired, spent, withdrawn, a
  signature that did not check out, a credential already registered elsewhere —
  one sentence, and it names the remedy rather than the reason. Invariant 23,
  where the thing being refused is a secret somebody may legitimately hold.
- **The token is in the URL fragment, never the path.** Not sent to any server,
  not written to any access log, taken out of the address bar as soon as it is
  read. The two routes that spend it are on the guard's unauthenticated
  allowlist for `/api/auth/login`'s exact reason: an invited person holds no
  credential but the one in their hand.
- **A challenge is a server-side row, taken once.** Not a cookie, not a value
  echoed back — the fifth time this codebase has needed a compare-and-swap on a
  value the claimant does not supply. It is taken *before* anything is verified,
  so one intercepted assertion cannot be replayed even against a signature that
  would otherwise check out.
- **Recovery retires before it issues.** A replacement link handed out beside a
  credential that still works is not a recovery, it is a second door — and if
  the device was lost because somebody else has it, the whole point is that it
  stops working now rather than when the replacement is used. The revoked row
  keeps its reason; nothing is deleted.
- **Nothing here mints a credential, and the tests do.** The verifier is Node
  crypto and a hand-written partial CBOR reader — `attestation: none` only,
  ES256 and RS256 only, a counter that may not go backwards. The synthetic
  authenticator lives in `tests/helpers/authenticator.ts` and nowhere in
  `server/`, because a Brain that could make a passkey would be manufacturing
  the one thing a person is supposed to be holding.
- **Readiness is derived, and `HEALTHY` is not `CONFIGURED`.** A member is READY
  when they hold a live passkey — not when a slot exists and not when a link was
  sent, both of which are things the administrator did. A capacity account is
  HEALTHY only once a session Brain fired has arrived and finished something;
  registered-with-a-secret is `CONFIGURED`, which is §23's rule that a perfect
  configured block over an empty observed one is a refusal rather than a pass.
- **The count is reported and does not gate, and that is a recorded correction
  rather than a quiet weakening.** It used to: the Start button was disabled
  below four of four and `POST /api/cash/activate` re-read the count and
  refused with both figures. The owner has since withdrawn it — **waiting for
  everybody was their decision, never a property of the system** — so both
  halves went together, because a button enabled against a route that still
  refused is the worse of the two failures. The counts are still derived, still
  shown and still honest; they simply stop nothing, and the remaining members
  and Routines join afterwards through the paths they always did. The sentence
  that explained the lock went with it: *"not ready to start"* beside a button
  that starts is §29's status contradicting the control beside it.
- **Nothing beside it moved, and the tests say so while the counts are short.**
  `requirePerson` and `requireBrainAdmin` are unchanged — an ordinary member
  still gets the same 404 the other administrator-only route gives them — the
  one-Cash-Mode check is unchanged, and no other guard on that handler was
  touched. Removing a gate is exactly the change that quietly removes its
  neighbours, because they sit in the same function, so the coverage asserts
  every neighbour **in the state a leftover readiness check could have hidden
  in**, and was run against the restored lock to confirm it fails.
- **Being ready is not being authorized, and neither is starting.** What Brain
  may spend is still the standing commercial grant of §30, still a person's,
  and still a separate decision this route cannot make.
- **A capacity account is not a person and is not a lane.** `Brain Research A`
  to `D` are surfaces Brain fires; `V1` and `V2` are sites. `fleet rename`
  exists because the two had borrowed one name, and it changes the label and
  nothing else — not the trigger, not the secret's name, not the digest, not the
  worker binding, not the state — so it is safe to run against the surface that
  is mid-packet. All four pull from the same queue; there is no
  project-coloured or person-coloured research lane.

**The migration that made this possible was written twice and was silently
destructive both times. The correction is recorded rather than quietly
applied.** SQLite cannot relax a `NOT NULL`, so `users` had to be rebuilt — and
`PRAGMA foreign_keys` is a documented no-op *inside a transaction*, which is
where every migration runs. So the `OFF` the standard recipe relies on did
nothing: foreign keys stayed on, `DROP TABLE users` performed an implicit DELETE
of every row, and every `ON DELETE CASCADE` aimed at `users` fired — sessions,
conversations, messages, collections, preferences, milestones. **It did not
fail. It succeeded, having deleted the Brain's history.** The second attempt
renamed instead of dropping, on the reasoning that `legacy_alter_table` would
stop the rename following; measured, it does not — with foreign keys on, a
rename rewrites the other tables' `REFERENCES` clauses either way, and the drop
that followed cascaded exactly as before.

Neither was visible from reading the file, from a typecheck, or from the whole
suite, because every other suite migrates an *empty* database. Both were visible
from one row. So a migration may now carry `-- brain:rebuild-without-foreign-keys`
on its first line, and the runner does what SQLite's own twelve-step procedure
says: the pragma outside the transaction, the rebuild inside it, **`PRAGMA
foreign_key_check` before the commit** — which is the half that makes it safe
rather than merely permitted — and the pragma restored afterwards whatever
happened. `docs/ONBOARDING.md` is the journey as a person walks it — inviting somebody,
what they see, losing a device, and what turns a registered capacity account
into a proven one. `tests/migrationRebuild.test.ts` seeds a person, a session and a
conversation, migrates over them, and fails if any of the three is gone; it was
run against the destructive version to confirm it catches it, because a
regression test nobody has seen fail is a claim rather than a reading.

The marker is deliberately narrow: one capability, no way for an ordinary
migration to opt out of its transaction, and nothing on the Postgres chain,
which has `ALTER COLUMN ... DROP NOT NULL` and needs none of it.

## 33. A pipeline is what actually ran, not what each stage would do if it were reached.

A production audit of the four research surfaces — *Brain Research A*, *1-B*,
*1-C*, *1-D* — measured what Cash Mode had actually produced after ten discovery
rounds: twenty orchestrations, forty-six fragments, eighty-two claims, four filed
reports, four audits, **zero opportunities**, **zero cards**, and ten candidates
parked. Every stage passed its own tests. Every row read as healthy. The four
Routines were not the defect and no per-Routine remedy exists: they are
interchangeable execution surfaces for one pooled worker, and B, C and D were
idle because the queue was empty rather than because their instructions were
wrong. **Attribution came from `research_passes.executor_routine_id` rather than
from a Routine firing near the same time**, which is what made that sayable.

What the audit found was four disconnections in a row, each of which made the
one after it unreachable — so the stages downstream were never wrong, they were
never asked. The repair is recorded here as one section because reading any of
them alone gives the wrong lesson.

- **Pressing Start authorized nothing, so every idea parked.** Activation wrote
  a `cash_modes` row, discovery captured its buckets, and the compiler then
  refused each one for want of a `russell_goals` standing authority — a decision
  §24 correctly reserves to a person, being asked for a second time about a
  decision the person had just made. Ten candidates sat `PARKED` with three
  honest sentences on them and nobody was ever shown a card to answer, because an
  ungranted project raises no `russell_human_requests` row. **Start is the
  authorization**: `ensureDiscoveryAuthority` writes the internal discovery grant
  from the activation, named and bounded in code, with `ON CONFLICT DO NOTHING`
  against a partial unique index so two ticks produce one grant. It authorizes
  **reading published sources and nothing else** — the prohibitions are
  `ALWAYS_PROHIBITED` unioned with publishing, `max_external_spend` is the same
  literal zero, and **no commercial action is granted by it at any point**. The
  commercial grant of §30 is untouched, still separate, still a person's. There
  is no second Start, no extra lock, no form and no confirmation step: what was
  added is that the button now means what the screen already said it meant.
  `resumeAuthorityParkedCandidates` reaches the ten already parked, and only
  those parked for exactly that reason — it matches the sentences Brain itself
  composed and refuses to unpark anything else.
- **The envelope refused six of ten correctly-shaped plans before a source was
  read, and the screen it failed on was aimed at the wrong subject.**
  `forbiddenActions` was tested against a fragment's question, definitions,
  population and completion criteria — every one of which says what to *look
  for*, and none of which says what Brain will *do*. So a fragment asking which
  government surplus listings are open was refused for describing a purchase,
  because a surplus auction *is* a purchase and the word appears in any honest
  description of one. `services/research/actorScope.ts` is the distinction: a
  forbidden phrase is Brain's own action unless a governor within forty
  characters turns it into a described thing, and always when the researcher is
  named as its subject. **Narrowing a screen is safe here precisely because this
  was never the enforcement** — the grant's prohibitions, the zero spend and the
  absence of any acting tool are — so the failure mode is admitting a plan whose
  effects are blocked anyway, and the tests pin the refusals rather than the
  admissions. The source allowlist was widened the same way, and **the refusal
  now quotes the envelope's own rule back**: a plan told what it accepts rather
  than only that it was refused is one a worker can correct.
- **A rejection with no reason is a claim destroyed silently, and there were
  thirteen.** All thirteen rejected claims in the four Cash packets failed on
  `SCOPE_MATCH`, and twelve of those were `UNSTATED` rather than `MISMATCH` —
  including a $125M settlement and three marketplace postings that were
  *literally* the declared population. The evidence was fine; nobody had said so,
  and the gate fails closed. `UNSTATED` is gone from what a verifier may submit:
  the answers are MATCH, MISMATCH, NOT_APPLICABLE and UNKNOWN, **each with a
  quoted fragment value beside it**, and a submission missing one is **refused**
  rather than stored — so the worker corrects it and the claim survives, instead
  of the claim dying to preserve an incomplete verdict. `UNSTATED` still *parses*,
  because the thirteen existing rows still mean what they meant and none of them
  was touched.
- **"Two independent sources" was applied where §14 says it must not be.** One
  published request proves one published request; requiring a second publisher
  for it is requiring somebody else to have published the same notice. The bar is
  per lane now, declared by the compiler profile and carried on the lane row:
  `SPECIFIC_INSTANCE` needs one example from one publisher, `MARKET_PATTERN` two
  distinct examples, `GENERALIZED_ECONOMICS` two independent publishers. **No
  blanket minimum anywhere**, and no bar was lowered in the aggregate — a
  `DATED` condition was added beside it, refusing a time-sensitive claim with no
  observation date, because §30 already said an undated signal cannot be told
  apart from one somebody remembers from March.
- **Nothing connected an accepted claim to an opportunity, and the code that
  looked as though it did could never fire.** `harvest` read
  `evidence_lane === 'demand_signal'` and required a `russell_missions` row that
  the admin-started packets did not have — so four filed reports full of accepted
  openings produced nothing, twice over. The bridge is **typed rather than
  guessed**: a worker that read the source chooses one of seven
  `OPPORTUNITY_SIGNALS` for a claim, or none, and only a signalled claim is
  promoted. **An existing claim cannot become an opportunity merely by existing**
  — every historical row carries a null signal, by construction rather than by a
  cutoff date — and a unique partial index makes one claim at most one
  opportunity whichever tick gets there first.
- **Discovery and commercial validation were one question, and it could only be
  answered badly.** The four reports answered *who is asking* and *what they
  published*, and answered none of the fourteen commercial questions — not
  poorly, but not at all, because nothing ever asked them. They are two packets
  now under two profiles: discovery finds openings, and a bounded deep dive under
  `RUSSELL_CASH_VALIDATION_V1` asks who pays, what it pays, what it costs, how
  long it takes and what would rule it out, from published sources, at most two
  at a time. What comes back lands on a **Cash Engine Card** where every answer
  says which of four things it is — a gated `FACT` resolving to a URL and a
  passage, an `ESTIMATE` carrying its basis, assumptions and uncertainty, a
  person's `DECISION`, or an honest `UNKNOWN`. **A margin is withheld rather than
  computed against an unknown cost**, naming which half is missing, because that
  error fails in the direction that makes a piece look worth doing.
- **A card read the column and ignored the answer beside it.**
  `applyValidationAnswers` fills `payer` from a gated claim without touching the
  opportunity column, and the engine card read the column alone — so a question
  Brain had answered, with a claim id on it, displayed as *we do not know*. The
  column still wins wherever it has a value and readiness is untouched; a
  recorded fact answers the field where it does not.
- **Four reports shared one filename and the dashboard said work was moving.**
  `buildNames` takes a variant, so two cash packets in one layer no longer
  collide, and the roadmap reports an `activity` derived from rows —
  `PARKED` with the blocker's own words rather than `OPEN`. The page says what
  is not moving and why. **A status that contradicts what a person can see is
  worse than no status**, for the seventh time in this file.

Running it found four more, each of which would have stopped the chain at a
different transition while every test of the part in question passed. They are
one lesson at four altitudes: **a stage can be correct and still be unreachable,
and a suite that exercises the stage cannot see that.**

- **The field that decides everything was forbidden by its own schema.**
  `brain_submit_claims` told a worker, in its description, to set
  `opportunity_signal` — and declared `additionalProperties: false` without
  listing it. A client honouring the schema drops the field; one honouring the
  prose sends what the schema forbids. So the single column that decides whether
  any opportunity is ever created could never be filled, and the failure would
  have read exactly like a worker honestly finding no openings. It is declared
  now, and the instruction also went into the discovery profile's completion
  criteria, because a worker reads its assignment *before* it starts looking and
  the submission tool is the wrong end of the job. Found by scanning every tool
  for a field its description names and its schema does not declare; it was the
  only real gap.
- **The Cash Engine Card was computed by nothing.** The module existed, was
  tested, and no route, view or component ever called it — so the brief that is
  the whole point of qualifying an opening could not be read by anybody. §29's
  sentence arriving at the *end* of a pipeline rather than the middle. It is
  composed in `cashView` from the facts already loaded for `provenance`, so it
  costs no query, and the screen renders each line as the kind of answer it is.
- **A researched answer reached the facts and not the row.** `answers.ts` writes
  the opportunity column *and* the card fact when a need's research settles a
  field; `applyValidationAnswers` wrote only the fact. The identical question,
  answered by the deep dive instead, never reached `evidenceCard`,
  `readyToTest` or `reconcileDiscoverableGaps` — which would go on raising a
  need for a payer the deep dive had already established and research it twice,
  which is §13's waste arriving through the door this repair opened. Both read
  one `COLUMN` map now, because a copy each is the thing that drifts.
- **The live Brain refused its own release gate, and was right to.** The deploy
  released, and then answered its own hosted verification with
  `INVALID_INPUT "verdicts[0].geography_basis" is missing`. Requiring a basis is
  correct and stays. What was wrong is that the change reached every fixture in
  `tests/` and not `scripts/verify-hosted.ts` — a scripted worker the suite
  never runs. So the whole suite passed, the image released, and the packet the
  release gate itself submits was refused. **A real worker would have
  resubmitted; a scripted one cannot**, which is the whole difference between a
  strict contract and a broken one. The guard reads the repository rather than
  behaviour, because behaviour is exactly what the suite could not see.

- **An accepted claim carrying an `opportunity_signal` became a user-facing
  opportunity, and market evidence is not an opportunity.** The bridge §33 built
  was right that the signal is a typed column rather than a lane id, and wrong
  about what promotion *means*: it made thirty-one production records into
  "openings", and every one of them was a fact about a market. Rev and
  GoTranscript's published per-minute prices, WriterAccess and Verblio's
  per-word rates, Adobe Stock and Depositphotos subscription tiers, FIFA and
  Coachella resale *asking* prices, sneaker and trading-card spreads from
  tracked historical sales, two domain appraisals above their asking price,
  GitHub's bug-bounty programme, Copart and IAA broker access, Freelancer's
  listing page, three government procurement notices. Every one gated,
  well-sourced and real; not one of them says anybody would pay **us**.

  `services/cash/tier.ts` is the distinction, and it is **derived on the read
  path** for `placements`' own reason — a row is not a decision, a stored tier
  is stale the moment the fact it waited on arrives, and deriving it is what
  reclassified all thirty-one by deploying rather than by a backfill that
  could not reach what a later tick promoted. **Signal** is evidence, kept
  whole with its claim, source, packet and round. **Candidate** is a signal
  Brain can say would be paid for. **Qualified** is a supported execution
  thesis. **Ready to test** is that plus the short card a bounded test runs
  against.

  **The boundary is type-aware and is not a keyword filter**, and the ten
  examples are regression cases rather than the rule. §27 records what happens
  to a closed list that has to be complete over ordinary English: four
  widenings, each adding the one word the last production message was declined
  for. So each of the seven `OPPORTUNITY_SIGNALS` declares what its evidence
  establishes, what it does not, and what else its *kind* needs — a pricing
  asymmetry and a resalable asset need present acquisition access and an
  after-fee exit before either is arbitrage; repeated outsourced work and a
  paid task need something that serves the next customer too. None of it reads
  a word of anybody's prose.

  **What moves a signal is a payer**, and that is why the same sentence can be
  either. `captureMechanism` is Brain's own proposal, composed from a payer and
  something to supply them — both already gated — and **withheld entirely where
  there is no payer**. Nothing about Rev charging $1.99 a minute names anybody
  who would pay us, so no payer ever lands and no capture thesis is ever
  proposed. The identical title qualifies the moment research finds a buyer.

  **A bar with no way over it is a park rather than a standard.** The
  eligibility, acquisition, exit-evidence and contact-mode lanes did not exist
  when the first dives were compiled, so a piece that answered everything its
  dive asked could have sat one answer short for ever. A piece below qualified
  with a completed dive gets exactly one more, bounded by `validation_rounds`;
  a third would be the same search twice, which `repair.ts` already refuses.

- **Brain asked a person for the research Brain was at that moment doing.**
  `CardField.discoverable` was a boolean splitting the twelve into *facts Brain
  looks up* and *the owner's calls*, and the second half was nine of them — the
  price, the delivery path, who does the work, the cash dates, the economics,
  the exposure. §30 had already corrected the reasoning ("a commercial judgment
  is not permanently a person's either") and `answers.ts` had already built the
  machinery to propose them; the boolean never moved. So production showed five
  "decisions" standing for ninety-eight items, with a **mark all thirty done**
  control over facts nobody had established.

  It is `owner` now — `BRAIN_RESEARCH`, `BRAIN_PROPOSES`, `PERSON_ONLY` — and
  **no card field is `PERSON_ONLY`**. The grouped-blank section of
  `compressedReview` is **deleted rather than narrowed**, because every field it
  could group on was one or the other. What replaces it is the decision that is
  genuinely a person's once the researching is over: several qualified openings
  and not enough capacity to run them all, which cannot exist until something is
  qualified — so the screen is correctly empty on a sprint that is still
  qualifying. A card's grouped sentences are deduplicated, because a card that
  says the same thing thirty times is one nobody finishes reading.

- **`1 / 4 HEALTHY` and *four eligible Routines* were both true, and neither
  said which it was counting.** Production holds two real accounts; one carries
  all four research Routines and the other's single Routine is quarantined. §23
  drew this distinction and warned about arithmetic that ignores it — **an
  account holds a subscription allowance; a Routine is a fire surface** — and
  the page had one number where there are two. Both are reported now, each
  labelled as what it counts, and the quarantined surface prints
  `fleet_routines.state_reason` beside it. Neither figure was changed to make
  them agree.

- **The page leads with where the sprint stands rather than with every row in
  it.** Seven counts, the server's own sentence about what happens next, the
  best three-to-five qualified or explicitly nearly-qualified openings, the
  real decisions, a four-figure money row — and everything else behind a
  disclosure that carries its own count so a person can tell whether opening it
  is worth it. Nothing was deleted: the full portfolio, every claim and source,
  the research table, the needs, the money detail, the authority form and the
  whole activity history are all still there, one click away.

- **The bar I put up had no way over it, and only driving the product found
  it.** `recommendation` was required for `QUALIFIED` and written by nothing —
  no lane mapped to it and `proposeEngineTerms` did not propose it — so no
  piece could ever reach the tier whatever research established. Beside it,
  `ENGINE_FIELDS` are `cash_card_facts` rows with no column, so the bounded
  deep dive was the only thing that could answer one: a person who knew
  perfectly well what a job pays, what it costs and whether it needs a phone
  call had no way to say so, and their piece could never leave `CANDIDATE`.
  **§24's *waiting nobody can resolve*, arriving through a gate this very
  change put up**, and the fifth time this file has had to write that an
  escalation needs an answering transition.

  **And the first bound on it was one too many.** Raising a research need for
  every researchable blank on every record would have been two hundred
  questions asking what to charge for somebody else's product, so a signal was
  skipped entirely — which left the *payer* unasked, and the payer is the one
  question that could have stopped it being a signal. A signal is asked the
  three questions `captureMechanism` is composed from and nothing else.

  Nothing in the unit suites could see either one: every fixture wrote its own
  card facts, so every one of them cleared a bar the product could not.
  `cashDeploymentSmoke` found it by driving a sprint the way a person does and
  **timing out waiting for a piece to become ready** — which is the same
  argument §30 already makes for why that suite exists. Brain proposes the
  recommendation where it has a price and a cost to reason from and withholds
  it otherwise, `fillCard` takes an engine field as a `PERSON` fact, and a test
  holds every qualification key against the three things that can write one, so
  a key answered by none of them is a compile-time-visible absence rather than
  a park somebody finds in production.

- **An ordering that is true only sometimes is not an ordering, and the
  release gate is what found it.** `outstandingClarification` decided that a
  captured change answers an outstanding question with
  `request.createdAt > refusal.at`, and both are ISO-8601 to the millisecond —
  so a capture written in the *same* millisecond as the refusal it answers
  compared as not-after, and the question stayed on screen after the person had
  settled it. §29's status-contradicting-the-control defect, reached by nothing
  but machine speed: it passed on two local full runs and failed in CI, which
  is the whole tell.

  The conversation's own order is the answer where both rows carry a message,
  because `listTurns` is ordered and a request captured from a later turn is
  unambiguously later. A capture with no message has only the clock, and there
  `>=` is right rather than generous: **a refusal captured nothing**, so a
  request at that same instant is necessarily a different and successful one.
  The test forces the timestamps equal rather than racing for the collision,
  because a test that hoped for it would be the same flake wearing a hat.

- **A key is not a filename, and production filed nothing for a day because
  the two were answered by one function.** §33 gave the canonical name a
  variant so that four cash packets answering four different questions stopped
  filing under one name, separated by an em-dash. A local disk is perfectly
  happy with one; the bucket answered `400 InvalidKey` on
  `Opportunity Research v1B — Where the same deliverable has two published
  prices.md`, so **every staged research report in a cash project failed to
  file in cloud mode** while the whole local suite passed and the packet's own
  work item finished having recorded nothing.

  `sanitizeFilename` answers a filesystem question and `safeSegment` answers a
  storage one — which is the reason that module exists beside this one, and
  the two halves of that repair were written at two layers with nothing
  holding them against each other. `safeSegment` now reduces a segment to the
  intersection both stores accept, which is lossy on purpose: a key is an
  address and the canonical name on the row is what a person reads. The test
  holds it against object storage's own character class rather than against
  the production constant, because a test sharing that constant would pass
  whatever it became.

- **A card told a person Brain would not be asking them, directly above the
  control asking them.** Production rendered *"29 blocked actions, one
  remedy"* whose explanation read *"it is a fact about the world rather than a
  decision of yours — so Brain looks it up rather than asking you."* That
  sentence is `whyItMatters`, written by `reconcileDiscoverableGaps` when the
  need is raised, and it is **true then and false at the only moment this card
  exists** — a need reaches the review precisely when the looking-up has
  stopped. §29's status-contradicting-the-control defect, in the worst
  available place: the sentence that explains the card denies the card.

  The reason it had nothing better to say is that the reason **was derived and
  then discarded**. `assessResearch` answers exactly this — `NEVER_STARTED`
  with *"no mission has launched for it yet — most often because the project
  has no standing research authority, or the sprint has wound down"*, `FAILED`
  with the mission's own terminal reason — and `cashView` ended the line
  `.map((one) => one.need.id)`, keeping the ids and dropping the sentences. So
  `stalled` carries `{ needId, detail }` and the card prints the derived
  reason; the stored one is still used, and only reachable, for a need that
  never becomes a mission at all — a missing integration, whose stored
  sentence stays true. Re-fetching it inside the review was the other option
  and is the one this repository keeps refusing: **two readers of one fact
  disagree eventually.** The card is now a diagnosis rather than a
  contradiction, which matters more than the wording: fifty-nine of these at
  once is one upstream condition, and the card finally names it.

- **The same card said one sentence twenty-nine times, in two places, and the
  fix for that was already sitting one field above it.** `why` had been
  deduplicated for exactly this reason — *"identical paths routinely carry
  identical explanations"* — and `answer.completionCondition`, grouped by the
  same remedy from the same rows, still joined all twenty-nine. **A rule
  applied by one of two readers is worse than none**, and the second reader
  here was four lines below the first. It is one `sentences()` helper now,
  called by both, so the next field cannot be missed the same way.

  And the remedy printed twice — *"Establish a channel that actually reaches
  them. Next step: Establish a channel that actually reaches them."* —
  because `reconcileDiscoverableGaps` writes `field.task` into both
  `recommendedPath` and `nextStep`, correctly: for a researched blank they are
  one instruction. The template assumed two. It says the second only when it
  differs from the first, so a need that genuinely distinguishes them still
  says both.

- **The production guard cried wolf, and the remedy it named was wrong.** Vite
  hashes are base64url, the guard matched `[A-Za-z0-9]+`, and the day
  production shipped `index-C5-52qux.js` the `grep` found nothing — which under
  `pipefail` and the runner's `bash -e` ended the step with no output and
  reported *"Production does not match the canonical branch"*. Production was
  correct the whole time. §27 already has the sentence: a warning that cries
  wolf is worse than no warning, because it teaches a reader to stop believing
  the one place that says something is genuinely wrong.

**None of the existing work was rewritten to make any of this come out right.**
Every orchestration, fragment, claim, report, audit, round and parked candidate
keeps its id, its reason and its lineage; the two migrations are additive; the
thirteen rejected claims stand exactly as recorded. The repair is what happens
*next* — which is the only honest way to fix a pipeline whose defect was that it
had never run to the end.

---

## 34. Discovery is shared. Execution is private. People and capacity are neither.

Three production defects, demonstrated from a member's browser rather than
inferred, and every row underneath all three read as healthy.

**An ordinary enrolled member opening `/cash` was told there was nothing there
to see.** Word for word: *"There is nothing here for you to see. That is the
same answer a project that does not exist gives, on purpose."* The owner, at
that instant, saw the active shared frontier.

Nothing was broken. `GET /api/projects/:id/cash` resolves through
`requireProject`, which asks `decideProjectAccess` whether the caller is a member
of *that project*; the shared frontier is a project; a person who had joined the
Brain held no membership row on it; and a Brain administrator reaches every
project by design. So invariant 23 answered exactly as designed, at a door where
absent-versus-forbidden was not the question — and the failure was **invisible
from the only screen anybody was looking at**, which is the shape that survives
longest.

- **The boundary was already written down, and the code implemented its
  opposite.** `services/cash/root.ts` opens by saying discovery is one shared
  frontier and that *separation begins when a validated opportunity becomes an
  execution job*, because that is the first moment there is anything private to
  separate — an owner, a budget, a credential, a decision. §31 settled the same
  question one boundary out: a validated finding belongs to the Brain. The
  project membership made **discovery** private and left execution wherever the
  project happened to put it, which is the boundary upside down.
- **The seam is `services/cash/access.ts`, and it is three decisions.** The
  subject is the **server-resolved** root and never a project id a caller chose —
  a caller who could nominate the project this rule applies to would be choosing
  which project to be granted a shared read of. A **genuine authenticated
  person** may read it, which `requirePerson` already resolves from server rows:
  a worker is refused by type, an anonymous caller has no principal, an invalid
  session resolves to none, and a disabled account fails authentication before it
  arrives. Everything else — any other project, any other level, every write —
  falls through to `decideProjectAccess` with the same 404 and the same body.
- **The payload changes, so there is no shape of this a screen could paper
  over.** `services/cash/shared.ts` is a *second projection* rather than a filter
  over the owner's view, and that is the whole safety argument: a read that
  fetches broadly and strips fields afterwards is one forgotten line from a
  disclosure, and its safety depends on somebody remembering that a new column is
  private. The shared view is built from the columns it names, so a field added
  next month is **absent until somebody writes it in** — the failure mode is a
  missing fact rather than a leaked one.
- **A signal is what a publisher said; a price is what this operation would
  charge.** That pair is the line in one sentence. Shared: the opportunity's
  identity, its accepted claim and dated signal, its packet, fragment and round,
  how far qualification has got and which fields are still blank *by name*, the
  roadmap, the capability gaps, and whether it is open, being qualified, claimed
  or executing. Private: every commercial term's **value**, every money figure,
  the ledger, the forecast, the grant's ceilings, the next action, and the
  decisions review. A claimed piece is **redacted rather than hidden**, because
  another member needs to know it is taken — otherwise two of them research the
  same opening — and needs nothing else about it.
- **Activity is counted rather than quoted.** `cash_events.summary` is free text
  composed by whatever wrote the event and `detail` is an untyped bag; deciding
  per sentence whether one of them names money would be a filter over prose,
  which is the thing this module refuses to be. So shared activity is a count per
  kind and the most recent timestamp for each, and no free text crosses at all.

**People, invitations and Claude capacity were embedded at the bottom of Cash.**
A person joins a *Brain* and a Routine serves every project in it; §32 removed
the last count on that surface that gated anything, so what was left was
Brain-wide account infrastructure administered from a section §30 says is meant
to be wound down in a month or two. It is `/people` now, one destination, and
Cash carries a link and renders none of it — asserted as an absence *and* as a
link, because deleting a panel without leaving a way to reach what it did is the
disappearing control §29 keeps correcting.

**Both counts on it were wrong, in the same way.** The member list counted every
`users` row that was not disabled, so *Hosted verification* and *Hosted
verification owner* — the two accounts `scripts/verify-hosted.ts` creates on
every deploy — were rendered as two of the four people the sprint was waiting
for. The capacity list counted **accounts** while the dispatcher fires
**Routines**, and production runs four research Routines under one account, so
the page read `1 / 4 HEALTHY` at the same instant `fleet show` read *four
eligible now*.

- **Both are declared, never recognised by a name.** `users.kind` and
  `fleet_accounts.kind`, migration 066, following `projects.purpose` from 028 and
  its comment: *declared, not inferred*. The fleet half had already reached for
  the fragile answer — `name.startsWith('verify-hosted')` — which is a string
  comparison standing in for a fact and stops working on the first row somebody
  names differently. Unknown reads as the *machinery* value in both mappers,
  because the two mistakes do not cost the same: leaving a real person off a list
  is a complaint, and counting a fixture as a person is the defect silently back.
- **The fourth identity the correction named is the owner, and it stays — the
  reading was wrong about it rather than the row.** Traced live, it is
  `bootstrap.ts`'s administrator: `kind = PERSON`, `is_brain_admin = 1`, a scrypt
  verifier and no device. Hiding it would leave the owner's own roster showing no
  administrator, and typing it `SYSTEM` would be a declared lie. Two things about
  it *were* wrong. It read `NOT_INVITED` — *a slot nobody has filled* — because
  the reading counted live passkeys and this account signs in with a password:
  **the member count wrong in the under-stating direction, which is the same
  class of defect as the fixtures overstating it.** So `READY` is *holds a live
  credential* and `signsInWith` says which — `DEVICE`, `PASSWORD` or `NONE` —
  because the enrollment journey only ever produces a device and that is the row
  a lost-device recovery applies to. And its display name *was* the owner's
  inbox, on a page every member reads, against this module's own stated contract
  that no contact detail crosses it; the domain is dropped. That is a redaction
  rather than a classification — what a row *is* is declared by `users.kind`, and
  the worst a false positive costs here is a shortened name.
- **Nothing was deleted to clear a screen.** Every verification identity keeps
  its row, its memberships and its audit trail; the two retired `V1-oak`
  Routines and the quarantined `V2` keep theirs. What a screen asking for
  *people* gets is different from what the table holds, and the administrator's
  view says how many were left out and why.
- **One authoritative eligibility definition.** `services/fleet/capacity.ts`
  reads `fleetSnapshot()` — the same impure read `services/dispatch/loop.ts`
  performs every tick — so the page and the loop cannot disagree about which
  surfaces exist. It reads **every** Routine rather than only the candidates,
  because the snapshot drops one whose secret is not deployed on purpose (§23:
  do not spend a fire discovering it) and a surface waiting on its administrator
  must read as *waiting* rather than vanish. That is the one thing this page
  exists not to do.
- **Three readings, labelled as three readings.** Eligible now, proven by a
  completed session, waiting on an operator — genuinely different facts with
  different remedies, and the last time they were collapsed into one fraction the
  page said `1 / 4` about a healthy fleet. The configured target is named as a
  *target* rather than used as a denominator. And `4` as a denominator went
  entirely: it was the intended topology written down as a constant, never a
  measurement of anything, and a working Brain with two members read as half
  missing.

**A member had no self-contained way to connect their Claude account.** Every
piece existed — a worker invitation, an OAuth consent screen, `fleet
register-account`, `register-routine`, `bind-worker`, a deployment secret,
`verify-surface --probe` — and each lived on a terminal or in somebody's memory
of a conversation. `services/capacity/connection.ts` is the journey, and its
shape is decided by one fact that was traced before anything was built:

**`fire.ts` resolves a Routine's bearer with `process.env[secretName]`, so it is
a deployment secret and nothing in this repository can write one.** Not a route,
not a tick, not an administrator's session. So one step of six belongs to a Brain
administrator, and the design is arranged around that rather than against it —
*no second, weaker registration route was invented beside the real one*. The
friend does every non-privileged step, never opens Fly and is never given access
to the owner's organisation; the connection sits at **Waiting for
administrator** rather than at a vague failure; the administrator is shown one
exact remaining action, the variable's name and nothing else; and Brain resumes
from rows the moment it is set, with neither person repeating anything.

- **There is no column that could hold a credential**, of any shape, and a
  submission that looks like one is refused by name rather than stored and
  ignored. What the table holds is a `trig_…` id — an address rather than a
  secret — and three names Brain assigned so nobody has to invent one and two
  members cannot choose the same.
- **Every transition is a compare-and-swap naming the state it moves from, and
  every derived state is re-read from rows.** A refresh resumes, a restart
  resumes, two tabs produce one effect, and re-submitting the same trigger id
  registers one surface and reports the state the first call produced —
  idempotency means the effect is present after either call, not that the second
  call does nothing. A failed probe is retried against the **same** connection,
  account and Routine.
- **HEALTHY is `proveSurface`'s four rows and nothing a member typed.** Brain
  fired it, a session arrived and was attributed to the bound worker from that
  same dispatch row, it was handed a bin, and the bin reached `COMPLETE`.
  Registered-with-a-credential is CONFIGURED, which is a different word on
  purpose — §23 and §32 both, at a new surface. The probe that creates something
  to be fired for moved into `services/fleet/probe.ts` and is called by the page
  *and* by `verify-surface --probe`, because two copies of it would be two
  readers disagreeing about what "proven" costs.
- **A member's own secret name is on their page and has to be**, since sending it
  to an administrator is the step; what is absent is anybody else's, and the
  operator-depth block on every capacity surface. `withoutDiagnostics` removes
  the fields rather than asking a screen not to render them — §29's rule that
  technical detail is what a caller is *owed*, applied by not sending it.

**The boundary is proved from the wrong side of it, on the released image.**
Everything in `tests/` drives a server this process started, and the
demonstrated defect was that the owner could see Cash and a member could not —
so an administrator's screenshot settles nothing, because the administrator was
never refused. `scripts/verify-hosted.ts` already signs in as
`verification-member@brain.invalid`, which is exactly the party that was being
refused: a real authenticated person with no membership on the cash root and no
Brain administrator rights. `sharedCashBoundary` asserts, in that session, that
the frontier answers `200` with `scope: 'SHARED'`; that `/api/projects` does
**not** list the root, read from Brain's own answer rather than assumed, so the
check cannot silently degrade into testing the ordinary member path; that
fifteen named private fields are absent **as JSON keys at any depth**, because a
figure nested inside an opportunity is the same disclosure and because those
money keys are what the first version of this projection actually leaked; that
another operation's Cash is `404` with a byte-identical body to a project that
does not exist; and that activating a sprint or granting commercial authority is
refused. It creates nothing, and a Brain with no sprint records that there was
no frontier to read rather than passing silently. Matching keys rather than bare
words is deliberate: `entries`, `commitments` and `provenance` are ordinary
English, and a false finding in a release gate costs somebody an hour and
teaches them to stop believing it — §29's defect, in the place it would do most
damage. `sharedCashAccess` asserts the check exists **and is called**, reading
the script rather than running it, because nothing in the suite executes it —
which is precisely how §33's `geography_basis` defect reached production with
the whole suite green.

**Reading either page performs no effect at all** — no enqueue, claim, replay,
cancellation, registration, fire or credential mutation — and that is asserted
against the queue, the bins and the fire counters rather than stated in a
comment.

**Two things are written on those read paths, and saying so precisely is the
point.** The connection row that assigns a member their three names, because a
name that changed between two reads would be a name somebody had already pasted
into Claude; and the connection's own `state`, reconciled against what the rows
say. The second is a derivation rather than a hook, for the reason this
repository has needed four times: it reaches the connections already stranded,
survives a tick that died halfway, and cannot be missed by a code path that
forgot to call something. Every move is a compare-and-swap naming the state it
came from, and nothing moves a proven surface backwards — the chain that proved
it is history, and history does not stop having happened.

**And one was found by the second backend and by nothing else, which is the
third time that has happened and the clearest instance of it yet.** §25 makes
the argument in one line — *a repository layer over two databases is true or
merely compiling, and only one of the two can tell you which* — and it had
applied to a missing column and a missing identity column. This time it applied
to a **guard**.

The probe claim was `UPDATE … SET state = 'PROBE_SENT' WHERE state = ?`, with
`?` the state the caller had just read. On SQLite writers are serialized, so the
second caller's read always saw `CONFIGURED` and its claim matched nothing once
the first had moved the row. On Postgres the round trips are slow enough that
the second caller reads `PROBE_SENT` — and then claims `WHERE state =
'PROBE_SENT'`, which is the state it was claiming *into*. **A guard satisfied by
the thing it guards against is not a guard**, and a suite that only ever
serializes its writers cannot show you that.

What is claimed now is `probe_bin_id IS NULL`: the one value that means nobody
holds this yet and is never what a winner leaves behind. The bin is made as a
**DRAFT**, which `DISPATCHABLE_SQL` does not select, so it cannot be fired; only
the winner's is marked READY and the loser retires one that was never
dispatchable. That closes the window rather than narrowing it, and it is §20's
reconcilable-effect shape rather than claim-then-act — available here **only**
because the effect is Brain's own row. A DRAFT bin can be given back; an
external effect cannot, which is why this is not a general licence to act before
claiming.

Two things about how it was fixed are worth more than the fix. It was the
**second** wrong answer at that one guard, so the third attempt was made against
a real local cluster rather than against an argument — and the rejected version
was run there first, to see it fail, before the replacement was run to see it
pass. And the loser's bin is **retired rather than deleted** (§5), so the
assertion had to move with it: it counts what is *dispatchable* and checks the
retired one was never READY, because a row count would have been satisfied by
destroying the evidence.

**And one defect in this work was found by re-reading the diff rather than by a
test, which is recorded rather than quietly fixed.** The shared projection first
reused `placements()` and handed it `deployableCents: 0`, so a qualified piece
needing funding would have been described to every member, in Brain's own voice,
as waiting on cash the operation might well have had. **A false figure is a
worse leak than a true one**, because nobody reading it can tell it is wrong.
The shared reason is derived from the piece's own state, its dependency and its
card, and has no branch that can name a figure at all; the ranking is shared
because `rank` orders on properties of the piece rather than of the account; and
the owner's *disposition* is absent entirely, being a recommendation to whoever
owns the job rather than a fact about the frontier.

---

## Repository map

```
server/
  index.ts              boot: migrate -> seed -> recompute -> serve
  env.ts                every path the app uses
  config.ts             which database and which store, validated; no silent fallback
  db/
    types.ts            the async Database interface both backends implement
    driver.ts           SQLite driver abstraction (node:sqlite, or better-sqlite3 if installed)
    dialect.ts          ? -> $n and rowid -> seq, by walking the statement
    adapters/
      sqlite.ts         the local adapter
      postgres.ts       the cloud adapter: pooled, TLS, transactions pinned to a client
      transactions.ts   per-frame savepoints, so concurrent siblings cannot collide
    database.ts         opening the configured database and proving it works
    migrate.ts          automatic, checksum-verified, transactional migration runner
    migrations/*.sql    the SQLite schema, one numbered file per change
    pg-migrations/*.sql the Postgres schema, generated from it
  domain/
    types.ts            enums, row types, view types — the contract
    version.ts          version parsing/ordering/next-version (never sort strings)
    naming.ts           canonical name / conversation title / filename
    jurisdiction.ts     states, postal codes, and where each one may be read from
    opportunitySignals.ts  what kind of opening a claim is, and what it becomes
    auditProfile.ts     per-project audit criteria (Deal Dispatch G1-G14 + layers)
  repos/                data access, one module per entity
    auditReopens.ts     the record behind a re-audit, and its one reservation
    fleet.ts            accounts, Routines, capacity policy, and the fire slot
    factory.ts          the contract, the campaign, and units that own a surface
    factoryFleet.ts     factory workers, sessions, reviews, findings, the ledger
    externalRecords.ts  a site's record, its version guard, and its refusals
    cashMode.ts       the sprint's row, and the append-only history beside it
    cashAuthority.ts  the commercial grant, and the ceiling spent by insert
    cashPortfolio.ts  the opportunities, and the needs they raise
    cashLedger.ts     money, as append-only rows; no balance column anywhere
    cashActions.ts    what was actually done, and under which grant
    cashLock.ts       where two cash decisions stop being concurrent
    sharedFindings.ts the promotion record behind one shared Brain; pointers, never knowledge
    passkeys.ts       devices, enrollment links and challenges; digests, never secrets
    cashDiscovery.ts  which questions discovery asked, and which idea asked each
    capacityConnections.ts  one member's Claude connection, as rows rather than a conversation
    cashCardFacts.ts  where each answer on a card came from, and what kind it is
  services/
    storage.ts          document keys, confinement, and writing through the store
    storage/
      types.ts          the StorageProvider interface
      keys.ts           keys from Brain's identifiers; filenames are metadata
      local.ts          the data folder
      supabase.ts       the bucket, over REST
      index.ts          choosing one, and proving it answers
    cloudMigration.ts   the copy into the cloud, and its verification
    dependencies.ts     dependency checker
    stateEngine.ts      derived document/layer/project state
    planner.ts          Master Planner and next best action
    runtimeState.ts     data/runtime/project-state.json writer
    promptCompiler.ts   composable prompt sections
    auditEngine.ts      structured audits and their consequences
    redoEngine.ts       redo lineage
    synthesis.ts        synthesis preparation and packet validation
    freeze.ts           freeze / reopen semantics
    inference.ts        filename -> layer/version/type
    importer.ts         PDF import and registration
    reconcile.ts        scan & reconcile
    identity/
        secrets.ts        scrypt for passwords, sha-256 for generated credentials
      people.ts         who has actually joined, from a declared kind rather than a name
      webauthn.ts       a registration and an assertion, verified against Node crypto
      enrollment.ts     a member slot, its one link, and the recovery that retires first
      passkeyAuth.ts    the relying party, the challenge, and one refusal for everything
      context.ts        the request's principal, and why it is also on the request
      policy.ts         roles, scopes, and the one authorization decision
      authenticate.ts   cookie or bearer -> principal, from server rows only
      bootstrap.ts      the first administrator, once, into an empty Brain
    agent/              chat tools and the local intent router
    archive/
      import.ts         folder-scale import: discovery, resume, retry, provenance
    reconcile/
      claims.ts         mechanical claim extraction from the project's own documents
      coverage.ts       requirement x archive -> SATISFIED / STALE / MISSING / ...
      plan.ts           the boundary, the requirement graph, and gap-only fragments
    audit/
      context.ts        what an audit is allowed to see
      prompts.ts        the primary / adversarial / judge prompts
      schema.ts         zero-trust validation of model output
      pipeline.ts       orchestration; the only path to a recorded verdict
      evidence.ts       the citation trail from a verdict back to passages
      integrityReaudit.ts  the second reason a round begins, and what it preserves
    dispatch/
      fire.ts           one POST to the Routine, and what a refusal means
      loop.ts           the tick: supersede, ensure, route, claim a slot, send
      candidates.ts     the fleet as numbers, read once per tick
      router.ts         a pure decision, and seven named refusals
      scaler.ts         raise, lower, quarantine — proposals, never actions
      simulate.ts       a deterministic projection, structurally labelled
      profiles.ts       workload cost and activation traces, as queries
    factory/
      contract.ts       the change request, and what may never happen to it
      planner.ts        a proposed plan, validated to death before a row is written
      architect.ts      the decomposition pass, and the plan it is refused for
      registry.ts       the worker registry, and what the fleet can currently run
      scheduler.ts      a pure decision, and the lane count it measures
      git.ts            worktrees, diffs and merges — the factory's only evidence
      dispatch.ts       one unit on one worker, and the four ways it can end
      integrate.ts      ownership, the merge, and the verification that follows it
      review.ts         the independent verdict, and the lineage that makes it one
      repair.ts         a finding becomes work, exactly once
      assemble.ts       the reviewable artifact, and the publishing it refuses
      metrics.ts        throughput from the ledger, with an evidence class
      prompts.ts        every assignment, compiled from rows
      loop.ts           the tick, and every stage's answering transition
      executors/        how a worker is actually run; adding one is a row
    connect/
      sites.ts          a connected site's identity, credential and status, as one action
      contract.ts       the frozen wire contract, and nothing about it trusted
      projection.ts     the six answers, derived from rows on the read path
      service.ts        registering a site's records, and its one typed command
      loop.ts           the tick that makes a state change visible to a poller
    capacity/
      connection.ts     connecting a Claude account, and the one step Brain cannot do
    storageHealth.ts    how much room is left, measured rather than guessed
    knowledge/
      shared.ts         what crosses between projects, and what may never
    fleet/
      view.ts           three capacity numbers that are not each other, and why it is slow
      capacity.ts       what the dispatcher would fire, counted once and labelled honestly
      probe.ts          the one bounded self-test that turns configured into proven
      lab.ts            the eight test modes, and the five this version refuses to run
    cash/
      access.ts         where the shared frontier ends and a private job begins
      shared.ts         what every member may read, built from the columns it names
      lifecycle.ts      activating a sprint, giving it somewhere to file, winding it down
      authority.ts      the closed set of commercial actions, and the check
      money.ts          the six figures, and the arithmetic that keeps them apart
      card.ts           what is unknown, and the task that would answer each
      portfolio.ts      the disposition of every piece, and the assembled plan
      needs.ts          a missing capability, with somewhere to go
      review.ts         grouping by shared remedy; compression, measured
      opportunities.ts  the producer, and every transition an opportunity has
      capabilities.ts   what Brain can verifiably do, read rather than declared
      answers.ts        research reaching the card, and the view Brain forms on it
      figures.ts        a money figure read from a source, and never produced
      tier.ts           signal, candidate, qualified, ready — derived, never stored
      conditions.ts     what settles a need, as a function rather than a wiring
      discoveryAuthority.ts  what pressing Start authorizes, and what it never will
      validation.ts     the bounded deep dive, and what it puts on the card
      engineCard.ts     fact, estimate, decision, unknown — and the margin withheld
      discovery.ts      where the portfolio comes from: buckets, and a lane
      operate.ts        acting on a need: raise, settle, resume, start work
      view.ts           one private section, derived in one place
      readiness.ts      four people and four surfaces, counted from rows
    russell/
      home.ts           the eight things home says, in the order S6 fixes them
      collections.ts    threads organized without inventing a category, ranked by meaning
      frontier.ts       where understanding runs out: five regions, five lenses answered, four asked
      maps.ts           six maps over the authoritative graph, and an outline that is the same graph
      search.ts         scope decided before the query, never filtered after
      preferences.ts    a closed set of presentational keys; nothing here changes a fact
      whyThisMatters.ts real milestones, quiet by default, no gamification
      routing.ts        which project a conversation is about, authorization-first
      judgment.ts       what is worth capturing, dedupe, and Russell's own priority
      similarity.ts     the floor a proposed semantic merge is held to
      authority.ts      what Russell may do here, in the words a person decides in
      coverage.ts       the archive check that runs before any work is created
      launch.ts         the one way a mission comes into existence, and its repair
      turn.ts           one conversation turn, carried by the Routine fleet
      probe.ts          the bounded light probe, and its deterministic verdict
      probeEnvelope.ts  where a probe may look — in code, named by id
      proposal.ts       zero-trust validation of what a model proposes
      writeback.ts      what happens when a mission finishes, exactly once
      needsHuman.ts     the park a packet stops at, and the answer that finishes it
      planning.ts       the judgment pass, its post-probe repeat, and the mission spec
      loop.ts           the durable tick, beside the dispatcher
      subject.ts        what an idea is about, from rows rather than its own prose
      dealDispatch.ts   the connected system, with its freshness in the type
      projections.ts    the briefing, and progress that may not be invented
    research/
      schema.ts         zero-trust validation of every research pass
      sources.ts        what makes a claim sourced; structural URL validation
      standards.ts      the evidence standard per claim type, and independence
      actorScope.ts     whose action a forbidden phrase is: Brain’s, or the source’s
      gate.ts           the seven evidence conditions, applied per fragment
      splitting.ts      fragment splitting and the dependency order
      bundling.ts       which fragments may share one job, and which never may
      quota.ts          execution tiers, and pausing rather than lowering the bar
      repair.ts         the plan behind a second attempt, never the same search
      replan.ts         new evidence against old, and cancelling needless work
      contradictions.ts which kind of disagreement two claims are actually in
      independence.ts   audit independence by execution lineage, not role name
      packet.ts         does this answer the goal, and what is missing if not
      review.ts         the plan a person approves before anything is spent
      approvalEnvelope.ts  limits a person set first, and the check against them
      progress.ts       where the run is, read from persisted state only
      prompts.ts        plan / fragment / bundle / verification / synthesis prompts
      orchestrator.ts   the assignment loop, and the only path to a filed report
      queue.ts          one job at a time, cancellation, restart recovery
    providers/
      connection.ts     detect / authenticate / test / models / paid overage
    sources/
      segmenter.ts      conversation- and topic-aware segmentation
      classify.ts       content-based layer proposals, and injection detection
      ingest.ts         the ingestion pipeline and its counted report
    documents/
      formats.ts        format detection by magic bytes, not extension
      pdf.ts            columns -> lines -> blocks, plus quality signals
      docx.ts           OOXML via mammoth, headings/lists/tables preserved
      text.ts           plain text, Markdown and pasted text
      ocr.ts            recognition, per-block boxes and confidence
      ocrRuntime.ts     deterministic discovery of the local OCR executables
      normalize.ts      artifact cleanup that keeps the raw text
      quality.ts        the gate: READY / READY_WITH_WARNINGS / BLOCKED
      chunker.ts        heading-aware chunks with page and block anchors
      extraction.ts     the pipeline, and crash recovery
      queue.ts          serial background extraction
      retrieval.ts      passage search and citation resolution
      findings.ts       the structured index, anchored to real quotes
  providers/            AIProvider abstraction: mock, Claude, OpenAI, Antigravity
    antigravity/        runtime probe, bounded process, job workspaces, PTY path
  mcp/                  the remote MCP gateway (Step 7)
    protocol.ts         versions, header rules, error codes, result envelopes
    validate.ts         _meta and header-body validation, era detection
    errors.ts           the closed set of tool error categories
    limits.ts           sizes, pages, rate and concurrency
    tools.ts            the permanent tool surface, over existing services
    execute.ts          one call: rate slot, authorize, bound, audit
    modern.ts           the 2026-07-28 dispatcher
    legacy.ts           the 2025-11-25 front-end, over the official SDK
    endpoint.ts         POST /mcp: auth, origin, limits, era selection
  routes/               HTTP API
    factory.ts          the Software Factory: objective, stage, evidence, release
    connect.ts          a connected site's door: records, projections, one command (Step 12C)
    cash.ts             Cash Mode's door: the sprint, the grant, the portfolio, the money
    russell.ts          Russell's surface: threads, briefing, work, ideas, sites, Needs You
    passkeys.ts         enrolling, signing in with a device, and your own devices
    people.ts           who has joined, what can run, and connecting your Claude account
    oauth.ts            the authorization server: discovery, consent, tokens (Step 8)
    pages.ts            shared chrome for the server-rendered pages
    guard.ts            request context, authentication, deny-by-default
    auth.ts             sign in, sign out, change a password
    admin.ts            people, workers, credentials, membership, the identity audit
    access.ts           the optional shared-token outer layer (not the security model)
    files.ts            serving a stored document through the storage layer
client/                 React UI
  src/Root.tsx          which shell this address wants, and who is signed in
  src/russell/          the whole product: conversation, thin views, states
  src/russell/Build.tsx the factory, as a person uses it: one objective, one approval
  src/russell/Cash.tsx  one person's private sprint, and nobody else's
  src/russell/People.tsx     who has joined, my Claude connection, and usable capacity
  src/russell/Devices.tsx    your own passkeys, and nobody else's
  src/components/Enrol.tsx   where an enrollment link lands, before the sign-in gate
  src/russell/Home.tsx  the command center: state, focus, maturity strip, collections
  src/russell/Fleet.tsx capacity, surfaces, policy as rows, and the lab beside it
  src/russell/Frontier.tsx  the five regions, each item naming what it came from
  src/russell/Maps.tsx  six maps, with the outline always in the document
  src/russell/Search.tsx one search over everything this person may see
  src/russell/design.css the Step 12B design system: tokens, container reflow, both themes
  src/App.tsx           the legacy console, at /legacy
objectives/             software objectives a person approved, in the image by design
scripts/
  factory.ts                the operator's factory surface: register, submit, run
  connect-site.ts           a site's worker and grant, made without a browser
  connect-report.ts         what a connected site has done, read from inside
  admin.ts                  emergency administration, on a terminal rather than a page
  step12a-acceptance.ts     the nineteen gates, from rows; exit 0 only if all PASS
  fleet.ts                  the operator's fleet surface: register, target, explain
  generate-pg-baseline.mjs  the Postgres schema, generated from the SQLite one
  migrate-cloud.ts          npm run migrate:cloud
tests/                  Vitest suites
  step12bProduct.test.ts     the product decisions, where they are decided
  step12bResponsive.test.ts  the widths that were clipping, and why they no longer do
  cashMode.test.ts           the lifecycle, and the off switch that is not the Brain's
  cashMoney.test.ts          the six figures, and the cost that must not be subtracted twice
  cashAuthority.test.ts      the closed vocabulary, and the race for the last dollar
  cashPortfolio.test.ts      the unknowns, the dispositions, and the measured compression
  cashDiscovery.test.ts      the buckets, the lane, and the blank card they produce
  cashPipelineRepair.test.ts the fifteen proofs the production audit asked for
  cashOperate.test.ts        a capability read, a need resumed, an action recorded
  cashIntegrationPass.test.ts  one sprint, walked the whole way, entrances only
  cashProposal.test.ts       the seven terms, and the numbers Brain will not invent
  cashOpportunityStandard.test.ts  what is an opportunity, and whose question is whose
  cashBrowserToDatabase.test.ts  the screen, the route and the row, with no seam
  cashFourAccounts.test.ts   four private operations, and the walls between them
  cashDeploymentSmoke.test.ts  the artifact booted, driven over HTTP as a person and a worker
  sharedKnowledge.test.ts    one finding, two operations, and the wall between them
  webauthn.test.ts           a real P-256 credential, and every refusal that would not have been one
  passkeyEnrollment.test.ts  a link spent once, a recovery that retires, a count that waits
  passkeyHttp.test.ts        the door, over a socket: five ways in and nothing else new
  sharedCashAccess.test.ts   a member reads the frontier; nobody reads somebody's job
  peopleAndCapacity.test.ts  a declared person, a counted Routine, a resumable setup
  peopleSection.test.tsx     the two screens the defects were actually visible on
  migrationRebuild.test.ts   a rebuild over rows, and the cascade it must not fire
  cashConcurrency.test.ts    two commitments, forced to overlap, on both backends
  cashCurrencyHttp.test.ts   a sprint that is not in dollars, driven as a person does
  cashHttp.test.ts           Cash Mode's door, driven as an attack
  cashSection.test.tsx       the Cash section in a browser: four states, one control
  connectorIsolation.test.ts one site, two private operations, two identities
  fixtures/             generated PDFs and DOCX packages, not opaque binaries
data/                   database, documents, backups, runtime state (gitignored)
```

## Conventions

- TypeScript ESM. **Relative imports include the `.ts` / `.tsx` extension.**
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` and `noUncheckedIndexedAccess` are on.
- SQLite parameters are positional `?` only, so both drivers behave identically.
- **An `ORDER BY` must be sayable in both dialects.** Postgres refuses an
  expression that is not in the select list of a `SELECT DISTINCT`, so name the
  aggregate and order by the alias — `SELECT DISTINCT … ORDER BY MAX(x)` passes
  the SQLite suite and throws on the database production runs.
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

```
npm run typecheck
npm test
```

Then verify the two boot paths that matter: migrating from an empty database, and
restarting against an existing one.

If the change touched persistence, run the suite against Postgres too — it is
the same 490 tests against the other backend, and it is the only thing that
proves one repository layer over two databases is true rather than merely
compiling:

```
BRAIN_TEST_DATABASE_URL=postgresql://... npm test
```
