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

On Windows the installer is `iwr https://fly.io/install.ps1 -useb | iex`, and it
has two traps:

- **It reads a variable called `$v` as the version to install.** If anything
  earlier in your session left `$v` set — a `ForEach-Object { $n,$v = $_ -split
  '=',2 }` over your `.env` will do it — the installer tries to fetch a release
  named after that value and prints it in the error. If that value was a
  secret, it is now in your scrollback: rotate it, do not just clear the
  variable. Run `Remove-Variable v -ErrorAction SilentlyContinue` first.
- **The last step needs Administrator** to create a `fly` → `flyctl` symlink,
  and cancelling the UAC prompt fails the install even though the binary
  downloaded fine. A copy does the same job without privilege:

  ```powershell
  $fb = "$HOME\.fly\bin"
  Copy-Item "$fb\flyctl.exe" "$fb\fly.exe"
  $env:Path = "$env:Path;$fb"
  fly version
  ```

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

## 2.0 If there is nothing to migrate, say so and skip to Part 3

This part copies an **existing** local Brain. A fresh `git clone` does not have
one: `data/` is gitignored, so it arrives empty and there is nothing to copy.

```bash
ls data/brain.db
```

No such file means Part 2 is a no-op — not a step you passed. Go to Part 3; your
Cloud Brain starts empty and everything you put in it from then on lives in
Supabase. If your archive is on a different machine, run Part 2 from there
later: the migration copies, never deletes, and is safe to run twice.

Record which of the two happened. "Migration verified" and "migration not
exercised" are different claims, and only one of them is true for any given
deployment.

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
fly apps create <a-name-nobody-else-has-taken>
```

The name becomes the URL — `https://<name>.fly.dev` — so it is public. Choose
accordingly.

Then put it in `fly.toml`:

```toml
app = "<the name you just created>"
```

**Not `fly launch`.** The runbook used to say that, and it is wrong for this
repository. Current flyctl rescans the project and rewrites `fly.toml` from its
own guesses, which drops `auto_stop_machines = false`, `min_machines_running =
1` and the health-check grace period. Without those, Fly suspends the machine
when traffic pauses — killing half-finished extractions and dropping open SSE
streams — and the failure looks like work randomly disappearing rather than
like a configuration change. Reserve the name, edit one line, keep the file.

Set `primary_region` to the Fly region nearest your Supabase project. `iad`
(Ashburn) is a few milliseconds from Supabase's `us-east-1` and `us-east-2`.

## 3.2 Set the secrets

Secrets go to Fly's encrypted store, never into `fly.toml`, never into git. On
macOS or Linux, feed it the `.env` you already wrote so no value ever touches a
command line or your shell history:

```bash
fly secrets import < .env
```

### On Windows PowerShell, that command cannot work

Two separate reasons, and both are worth knowing before you spend twenty
minutes on them:

1. **PowerShell has no `<` redirection.** The syntax is a bash-ism; PowerShell
   rejects it outright.
2. **Piping instead does not fix it.** `Get-Content .env | fly secrets import`
   fails with `"\ufeffBRAIN_DATABASE_PROVIDER" is not a valid secret name`.
   Windows PowerShell 5.1 prepends a byte-order mark when piping text to a
   native executable, and setting `$OutputEncoding` to a BOM-less UTF-8 does
   **not** suppress it. The file itself is clean — checking its first bytes
   proves that — so the BOM is coming from the pipe.

Pass the settings as arguments instead. The line you type contains `@kv`, a
variable reference, so your command history records that and not the values:

```powershell
$kv = @((Get-Content .env) | Where-Object { $_ -match '^[A-Z][A-Z0-9_]*=.+' })
Write-Host "sending $($kv.Count) settings"
fly secrets set --app <name> @kv
Remove-Variable kv
```

Expect `sending 7 settings`, then `Secrets are staged for the first
deployment`. "Staged" is correct before the first deploy — there is no machine
yet to restart.

## 3.3 Deploy

```bash
fly deploy --ha=false
```

`--ha=false` is not optional here. Left alone, Fly creates **two** machines for
redundancy, and two machines is currently wrong: the extraction and research
queues are per-instance and nothing coordinates them, so the second one would
run its own queue against the same database. Step 5 adds the atomic claiming
and leases that make more than one safe; Step 11 is where a second one is
actually run.

The build runs `npm run build`, so a type error fails the image rather than the
deployment. First deploy takes a few minutes; the image installs poppler and
tesseract so scanned pages are readable.

```bash
fly logs
```

You are looking for the same banner from 1.6, this time with schema migrations
already applied.

Failures land in one of two places, and the difference tells you where to look:

| Where it fails | What it means |
|---|---|
| during **Building image** | a build problem — a type error, a missing dependency. Nothing shipped |
| after **Creating 1 machine**, health checks red | the image is fine and the app will not start. Almost always a wrong secret; `fly logs` names which backend refused |

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

The same three checks in PowerShell — the anonymous ones first, because
"is it private" is the question you want answered before any other:

```powershell
$u='https://<name>.fly.dev'
foreach($p in '/healthz','/','/api/health'){
  try   { "{0,-14} {1}" -f $p, (Invoke-WebRequest "$u$p" -UseBasicParsing -TimeoutSec 20).StatusCode }
  catch { "{0,-14} {1}" -f $p, $_.Exception.Response.StatusCode.value__ }
}
```

Expect exactly `200`, `401`, `401`. `/api/health` returning 200 is a failure,
not a convenience: it names your database host and your bucket, which is why it
sits behind the gate rather than beside `/healthz`.

Then the authenticated one, reading the token out of `.env` so it is never
typed or displayed:

```powershell
$tk = (((Get-Content .env) -match '^BRAIN_ACCESS_TOKEN=') -replace '^BRAIN_ACCESS_TOKEN=','')[0]
$h  = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("brain:$tk")) }
$r  = Invoke-RestMethod 'https://<name>.fly.dev/api/health' -Headers $h
$r.persistence | ConvertTo-Json
$r.ocr | ConvertTo-Json -Depth 2
Remove-Variable tk,h
```

Worth reading the OCR block too. On a Windows laptop it usually reports *not
available*; in the container it reports `tesseract` and `pdftoppm` with their
versions, because the image installs them. That is a capability the deployed
Brain has and your local one does not.

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
Step 5's job (claiming and leases), and Step 11 is where more than one worker
is actually run.

---

# Part 4 — Upgrading a running Brain to accounts

Step 4 replaced the shared token with real accounts. This is what that costs a
Brain that is already deployed: one migration, one secret, one sign-in, and one
secret removed again.

**Nothing here deletes anything**, and the migration is additive — six new
tables and three unique indexes the cloud schema should always have had.

## 4.1 Back up first, or record what is there

Supabase → **Database → Backups**. On a paid plan, note the most recent one and
move on.

**On the free plan there are no scheduled backups**, and "back it up first" is
advice you cannot follow when there is nothing to click. Run this instead:

```bash
npm run preflight
```

It reads the cloud database, writes nothing to it, and does the two things the
backup would have been for: it records the row count of every table to a local
file with a sha-256, so the same command afterwards can be compared against it;
and it checks for the one thing that can actually make the migration fail.

**It is not a backup and does not restore anything.** Saying otherwise would be
worse than having nothing, because somebody would rely on it. What makes that
acceptable here is the shape of the change: the migration adds tables and
indexes, alters no existing column, and runs inside a transaction — so its
failure mode is *loud and complete*, not partial.

## 4.2 Know what the unique indexes will do

`004_unique_parity.sql` adds the three constraints the cloud schema was missing:
`projects.slug`, `layers (project_id, slug)` and
`documents (project_id, canonical_name)`. The local SQLite chain has always had
them; the generator that produced the cloud baseline silently dropped them.

If your cloud database contains two rows Brain has always treated as one, the
index cannot be created and **the migration fails, loudly, having changed
nothing**. That is the correct outcome: a person has to decide which of the two
is real. The error names the constraint and the duplicate key.

`npm run preflight` finds exactly this before you deploy, and names the rows.
Verified against the real thing: with two projects sharing a slug it reports

```
    two projects with the same slug: "deal-dispatch" appears 2 times
```

and the migration, run against that same database, fails with

```
    ERROR: could not create unique index "uq_projects__slug"
    DETAIL: Key (slug)=(deal-dispatch) is duplicated.
```

## 4.3 Choose the first administrator

Generate a password — do not choose one. It is temporary: it will exist in Fly's
secret store and in your terminal, and the account cannot do anything except
replace it.

```powershell
$b = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$pw = [Convert]::ToBase64String($b)
fly secrets set --app <name> BRAIN_BOOTSTRAP_ADMIN_EMAIL="you@example.com" BRAIN_BOOTSTRAP_ADMIN_PASSWORD="$pw"
Set-Clipboard $pw
Remove-Variable b,pw
```

The password goes to the clipboard, never to the screen. Paste it into your
password manager now — you need it exactly once.

## 4.4 Deploy

```bash
fly deploy --ha=false
```

The migrations run at boot, before the port opens. Then:

```bash
fly logs
```

The banner has two new lines:

```
  Sign-in         application accounts (email and password, server-side sessions)
  Outer gate      shared token in front of the site (optional outer layer; accounts are the real gate)

    Created the first Brain administrator: you@example.com
    It must choose a new password before it can do anything else.
    Remove BRAIN_BOOTSTRAP_ADMIN_PASSWORD from this deployment now.
```

If it says **NO ACCOUNTS** instead, the bootstrap did not run — the log line
below the banner says why, and it is almost always that only one of the two
variables was set.

## 4.5 Sign in and take ownership

Open the site. If `BRAIN_ACCESS_TOKEN` is still set you will get the browser's
Basic prompt first — that is the outer layer, unchanged — and then Brain's own
sign-in screen.

Sign in with the bootstrap address and password. Brain will immediately require
a new password; every other route answers `403 PASSWORD_CHANGE_REQUIRED` until
you have chosen one. Choose it, and store it.

## 4.6 Remove the bootstrap secret

```bash
fly secrets unset BRAIN_BOOTSTRAP_ADMIN_PASSWORD BRAIN_BOOTSTRAP_ADMIN_EMAIL
```

They are already inert — the bootstrap only runs into a Brain with no accounts —
but a temporary password should not be a permanent secret.

## 4.7 Optional: drop the outer layer

The shared token is no longer what protects anything. If you would rather have
one lock than two:

```bash
fly secrets unset BRAIN_ACCESS_TOKEN
```

Keep it if you would rather the sign-in page itself not be reachable from the
open internet. Both are defensible; what is not defensible is believing the
token is what makes the Brain private. It is not, and has not been since Step 4.

## 4.8 Verify from outside

```bash
APP=<name>

curl -s https://$APP.fly.dev/healthz                                        # -> ok
curl -s -o /dev/null -w '%{http_code}\n' https://$APP.fly.dev/api/health   # -> 401
curl -s -o /dev/null -w '%{http_code}\n' https://$APP.fly.dev/api/projects # -> 401
```

`/` answers 200 because the sign-in page has to be reachable — the bundle
contains no project data, only a program that asks the API, and the API is the
thing behind the gate.

Then in the browser, signed in: your projects are there, a document opens, and
the header shows who you are with a SIGN OUT button.

## 4.9 A worker credential, if you want one now

You do not need one until Step 8. If you want to prove the contract:

**Settings** are not in the UI for this — it is an API, on purpose, because Step
4 is not the fleet UI:

```bash
# as the administrator, with your session cookie
curl -s -X POST https://$APP.fly.dev/api/admin/workers \
  -H 'content-type: application/json' -b cookies.txt \
  -d '{"name":"first-worker","displayName":"First Worker"}'

curl -s -X POST https://$APP.fly.dev/api/admin/workers/<id>/credentials \
  -H 'content-type: application/json' -b cookies.txt -d '{"expiresInDays":90}'
```

The second one returns the credential **once**. It is not recoverable
afterwards, by anyone. Grant it a project and some scopes with
`POST /api/admin/projects/<id>/members`; see
[`IDENTITY.md`](IDENTITY.md) for the scope list.

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
| A worker credential leaked | Revoke that credential (`POST /api/admin/workers/<id>/credentials/<cid>/revoke`) and issue another. Immediate, and durable across a redeploy |
| Somebody's password leaked | Another administrator resets it (`POST /api/admin/users/<id>/password`). Every session that person held ends |
| Locked out of every account | Disable nothing and delete nothing: with no administrator left, an empty `users` table is what the bootstrap needs, so this requires direct database access. The refusal to disable the last administrator exists to keep this hypothetical |
| Step 4 migration failed on a unique index | Two rows the Brain has always treated as one. Nothing was changed. Decide which is real, remove the other, redeploy |
| Service-role key leaked | Rotate it in Supabase (Settings → API), then `fly secrets set` the new one. Rotating the *database password* invalidates every connection string you have written down |

Work done in the cloud after migrating stays there. Migrating back is not
something this tool does.

---

## What this deployment is not

Worth being precise, so nobody mistakes the gate for a security model:

- **One instance.** The background queues are per-instance and uncoordinated.
- **No distributed queue, atomic claiming, leases or heartbeats** — Step 5.
  **No idempotency guarantees for concurrent effects** — Step 6. **No remote
  MCP** — Step 7. **No connected worker** — Step 8. **No fleet** — Step 11.
  Those are separate steps and the separation is deliberate; see
  [`ROADMAP.md`](ROADMAP.md).
- **No second factor**, for people or for machines. Revocation is the answer to
  a leaked credential, and it is immediate.
- **The sign-in throttle is per-instance.** Fine with one; worth knowing before
  there are several.

Since Step 4 there *are* users, roles, per-worker credentials and per-principal
revocation — see [`IDENTITY.md`](IDENTITY.md), including the section on what the
model does not defend against.

---

## A note if Claude is doing this for you

Claude Code's environment blocks outbound HTTPS to `*.supabase.co` and
`api.supabase.com` by default — the gateway answers 403 to CONNECT, while raw
TCP to :443 succeeds, so it is proxy policy rather than a network fault. Claude
therefore cannot reach Supabase to provision anything, run the migration, or
verify a deployment from inside that environment, credentials or not.

This runbook is written to be *driven* by Claude and *run* by you, one command
at a time from your own machine. That split worked: every step below Part 1 was
executed on a Windows laptop with Claude reading the output and choosing the
next command. The Windows-specific corrections in 3.1, 3.2 and the installer
notes above all came out of that run, not out of anticipation.

Two rules that earned their place during it:

- **Never echo a secret to check it.** Report a length and a suffix instead —
  `109 chars, ends with :5432/postgres` is enough to catch a wrong pooler port
  and reveals nothing.
- **Rotate on exposure, do not rationalise.** A secret that reached a terminal
  scrollback or a screenshot is spent, even if nothing was listening on it yet.
  Rotating costs one command.
