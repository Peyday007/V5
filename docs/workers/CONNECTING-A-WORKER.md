# Connecting a Claude worker

How a Claude Max subscription becomes a constrained Brain worker. Twelve
minutes, once, and no credential is ever copied by hand.

---

## What you are actually doing

You are **not** pasting a key into Claude. You are telling Claude where the
Brain lives, and then signing in to the Brain to approve a worker.

```
Claude  ──"who are you?"──▶  Brain /mcp
        ◀──"nobody. authenticate here"── 401 + pointer

Claude  ──registers itself──▶  Brain /oauth/register
Claude  ──sends your browser──▶  Brain /oauth/authorize

        YOU sign in to the Brain and pick a worker

Brain   ──token for that worker──▶  Claude
```

The token Claude ends up holding is **the worker's**, not yours. You are the
person who granted it; you are not the identity Claude acts as. You can revoke
it at any time without changing your own password or anything else.

---

## 1. Create the worker

Sign in to the Brain, then go to **`/operator`**.

> `https://northline-brain.fly.dev/operator`

This screen is only reachable by a Brain administrator. To anyone else — signed
out, an ordinary member, or a worker holding a token — it answers *404*, because
a console that announces itself to whoever guesses the path is a map of what to
attack.

**Create a worker:**

| Field | Value |
|---|---|
| Canonical name | lower case, digits and hyphens — e.g. `worker-01` |
| Display name | anything readable — e.g. `Worker 01` |

A worker is not a person and not your Claude account. It is an identity the
Brain owns. Number them rather than naming them after whoever lent the account:
the Brain never sees Claude accounts, and a name that implies otherwise will
mislead somebody reading an audit row later.

Below, `<worker>` means whatever canonical name you chose here.

## 2. Give it a project

In **Grant access** on the same screen, choose the worker and the project, and
click **Grant**. There is nothing else to fill in.

Point a new worker at a throwaway project rather than the one holding real
research. A worker's first run writing into work you depend on is what an
isolated project prevents.

**You do not choose what it may do.** The Brain sets that: exactly what the
remote tools require and nothing else. Composing a scope list by hand was a job
with no judgement in it and two ways to get wrong, and both happened within ten
minutes of that screen existing — a worker granted the wrong project, and
`work:complete` ticked in place of `queue:heartbeat` because the names sit
beside each other and one of them no remote tool reads.

Scopes still exist and still matter. They bound what a stolen credential
reaches, and they will matter more once research tools land and "reads
evidence" stops being the same thing as "writes findings". What changed is who
composes the set.

**What actually constrains a worker is what has no scope at all.** It cannot
create work, cancel work, or administer anything — that is decided in the
policy, not on this screen, and no grant here can change it.

## 2a. If the account is not yours — send an invitation

Everything below assumes you are sitting at the machine whose Claude account is
being connected. When you are not — a friend's account, a second laptop — do
this instead and skip to *Checking it worked*.

On `/operator`, click **Invite** beside the worker. You get a link, shown once.
Send it to whoever holds the account. They:

1. open the link — this connects nothing, it just tells their browser which
   worker it may connect;
2. add the connector in their own Claude, exactly as in step 3 below;
3. click **Connect**, and **Approve** on a screen naming that one worker.

They never sign in here, never get a Brain account, and can connect only that
worker, once, before the link expires.

**Why a link rather than an account for them.** The connection begins and ends
in the browser Claude opened, and the consent screen requires an administrator —
so connecting somebody else's account would otherwise mean standing at their
keyboard or making them an administrator. An administrator can create workers,
grant any project and issue credentials. The people lending an account hold no
research here and need no login; giving them one to click a button is the wrong
trade. So the approval moves earlier instead of moving machines.

**Treat the link like a password until it is used.** Anyone holding it can
connect that worker. A used one is dead, and **Remove** on the worker withdraws
any that are still outstanding.

## 3. Register the connector in Claude

Go to **Settings → Connectors → Add custom connector**.

| Field | Value |
|---|---|
| Name | `Cloud Brain` |
| Remote MCP server URL | `https://northline-brain.fly.dev/mcp` |

**Leave Advanced settings empty.** The OAuth Client ID and Secret boxes are
optional, and the Brain registers Claude automatically the first time it
connects. Filling them in with invented values will break the connection.

Click **Add**.

The URL carries no credential, no project id, no worker id and no token. If you
are ever asked to put one in a connector URL, something is wrong.

## 4. Connect it

Claude will show the connector with a **Connect** button. Click it.

Your browser goes to the Brain:

1. **Sign in** with your ordinary Brain account, if you are not already.
2. **Connect a worker** — a list of your workers, each showing exactly what it
   can reach. Choose `<worker>`.
3. **Approve.**

You come back to Claude, connected.

If the list shows a worker with *"no project yet"*, go back to step 2 — a worker
with no membership can do nothing, and the Brain refuses to connect one rather
than issuing a token that would puzzle you later.

## 5. Enable it for the session

**In Cowork.** Use the **"+"** control → **Connectors**, and turn on
**Cloud Brain** for that task.

Cowork is the selected worker surface — see §22 of `CLAUDE.md`. An ordinary
Claude conversation can hold the connector too, and the Brain cannot tell the
difference, but it is a fallback for a one-off rather than the workflow. A step
or a runbook that assumes chat is following `STEP-8-PLAN.md` §1, which is
superseded.

Claude asking your permission to run a tool is *its* safety check. It is not the
Brain's. A tool the Brain refuses stays refused however many times you click
Allow.

## 6. Give the worker its contract

Paste [`WORKER-CONTRACT.md`](WORKER-CONTRACT.md) into the project or
task instructions, or point at it. The repository copy is authoritative; if the
two ever disagree, the repository is right and the pasted one is stale.

## 7. Give it something to do

Back on **`/operator`**, in **Give a worker something to do**:

- **Project** — the same acceptance project
- **Note** — anything short, e.g. `Step 8 acceptance item`

Click **Queue a synthetic echo**. The green line names the item's id, and **The
queue** card below lists it as `QUEUED`.

**There are two kinds, and the difference is the point.**

`SYNTHETIC_ECHO` carries a short note and asks for it back. It exercises
claiming, the lease, heartbeats, fencing and completion without touching a
document or spending anything — and it proves the queue and nothing else,
because a worker that never read the note would look identical to one that did.

`SUMMARIZE_PASSAGE` cannot be faked. Paste a paragraph, optionally a question,
and the worker has to read it and produce something that depends on it. That
costs a little of the connected account's allowance, which is the reason to use
it: an end-to-end test that spends nothing has not tested the part where
spending happens.

Both stay inside what the queue requires. It is at-least-once — a lease can
expire after a worker did something and before it recorded that it did — so
everything it carries must be safe to perform twice. The passage travels in the
item, bounded, so nothing is fetched and no document is touched, and a repeat
cannot record a second result.

**A worker cannot do this for itself.** Enqueueing is a project write and no
worker scope grants it, so a machine credential is refused however its
membership is configured. That is why there is a button rather than a tool: a
machine that could create its own work could also create work nobody asked for.

---

## Checking it worked

Ask the worker to run `brain_whoami`. You should see:

- `principalType: WORKER`
- `handle` matching the worker you approved
- exactly one project, with exactly the six scopes

If it says anything else — especially if it names *you* — stop and say so. That
would mean the token resolved to the approver rather than the worker, which is
the one thing this design must never do.

## Revoking

**One connection:** `/operator` → **Disable** the worker. Every live token for
it is revoked immediately, not at expiry.

**Re-enable:** the same button. It will need connecting again — disabling ends
the grant, it does not suspend it.

**Rotating:** disable, re-enable, reconnect. The worker id, its project and its
scopes all survive; only the token changes.

Revoking a worker never touches your account, your password, or your own access.

## What this never involves

- Your Claude password, cookies, or Anthropic session — the Brain stores none of
  them and has no column that could.
- An Anthropic API key. This is your Max subscription, not metered usage.
- A credential you copy by hand. The **Issue a credential** button on
  `/operator` exists for a client that cannot do OAuth; Claude does not need it.
- Any database, storage or deployment access. The worker reaches the Brain's
  tools and nothing behind them.

## When something is wrong

**"Connect" does nothing, or errors immediately.**
Check the URL is exactly `https://northline-brain.fly.dev/mcp` with no trailing
slash and nothing after it, and that Advanced settings is empty.

**The consent screen says the Brain has no workers.**
Step 1 did not save. The worker list on `/operator` is the truth.

**The worker connects but every tool refuses.**
It has no project membership, or not the scope that tool needs. `brain_whoami`
tells you what it actually holds — trust that over what you meant to grant.

**You want to start over.**
Remove the connector in Claude (there is no edit — remove and re-add), disable
the worker in `/operator`, and begin at step 1. Nothing accumulates.
