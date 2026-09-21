# The work register

What it is, what it stores, what it refuses to store, and how to read it.

---

## The question it answers

Brain already holds every *part* of what it is doing — candidates, missions,
packets, campaigns, change requests, faculties, industry rounds, cash
opportunities, documents, audits. What it has never held is the thing a person
actually asks about:

> What is pursuing money? What is being built? What is running? What is
> blocked? What needs me? What actually shipped?

That question spans all of those and belongs to none of them. The register is
where it lives.

---

## What a workstream is

**A join plus an intent.** There is no new orchestration object here, no second
queue, no command bus and no duplicate of anything. A workstream points at rows
that already exist, and holds only the two things no derivation could recover:

| Stored | Why it cannot be derived |
| --- | --- |
| `intent` | What outcome somebody meant by this. A paraphrase would eventually be a paraphrase of something else. |
| `purpose` | Whether this pursues money, clears the way for money, builds a capability, or serves a longer-term goal. A judgment about intent, not a fact about a row. |

Everything else is a pointer. `workstream_links` is many-to-many in both
directions, which is the requirement rather than a convenience: one conversation
can feed several workstreams and several conversations can describe one.

**There is no `state` column anywhere**, and a test asserts that against the
database rather than the TypeScript — because what must not exist is a *place to
put* a stored verdict. A stored state is stale the moment the thing it waited on
arrives, which §29 records at a status line and §38 at a capital tier.

---

## How the state is derived

On every read, from the rows a workstream points at. Three rules keep it honest:

**A `SOURCE` link never contributes a state.** A conversation describing shipped
work is not the work shipping. Sources are read, named and shown — and say
nothing about whether any of it happened.

**An unattested pull request moves nothing.** Brain holds no forge credential
(§27), so a link carrying `merged: true` with nobody attesting to it reads as
*recorded, with nobody attesting to its state* and contributes no state at all.
Once something has attested — a campaign, or a person — the reading names **who**
and **when**, and the state moves.

**`UNKNOWN` is an answer.** A workstream nothing can be read about is neither
proposed nor failed: nobody has said. It is counted and reported separately,
never folded into another number.

Where two readings disagree, the furthest one wins — except that `BLOCKED` beats
anything below `MERGED`, because a person needs to know work has *stopped* more
than they need to know it started. Above `MERGED` the further reading wins and
the blocker is still listed beside it.

### The states

| State | Means |
| --- | --- |
| `UNKNOWN` | Nothing linked says where this has got to. |
| `PROPOSED` | Written down, nobody has approved it. |
| `IN_PROGRESS` | A campaign, mission or packet is running. |
| `PR_READY` | Finished work is waiting on a review. |
| `MERGED` / `DEPLOYED` / `VERIFIED_LIVE` | Attested, by somebody named, at a time. |
| `DONE` | A packet completed or a document was filed. |
| `BLOCKED` | Something stopped, with the blocker in its own words. |

---

## Unfiled work

The half that makes it a register rather than a list somebody remembered to
type: **work Brain is holding that no workstream accounts for**, derived on the
read path from live campaigns, change requests, software requests and missions.

It is **offered and never filed automatically.** Filing one needs an intent and
a purpose, and composing either would be Brain manufacturing the judgment a
person is supposed to supply — §8's rule at the one place it is most tempting to
break, because a composed intent reads like a decision somebody made.

A software request with no change request yet is deliberately **not** offered: a
`CHANGE_REQUEST` link pointing at an `rsr_` id would be reported as missing for
ever, which is a register telling somebody their work had vanished on a row that
is perfectly healthy. Until it has one, the bridge's own status answers it.

---

## Reading it

**In the product:** *Work*. The register leads the page and the project's
mission list follows, because *what is pursuing money, what is running, what
needs me* spans every kind of work and every project, and the missions below it
are one project's research.

**Over HTTP:**

| Route | What it does |
| --- | --- |
| `GET /api/register` | The whole view, in one read. Add `?archived=true` to include archived workstreams. |
| `POST /api/register/workstreams` | Open one, optionally with its links, so filing is one action. |
| `GET /api/register/workstreams/:id` | One workstream, with corrections and events. |
| `PATCH /api/register/workstreams/:id` | Change what it says it is. |
| `POST /api/register/workstreams/:id/links` | Point it at something. |
| `POST /api/register/workstreams/:id/links/:linkId/supersede` | Correct a link, keeping it. |
| `POST /api/register/workstreams/:id/archive` | Stop caring, destroying nothing. |

Every route is `requirePerson`, so a **worker is refused by type** including on
the reads: a register is a statement about what work exists, and a machine that
could write one could describe work nobody asked for and have it read back as
the plan.

Scope is settled before the query through `decideProjectAccess` — the same
module every other route uses. There is no register policy module and there must
never be one. A workstream with no project is Brain-wide and readable by anybody
who may read the register at all; one filed under a project needs `WRITE` there
to change.

---

## Corrections

A link is **superseded, never deleted**, with its reason kept — so the register
can say what it used to believe and why that changed. The guard is on the link
still being live, in the statement that makes the change, so two people
correcting one link produce one correction and the loser is an ordinary refusal.

Archiving a workstream keeps its links, so the conversations that fed it still
resolve.

---

## What it deliberately does not do

- **No percentage and no progress bar.** "0 of 8 settled" was accurate and read
  as failure; a bar over an unknown denominator is invented precision.
- **No score and no weighted rank.** A weight is a judgement nobody made, and
  the number then reads like a measurement.
- **No badge, streak or celebration.**
- **No favourable unknown.** Nothing here reads *we could not tell* as *nothing
  is happening*.
