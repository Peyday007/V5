# Running Brain in the cloud

Brain is local-first and stays that way. Nothing in this document is required to
use it: with no configuration at all it runs against a SQLite file and a folder
of documents, exactly as before, and that remains the default and the mode the
tests run in.

What this adds is a second place Brain's state can live — a Postgres database
and an object store — so that the project stops being the property of one
laptop. That matters for one reason: the moment a second thing needs to read
the project (another server, a worker, a colleague), a database on somebody's
machine is not a database anybody else can reach.

---

## The one rule

**Cloud mode never falls back to local.**

If Brain is configured for Postgres and cannot reach it, it refuses to start and
says why. If it is configured for a bucket and the bucket does not answer, same.
It does not quietly carry on against local disk.

This is deliberate and it is the most important behaviour in this document. A
server that fell back would look healthy. It would accept imports and research,
write them to a disk nobody else can see, and report itself as cloud-backed the
whole time. Nobody would find out until they went looking for the work from
somewhere else — by which point there would be two divergent Brains and no
record of which held what.

A refusal to boot costs you five minutes. The alternative costs you the project.

The same rule applies to reporting. Brain never says it is cloud-backed because
the environment variables are set; it runs a real query and a real bucket
listing at boot, and only then does the banner say so.

---

## Configuration

### Local (the default — no configuration needed)

```bash
npm run dev
```

Database: `data/brain.db`. Documents: `data/projects/<slug>/documents/…`.

### Cloud

```bash
# Database
BRAIN_DATABASE_PROVIDER=postgres
BRAIN_DATABASE_URL=postgresql://user:password@host:5432/database

# Documents
BRAIN_STORAGE_PROVIDER=supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
BRAIN_STORAGE_BUCKET=brain
```

Optional:

```bash
BRAIN_DATABASE_POOL_SIZE=10   # 1–100, default 10
BRAIN_DATA_DIR=/path/to/data  # where local state lives, in either mode
```

Either half can be cloud on its own. Postgres with local documents is a
reasonable staging setup; the reverse is unusual but works.

#### TLS

Brain requires TLS for Postgres unless the connection string says otherwise,
because a managed database reached without it sends the password in clear. A
local Postgres with no TLS is a legitimate exception — say so deliberately:

```bash
BRAIN_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/brain?sslmode=disable
```

`SUPABASE_URL` must be `https://`. There is no opt-out, because the service-role
key is a bearer token with full access to the bucket.

#### Where to put them

Create `.env` in the repository root — it is gitignored, and `.env.example`
shows the shape without holding a value. `npm run dev`, `npm start` and
`npm run migrate:cloud` load it automatically.

```bash
cp .env.example .env    # then fill it in
```

Nothing needs to go on a command line, so nothing lands in shell history.

#### Where the secrets live

Server-side only. They are read from the environment by the server process, and
they appear in exactly two places: the Postgres connection and the
`Authorization` header of storage requests.

They are never in an API response, never in a log line, and never in the
frontend bundle — the client is a static React app that talks only to Brain's
own API and has no idea which backend is underneath. `/api/health` reports
`persistence.databaseTarget` as `host:port/database` and
`persistence.storageTarget` as `host/bucket`: enough to recognise where you
are, nothing that would let anyone else get there.

Do not make the bucket public. Every read goes through Brain, which is what lets
the project's own rules about who may see what apply at all; a public bucket is
a URL anybody can pass around, permanently.

---

## Setting up the Supabase side

1. Create the project. Copy the connection string from **Project settings →
   Database** into `BRAIN_DATABASE_URL`. Use the pooled connection string if you
   will run more than one Brain instance.
2. Create a **private** bucket (Storage → New bucket, "Public bucket" off). Put
   its name in `BRAIN_STORAGE_BUCKET`.
3. Copy the **service role** key from Project settings → API into
   `SUPABASE_SERVICE_ROLE_KEY`. Not the anon key — the anon key cannot write.
4. Start Brain. It migrates the schema before it accepts a single request, and
   the banner tells you what it actually reached:

```
  Database        postgres · db.abcdef.supabase.co/postgres
  Documents       supabase · abcdef.supabase.co · bucket brain
```

If either line is missing, Brain did not start; read the error, which names the
cause and the fix.

---

## Moving an existing Brain into the cloud

```bash
npm run migrate:cloud -- --dry-run     # always first
npm run migrate:cloud                  # do it
npm run migrate:cloud -- --verify-only # check it again, any time
```

Options: `--project <id|slug>` for one project, `--resume` (the ordinary run
already resumes; this is the same thing named), `--json` for the machine-readable
report, `--target-root <dir>` when the target store is local.

### What it does, and what it does not

It **copies**. It reads the local database and document tree, writes them into
Postgres and the bucket, checks that what arrived matches what left, and stops.

It never writes to the source. The SQLite file is opened read-only — enforced by
the driver, not by discipline in the calling code — and no local file is written
or removed at any point. **Success triggers no cleanup.** After a migration you
have two complete Brains, and archiving the first one is a decision for you to
make later, deliberately, when you have used the second one long enough to trust
it.

So an interrupted migration is not a disaster. It is a partly populated target
and an untouched source. Run it again.

### Why running it again is safe

Every row is inserted with `ON CONFLICT DO NOTHING` against its real primary
key. Every file already in the target with the same checksum is recognised
rather than re-uploaded. A file in the target with *different* bytes is never
overwritten — it is reported, because which of the two is the document is a
question for a person.

That means resumption needs no bookkeeping to be correct. The ledger tables
(`cloud_migration_runs`, `cloud_migration_tables`, `cloud_migration_files`)
record what each run did so the report can be truthful; they are not what keeps
the operation safe.

### What survives

Ids, timestamps, checksums, parent links, superseded-by links, attempt numbers,
redo reasons, failed attempts, audit verdicts and gaps, every event row, every
extracted block, every OCR provenance record, every research claim and the pass
that produced it. Nothing is renumbered. A migration that regenerated an id
would break the thing the platform exists for — that a conclusion resolves to a
passage, through a chain of identifiers that still means what it meant.

Rows are read ordered by `rowid` so the target's identity column is assigned in
the same order, because a number of queries break ties on it and a different
order would quietly reorder history.

### Verification

Counting rows as they are written proves the loop ran. It does not prove the
target holds them. So the verify pass reads the target back:

- **row counts** per table, compared with the source;
- **relationships** — eight real joins resolved in the target: a document to its
  layer, a layer to its project, an audit to its gaps, a superseded document to
  its successor, an extraction run to its document, a claim to the pass that
  produced it, a redo attempt to its parent run, an event to its project;
- **checksums** — the sha-256 of every uploaded object, recomputed from the
  bytes the target returns.

`--verify-only` runs exactly that and changes nothing.

---

## Proving it worked

The test that matters is not "did the migration report success". It is whether a
server that has never seen your laptop can do the work.

1. Migrate.
2. Start Brain somewhere else — or in a fresh directory — with the same cloud
   configuration and an **empty** local data folder.
3. Open it. You should see the project, its layers, its documents, their
   extraction state and the derived plan, and you should be able to open a
   document and get the bytes.

If that works, the state is genuinely independent of the original machine. If
the fresh server needs a file from the laptop, cloud mode is not finished, and
this repository's own end-to-end check (below) is what caught that class of
problem during development.

`/api/health` on the fresh instance answers the question directly:

```json
"persistence": {
  "database": "postgres",
  "databaseTarget": "db.abcdef.supabase.co/postgres",
  "storage": "supabase",
  "storageTarget": "abcdef.supabase.co/brain"
}
```

---

## Deploying it

The Brain deploys as **one container**. That is the smallest thing that actually
works here, and the shape comes from the code rather than from taste:

- the client calls the API with **same-origin relative paths**, and the server
  already serves the built SPA in production. One origin means no CORS, no API
  base URL to configure, and no second thing to deploy or keep in step;
- the app uses **Server-Sent Events** for audit and research progress, which
  needs a long-running process holding an open response. That rules out
  request/response serverless runtimes regardless of anything else.

```bash
docker build -t brain .
docker run -p 8080:8080 --env-file .env brain
```

The image carries `poppler-utils` and `tesseract-ocr`, so a scanned PDF is
evidence rather than a reported gap. It runs as a non-root user, and nothing
authoritative lives inside it: the database is Postgres and the documents are in
the bucket, so the container is disposable and can be replaced at any time
without losing a row or a byte.

### What the host must provide

| Need | Why |
| --- | --- |
| Long-running Node process | SSE holds responses open |
| HTTPS | the access token is sent as a Basic credential |
| Outbound to `*.supabase.co` | database and storage |
| Encrypted environment variables | the connection string and the service-role key |
| `PORT` injected | the server reads it; 8080 is the fallback |
| SIGTERM on redeploy | the shutdown path drains the queues and closes the database |

`/healthz` is the liveness probe: unauthenticated, returns `ok`, and names
nothing. Readiness — did the database answer, did the bucket answer — is
`/api/health`, which is behind the gate because it says where this Brain's data
lives.

The container runs `node --import tsx server/index.ts` rather than `npm start`,
and the difference matters: **npm does not forward SIGTERM to its child**. With
npm in between, every redeploy would abandon in-flight extraction and research
instead of draining it.

---

## Keeping it private

A Brain with a URL is a Brain anyone can find. Behind that URL are every
document, every claim, and an endpoint that accepts uploads.

So: **a cloud-backed Brain refuses to start without `BRAIN_ACCESS_TOKEN`.** Not
a warning and not a default — it does not boot. Forgetting to protect a
deployment should cost a failed deploy, which you notice, rather than an
exposure, which you may not.

```bash
BRAIN_ACCESS_TOKEN=$(openssl rand -base64 32)   # 16 chars minimum, enforced
BRAIN_ACCESS_USER=brain                          # optional, cosmetic
```

Local mode is exempt. Requiring a password for `npm run dev` against a SQLite
file would be theatre that people work around, and workarounds reach production.

The mechanism is HTTP Basic, chosen for what it does *not* require: no login
page, no session store, no cookie handling, and no change to the client. The
browser prompts once and then attaches credentials to everything the app does —
including `EventSource` streams and document downloads. A bearer token is also
accepted, so a script does not have to base64 anything.

**This is deliberately coarse and deliberately temporary.** One shared
credential; everyone who has it sees everything. It exists so the first Cloud
Brain is not public. Step 4 replaces it with real identities — per-worker
credentials, per-user authorisation, revocation — and `server/routes/access.ts`
should be deleted then, not extended.

---

## The local runtime snapshot

`data/runtime/project-state.json` is a derived mirror of what Brain believes,
written so an outside tool or a person with `cat` can read project state without
opening SQLite.

**In cloud mode it is not written at all**, and nothing reads it.

That is a decision, not an omission. The file earns its place on a single
machine, where the database is a file beside it. In cloud mode it would be
instance-local state describing shared truth: two Brains against one Postgres
would each write their own copy, each stale the moment the other committed
anything, and the first person to read one would be looking at a different
project than the database holds.

Nothing consumes it as input — no route, no service, no client code — so not
writing it removes a source of confusion rather than a capability. A cloud
instance rebuilds derived state from Postgres, which is the only copy that can
be right for everybody. `readProjectState()` returns null in cloud mode
regardless of what is on that disk, so a file left over from an earlier local
run cannot influence anything.

---

## Recovery

**The local Brain is the recovery plan.** It is untouched, complete, and still
runs: unset the cloud environment variables and `npm run dev` gives you exactly
what you had before. Keep it until you are sure.

| What went wrong | What to do |
| --- | --- |
| Migration stopped partway | Run it again. Finished work is recognised, not repeated. |
| A document is missing at source | The row exists and its bytes do not — the same inconsistency `SCAN & RECONCILE` reports. Fix it locally, then re-run. |
| A file clashes in the target | Two different documents claim one key. Nothing was overwritten. Decide which is right, remove the other, re-run. |
| Cloud Brain looks wrong | `npm run migrate:cloud -- --verify-only`. It reads the target back and says exactly which counts, relationships or checksums do not hold. |
| You want to go back | Stop the cloud server, unset `BRAIN_DATABASE_PROVIDER` and `BRAIN_STORAGE_PROVIDER`, start locally. Nothing was removed. Work done *in* the cloud since the migration stays there — migrating it back is not something this tool does. |
| Brain will not start | Read the error. It names the host, the bucket or the missing variable, and the fix. It never prints the password or the key. |

---

## Schema differences between the two backends

The Postgres schema is **generated** from the SQLite one
(`scripts/generate-pg-baseline.mjs` → `server/db/pg-migrations/001_baseline.sql`)
so the two cannot drift into describing different things. Four differences are
deliberate, and there are no others:

1. **`seq`**, an identity column on every table, standing in for SQLite's
   `rowid`. A number of queries order by it to break ties on equal timestamps;
   without it those orderings would be arbitrary rather than stable.
2. **Serialized JSON stays `text`**, not `jsonb`. `jsonb` would have the driver
   return parsed objects where every repository expects a string. Converting a
   column and its mapper together is a later, deliberate migration, not a
   side effect of this one.
3. **Timestamps stay `text`**, holding the same ISO-8601 UTC strings SQLite
   holds. A `timestamptz` would re-interpret them on the way in and out, and the
   point of this schema is that the values survive unchanged.
4. **A `nocase` collation** (nondeterministic ICU, strength level 2) so the
   three queries that compare a canonical name case-insensitively read
   identically on both backends, instead of the repositories branching on
   dialect.

Foreign keys are `DEFERRABLE INITIALLY IMMEDIATE`: checked per statement exactly
as before, so ordinary operation is unchanged and a broken reference still fails
where it was made. What it allows is a bulk loader saying `SET CONSTRAINTS ALL
DEFERRED` inside its own transaction — which the migration does, because the
schema has self-references and cycles and no table ordering satisfies them all.

The two migration chains are numbered independently and mean different things:
SQLite is at 13 (its original twelve plus `013_storage_keys.sql`), Postgres at 2
(the generated baseline plus the migration ledger). The migration tool never
copies `schema_migrations` — telling a database it had run migrations it has
never seen would be worse than useless.

---

## What this step deliberately does not do

No worker fleet, no MCP server, no distributed task claiming, no leases, no
multi-user visibility rules. The persistence layer does not prevent them:
Postgres gives transactions, row-level locking, conditional updates and
`SET CONSTRAINTS`, and worker-ownership and idempotency columns can be added by
additive migration when there is something to own.

But none of that is here, and cloud persistence being reliable is where this
step ends.
