# Step 3 — evidence

What was actually observed, on what day, by what means. Written so that a
sceptical reader can tell the difference between a thing that was proven, a
thing that passes its tests, and a thing nobody has run yet.

**Date** 2026-08-25 · **Branch** `claude/zealous-hypatia-78a2yp`

The claim being made is narrow and it is the only one worth making:

> The Brain is cloud-backed, deployed, private, and no longer dependent on one
> local computer.

---

## The deployment

| | |
|---|---|
| Application | `northline-brain` on Fly.io, region `iad` |
| Machines | 1, deliberately (`--ha=false`; queues are per-instance until Step 5's claiming and leases) |
| URL | `https://northline-brain.fly.dev` |
| Database | Supabase Postgres, session pooler, `aws-0-us-east-2.pooler.supabase.com:5432/postgres` |
| Documents | Supabase Storage, **private** bucket `brain`, project `<project-ref>.supabase.co` |
| Access | HTTP Basic, one shared token, `/healthz` exempt |
| Image | `node:22-slim` + `poppler-utils` + `tesseract-ocr`, non-root, `node` as PID 1 |

The Supabase project reference is redacted here on purpose. It is not a
credential and Brain's own `/api/health` returns it to the browser, but an
evidence file is a poor place to widen anything's blast radius.

---

## What was proven, and how

| Claim | Evidence |
|---|---|
| The schema exists in Postgres, applied by Brain itself | Local `npm start` against the Supabase URL reported `Driver postgres`, `Schema version 2`, `Migrations applied 2 (1 baseline, 2 cloud_migration_ledger)` — against a database that was empty minutes earlier |
| The private bucket answers | Same boot printed `Documents supabase · <ref>.supabase.co · bucket brain`. That line is printed only after a real listing, not from configuration |
| Cloud mode does not fall back | Boot is the proof: a Postgres or bucket that did not answer stops the boot with the reason. It started |
| The deployment is private | Anonymous `GET /healthz` → **200**; `GET /` → **401**; `GET /api/health` → **401** |
| Liveness reveals nothing | `/healthz` returns the fixed string `ok`; it names no project, host or version |
| The container really reaches Supabase | Authenticated `/api/health` from outside reported `"database":"postgres"`, `"databaseTarget":"aws-0-us-east-2.pooler.supabase.com:5432/postgres"`, `"storage":"supabase"`, `"storageTarget":"<ref>.supabase.co/brain"`, `schemaVersion 2` |
| No credential leaks through the API | That same response names hosts and a bucket and contains neither the connection string nor the service-role key |
| The container can read scanned pages | `/api/health` OCR block: `available: true`, `tesseract 5.3.0`, `pdftoppm version 22.12.0`. The Windows laptop that deployed it reports OCR **not** available — the capability belongs to the image, not the operator |

### A → B → C, the test that matters

Everything above can pass while an app still secretly depends on local disk.
This is what rules that out.

1. **A** — signed in to `https://northline-brain.fly.dev` from a browser. The
   seeded **Deal Dispatch** project rendered, header `schema v2 · postgres`.
   Nothing on the operator's laptop was running.
2. **B** — imported `World Model v1.md` (289 B) through the deployed app. It
   registered as `World Model v1`, `FOUNDATION`, wave 1, and the layer moved to
   **AUDIT READY** with `docs 1 / 1`, extraction `READY · 1/1 pages · 100%
   coverage · 277 chars`. AUDIT READY is the load-bearing detail: a layer
   reaches it only when the document was *read*, not merely stored.
3. **C** — `fly apps restart northline-brain`. A Fly machine gets a fresh
   filesystem; no volume is attached. After the restart the layer still read
   `v1 docs 1 / 1 · AUDIT READY`, and
   `GET /api/documents/doc_ec08a425…/file` returned the file's own marker text.

The row surviving proves Postgres kept it. **The bytes coming back proves the
bucket kept them** — a row without bytes is `INCONSISTENT STATE`, which Brain
reports rather than papers over.

---

## What was *not* proven

Listing these is the point of the document.

- **Migration of a real archive.** `npm run migrate:cloud` was never exercised
  against real data, because there was none to exercise it against: the
  deployment machine held a fresh clone and `data/` is gitignored, so
  `data/brain.db` did not exist. The migration engine passes its own suite
  (17 tests, both backends) and remains **unverified against a real archive**.
  If an archive exists on another machine, Part 2 of `docs/DEPLOY.md` should be
  run from there.
- **More than one instance.** One machine, on purpose. `fly scale count 2` was
  not run and must not be until Step 5's atomic claiming and leases exist; Step
  11 is where a second worker is actually run.
- **The real Antigravity worker inside the container.** Unchanged and still
  UNVERIFIED; the deployed Brain reports `RESEARCH: SETUP REQUIRED`.
- **Sustained operation.** This is hours old. Nothing here says anything about
  what it does over weeks.

---

## Security events during the deployment

Recorded because a security note that only lists successes is not a record.

- **`BRAIN_ACCESS_TOKEN` was printed to a terminal.** Fly's Windows installer
  reads a PowerShell variable named `$v` as the version to install. An earlier
  command in the same session had left `$v` holding the last line it parsed out
  of `.env` — the access token — and the installer echoed it inside a "no such
  release" error. Nothing was listening on that token yet; it had not been
  deployed. It was **rotated** and the terminal closed. `docs/DEPLOY.md` now
  warns about `$v` before the installer step.
- **No credential was ever pasted into chat, committed, or printed
  deliberately.** Values were written to `.env` through masked prompts and
  confirmed by length and suffix only — `109 chars, ends with :5432/postgres`
  catches a wrong pooler port and discloses nothing.
- **`.dockerignore` excludes `.env`, `.env.*` and `data/`.** The image contains
  no credential and no research.
- **Secrets reached Fly through argument splatting**, not the command line as
  typed: the typed text was `@kv`, so shell history holds a variable name.

---

## Cost

One `shared-cpu-1x` machine with 1 GB of memory, kept running (`auto_stop_machines
= false`) because background extraction and open SSE streams do not survive
being suspended. Roughly $2–5/month, plus Supabase's free tier.

---

## What this is not

- **One shared credential.** Everyone holding the token sees everything. No
  users, no roles, no revocation of one person without changing it for all.
- **One uncoordinated instance.** The extraction and research queues are
  per-instance.
- **No worker identities** — Step 4. **No distributed queue, atomic claiming,
  leases or heartbeats** — Step 5. **No idempotency guarantees for concurrent
  effects** — Step 6. **No remote MCP** — Step 7. **No connected worker** —
  Step 8. **No fleet controls** — Step 11.

Those are separate steps and the separation is deliberate. Identity is not
concurrency: knowing which worker is calling does nothing to stop two of them
claiming one job, and a lease that stops them starting it does nothing to make
its effects safe to apply twice. The register is in [`ROADMAP.md`](ROADMAP.md).

`server/routes/access.ts` should be **deleted** when **Step 4** lands, not
extended. Step 4 is identity, credentials, authorization and the carry-forward
register — and nothing about concurrency.

---

## What comes next

| Step | What it contains |
|---|---|
| 4 | Identities, credentials, authorization, and the explicit carry-forward register |
| 5 | Distributed queue, atomic claiming, leases, and heartbeats |
| 6 | Idempotency and safe concurrent effects |
| 7 | Remote MCP |
| 8 | Connect one Claude Max worker |
| 9 | Manual end-to-end research packet |
| 10 | Scheduled firing and interruption recovery |
| 11 | Additional workers and fleet controls |

Step 3 is closed. None of the above is started.
