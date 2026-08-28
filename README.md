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

### Or in the cloud

The table above is the default and needs no configuration. Brain can also keep
its state in Postgres and an object store instead, so a project stops being the
property of one laptop:

```bash
BRAIN_DATABASE_PROVIDER=postgres
BRAIN_DATABASE_URL=postgresql://…
BRAIN_STORAGE_PROVIDER=supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=…
BRAIN_STORAGE_BUCKET=brain
```

Cloud mode never falls back to local: if the database or the bucket cannot be
reached, Brain refuses to start and says why, rather than quietly writing your
research somewhere nobody else can see it. Moving an existing Brain across is
`npm run migrate:cloud` — a copy that never modifies the local original and is
safe to re-run.

**[docs/CLOUD.md](docs/CLOUD.md)** covers how cloud mode works — configuration,
migration, verification and recovery. **[docs/DEPLOY.md](docs/DEPLOY.md)** is the
runbook for standing up the first hosted Brain on Supabase and Fly.io, and
**[docs/STEP-3-EVIDENCE.md](docs/STEP-3-EVIDENCE.md)** records what the first
deployment actually proved and what it did not.

A hosted Brain is private: every API route and every document byte resolves to an
authenticated principal — a person holding a session, or a worker holding a
Brain-issued credential — and to an explicit authorization decision made by
server code when the operation runs.
**[docs/IDENTITY.md](docs/IDENTITY.md)** is the whole model: principals, roles
and scopes, project membership, credential lifecycle, the audit, and the threat
model including what it does *not* defend against.

A connected Claude does the research, and the Brain decides what counts. A worker
is handed one bounded question with the boundaries it will be judged against,
submits what it found, and every claim is stored **unaccepted** until the
evidence gate rules on it — the same gate, in the same code, that judges research
done in process. **[docs/RESEARCH-PACKETS.md](docs/RESEARCH-PACKETS.md)** is the
design; **[docs/workers/RUNNING-A-PACKET.md](docs/workers/RUNNING-A-PACKET.md)**
is what a person actually does, in order.

It still runs **one** instance, deliberately: the atomic claiming and leases that
make a second one safe are Step 5.
**[docs/ROADMAP.md](docs/ROADMAP.md)** is the register of which step owns what,
and the separations in it are load-bearing rather than cosmetic.

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
- **Document understanding** — PDF, DOCX, TXT, Markdown and pasted text read into pages
  and ordered blocks with per-page quality signals, a quality gate that blocks a document
  Brain cannot honestly claim to have read, and append-only extraction runs so an old
  audit still resolves to the text it saw.
- **Scanned documents** — a local OCR runtime Brain discovers and version-checks itself,
  invoked only for the pages that need it, with the engine, the rendered image, the
  resolution and the per-block confidence all recorded.
- **Evidence and citations** — chunked with page and block anchors, searchable, and every
  audit conclusion recorded with the passages it can be checked against.
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
- **Structured findings.** The index over a document (claims, definitions, actors,
  contradictions) needs a real provider, and Brain refuses to derive it from the mock —
  an invented index is worse than none. Retrieval, citations and audits all work without
  it.
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

## Reading documents

Drop in a PDF, DOCX, TXT or Markdown file and Brain reads it in the background, then tells
you exactly what it managed to read:

```
READY  28/28 pages · 100% coverage · 22,642 chars   [REPROCESS] [VIEW EXTRACTED TEXT] [INDEX FINDINGS] [VIEW ORIGINAL]
```

Format is decided by the bytes, not the extension. PDF pages are reconstructed into reading
order — columns found from the text items, then lines within each column — and repeated
headers and footers are labelled as furniture rather than deleted. Pages with no text layer
are sent to OCR if a local engine is installed; if none is, they are reported unreadable
instead of passed on as empty content.

### Scanned documents

Pages with no text layer are sent to OCR. Brain finds the tools itself — an
explicit path in the environment first, then the `PATH`, then the default install
locations for your platform — checks them at startup and prints what it found:

```
OCR             tesseract 5.3.4 + pdftoppm version 24.02.0 at 300 dpi (eng)
```

If they are missing it prints the exact one-time step instead, and every scanned
page is reported unreadable rather than passed on as empty content:

| Platform | One-time install |
| --- | --- |
| Windows | `winget install --id UB-Mannheim.TesseractOCR`, then unzip [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) to `C:\Program Files\poppler` |
| macOS | `brew install tesseract poppler` |
| Debian/Ubuntu | `sudo apt-get install -y tesseract-ocr poppler-utils` |

No PATH edit is needed — Brain looks in the default install directories. If yours
are elsewhere, set `BRAIN_TESSERACT_PATH` and `BRAIN_PDF_RENDERER_PATH` and
restart. An explicit path that does not work is reported as an error rather than
quietly replaced by some other binary.

| Variable | Default | What it does |
| --- | --- | --- |
| `BRAIN_OCR` | (unset) | `none` switches OCR off; scanned pages are then reported unreadable |
| `BRAIN_TESSERACT_PATH` | (discovered) | Explicit path to the recogniser |
| `BRAIN_PDF_RENDERER_PATH` | (discovered) | Explicit path to `pdftoppm` or `pdftocairo` |
| `BRAIN_OCR_DPI` | `300` | Resolution the page is rendered at before recognition |
| `BRAIN_OCR_LANG` | `eng` | Recognition language passed to Tesseract |
| `BRAIN_OCR_TIMEOUT_MS` | `120000` | Per-page ceiling; a page that exceeds it is unreadable, not blank |

Recognition is local. Nothing is uploaded to be read, and there is no cloud
fallback: a page this machine cannot read is reported as one it cannot read.

Every recognised page records what it was read from — the sha-256 of the exact
rendered image, its size, the DPI, the confidence and how long it took — and every
recognised block keeps its bounding box and its own confidence:

```
READY WITH WARNINGS  3/3 pages · 100% coverage · 1,698 chars · 3 page(s) by OCR

OCR — tesseract-cli (tesseract 5.3.4) via pdftoppm version 24.02.0.
PAGE  READ  CONFIDENCE  IMAGE                          BLOCKS  CHARS  TIME
1     yes   96%         2550x3300 @300dpi 76726fbc     4       572    2705ms
```

Confidence is evidence, so it gates. Below 35% a page is counted as unread and
goes through the ordinary coverage rule; between 35% and 60% the reading stands
but the uncertainty is stated on the run, the block and the panel. A document
does not become READY merely because OCR returned some characters.

Then the quality gate decides whether the reading can be trusted at all. Too few pages read,
too little text, or too many replacement glyphs and the document is **BLOCKED**: it cannot
be audited, synthesised or frozen until it is reprocessed or replaced. A packet with one
blocked member cannot be audited either.

Every block keeps its raw text beside its normalized text, its page, its character range and
its extraction method, so nothing the cleanup does can be the only copy of the evidence.
Reprocessing creates a **new** run and supersedes the old one, so an audit recorded last
month still resolves to the text it actually read.

Ask the evidence a question — from the audit panel, or `POST /api/layers/:id/evidence` — and
you get passages with page anchors, plus the two lists that decide whether a gap is real:
what was searched, and what could not be read. Every audit verdict records the passages
behind it, retrieved from the text rather than quoted by the model, and each one resolves
back to its source blocks.

## Recommended next build step

**Research execution through the provider.** `AIProvider.runResearch()` is already defined
and every run already stores its exact prompt and attachment list, so running the research
is the same shape of change the audit engine and the ingestion pipeline just made.

After that, **more recognition languages** — the pipeline already passes `BRAIN_OCR_LANG`
through, so a non-English corpus is a matter of installing the language data and setting
one variable, not a change to the engine.

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
