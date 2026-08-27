# Step 7 — Authoritative Remote MCP Gateway: what was proven

Companion to [`MCP.md`](MCP.md), which is the design, and to
[`STEP-7-PLAN.md`](STEP-7-PLAN.md), which is what was decided before any code
was written.

This file separates three things on purpose: what a test proves, what a real
external client proved against the deployed Brain, and what nobody has run.

---

## The two findings that shaped the step

**1. The current protocol revision exists, and the official SDK cannot speak
it.**

| Fact | How to re-check it |
|---|---|
| `2026-07-28` is real; its pages moved into per-topic directories | `schema/2026-07-28/schema.ts` → 200 in the spec repo |
| Latest SDK is `@modelcontextprotocol/sdk@1.30.0` | `npm view @modelcontextprotocol/sdk version` |
| Published **2026-07-27** — the day before the revision | `npm view @modelcontextprotocol/sdk time` |
| It declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` | `dist/esm/types.js:2` |
| `2026-07-28` appears **nowhere** in the package | `grep -rn "2026-07-28" dist/` → no matches |
| No prerelease has it | `npm view … dist-tags` → `{ latest: '1.30.0' }` |

So "use the current specification" and "use the official SDK" could not both be
satisfied by one code path. The specification's own versioning page permits the
resolution — *"A dual-era server MAY serve both eras concurrently on the same
endpoint or process"* — and its compatibility matrix makes it necessary:
*legacy client → modern server* is marked **Fails**, with no fall-forward
available to the client, and every client that exists today is a legacy client.

**2. `2026-07-28` removed sessions and the `initialize` handshake outright.**

Which answered the brief's "smallest possible session model" requirement with
*none*. The legacy era could have had one and does not: the SDK's transport runs
with `sessionIdGenerator: undefined`. **The gateway holds no state between
requests in either era** — not a small store, no store.

---

## The verification matrix

47 items. `AUTOMATED` means a test in the suite asserts it; `LIVE` means the
hosted harness asserted it against the deployed Brain through the public
hostname; `BOTH` means both.

### The endpoint

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 1 | One MCP endpoint, `POST /mcp`, answering JSON-RPC | BOTH — *answers POST at exactly one path* | **PASS** |
| 2 | `GET` refused with `405`, because this revision removed the GET stream | BOTH — *refuses GET with 405* | **PASS** |
| 3 | `DELETE` refused with `405`, because sessions went with it | AUTOMATED — *refuses DELETE with 405* | **PASS** |
| 4 | Reachable through the optional outer shared-token gate | AUTOMATED — *is reachable through the outer shared-token gate* | **PASS** |
| 5 | Not swallowed by the SPA fallback | AUTOMATED — *is not swallowed by the SPA fallback* | **PASS** |
| 6 | Its own 1 MiB body limit, not the application-wide 10 MiB one | AUTOMATED — *refuses a body over its own 1 MiB limit* | **PASS** |
| 7 | A batch refused; this revision defines one request per POST | AUTOMATED — *refuses a batch* | **PASS** |
| 8 | Malformed JSON answered `-32700`, never a stack trace | AUTOMATED — *answers malformed JSON with a parse error* | **PASS** |

### Authentication

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 9 | No credential → `401` | BOTH — *refuses a request with no credential* | **PASS** |
| 10 | Unknown and malformed credentials give byte-identical refusals | AUTOMATED — *refuses an unknown credential with the same body* | **PASS** |
| 11 | A revoked or expired credential → `401` | BOTH — *refuses a revoked credential* / *refuses an expired credential* | **PASS** |
| 12 | No `WWW-Authenticate` pointing at OAuth metadata Brain does not serve | BOTH — *never points at OAuth metadata it does not serve* | **PASS** |
| 13 | A valid session cookie is refused at this endpoint | AUTOMATED — *refuses a session cookie even when it is perfectly valid* | **PASS** |
| 14 | A credential in the query string is refused, not ignored | AUTOMATED — *refuses a credential smuggled through the query string* | **PASS** |
| 15 | A browser `Origin` → `403` (the DNS-rebinding control) | BOTH — *refuses a browser origin* | **PASS** |
| 16 | Origin is checked *before* the credential | AUTOMATED — *checks the origin before it checks the credential* | **PASS** |

### The 2026-07-28 protocol

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 17 | `server/discover` implemented — this revision makes it mandatory | BOTH — *implements server/discover* | **PASS** |
| 18 | Advertised versions are exactly the versions served | BOTH — *is told both protocol eras* | **PASS** |
| 19 | No capability declared that is not implemented | AUTOMATED — *declares no capability it does not implement* | **PASS** |
| 20 | `resultType` on every result | BOTH — *puts resultType on every result* | **PASS** |
| 21 | `ttlMs` and `cacheScope` on every cacheable result | BOTH — *puts ttlMs and cacheScope on the cacheable results* | **PASS** |
| 22 | `cacheScope` is `private`, because every result is caller-shaped | BOTH — same check | **PASS** |
| 23 | `serverInfo` in the result `_meta` | AUTOMATED — *identifies itself in the result _meta* | **PASS** |
| 24 | Tools returned in a deterministic order | AUTOMATED — *returns tools in a deterministic order* | **PASS** |
| 25 | Unknown method → `-32601` with HTTP `404` | AUTOMATED — *answers an unknown method with -32601 and 404* | **PASS** |

### Headers and version negotiation

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 26 | Unsupported version → `-32022`, `400`, and `data.supported` | BOTH — *refuses an unsupported version with the ones it does speak* | **PASS** |
| 27 | Mismatched `Mcp-Method` → `-32020` | BOTH — *refuses a header that disagrees with the body* | **PASS** |
| 28 | Mismatched `MCP-Protocol-Version` → `-32020`, not `-32022` | AUTOMATED — *refuses a mismatched MCP-Protocol-Version header* | **PASS** |
| 29 | Missing required header → `-32020` | AUTOMATED — *refuses a missing Mcp-Method header* | **PASS** |
| 30 | `Mcp-Name` required and matched on `tools/call` | AUTOMATED — *refuses a mismatched / missing Mcp-Name* | **PASS** |
| 31 | The Base64 sentinel is decoded before comparison; a bad one is refused | AUTOMATED — *decodes the base64 sentinel* / *refuses a sentinel that does not decode* | **PASS** |
| 32 | `clientCapabilities` required on every request, never inferred | AUTOMATED — *requires clientCapabilities to be declared on every request* | **PASS** |

### What the revision removed

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 33 | No session id is ever minted | BOTH — *never mints a session id* | **PASS** |
| 34 | An `Mcp-Session-Id` from an older client is ignored, not echoed | AUTOMATED — *ignores an Mcp-Session-Id* | **PASS** |
| 35 | `Last-Event-ID` ignored; streams are not resumable | AUTOMATED — *ignores Last-Event-ID* | **PASS** |

### Authorization

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 36 | Every caller sees the identical tool list | AUTOMATED — *shows every caller the identical tool list* | **PASS** |
| 37 | A listed tool still refuses without the scope, at execution time | BOTH — *refuses a tool the caller lacks the scope for* / *a tool it may not use is listed and still refuses* | **PASS** |
| 38 | Forbidden and absent produce byte-identical bodies | BOTH — *gives a forbidden project and an absent one byte-identical answers* | **PASS** |
| 39 | A refusal never names the id it refused | BOTH — *never names the id it refused* | **PASS** |
| 40 | A work item resolves to its own project, never to one an argument names | AUTOMATED — *resolves a work item to its own project* | **PASS** |
| 41 | No administrative capability is exposed at all | AUTOMATED — *exposes no tool that administers anything* | **PASS** |

### Idempotency

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 42 | A repeated mutation replays instead of performing a second effect | BOTH — *replays a repeated completion* / *a repeat of that completion replays* | **PASS** |
| 43 | The key is independent of the result the worker reports | AUTOMATED — *derives the same key whether or not the caller supplies one* | **PASS** |
| 44 | A malformed caller-supplied key is refused, not ignored | AUTOMATED — *refuses a malformed idempotency key* | **PASS** |
| 45 | Concurrent duplicates collapse to exactly one effect | AUTOMATED — *suppresses concurrent duplicates down to one effect* | **PASS** |

### Bounds and the record

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 46 | Page sizes clamped, invalid input refused, unreadable documents reported as unreadable rather than empty | AUTOMATED — the four *bounds* checks | **PASS** |
| 47 | Every call audited with categories and ids only — never an argument, a payload or a credential | AUTOMATED — the three *audit trail* checks | **PASS** |

---

## The live proof

The brief is explicit that an in-process test is not evidence here, and it is
right: a supertest proves the handler agrees with itself. Header validation, the
body limit, the 405s, the access-gate exemption, the SPA fallback and the mount
order are properties of the *wiring*, and an in-process test passes with every
one of them broken.

So two genuine external MCP clients drive the deployed endpoint, from inside the
container and out through the public hostname — the only place that can both
mint a test principal and arrive from outside.

**The official SDK's own client.** `@modelcontextprotocol/sdk`'s `Client` and
`StreamableHTTPClientTransport` — the reference implementation, performing its
own `initialize`, framing and validation, with none of Brain's code in its
process. It speaks 2025-11-25 because that is the newest revision the SDK has.

**A conformant 2026-07-28 client.** `scripts/mcpModernClient.ts`, written from
the published schema and importing nothing from `server/`. A client built out of
the server's own types would prove only that the server agrees with itself; this
one can disagree with it.

Eighteen hosted checks, run either side of a real restart:

```
The MCP gateway, driven by real external clients
  PASS  a modern client discovers the deployed Brain
  PASS  and is told both protocol eras
  PASS  and lists the permanent tool surface
  PASS  with the cache fields this revision requires
  PASS  and calls a tool over TLS, through the load balancer
  PASS  the official SDK client connects to the deployed Brain
  PASS  and is served the identical tool surface
  PASS  a work item is queued for it
  PASS  and the SDK client claims it
  PASS  heartbeats the lease it was given
  PASS  and completes it
  PASS  a repeat of that completion replays rather than performing a second effect
  PASS  a tool it may not use is listed and still refuses
  PASS  the live gateway refuses a request with no credential
  PASS  and points at no OAuth metadata it does not serve
  PASS  and refuses an expired credential
  PASS  and refuses a browser origin, live
  PASS  and answers GET with 405, because that stream was removed
  PASS  and never mints a session id
  PASS  and refuses a header that disagrees with the body
  PASS  and refuses an unsupported version with the ones it does speak
  PASS  a live credential cannot open a project it was never granted
  PASS  and that refusal is byte-identical to one for a project that does not exist
  PASS  and never names the id it refused
```

### Executed, on the deployment

**Deploy run 11, commit `58a6db1`, 2026-08-27.** Target
`https://northline-brain.fly.dev`, Postgres at
`aws-0-us-east-2.pooler.supabase.com`, documents in the `brain` bucket.

```
Phase       before the restart
...
The MCP gateway, driven by real external clients
  PASS  and is told both protocol eras — ["2026-07-28","2025-11-25"]
  PASS  and lists the permanent tool surface — 14 tool(s)
  PASS  the official SDK client connects to the deployed Brain — initialize completed
  PASS  and is served the identical tool surface — 14 tool(s)
  PASS  and completes it — SUCCEEDED
  PASS  a repeat of that completion replays rather than performing a second effect — ALREADY_RECORDED
...
HOSTED-VERIFICATION: PASS 114/114
```

Then a real restart — not a side effect of anything else:

```
Restarting machine 891ed44a46e4e8
  Waiting for 891ed44a46e4e8 to become healthy (started, 0/1)     × 14
Machine 891ed44a46e4e8 restarted successfully!
```

Twenty-one seconds during which the process serving those checks did not
exist. Then, against the new process:

```
Phase       after the restart

Surviving a restart
  PASS  the work left before the restart is still there — all three found
  PASS  a live lease survived the restart, still owned and still counting down
        — LEASED, expires 2026-08-27T08:54:43.271Z
  PASS  the fencing generation and attempt count are unchanged — generation 1, attempt 1
...
The MCP gateway, driven by real external clients
  [all 24 checks PASS again]
...
HOSTED-VERIFICATION: PASS 120/120
```

**114/114 before, 120/120 after** — the six extra are the beacon checks that
only exist in the post-restart phase. Both passes include all 24 MCP checks.
The `Holdout` was `deal-dispatch`, so the cross-project isolation checks were
genuinely exercised rather than skipped.

The workflow's own verdict:

```
hosted verification: success
after the restart:   success
The live Brain refused everything it should have, twice, either side of a real restart,
and the work left before it was still there afterwards.
```

**This is what a stateless gateway surviving a restart looks like: nothing had
to be restored, because there was nothing to restore.** The queue state
persisted because it is rows; the gateway persisted because it holds nothing.

---

## Test counts

| Suite | Tests |
|---|---|
| `tests/mcp.test.ts` — conformance and threat matrix | 67 |
| `tests/mcpExternalClient.test.ts` — two real clients, out of process | 18 |
| **Whole suite, SQLite** | **762 passed, 25 skipped** |
| **Whole suite, real Postgres 16** | **787 passed, 0 skipped** |
| Hosted harness | 96 → **114 checks** (120 in the post-restart phase) |

Both backends, because one repository layer over two databases is a claim that
only a run against the second one can support.

---

## Two things found while building this

**1. The `Idempotency-Key` header was silently ignored.**

`STEP-7-PLAN.md` §8 said it must be *refused*, and the endpoint was ignoring it.
Caught by the matrix, which asserted the plan rather than the code.

On this endpoint that header would name a POST — but a POST is a transport frame
and the effect is the tool call inside it, keyed from the work item. A caller
sending the header believed it had transport-level idempotency it did not have,
which is the same failure `effects/http.ts` refuses for a key in a query string.
Now refused, naming the `idempotency_key` tool argument as the way to say this.

**2. A hosted check asserted the wrong thing about its own fixture.**

The first version pointed the *rival* worker at the scope project and expected a
refusal. It got `200`, correctly: that worker is deliberately a full member of
the same project, because it exists so a hosted claim can be a real race.

Rewritten into the property actually worth proving — a live credential pointed
at the **holdout** project gets the same answer as for a project that does not
exist, with the same body and no id echoed. A more valuable assertion than the
one that was wrong, and the same lesson Step 6 recorded.

---

## Carry-forward

**Nothing in the register was assigned to Step 7**, and nothing new is left
open by it.

| Item | Disposition |
|---|---|
| CF-5 — a real archive migration was never exercised | Still an operator task. Not Step 7's |
| CF-6 — more than one instance | Half closed by Step 5; the rest is Step 11 |
| **CF-7 — the real Antigravity/Claude worker is UNVERIFIED** | **Step 8, and untouched by this step** |

**CF-7 is the one to keep in view precisely because Step 7 did not close it.**
Two real MCP clients connecting to the deployed endpoint proves the gateway is
reachable and authoritative. It proves nothing about whether a particular worker
on a particular account can do useful work through it. Those are different
claims and only Step 8 can make the second one — the same separation Step 3 drew
between the research engine passing its tests against a scripted provider and a
real job having actually run.

### New, and recorded rather than solved

| Item | Assigned to |
|---|---|
| The MCP rate-limit counter is in-memory, so with several instances the effective limit multiplies by the instance count — the identical property the sign-in throttle already has | **Step 11**, alongside the throttle it matches |

---

## What nobody has run

- **A real Claude Max worker has never connected to this endpoint.** Step 8.
- **No new work type was registered.** `SYNTHETIC_ECHO` remains the only one, so
  every mutation proven here operated a work item that is safe to repeat.
  Exposing the queue over MCP did not change what may be queued.
- **`subscriptions/listen`, MRTR, sampling, elicitation, roots, logging,
  completions and the Tasks extension are not implemented**, and are declared
  absent in capabilities rather than left ambiguous.
- **Sustained operation.** This is hours old.
