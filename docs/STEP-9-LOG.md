# Step 9 — field log

**First manual end-to-end research packet.**
2026-08-28 16:37:39Z → 2026-08-29 05:48:38Z. All times UTC, all durations wall clock.

Step 9 set out to run one genuinely useful research packet through the
production Brain. It did that. Most of the time went somewhere else: into the
seventeen things that had to be wrong first for anyone to find out they were
wrong.

| | |
|---|---|
| Elapsed | 13h 11m |
| Commits | 36 |
| Deploys | 21 — 13 green, 8 red |
| Time spent deploying | 1h 49m, of which 41m was failed runs |
| Faults found | 17 |
| Tests | 976 on Postgres, 951 on SQLite |

Every timestamp here is read from git, the GitHub Actions API, or the Brain's
own `work_items` rows. Two entries are marked `~` because they come from a
worker session's own account of itself rather than from a row; everything else
is measured.

---

## The finding

Step 8 connected a real Claude worker and proved it could authenticate, claim,
heartbeat and complete. Step 9 opened by discovering that nothing it learned
could get in.

> The orchestrator was a synchronous in-process loop calling
> `provider.run(prompt)`. A Claude Max worker pulls work off a queue. Both were
> built, both were tested, and they did not meet.

The tempting fix was a work type whose payload is a prompt — the whole
orchestrator would have worked unchanged. The queue's own registry forbids it in
as many words: there is deliberately no work type meaning "run this." So the
shape became typed research work naming *what to research*, structured
submission, and server-side gating through the same functions the in-process
path already used.

---

## The log

| Time | What | Why it mattered |
|---|---|---|
| 28 Aug 16:37:39 | Work items get a subject they cannot carry in a payload | Schema for research-linked work: `orchestration_id`, `fragment_id`, and an append-only checkpoint table. Both migration chains. |
| 28 Aug 20:15:27 | **The research loop is turned inside out** | Ten MCP tools, the packet runner state machine, and one shared acceptance path so the remote route cannot be looser than the local one. |
| 28 Aug 20:31:23 | Tests written as the ways the packet could lie | 43 of them. Inverting the gate showed only one of three assertions failing — they checked the reported count, not the stored flag. **(fault 4)** |
| 28 Aug 20:45:04 | The runner could create a second item for one fragment | A second work item is a second idempotency scope, so it could record a second claim ledger. **(fault 2)** |
| 28 Aug 21:14:34 | Test packets, so the pipeline can be judged before it is paid for | Asked for directly. A fixture path that exercises everything and spends nothing. |
| 28 Aug 21:34:29 | A markdown defect in every packet ever filed | The ledger builder stripped deliberate blank lines. Found only by printing a filed document. **(fault 6)** |
| 28 Aug 22:52:11 | The archive gets read before a proposal becomes research | §13 held on the in-process path and not the worker path. **(fault 9)** |
| 28 Aug 23:00:54 | The test harness had leaked 4,762 data roots — 26 GB | Presents as a hundred unrelated tests dying on "No space left on device". **(fault 8)** |
| 28 Aug 23:50:50 | **The real packet is created** | Business-broker licensing for success-fee intermediation, into Deal Dispatch → Monetization Logic. |
| 29 Aug 00:07:49 | Every deploy starts driving a whole packet | Found that `brain_submit_audit` advertised an adversarial schema its own validator rejects — **no worker-driven packet could ever have reached a verdict**. **(fault 10)** |
| 29 Aug 01:20:37 | A worker claims work and finds the wrong project | The packet was in a third project it had no membership in. From a worker's side, "no work" and "not yours" are the same sentence. **(fault 11)** |
| 29 Aug 02:13:01 | **The planning job is claimed and done** | Twelve fragments in 3m 28s: five licence triggers, five penalties, two boundary fragments the worker added itself. |
| 29 Aug 02:27:25 | Every deploy had been corrupting packets in flight | Boot recovery treated worker-driven packets as dead in-process runs. True since the runner landed. **(fault 12)** |
| 29 Aug 02:38:37 | **The plan is approved — twelve research jobs queued** | The single point where a human decision is load-bearing. |
| ~29 Aug 03:00 | **Real research, and the gate refuses a third of it** | California: 13 claims, 8 accepted, `INSUFFICIENT`. Three different gate conditions on real evidence, for the first time. |
| ~29 Aug 03:20 | The worker's budget runs out mid-verification | It completed the lease instead of releasing it, stopping the packet with real research inside. **(fault 14)** |
| 29 Aug 04:07:39 | Completing research that recorded nothing is refused | An item whose purpose is to record a verification, completed without one, is a contradiction. |
| 29 Aug 04:25:34 | A recovery is built — for the wrong failure | Correct code, thoroughly tested, and not what had gone wrong. |
| 29 Aug 05:12:47 | A "flaky" test turns out to be an ordering bug | Checkpoints ordered by `created_at, id`; ids are random. Reported as unexplained hours earlier rather than called flaky. **(fault 15)** |
| 29 Aug 05:24:54 | The fix takes down the live Brain | `rowid` is rewritten to `seq` on Postgres and that table never had the column. The Postgres suite had been run *before* the change. **(fault 16)** |
| 29 Aug 05:48:38 | **The actual repair path** | §15 was already explicit: a repair is a *new fragment row*. Nothing on the worker path could create one. **(fault 17)** |

---

## Where the time went

| | |
|---|---|
| Packet waiting to be claimed | **2h 22m** |
| Deploys, 21 of them | 1h 49m |
| — of which failed and rerun | 41m |
| Full test suite, per run | 1m 36s |
| Full suite on Postgres | 3m 38s |
| Worker: plan 12 fragments | 3m 28s |

The largest measured block is not work. It is the packet sitting in a queue
waiting for a person to start a worker session — the Brain never reaches out to
Claude, and until scheduling exists, somebody has to say go.

---

## The ledger — seventeen faults, and what found each one

| # | Fault | Found by |
|---|---|---|
| 1 | Nothing could write research at all | Reading the two halves against each other before building |
| 2 | A second work item per fragment — two claim ledgers | Following the guard's own reasoning past the loop it was written for |
| 3 | `RESEARCH_AUDIT` silently dropped unknown payload fields | A test written against the one item where a prompt nears a model |
| 4 | Gate tests asserted the reported count, not the stored flag | Deliberately inverting the gate to see how many tests noticed |
| 5 | Connector scopes omitted every research scope | A connected worker claiming an item and being refused by every write tool |
| 6 | Broken markdown in every packet ever filed | Printing a filed document instead of trusting the writer |
| 7 | A second packet on one layer could not file | A fixture run that hit the duplicate-version refusal |
| 8 | Test harness leaked a data root per file — 26 GB | Root-causing a Postgres run that died mid-way rather than rerunning it |
| 9 | The coverage check never ran on the worker path | Asking which of the two paths §13 actually held on |
| 10 | The adversarial audit schema its own validator rejects | Driving the audit roles end to end for the first time |
| 11 | Work invisible to a worker with no membership | A worker's honest report of an empty queue that was not empty |
| 12 | Every deploy corrupted a packet in flight | Chasing a false "interrupted" banner rather than dismissing it |
| 13 | A fragment naming a sibling it declared no dependency on | Twelve fragments going ready at once when five should have waited |
| 14 | Completing research work that recorded nothing | The live packet stopping with real research inside it |
| 15 | Checkpoints ordered by a random id | CI failing where local passed — reported unexplained, not flaky |
| 16 | A Postgres table missing the column every table carries | The deployed Brain, one deploy later than it should have been |
| 17 | No repair path on the worker-driven side | A recovery button that correctly refused to appear |

---

## What the packet found

- **California** — a licence is required. §10030 defines "business opportunity"
  with no real-property element; §10131(a) catches negotiating its sale for
  compensation "regardless of the form or time of payment"; §10130 makes doing
  so unlicensed unlawful. The finder's exception was checked and forecloses
  itself: an intermediary who takes any part in negotiations is a broker, not a
  finder.
- **Texas** — provisionally no, and marked provisional. Every enumerated broker
  act is done to "real estate", defined as an interest in real property. Three
  claims went in **explicitly unsourced** rather than backfilled from Justia or
  FindLaw mirrors.
- **The constraint that shapes the rest** — state legislature sites defend
  against automated retrieval. `leginfo` blocked amendment dates;
  `statutes.capitol.texas.gov` serves a JavaScript shell and refuses PDFs.
  Florida, New York and Illinois will do the same.

---

## Measured, for the budget defaults

- **~3 work items per fragment**, not 2 — one fragment consumed research,
  verification and a repair. Twelve fragments is closer to 36 items than the 24
  estimated.
- **3m 28s** for a worker to decompose a goal into twelve declared fragments.
- **2h 22m** between work being queued and a person starting the worker that
  claims it. Until scheduling exists, this is the pipeline's real latency.
- **Allowance consumption is not observable to the Brain** and never will be —
  it belongs to the connected account, not to the platform. It is the one
  measurement that has to be reported by hand.

---

## Still open

- Ten fragments remain queued; California is on attempt 2 and Texas is ungated.
- A regression in `brain_propose_fragments` that the hosted harness catches and
  which is not yet diagnosed.
- Sixteen throwaway verification packets accumulating in the verification
  project, one per deploy, cluttering the operator console.
- The budget system itself — packets per goal, fragments across them, a time
  limit, external spend fixed at zero — specified and deliberately not built.
