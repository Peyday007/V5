# Connection reliability

The connection system is one chain, and it is closed as one:

    Postgres/Supabase → OAuth registration/consent → token validation →
    refresh rotation → MCP authentication → whoami → connector identity →
    Routine firing → session arrival → brain_check_in → routing →
    no-show accounting → quarantine → automatic recovery

**Invariant.** A valid connector credential never becomes "Not authorized"
because Brain's database is busy, slow, restarting or unavailable. "Not
authorized" means a credential was judged and found wanting.

## Error semantics

| category | meaning | what the caller sees |
|---|---|---|
| `AUTH_INVALID` | bad, revoked or expired credential; actual lack of permission | MCP `401 Not authorized…`; token endpoint `400 invalid_grant` / `401 invalid_client`; tool `NOT_PERMITTED` |
| `AUTH_REAUTH_REQUIRED` | `connectorHealth` reads `HUMAN_REAUTH_REQUIRED` from rows | the connector report, with the row that says why |
| `INFRA_RETRYABLE` | pool or pooler checkout timeout, statement timeout, connection lost, database unavailable, restart | MCP and HTTP `503` + `Retry-After: 5`, a sentence saying the credential was not judged; token endpoint `503 temporarily_unavailable`; tool result `kind: INFRA_RETRYABLE, retryable: true`; check-in `RETRY_LATER` |
| `RATE_OR_CAPACITY_RETRYABLE` | the MCP rate slot, a provider refusal, the document store declining a *read* (429, 5xx, 544) after its own retries — never a write, whose outcome is unknown | `RATE_LIMITED`, a deferred intent; a store refusal is a tool result `kind: RATE_OR_CAPACITY_RETRYABLE, retryable: true` |

Every Supabase read retries a transient refusal up to three times, honouring
`Retry-After` — listings included. A listing is a POST only because Supabase
takes its query as a body; it was the one read that did not retry, and deploy
403's post-restart gate died on it (`refused a listing (HTTP 429)` inside
`storeFile`'s collision check, during a synthesis filing).

`server/db/infra.ts#classifyInfraFailure` is the one classifier. It returns
null for real defects (constraint violations, bugs) so they are never hidden
behind a retry. None of the infrastructure paths writes an auth refusal, mutates
token lineage, or moves a connector's health.

## The control plane

`asControlPlane(fn)` marks an async context; the Postgres adapter sends its
statements (and transactions) to a pool of its own. `controlPlaneShare(n)` gives
it 2 of a pool of `n ≥ 4` (`BRAIN_DATABASE_CONTROL_POOL_SIZE` to change), carved
out of the ceiling, so production's 10 is 2 control + 8 workload and the total
against Supabase's session-mode pooler is unchanged. Below 4 nothing is split.

On the control plane: authenticating a machine's bearer (an OAuth access token
or a worker credential, at the MCP door or the API guard), `POST /oauth/token`
(client authentication, code exchange, refresh rotation), `brain_whoami` and the
establishing half of `brain_check_in`. A browser's session cookie and a person's
bridge key authenticate on the workload pool, so a page loading a dozen routes
cannot queue ahead of a connector. Everything an authentication merely
*triggers* — token-use writes, session and credential "last used" stamps,
incident rows, the liveness write, and every audit row (success or refusal, at
the token endpoint and on a control-plane tool) — runs on the workload pool.

Each control connection carries a server-side `statement_timeout` of 12s (inside
the client's 15s `query_timeout`) and a `lock_timeout` of 5s, set on connect, so
a statement the client gave up on does not keep running on the backend beside
the retry. A statement that fails outside a transaction returns its connection
to the pool unless the connection itself is in doubt (`pool.query` used to
destroy it on any error, re-dialling the reservation through a saturated
pooler). Workload connections carry TCP keepalive.

The control pool's connections are opened at boot and never idled out: in
session mode a client holds a backend while connected, so a reservation that let
its connections go would have to queue at the pooler for new ones exactly when
the pooler is saturated. Workload connections idle out after 10s (was 30s) so
they hand their backends back to operator scripts and the release harness.

## OAuth around the token

- **The code exchange is one transaction.** Redeeming the code, the worker check,
  a member reconnect's attachment and minting the grant commit together; a
  database failure anywhere rolls the redemption back, so the client's retry of
  the same code succeeds instead of meeting `invalid_grant`. The grant's refresh
  token is derived from the code (as a refresh successor is derived from its
  parent), so a reply lost after the commit is answered with the same grant
  while nothing in it has been used — presented by the same client, with the
  PKCE verifier, inside the code's lifetime. Once the grant is in use the code is
  refused as before.
- **Consent is one transaction.** Spending an invitation, issuing the code and
  attaching the client commit together, so a failure answers 503 and the retry
  finds the same live invitation rather than "This invitation cannot be used".
- **A Brain retrying its boot answers 503 with `Retry-After`**: the token
  endpoint `temporarily_unavailable`, MCP a retryable `INFRA_RETRYABLE` JSON-RPC
  error, the API `retryable: true` (`server/bootFailure.ts`). It used to serve a
  500 page of text on every path.
- **The browser treats a retryable session check as unknown, not signed out**
  (`client/src/Root.tsx`): it says Brain is temporarily unavailable and asks
  again on a bounded backoff.

## Check-in

1. **Establishing** (control plane): `recordWorkerArrival`.
2. **Choosing** (workload pool, bounded by `CHECK_IN_ADMISSION_BUDGET_MS` = 25s):
   candidates, admission, derive-on-empty. A candidate whose admission throws an
   infrastructure failure, or that is reached past the budget, is skipped
   quietly. An empty result after that is `RETRY_LATER`, and the arrival is
   recorded as an `UNSERVED_ARRIVAL` incident carrying its session. A failed read
   of the worker's routing row propagates as infrastructure; it used to be read
   as "no routing row", refusing a Factory worker its own repository bins out
   loud and telling it `NO_READY_BINS`.
3. **After the lease** nothing turns the assignment into "nothing". If the
   `BIN_ASSIGNED` event or the arrival credit cannot be written, the session's
   arrival is held as evidence (`UNSERVED_ARRIVAL`, detail
   `ARRIVED_ASSIGNMENT_UNRECORDED`), because that event is what tells the no-show
   pass a fired session took other work.

## No-show accounting

`infra_incidents` rows mark Brain's own trouble: failures callers felt
(coalesced per minute per kind and surface), unserved arrivals (scoped to the
session), and `PROCESS_RESTART` windows derived at boot from `runtime_liveness`.
`affects_arrival = 1` only for a classified infrastructure failure at
`mcp:authenticate`, `oauth:token` or `check_in:establish` — the doors a fired
session uses — and for restarts. `http:auth` is a browser's and excuses nobody. An
unclassified exception (a bug) is logged, still answered 503, and recorded as
nothing. The adapter only counts what it feels; the recorder's own failed writes
are never incidents.

A session's own evidence (an unserved arrival under its session id, in any of
the three spellings `cse_`, `session_`, `claude-code-session_`) excuses its fire
however late it arrived after the fire; only evidence matched by worker, for a
session that reported no id, is bounded to the 15-minute arrival window. The
restart window runs from the previous process's last liveness to this one's
listen (bounded at its *end* to a day), is held in memory as evidence if its
write fails, is re-established in the background if its read fails, and until
it is known the no-show pass judges nothing (`restartWindowPending`).

Before charging an unanswered fire, `reopenNoShowDispatches` first asks what
this process holds in memory and has not yet written (`heldArrivalEvidence` —
rows waiting out an outage, or mid-flush), and then asks
`unservedArrivalFor(dispatch.session_ref)` and then
`arrivalIncidentDuring(sent_at)` (window: 15 minutes after the fire). Either
makes the miss `DISPATCH_INFRA_NO_SHOW`; `DISPATCH_NO_SHOW` (quarantine) and
`DISPATCH_AUTH_NO_SHOW` (connector health) are not written. The dispatch attempt
is refunded in the reopening statement, at most `MAX_INFRA_REFUNDS` = 3 times per
intent; after that the dispatch budget applies.

If the pass cannot read its own evidence because the database is failing, the
row is left `SENT` and judged on a later tick; past twice the in-flight window it
is reopened with no charge at all, so a persistent failure cannot strand the bin.
Evidence rows (arrival-path failures and unserved arrivals) are never dropped by
the recorder's retry give-up or its memory cap.

**Single-instance caveat.** Evidence still held in memory, and token uses not yet
written, are visible only to the process that holds them. Production runs one
machine; with several, the instance judging a no-show may not hold the evidence
another felt, and only the written rows would count.

## Recovery probe

Silence is only evidence about a connector when Brain was there to hear it. A
probe whose window overlapped Brain's own trouble (the same evidence the no-show
pass reads, or a restart window still being established) settles `AMBIGUOUS`
with "no reconnect is indicated", never `NO_MCP` with a reconnect instruction.

## Load Brain puts on its own database

- The document extraction queue never runs inside a caller's transaction: a
  caller in a transaction extracts its own document inline, and a fire-and-forget
  import schedules extraction after its transaction commits (`afterCommit`).
- Browser-polled readers (Build's line, Who, People, goals, the self-model) share
  one fleet snapshot for 5s (`sharedFleetSnapshot`); the dispatch tick reads its
  own.
- A bin completion and the factory loop ask for a dispatch pass through the
  dispatcher's own guard (`dispatchTickIfIdle`), never beside it.
- In cloud mode a recompute no longer builds the whole runtime snapshot only to
  discard it, and `brain_get_plan` / `brain_next_action` ask the store about each
  document once, sixteen at a time.

## Background writes

Token touches, incidents and liveness are written on the workload pool, one
flush at a time, outside any transaction the scheduling context carried, retried
with backoff (token touches for up to a day, evidence rows until written), and
bounded in memory. A held token use counts as a use for connector health, both
for "was the reply picked up" and for whether a refusal is newer than the
client's last activity.

## The matrix

`tests/connectionReliability.test.ts` › *the chaos matrix* drives twenty cases
through the real doors and prints one row each: client answer, connector health,
no-show events, unanswered fires counted toward quarantine, whether a reconnect
was asked for, and whether the same connector worked again afterwards. Cases 1–19
end HEALTHY, with zero quarantine-counted misses and no reconnect; case 20 (an
explicitly revoked credential) is the only one that asks for a person.

## Reading it

`npm run report:connections -- --hours 24`, or the `Connection report` workflow.
