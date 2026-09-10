# A connected site

**Step 12C.** One endpoint family on the outside of Brain, one link table, one
typed command, and a projection a site can render. It is the smallest thing that
makes the sentence *"the websites are thin X-ray glasses over Brain"* true for
one site, and it is arranged so that repeating it for a second site is a
mapping file rather than a design.

Everything here is a new **entrance** to machinery Steps 4 to 12A already built.
There is no second Opportunity model, no second work queue, no second command
bus, no second identity and no second policy module — §21's rule about the MCP
door, at a new boundary: *it adds a way in without adding a way around*.

---

## 1. The contract

Frozen at `connect.v1`, in `server/services/connect/contract.ts`.

| Field | Meaning |
|---|---|
| `sourceRecordType` | `OPPORTUNITY`. Matched exactly against a closed set. |
| `sourceRecordId` | The site's own id. Half of the uniqueness key. |
| `sourceVersion` | ISO-8601 instant, normalized. **The ordering fact.** |
| `sourceCreatedAt` | Optional, normalized the same way. |
| `sourceRef` | A site-relative path. Validated as one; anything else is dropped. |
| `title`, `summary` | What a person recognises it by. |
| `attributes` | An allow-list. Everything else is discarded. |

The attributes Brain imports are exactly: `type`, `stage`, `status`, `priority`,
`state`, `location`, `estimatedValue`, `expectedValue`, `closingProbability`,
`primaryBlocker`, `missingInformation`, `lane`, `counterparty`. Nothing else
crosses. **The margin, the contacts, the transcripts and the costs deliberately
do not**: Brain is the intelligence behind the site, not a second copy of it,
and every field that crosses is a field that could acquire two masters.

Every registered record carries its Brain id (`ext_…`), its source system, its
source record id, its source version, its provenance, its last synchronized
version and a stable idempotency key. `UNIQUE (source_system, source_record_id)`
is what makes a second backfill produce zero duplicates.

### What is authoritative for what

| | Master |
|---|---|
| Stage, status, owner, money, contacts, calls | **The site.** Brain never writes them. |
| Priority, reason, research, verdict, conclusion | **Brain.** The site never writes them. |

`lib/brain/sync.ts` contains no `prisma.opportunity.update`, and a test asserts
that it never will.

---

## 2. The routes

All project-scoped, all resolved through `requireProject` → `authorizeProject` →
`decideProjectAccess`. **There is no connect policy module and there must never
be one.**

```
POST /api/projects/:id/connect/:system/records                     WRITE  external:sync
GET  /api/projects/:id/connect/:system/records?since=&limit=       READ   project:read
GET  /api/projects/:id/connect/:system/records/:sourceRecordId     READ   project:read
GET  /api/projects/:id/connect/:system/rejections                  READ   project:read
POST /api/projects/:id/connect/:system/records/:id/commands        WRITE  external:sync
```

A project the caller may not reach, a source system this Brain does not speak
and a record that was never registered are **the same 404 with the same body**.

These paths are also outside the optional outer shared-token gate, for the
mechanical reason `/mcp` is: an HTTP request carries one `Authorization` header,
that gate wants `Basic <shared token>` in it, and a site connector must put
`Bearer brnw_…` there. The exemption is a narrow pattern over
`/api/projects/:id/connect/` and nothing beside it — the rest of the API stays
behind the gate — and it takes nothing away, because an anonymous caller here
still gets `401 Not authorized.` from the real authentication behind it.

An `Idempotency-Key` header on the command is **refused**, not ignored: the key
is derived from the record and the command, both of which are in the path. A
caller who sent one would believe they had a property that was in fact not
theirs to name (§20).

---

## 3. The one command

`RESEARCH_FURTHER` captures a Russell **idea**, and that is all it does.

It does not enqueue work, launch a mission, approve a plan or spend anything —
§22's rule that a worker cannot create its own work is not bypassed here, it is
respected. What happens next is Russell's existing loop: the idea is judged
against the archive first (§13), and it can only become a mission inside the
standing authority a person granted in Russell (§24).

That is why the projection has a `NEEDS_PERSON` answer that names a missing
authority. A site whose project has no standing authority would otherwise sit at
"queued" for ever, which is §24's own defect: *a state that says "waiting" which
that person cannot resolve is not waiting, it is stuck.*

---

## 4. The projection

Six answers, derived on the read path from the rows that actually decide —
never a stored status column, because everything that moves this work would have
to remember to write one and the one that forgot would leave a record reading
"being worked on" for ever.

| State | What it means |
|---|---|
| `NOT_EVALUATED` | Registered here; nobody has asked Brain for anything. |
| `QUEUED` | The idea exists and is waiting its turn. |
| `IN_PROGRESS` | A mission for it is running. |
| `NEEDS_PERSON` | Something is waiting on a human decision, and it says which. |
| `COMPLETED` | Finished, with what was concluded. |
| `FAILED` | Over, with the reason that was actually recorded. |

There is no optimistic seventh. An idea Russell parked because the archive
already answered it reads `COMPLETED` with that as its reason.

### How a state change reaches the site

`services/connect/loop.ts` runs every five seconds, derives each linked record's
projection, compares it to the last state the site could have seen, and touches
the link row **only when the answer has actually changed**. A tick over an
unchanged Brain writes nothing.

Measured locally: a Brain-side state change reappeared in a cursor-filtered poll
in **3.55 s**, and on the site's own record page in **202 ms** (the detail page
reads live rather than polling).

### Where the work is

A compiled research specification asserts a jurisdiction, and it must be the
subject's own. `services/russell/subject.ts` reads it from the record's `state`
column first and its `location` second, and answers `null` rather than
defaulting — a record Brain cannot place is one it will not place.

That matters here because the connector is what first brought records with a
jurisdiction of their own into a project whose standing authorization has one.
Three outcomes:

| The record is | Result |
|---|---|
| in a jurisdiction the authorization covers | researched, and the objective names it |
| in one it does not | **Needs a person** — refused with a sentence naming both, so the authorization can be granted |
| somewhere Brain cannot read | the objective names the authorized search rather than claiming the record is there |

---

## 5. Storage

`GET /api/health`, administrator view, carries a `storage` reading:
used bytes, provisioned capacity, growth, runway, projected monthly cost and the
largest categories.

Two rules:

* **Evidence is counted once.** The used figure groups `documents` by
  `file_hash`, so two documents that are the same file are one file's worth of
  storage. The naive total is reported beside it so the saving is visible.
* **Anything unmeasurable is absent, never estimated.** Provisioned capacity is
  a fact about somebody's plan; with `BRAIN_STORAGE_CAPACITY_GB` unset the
  percentage, the threshold and the runway are all `null` and the reading says
  why. Same for `BRAIN_STORAGE_COST_PER_GB_MONTH` and the projected cost.

Thresholds are 70% `NOTICE`, 85% `WARNING`, 95% `URGENT`. **Nothing stops at
any of them.** No work path calls `storageHealth`, and there is no per-project
quota, no per-idea approval and no archival engine — storage is cheap relative
to the business this Brain runs, and the only thing worth building is the
reading that stops it becoming a surprise.

---

## 6. Connecting a site

Three steps, all in a browser, once.

1. **Create the worker.** `/operator` → *Workers* → create one named for the
   site.
2. **Grant it the project, as a site.** On that worker's row, pick the project
   and choose **is a connected site**. The Brain composes
   `SITE_CONNECTOR_SCOPES` — `project:read` and `external:sync`, and nothing
   else. (Choosing *researches for Brain* would grant the research set, whose
   calls this endpoint refuses with the same 404 a missing project gives.)
3. **Issue a credential** on the same row and copy it. It is shown once and is
   not recoverable afterwards by anyone, including an administrator.

Then set three variables on the site and redeploy it:

```
BRAIN_URL=https://<your brain>
BRAIN_TOKEN=<the credential from step 3>
BRAIN_PROJECT_ID=prj_…
```

All three or none: with any missing the connector is off, the panel says the
site is not connected, no job is enqueued and nothing on the site changes.

The credential is a Brain-issued worker credential scoped to one project and two
verbs. It never appears in a Brain log, an API response, an error, a URL or the
site's own logs — `lib/audit.ts` redacts the `brnw_` pattern, and the site's
client never interpolates it into anything it throws.

---

## 7. Billing

**Nothing here activates a paid model or API.** The connector makes HTTP calls
to Brain and to nowhere else; it adds no provider, no key, no data source, no
queue and no service. The command captures an idea, which spends nothing; what
happens after it is Russell's existing loop on the existing fixed-subscription
Cowork fleet, bounded by the standing authority a person granted (§24) with
paid overages off and `max_external_spend` at 0.

A test asserts that no file in the connector mentions an API key or a provider
host.

---

## 8. Rollback

The connector is additive on both sides and rolls back in either direction
without touching anything that was already there.

**Brain.** Migration `036` (SQLite) / `027` (Postgres) creates three tables and
alters none. Deploying the previous image leaves them in place and unread;
nothing else in Brain queries them. To remove them entirely:
`DROP TABLE external_records, external_record_rejections, storage_readings;` —
no other table references them and no existing row changes.

**The site.** Migration `20260910120000_brain_connector` creates `BrainLink` and
`BrainSyncState` and alters no existing table. Unsetting `BRAIN_URL` turns the
connector off completely: the panel disappears, both jobs return immediately,
and every opportunity renders exactly as it did before.

**Neither direction loses work.** Brain's ideas, missions, documents and audits
are ordinary Russell rows and survive the connector being removed; the site's
opportunities were never written to by any of this.
