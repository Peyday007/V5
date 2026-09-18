# Getting people in, and surfaces proven

Both counts live on **People & capacity** (`/people`), reachable from
**More → People & capacity** and from **Who**. Neither of them is on the Cash
page and neither of them gates anything.

```
Members who can sign in          2 of 3
Surfaces Brain can fire right now  4
  proven by a completed session    4
  waiting on an administrator      1
```

They used to be at the bottom of Cash, and two things were wrong with that.

**They are not about Cash.** A person joins a *Brain* and a Routine serves every
project in it; §32 removed the last count on that surface that gated anything,
so what was left was Brain-wide account infrastructure administered from a
section §30 says is meant to be wound down in a month or two.

**Both counts were wrong.** The member list included the two identities
`scripts/verify-hosted.ts` creates on every deploy, so it reported more of the
team as present than were. And the capacity count reported `1 / 4 HEALTHY`
while `fleet show`, reading the dispatcher's own snapshot at the same instant,
reported *four eligible* — because it counted **accounts** and the dispatcher
fires **Routines**, and production runs four research Routines under one
account. Both are declared facts now: `users.kind` and `fleet_accounts.kind`
(migration 066), and one authoritative eligibility definition read straight from
`fleetSnapshot()`.

The denominator went too. `4` was the intended topology written down as a
constant; it was never a measurement, and a working Brain with two members read
as half missing. Members are counted against the slots that exist, and capacity
is reported as three labelled readings — eligible now, proven, waiting — beside
a *target* if somebody configured one.

**Being ready is not being authorized.** Neither count starts or stops anything.
What Brain may spend is the standing commercial grant of §30, which is a
separate decision and stays the owner's.

---

## 1. The four people

There is no email address and no password in this journey. An address exists to
recover a password, and there is no password here to recover.

### Inviting somebody

Signed in as a Brain administrator, in the browser:

**More → People & capacity → Invite somebody**.

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

**So `Joined` on the People page means *holds a live credential*, and the row
says which.** An earlier reading counted live passkeys only, which reported the
owner's own administrator account — a password and no device — as a slot nobody
had filled, beside the people who had enrolled. A row reads `Joined ·
password` or plain `Joined`, and the difference is not cosmetic: a recovery
link retires *devices*, so it is the plain one that journey applies to. A slot
with neither reads `Link sent` or `No link yet`, which are kept apart because
*nobody has been asked yet* and *somebody was asked and has not finished* have
different remedies.

**An address never appears as a name.** `bootstrap.ts` names the first
administrator after the address it was created with, so the owner's inbox was
the label every member read — and the same name is what Brain derives a
connector name, a Routine name and a **deployment secret's name** from, which
would have put an address into the app's own configuration. The domain is
dropped in both places.

---

## 2. Connecting a Claude account

A capacity account is a **surface Brain fires**. It is not a person, not a Cash
owner, and not a lane: all of them pull from the same shared queue, and there is
no project-coloured or person-coloured research. `V1` and `V2` are the **sites**
and those names are reserved for them.

**HEALTHY is not CONFIGURED.** A registered Routine with a secret and a bound
worker is *configured*. It becomes HEALTHY only once a session Brain fired has
arrived and finished a piece of work — §23's rule that a perfect configured
block over an empty observed one is a refusal rather than a pass.

### The member's journey, on their own page

**More → People & capacity → My Claude connection.** Every value they have to
paste is in its own copy box, and the page names the step they are on. Nobody has
to invent a name, infer one from prose, read a chat log, open a terminal or
understand anything about the fleet.

| Step | What Brain shows | What they do |
| --- | --- | --- |
| 1 | The connector name and the MCP URL | Add the custom connector in Claude and approve it on Brain's consent screen |
| 2 | The Routine name, the bootstrap repository, the connector to enable, and *schedule: off* | Create the Routine in Claude |
| 3 | A field | Paste the Routine's trigger id (`trig_…`) |
| 4 | The name of the deployment variable | Send the trigger's **bearer** to a Brain administrator privately |
| 5 | A button | Send the bounded self-test |
| 6 | The session, the bin and when it finished | Nothing — it is proven |

**The friend never opens Fly and never gets access to the owner's
organisation.** `services/dispatch/fire.ts` resolves a Routine's bearer with
`process.env[secretName]`, so the credential is a deployment secret and nothing
in this repository can write one. That is a fact about the credential model
rather than a gap, and the design is arranged around it instead of inventing a
second, weaker registration route beside it. The connection sits at **Waiting
for administrator** — not at a vague failure — and resumes from its own rows the
moment the variable is set. Neither person repeats a step.

Every state is durable. Refreshing does not lose progress, a restart does not,
re-submitting the same trigger id registers one surface, and a failed probe is
retried against the same connection, the same account and the same Routine.

### The administrator's one action

**More → People & capacity → Diagnostics → Connections** lists every member's
connection and the exact variable each is waiting on. It carries the name of an
environment variable, a trigger id and a state — no value of any kind.

```
flyctl secrets set BRAIN_ROUTINE_TOKEN_<MEMBER>=<the bearer Claude showed once> --app northline-brain
```

Brain stores the variable's **name** and a digest of the value taken once at
registration, never the value. It appears in no log, no URL, no API response and
no other member's screen.

### Doing it from a terminal instead

The Fleet workflow still does all of it, and is the path for a surface nobody is
setting up through the product:

```
fleet register-account  --name Brain_Research_B
fleet register-routine  --account Brain_Research_B --ref trig_… --secret BRAIN_ROUTINE_TOKEN_B
fleet bind-worker       --ref trig_… --worker <the research worker>
fleet verify-surface    --ref trig_… --probe
```

`verify-surface --probe` and the page's **Send the self-test** create the same
bin, from the same module (`server/services/fleet/probe.ts`): one bounded
`DETERMINISTIC_CHECK` that belongs to no campaign, forbids every repository
operation, and exists to be answered and finished. Four rows Brain wrote itself
— fired, arrived, assigned, completed — are the proof. A registered row is not.

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

and, in the browser, **People & capacity**. The two readings there are the same
ones `fleet show` prints, from the same snapshot, so they cannot disagree.

Neither of them gates **Start Cash Mode**, which is a Brain administrator's
click and starts the one shared Cash Mode for everybody. Nobody else activates
anything of their own — there is one frontier, one objective and one queue.

**Every member reads that frontier.** Discovery is shared: the machine's status,
the signals and candidates, the qualified opportunities, the accepted evidence,
the roadmap and whether a piece is already claimed. Privacy begins where a
validated opportunity becomes an **execution job** — the money, the spending
authority, the commercial terms and each job's own working state belong to
whoever owns that job, and are not sent to anybody else's page.
