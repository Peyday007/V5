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

Step 8 (`server/routes/oauth.ts`, `server/routes/operator.ts`,
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
- **The operator console is server-rendered and has no JavaScript.** It is the
  surface you need when the client bundle is broken or access has to be
  repaired, so it must not depend on the front-end having built. It exposes no
  operation an administrator could not already perform.
- **It has three answers, not two.** Nobody signed in gets a sign-in form, which
  discloses nothing — the Brain already serves one at its root to the whole
  internet. Somebody who *is* signed in and may not be here gets **404**, because
  that is the case worth hiding: a caller who has already proved they are not an
  administrator learns nothing about whether the path is anything. A bearer token
  is refused in all three, since a machine reaching the screen that grants
  credentials would be a machine widening its own access. The first version
  answered 404 to both of the last two, which also told an administrator with an
  expired session that the console did not exist — a control indistinguishable
  from a broken deployment costs more than it saves.
- **A worker cannot create its own work.** Enqueueing is a project write and no
  worker scope grants it, so `decideProjectAccess` refuses a worker principal
  however its membership is configured. The console has the button instead,
  because a machine that could create its own work could also create work nobody
  asked for. The same reasoning put project creation there: the only project that
  existed held real research, and a test worker's first bounded run must not be
  able to write into work somebody depends on.

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
  only place some operations exist. `/operator` stays server-rendered and
  outside the bundle, for the same reason §22 gave.

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
    auditProfile.ts     per-project audit criteria (Deal Dispatch G1-G14 + layers)
  repos/                data access, one module per entity
    fleet.ts            accounts, Routines, capacity policy, and the fire slot
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
    dispatch/
      fire.ts           one POST to the Routine, and what a refusal means
      loop.ts           the tick: supersede, ensure, route, claim a slot, send
      candidates.ts     the fleet as numbers, read once per tick
      router.ts         a pure decision, and seven named refusals
      scaler.ts         raise, lower, quarantine — proposals, never actions
      simulate.ts       a deterministic projection, structurally labelled
      profiles.ts       workload cost and activation traces, as queries
    russell/
      routing.ts        which project a conversation is about, authorization-first
      judgment.ts       what is worth capturing, dedupe, and Russell's own priority
      coverage.ts       the archive check that runs before any work is created
      launch.ts         the one way a mission comes into existence, and its repair
      turn.ts           one conversation turn, carried by the Routine fleet
      probe.ts          the bounded light probe, and its deterministic verdict
      probeEnvelope.ts  where a probe may look — in code, named by id
      proposal.ts       zero-trust validation of what a model proposes
      writeback.ts      what happens when a mission finishes, exactly once
      loop.ts           the durable tick, beside the dispatcher
      dealDispatch.ts   the connected system, with its freshness in the type
      projections.ts    the briefing, and progress that may not be invented
    research/
      schema.ts         zero-trust validation of every research pass
      sources.ts        what makes a claim sourced; structural URL validation
      standards.ts      the evidence standard per claim type, and independence
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
    russell.ts          Russell's surface: threads, briefing, work, Needs You (Step 12A)
    oauth.ts            the authorization server: discovery, consent, tokens (Step 8)
    operator.ts         the operator console: workers, access, projects, queued work
    pages.ts            shared chrome for the server-rendered pages
    guard.ts            request context, authentication, deny-by-default
    auth.ts             sign in, sign out, change a password
    admin.ts            people, workers, credentials, membership, the identity audit
    access.ts           the optional shared-token outer layer (not the security model)
    files.ts            serving a stored document through the storage layer
client/                 React UI
  src/Root.tsx          which shell this address wants, and who is signed in
  src/russell/          the default shell: conversation, thin views, states
  src/App.tsx           the legacy console, at /legacy
scripts/
  step12a-acceptance.ts     the nineteen gates, from rows; exit 0 only if all PASS
  fleet.ts                  the operator's fleet surface: register, target, explain
  generate-pg-baseline.mjs  the Postgres schema, generated from the SQLite one
  migrate-cloud.ts          npm run migrate:cloud
tests/                  Vitest suites
  fixtures/             generated PDFs and DOCX packages, not opaque binaries
data/                   database, documents, backups, runtime state (gitignored)
```

## Conventions

- TypeScript ESM. **Relative imports include the `.ts` / `.tsx` extension.**
- `import type` for type-only imports (`verbatimModuleSyntax` is on).
- `strict` and `noUncheckedIndexedAccess` are on.
- SQLite parameters are positional `?` only, so both drivers behave identically.
- Booleans are `0`/`1` in the database and real booleans in view types; repositories are
  the only place the two representations meet.
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
