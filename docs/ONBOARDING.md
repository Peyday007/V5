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

There is no email address and no password in this journey, and there is none in
the project-invitation journey either. An address exists to recover a password,
and there is no password here to recover: an invitation accepted by somebody
with no Brain account creates a credential-less row and hands back one
enrollment link, which the screen spends immediately.

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

**It is gone from the sign-in screen, and gone as a way for a person to sign
in.** The screen carries one button. There is no address field, no password
field, no *or with a password*, and no mention of a recovery path — the last of
those deliberately, because internal recovery machinery on the front door tells
somebody probing that a second door exists and where it is.

What decides it is one rule, in `server/services/identity/passwordDoor.ts`, and
it is derived from rows rather than set anywhere: **a password is accepted only
from an account that cannot sign in with a device.** Concretely, an account is
refused its password once it holds a live passkey it has *actually signed in
with at least once* — registered is not enough, because a credential bound to
the wrong origin registers perfectly and asserts never, and the safe direction
to be wrong in is leaving the door somebody came in through open.

Three consequences, which are the whole reason the rule is shaped this way:

* **The owner's own migration needs no step anybody has to remember.** Their
  account had a password and no device, so the door was open for them; the
  first time a device signed them in, it shut. "Verify the passkey works before
  disabling the password" is a derivation rather than a procedure.
* **A member is never offered one.** A member slot holds no address and no
  verifier, so there is nothing for a password to be compared against — and
  once they enrol, the rule shuts the door as well.
* **The hosted verification identities keep working.** `kind = 'SYSTEM'`,
  created on every deploy, no device and never one. Nothing in the rule mentions
  kinds; what keeps them working is that machinery holds no passkey.

### If you are locked out

Two doors, in this order.

**`/recovery`** is an address in the app that nothing links to. It takes an
address and a password, and it exists for an account that has no working device
yet. It ends by registering a device rather than by opening the Brain, because
the point of getting in that way is to stop needing to. Every attempt is
recorded.

**`BRAIN_BREAK_GLASS`** is the answer when `/recovery` refuses you — which it
will, once your device has worked once. Set it in the deployment's own secrets
(`fly secrets set BRAIN_BREAK_GLASS=true`), which re-opens the password door for
every account that has one, sign in at `/recovery`, register a replacement
device, and **remove it again**. The boot banner says `BREAK-GLASS IS ARMED`
every time the machine starts while it is set, so a deployment left armed says
so rather than quietly keeping a second way in.

It grants no authority of its own: the password still has to be right, the
throttle still applies, a disabled account is still refused, and the session it
opens is the short one rather than the thirty-day device session.

### How long you stay signed in

A device session lasts **thirty days**, absolute, and is carried in the cookie's
`Max-Age` so it survives closing the browser and restarting the machine. It is
not refreshed on use, because a rolling session never ends. A password session —
which now only means a break-glass one — is eight hours.

The session is a row the server can end at any moment: signing out revokes it,
revoking a device revokes the sessions **that device** opened, and issuing a
recovery link revokes every session that person holds. A disabled account is
refused on its next request whatever it is carrying.

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

### Where a person finds it

**One canonical screen, for every account**, on **More → People & capacity →
Your Claude connection**. Three surfaces carry a compact card that opens it and
never a second copy of it: the **home page**, whenever a connection is not
proven — which is where somebody who registered their device five minutes ago
actually is; **Your devices**, permanently, because a Claude connection is a
credential of theirs like the devices above it; and the **enrolment screen**,
which names the journey in one sentence as the next thing they will do.

Every word on it is composed by the server, in
`server/services/capacity/connection.ts`, and
`client/src/russell/ClaudeConnection.tsx` renders what it is given. There is no
administrator variant and no member variant — the component contains no role,
no membership and no capability check at all, which is asserted by a test that
reads the file. A control somebody may not use arrives **disabled with the
server's reason beside it**, never removed, because "there is no button" and
"the button is not for you yet" are answers a person reads very differently.

### The member's journey, on their own page

Every value they have to paste is in its own copy box, and the page names the
step they are on. Nobody has to invent a name, infer one from prose, read a chat
log, open a terminal or understand anything about the fleet.

| Step | What Brain shows | What they do |
| --- | --- | --- |
| 1 | A button | Ask for their one-time connector link |
| 2 | The connector name and the MCP URL | Add the custom connector in Claude and approve it on Brain's consent screen, with that link |
| 3 | The Routine name, the bootstrap repository, the connector to enable, and *schedule: off* | Create the Routine in Claude |
| 4 | A field | Paste the Routine's trigger id (`trig_…`) |
| 5 | The name of the deployment variable | Send the trigger's **bearer** to a Brain administrator privately |
| 6 | A button | Send the bounded self-test |
| 7 | The session, the bin and when it finished | Nothing — it is proven |

**Step 1 is the one that used to be missing, and its absence was the whole
reason an ordinary member could not start.** `/oauth/authorize` looks for a
signed-in Brain administrator first and an invitation second, so a member
holding neither is refused at Claude's approval screen — and the old step 1 told
them to go there. The link is still a Brain administrator's to issue, because
issuing it mints a worker identity and grants it a project membership; what is
new is that a member can **ask**, which is §24's rule that every escalation
needs an answering transition, at the first step of the journey rather than the
last.

### Checking it, and getting it back

The same page carries three things that do not depend on being mid-setup:

* **Check this connection** re-reads the rows — the worker identity, its project
  membership, the OAuth tokens minted against it, the registered Routine and its
  bound worker, whether the deployment variable is present, and the four-row
  proof chain — and answers each one `PASS`, `FAIL` or *not yet*, with a remedy
  on anything that is not a pass. It fires nothing and spends nothing, so it is
  available in every state to every reader.
* **Take this connection back** revokes every token minted against that worker,
  revokes any outstanding link, and moves the surface to `UNAVAILABLE` so the
  dispatcher stops firing it. It destroys nothing: the trigger, the capacity
  account, the Routine and the proof that it once worked all stay.
* **Reconnect** puts it back at the start of the journey with all of that
  intact, so what is left is one approval rather than a second setup. It
  re-enables the surface **only** if this member's own revoke is what took it
  out; a surface an operator drained or quarantined stays where they put it.

Two states are reported that nobody presses a button for. **Bound to the wrong
surface** means the registered Routine no longer names this connection's trigger
or answers as another worker — Brain would fire it and attribute its sessions to
somebody else, so it is named rather than counted as capacity, and the remedy is
`fleet repoint-worker`, an operator's. And an **authorization that has lapsed**
is reported *beside* the state rather than instead of it: proof is history and
does not stop having happened, so a surface that was proven stays proven and
still says, in the same breath, that nothing Brain fires at it can authenticate
now.

**Brain holds nothing about the Claude account itself** — no password, no
cookie, no session and no Anthropic token. There is no field on that screen
that accepts one, and the server refuses a credential pasted into the trigger
field. What Brain has is a worker it minted and a token it issued against that
worker, on the authority of a person it authenticated.

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
connection and the exact variable each is waiting on, and names anybody who has
asked for a connector link — which is the only channel that request travels
down, since this Brain has no email and no notifications. The link itself is
issued with the **Claude connector link** button beside that person in the
member list, and is shown once. The list carries the name of an environment
variable, a trigger id and a state — no value of any kind.

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

## 3. Is this account actually set up?

```
npm run admin -- people foundation
```

and, in the browser, **People & capacity**, where the same reading appears
under each person beside the controls that answer it.

It is one line per account per dimension, and there are six: **identity**,
**sign-in**, **Claude connection**, **worker attribution**, **capacity** and
**recovery**. Each is `PASS`, `BLOCKED` or `NOT_APPLICABLE`, and every blocked
one carries the single next action and who performs it — *them*, *you*, the
*deployment* administrator, or Brain by itself.

Three things about how to read it.

**`NOT_APPLICABLE` is not a pass.** A member who has not begun a Claude
connection has no worker to attribute and no capacity to measure. That is a
different fact from those being fine, and it neither makes the account pass nor
blocks it.

**`SIGN_IN` is judged by the screen that is served, not by the schema.** An
account holding only a passkey reads `BLOCKED` even though it holds a real
credential, because the sign-in screen asks for a PIN and offers no way to
present a device. The remedy is a recovery link, which ends in setting one.

**Two accounts sharing a display name is an identity failure that presents as a
credential one.** The PIN lookup resolves a typed name only when exactly one
row matches, so neither of them can sign in by name, and the refusal — as it
must — tells them nothing about why.

Below the accounts it names any **surface running under an identity no account
owns**: a worker registered by hand before the connection journey existed has
no connection row, so nothing can attribute its sessions to a person. It is
reported and never acted on. Adopting one or retiring its Routine is your
decision, because a projection that redistributed live surfaces would lose
running work.

## 4. What else to check

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
