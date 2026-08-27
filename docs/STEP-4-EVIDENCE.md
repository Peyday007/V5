# Step 4 — evidence

What was built, what was actually verified and by what means, and — the part
that decides the verdict — what could not be verified from where this was built.

**Date** 2026-08-26 · **Branch** `claude/zealous-hypatia-78a2yp` ·
**Starting HEAD** `e4aa670`

---

## Verdict

**Step 4 is code-complete, locally verified, and its hosted verification is
built and automated. It is not closed until that verification has run green
against the deployment.**

Everything that can be proven without the operator's Supabase project and Fly
deployment has been proven, against real databases and a real server over a real
socket. This environment still cannot reach the deployment — `curl` to
`*.supabase.co`, `api.supabase.com` and `northline-brain.fly.dev` all fail with
`CONNECT tunnel failed, response 403` — and the first response to that was to
write section 15 of the brief up as an operator task with a list of `curl`
commands beside it.

That was the wrong answer, and it was wrong for a reason worth recording: a
verification a person performs by hand is performed once, is reported back as a
sentence rather than as evidence, and is never performed again. The production
migration and the first hosted sign-in were done that way and are recorded below
as such. Everything else is now `scripts/verify-hosted.ts`, which runs inside
the deployment on every deploy, asserts forty-one things about it from outside,
and fails the run when any of them is wrong.

The operator's remaining part is pressing one button.

No tag was created. A tag on work whose live half has not run would be the
"complete except…" this project's own rules refuse.

---

## Step 3 carry-forward register, and its disposition

Read from `docs/STEP-3-EVIDENCE.md`, `docs/CLOUD.md`, `docs/DEPLOY.md` and the
header of `server/routes/access.ts`.

| # | Item, as Step 3 recorded it | Assigned to | Disposition |
|---|---|---|---|
| CF-1 | "One shared credential. Everyone holding the token sees everything. No users, no roles, no revocation of one person without changing it for all." | **Step 4** | **Closed.** Users, four project roles, eleven worker scopes, per-principal revocation that takes effect on the next request. Tests: `identity.test.ts`, `authorization.test.ts` |
| CF-2 | "No worker identities." | **Step 4** | **Closed.** `workers` + `worker_credentials`, issue / rotate / expire / revoke, disable-the-worker revokes its credentials |
| CF-3 | "`server/routes/access.ts` should be deleted when Step 4 lands, not extended." | **Step 4** | **Closed differently, and the difference is deliberate.** It is reduced to an optional outer layer, off by default, explicitly documented as not the security model. Deleting it outright would have silently opened every installation relying on it at the moment they upgraded. The brief permits exactly this ("removed **or** reduced to an explicitly documented additional outer layer") |
| CF-4 | "`/api/health` names the database host and the bucket, so it sits behind the gate." | **Step 4** | **Closed.** Now sanitized per principal: an administrator gets the full readiness report, everybody else gets schema version, providers and OCR. Test: *sees a health report with nothing about the installation in it* |
| CF-5 | "Migration of a real archive was never exercised — there was none on the deployment machine." | **no step; operator task** | **Still open, and not Step 4's.** The tool is built and tested; it needs an archive to run against. Recorded here so it is not lost |
| CF-6 | "More than one instance was not run and must not be." | **Steps 5 and 11** | Correctly assigned elsewhere. Not absorbed into Step 4 |
| CF-7 | "The real Antigravity worker inside the container is UNVERIFIED." | **Step 8** | Correctly assigned elsewhere |
| CF-8 | "Sustained operation — this is hours old." | no step | Not a deliverable |
| CF-9 | Security event: the access token was echoed by Fly's Windows installer and rotated. | **closed in Step 3** | Rotated then; `docs/DEPLOY.md` warns before the step that causes it |

Nothing from Steps 5–11 was pulled into Step 4 to make this table look
complete, and nothing that belongs to Step 4 was pushed out of it.

---

## A defect found by inspection, and fixed

Required by the brief only if it "directly prevents secure identity or
authorization". It does.

**The Postgres schema was enforcing three fewer uniqueness constraints than the
SQLite schema**, and had been since the cloud chain was created. Measured, not
inferred: a database built from `001_baseline.sql` carried a primary key on
`projects`, `layers` and `documents` and nothing else, while the SQLite chain
those were generated from declares

```
projects   slug                           UNIQUE
layers     (project_id, slug)             UNIQUE
documents  (project_id, canonical_name)   UNIQUE
```

The generator walked columns and foreign keys and never emitted uniqueness, so
all three were dropped in translation. This is a fifth difference between the
chains, and an undocumented one, which this project's own rules say must not
exist.

It is authorization-relevant because `/files/<slug>/documents/…` resolves a
project **by slug**, and Step 4 makes that resolution an authorization decision.
Two projects sharing a slug in the cloud database would mean a member of one
could be handed the other's documents, decided by whichever row the planner
reached first.

Fixed three ways: `pg-migrations/004_unique_parity.sql` repairs existing
deployments; `scripts/generate-pg-baseline.mjs` now emits uniqueness so no future
table inherits the gap; and `persistence.test.ts` compares the *constraint set*
across backends rather than the table names, which is what would have caught it.

---

## What was verified, and how

### The verification matrix

| # | Item | Result |
|---|---|---|
| 1 | Existing SQLite regression suite | **EXECUTED — PASS** · 571 passed, 25 skipped (Postgres-only) |
| 2 | Existing PostgreSQL regression suite | **EXECUTED — PASS** · 587 passed, 0 skipped, real Postgres 16 |
| 3 | New identity repository tests | **EXECUTED — PASS** · `identity.test.ts`, 31 |
| 4 | Human authentication tests | **EXECUTED — PASS** · `authorization.test.ts`, `identity.test.ts` |
| 5 | Worker authentication tests | **EXECUTED — PASS** · `authorization.test.ts` |
| 6 | Credential lifecycle tests | **EXECUTED — PASS** · issue, rotate, expire, revoke, worker-disable |
| 7 | Role / scope policy tests | **EXECUTED — PASS** · `identity.test.ts` |
| 8 | Project isolation tests | **EXECUTED — PASS** · `authorization.test.ts` |
| 9 | Direct-object authorization tests | **EXECUTED — PASS** · layer, audit, orchestration, chunk, import job by guessed id |
| 10 | SSE authorization tests | **EXECUTED — PASS** · refused before any stream header is written |
| 11 | File authorization tests | **EXECUTED — PASS** · `/files` and `/api/documents/:id/file`, anonymous and cross-project |
| 12 | Administrative-operation tests | **EXECUTED — PASS** · including the last-administrator refusal |
| 13 | Audit-attribution tests | **EXECUTED — PASS** · `identity.test.ts`, plus a no-credentials-in-the-audit check over HTTP |
| 14 | Concurrency / integrity tests | **EXECUTED — PASS** · concurrent grants, rotation, disable-mid-session |
| 15 | No-fallback tests | **EXECUTED — PASS** · database closed under a live guard → 503, never 200 |
| 16 | Secret-leak scan | **EXECUTED — PASS** · see below |
| 17 | Typecheck | **EXECUTED — PASS** · `tsc --noEmit` clean |
| 18 | Production build | **EXECUTED — PASS** · `npm run build` |
| 19 | Local production boot | **EXECUTED — PASS** · see below |
| 20 | Actual Cloud Brain migration | **EXECUTED — PASS** · deploy run 6, boot banner: `Driver postgres`, `Schema version 4`, `Migrations up to date (4 already applied)` against `aws-0-us-east-2.pooler.supabase.com/postgres` |
| 21 | Hosted login / authentication test | **EXECUTED — PASS** · the operator signed in to the live Brain as the bootstrap administrator. Machine-verified from the next deploy onwards |
| 22 | Hosted worker-authentication test | **AUTOMATED — pending its first run** · `scripts/verify-hosted.ts`, eleven assertions, in the deploy workflow |
| 23 | Hosted authorization-denial test | **AUTOMATED — pending its first run** · same script, nineteen assertions |
| 24 | Hosted restart / redeploy persistence | **AUTOMATED — pending its first run** · the workflow removes the bootstrap secrets, which restarts the machine, and re-runs all forty-one assertions against what comes back |
| 25 | Existing authorized research/document workflow smoke test | **EXECUTED — PASS** · the whole 24-test API suite now runs through a real session cookie |

Totals: **596 tests, 31 files, green on both backends** — 571 executed on SQLite, the
25 Postgres-only ones on real Postgres 16. 79 of those are new, and 41 further
assertions run against the live deployment on every deploy.

### Local production boot

`NODE_ENV=production`, built client, bootstrap variables set:

```
  Sign-in         application accounts (email and password, server-side sessions)
  Outer gate      none (accounts are the gate; set BRAIN_ACCESS_TOKEN to add an outer layer)
  Migrations      applied 14 (… 14 identity)

    Created the first Brain administrator: owner@example.invalid
    It must choose a new password before it can do anything else.
    Remove BRAIN_BOOTSTRAP_ADMIN_PASSWORD from this deployment now.
```

Anonymous: `/` → 200 (the sign-in page must be reachable), `/healthz` → 200,
`/api/health` → 401, `/api/projects` → 401. Signed in with the bootstrap
password: every route → `403 PASSWORD_CHANGE_REQUIRED`; after choosing a
password → 200. The log contains neither password.

### Secret-leak scan

- No `.env`, key or credential file is tracked. `.env.example` holds names only.
- No `sb_secret_…`, no populated connection string, no JWT-shaped value anywhere
  in tracked source. The four regex hits are documentation placeholders
  (`user:password`, `[YOUR-PASSWORD]`, `<password>`) and one error message.
- No live worker credential (`brnw_<hex>.<secret>`) in any tracked file.
- The built client bundle contains zero occurrences of `sb_secret`,
  `SUPABASE_SERVICE_ROLE`, `BRAIN_DATABASE_URL`, `password_verifier`,
  `token_verifier` or `brnw_`, and no server module.
- Three tests assert the negative directly: no credential in the database dump,
  none in the identity audit, none in anything the server printed.

---

## A second defect, found by the harness on its first run

`GET /api/auth/session` is the client's first call on every page load. Its whole
job is to answer "am I already signed in?", and it was in the same allowlist as
`/api/auth/login` — the set of paths the guard lets through **without
authenticating**.

So authentication never ran for it. It answered `authenticated: false` to a
perfectly valid session cookie, every time, and `App.tsx` does exactly what that
answer tells it to: shows the sign-in form. **A signed-in person was thrown back
to the sign-in card on every refresh.**

Nothing in 587 tests noticed, and the reason is worth stating: every other test
authenticates by sending a cookie to a route that *requires* one, and gets a 200.
This is the only route in the application that must accept both answers, so it is
the only one where "the guard skipped me entirely" and "the guard authenticated
me" look the same from the outside — unless you check the body, which nothing
did.

Two kinds of exemption were being spelled the same way, and now are not:

- `UNAUTHENTICATED_PATHS` — `/api/auth/login`. Genuinely no credential: it is how
  one is obtained, and it must work while the browser still carries a stale
  cookie.
- `OPTIONAL_AUTH_PATHS` — `/api/auth/session`. Authentication **runs**; a failure
  is not a refusal. It is also not audited, because a browser holding an expired
  cookie asks this on every page load and an audit trail of that hides the
  denials worth reading.

Four regression tests: a valid session is recognised, no credential answers
without refusing, a stale credential answers without refusing, and a worker
credential is never reported as a signed-in person.

This is the argument for the harness in one paragraph. It found this on its
first execution, against a locally-running production build, before it had ever
been pointed at the deployment.

---

## The bug the tests caught

Worth recording, because it is the argument for having written them.

`providersRouter` is mounted at the root of `/api` (its routes carry their own
`/providers` prefix). A router-level `providersRouter.use(brainAdminOnly())`
therefore ran for **every API request**, and a Brain-administrator guard on every
API request refuses every ordinary member of every project. Every administrator
test passed; every non-administrator test failed with a 404. Scoped to
`/providers/connections`, where it belongs.

A unit test of the policy would have passed throughout.

---

## How the hosted half is verified

`scripts/verify-hosted.ts` — 41 assertions against the live Brain, over the
internet, run by the deploy workflow and re-run after a restart.

It runs **inside the deployed container**, which is the only design that works.
A hosted authorization test needs two capabilities at once: to mint principals —
a member, a non-member, a worker with a credential, an expired credential, a
revoked one — and to arrive at the public URL as an outsider. Anything running
on a laptop or a CI runner has the second and not the first, and obtains the
first only by being handed an administrator's password, which puts a live
credential into a second system for the rest of time. Inside the container both
are free: the database is already open, the public URL is one HTTPS call away,
the fixtures exist only for the length of the run, and every assertion is still
made from outside, through Fly's edge, exactly as an attacker would arrive.

What it asserts, in five groups:

- **Anonymous** — liveness is open; the project list, the readiness report, a
  project by id and the administration API are all 401; the sign-in page is
  reachable; and no refusal names the database host, the bucket or a variable.
- **Signing in** — the wrong password and an unknown address are refused
  *identically*, so neither enumerates accounts; the right one is accepted; the
  cookie is HttpOnly, Secure and SameSite=Lax; and it identifies the account on
  the next request.
- **A member's reach** — sees its own project and not the other one, is refused
  the other by id with **404 rather than 403**, and that 404 is byte-identical
  to the one for a project that does not exist; documents under it are refused
  too; the administration API is refused; a cookie-authenticated mutation from
  another origin is refused.
- **Workers** — a valid credential authenticates and sees only what it was
  granted; a read-scoped worker may not write; a real prefix with the wrong
  secret, an invented credential, a malformed one and an expired one are all
  401; a credential revoked mid-run is refused on the very next request; and a
  worker credential never makes the caller a person.
- **Taking access away** — disabling a worker refuses its credential
  immediately, signing out ends that session immediately, and a disabled account
  cannot sign in.

It deletes nothing. The fixtures are disabled rather than removed, because
`identity_events` records what happened to them and a cascade that erased the
subject of an audit row is what invariant 5 forbids. It touches no real
project's rows: the project it must be *refused* is the real one, and the only
thing it ever does with that is ask for it and be told it does not exist.

No credential is printed. Every secret it uses is generated at the start of the
run and invalidated at the end.

The verdict is read from a `HOSTED-VERIFICATION: PASS 41/41` line rather than
from an exit code, because an exit code here would have to survive an SSH
session, a remote shell and a CLI, and that is a fragile thing to hang a
security verdict on.

Proven before it was shipped: 41/41 against a locally-running production build,
three times in a row, including twice over fixtures a previous run had disabled —
the re-run case the workflow depends on.

---

## What Step 4 does not claim

- **Nothing is verified on the live Brain.** Items 20–24 above.
- **The login throttle is per-instance and in-memory.** Correct with one
  instance, which is deliberate until Step 5; with several, each brakes
  separately. Said out loud in `IDENTITY.md` rather than left to be discovered.
- **No second factor**, for people or machines. Revocation is the answer to a
  leaked credential.
- **A Brain administrator can reach every project.** By design, audited, not
  prevented.
- **Direct database access defeats all of it.** Not recoverable secrets, but an
  inserted administrator row. Protecting the database is Supabase's job.

---

## Steps 5–11 were not started

No distributed claiming, leases, heartbeats, reclaim, retry policy, cross-worker
idempotency, remote MCP, Claude Max connection, scheduling, fleet capacity,
usage observation, fleet UI, multi-worker execution or automatic assignment.

No placeholder table was added for any of them. The scope list in
`WORKER_SCOPES` contains no queue-claim scope and no MCP scope, because a scope
that grants nothing is worse than an absent one: code starts checking for it and
the check reads as protection.

---

## What has to happen before this step can be tagged

One deploy. The workflow now migrates, boots, verifies the live Brain, removes
the bootstrap secrets, waits for the restart, and verifies it again — and fails
the run if either verification does not pass.

When that run is green, rows 22, 23 and 24 above are filled in from its log and
`step-4-identities-access-control` can be created. Not before: a tag on work
whose live half has not run would be the "complete except…" this project's own
rules refuse.
