# Connecting the Factory worker

Everything Brain can do by itself is already done. What is left is four things
that happen inside a Claude account and one Fly secret, and this file is the
whole of it — every name, URL, branch and command is written out, because a
runbook with a value left to invent is a runbook that produces a surface Brain
will refuse for a reason nobody can see.

Read once before starting: **step 2 must happen in the same browser as step 3,
and before it.** That is the only ordering in here that cannot be recovered from
by trying again.

---

## What you are connecting, and why it is a second connector

A Claude connector authenticates with OAuth, and **the credential Brain issues is
per connector**. So one connector is exactly one Brain worker identity, however
it is labelled — and the converse is what matters here: *renaming* a connector
separates nothing, and pointing the existing research connector at a factory
Routine would make the factory worker and the research worker the same identity
again. Brain's routing boundary is keyed on the authenticated worker, so it would
then have nothing to separate.

Both connectors may live in **one Claude account**. A second subscription is not
required and is not what this buys.

| | Research | Software Factory |
|---|---|---|
| Connector name in Claude | `Cloud Brain` | `Factory Brain` |
| Tool prefix it produces | `mcp__cloud-brain__*` | `mcp__factory-brain__*` |
| Brain worker it authenticates as | the existing research worker | `factory-brain-worker-bootstrap` |
| What it may be handed | research and general work | `FACTORY` work for one repository |

Both prefixes are pre-approved in
[`Peyday007/brain-worker-bootstrap`](https://github.com/Peyday007/brain-worker-bootstrap)'s
checked-in `.claude/settings.json`, which is what stops a fired worker halting at
a permission prompt with nobody there to answer it.

---

## 1. Onboard the repository, in Russell

Brain → **Build** → **Repositories**.

Two are authorized. For this first campaign, onboard the first:

| Grant | Remote | What it is |
|---|---|---|
| `brain-worker-bootstrap` | `https://github.com/Peyday007/brain-worker-bootstrap` | the proving ground. No application code, no project data, no credentials. |
| `oakwood-site` | `https://github.com/Peyday007/oakwood-junk-removal` | the real target, for later. It has its own continuous integration. |

Press **Onboard this repository**. Brain creates the worker
`factory-brain-worker-bootstrap`, gives it the fixed factory scope set, writes an
exhaustive routing row for that one repository, and shows **one invitation link,
once**.

**Copy the link now.** If you lose it, press the button again — onboarding is a
repair and a rotation, so the second press reuses the same worker, revokes the
lost invitation and issues a fresh one. Nothing accumulates and nothing else
changes.

The link is not a credential. On its own it cannot read anything, call a tool or
obtain a token; all it does is make one browser able to approve **that one
worker**.

---

## 2. Open the invitation link — first, and in the browser you will use

Paste the link into the browser you are going to authorize the connector from,
and open it. You should see *"You are ready to connect — this browser can now
connect Factory · Peyday007/brain-worker-bootstrap, and nothing else."*

Leave that tab open. Opening the link does **not** spend the invitation; it is
spent when a connection is actually authorized.

If you do step 3 first, the consent screen will offer you the full list of
workers instead of that one, and choosing wrongly there is exactly the mistake
this ordering exists to prevent.

---

## 3. Add the connector in Claude

**Settings → Connectors → Add custom connector.**

| Field | Value |
|---|---|
| Name | `Factory Brain` |
| Remote MCP server URL | `https://northline-brain.fly.dev/mcp` |

**Leave Advanced settings empty.** The OAuth client id and secret are optional
and Brain registers Claude automatically; inventing values there breaks the
connection.

Click **Add**, then **Connect**. In the browser:

1. sign in to Brain if you are not already;
2. the consent screen names **one** worker — `Factory · Peyday007/brain-worker-bootstrap`;
3. **Approve.**

The name must be that one. If you are shown a list to choose from, the
invitation cookie from step 2 is not in this browser — go back to step 2.

---

## 4. Create the Routine, in Cowork

| Setting | Value |
|---|---|
| Repository | `Peyday007/brain-worker-bootstrap` |
| Branch | `main` |
| Connectors enabled | **`Factory Brain` only** |
| Schedule | none |
| API trigger | on |

**Connectors is the setting that decides identity.** Enable `Factory Brain` and
turn `Cloud Brain` **off** for this Routine. A session that could reach Brain as
either identity is a session Brain cannot separate, and the whole boundary
depends on the arriving worker being one worker.

**Repository is the setting that decides whether the session can act.** The
worker reads `.claude/settings.json` out of that checkout, which is what
pre-approves the connector's tools. It is also the repository the first campaign
works in.

**No schedule.** Brain fires this Routine when a bin is ready — that is what the
API trigger is for, and a timer is the wrong answer to a question somebody is
asking now.

Use the current permanent Brain Worker prompt
([`WORKER-CONTRACT.md`](WORKER-CONTRACT.md)). It must not name a bin, a project,
a packet, a repository or a subject: Brain chooses the work, and a prompt that
named any of it would be a second, weaker way of assigning.

Copy two values out of the Routine when it is created:

* its **trigger id**, `trig_…`;
* its **API trigger bearer token**, shown once.

---

## 5. Put the trigger token where Brain can read it, and nowhere else

The token goes in the deployment secret store as a Fly secret on the Brain app,
under this exact name:

```
BRAIN_ROUTINE_TOKEN_FACTORY
```

From a terminal with `flyctl` authenticated:

```
fly secrets set BRAIN_ROUTINE_TOKEN_FACTORY=<the token> --app northline-brain
```

Setting a secret restarts the machine, which is ordinary — every stage is a row,
so nothing in flight is lost.

**Never anywhere else.** Not in a repository, not in a Brain field, not in a
prompt, not in an issue, not pasted into a chat. Brain's registry stores the
secret's **name** and a sha-256 of its value taken once, and no projection can
recover a value from either — so the only copy that exists is the one in Fly.

---

## 6. Register the surface, and bind it to the worker

Run the **Fleet** workflow (Actions → Fleet → Run workflow), twice.

**Register the Routine.** `command: register-routine`

| Input | Value |
|---|---|
| `account` | `primary` |
| `ref` | the `trig_…` id from step 4 |
| `secret` | `BRAIN_ROUTINE_TOKEN_FACTORY` |
| `name` | `Factory_surface` |
| `capabilities` | `repository,repository-write` |

The underscore is not a typo: the workflow refuses a value with a space in it,
because an input pasted into a command line is an injection whatever the
intention, and only `--reason` turns underscores back into spaces. The Routine
will be listed as `Factory_surface`.

Both capabilities, not one. The stages that push are the ones that cannot be
skipped, so a surface that can read but not push produces a campaign that plans
and then reports an honest blocker for ever.

If it refuses with *"the deployment has no secret named …"*, step 5 has not
landed yet — wait for the restart and run it again. Brain reads the value only to
prove it is there and to take its digest.

**Bind it to the worker.** `command: bind-worker`

| Input | Value |
|---|---|
| `ref` | the same `trig_…` |
| `extra` | `--worker factory-brain-worker-bootstrap` |

The worker **name**, which is the one onboarding gave you; you never need its id.
Binding explicitly here rather than waiting for Brain to observe it on the first
arrival means the fire router knows what this surface is before it fires it.

A Routine is not re-pointed silently: if this refuses because the Routine is
already bound to somebody else, that is `repoint-worker`, which is a decision
rather than an observation and is audited with both ends of the move.

---

## 7. Prove it is the worker you meant

`command: verify-surface`, `ref:` the `trig_…`.

It prints two blocks and they are not the same kind of fact.

**CONFIGURED** is the rows you wrote. Expect:

```
  routine     Factory_surface  ENABLED  ref=trig_…
  account     primary  ENABLED
  caps        [repository,repository-write]
  secret      BRAIN_ROUTINE_TOKEN_FACTORY  present
  worker      factory-brain-worker-bootstrap  wkr_…
  families    [FACTORY]
  repos       [peyday007/brain-worker-bootstrap]
```

**OBSERVED** is what has actually happened — whether an OAuth token was ever
minted for that worker and ever used, and whether fires to this Routine are being
answered. A perfect CONFIGURED block over an empty OBSERVED one is a plan rather
than a proof, and the command says so rather than passing.

It ends in one of two lines:

```
  VERIFIED  this surface is the worker it is meant to be, and that worker has
            authenticated to Brain at least once.
```

or a `PROBLEM` line per fault and a refusal. The one that matters most is *"the
bound worker also serves [RESEARCH] — a factory surface must not share an
identity with research work"*: that is what a reused connector looks like from
Brain's side, and it is the failure a second connector *name* would have hidden.

Nothing after this needs you. Brain fires the surface when a stage is ready.

---

## What Brain refuses to do here, and why you have to

Brain cannot create a Routine, cannot mint a Claude connector and cannot choose
its permissions. The surface owns whether a worker may act; Brain owns dispatch.
A Brain that could mint its own execution surfaces would be able to grant itself
whatever it was refused, which is the one thing that boundary exists to prevent
— so these six steps are not a gap in the automation, they are the automation's
edge.

## Adding the second repository later

Onboard `oakwood-site` in Build, then repeat steps 2 to 7 with these values and
no other changes:

| | Value |
|---|---|
| Brain worker | `factory-oakwood-site` |
| Connector name in Claude | `Factory Brain Oakwood` |
| Tool prefix it produces | `mcp__factory-brain-oakwood__*` |
| Routine repository / branch | `Peyday007/oakwood-junk-removal` / `main` |
| Fly secret | `BRAIN_ROUTINE_TOKEN_FACTORY_OAKWOOD` |
| `capabilities` | `repository,repository-write` |
| `bind-worker` `extra` | `--worker factory-oakwood-site` |

**A third connector, not a reused second one.** The credential is per connector,
so a connector is an identity: connecting `Factory Brain` a second time would
hand this Routine the bootstrap worker, which is authorized for the wrong
repository and would be refused every bin. `oakwood-junk-removal`'s own
`.claude/settings.json` already pre-approves that prefix, so nothing needs adding
to a repository first.

Brain will not fire the bootstrap surface for Oakwood work or the other way
round: the fire router refuses a surface whose worker is not authorized for the
repository the bin names, by name — `NO_SURFACE_SERVES_THIS_REPOSITORY` — and the
assigner refuses it again if one ever arrives anyway.
