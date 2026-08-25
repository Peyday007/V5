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
- Before synthesis the packet is checked against the whole goal — mandatory
  coverage, consistent scope, verified calculation inputs, investigated
  counterarguments, nothing load-bearing on a single source. A failure produces
  fragments for exactly what is missing, never a re-run of what worked.
- The research engine, archive ingestion, and the real Antigravity worker are
  reported separately. The engine passing its tests against a scripted provider
  says nothing about whether the tool works on this machine, and the worker is
  UNVERIFIED until a real job has actually run there.

## 17. Configuration is a request. Only a real operation is a fact.

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
      packet.ts         does this answer the goal, and what is missing if not
      review.ts         the plan a person approves before anything is spent
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
  routes/               HTTP API
    files.ts            serving a stored document through the storage layer
client/                 React UI (three panes: layers / workflow / planner)
scripts/
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
