# Step 8 — First Claude Max Worker: what was proven

Step 8 asked one question that no amount of testing could answer: **can a real
Claude, on a real subscription, act as a constrained Brain worker?**

Everything before it drove the Brain from scripts I wrote, and a script I wrote
will always behave the way I expected it to. This is the record of a real
Claude Max session doing it instead — what it actually did, what only the tests
cover, and the two things nobody has watched happen.

---

## The finding that shaped the step

Claude's custom connector has **no field for a static `Authorization` header**.
Its only authentication affordance is OAuth. So a Brain that could not speak
OAuth could not be connected to Claude at all, however correct its bearer design
was — and Step 7 had deliberately built none, on the reasoning that there was no
resource owner to redirect to.

That reasoning was wrong, and the correction is recorded in `CLAUDE.md` §22
rather than quietly fixed. There *is* a resource owner: the operator, in a
browser, at the moment the connector is registered. The mistake was conflating
that moment with the later tool calls, which genuinely have nobody present.
OAuth is built for exactly that shape — a human authorizes once, a machine acts
many times.

The half of Step 7's reasoning worth keeping is the half that still holds:
**never advertise a mechanism that is not served.** The discovery pointer is
emitted now because the flow behind it is real.

---

## The one property that had to hold

**A token resolves to the worker, never to the approver.**

A person signs in and approves; what the client receives is a token whose
principal is *that worker*. The human is recorded on the authorization code, for
the audit, and is deliberately absent from the token — there is no column on
`oauth_tokens` that could make an approver into a principal by accident.

Live, from a real Claude Max session:

```json
{"principalType":"WORKER","handle":"<worker>","memberships":[
  {"projectId":"prj_…","scopes":["project:read","documents:read",
   "queue:read","queue:claim","queue:heartbeat","queue:complete"]}]}
```

`principalType: WORKER`. Had that said `HUMAN` with the approver's handle, Step 8
would have been stopped rather than closed.

---

## The acceptance cycle, as it actually ran

One `SYNTHETIC_ECHO` item in an isolated project, through the deployed gateway,
from a real Claude Max session. In order:

| Call | Result |
|---|---|
| `brain_whoami` | `WORKER`, one project, six scopes |
| `brain_list_projects` | one project — the other **absent**, not refused |
| `brain_list_work` | the queued item |
| `brain_claim_work` | lease issued, generation **1**, attempt 1 |
| `brain_get_plan` | bounded context read |
| `brain_heartbeat_work` | lease extended, generation unchanged |
| `brain_release_work` | item returned to the queue |
| `brain_claim_work` | re-claimed, generation **2**, attempt 2 |
| `brain_heartbeat_work` *(stale generation 1)* | **refused** — "This lease is not current" |
| `brain_complete_work` | `SUCCEEDED` |
| `brain_complete_work` *(identical, again)* | **`ALREADY_RECORDED`** |
| `brain_get_work_item` | `SUCCEEDED`, result recorded, no lease held |
| `brain_get_project` *(an id it cannot have)* | "No such resource, or it is not available to you" |

The release was not planned. It was a scope probe built on an assumption I had
not checked — I expected `queue:release` to be a scope this worker lacked, and
there is no such scope: release is gated by `queue:complete`, which it holds. So
the call was entitled and did exactly what release is for.

It also produced better evidence than the plan would have. The re-claim advanced
the generation to 2, which left a genuinely dead lease to test fencing with,
rather than a fabricated generation number.

### What the replay proves

The item's `updatedAt` and `completedAt` are the same timestamp to the
millisecond. The second completion did not re-run and write a new one; it read
the record it collided with and handed it back.

Then the machine was restarted by a deploy, and a **different session holding a
different token** repeated the same completion:

```json
{"workItemId":"wki_…","state":"ALREADY_RECORDED"}
```

So the idempotency record lives in the database, not in a process's memory. If a
worker performs an effect and the machine dies before it can record that it did,
the retry does not do it twice. Until this moment that had only ever been proven
against tests written by the same person who wrote the code.

---

## Authorization, observed rather than asserted

Scopes could not be tested by picking a tool the worker lacked a scope for,
because **all fourteen tools together require exactly the six scopes granted**.
The grant is not a narrow slice of the surface; it *is* the surface. What
constrains this worker is what has no scope at all: it cannot enqueue, cancel or
administer anything, and it reaches one project.

So a scope was removed instead, and the pair below was run seconds apart on the
same worker, same token, same project:

| Tool | Scope | Result |
|---|---|---|
| `brain_get_project` | `project:read` — removed | refused |
| `brain_list_work` | `queue:read` — held | **worked** |

The refusal is about the missing scope, not about losing the project. It landed
on the very next call with no reconnect and no new token, because memberships
are read per request rather than frozen into a token — which is what makes
revoking access take effect immediately rather than whenever a token expires.

Removing a project entirely behaves the same way: it vanished from the worker's
`brain_list_projects` on the next call. **Absent, not refused** — a project the
caller may not have and a project that does not exist produce the same sentence,
so the refusal is not an oracle for what exists.

---

## Two product gaps found by using the thing

Both were found the same way — by trying to follow a runbook I had just written
— and both were blocking.

**There was no way to create a project.** Projects had only ever come from the
seeder, so the only project that existed was the one holding real research, and
the sole way to give a test worker somewhere to work would have been to grant it
that.

**There was no way to queue work from a browser.** A worker cannot enqueue its
own work — enqueueing is a project write and no worker scope grants it — so a
human needs a button, and there wasn't one. The alternative was `curl`, for the
operation whose entire purpose is proving the browser path works.

Both are marked in the code as scaffolding. In the finished product the planner
decides what work exists; nobody hand-queues an item. See `docs/ROADMAP.md`.

---

## Three faults on one screen, and what caused them

The operator console produced two real mis-grants inside ten minutes. All three
causes were mine.

1. **The dropdowns silently chose.** A `<select>` with no placeholder is pre-set
   to its first option, so a form submitted without opening it grants whatever
   sorts first. That is exactly how a worker meant for a throwaway project was
   granted the project holding real research. Both selects now start on a
   disabled `— choose —`.
2. **It could grant and not revoke.** Revoking existed only on the HTTP API, so
   the first misclick was one the screen that caused it could not undo. That is
   a ratchet rather than access control. Every membership now carries its own
   Remove.
3. **Eleven flat checkboxes put `work:complete` beside `queue:complete`.**
   Somebody ticking six quickly got that pair wrong — losing `queue:heartbeat`,
   gaining a scope no remote tool reads. They are grouped now, and the six a
   connector needs are marked. `work:complete` is not dead; one HTTP route
   requires it. It simply is not part of the remote surface, and a picker that
   could not say so invited precisely this.

Grouping the picker by hand costs something: a scope added later would not
appear, ungrantable, with nothing to notice. A test walks the scope enum and
asserts every one is present, and it was checked against its own inversion.

---

## A defect in the tests, found while checking a claim

I said a test proved that a disabled worker holding a **valid, unrevoked** token
is refused. The claim was true and I had cited the wrong test. Going to look
turned up something worse than the thing being checked.

Both MCP suites computed a tool call's `isError` from the JSON-RPC `result`. A
401 has no `result` at all, so `isError` read `false` **both when a call
succeeded and when it was rejected outright.** Sixteen assertions say
`expect(...isError).toBe(false)` to mean "this works", and nearly every one is
the setup half of a test: prove the token works, break something, prove it now
refuses.

That is the worst possible place for a false pass. A regression that broke
authentication outright would have turned those tests **green**.

Fixed in the two helpers rather than at sixteen call sites. All 150 tests across
the three suites still pass, so none were relying on the old reading — this
hardens against a future regression rather than papering over a current one.
Pointing one of those assertions at a garbage bearer now reports
`expected true to be false`; before, it passed silently.

---

## The verification matrix

`PROVEN LIVE` means a real Claude Max session did it against the deployed Brain.
`AUTOMATED` means the suite covers it and nothing else does.

| # | Item | Result |
|---|---|---|
| 1 | Step 4 identity regression suite | **EXECUTED — PASS** |
| 2 | Step 5 queue regression suite | **EXECUTED — PASS** |
| 3 | Step 6 idempotency/effect regression suite | **EXECUTED — PASS** |
| 4 | Step 7 MCP regression suite | **EXECUTED — PASS** — 67 + 18 |
| 5 | Existing SQLite regression suite | **EXECUTED — PASS** — 827 passed, 25 skipped |
| 6 | Existing PostgreSQL regression suite | **EXECUTED — PASS** — 848/848 |
| 7 | Typecheck | **EXECUTED — PASS** |
| 8 | Production build | **EXECUTED — PASS** — deploy 17 |
| 9 | Local production boot | **EXECUTED — PASS** |
| 10 | Secret-leak scan | **EXECUTED — PASS** |
| 11 | Step 7 tag verification | **EXECUTED — PASS** — `9a5791a3…`, lightweight |
| 12 | Claude Max feature/plan verification | **EXECUTED — PASS** — operator confirmed Max, connector present |
| 13 | Selected Claude surface verification | **EXECUTED — PASS** — connector registered and connected |
| 14 | Permanent worker creation | **EXECUTED — PASS** |
| 15 | Minimal project-membership grant | **EXECUTED — PASS** — one project |
| 16 | Minimal scope grant | **EXECUTED — PASS** — the six the surface requires |
| 17 | One-time credential issuance | **NOT APPLICABLE** — OAuth was used; no credential was issued or copied by hand. The path exists and is covered by the suite |
| 18 | Remote connector registration | **EXECUTED — PASS** — dynamic registration, no client id or secret typed |
| 19 | Real Claude MCP initialization | **EXECUTED — PASS** |
| 20 | Real Claude tool discovery | **EXECUTED — PASS** — 14 tools |
| 21 | Real Claude worker-identity resolution | **EXECUTED — PASS** — `principalType: WORKER` |
| 22 | Real Claude authorized project read | **EXECUTED — PASS** |
| 23 | Real Claude unauthorized project denial | **EXECUTED — PASS** — same body as a project that does not exist |
| 24 | Real Claude authorized-scope test | **EXECUTED — PASS** |
| 25 | Real Claude ungranted-scope denial | **EXECUTED — PASS** — by removing `project:read` live; see the note on why no tool could test it otherwise |
| 26 | Real Claude queue claim | **EXECUTED — PASS** |
| 27 | Real Claude heartbeat | **EXECUTED — PASS** |
| 28 | Real Claude checkpoint/finding/blocker mutation | **EXECUTED — PASS** — the completion's result and summary are the bounded item's durable output |
| 29 | Real Claude idempotent replay | **EXECUTED — PASS** — `ALREADY_RECORDED`, `updatedAt` unmoved |
| 30 | Real Claude conflicting-operation denial | **AUTOMATED** — the fingerprint-conflict path is covered by the Step 6 suite; the acceptance item had no conflicting variant to send |
| 31 | Real Claude completion or controlled failure | **EXECUTED — PASS** — `SUCCEEDED` |
| 32 | Real Claude terminal-state readback | **EXECUTED — PASS** |
| 33 | Real Claude stale-lease denial | **EXECUTED — PASS** — a genuinely dead generation, not a fabricated one |
| 34 | Credential revocation/rotation test | **NOT EXECUTED** — see below |
| 35 | Membership/scope removal test | **EXECUTED — PASS** — both, live, effective on the next call |
| 36 | Connector reconnect test | **NOT EXECUTED** — see below |
| 37 | Brain restart/redeploy persistence test | **EXECUTED — PASS** — every field byte-identical across a real restart |
| 38 | Fresh Claude-session persistence read | **EXECUTED — PASS** — a new session, a new token, same state, replay still `ALREADY_RECORDED` |
| 39 | Audit-attribution verification | **AUTOMATED** — `identity_events` records the token row as `credentialId`; not read back from production |
| 40 | Conversation/log/audit/repository secret scan | **EXECUTED — PASS** — no credential in chat, commits, logs or snapshots |
| 41 | Existing hosted authorized web workflow smoke test | **EXECUTED — PASS** — `HOSTED-VERIFICATION: PASS 121/121`, twice, either side of a restart |
| 42 | No full Step 9 packet ran | **CONFIRMED** — one `SYNTHETIC_ECHO`; no research executed, nothing spent |
| 43 | No Step 10 schedule exists | **CONFIRMED** |
| 44 | No Step 11 fleet work began | **CONFIRMED** — one worker |
| 45 | No Step 12 UI work began | **CONFIRMED** — the console is Step 8's own administration surface, and its scope is written down |

### Items 34 and 36, honestly

The worker was disabled and the next call was refused — but the console reported
**zero** tokens revoked, meaning nothing live was there to revoke. The token had
already aged out. So what was observed is an expiry, not a revocation, and the
two are indistinguishable from the client: the Brain answers 401 for every
reason deliberately, and the client renders any 401 as "token expired".

The property itself is not in doubt. It does not depend on revocation at all:

```ts
if (worker.disabled) return { ok: false, reason: 'PRINCIPAL_DISABLED' };
```

That runs on every request against the worker's current row. A disabled worker
is refused while holding a perfectly valid unrevoked token, and deleting that
line makes two tests fail with `expected 200 to be 401`. What is missing is
having watched it on production, and reconnecting afterwards.

Recorded as NOT EXECUTED rather than inferred from a refusal that has another
explanation.

---

## Carry-forward register

| Item | Disposition |
|---|---|
| **CF-7 — the real Claude worker is UNVERIFIED** | **CLOSED.** A real Claude Max session completed a bounded cycle against the deployed Brain |
| **CF-8 — a one-hour access token versus long research jobs** | **Step 10.** Refresh tokens are issued and valid for thirty days, but the client reported it could not re-authorize in a non-interactive session. If it does not refresh, an unattended job outliving the access token dies and needs a human. Harmless for a bounded echo; not harmless for scheduled work |
| **CF-9 — the console's live-connection count disagreed with the revoke** | **Open.** The count filters access tokens that are unrevoked and unexpired; the revoke matches every unrevoked token, a strictly larger set. They should not disagree, and they did. Most likely a stale render, but unexplained and not explained away |
| **CF-10 — a dropped connector does not re-attach to a running session** | **Known client limitation.** The tool list is assembled when a session starts, so re-enabling the toggle does not restore it. Work around it with a fresh session |
| CF-5 — a real archive migration | operator task |
| CF-6 — more than one instance | Step 11 |
| MCP rate counter is in-memory | Step 11 |

---

## What Step 8 does not claim

- **That the fleet works.** One worker connected. Two accounts interacting
  through OAuth is Step 11 and remains untested.
- **That research runs.** `SYNTHETIC_ECHO` is still the only registered work
  type, and research is deliberately not on the queue. Step 9.
- **That anything is scheduled.** Nothing fires on its own. Step 10.
- **That the acceptance session was neutral.** It was driven by the same session
  that built the Brain, which knows where the edges are. The Brain could not
  tell — it saw a token and resolved it to a worker — but a session that did not
  write the code would be better evidence, and the fresh-session checks in items
  38 and the readbacks above are the closest this step gets to that.
