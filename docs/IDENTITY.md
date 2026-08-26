# Identity and access control

Who may reach this Brain, what they may do inside it, and how that is decided
and recorded. Step 4 built all of it; before Step 4 there was one shared
password in front of the whole site and nothing else.

The rule that shapes every decision below: **authorization is what deterministic
server code does when an operation executes.** A hidden button, an omitted tool
schema, a route guard in the browser and an instruction in a prompt are all
things an attacker simply does not run. None of them is a security boundary and
none of them appears in this document as one.

---

## 1. Two kinds of principal

| | `human_user` | `worker` |
|---|---|---|
| Proves itself with | email + password → session cookie | `Authorization: Bearer brnw_…` |
| Credential lives | server-side session row; cookie holds a random secret | issued once, held by the worker |
| Can administer the Brain | if `is_brain_admin` | **never** |
| Authority in a project | a role | a set of scopes |

They are deliberately not the same kind of row. A worker represented as a user
with a password would mean a machine could sign in to the interface and a person
could be handed a bearer token, and both are mistakes that look harmless right
up until somebody makes them.

**A Brain worker identity is not a Claude account.** Claude authenticates to
Anthropic on its own; the Brain issues it a *Brain* credential and never learns
the other one. No Claude password, browser session, subscription cookie or
provider OAuth token is stored anywhere in this system, and none should ever be
— it would make the Brain a store of somebody's subscription access, which is a
liability it has no reason to accept.

---

## 2. Why sessions, and not Supabase Auth

Supabase remains the database and the document store. It is not the
authenticator, and that was a decision with reasons rather than a default:

1. **Server-sent events and document links decide for themselves what to send.**
   `new EventSource('/api/research/…/stream')` and `<a href="/files/…">` carry
   what the browser attaches, and what the browser attaches is cookies.
   Application code cannot put a header on either. A JWT scheme would have left
   both unauthenticated or forced a credential into a URL — where it lands in
   logs, in history and in `Referer`.
2. **One origin.** The server serves the built client, and the client calls
   relative paths. There is no cross-origin token exchange for a hosted
   authenticator to simplify.
3. **Revocation has to be immediate.** Removing somebody from a project, or
   revoking a scope, must take effect on the next request rather than at the
   next sign-in. A stateless token cannot do that without a server-side check
   per request — which is the session lookup, arrived at the long way round.
4. **Testability is a security property.** Authentication that can only be
   tested against a mock is authentication nobody has actually tested. Every
   claim in this document is checked against a real database and, for the HTTP
   ones, a real server over a real socket.

No new dependency was added: `scrypt`, `randomBytes` and `timingSafeEqual` come
from `node:crypto`.

---

## 3. What is stored, and what is not

| Table | Holds | Never holds |
|---|---|---|
| `users` | email, display name, scrypt verifier, admin flag, disabled-at | the password |
| `user_sessions` | sha-256 of the cookie's secret, issue/expiry/revocation | the cookie |
| `workers` | name, type, status, who created it | any provider credential |
| `worker_credentials` | prefix, sha-256 verifier, issue/expiry/revocation, last use | the credential |
| `project_memberships` | (project, principal) → role or scopes | — |
| `identity_events` | who did what to whom, and the outcome | any secret, ever |

**Passwords use scrypt; machine credentials use SHA-256, and the difference is
deliberate.** A password is chosen by a person and has little entropy however
long it is, so its stored form must be expensive to compute — an attacker with
a stolen database should be buying every guess. A worker credential is 32 bytes
from `crypto.randomBytes`; there is nothing to dictionary-attack, and it is
presented on *every* request, so a deliberately slow hash would put ~60ms of CPU
in front of each one. Using scrypt for both would look more careful and be
worse: slow authentication is what pushes people toward caching decisions, and
cached decisions are how revocation stops working.

### The shape of a worker credential

```
brnw_<16 hex>.<43 characters>
└──── prefix ────┘ └─ secret ─┘
```

- the `brnw_` marker makes a leaked credential recognisable on sight, in a log
  or a paste, as a thing that must be revoked;
- the prefix is a single indexed lookup, so authentication does not verify every
  credential in the table to find out which one this is;
- the dot separates what is safe to show from what is not, so an audit row can
  name the credential without containing it.

**It is displayed exactly once**, in the response that issues it. It is not
recoverable afterwards by anyone, including a Brain administrator.

---

## 4. Roles and scopes

**Human roles**, per project, strongest first: `OWNER`, `ADMIN`, `MEMBER`,
`VIEWER`. The ordering is declared once, in `PROJECT_ROLES`, and interpreted in
one function (`roleAtLeast`).

| Level | Needs | Means |
|---|---|---|
| READ | `VIEWER` | see the project and what is in it |
| WRITE | `MEMBER` | import, run, audit, freeze, reconcile |
| ADMIN | `ADMIN` | change the project itself, and who may reach it |

A **Brain administrator** (`is_brain_admin`) can reach every project and
administer identities. That is a deliberate grant: somebody has to be able to
repair a project whose only owner left, and an administrator who can grant
themselves access but not use it is the same power with an extra step and a
worse audit trail. Every such access is recorded as an administrator's.

**Worker scopes**, per project:

`project:read` · `documents:read` · `research:read` · `research:write` ·
`research:propose` · `claims:write` · `sources:write` · `contradictions:write` ·
`checkpoints:write` · `blockers:report` · `work:complete`

Membership says *which project*; scopes say *what*. A worker with membership and
no matching scope is refused — an unnamed write is never waved through on the
strength of membership alone. There is no queue-claiming scope and no MCP scope:
those belong to Steps 5 and 7, and a scope that grants nothing is worse than an
absent one, because code starts checking for it and the check reads as
protection.

---

## 5. How a decision is made

```
request
  │
  ├─ requestContext()      correlation id; a place to hang the principal
  ├─ requireAuthentication()  cookie or bearer → principal, from server rows only
  │                           ↳ no credentials, or bad ones → 401
  │                           ↳ database unreachable         → 503   (never "allow")
  │                           ↳ cookie + mutation + foreign origin → 403
  │                           ↳ password still temporary      → 403 PASSWORD_CHANGE_REQUIRED
  │
  └─ route handler
       └─ requireProject / requireLayer / requireRun / requireDocument
          requireAudit / requireOrchestration / requireImportJob / requireChunk
            ├─ resolve the resource
            ├─ trace it to its project
            └─ decideProjectAccess(principal, projectId, level, scope?)
                 ↳ denied → 404, and an audit row
```

Those resolvers were already called by every route that addresses a
project-scoped resource, which is why they are the authorization point. A check
written into each of eighty-four handlers is eighty-four chances to forget one,
and the one that gets forgotten is not discovered by anybody friendly.

**What a route needs is derived from its own method and path.** `GET` is READ,
everything else is WRITE, and a short override table tightens the handful that
are really ADMIN or that name a worker scope. Defaults matter more than
exceptions: a route added next year with nobody remembering to classify it lands
on the safe side of both mistakes.

### Denied looks exactly like absent

A project, layer, document or research run the caller may not have returns the
same **404** as an id that was never real. Not 403. A distinguishable refusal is
an oracle — feed it ids until one answers differently and you have enumerated a
Brain you have no access to. The identity audit records which it was; the caller
does not learn it.

The same reasoning applies to sign-in: a wrong password, an unknown address and
a disabled account produce one sentence and one status code, and the password is
verified even when there is no such user so that an unknown address does not
answer measurably faster than a known one.

### Where the principal comes from

Only from server-held rows. No header names a user, no body field selects a
principal, no query parameter carries a credential — a credential in a query
string is **refused**, not accepted with a warning, because query strings are
logged by proxies, kept in history and forwarded in `Referer`.

One implementation note that is easy to get wrong: the principal is carried in
`AsyncLocalStorage`, and that does **not** survive an `EventEmitter` callback —
`multer` finishes a multipart upload from a socket-driven event, and the context
is simply gone by the time the route body runs. The request also carries its own
context, and `handler()` re-enters it before calling any route body, which makes
the guarantee structural rather than dependent on which middleware sits in front.

---

## 6. Sessions and cookies

- `HttpOnly` — no script on the page can read the session, which is the
  difference between an XSS bug being serious and being total.
- `SameSite=Lax` — the browser will not attach it to a cross-site POST. Every
  mutating route here is a simple JSON POST, so this is the CSRF class the
  application would otherwise be wide open to.
- `Secure` on any connection the browser considers secure, and a cloud-backed
  Brain **refuses to issue a session over plaintext at all**.
- Eight hours, not rolling. A session that refreshes on use never ends.
- A second lock behind `SameSite`: a cookie-authenticated mutation carrying an
  `Origin` or `Referer` from another host is refused. Bearer credentials are
  exempt, because no browser attaches one on anybody's behalf.

Changing a password ends every *other* session that person holds — that is what
the operation is for — and keeps the one doing it. Disabling an account ends all
of them immediately: "disabled, but still reading everything until Tuesday" is
not disabled.

---

## 7. Administering identities

`/api/admin/*`, Brain administrators only, guarded once at the router rather
than route by route.

| Operation | Route |
|---|---|
| list / create a person | `GET`, `POST /api/admin/users` |
| disable / re-enable | `POST /api/admin/users/:id/disabled` |
| grant / revoke Brain administration | `POST /api/admin/users/:id/brain-admin` |
| reset a password | `POST /api/admin/users/:id/password` |
| list / create a worker | `GET`, `POST /api/admin/workers` |
| disable / re-enable a worker | `POST /api/admin/workers/:id/disabled` |
| issue or rotate a credential | `POST /api/admin/workers/:id/credentials` |
| revoke one credential | `POST /api/admin/workers/:id/credentials/:cid/revoke` |
| project membership | `GET`, `POST /api/admin/projects/:id/members`, `DELETE …/:type/:principalId` |
| read the identity audit | `GET /api/admin/identity-events` |

Three properties these keep:

- **A stored credential is never returned.** Issuing hands back plaintext once;
  every listing afterwards is a prefix and some dates.
- **The last enabled Brain administrator cannot be disabled or demoted.** Not a
  courtesy: a Brain with no administrator cannot grant anybody the right to fix
  that, and the only remedy left is direct database access — which this whole
  step exists to make unnecessary.
- **Granting is idempotent by construction.** The membership row is upserted
  against a unique `(project, principal type, principal)` triple, so two
  administrators granting at the same moment produce one membership with one
  deterministic role rather than a race.

### Rotation without a gap

`POST …/credentials` with `rotatedFrom` issues the new credential **first** and
revokes the old one after. A rotation that revoked first would break whatever
the worker is doing at that moment, and a rotation people avoid is a rotation
that does not happen. Pass `revokeAfter: false` to keep both alive until the old
one is revoked explicitly.

---

## 8. The first administrator

A Brain with authentication and no accounts is a locked building with the key
inside. There is exactly one way in:

```
BRAIN_BOOTSTRAP_ADMIN_EMAIL=you@example.com
BRAIN_BOOTSTRAP_ADMIN_PASSWORD=<generated, temporary>
```

- **Read once, into a Brain that has no accounts at all.** Not "if this address
  is missing" — that would let the variables re-add an administrator somebody
  had deliberately removed. After the first account exists they are inert, and
  the boot log says so.
- **The password is temporary by construction.** It has been in a secret store
  and probably a terminal, so the account is created owing a password change and
  can do *nothing else* — every route except `/api/auth/*` answers
  `403 PASSWORD_CHANGE_REQUIRED` until it is done.
- **Nothing prints it.** The boot log names the address and tells you to remove
  the variable.

There is deliberately no default account and no unauthenticated setup page:
those are how installations end up with `admin/admin` reachable on the internet
for a year.

### If you are locked out

In order of preference:

1. Another Brain administrator resets your password
   (`POST /api/admin/users/:id/password`).
2. If there is no other administrator, disable every account with direct
   database access, then redeploy with the bootstrap variables set — an empty
   `users` table is what the bootstrap needs, so this is genuinely a last
   resort and genuinely requires the access that everything else avoids.

The refusal to disable the last administrator exists so that (2) stays
hypothetical.

---

## 9. The identity audit

`identity_events` is append-only, has **no foreign keys**, and is never a secret
store.

No foreign keys because an audit row a cascade can delete is not an audit row:
the record of who was given access to a project is most interesting exactly when
the project has gone.

Recorded: sign-in success and failure, worker authentication failure,
authorization denials, user and worker creation, enable/disable, membership
grant and revocation, role and scope changes, credential issue, rotation and
revocation. Each row carries the acting principal, the credential *id* it acted
with, the target, the project where there is one, the result, a **denial reason
category**, and a request id that correlates everything one request did.

The reason is a category from a fixed set — `INVALID_CREDENTIALS`,
`NOT_A_MEMBER`, `MISSING_SCOPE`, and so on — never a sentence containing
evidence. A log that distinguished "no such user" from "wrong password" would be
an oracle for exactly the question the refusal declines to answer.

A membership change is written to **both** logs: here, and to the project's own
`project_events` as `ACCESS_GRANTED` / `ACCESS_REVOKED`, so a project's history
answers "who could see this, and since when" without anybody having to know
there is a second log.

---

## 10. Threat model

| Attempt | What happens |
|---|---|
| No credentials at all | 401 on every API route and every document byte |
| Guessing a document, layer, audit, chunk, orchestration or import-job id | 404, indistinguishable from a real miss |
| Reading `/files/<other-project-slug>/…` | 404 before the storage layer is touched |
| Supplying another principal's id in a body, header or query | ignored — it contributes nothing to the principal |
| Subscribing to another project's research stream | refused before a single SSE header is written |
| A credential in a query string | refused outright, cookie or no cookie |
| A cross-site form post with a live session | 403 (`SameSite=Lax` plus an origin check) |
| Brute-forcing a password | scrypt per attempt, plus a per-instance lockout after 10 failures in 15 minutes |
| A stolen database | no password and no credential can be recovered from it |
| The database going away mid-request | 503; never a downgrade to anonymous, local or administrator |
| A project member reaching `/api/health` | the sanitized version: no host, no bucket, no data root |
| A worker trying to administer anything | refused, whatever scopes it holds |

### What this does not defend against

Said plainly, because a threat model that only lists successes is marketing:

- **A Brain administrator.** They can reach every project by design. The audit
  records it; nothing prevents it.
- **Anyone holding a live worker credential.** There is no second factor for
  machines and no per-request signing. Revocation is the answer, and it is
  immediate.
- **The login throttle across instances.** It is per-process and in-memory.
  There is deliberately one instance today (Step 5 adds the coordination that
  makes a second safe); with several, each brakes separately.
- **Anyone with direct database access.** They cannot recover a password or a
  credential, but they can insert an administrator. Protecting the database is
  Supabase's job and the operator's.

---

## 11. What Step 4 is not

No distributed claiming, leases, heartbeats, reclaim, retry policy, cross-worker
idempotency, remote MCP, connected Claude worker, scheduling, fleet capacity,
usage observation, fleet UI, multi-worker execution or automatic assignment.

Identity is not concurrency. Knowing which worker is calling does nothing to
stop two of them claiming one job — that is **Step 5** — and a lease that stops
them starting it does nothing to make its effects safe to apply twice, which is
**Step 6**. See [`ROADMAP.md`](ROADMAP.md).
