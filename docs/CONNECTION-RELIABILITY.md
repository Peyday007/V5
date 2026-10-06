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
| `RATE_OR_CAPACITY_RETRYABLE` | the MCP rate slot, a provider refusal | unchanged: `RATE_LIMITED`, a deferred intent |

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

On the control plane: `authenticateRequest` (every MCP and API request),
`POST /oauth/token` (client authentication, code redemption, refresh rotation),
`brain_whoami` and the establishing half of `brain_check_in`. Everything an
authentication merely *triggers* — token-use writes, session and credential
"last used" stamps, incident rows, the liveness write, the audit row on an
infrastructure failure — runs on the workload pool, so a browser polling the API
cannot spend the connections MCP authentication is reserved.

The control pool's connections are opened at boot and never idled out: in
session mode a client holds a backend while connected, so a reservation that let
its connections go would have to queue at the pooler for new ones exactly when
the pooler is saturated. Workload connections idle out after 10s (was 30s) so
they hand their backends back to operator scripts and the release harness.

## Check-in

1. **Establishing** (control plane): `recordWorkerArrival`.
2. **Choosing** (workload pool, bounded by `CHECK_IN_ADMISSION_BUDGET_MS` = 25s):
   candidates, admission, derive-on-empty. A candidate whose admission throws an
   infrastructure failure, or that is reached past the budget, is skipped
   quietly. An empty result after that is `RETRY_LATER`, and the arrival is
   recorded as an `UNSERVED_ARRIVAL` incident carrying its session.

## No-show accounting

`infra_incidents` rows mark Brain's own trouble: failures callers felt
(coalesced per minute per kind and surface), unserved arrivals (scoped to the
session), and `PROCESS_RESTART` windows derived at boot from `runtime_liveness`.
`affects_arrival = 1` only for a classified infrastructure failure at
`mcp:authenticate`, `http:auth`, `oauth:token` or `check_in:establish`, and for
restarts. An
unclassified exception (a bug) is logged, still answered 503, and recorded as
nothing. The adapter only counts what it feels; the recorder's own failed writes
are never incidents.

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

## Background writes

Token touches, incidents and liveness are written on the workload pool, one
flush at a time, outside any transaction the scheduling context carried, retried
for up to an hour with backoff, and bounded in memory.

## Reading it

`npm run report:connections -- --hours 24`, or the `Connection report` workflow.
