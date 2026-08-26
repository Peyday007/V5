# Step 4 — implementation map

Written before any implementation was edited, from the inspection recorded below.
Kept in the repository because the decisions in it are the ones a reviewer will
want to argue with, and they should be arguable against something written down
in advance rather than reconstructed afterwards.

## 1. State found at inspection

| | |
|---|---|
| Branch | `claude/zealous-hypatia-78a2yp`, clean worktree |
| Local HEAD | `e4aa670` |
| Remote HEAD | `e4aa670` (identical) |
| Step 3 tag | `step-3-cloud-brain-foundation` → `8b378ff`, annotated, on the remote |
| `3774f22` | an ancestor of HEAD, two commits behind — **not** HEAD |
| Migrations | SQLite `001`–`013`; Postgres `001`–`002` (chains numbered independently) |
| API surface | 84 routes across 9 routers, plus `/files/*`, `/healthz`, and the SPA |
| SSE | two: `GET /api/research/:id/stream` (EventSource) and `POST …/dynamic-audit/stream` (fetch) |
| Existing auth | none — no user, session, principal, role or permission concept anywhere in `server/` |
| Only protection | `server/routes/access.ts`: one shared token, HTTP Basic, `/healthz` exempt |
| Test harness | 27 files; `api.test.ts` spawns the real server as a child process; the whole suite runs against real Postgres with `BRAIN_TEST_DATABASE_URL` |

Step 3 is closed: the tag exists, is annotated, points at a real commit, and
`docs/STEP-3-EVIDENCE.md` records both what was proven and what was not. Step 4
proceeds.

## 2. The two environment facts that decide the design

**This environment cannot reach Supabase or the deployment.** `curl` to
`*.supabase.co`, `api.supabase.com` and `northline-brain.fly.dev` all fail with
`CONNECT tunnel failed, response 403`. Local Postgres 16 *is* available, so
every production-path test can run against a real database — but live
Supabase and hosted verification must be driven from the operator's machine, as
Step 3 was.

**`EventSource` cannot send an `Authorization` header.** `client/src/components/
ResearchPanel.tsx:213` opens `new EventSource('/api/research/…/stream')`. The
browser decides what that request carries, and it carries cookies, not headers.

## 3. Human authentication: Brain-owned sessions, not Supabase Auth

The brief prefers Supabase Auth and requires a justification from real
constraints for anything else. Here is the justification.

1. **SSE would need a cookie anyway.** Supabase Auth hands the browser a JWT
   that application code attaches to requests. `EventSource` has no such hook,
   and neither does a `<a href>` to `/files/…`. Both would have to fall back to
   a Brain-issued cookie — so the cookie session gets built either way, and the
   only question is whether a *second* identity system sits in front of it.
2. **One origin, so there is nothing to federate.** The server serves the built
   SPA (`server/index.ts` `express.static(CLIENT_DIST)`) and the client calls
   relative paths (`client/src/lib/api.ts`). There is no cross-origin token
   exchange for Supabase Auth to simplify.
3. **Every auth test would become a mock.** This environment cannot reach
   Supabase, and new Supabase projects sign JWTs with asymmetric keys published
   over JWKS — verification is a network call. The brief says mocks cannot
   substitute for live-provider evidence; choosing Supabase Auth would make
   *authentication itself* the one thing with no real test. Brain-owned
   sessions are verified against real Postgres, in-process, every run.
4. **Revocation must be immediate.** The brief requires that removing
   membership or revoking a scope takes effect without a new login. A stateless
   JWT cannot do that without a server-side check on every request — which is
   the session lookup again.
5. **No new dependency.** `scrypt`, `randomBytes` and `timingSafeEqual` are in
   `node:crypto`. The repository has deliberately hand-rolled comparable
   things (SQL dialect translation, the storage REST client) rather than adding
   packages.

Supabase remains the database and the store. It is not the authenticator.

## 4. Principal model

Two principal types now; no third invented speculatively.

- `human_user` — authenticates with email + password, receives an HttpOnly
  session cookie.
- `worker` — authenticates with a Brain-issued bearer credential.

A request resolves to a `Principal` carrying: type, id, display name, enabled
state, global-admin flag, the credential/session id it authenticated with, the
authentication method, its project memberships with roles, its scopes, and the
request correlation id. Client-supplied identifiers never contribute to it.

## 5. Schema (SQLite `014_identity.sql`, Postgres `003_identity.sql`)

| Table | Holds |
|---|---|
| `users` | human principals: email (unique, case-insensitive), display name, password verifier, `is_brain_admin`, disabled_at, must_change_password, timestamps |
| `user_sessions` | one row per live session: token verifier, user id, issued/expires/revoked, last seen, user agent hash |
| `workers` | worker principals: unique name, display name, type, description, status, created_by, disabled_at |
| `worker_credentials` | many per worker: prefix, verifier, issued/expires/revoked, last used, issued_by, rotated_from |
| `project_memberships` | (principal_type, principal_id, project_id) → role, scopes, granted_by, revoked_at |
| `identity_events` | append-only identity audit, not project-scoped |

`project_events` is *also* written for membership changes, because a project's
own history should show who was given access to it. `identity_events` is the
authoritative identity log; it is never a secret store.

## 6. Roles and scopes

Human roles, per project: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`. Plus a global
`is_brain_admin` flag for Brain-wide administration.

Worker scopes, granted per project: `project:read`, `documents:read`,
`research:read`, `research:write`, `claims:write`, `sources:write`,
`contradictions:write`, `checkpoints:write`, `research:propose`,
`blockers:report`, `work:complete`. No queue-claiming or MCP scope is defined —
those are Steps 5 and 7 and would be inactive speculative architecture here.

## 7. Enforcement

One policy module, one authentication middleware, and — this is the part that
makes it tractable across 84 routes — **the existing resolver helpers become
the authorization choke point.** `requireProject`, `requireLayer`, `requireRun`,
`requireDocument`, `requireLayerOfProject` in `server/routes/helpers.ts` already
resolve every addressed resource to its project. Each will consult the
request's principal, resolved from `AsyncLocalStorage` (the same mechanism the
transaction layer already uses), and refuse with the *same* 404 an unknown id
produces, so a resource in another project is indistinguishable from one that
does not exist.

Deny by default: `/api` requires an authenticated principal before any router
runs. The exempt set is `/healthz` and the login endpoint, and nothing else.
`/files/*` resolves its slug to a project and applies the same check. SSE is
authorized before a single header is written. Fail closed: an authentication or
database error is a refusal, never a downgrade.

## 8. The Step 3 access gate

Demoted, not deleted-and-forgotten: it becomes an optional outer layer, off by
default, documented as defence in depth rather than as security. The boot
invariant it carried — *a cloud-backed Brain must not be reachable
unprotected* — is preserved and strengthened: the Brain now refuses to boot
cloud-backed with no way to authenticate anyone, and refuses outright to run
any development authentication path in production.

## 9. What Step 4 will not touch

No distributed claiming, leases, heartbeats, reclaim, retry policy,
cross-worker idempotency, remote MCP, Claude Max connection, scheduling, fleet
capacity, usage observation, fleet UI, multi-worker execution or automatic
assignment. Those are Steps 5–11 and `docs/ROADMAP.md` says which owns which.
