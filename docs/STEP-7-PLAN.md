# Step 7 — Authoritative Remote MCP Gateway: the implementation map

Written before any code, because two of the decisions below were forced by
facts that contradict the brief, and finding that out halfway through the
implementation would have meant rewriting the transport.

Everything here was established by inspecting the repository, the deployed
Brain, the published specification and the published SDK on 2026-08-27. Where a
claim is a fact somebody can re-check, the check is written beside it.

---

## 0. What the inspection found, before the map

### 0.1 The current protocol revision is `2026-07-28`, and it exists

The brief names it, and it is real. It was not obvious at first: the revision's
pages do not sit where earlier revisions' pages sat, and a first probe of
`docs/specification/2026-07-28/basic/transports.mdx` returned 404 while
`2025-11-25` returned 200. That is a path change, not an absence — the
transports page split into a directory:

```
docs/specification/2026-07-28/basic/transports/streamable-http.mdx   200
schema/2026-07-28/schema.ts                                          200
```

Both fetched, both read, and the schema is the contract this step implements.

### 0.2 The official TypeScript SDK cannot speak it

This is the finding that shapes the whole step.

| Fact | Check |
|---|---|
| Latest published SDK is `@modelcontextprotocol/sdk@1.30.0` | `npm view @modelcontextprotocol/sdk version` |
| It was published **2026-07-27** — the day before the revision | `npm view @modelcontextprotocol/sdk time` |
| `LATEST_PROTOCOL_VERSION = '2025-11-25'` | `dist/esm/types.js:2` |
| `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']` | `dist/esm/types.js:4` |
| The string `2026-07-28` appears **nowhere** in the package | `grep -rn "2026-07-28" dist/` → no matches |
| There is no prerelease that does | `npm view … dist-tags` → `{ latest: '1.30.0' }` |

So the brief's two instructions — *use the current specification* and *use the
official SDK* — cannot both be satisfied by one code path. That is not a
defect in the brief; it is a three-week-old gap between a specification and its
reference implementation, and the specification anticipated it.

### 0.3 The specification's own answer: a dual-era server

`basic/versioning` defines the terms and permits the resolution outright:

> **Modern**: protocol versions that convey version, identity, and capabilities
> as per-request metadata (revision `2026-07-28` and later).
> **Legacy**: protocol versions that establish a session with an `initialize`
> handshake (`2025-11-25` and earlier).
> **Dual-era**: an implementation that supports both.

> A dual-era server **MAY** serve both eras concurrently on the same endpoint
> or process.

And it says how the server chooses:

> - A request carrying modern per-request `_meta` is served statelessly
>   according to this revision.
> - An `initialize` request selects legacy semantics.

The compatibility matrix marks `Legacy client → Dual-era server` and
`Modern client → Dual-era server` both **Works**, and `Legacy client → Modern
server` **Fails** with no fall-forward mechanism available to the client.

That last row is the operative one. **Every MCP client that exists today is a
legacy client**, because every client is built on an SDK that tops out at
`2025-11-25`. A modern-only Brain would be a conformant server that nothing
could connect to — and Step 7's own closure condition is a live connection from
a real external client. A legacy-only Brain would connect to everything and be
three weeks out of date the day it shipped.

**Decision: Brain is a dual-era server.** The modern era is implemented
directly against the published schema, because no SDK implements it. The legacy
era is served by the official SDK, because it does implement that and because
that is what real clients speak. One endpoint, one tool surface, one
authorization path, two protocol front-ends.

This satisfies the brief on both counts and is the only arrangement that does.

### 0.4 What `2026-07-28` removed, and why that is good news here

The revision is not a version bump. From `changelog`:

1. **Protocol-level sessions and `Mcp-Session-Id` are gone.**
2. **`initialize` / `notifications/initialized` are gone** — the protocol is
   stateless, and every request carries its own version and capabilities in
   `_meta`.
3. **`server/discover` is MUST-implement.**
4. **The GET endpoint is gone**, replaced by `subscriptions/listen`.
5. **`ping` and `logging/setLevel` are gone.**
6. **SSE resumability and `Last-Event-ID` are gone.**
7. All results carry a required `resultType`.
8. List and read results carry required `ttlMs` and `cacheScope`.
9. `Mcp-Method` and `Mcp-Name` headers are required and **must match the body**.
10. Error codes renumbered: `-32020` HeaderMismatch, `-32021`
    MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion.

Item 1 and item 2 are the answer to the brief's "smallest possible session
model" requirement, and the answer is **none**. The protocol removed the
concept. Brain does not get to have a small session model on the modern path;
it gets to have no session model at all.

The legacy path could have had one — the SDK offers it — and will not. The SDK's
`StreamableHTTPServerTransport` supports stateless operation
(`sessionIdGenerator: undefined`, documented at
`dist/esm/server/streamableHttp.d.ts:35`), which means:

> In stateless mode: No Session ID is included in any responses. No session
> validation is performed.

**So the gateway holds no session state in either era.** Not a small store — no
store. Nothing to expire, nothing to leak, nothing that makes two Brain
instances disagree, and nothing standing between an authenticated request and
the authorization decision that Step 4 already owns.

### 0.5 Authorization is OPTIONAL in MCP, in the specification's own words

`basic/authorization`:

> Authorization is **OPTIONAL** for MCP implementations. When supported:
> - Implementations using an HTTP-based transport **SHOULD** conform to this
>   specification.

`SHOULD`, not `MUST`, and the whole OAuth apparatus sits under "when
supported". A justified deviation is permitted by the text, and the brief
already anticipated one ("reusing Step 4 Brain worker credentials, or a
justified OAuth 2.1 facade").

**Decision: Brain reuses Step 4 worker credentials, and builds no OAuth
facade.** Reasons, in order of weight:

1. **An OAuth facade here would be theatre.** Brain would be its own
   authorization server issuing tokens to a client it already authenticates by
   another means. The redirect, the PKCE challenge and the metadata documents
   would all resolve to "does this `brnw_…` credential exist and is it live" —
   the check Step 4 already performs. A protocol whose only purpose is to
   arrive at a check you were going to do anyway adds attack surface and
   removes nothing.
2. **There is no resource owner to redirect.** OAuth's authorization code flow
   exists to get a *person* in front of a consent screen. Step 8's client is a
   worker holding a machine credential; there is no browser and no human in
   that loop.
3. **Step 4 already decided this**, and `IDENTITY.md` says why a worker
   presents `Authorization: Bearer brnw_…` rather than anything else. Inventing
   a second worker-authentication scheme for one endpoint would mean two
   answers to "who is this", which is how the wrong one gets used.
4. The transport specification's own security section asks only for
   *"proper authentication for all connections"* — `SHOULD`, satisfied.

What Brain will **not** do is advertise OAuth it does not implement. No
`WWW-Authenticate: Bearer resource_metadata=…`, no
`/.well-known/oauth-protected-resource`, no `scopes_supported`. A client that
follows a discovery pointer into a facade that cannot issue a usable token is
worse off than one told plainly that it needs a credential. The 401 says what
is required in one sentence and points at nothing.

### 0.6 The carry-forward register assigns nothing to Step 7

Checked across `STEP-4-EVIDENCE.md`, `STEP-5-EVIDENCE.md`,
`STEP-6-PLAN.md`, `STEP-6-EVIDENCE.md`:

- **CF-5** — a real archive migration — remains an operator task.
- **CF-6** — second instance — half closed by Step 5, half is Step 11.
- **CF-7** — the real Antigravity worker is UNVERIFIED — is **Step 8**.
- Step 6 recorded no item for Step 7.

CF-7 is the one to keep in view precisely because it is *not* this step's.
Step 7 exposes the protocol; Step 8 connects the real worker. Proving the
first is not evidence for the second, and this plan's live-proof section is
written to avoid claiming otherwise.

### 0.7 State of the repository and the deployment

| Fact | Value |
|---|---|
| Branch | `claude/zealous-hypatia-78a2yp` |
| HEAD, local and remote | `6f5856e7c0df08186d2737dd5f572207ec136a23` |
| Worktree | clean |
| `step-6-idempotency-safe-effects` | → `6f5856e7…`, equal to HEAD |
| Node | v22.22.2 (`engines: >=22.5.0`); SDK needs `>=18` |
| Express | 4.21.2 |
| Production | `northline-brain.fly.dev`, one machine, `iad` |
| Schema version | 6 (Postgres) / 16 (SQLite) |

Step 6 is genuinely closed and its tag matches HEAD, so §3.9's stop condition
does not apply and Step 7 may proceed.

**This environment cannot reach the deployment** — `curl https://northline-brain.fly.dev/healthz`
returns `CONNECT tunnel failed, response 403`. Live proof therefore runs where
Steps 3–6 ran theirs: inside the container, through the deploy workflow. That
is a constraint, not a workaround, and it is the same one the previous three
steps closed under.

---

## 1. Protocol version

**Primary: `2026-07-28`.** Implemented directly against
`schema/2026-07-28/schema.ts`.

**Also served: `2025-11-25`**, through the official SDK, for the clients that
exist.

`server/discover` advertises exactly `["2026-07-28", "2025-11-25"]`, and that
array is generated from the same constant the dispatcher validates against, so
the advertisement cannot drift from the behaviour.

Anything else is refused with `-32022` `UnsupportedProtocolVersion` and
`400 Bad Request`, carrying `data.supported` and `data.requested` as the schema
requires — which is also what lets a dual-era client recognise Brain as modern
rather than falling back.

## 2. SDK

`@modelcontextprotocol/sdk@1.30.0`, pinned, as a **production** dependency —
`Dockerfile` runs `npm ci --omit=dev` in the runtime stage, so a devDependency
would typecheck locally and crash the container on boot.

Used for exactly one thing: the legacy era's `Server` + stateless
`StreamableHTTPServerTransport`. It is not used for the modern era, because it
cannot be.

**Cost, stated rather than hidden:** it brings 17 transitive dependencies into
the runtime image, including a second major of Express (5.x) and a second HTTP
framework (`hono`, used internally to bridge Node streams to Web Standard
Request/Response). Brain's own Express 4 app is untouched — the SDK's transport
takes a raw `IncomingMessage`/`ServerResponse` plus a pre-parsed body, so it
mounts under the existing app without either framework knowing about the other.
The image grows. That is the price of serving clients that exist, and it is
written here so nobody later mistakes it for an accident.

## 3. Transport

Streamable HTTP, one endpoint: **`POST /mcp`**.

| Method | Behaviour | Why |
|---|---|---|
| `POST` | The MCP endpoint | The only method the revision defines |
| `GET` | `405 Method Not Allowed` | The revision removed the GET stream and names 405 as the response |
| `DELETE` | `405 Method Not Allowed` | Session termination is gone with sessions |

`Mcp-Session-Id` on a request is **ignored** — not echoed, not minted.
`Last-Event-ID` is **ignored** — streams are not resumable. Both per the
revision's explicit instruction for a server receiving older traffic.

Responses are `application/json`. Brain's tools are bounded and fast by
construction (§10), so there is no request for which an SSE stream is the
honest answer, and opening one to look modern would add a held-open connection
per call for nothing. `subscriptions/listen` is **not** implemented and is
declared absent in capabilities — see §14.

## 4. Authentication

`Authorization: Bearer brnw_<16 hex>.<secret>` — the Step 4 worker credential,
resolved by the existing `authenticateRequest`, against server-held rows only.

- **Bearer only.** A session cookie is refused at `/mcp` even when valid. A
  browser is not an MCP client, and accepting the cookie would put a
  CSRF-reachable credential on a JSON-RPC endpoint that performs mutations.
- **No credential in a query string** — the existing check already refuses
  `token`, `access_token`, `credential`, `api_key`, `apikey`, `password`, and
  the specification independently requires that tokens not be in the URI.
- **`Origin` is validated** and an invalid one is `403 Forbidden`, as the
  transport section requires, with a JSON-RPC error body carrying no `id`.
  A *missing* Origin is allowed: non-browser clients legitimately send none,
  and the credential is a bearer token no browser attaches on anyone's behalf.
- **No CORS headers are emitted.** Brain grants no browser origin access to
  `/mcp`. Nothing legitimate needs it, and a permissive header here would hand
  a page on another site the ability to drive the gateway with a credential a
  user pasted into it.
- **A refusal is `401` with one sentence** and no `WWW-Authenticate` discovery
  pointer (§0.5). "Invalid", "expired", "revoked", "unknown" and "belongs to a
  disabled worker" are one message, as everywhere else in this codebase.

Authentication happens **before** the JSON-RPC body is interpreted. An
unauthenticated caller cannot learn which tools exist, cannot reach
`server/discover`, and cannot distinguish Brain from any other 401.

## 5. Session model

**None, in either era.** Established in §0.4. There is no session table, no
in-memory map, no `Mcp-Session-Id`, and no state that survives a request.

Consequences worth stating because they are the point:

- Every request re-authenticates and re-authorizes from current rows, so a
  revoked credential stops working on the **next call**, not at some later
  re-handshake. This is the property Step 4 built and it survives intact.
- Two Brain instances would behave identically, because there is no per-instance
  state to disagree about. The gateway is not what keeps Brain at one machine
  (that is Step 11's two items, unchanged).
- A restart loses nothing.

Where the modern protocol says cross-call state must be "explicit, server-minted
handles passed as ordinary tool arguments" — Brain already has those, and had
them before MCP asked: a work item id, a lease id, a project id. They are rows,
not session state.

## 6. Tool and resource inventory

**Resources: none.** `resources/*` is not implemented and is absent from
capabilities. Brain's documents are the one thing that looks like an MCP
resource, and exposing them as one would mean handing a client a URI template
over stored bytes. Document *text* reaches a worker through a tool that runs
the same authorization and the same extraction-readiness rules as every other
reader (CLAUDE.md §9: a `BLOCKED` document is not evidence, and an empty
extraction must never read as an empty document). A resource read that
bypassed that would be a second, weaker path to the same bytes.

**Prompts: none.** Nothing in Brain is a prompt template a client should
expand; `promptCompiler.ts` composes prompts *for* providers, on the server,
from project state.

**Tools: a small permanent set**, each one a thin wrapper over a service that
already exists, with the scope it already requires. No tool is invented for MCP,
and no tool reaches a capability no HTTP route reaches.

| Tool | Wraps | Level | Worker scope | Mutates |
|---|---|---|---|---|
| `brain_whoami` | the request's principal | — | — | no |
| `brain_list_projects` | `visibleProjectIds` + projects repo | READ | `project:read` | no |
| `brain_get_project` | `GET /api/projects/:id` | READ | `project:read` | no |
| `brain_get_plan` | planner | READ | `project:read` | no |
| `brain_next_action` | planner | READ | `project:read` | no |
| `brain_list_work` | work queue | READ | `queue:read` | no |
| `brain_get_work_item` | work queue | READ | `queue:read` | no |
| `brain_claim_work` | atomic claim | WRITE | `queue:claim` | **yes** |
| `brain_heartbeat_work` | lease heartbeat | WRITE | `queue:heartbeat` | **yes** |
| `brain_complete_work` | fenced completion | WRITE | `queue:complete` | **yes** |
| `brain_fail_work` | fenced failure | WRITE | `queue:complete` | **yes** |
| `brain_release_work` | fenced release | WRITE | `queue:complete` | **yes** |
| `brain_get_document_text` | extraction retrieval | READ | `documents:read` | no |
| `brain_search_evidence` | `retrieveEvidence` | READ | `documents:read` | no |

`brain_whoami` needs no scope because it discloses only what the caller already
proved: the principal Brain resolved from the credential the caller sent. It
lists the projects and scopes that credential holds, which is the difference
between a worker that can be configured and one that has to guess.

**Deliberately absent, and each for a reason that is not "we ran out of time":**

- Enqueueing and cancelling work — ADMIN, and `policy.ts` names no worker scope
  for either, deliberately, so that a leaked worker credential cannot create
  work for the fleet. That property does not get quietly dropped at a new
  boundary.
- Resolving an uncertain operation — ADMIN. Step 6: a worker may record that an
  outcome is unknown and may never decide what it means.
- Freeze, reopen, import, audit recording, research approval, provider
  configuration, identity administration — none is a worker's job.
- Anything the brief excludes outright (§14).

The set is **permanent**: no dynamic registration, no tool whose existence
depends on the caller. Every caller sees the same `tools/list`, in a
deterministic order (`SHOULD`, changelog minor item 3). Which tools a caller may
*succeed* with is decided at execution time, not by editing the menu — §7.

## 7. Scope mapping and authorization

**The tool list is not a security boundary and is not treated as one.**

Every caller gets the identical `tools/list`. Hiding a tool from a caller who
may not use it would make the list a permission oracle and would put Brain one
forgotten filter away from an unauthorized call. The brief says this and the
codebase already agreed: authorization is deterministic server code at
execution time (CLAUDE.md §17).

So every `tools/call` runs the full path, in this order:

1. Authenticate → `Principal`, from server rows only.
2. Resolve the target resource's **own** project from its row — never from an
   argument that names a project. A work item id resolves through
   `requireWorkItem`, which authorizes the project the row actually belongs to.
3. `decideProjectAccess(principal, projectId, level, scope)` — the same
   function every HTTP route uses. No new policy module, no second rule set.
4. Execute.

A tool the caller may not use fails at step 3, not by being invisible.

**Refusals are indistinguishable from absence.** A project a worker may not see
and a project that does not exist produce the same error, with the same text,
naming no id — invariant 23, which Step 4 amended after this exact leak was
found in the resolvers. At the MCP boundary that means an `isError` tool result
whose message is identical in both cases.

**A worker is never a Brain administrator**, and `level: 'ADMIN'` is refused for
a worker principal by the policy regardless of scopes held. No MCP tool asks for
ADMIN, so this is a second lock behind an empty room — which is the correct
number of locks.

## 8. Idempotency

**Every mutating tool runs through Step 6.** No exceptions, and no new
mechanism.

The four mutating tools (`claim`, `heartbeat`, `complete`, `fail`/`release`)
divide into two cases:

**Lease-fenced queue operations** — `complete`, `fail`, `release` — already
carry their own proof: item, lease id, generation, worker id from the
authenticated principal, `LEASED`, unexpired. That guarded `UPDATE` is the fence
at the commit boundary, and it makes a repeat a no-op rather than a second
effect. They additionally take a Step 6 logical key derived by
`logicalEffectKey({ workItemId, namespace, discriminator })` — **from the work
item and which effect it is, and from nothing else.** Not the lease, not the
attempt, not the generation, not the credential, not the clock, and above all
not the result the worker reports. Step 6 found that defect the hard way and
invariant 27 exists because of it; the MCP path inherits the fix rather than
re-earning it.

**`claim`** is a compare-and-swap and is idempotent by construction: a losing
claim is an ordinary outcome, not an error, and is reported as "no work
available" rather than as a failure.

**How the key arrives.** MCP has no header the client controls per tool call in
the way HTTP does, so a key cannot be required from the caller. It does not need
to be: for every mutating tool the logical key is derivable from
server-controlled facts — the work item and the operation — which is exactly
what Step 6 requires (*"a queue effect's key is derived from the work item,
never from the lease, attempt, generation, credential, request or clock"*).
An optional `idempotency_key` **argument** is accepted where a caller genuinely
has its own notion of one request, validated by the existing `assertValidKey`,
and refused if malformed rather than ignored. The scope is built from
server-controlled facts only, so a key can never reach another project.

`Idempotency-Key` as an **HTTP header on the `/mcp` POST is refused**, not
honoured. One POST may carry a batch, so a transport-level key would name a
request rather than an effect, and honouring it would give the caller a property
it does not have.

## 9. Error model

Two kinds of error, and the difference is the specification's, not a
preference:

**Protocol errors** — JSON-RPC `error` responses. Reserved for failures in
*finding* or *admitting* the call: unknown method (`-32601`, with `404`),
header/body mismatch (`-32020`, with `400`), unsupported version (`-32022`,
with `400`), malformed JSON (`-32700`), bad params (`-32602`).

**Tool errors** — `CallToolResult` with `isError: true` and `resultType:
"complete"`, HTTP `200`. Everything that happens *inside* a tool: refused
authorization, an absent row, a lost lease, a conflicting idempotency key, an
uncertain operation. The schema is explicit that tool-originated errors belong
in the result so the model can see them and self-correct; making an
authorization refusal a protocol error would hide it from the very consumer that
needs to react to it.

Every tool error carries a **category from a closed set** — `NOT_FOUND`,
`NOT_PERMITTED`, `CONFLICT`, `FENCE_LOST`, `IN_PROGRESS`,
`RECONCILIATION_REQUIRED`, `INVALID_INPUT`, `LIMIT_EXCEEDED`,
`UNAVAILABLE` — and a sentence. Never a stack trace, never a SQL fragment,
never an id the caller did not already have, never a credential, never a
provider response, never the contents of a conflicting payload.

`NOT_FOUND` and `NOT_PERMITTED` **are the same string on the wire.** The
category distinction exists in the audit row, which Brain owns, not in the
response, which the caller reads.

## 10. Limits

| Limit | Value | Why |
|---|---|---|
| Request body | 1 MiB | A tool call is arguments, not an upload. Brain's file path is multipart on a different route with its own 50 MiB bound |
| Batch size | 1 | The revision defines one request or notification per POST |
| Tool result | 256 KiB, hard | Beyond this a result is truncated with an explicit `truncated: true` and a count of what was omitted — never silently cut |
| `brain_list_*` page | 50 default, 200 max | Paginated with an opaque cursor |
| Evidence passages | 20 | `retrieveEvidence` already bounds; this bounds the boundary |
| Document text | 128 KiB per call, offset-paged | A transcript is not a tool result |
| Per-credential rate | 120 calls/min, burst 30 | Enough for a worker loop; not enough to sweep |
| Concurrent in-flight per credential | 8 | |
| Request timeout | 30 s | |

Rate limiting is **per credential id**, not per IP: behind Fly's balancer every
caller shares an address, so an IP limit would either be useless or would
throttle the fleet as one. Exceeding it is `LIMIT_EXCEEDED` with a
`retry_after_ms`, never a silent drop.

**Known and written down:** the counter is in-memory, so with two instances the
effective limit multiplies by the instance count — the identical property the
sign-in throttle has, already recorded as Step 11's. Brain runs one machine.
This is added to the Step 11 register rather than presented as solved.

## 11. Audit

Every tool call writes one `identity_events` row through the existing
`recordIdentityEvent`: actor type and id, credential id, `action`
(`MCP_TOOL_CALL`), `targetType: 'MCP_TOOL'`, `targetId` = the tool name,
project id, `SUCCESS`/`DENIED`/`FAILED`, request id, user agent, remote address.

Metadata carries **counts, categories and ids only**: the protocol era and
version, the denial category, the operation id, whether the result was replayed,
whether it was truncated. Never arguments, never document text, never a
passage, never a payload, never a key, never a credential — the same rule the
queue routes already follow.

`server/discover`, `tools/list` and authentication failures are **not** audited
per-call. A worker discovers on every reconnect and lists on every startup;
recording those would bury the rows worth reading, which is the reasoning
`guard.ts` already applies to `NO_CREDENTIALS` on safe methods. A *presented and
refused* credential is audited, because that one is always interesting.

Audit failure never turns a successful call into a failure, and never the
reverse.

## 12. Generic-client test plan

The brief is explicit that an in-process supertest is insufficient, and it is
right: supertest proves the handler, not the protocol. Three layers, and only
the third is evidence of the claim Step 7 makes.

**Layer 1 — in-process suites** (`tests/mcp*.test.ts`). Fast, exhaustive,
adversarial: header/body mismatch in both directions, base64 sentinel decoding,
missing and mismatched `MCP-Protocol-Version`, unsupported version shape,
GET/DELETE 405, `Mcp-Session-Id` ignored, `Last-Event-ID` ignored, Origin
refusal, cookie refusal, query-credential refusal, `resultType` on every result,
`ttlMs`/`cacheScope` on every cacheable result, the identical-refusal property,
tool-list identity across principals, scope enforcement per tool, idempotent
replay, fence loss, every limit, every error category. These prove the rules.

**Layer 2 — the real SDK client, out of process.** A script that builds a
genuine `@modelcontextprotocol/sdk` **client** with
`StreamableHTTPClientTransport`, over a real socket, against a Brain listening
on a real port, and drives the legacy era end to end: connect, list tools, call
a read tool, claim work, heartbeat, complete, and be refused for a scope it does
not hold. This is a real external MCP client by construction — it is the
reference implementation, it performs its own `initialize`, and Brain's code
does not appear in its process.

**Layer 3 — a hand-written modern client.** The SDK cannot speak `2026-07-28`,
so the modern era needs a client written to the published schema: correct
`_meta`, correct headers, `server/discover` first, then `tools/list` and
`tools/call`, plus the negative cases a conformant client would hit. It shares
no code with the server — it is written from `schema/2026-07-28/schema.ts`, not
from Brain's types — because a client built from the server's own modules would
prove only that the server agrees with itself.

Layers 2 and 3 both run in CI **and** against the deployed URL (§13).

## 13. Live deployment plan

The same shape that closed Steps 3–6, because it is the only shape available:
this environment cannot reach the deployment (§0.7), so verification runs
**inside the container** and asserts against the **public URL** — the only place
that can both mint a test principal and arrive from outside.

`scripts/verify-hosted.ts` grows an MCP section: a worker and credential minted
for the run, then both external clients (§12 layers 2 and 3) driven against
`https://northline-brain.fly.dev/mcp`, plus the negative cases — no credential,
revoked credential, wrong project, missing scope, bad Origin, GET, DELETE,
oversized body, unsupported version. The marker line's count rises from 96 and
the workflow greps for the new total.

The existing persistence beacon already runs the harness either side of a real
`flyctl apps restart`; the MCP section runs in both phases, which is what
demonstrates that a stateless gateway survives a restart with nothing to
restore.

**Step 7 is closed only when a real external MCP client has completed a tool
call against the deployed URL and the workflow printed the pass line.** Passing
tests against a local server is not that claim, and will not be reported as it.

## 14. Explicit exclusions

**Excluded by the brief, and absent from the code — not merely undocumented:**

- No arbitrary SQL. No tool takes a query, a fragment, a table or a column name.
- No filesystem access. No path argument, no read, no write, no listing.
- No outbound HTTP fetching on a caller's behalf.
- No shell or process execution.
- No general-purpose code execution.
- No provider credential sharing. No tool returns, accepts or proxies a provider
  key, and none causes Brain to spend the user's allowance.
- No Claude browser cookies, OAuth tokens or passwords. **A Claude subscription
  identity and a Brain worker identity remain separate**, and nothing here
  brings them closer together.

**Excluded because they belong to another step:**

- **The real Claude Max worker is not connected.** That is Step 8, and CF-7
  stays open and UNVERIFIED. Step 7 proves the protocol is reachable and
  authoritative; it proves nothing about a real worker on a real account.
- No new work type is registered. `SYNTHETIC_ECHO` remains the only one.
  Exposing the queue over MCP does not change what may be queued.
- Research and extraction stay off the queue (Step 11's item, unchanged).
- No second instance (Step 11).

**Excluded on the protocol side, deliberately, and declared absent in
capabilities rather than left ambiguous:**

- `subscriptions/listen` and every change notification. Brain has nothing to
  push that a worker cannot poll, and a long-lived stream per worker is real
  cost for no information.
- Sampling, elicitation, roots, and the MRTR `InputRequiredResult` path. Brain
  never needs input from the client mid-call — a tool has its arguments or it
  fails. All three are deprecated as of this revision in any case.
- Logging notifications. Deprecated this revision; Brain's audit is the record.
- The Tasks extension. Brain has a queue with leases and fencing that predates
  it and is stronger.
- Completions, icons, `x-mcp-header` annotations on tool parameters. Nothing
  Brain exposes needs a value mirrored into a header for routing, and adding
  annotations would add a validation surface for no gain. Header *validation* is
  still implemented for the standard headers, because that is required of the
  server regardless.
- The deprecated HTTP+SSE transport (2024-11-05). New implementations
  **SHOULD NOT** adopt it.

---

## The order of work

1. Add the SDK as a pinned production dependency; confirm the image still builds.
2. Protocol core: version constants, `_meta` validation, header/body validation,
   error construction, result envelopes (`resultType`, `ttlMs`, `cacheScope`).
3. The tool registry and its execution path — authorization, idempotency,
   bounds, audit — with no transport attached.
4. The modern dispatcher (`server/discover`, `tools/list`, `tools/call`).
5. The legacy front-end over the SDK, stateless, same registry.
6. The endpoint: `POST /mcp`, auth, Origin, limits, 405s.
7. In-process suites.
8. Both external clients.
9. Hosted harness, deploy, live proof.
10. `docs/MCP.md`, `docs/STEP-7-EVIDENCE.md`, `ROADMAP.md`, `CLAUDE.md` §21.

Checks before it is called done: `npm run typecheck`, `npm test`, the suite
against real Postgres, migrate-from-empty, restart-against-existing, and the
deploy workflow green with the MCP section passing on both sides of a restart.
