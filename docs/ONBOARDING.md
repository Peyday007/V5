# Getting four people in, and four surfaces proven

Cash Mode starts when two counts are full and not before:

```
Human members            4 / 4 READY
Claude capacity accounts 4 / 4 HEALTHY
```

Both are derived from rows by `server/services/cash/readiness.ts`. The screen
renders that reading and forms no opinion of its own; `POST /api/cash/activate`
re-reads it and refuses with both figures in the sentence, so the disabled
button is a hint and the route is the control.

**Being ready is not being authorized.** Four READY and four HEALTHY lets the
sprint *start*. What Brain may spend is the standing commercial grant of §30,
which is a separate decision and stays the owner's.

---

## 1. The four people

There is no email address and no password in this journey. An address exists to
recover a password, and there is no password here to recover.

### Inviting somebody

Signed in as a Brain administrator, in the browser:

**Cash → Invite somebody**, or **More → Your devices → People and capacity**.

Type the name they should be shown as, press **Make a private link**, and send
it to them privately — a message, not a shared document. The link is shown
**once**: Brain stored a sha-256 digest of it and cannot show it again. If it is
lost, withdraw it and make another.

What the link is:

- cryptographically random, and compared in constant time against a digest;
- bound to one member slot, so the display name and the account it fills come
  from the enrollment's own row and nothing the holder sends decides either;
- single-use, spent by one guarded `UPDATE`, so two requests holding the same
  intercepted link produce one passkey and one ordinary refusal;
- valid for 48 hours;
- revocable before use.

It travels in the URL **fragment** (`/enrol#…`), which is never sent to a server
and never written to an access log. That is what makes it safe to put in a
message and is why the address bar is cleared as soon as the page reads it.

### What the person does

Open the link. They see the name it was made for and nothing else — no email, no
role, no list of who else is here, because an intercepted link must not be a
reconnaissance tool. They name the device, press **Register this device**, and
their phone or laptop asks for a fingerprint, a face or a screen lock. They land
inside Brain, signed in. Their slot reads READY.

Afterwards they can add more devices and remove their own under **More → Your
devices**. Removing the *last* one is refused: it would lock them out and need
an administrator, and a control should not produce a state its own user cannot
resolve.

### If somebody loses their device

An administrator issues a recovery link for that member. Issuing it **retires
every credential they hold first** — a replacement handed out beside a
credential that still works is a second door, not a recovery, and if the device
was lost because somebody else has it, the whole point is that it stops working
now rather than when the replacement is used. The revoked rows keep their reason.

Every enrollment, revocation, recovery and administration step is written to
`identity_events`, which is append-only and records the enrollment's **id**,
never its token.

### Password sign-in

Password sign-in is still on the sign-in screen, below the device button,
because the owner's own account has one and an account made before this existed
needs it. A passkey-only account is not reachable by that path at all: it has no
address and no verifier, so the lookup answers `null` in exactly the way an
unknown address does.

Turning password sign-in off entirely is the owner's decision and needs the
owner to hold a safe secondary passkey first.

---

## 2. The four capacity accounts

A capacity account is a **surface Brain fires**. It is not a person, not a Cash
owner, and not a lane: all four pull from the same shared queue, and there is no
project-coloured or person-coloured research. `V1` and `V2` are the **sites** and
those names are reserved for them; a capacity account is `Brain Research A`
through `D`.

**HEALTHY is not CONFIGURED.** A registered Routine with a secret and a bound
worker is *configured*. It becomes HEALTHY only once a session Brain fired has
arrived and finished a piece of work — §23's rule that a perfect configured
block over an empty observed one is a refusal rather than a pass.

### Per account, once

In the Claude account:

1. **One custom connector**, pointing at `https://northline-brain.fly.dev/mcp`.
   One per account: Claude refuses a second connector on the same URL inside one
   account, and a connector is one Brain worker however it is labelled.
2. Approve it on Brain's consent screen, as the **pooled shared-research
   worker**. Not a new worker per account — the routing boundary is keyed on the
   authenticated worker, and four workers would be four scopes to keep in step.
3. **A Routine** named `Brain Research <letter>`, which:
   - attaches `Peyday007/brain-worker-bootstrap` — this is what lets a fired
     worker read `.claude/settings.json` and call the connector's tools without
     stopping at a permission prompt;
   - enables **only** its own Brain connector;
   - has **no cron**. Brain fires it on demand.
4. Copy its **API trigger id** (`trig_…`).

Then, on the deployment:

5. Set the Routine's fire token as a Fly secret under its own name —
   `BRAIN_ROUTINE_TOKEN_B`, `_C`, `_D`. Brain stores the secret's **name** and a
   digest of the value taken once at registration, never the value.

Then, through the **Fleet** workflow:

```
fleet register-account  --name Brain_Research_B
fleet register-routine  --account Brain_Research_B --ref trig_… --secret BRAIN_ROUTINE_TOKEN_B
fleet bind-worker       --ref trig_… --worker <the pooled research worker>
fleet verify-surface    --ref trig_… --probe
```

`verify-surface --probe` is what turns CONFIGURED into HEALTHY, and it is the
only thing that does: it fires one bounded probe bin that belongs to no
campaign, forbids every repository operation, and exists to be answered and
finished. Four rows Brain wrote itself — fired, arrived, assigned, completed —
are the proof. A registered row is not.

### Renaming a surface

```
fleet rename --kind account --ref primary --to Brain_Research_A
fleet rename --kind routine --ref trig_…  --to Brain_Research_A
```

Underscores become spaces. It changes the **label** and nothing else: not the
trigger, not the secret's name, not the digest taken at registration, not the
worker binding, not the state, not the counters. That is why it is safe to run
against the surface that is in the middle of a packet.

---

## 3. What to check

```
fleet show
```

and, in the browser, the two counts on the Cash card. When both read `4 / 4`,
**Start Cash Mode** becomes pressable, and one owner click starts the one shared
Cash Mode for everybody. The other three do not activate anything of their own —
there is one frontier, one objective and one queue, and privacy begins where a
validated opportunity becomes an execution job.
