# Brain

A local-first research-operations platform. It holds the state of a multi-layer research
project — which documents exist, which are missing, what is blocked, what is ready for
synthesis, what is frozen — and answers one question reliably:

> **What should I do next?**

SQLite is plumbing you never touch. Change code, restart, and the database migrates
itself. Drop a folder of PDFs on the window and the platform reconstructs the project.

---

## Quick start

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**.

That is the whole setup. No database to create, no migrations to run, no API keys
required. On first boot the app creates the database, applies every migration, seeds the
**Deal Dispatch** project with its eight layers, and starts serving.

| Command | What it does |
| --- | --- |
| `npm run dev` | API on `:5174` + Vite dev server on `:5173` (proxied) |
| `npm run build` | Typecheck, then build the client to `client/dist` |
| `npm start` | Production: one process on `:5174` serving API **and** UI |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:reset` | Delete the database so the next boot starts clean |

Requires **Node 22.5+** (for the built-in `node:sqlite` driver). If you would rather use
`better-sqlite3`, just `npm install better-sqlite3` — the platform detects it and uses it
automatically, with no code change.

---

## Where everything lives

| Thing | Path |
| --- | --- |
| Database | `data/brain.db` (plus WAL sidecar files) |
| Documents | `data/projects/<project-slug>/documents/<layer-slug>/` |
| Unfiled imports | `data/projects/<project-slug>/documents/_unfiled/` |
| Derived state snapshot | `data/runtime/project-state.json` |
| Pre-migration backups | `data/backups/` |

All of `data/` is gitignored — it is your research, not source code. Override the
location with `BRAIN_DATA_DIR=/some/path`.

Documents are stored under the **platform-controlled** filename, e.g.
`data/projects/deal-dispatch/documents/discovery-logic/Discovery Logic v1G.pdf`.
Original files are preserved; nothing is ever overwritten in place.

---

## How automatic migrations work

On every boot, in `server/index.ts`:

1. Open `data/brain.db` (created if absent).
2. Ensure the `schema_migrations` table exists.
3. Read every `server/db/migrations/NNN_name.sql` in numeric order.
4. Verify each already-applied migration still matches its recorded checksum.
5. Back up the database file if there are pending migrations and existing data.
6. Apply each pending migration **inside its own transaction**, recording its version.
7. Continue boot — or, if a migration fails, roll it back and surface a clear
   application error instead of serving a half-migrated database.

So the loop is exactly: **code update → restart → database updates → app loads.**

To change the schema, add a new numbered file. Never edit an applied one: applied
migrations are checksum-locked, and editing `001_initial.sql` after it has run makes the
app refuse to boot with an explicit message. That is deliberate — it is what stops the
schema and the data from silently diverging.

---

## Importing your existing research

1. Click **IMPORT DOCUMENT** (or drag files straight onto the drop zone).
2. Drop in as many PDFs as you like at once.
3. For each file the platform infers **layer**, **version** and **document type** from the
   filename, shows its confidence and its reasoning, and registers the obvious matches
   automatically.
4. Anything genuinely ambiguous lands in `_unfiled` and asks you one question — it is
   never guessed at and never silently registered.
5. Dependencies, layer status and the next action all recalculate immediately.

Filenames like these are understood without any help:

```
World Model v1.pdf
Discovery Logic v1G.pdf
Decision Routing Rules v1F.pdf
Qualification Logic v3.1.pdf
monetization-logic-v1c.pdf
```

After a bulk import, use **DERIVE FROM DOCUMENTS** on a layer to set its expected version
set to what you actually have, so completeness is measured against reality.

If you ever move or delete files by hand, run **SCAN & RECONCILE**. It reports files on
disk that nobody registered, database rows whose file disappeared, and checksum changes —
each with a one-click fix. It never deletes anything of yours, and an inconsistency
outranks every other piece of work in the planner until you resolve it.

---

## What is built

- **Automatic migrations** — checksum-verified, transactional, applied on boot.
- **Domain model** — projects, layers, documents, dependencies, research runs, audits with
  structured findings, conversations, messages, and an append-only event log.
- **Versioning engine** — real version semantics (`v1` → `v1B` … `v1G` → `v3.1`), never
  lexicographic string sorting, configurable per project.
- **Naming engine** — the platform, not the model, owns `canonical_name`,
  `conversation_title` and `filename`, and injects hardened naming rules plus a final
  naming check into every prompt.
- **Document import** — drag-and-drop with filename inference, confidence scoring,
  duplicate detection by checksum, and originals preserved.
- **Dependency checker** — `7 / 7 READY`, or the exact missing canonical names and
  `RUN BLOCKED`.
- **Project-state engine** — document, layer and project status all derived automatically
  from the database and the filesystem after every meaningful action.
- **Master Planner** — NOW / NEXT / LATER / BLOCKED plus one prominent **next best
  action**, deterministic from state.
- **Prompt compiler** — prompts composed from reusable sections, saved verbatim onto the
  run along with the exact required-attachment list.
- **Audit engine** — structured verdicts and findings, never prose alone; tolerant of
  messy model output, and deliberately hard to trick into an approval nobody gave.
- **Dynamic audit engine** — one button runs a primary audit, an adversarial critique and
  a final judge over a single artifact or a whole layer packet, against the project's own
  criteria, and answers the questions that decide what happens next: is it actually good
  enough, what is truly missing, does that gap belong here, does it require research, how
  many runs remain, can we synthesise, can we freeze.
- **Redo engine** — new run, new attempt number, lineage preserved, failed attempts never
  destroyed, capped at `maxAutoRedos` before a human is required.
- **Synthesis engine** — packet validation at every door (start, complete, register), and
  a hard refusal to run with missing dependencies unless you explicitly override.
- **Freeze semantics** — a synthesis that passes its final audit freezes the layer
  automatically; a canonical artifact is always required, earlier documents are kept as
  provenance, and reopening restores the whole source packet so the layer can run again.
- **Reconciliation** — database ↔ filesystem consistency with one-click fixes.
- **Project-aware chat** — natural instructions ("What's next?", "Audit Discovery.",
  "Freeze World Model.") routed through tools that read live state. It cannot assert that
  a document exists without a database read proving it.
- **Provider abstraction** — `MockProvider` (default, fully working, no network) with
  clean `ClaudeProvider` / `OpenAIProvider` adapters.

## What is still mocked

- **AI execution.** The default provider is `MockProvider`. The MVP path is
  **COPY PROMPT** + **COPY REQUIRED ATTACHMENT LIST** — you run the research in whatever
  tool you like and import the resulting PDF back in. `ClaudeProvider` and
  `OpenAIProvider` are real `fetch` adapters, but they are inert until you set
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and `BRAIN_PROVIDER`.
- **PDF text extraction.** Import reasons about filenames, not contents, so an audit
  cannot yet read the document it is auditing.
- Deliberately out of scope for this build: webhooks, cloud deployment, multi-user auth,
  vector search, RAG, billing, analytics.

## The audit engine

Click **AUDIT** on a document, or **AUDIT FULL LAYER PACKET** on a layer. Brain gathers the
exact assignment, the artifact, the surrounding packet, prior findings and live dependency
state, then runs three separate roles:

```
context -> PRIMARY (requirement, structural, boundary, dependency)
        -> ADVERSARIAL (assume the primary was too generous)
        -> JUDGE (one disposition, structured)
        -> recordAudit -> state engine -> Master Planner
```

The answer leads with three lines — the verdict, how many research runs remain, and the one
concrete next action — with gaps, patches, handoffs, adversarial findings, reasoning and
the raw model responses behind expandable sections.

Every issue is **classified**, because "more could be researched" and "more research is
required" are different answers. Only `FOUNDATIONAL_GAP` and `TARGETED_RESEARCH_GAP` may
hold a layer open; `OTHER_LAYER`, `IMPLEMENTATION_DETAIL`, `EMPIRICAL_TUNING`,
`DOMAIN_PLUGIN`, `PATCH` and `OPTIONAL_IMPROVEMENT` never do.

Model prose cannot move the project. Enums are matched exactly — no substring matching, no
negation handling, no template placeholders, no inferred approval — the judge's counts are
cross-checked against the gaps it classified, and an advancing verdict is refused while a
foundational gap is open. An invalid response, a provider error or an unreadable artifact
is an audit **failure**: nothing is recorded and nothing moves, though the failure and the
raw response are kept so you can see why.

Project criteria live in one profile (`server/domain/auditProfile.ts`). The Deal Dispatch
profile carries G1–G14 and each of the eight layers' own criteria, including what each layer
does **not** own — which is what lets the audit route a gap to its real owner instead of
opening research in the wrong place.

Without an API key the audit still runs, and deliberately declines to advance any layer it
never actually read.

## Recommended next build step

**Proper PDF text extraction.** The audit engine is now the sharpest tool in the box, and
it is limited by what it can read: `extractReadableText` recovers text from uncompressed
PDF content streams and returns nothing for compressed or scanned files, which the pipeline
correctly treats as a blocked audit rather than a pass. Real extraction would let the
auditor judge the whole corpus instead of the part it can currently see.

After that, **research execution through the provider** — `AIProvider.runResearch()` is
already defined and every run already stores its exact prompt and attachment list, so
running the research is the same shape of change the audit engine just made.

---

## Architecture

```
server/
  index.ts              boot: migrate -> seed -> recompute -> serve
  env.ts                every path the app uses
  db/                   driver abstraction, connection, migration runner, migrations
  domain/               types, versioning engine, naming engine
  repos/                data access, one module per entity
  services/             dependencies, state engine, planner, prompt compiler,
                        audit/redo/synthesis/freeze, import/inference/reconcile, chat agent
  providers/            AIProvider abstraction: mock, Claude, OpenAI
  routes/               HTTP API
client/                 React UI: layers | workflow | Master Planner
tests/                  Vitest suites
```

`CLAUDE.md` holds the operating rules for any agent working on this repository — chiefly:
query state, never guess it; every schema change gets a migration; every artifact gets
registered; preserve lineage.
