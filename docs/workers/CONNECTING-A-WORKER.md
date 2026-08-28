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

## 2. Grant it exactly what it needs

In **Grant access** on the same screen:

- **Worker** — `<worker>`
- **Project** — the Step 8 acceptance project (**not** Deal Dispatch)
- **Scopes** — tick only these six:

  `project:read` · `documents:read` · `queue:read` · `queue:claim` ·
  `queue:heartbeat` · `queue:complete`

Leave everything else unticked. The research scopes belong to Step 9, and
granting them now would make the "a scope it does not hold is refused" test
meaningless.

A worker administers nothing regardless of what is ticked — administration is
refused to a worker principal outright, in the policy, not here.

**The scope names imply more granularity than exists.** There is no
`queue:fail` and no `queue:release`: finishing an item, failing it and giving it
back are all gated by `queue:complete`, because they are one authority — the
right to stop holding this item. A worker with `queue:complete` can therefore
report a blocker and hand work back, which is what you want. Reading the names
alone suggests otherwise, and that inference has already been made once.

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

In Cowork or a Claude conversation, use the **"+"** control → **Connectors**, and
turn on **Cloud Brain** for that session.

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

`SYNTHETIC_ECHO` is the only registered work type, deliberately. The queue is
at-least-once — a lease can expire after a worker did something and before it
recorded that it did — so the only work it may carry is work that costs nothing
to perform twice. This one carries a short note and asks for it back, which
exercises claiming, the lease, heartbeats, fencing and completion without
touching a document or spending anything.

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
