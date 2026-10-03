# The connector lifecycle

This is the operator's reference for how a Claude connector authenticates to
Brain, how Brain tells a healthy connector from one that needs a person, and
what the one human action is when one does. CLAUDE.md §51 is the reasoning;
this is the mechanism and the commands.

## The cycle it ends

```
healthy connector
→ token expires, refresh stalls or its reply is lost
→ Claude marks the connector needs-auth
→ Routine still fires → session has no usable Brain MCP
→ brain_check_in never arrives → Brain counts no-shows
→ surface quarantined → person reconnects → repeat
```

Four earlier fixes (2026-09-27, 09-30, 10-01, 10-03) each moved a clock on the
refresh-recovery window. The structural holes behind all four:

1. **A second answer to one refresh was a second credential.** Every recovery
   minted a new random successor and retired the previous one, so a client
   that received the *earlier* answer — a late reply, or one of two racing
   sessions — held a token Brain had just revoked, with nothing descending
   from it. It could never recover.
2. **"Worker-10 authenticated" stood in for every account.** Airyn, Caleb and
   the owner can all connect as one worker; nothing recorded which Claude
   account's connector a token came from, so no reader could say whose
   connector was broken.
3. **An auth failure was charged as a worker no-show.** A connector that could
   not authenticate produced fires nobody answered, which quarantined the
   surface and then needed a person to remember `fleet set-state` after
   reconnecting.
4. **Consent offered a chooser.** An administrator reconnecting a connector saw
   every worker, preselected or not.

## Refresh: a state, not a clock

`server/repos/oauth.ts` · `rotateRefreshToken`

- A refresh token's successor is **derived**:
  `HMAC(key, presented-token-id | presented-secret)` under a server-held key
  (`oauth_rotation_keys`, or `BRAIN_OAUTH_ROTATION_KEY`). Presenting the same
  token again yields the **same** successor. Nothing recoverable is stored: the
  derivation needs the presented secret, which Brain never kept.
- Every token carries `grant_id` (the authorization it descends from),
  `revoked_reason` (`ROTATED` | `SUPERSEDED` | `EXPLICIT`) and `first_used_at`.
- Presenting an already-rotated token is judged by the grant's lineage:

  | condition (newer than the presented token, in its grant) | answer |
  |---|---|
  | any refresh token explicitly revoked | `REVOKED` |
  | a refresh token that was itself presented (rotated) | `REUSED` |
  | a token in use for longer than `CONCURRENT_REFRESH_LEEWAY_MS` (5 min) | `REUSED` |
  | otherwise | the same successor, with a fresh access token |

- The one clock left is the five-minute race leeway, and it applies only to
  "the successor has been in use": two sessions of one Routine refreshing on
  the same expiry can each start using the answer before the other's request
  commits, and the slowest rotation production measured took ~117 s.
- A rotation no longer revokes the presented token's access tokens; they live
  out their hour, so a sibling session is not cut off. Explicit revocation
  still revokes everything.
- **The accepted risk, stated.** Idempotent rotation means anybody holding a
  refresh token — the client or a thief — receives the *same* successor until
  that successor has been presented, or has been in use for longer than the
  leeway. A stolen token therefore converges on the legitimate chain rather
  than forking it, and a theft is not detected by divergence. That window
  existed before (a stolen token was always redeemable until its successor was
  used, and a REUSED refusal never revoked the thief's chain); what is new is
  the five-minute leeway after first use, and the absence of a fork. It is
  accepted because the alternative — refusing or revoking on the second
  presentation — is exactly what turned every lost reply into a manual
  reconnect, and because a refresh token is held only by Claude's connector
  store, never by a browser. A refusal still revokes nothing; family
  revocation on REUSED is deliberately not done, because a stale sibling
  session presenting an old token would then kill the live chain.
- A rotation also no longer revokes the presented token's access tokens: they
  live out their hour, so a sibling session is not cut off mid-call.
- A chain rotated before this change has a random successor nobody can re-send;
  its first retry supersedes it and issues the derived one (`RECOVERED`).
- The token endpoint lost two read-backs and a duplicate client read: one
  lookup of the presented token, one of the client, one of the worker, and a
  transaction of three statements. Registration was already one write.

## Identity: a logical connector

`server/repos/connectors.ts` · `server/services/fleet/connectorBinding.ts`

A connector is **(fleet account, endpoint)** — Claude refuses a second custom
connector at a URL one already holds, so that pair names exactly one. Every
OAuth client that was ever that connector is kept in `connector_clients` with
its evidence; `fleet_routines.connector_id` says which connector a Routine's
sessions authenticate through.

Attribution, never guessed from a worker id:

- **Observed arrival.** Brain fired Routine R (account A); the session that
  arrived authenticated with a token from client C for endpoint E. Accepted only
  when the provider session matches the dispatch row, or every Routine bound to
  that worker is in one account. The tick's derivation from `worker_sessions`
  trusts only the second: those rows are written under the fired Routine's
  account even when nothing proves the session was that fire.
- **Member-bound consent.** Read through the member's capacity connection *for
  the same worker*, so a research connection cannot attribute a Factory client.
- **Bound reconnect.** An invitation carrying `connector_id` attaches whatever
  client Claude presents at consent to that connector.
- **Operator.** `admin connectors attach <brnc_…> <trig_…>`.

Evidence naming more than one account attaches nothing; the connector stays
`UNKNOWN`. A client is never re-pointed. Existing connectors are derived on the
dispatch tick (every five minutes) from recorded arrivals and consents — nobody
reconnects to be migrated.

## Health: one projection

`server/services/fleet/connectorHealth.ts`

| state | means | dispatch |
|---|---|---|
| `HEALTHY` | holds a live credential and is using it (or idle with a live refresh) | routable |
| `REFRESH_RECOVERABLE` | the last rotation's answer was not picked up; its next retry gets the same successor | routable — fires are the retry; an unanswered one is charged to auth |
| `HUMAN_REAUTH_REQUIRED` | proven unrecoverable without consent (below) | refused by `surfaceIneligibility` |
| `DISABLED` | the worker is disabled | refused already |
| `UNKNOWN` | no client attributed yet | routable (an unknown can only waste a fire) |

`HUMAN_REAUTH_REQUIRED` reasons, each read from a row:

- `CLIENT_HOLDS_REFUSED_CREDENTIAL` — the client's last refresh was refused and
  it has not authenticated since. Under idempotent rotation a refusal means the
  token was explicitly withdrawn or provably superseded.
- `CLIENT_STOPPED_RETRYING` — the last rotation's answer was never picked up and
  `AUTH_NO_SHOW_LIMIT` (3) fires since never presented a credential. Brain would
  still answer a retry; the client has stopped asking (Claude's needs-auth).
- `CONSENT_REVOKED` — explicitly withdrawn.
- `CREDENTIALS_EXPIRED` — every refresh token expired unused (30 days idle).
- `CLIENT_DISABLED`, `NEVER_AUTHORIZED`.

Configured is not authenticated, authenticated is not observed, and a past
delivery proof is not a present answer: nothing in the projection reads a
delivery proof or a Routine's state column.

## Dispatch

- **Routing.** `fleetSnapshot` attaches each Routine's connector health;
  `surfaceIneligibility` refuses `HUMAN_REAUTH_REQUIRED` with the reason. The
  surface comes back by itself when consent is renewed — nothing re-enables it.
- **No-show attribution.** `reopenNoShowDispatches` writes
  `DISPATCH_AUTH_NO_SHOW` instead of `DISPATCH_NO_SHOW` when the fired Routine's
  connector is `REFRESH_RECOVERABLE` or `HUMAN_REAUTH_REQUIRED`. The quarantine
  count reads only `DISPATCH_NO_SHOW`; the connector's health reads the other.
  A healthy connector's no-show still quarantines.
- **Recovery.** `recoverReauthorizedSurfaces` (every dispatch tick) re-enables a
  Routine quarantined for unanswered fires once *its own* connector is `HEALTHY`
  with a **new consent** (an authorization-code grant) after the quarantine —
  never a sibling account's, and never on token use alone: every Routine in an
  account shares its connector, so a sibling's session would otherwise lift a
  surface whose own trigger is what never answers.
  The forgiveness boundary means a connector that was not actually fixed is
  quarantined again three unanswered fires later.
- A consent that attaches a client touches the connector's Routines, which
  re-arms dispatch intents deferred while it could not authenticate.

## Consent

`server/routes/oauth.ts` · `boundWorkerFor`

The consent screen names one worker and offers nothing else when Brain already
knows it: a client attributed to a connector (which outranks anything else,
because a client is never re-pointed), or an invitation in the browser (cookie,
or the one live invitation bound to the signed-in member). The approval refuses
any other worker, administrator or invited. A reconnect invitation attaches the
client to its connector only when the client asked for that connector's own
endpoint, and only a client that actually attached re-arms the Routines. A chooser appears only for an
unattributed client approached without an invitation.

### A signed-in member reconnecting their own connector

`server/services/fleet/memberReconnect.ts` · `resolveMemberReconnect`

A member with no unspent invitation, signed in to Brain in the browser Claude
opens, reconnects their own connector without an administrator. The screen
offers the connector's worker only when every one of these holds, each read
from a row:

- the browser has an authenticated person;
- exactly one connector at the endpoint the request names (`resource`) belongs
  to them — proven only by a `BOUND_INVITATION` attachment whose recorded
  `invitation_id` names this member and this connector (not a capacity
  connection, whose account is found by a normalized name; not an earlier member
  reconnect, which would renew itself; not an inferred or `INVITATION_MEMBER`
  attachment; not a consent matched to a public client id), and not given back
  (a REVOKED capacity connection for that account and worker voids the claim);
- no other person has a claim to that connector;
- the client is not already attached to a different connector;
- the worker is live, nothing on the connector was explicitly revoked since its
  last grant (read from the token rows, because a refused refresh after a
  revocation changes the health verdict), and none of its clients is disabled;
- the request asks for no scope its earlier grants did not carry.

The approval re-asks all of it and records the member as the approver; the new
client is attached as `MEMBER_RECONNECT` on the same connector when its code is
redeemed with the verifier and the client's secret, not at approval, because a
`client_id` is public — and only after the whole question is asked again at
redemption, so a withdrawal inside the code's lifetime holds. An invitation
spent on a client that is already a connector must name that connector. Anything
else is refused by name (`ENDPOINT_UNSPECIFIED`, `NO_CONNECTOR_FOR_MEMBER`,
`AMBIGUOUS_CONNECTORS`, `CONNECTOR_SHARED_WITH_ANOTHER_MEMBER`,
`CLIENT_ATTACHED_ELSEWHERE`, `WORKER_UNAVAILABLE`, `CONSENT_REVOKED`,
`SCOPE_NOT_PREVIOUSLY_GRANTED`) on a page that says the account is signed in
and names the bound reconnect link as the next step. A signed-in person is never
shown the sign-in page. Every `OAUTH_AUTHORIZE_PAGE` row carries `decision`,
`userId`, `clientId`, `endpoint`, `connectorIds` and `reason`.

## When a person is genuinely needed

Only for a `HUMAN_REAUTH_REQUIRED` connector. Prepare everything with:

```
npm run admin -- connectors reconnect <cnr_…|trig_…> <user id> --admin <email>
```

(or the Admin workflow, command `connectors reconnect`, subject the connector or
Routine, object the user id). It issues one invitation bound to that member, the
connector's worker and the connector; withdraws older reconnect links for the
connector; prints no link.

**The one human action:** sign in to Brain in the browser Claude uses,
reconnect the connector from Claude, approve the worker already chosen.
Afterwards: the client is attached to the same connector, its Routines re-arm,
an auth-caused quarantine lifts on the next tick, and no trigger, Routine or
secret is recreated.

## Reading it

```
npm run admin -- connectors show
```

Per connector: account, endpoint, worker, Routines, health and reason, whether
human action is required and why, current and historical client ids, the last
registration, grant, refresh, recovered refresh and access-token use, the last
refusal category, the last fire and check-in, real no-shows and auth no-shows.
No token, digest or prefix is printed. `connectors derive` runs the attribution
now; `connectors attach` is the explicit binding.

## What it cannot fix

- **A reply lost before Brain received the request.** If Claude's refresh never
  reaches Brain, Brain sees only silence: no rotation, no refusal. Fires then
  read as ordinary no-shows. Brain cannot distinguish that from a Routine that
  is not starting or a usage limit.
- **Claude's own needs-auth state.** When Claude marks a connector as needing
  authorization after a timeout, only a consent in Claude clears it. Brain
  answers every retry correctly and quickly; it cannot make Claude retry. That
  is why `CLIENT_STOPPED_RETRYING` exists and why its remedy is one bound
  reconnect rather than a loop.
