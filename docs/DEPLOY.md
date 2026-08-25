# Deploying the first Cloud Brain

A runbook, written to be followed once, in order, from a laptop that has the
repository checked out. It ends with a private Brain on the internet holding
your real research, and a local Brain that is still complete and still yours.

Roughly an hour, most of it waiting for a database to provision.

**Nothing here deletes anything.** The migration copies; the local Brain is
untouched and stays the recoverable original until you archive it yourself,
deliberately, long after you have stopped needing it.

---

## Before you start

```bash
git checkout claude/zealous-hypatia-78a2yp
npm install
npm test          # 474 pass, 24 skipped — the skips are the Postgres-only tests
npm run build
```

If that is not green, stop and fix it. Deploying a red tree is how you end up
debugging two things at once.

You will also need:

- a **Supabase** account (the free tier is enough to start);
- a **Fly.io** account with a payment method (this costs roughly $2–5/month; Fly
  requires a card even inside the free allowance);
- the **Fly CLI**: `curl -L https://fly.io/install.sh | sh`, then `fly auth login`.

---

# Part 1 — Supabase

## 1.1 Create the project

<https://supabase.com/dashboard> → **New project**.

- **Name**: `brain` (anything; it only appears in the dashboard)
- **Database Password**: click **Generate a password** and *save it in your
  password manager now*. Supabase shows it once. You can reset it later, but
  every connection string you have written down stops working when you do.
- **Region**: pick the one nearest you, and remember which — you will put Fly in
  the same place so the database is a few milliseconds away rather than an
  ocean.

Provisioning takes a couple of minutes.

## 1.2 Get the connection string — the *Session pooler* one

**Project Settings → Database → Connection string**, and this is the step where
it is easiest to pick the wrong thing. Supabase offers three:

| Tab | Port | Use it? |
|---|---|---|
| **Session pooler** | 5432 | **Yes.** This is the one. |
| Direct connection | 5432 | No — IPv6-only on new projects, and Fly's egress may not have a route. Brain will tell you (`ENETUNREACH`), but you would rather not find out at deploy time. |
| Transaction pooler | 6543 | No — it does not keep session state, and Brain's migrations use `SET CONSTRAINTS ALL DEFERRED` inside a transaction. |

Copy the **Session pooler** string. It looks like:

```
postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
```

Replace `[YOUR-PASSWORD]` with the password from 1.1. If the password contains
`@ : / ? #` or a space, percent-encode it (`@` → `%40`, and so on) or the URL
parses wrong in a way that produces a baffling error.

### One thing to delete

If the string ends with `?sslmode=require`, **remove that parameter.**

Not a shortcut — the opposite. The driver treats `sslmode=require` as *full
chain verification*, and it then rejects a certificate signed by a CA that Node
does not ship, which is what several managed databases use. With the parameter
gone, Brain applies its own TLS: the connection is still encrypted, it just does
not demand a chain it cannot see.

Never replace it with `sslmode=disable`. That would send the password in clear,
and Brain refuses to do it silently — it would connect, but you would have
turned off the thing that matters.

## 1.3 Create the private bucket

**Storage → New bucket**.

- **Name**: `brain`
- **Public bucket**: **OFF**. This is the setting that matters most on this
  page. Every document read goes through the Brain server, which is what lets
  the project's own rules apply at all; a public bucket is a URL that anyone
  who ever sees it can keep, permanently, for any document in it.

Leave the rest at defaults.

## 1.4 Copy the API values

**Project Settings → API**:

- **Project URL** → `SUPABASE_URL`. Looks like
  `https://abcdefghijklmnop.supabase.co`.
- **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY`. It is hidden behind a
  *Reveal* button and marked "secret", which is accurate: it bypasses every row
  policy in the project.

**Not the `anon` key.** The anon key cannot write to a private bucket, so
Brain's boot check fails with a permissions error that reads like a bug in
Brain rather than like the wrong key.

The service-role key is a server-side credential. It belongs in Fly's secret
store and in your gitignored `.env`, and nowhere else — never in the client,
never in a commit, never pasted into a chat.

## 1.5 Write your `.env`

```bash
cp .env.example .env
```

Fill it in:

```bash
BRAIN_DATABASE_PROVIDER=postgres
BRAIN_DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

BRAIN_STORAGE_PROVIDER=supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
BRAIN_STORAGE_BUCKET=brain

BRAIN_ACCESS_TOKEN=<generate below>
```

Generate the access token — do not choose one:

```bash
openssl rand -base64 32
```

`.env` is gitignored. `npm run dev`, `npm start` and `npm run migrate:cloud`
load it automatically, so no secret ever needs to appear on a command line or in
your shell history.

## 1.6 Prove it before you migrate anything

```bash
npm start
```

Read the banner. It should say:

```
  Database        postgres · aws-0-us-east-1.pooler.supabase.com/postgres
  Documents       supabase · abcdefghijklmnop.supabase.co · bucket brain
  Access          private · shared token (temporary; Step 4 replaces this with identities)
```

Those lines are not printed from your configuration — Brain ran a real query and
a real bucket listing first. If it did not start, the error names the cause and
the fix, and never prints the password or the key.

Common ones:

| It says | It means |
|---|---|
| certificate / self-signed | the `sslmode=require` from 1.2 — delete it |
| `ENETUNREACH` | direct connection instead of the session pooler |
| authentication failed | password wrong, or an unencoded special character |
| bucket "brain" does not exist | name mismatch, or the bucket is in a different project |
| rejected Brain's credentials | the anon key instead of `service_role` |
| will not start unprotected | `BRAIN_ACCESS_TOKEN` missing |

Stop the server once the banner is right. **Do not use it yet** — it is
connected to an empty cloud database, and the next part fills it.

---

# Part 2 — Migrate your real Brain

## 2.1 Back it up first

```bash
cp -r data data-backup-$(date +%Y%m%d)
shasum -a 256 data/brain.db
du -sh data
```

Keep those numbers. You will compare them afterwards.

The migration opens the source read-only and never writes to it, but a backup
costs one command and removes the question entirely.

## 2.2 Dry run — always

```bash
npm run migrate:cloud -- --dry-run
```

It writes nothing. Read what it says it would move: the row count per table, the
number of documents, and anything under **Problems**.

If a document is listed as *missing at source*, its database row exists but its
bytes do not. That is a pre-existing inconsistency, not something the migration
caused — run **SCAN & RECONCILE** in the app and fix it locally first.
Migrating around it just moves the problem.

## 2.3 Do it

```bash
npm run migrate:cloud
```

It copies rows, uploads documents, and then reads the target back to check: row
counts per table, eight real relationships resolved *in the target*, and the
sha-256 of every uploaded object recomputed from the bytes the bucket returns.

Safe to interrupt. Safe to run twice — every row is inserted with `ON CONFLICT
DO NOTHING` and every file already present with the same checksum is recognised
rather than re-uploaded. If it stops, run it again; it continues rather than
restarting.

## 2.4 Check the source is untouched

```bash
shasum -a 256 data/brain.db      # same as 2.1
npm run migrate:cloud -- --verify-only
```

The hash must match. (`brain.db-wal` and `brain.db-shm` may appear — those are
SQLite's own scratch, created by any connection including a read-only one, and
hold none of your data.)

---

# Part 3 — Fly.io

## 3.1 Reserve the app

```bash
fly launch --no-deploy
```

Answer:

- **copy existing configuration?** → **Yes** (use the committed `fly.toml`)
- **tweak settings?** → **No**
- **Postgres / Redis?** → **No** to both. Supabase is the database.

This writes the real app name and region into `fly.toml`. Set the region to
match your Supabase region if it did not ask.

## 3.2 Set the secrets

Secrets go to Fly's encrypted store, never into `fly.toml`, never into git:

```bash
fly secrets set \
  BRAIN_DATABASE_PROVIDER=postgres \
  BRAIN_DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  BRAIN_STORAGE_PROVIDER=supabase \
  SUPABASE_URL="https://<ref>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
  BRAIN_STORAGE_BUCKET=brain \
  BRAIN_ACCESS_TOKEN="<the same token as .env>"
```

To keep them out of shell history, either prefix each command with a space (if
your shell honours `HISTCONTROL=ignorespace`) or read them from the `.env` you
already wrote:

```bash
fly secrets import < .env
```

## 3.3 Deploy

```bash
fly deploy
```

The build runs `npm run build`, so a type error fails the image rather than the
deployment. First deploy takes a few minutes; the image installs poppler and
tesseract so scanned pages are readable.

```bash
fly logs
```

You are looking for the same banner from 1.6, this time with schema migrations
already applied.

## 3.4 Verify the deployment

```bash
fly status
fly open                    # browser will prompt for the access token
```

At the prompt: **username** anything (`brain`), **password** your
`BRAIN_ACCESS_TOKEN`.

Then check it from outside:

```bash
APP=$(fly status --json | jq -r .Name)

# Liveness is open — this is what Fly's health check uses.
curl -s https://$APP.fly.dev/healthz                       # -> ok

# Everything else is not.
curl -s -o /dev/null -w '%{http_code}\n' https://$APP.fly.dev/api/health   # -> 401
curl -s -o /dev/null -w '%{http_code}\n' https://$APP.fly.dev/             # -> 401

# With the token, it answers — and says which backends it actually reached.
curl -s -u "brain:$BRAIN_ACCESS_TOKEN" https://$APP.fly.dev/api/health | jq .persistence
```

That last one should report `"database": "postgres"` and `"storage":
"supabase"`, with the host and bucket named and no credential anywhere in the
response.

## 3.5 Prove the state is really independent of your laptop

This is the test that matters. Everything above can pass while the app still
secretly depends on local files.

1. Open the deployed Brain. Confirm your projects, layers and documents are
   there, and **open a document** — the bytes come from the bucket, through the
   server.
2. Import a new document through the deployed app.
3. Restart it: `fly apps restart $APP`. Wait for it to come back.
4. Confirm the new document is still there and still opens.

A Fly machine gets a fresh filesystem on restart. If the document survives, it
was never on that disk.

For the strongest version, run a second machine briefly
(`fly scale count 2`, check, then `fly scale count 1`) and confirm it sees
everything the first one wrote. Do not leave two running: the extraction and
research queues are per-instance and nothing coordinates them yet — that is
Step 4's job.

---

## Rollback

**Your local Brain is the rollback.** It is untouched, complete, and still runs:

```bash
mv .env .env.cloud        # stop pointing at the cloud
npm run dev
```

That is the whole procedure. Nothing was deleted.

| Situation | Do this |
|---|---|
| Deploy broke it | `fly releases` then `fly deploy --image <previous image>` |
| Cloud data looks wrong | `npm run migrate:cloud -- --verify-only` — it names which counts, relationships or checksums do not hold |
| Migration stopped partway | Run it again. Finished work is recognised, not repeated |
| A file clashed in the bucket | Two documents claim one key. Nothing was overwritten. Decide which is right, remove the other, re-run |
| Token leaked | `fly secrets set BRAIN_ACCESS_TOKEN="$(openssl rand -base64 32)"` — it redeploys automatically |
| Service-role key leaked | Rotate it in Supabase (Settings → API), then `fly secrets set` the new one. Rotating the *database password* invalidates every connection string you have written down |

Work done in the cloud after migrating stays there. Migrating back is not
something this tool does.

---

## What this deployment is not

Worth being precise, so nobody mistakes the gate for a security model:

- **One shared credential.** Everyone who has the token sees everything. There
  are no users, no roles, and no way to revoke one person's access without
  changing it for all of them.
- **One instance.** The background queues are per-instance and uncoordinated.
- **No worker identities, no leases, no MCP.** Deliberately — that is Step 4.

The gate exists so the first Cloud Brain is not public while the real
authorisation system is built. When Step 4 lands,
`server/routes/access.ts` should be deleted rather than extended.

---

## A note if Claude is doing this for you

Claude Code's environment blocks outbound HTTPS to `*.supabase.co` by default
(the gateway answers 403 to CONNECT). Credentials alone are not enough — that
egress has to be opened on the environment before Claude can reach Supabase to
verify anything or run the migration. Until then this runbook is meant for you
to run from your own machine, where there is no such restriction.
