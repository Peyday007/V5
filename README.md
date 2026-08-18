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
each with a one-click fix. It never deletes anything of yours.

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
- **Audit engine** — structured verdicts and findings, never prose alone.
- **Redo engine** — new run, new attempt number, lineage preserved, failed attempts never
  destroyed, capped at `maxAutoRedos` before a human is required.
- **Synthesis engine** — packet validation, synthesis document and run creation, and a
  hard refusal to run with missing dependencies unless you explicitly override.
- **Freeze semantics** — canonical artifact required, earlier documents kept as
  provenance, explicit reopen path.
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

## Recommended next build step

**Wire in real provider execution behind the run lifecycle**, starting with audits.
Everything it needs already exists: runs persist their exact prompt and attachment list,
`AIProvider.audit()` is defined, `parseAuditJson` already consumes structured verdicts,
and `recordAudit` already applies the consequences. Making `POST /api/runs/:id/audit`
optionally call the configured provider turns the current copy-paste loop into a one-click
loop without changing a single stored shape.

After that, PDF text extraction on import is the highest-leverage addition, because it
lets audits check a document's actual contents against the prompt that produced it.

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
