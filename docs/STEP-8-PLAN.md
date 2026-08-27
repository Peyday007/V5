# Step 8 — First Claude Max Worker: the implementation map

Written before any account change, because the inspection turned up two things
that decide the shape of the step and one of them contradicts a decision Step 7
made deliberately.

---

## 0. What the inspection established

### 0.1 Step 7 is genuinely closed, and its tag is accurate

| Fact | Value |
|---|---|
| Branch | `claude/zealous-hypatia-78a2yp` |
| Local HEAD = remote HEAD | `9a5791a3c81b712121d0fd39a75e768f476b7ac3` |
| Worktree | clean |
| `step-7-authoritative-remote-mcp` | → `9a5791a3c81b712121d0fd39a75e768f476b7ac3` |
| Tag object type | **lightweight**, not annotated |

The tag points at the right commit and matches HEAD, so §3's stop condition does
not apply and Step 8 may proceed. The tag is *lightweight* rather than annotated
because it was created through the GitHub release UI — the same as Steps 4, 5
and 6, since tag pushes from the build environment are refused `403`. §3 says not
to move or recreate an accurate Step 7 tag, so it stays as it is and is recorded
here honestly rather than described as annotated.

Production was last proven at deploy run 11 (`HOSTED-VERIFICATION: PASS 114/114`
before a restart, `120/120` after). This environment cannot reach
`northline-brain.fly.dev` — `curl` returns `CONNECT tunnel failed, response 403`
— so live re-verification runs through the deploy workflow, as it has since
Step 3.

### 0.2 The Step 7 carry-forward register

**One item is assigned to Step 8, and it is the reason this step exists.**

| Item | Disposition |
|---|---|
| **CF-7 — the real Claude/Antigravity worker is UNVERIFIED** | **Step 8's to close** |
| CF-5 — a real archive migration | operator task, not Step 8's |
| CF-6 — more than one instance | Step 11 |
| MCP rate counter is in-memory | Step 11 |

### 0.3 Claude's custom connector authenticates by OAuth — and Step 7 built none

This is the finding that shapes the step.

From Anthropic's current custom-connector documentation, the individual Pro/Max
path is:

> 1. Navigate to **Settings > Connectors**.
> 2. Locate the "Connectors" section.
> 3. Click **"Add custom connector"** at the bottom of the section.
> 4. Add your connector's remote MCP server URL.
> 5. Optionally, click **"Advanced settings"** to specify an **OAuth Client ID**
>    and **OAuth Client Secret** for your server.
> 6. Finish configuring your connector by clicking **"Add."**

and on security:

> When you add a custom connector to Claude, you'll typically go through an
> **OAuth authentication process** to securely sign in to the application and
> grant specific permissions.

**There is no documented field for a static bearer token or a custom
`Authorization` header.** That is corroborated by open issues on
`anthropics/claude-ai-mcp` — #112 *"Cannot configure Authorization: Bearer for
custom remote MCP (only OAuth client id/secret in advanced settings)"* and #411
*"Custom MCP connector incompatible with Bearer token auth"*.

Step 7 deliberately implemented **the Step 4 worker credential as a bearer token
and explicitly no OAuth**, on the reasoning that OAuth here would be "theatre"
because "there is no resource owner to redirect."

**That reasoning is wrong for this surface, and Step 8 is where it shows.** In
the connector flow there *is* a resource owner to redirect: the person who
administers the Brain, who is signed into it, and who grants Claude the right to
act as a constrained worker they own. The redirect is not ceremony around a
check that was going to happen anyway — it is how a human authorizes a machine
identity without ever handing Claude a long-lived secret.

There is a reported **beta** capability — static request headers
(`static_headers`) — that would let a fixed `Authorization` header be configured
when adding a connector. Reporting associates it with *organization*
administrators, describes a gradual rollout that "may not appear in your account
yet", and issue #685 is titled *"Enable static request headers for **Cowork**
custom connectors"*, which implies Cowork does not have it. **Whether it exists
in this particular individual Max account cannot be established from
documentation.** It is the one fact that decides which of the two branches below
Step 8 takes, and only looking at the account can settle it.

### 0.4 The Brain has no administrator interface for workers

`client/src/components/` contains no admin, worker or credential screen. The
admin API exists — `POST /api/admin/workers`,
`POST /api/admin/projects/:id/members`,
`POST /api/admin/workers/:id/credentials` — but only over HTTP.

That matters because of how a credential must be handled. It is shown exactly
once and must go straight into the connector's configuration without passing
through this conversation, the repository, CI logs, a screenshot or a shell
history. With no UI, the only ways to create the worker are `curl` from the
user's terminal (which puts the plaintext in terminal output and shell history)
or a CI step (which puts it in a workflow log). **Both are refused by the
security rules, so Step 8 builds the smallest administrator screen that lets the
credential be created and copied once inside the browser.** It is an operational
addition, not a change to the security model: it calls the Step 4 admin routes
that already exist, behind the Brain-administrator guard that already protects
them.

---

## 1. Selected Claude surface

**Primary: Claude on the web, with a dedicated Project.**

- Custom connectors via remote MCP are documented as available on Claude,
  Cowork and Claude Desktop for Free/Pro/Max/Team/Enterprise, with no connector
  cap above Free.
- Projects persist instructions, which is how the worker operating contract
  reaches the worker on every run without being re-pasted.
- Connectors are enabled per conversation from the **"+"** control, so the
  worker's connector is not live in unrelated chats.
- The connector runs from Anthropic's infrastructure, not the user's laptop, so
  the hosted HTTPS endpoint is the network target and no local MCP fallback is
  involved.

**Cowork is the alternative** and may be the better long-term worker surface,
being built for bounded multi-step tool work. It is not selected first because
the static-header capability that one branch below depends on is reported as
*not* available for Cowork, and because Projects give a cleaner place to pin the
operating contract. The choice is recorded so it can be revisited in Step 10.

**Excluded: the Anthropic API.** Step 8 is explicitly a Claude Max
subscription-backed worker. Using an API key would be easier to automate and
would prove the wrong thing.

## 2. Connector registration path

`Settings → Connectors → Add custom connector`, name `Cloud Brain`, URL
`https://northline-brain.fly.dev/mcp`.

The URL carries no credential, no project id, no worker id, no session token and
no query string. It is exactly the canonical Step 7 endpoint.

## 3. Brain worker identity

One permanent worker, `claude-max-worker-01`, created through the authenticated
administrator surface. Not a human user, not the user's Claude account, not an
API key, not a shared password, not a synthetic test worker.

## 4. Project membership

**One project only** — a clearly labelled Step 8 acceptance project, created for
this purpose so no fabricated finding ever lands in canonical research. The
worker is granted membership in that project and nowhere else. It gets no access
to Deal Dispatch.

## 5. Scopes

The minimum the acceptance cycle needs:

| Scope | Why |
|---|---|
| `project:read` | read the project and its plan |
| `documents:read` | read bounded document text and search evidence |
| `queue:read` | see its own work |
| `queue:claim` | take the acceptance item |
| `queue:heartbeat` | hold the lease |
| `queue:complete` | complete, fail or release it |

Not granted: `research:*`, `claims:write`, `sources:write`,
`contradictions:write`, `checkpoints:write`, `work:complete`,
`blockers:report`. Those belong to Step 9's packet, and granting them now would
make the ungranted-scope denial test meaningless. **No Brain-administrator
authority, and none is grantable to a worker anyway** — `policy.ts` refuses
`ADMIN` for a worker principal regardless of scopes held.

## 6. Authentication flow — two branches

The branch is chosen by what the connector dialog actually offers.

### Branch A — the connector can send a static `Authorization` header

Nothing in the gateway changes. Step 7 is compatible as built.

The administrator issues a worker credential, it is shown once in the browser,
and it is pasted directly into the connector's header field. Step 8 requires no
deployment, which is the outcome §19 explicitly allows.

### Branch B — the connector offers OAuth only

This is a **real Step 7 compatibility defect**, and §4 requires correcting the
smallest permanent gateway issue rather than adding a workaround.

The correction makes Brain an OAuth 2.1 resource server *and* a minimal
authorization server, per the MCP authorization profile:

- `GET /.well-known/oauth-protected-resource` — RFC 9728 protected resource
  metadata, which the specification makes mandatory for a server that supports
  authorization.
- `401` with `WWW-Authenticate: Bearer resource_metadata="…"` on `/mcp`.
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata.
- `POST /register` — Dynamic Client Registration, because the connector's OAuth
  client id and secret are optional and a client that is given neither must be
  able to register itself.
- `GET /authorize` — **the consent screen, and the load-bearing part.** The
  human signs in to Brain as themselves, is shown exactly which worker identity,
  which project and which scopes Claude is asking to act with, and approves. The
  authorization code is bound to `claude-max-worker-01`.
- `POST /token` — PKCE required, exchanging the code for an access token whose
  principal **is the worker**, not the human.

The invariant that must survive: **a token issued this way resolves to the
worker principal.** The human is the resource owner who grants it; they are not
the identity Claude then acts as. Everything downstream —
`decideProjectAccess`, the scopes, the queue fencing, the audit attribution —
keeps working unchanged, because it only ever sees a `Principal` of type
`WORKER`. No Claude account credential, cookie or token is ever stored by Brain.

Branch B also requires: every Step 4–7 regression suite re-run, the Step 7
evidence corrected rather than rewritten, and the deploy re-verified.

**Branch A is strictly preferable and is tried first**, because it needs no
change to a closed step.

## 7. Credential handling

- Issued through the authenticated administrator screen, using the existing
  scrypt/sha-256 mechanism. Only the digest is stored.
- Shown exactly once, in the browser, with a copy control.
- Copied straight into the connector configuration or the user's password
  manager.
- Never into: this conversation, Claude chat, repository files, `.env`,
  screenshots, issue trackers, documentation, command output, MCP URLs, query
  parameters, tool arguments, project instructions, prompts or audit metadata.
- Revocation and rotation stay available and are exercised as an acceptance
  test.

## 8. Worker operating contract

`docs/workers/CLAUDE-MAX-WORKER-01.md`, version-controlled, covering identity,
the startup sequence, authority, lease behaviour, idempotency, research
behaviour, completion, failure, and prompt-injection resistance. The repository
copy is authoritative; the Claude Project instructions point at it and carry the
smallest safe summary needed to bootstrap a run.

## 9. Acceptance work item

One `SYNTHETIC_ECHO` item in the Step 8 acceptance project. It exercises the
whole contract and nothing consequential: claim, read the project, read bounded
context, heartbeat, one idempotent mutation, retry it and observe replay,
complete, read back the terminal state.

It executes no research layer, produces no packet, sends nothing, buys nothing,
changes no provider configuration, touches no unrelated project and performs no
irreversible external effect.

## 10. Expected MCP call sequence

1. `brain_whoami`
2. `brain_list_projects`
3. `brain_list_work`
4. `brain_claim_work`
5. `brain_get_work_item`
6. `brain_get_plan` / `brain_search_evidence`
7. `brain_heartbeat_work`
8. `brain_complete_work` — with a stable derived key
9. `brain_complete_work` again — same key, expecting `ALREADY_RECORDED`
10. `brain_get_work_item` — terminal state readback

Plus the denial probes: `brain_get_project` on an unauthorized id, and a tool
whose scope was not granted.

## 11. Evidence collection

Durable Brain records first, screenshots only as supplement and only redacted:
`workers` and `worker_credentials` rows, `project_members`, `work_items`,
`work_leases`, `idempotency_operations`, and `identity_events` showing
`MCP_TOOL_CALL` attributed to the worker's credential id.

## 12. Revocation and recovery tests

Credential revocation, scope removal, membership removal, lease loss, connector
reconnect, and a Brain restart followed by a fresh Claude session reading the
same authoritative state.

## 13. Explicit exclusions

- **Step 9** — no full research packet, no first production packet.
- **Step 10** — no schedule, no recurring firing, no unattended orchestration,
  no generalized interruption recovery.
- **Step 11** — no second worker, no fleet controls, no capacity accounting, no
  routing across accounts.
- **Step 12** — no control-centre redesign.
- No Anthropic API key anywhere. No Claude account credential, cookie or token
  stored in the Brain. No administrator tool exposed to Claude. No Claude-only
  privileged endpoint. No global project access. No blanket scope grant.

---

## The one thing that cannot be settled from here

Whether this account's **Add custom connector** dialog offers a request-header
field decides Branch A or Branch B, and it is a property of the account's
feature rollout rather than of the documentation. It needs one look at the
dialog before any account change is made.
