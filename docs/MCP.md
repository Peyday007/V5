# The remote MCP gateway

Brain speaks the Model Context Protocol at one endpoint, `POST /mcp`, so that a
worker somewhere else can read project state and operate the durable work queue
without holding anything but a Brain worker credential.

This document is the design and the reasoning. `docs/STEP-7-EVIDENCE.md` is what
was actually proven.

---

## 1. Two protocol eras, one endpoint

Brain is a **dual-era server**. It speaks:

| Revision | How it is served | Why |
|---|---|---|
| **2026-07-28** | Implemented here, directly against the published schema | It is the current revision |
| **2025-11-25** | The official TypeScript SDK, in stateless mode | It is the newest revision any client can speak today |

That is not belt-and-braces. It is forced, and the arithmetic is short:

- The official SDK's latest release, **1.30.0, published 2026-07-27**, declares
  `LATEST_PROTOCOL_VERSION = '2025-11-25'`. The string `2026-07-28` appears
  nowhere in the package.
- Every MCP client in existence is built on that SDK or a sibling, so every
  client is a **legacy** client.
- The specification's own compatibility matrix marks *legacy client → modern
  server* as **Fails**, and notes that legacy clients have **no fall-forward
  mechanism**.

So a modern-only Brain would be a conformant server nothing could connect to,
and a legacy-only Brain would have been out of date the day it shipped. The
specification anticipated this and permits the resolution outright:

> A dual-era server **MAY** serve both eras concurrently on the same endpoint or
> process.

**Choosing an era** is the rule the versioning page gives, and nothing more
clever: a request carrying modern per-request `_meta` is served statelessly by
the 2026-07-28 dispatcher; anything else — an `initialize` included — goes to
the legacy front-end.

`server/discover` advertises `["2026-07-28", "2025-11-25"]` from the same array
the validator checks against, so the advertisement cannot drift from the
behaviour.

## 2. There is no session, in either era

The 2026-07-28 revision **removed protocol-level sessions and the `initialize`
handshake**. There is nothing to have completed, nothing to look up and nothing
to expire. The legacy era could have had a session — the SDK offers one — and
does not: it runs with `sessionIdGenerator: undefined`, so no `Mcp-Session-Id`
is minted, echoed or validated.

The gateway therefore keeps **no state at all** between requests. Consequences,
which are the point rather than a side effect:

- Every request re-authenticates and re-authorizes from rows read *this*
  request, so revoking a credential takes effect on the **next call**.
- A restart loses nothing. There is nothing to restore.
- Two Brain instances would behave identically. The gateway is not what keeps
  Brain on one machine; that is still Step 11's two items.

Where the modern protocol says cross-call state must be *"explicit,
server-minted handles passed as ordinary tool arguments"* — Brain already had
those before MCP asked for them. A work item id, a lease id and a generation are
rows, not session state.

## 3. Authentication

`Authorization: Bearer brnw_<16 hex>.<secret>` — the Step 4 worker credential,
resolved by the same `authenticateRequest` the HTTP API uses, from server-held
rows only.

- **Bearer only.** A session cookie is refused here even when perfectly valid. A
  browser is not an MCP client, and accepting the cookie would put a
  CSRF-reachable credential on a JSON-RPC endpoint that performs mutations.
- **No credential in a query string.** Refused, not ignored.
- **`Origin` is validated**, and any browser origin is refused with `403`. No
  CORS headers are emitted, so nothing legitimate needs one. A *missing* Origin
  is allowed, because that is what every non-browser client sends.
- **A refusal is one sentence.** "Unknown", "invalid", "expired", "revoked" and
  "belongs to a disabled worker" are one message.

### Why there is no OAuth

The specification is explicit that **authorization is OPTIONAL**, and that HTTP
transports **SHOULD** — not MUST — conform to its OAuth profile. Brain
deliberately does not, for four reasons:

1. **It would be theatre.** Brain would be its own authorization server issuing
   tokens to a client it already authenticates by another means. Every redirect
   and PKCE challenge would resolve to "does this `brnw_…` credential exist and
   is it live" — the check Step 4 already performs.
2. **There is no resource owner to redirect.** The authorization code flow
   exists to put a *person* in front of a consent screen. Step 8's client is a
   worker holding a machine credential.
3. **Step 4 already decided how a worker identifies itself**, and a second
   scheme for one endpoint would mean two answers to "who is this".
4. The transport's own security section asks for *"proper authentication"*,
   which this is.

What Brain does **not** do is advertise OAuth it has not implemented: there is
no `WWW-Authenticate: Bearer resource_metadata=…`, no
`/.well-known/oauth-protected-resource` and no `scopes_supported`. Sending a
client round a discovery flow that cannot end in a usable token is worse than
telling it plainly what to present.

## 4. The tool surface

Fourteen tools, permanent, and **identical for every caller**.

| Tool | Level | Worker scope | Mutates |
|---|---|---|---|
| `brain_whoami` | — | — | no |
| `brain_list_projects` | READ | `project:read` | no |
| `brain_get_project` | READ | `project:read` | no |
| `brain_get_plan` | READ | `project:read` | no |
| `brain_next_action` | READ | `project:read` | no |
| `brain_list_work` | READ | `queue:read` | no |
| `brain_get_work_item` | READ | `queue:read` | no |
| `brain_claim_work` | WRITE | `queue:claim` | **yes** |
| `brain_heartbeat_work` | WRITE | `queue:heartbeat` | **yes** |
| `brain_complete_work` | WRITE | `queue:complete` | **yes** |
| `brain_fail_work` | WRITE | `queue:complete` | **yes** |
| `brain_release_work` | WRITE | `queue:complete` | **yes** |
| `brain_get_document_text` | READ | `documents:read` | no |
| `brain_search_evidence` | READ | `documents:read` | no |

Every one is a thin wrapper over a service that already existed. None reaches a
capability no HTTP route reaches, and none was invented for MCP — a remote
protocol that grows its own back door is a second security model, and the second
one is always weaker.

**Resources and prompts are not implemented**, and are *absent* from
capabilities rather than present-and-empty. Document text reaches a worker
through a tool that applies the same extraction-readiness rules as every other
reader; a `resources/read` over stored bytes would be a second, weaker path to
the same content.

### The tool list is not a security boundary

Every caller sees the same `tools/list`. Filtering it per principal would make
the list a permission oracle and would leave Brain one forgotten filter away from
an unauthorized call.

So **which tools a caller may succeed with is decided at execution time**, by
`services/identity/policy.ts` — the same module every HTTP route uses. There is
no MCP policy module and there must never be one.

The order of every call is:

1. Authenticate → `Principal`, from server rows only.
2. Resolve the target's **own** project from its row — never from an argument
   naming a project.
3. `decideProjectAccess(principal, projectId, level, scope)`.
4. Execute.

A refusal is `NOT_FOUND` with a message that names nothing, byte-identical
whether the resource is absent or forbidden. That is invariant 23, and the
reason Step 4 had to amend it is that the two had differed by their *body* while
sharing a status.

### What is deliberately absent

- **Enqueueing and cancelling work.** ADMIN, and `policy.ts` names no worker
  scope for either — so a leaked worker credential cannot create work for the
  fleet.
- **Resolving an uncertain operation.** ADMIN. A worker may record that an
  outcome is unknown and may never decide what it meant.
- Freeze, reopen, import, audit recording, research approval, provider
  configuration, identity administration.
- Arbitrary SQL, filesystem access, outbound HTTP, shell execution, general code
  execution, and anything touching a provider credential. **A Claude
  subscription identity and a Brain worker identity remain separate.**

## 5. Idempotency

Every mutating tool runs through Step 6.

**The key is derived from the work item and which operation it is, and from
nothing else** — not the lease, the attempt, the generation, the credential, the
request or the clock, every one of which changes on a retry. And never from the
*result*: putting an output into an identity makes a reclaimed item's new owner
look like a conflicting request, which Step 6 found the hard way and invariant 27
exists to prevent.

Namespaces are named for the operation rather than the transport —
`queue.complete`, not `mcp.queue.complete` — because the identity of "complete
work item X" does not change with the door the request came through.

`claim` is a compare-and-swap and is idempotent by construction; a losing claim
is an ordinary outcome reported as "nothing available", not an error.
`heartbeat` is not wrapped, deliberately: it is a guarded `UPDATE` moving an
expiry forward, and performing it twice is indistinguishable from performing it
once, so reserving an operation record per heartbeat would write more rows than
the work itself.

A caller may pass its own `idempotency_key` **as a tool argument**, validated by
the existing `assertValidKey` and refused if malformed rather than ignored.

An **`Idempotency-Key` HTTP header is refused**, not honoured: on this endpoint
it would name a POST, but a POST is a transport frame and the effect is the tool
call inside it, keyed from the work item. Silently ignoring it would leave the
caller believing it had a property it does not have.

## 6. Errors

Two kinds, and the difference is the specification's:

**Protocol errors** — JSON-RPC `error` responses — are failures to *admit* the
call. The status is paired with the code and both are normative, because a
dual-era client reads exactly that pairing to decide whether to retry with
another version or fall back to `initialize`:

| Code | Meaning | HTTP |
|---|---|---|
| `-32700` | Malformed JSON | 400 |
| `-32600` | Not a valid request | 400 |
| `-32601` | Unknown method | **404** |
| `-32602` | Bad params | 400 |
| `-32020` | `HeaderMismatch` | 400 |
| `-32022` | `UnsupportedProtocolVersion` (with `data.supported`) | 400 |
| `-32000` | Transport refusal: 401, 403, 405, 413, 503 | as listed |

`-32000` comes from the range this revision reserves as implementation-defined,
and is what the official SDK emits for its own transport refusals. The three
codes that look closer are all wrong: `-32603` blames the server for the
caller's request, `-32600` claims malformed JSON that parsed fine, and `-32601`
means a method that was never reached.

**Tool errors** are `CallToolResult` with `isError: true` and HTTP `200` —
everything that happens *inside* a tool, authorization refusals included. The
schema asks for this so the consumer can see the error and self-correct; an
authorization refusal delivered as a transport failure is one the caller cannot
reason about.

Every tool error carries a category from a closed set — `NOT_FOUND`,
`NOT_PERMITTED`, `INVALID_INPUT`, `CONFLICT`, `FENCE_LOST`, `IN_PROGRESS`,
`RECONCILIATION_REQUIRED`, `LIMIT_EXCEEDED`, `UNAVAILABLE` — and a sentence.
Never a stack trace, never SQL, never an id the caller did not already have,
never a credential, never a payload.

`NOT_FOUND` and `NOT_PERMITTED` are **the same string on the wire**. The
distinction lives in the audit row, which Brain owns.

## 7. Limits

| Limit | Value |
|---|---|
| Request body | 1 MiB |
| Batch size | 1 (this revision defines one request per POST) |
| Tool result | 256 KiB, refused rather than silently cut |
| List page | 50 default, 200 max |
| Evidence passages | 20 |
| Document text | 128 KiB per call, offset-paged |
| Rate | 120 calls/min per credential |
| Concurrent in flight | 8 per credential |

Rate limiting is **per credential id**, not per IP: behind Fly's balancer every
caller shares an address, so an IP limit would either be useless or throttle the
whole fleet as one.

Truncation is always reported — a caller that received half a document and
believes it received all of it draws conclusions from an absence that is not
there. A result over the hard bound is **refused** rather than cut, because
truncating a JSON structure cannot be reported honestly.

> **Known, and Step 11's.** The rate counter is in-memory, so with two instances
> the effective limit multiplies by the instance count — the identical property
> the sign-in throttle has. Brain runs one machine.

## 8. Audit

Every tool call writes one `identity_events` row: actor, credential id, action
`MCP_TOOL_CALL`, target `MCP_TOOL` plus the tool name, project, outcome, request
id. Metadata carries **counts, categories and ids only** — the protocol era, the
denial category, the operation id, whether the result was replayed or truncated.
Never arguments, document text, passages, payloads, keys or credentials.

A *presented and refused* credential is audited as `MCP_AUTHENTICATE` with a
denial category and never what was tried. A request with **no** credential is
not: a scanner would otherwise bury the rows worth reading, which is the same
judgement `guard.ts` already makes.

`server/discover` and `tools/list` are not audited per call — a worker discovers
on every reconnect and lists on every startup.

## 9. Connecting a client

The endpoint is `https://<host>/mcp`. A client needs one thing: a Brain worker
credential, as a bearer token.

```
POST /mcp
Authorization: Bearer brnw_….…
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: brain_claim_work
Content-Type: application/json
Accept: application/json, text/event-stream
```

A worker loop is: `brain_whoami` to learn what it may do, `brain_claim_work` to
take an item, `brain_heartbeat_work` while working, then `brain_complete_work`,
`brain_fail_work` or `brain_release_work`. A retry after a timeout is safe.

**Credentials are issued by an administrator** through
`POST /api/admin/workers/:id/credentials`, shown exactly once, and are not
recoverable afterwards by anyone.

## 10. What this is not

Step 7 exposes the protocol. It does **not** connect a real worker — that is
Step 8, and CF-7 stays open. Proving that a gateway is reachable and
authoritative proves nothing about whether a particular worker on a particular
account can do useful work through it, and the two claims are kept apart on
purpose.

No new work type was registered. `SYNTHETIC_ECHO` remains the only one. Exposing
the queue over MCP does not change what may be queued.
