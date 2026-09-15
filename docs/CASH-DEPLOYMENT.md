# Deploying Cash Mode, and operating it

This is the handoff for putting Cash Mode into use on a Brain that is already
deployed, and for running the four private operations afterwards. It assumes
[`DEPLOY.md`](DEPLOY.md) has been followed once — that is the cloud runbook
(Supabase, the bucket, Fly, the first administrator) and none of it is repeated
here.

**Nothing in this document has been deployed.** The work is on
`claude/new-session-k8fenr`, and §28 is explicit that one branch owns
production: this branch must be merged into `production` and deployed from
there, by a person, through the `Deploy` workflow. Do not dispatch `Deploy` on
this branch — that is the mistake that put a deleted surface back twice.

---

## 1. Configuration

### Must be set, in cloud mode

| Variable | What it is |
| --- | --- |
| `BRAIN_DATABASE_PROVIDER` | `postgres` |
| `BRAIN_DATABASE_URL` | The Session-pooler connection string |
| `BRAIN_STORAGE_PROVIDER` | `supabase` |
| `SUPABASE_URL` | The project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | The service-role key |
| `BRAIN_STORAGE_BUCKET` | The private bucket name |

Cloud mode never falls back to local. A Postgres that cannot be reached or a
bucket that does not answer stops the boot with the reason, which is the point:
a Brain that fell back would accept research and write it where nobody else can
see it.

### Must **not** be set

| Variable | Why |
| --- | --- |
| `ANTHROPIC_API_KEY` | §24: no inference is bought. The only permitted model path is the fixed-subscription fleet. |
| `OPENAI_API_KEY` | Same. |
| `BRAIN_PROVIDER` | Same. Setting it would give Russell a paid path it must not have. |

### Set once, then removed

| Variable | Note |
| --- | --- |
| `BRAIN_BOOTSTRAP_ADMIN_EMAIL` | The first administrator. |
| `BRAIN_BOOTSTRAP_ADMIN_PASSWORD` | Changed at first sign-in, then this is deleted. |
| `BRAIN_BOOTSTRAP_ADMIN_NAME` | Optional display name. |
| `BRAIN_BOOTSTRAP_ADMIN_RESET` | Break-glass only. Leave unset. |

### Per Routine, for the fleet

A `fleet_routines` row holds the **name** of a deployment secret and a sha-256
of its value taken once at registration — never the value. So for each Routine
you register, the deployment must also carry an environment variable with the
name that row records. A Routine whose secret is absent is left out of routing
and reported, rather than spending a fire discovering it.

`BRAIN_ROUTINE_BASE_URL`, `BRAIN_ROUTINE_ID`, `BRAIN_ROUTINE_TOKEN` and
`BRAIN_ROUTINE_VERSION` are the single-Routine fallback that predates the fleet
tables. A fleet registered through `npm run fleet` does not need them.

### Optional

`PORT`, `NODE_ENV`, `BRAIN_DATA_DIR` (scratch only in cloud mode),
`BRAIN_DATABASE_POOL_SIZE`, `BRAIN_PUBLIC_URL`, `BRAIN_REVISION`,
`BRAIN_ACCESS_TOKEN` / `BRAIN_ACCESS_USER` (the optional outer layer, which is
not the security model), `BRAIN_OCR*`, `BRAIN_STORAGE_CAPACITY_GB`.

---

## 2. Migrations

**There is no migration command.** Migrations run automatically at boot, in
order, each in its own transaction, with the applied version recorded in
`schema_migrations` and every applied file checksum-locked. Deploying *is*
migrating.

Two independently numbered chains: `server/db/migrations/` (SQLite) and
`server/db/pg-migrations/` (Postgres). Their version numbers do not mean the
same thing — this branch is at **59** and **50** respectively, and both are
correct.

`npm run migrate:cloud` is a different thing: it copies an existing local Brain
into the cloud. It is not a schema command and is not part of a routine deploy.

---

## 3. The process model

**One process.** `server/index.ts` boots in a fixed order — migrate, seed,
recompute, then serve — and starts every background loop in-process. There is no
separate worker process, no cron and no queue daemon to run.

| Loop | Interval | What it does |
| --- | --- | --- |
| Dispatcher | 10s | Turns dispatch intents into fires against Routines |
| Russell | 30s | The durable tick. **Cash Mode's operating pass runs here** |
| Connect refresh | 5s | Makes a connected site's state visible to a poller |
| Factory remote | 20s | Advances hosted factory campaigns |

Cash Mode has no loop of its own. `operate(projectId)` is called from the
Russell tick, which is why the machine must stay up: `fly.toml` disables
auto-stop deliberately, and a Brain that suspends between requests suspends
discovery, continuations and writeback with it.

---

## 4. Queue processing

Work is not pushed. A bin becoming `READY` writes a durable dispatch intent; the
dispatcher fires the Routine; a worker session arrives, authenticates, and
**claims** items off the queue. A claim is a compare-and-swap on
`lease_generation`, so two workers racing is an ordinary outcome rather than an
error, and an expired lease is claimable work — recovery never depends on one
process staying alive.

What the deployment has to supply is therefore only: registered Routines whose
secrets are present, and workers with the right memberships and scopes.

Two ways a worker authenticates, both real:

- a **`brnw_` bearer** issued at `POST /api/admin/workers/:id/credentials`,
  shown once and stored as a digest; and
- **OAuth**, for the Cowork connector, which has no field for a static header.

---

## 5. Accounts, projects and the order they go in

1. **Deploy, sign in as the bootstrap administrator, change the password,
   remove the bootstrap variables.**
2. **Create one project per private operation, on a terminal:**
   `npm run admin -- projects create "Ana's operation" --admin you@example.com`
   Reaching the shell is the authentication; `--admin` is the attribution,
   resolved against the database rather than trusted.
3. **Invite each person** from Russell → **Who** (`POST
   /api/projects/:id/invitations`). The link carries its token in the URL
   *fragment*, so it is never written to an access log. The acceptor chooses
   neither their email nor their role — both are read from the row.
4. **Each person activates their own sprint** in Russell → **Cash**, and
   **grants the standing commercial authority**. Those two decisions are a
   person's and there is no path around either.

Activating a sprint on a project with no layer **creates one** — `Opportunity
Research`, once, only when the project has none — because a project created in
step 2 has nowhere to file work, and `standingAuthority` refuses every launch
without one. Before that fix, a correctly set-up operation opened discovery,
captured ideas and launched nothing for ever, with every row reading healthy.

### The one setup mistake that is still silent, and how both were found

**A private operation must be its own, newly created project.**

The compiler chooses which approval envelope a project's work compiles under
from an in-code map of project slugs first, and from `cash_modes.envelope_id`
only when that map says nothing. That order is deliberate: *nothing about an
existing project's authorization can be changed by activating a cash mode on
it.*

The consequence is worth stating plainly, because nothing errors. Activate Cash
Mode on the seeded `deal-dispatch` project and discovery runs, missions launch,
workers do real research — and **no opening is ever harvested**, because the
buckets compile as public-records questions whose evidence lane is
`official_source`, while `harvest` reads `demand_signal`. Every row looks
healthy and the portfolio stays empty.

This was found by writing the deployment smoke test against the seeded project
first. A project created in step 2 above has no entry in that map, so it uses
the envelope its cash mode names, and the lanes line up.

Both findings came from the same place, and it is worth saying why: the smoke
test is the first thing in this repository to set a sprint up the way a person
actually would — create a project on a terminal, invite somebody, activate.
Every other suite arranges its own starting state, and neither defect is
visible from one that does.

---

## 6. How the four operations are isolated

There is no new mechanism here, and that is the argument for it. Privacy is a
`project_memberships` row read through `decideProjectAccess` — the same check
every other surface in Brain uses.

- Each operation is one project. Four people means four projects.
- A person sees an operation because they hold a membership on its project.
- A project a caller may not have is refused as one that **does not exist** —
  the same 404, with the same body, as a real miss. A status that matched while
  the body differed would still be an oracle.
- An idempotency key cannot reach across: the scope is built from server-held
  facts, so the same key typed by two people produces two commitments.
- A declined opening may be offered privately to another operation. The copy
  carries the opening and **none** of the first owner's working — no payer, no
  price, no acceptance condition. It does carry the id it came from as
  provenance, which is safe only because that id is not an oracle: holding it
  gets the same refusal as an id nobody issued.

**The one deployment fact this depends on:** a Brain administrator reaches every
project by design, so **the four daily accounts must not be Brain
administrators.** Make them ordinary members of their own project. This is
configuration, not code, and it is the single thing that would quietly undo the
boundary.

---

## 7. Monitoring

| Question | Where to look |
| --- | --- |
| Is it up? | `GET /healthz` — unauthenticated, and what Fly's health check uses |
| Which backends did it actually reach? | `GET /api/health` — names the database host, the bucket, the schema version. Never a credential |
| Is work stuck in the queue? | `npm run admin -- queue list <project>` — type, state and attempt count per item |
| Is a packet stranded? | `npm run admin -- packets list <project>`, then `npm run report:packet` |
| Are the surfaces healthy? | `npm run fleet -- show` — state, and the recorded reason behind a quarantine |
| What is Brain waiting on, per operation? | The Cash screen's **Needs You**, and `whatBrainNeeds` in `GET /api/projects/:id/cash` |
| Did an audit reviewer share a session with an author? | `npm run admin -- packets independence` — reports, never acts |

**Stalled leases need no alarm and no sweeper.** An expired lease is claimable
work by construction, so redelivery is the recovery. What is worth watching is
the *opposite*: an item whose attempts are spent, which shows as a terminal
state in `queue list` and as a bin at `NEEDS_HUMAN`.

**Unresolved needs are the normal state, not an incident.** An open
`cash_needs` row stops nothing except the one transition it names in
`blocks_state`. Every need carries a recommended path and a next step, and a
need whose condition later becomes true is settled by the tick without anybody
answering it.

---

## 8. What the deployed Brain can actually do

Read rather than declared. `readCapability` answers from rows every time it is
asked and is never cached, so this table is what the register would say — and
the first row's answer depends on the deployed fleet.

| Capability | State | What Brain does instead | The need a person sees | Next step |
| --- | --- | --- | --- | --- |
| `RESEARCH_A_QUESTION` | **PRESENT** when ≥1 enabled Routine has a registered secret and a bound worker; **MISSING** otherwise | Sends bounded questions and takes back gated, sourced claims | "Brain needs: research a question" | `npm run fleet -- register-routine`, then check a fire arrives and finishes something |
| `SEND_A_MESSAGE` | **MISSING** | Prepares the offer, the price and the acceptance condition on the card, and stops at READY | "Brain needs: contact the buyer" | An outbound messaging integration. Until one exists, a person sends it and the send is recorded as a confirmed action |
| `ISSUE_AN_INVOICE` | **MISSING** | Records the agreed scope and the amount | "Brain needs: issue an invoice" | An invoicing integration. Until then, issued outside Brain and settled against its own reference |
| `TAKE_A_PAYMENT` | **MISSING** | Records a settlement carrying a verifiable reference | "Brain needs: take a payment" | A payment processor. Until then, taken outside Brain |
| `PUBLISH_A_LISTING` | **MISSING** | Nothing — and note this is also `ALWAYS_PROHIBITED_COMMERCIAL` for Brain itself, whatever integration exists | "Brain needs: publish a listing" | A publishing integration *and* a person; Brain may never do this itself |
| `SIGN_AN_AGREEMENT` | **MISSING** | Records the agreement as an action once signed | "Brain needs: sign an agreement" | A signature integration, and somebody with authority to bind the account |

Anything not in this list reads `UNKNOWN`, which is a third answer on purpose:
*Brain does not have this* and *nobody has told Brain what this is* have
different remedies.

### Which commercial action each capability gates

| Commercial action | Needs | Today |
| --- | --- | --- |
| `CONTACT_BUYER` | `SEND_A_MESSAGE` | A person sends; the action is recorded |
| `QUOTE_AND_INVOICE` | `ISSUE_AN_INVOICE` | A person issues; the settlement is recorded |
| `ACCEPT_PAYMENT` | `TAKE_A_PAYMENT` | A person collects; the ledger takes a `SETTLEMENT` |
| `SPEND_FROM_ALLOWANCE`, `RUN_PAID_TEST`, `PURCHASE_TOOL_OR_DATA`, `ENGAGE_CONTRACTOR` | No integration — these are commitments against the grant | Work today, inside the ceilings a person set |

**The last row is the useful one.** Committing, settling and releasing money
need no external integration at all: they are rows, a compare-and-swap and a
person's grant. So a sprint is operable from day one for everything except
*reaching* a buyer, and the missing integrations are visible needs rather than
silent blocks.

---

## 9. What is not connected, and the boundary

The only execution capability the Brain has is `RESEARCH_A_QUESTION`, and it is
already wired — it is Steps 10 and 11's fleet, and it reads `PRESENT` the moment
a healthy Routine is registered. **No second execution capability exists in this
repository to connect**, and none has been invented here: choosing a messaging,
invoicing or payment provider is a decision with a contract and a bill attached,
and it is not one an agent should make.

The integration boundary, exactly:

- a capability becomes real by adding a `read` function to its entry in
  `services/cash/capabilities.ts` that answers from rows;
- the action it gates is already in `COMMERCIAL_ACTIONS` and already checked
  against the standing grant, so nothing about authorization changes;
- `advanceWithinAuthority` already asks the grant first and the capability
  second, so the moment a capability reads `PRESENT` the branch that performs
  the action is reached with no other change.

Until then `SEND_A_MESSAGE` stays `MISSING`, and no run of this system has
contacted a buyer, taken a payment, or started a Cowork session.
