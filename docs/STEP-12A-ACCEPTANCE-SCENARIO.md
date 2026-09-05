# The frozen Step 12A acceptance scenario

**Scenario id:** `S12A-ACC-1`
**Frozen at:** 2026-09-04, before any live result was seen.
**Status:** frozen locally. Nothing in it has been run in production.

This document exists so that the acceptance run cannot be judged against a
standard chosen after its results were known. Everything below was written
first; a live outcome that does not match it is a failure of the run, never a
reason to edit this file. If the scenario turns out to be wrong — if the
coverage check settles the question, say — the correct response is to abandon
it and freeze a different one, recording why, not to loosen this one.

---

## 1. Why not Florida, and why this

Florida is settled as a **conversation** proof: Russell understood the context,
retrieved existing Monetization Logic research, distinguished provisional from
established, named the two missing evidence conditions, and recommended
continuing the planned redo instead of researching again. That is
archive-first restraint, and it proves nothing about candidate capture,
dedupe, stored judgment, probes, mission launch, the research and audit chain,
writeback, follow-on, or a Needs You park and resume.

So the scenario needs a **genuinely unresolved** question that is bounded
enough to finish in one fragment.

The chosen subject is **permit intelligence**, which the addendum permits *only
if the coverage check shows the archive does not already settle it*. That
condition is part of the run rather than an assumption: `coverBeforeWork` runs
before anything is created, and if it reports the requirement `SATISFIED` or
`PRESENT_BUT_UNVERIFIED` the scenario is **abandoned** and a different one is
frozen. Researching what the project already knows is exactly the waste
invariant 13 exists to prevent, and a scenario that ignored its own coverage
check to reach a green gate would be the acceptance lying about the control it
is meant to be evidence for.

---

## 2. The frozen inputs

### The human message, exactly

> Do Michigan's larger counties publish building-permit records in a form we
> could actually consume — an open-data portal or a feed — and on what terms? I
> want to know before we design any discovery around it.

### The near-duplicate, for semantic dedupe

Sent after the first has been captured, deliberately reworded so a
fingerprint cannot match it:

> Same thing again, differently: is there anywhere in Michigan that puts
> building permits out in a machine-readable way, and are we allowed to use it?

**Expected:** the second produces no second candidate. It resolves to the first
by semantic comparison, with a `russell_candidate_merges` row whose `method` is
`SEMANTIC` and whose reason names the overlap. A deterministic fingerprint
match would prove nothing here, which is why the wording is different.

### Attachment

| | |
| --- | --- |
| Project | Deal Dispatch |
| Layer | `Discovery Logic` — shown to a person as **How we find opportunities** |

The layer is the expected attachment because the question is about where
opportunities are found, not about what they are worth or how they are priced.
An attachment to Monetization Logic or Qualification Logic is a **failure** of
condition 2, not a near miss.

### Russell's judgment question

> Is it worth a cheap look at whether Michigan permit data is machine-readable
> before any discovery design depends on it?

**Expected:** a stored priority with a reason that names the dependency — work
downstream would be built on an assumption. The priority itself is Russell's to
choose; what is frozen is that a priority and a reason are **stored**, and that
a person's override supersedes rather than erases them.

### The probe

| | |
| --- | --- |
| Envelope | `GENERAL_LIGHT_PROBE_V1` — named by id, defined in code |
| Question | Which Michigan counties publish building permit data through an open-data portal? |
| Sources | exactly the envelope's, resolved from `allowlistFor` |
| Lookups | at most 3 |
| Deadline | 5 minutes from opening |
| External effects | none |

**Expected:** the probe stops at its bound with `UNKNOWN` or a verdict about
presence. A probe that reaches a fourth source, outlives its deadline, or
follows a redirect off the allowlist is a **failure of condition 6** regardless
of what it found. A probe verdict is a claim about presence, never about truth.

### Authority and budget

One goal budget reservation, taken atomically before the mission exists, of
exactly one mission unit. A mission that appears without a reservation, or two
reservations for one mission, fails condition 8.

### The research

| | |
| --- | --- |
| Fragments | exactly **one** |
| Repairs | at most **one** |
| Separation required | `SESSION` — three distinct authenticated sessions |
| Evidence standard | as `standards.ts` picks it for the claim type; not overridden here |

`SESSION` is the floor and is what is required. A stronger achieved tier is
reported truthfully if the fleet supplies it and is **not** a completion
condition — that correction is recorded in CLAUDE.md §24 and is not reopened
here.

### The authorized follow-on

Exactly one, launched automatically on terminal:

> Record the terms of use for whichever counties were found to publish, so a
> later design knows what it may rely on.

**Expected:** launched exactly once, with `next_mission_id` set on the first
mission. A second follow-on, or none, fails condition 15.

### The Needs You boundary

A **genuine** out-of-authority decision, not a manufactured one:

> One county publishes only through a source class outside the frozen
> allowlist. Broadening the authorized source class is not Russell's to decide.

**Expected:** the mission parks at `NEEDS_HUMAN` with the exact missing
authority named, a person answers, and **the same mission resumes** — the same
`russell_missions.id`, not a replacement. A replacement mission fails condition
17 outright, because the defect that condition exists to catch is precisely an
escalation with no answering transition.

---

## 3. Stable acceptance ids

The anchor is the conversation. Everything else is walked from it by foreign
key — never by title, and never by "the most recent one".

    ACCEPTANCE_SCOPE.conversationId   → the conversation holding the message above
      → russell_messages
      → russell_candidates (by conversation, and by source message)
      → russell_candidate_merges
      → russell_probes (by candidate)
      → russell_missions (by conversation or candidate)
      → russell_missions.next_mission_id (the follow-on)
      → research_orchestrations
      → research_passes, audits, documents
      → russell_budget_reservations
      → russell_human_requests

`conversationId` is deliberately **empty in the repository right now**. It is a
production fact that does not exist yet: the conversation is created by a
person sending the frozen message during the fifth mutation. Setting it is a
one-line commit made *after* that message exists and *before* the acceptance
reporter is trusted, and until then every scoped gate reports `NOT_RUN` naming
that reason — which is the truthful state. Nothing has happened, and nothing is
wrong.

---

## 4. The seventeen conditions, and what would falsify each

| # | Condition | Falsified by |
| --- | --- | --- |
| 1 | One human message, one turn | two turns for one message, or a turn with no message |
| 2 | Correct context attachment | attached to another project, or to a layer other than Discovery Logic |
| 3 | Meaningful candidate capture | no candidate, or one whose statement is a restatement of the message |
| 4 | Deterministic **and** semantic dedupe | a second candidate for the reworded message |
| 5 | Stored Russell priority and reason | a priority with no reason, or a reason not stored on the row |
| 6 | Bounded probe within its envelope | a fourth lookup, an expired deadline, a source off the allowlist |
| 7 | Accepted-current coverage before mission creation | a mission created before the coverage check ran |
| 8 | Atomic authority/budget reservation | a mission with no reservation, or two reservations |
| 9 | Exactly one mission, orchestration and bin | any duplicate |
| 10 | Authentic Routine dispatch and check-in | a provider session with no authenticated check-in |
| 11 | Research → verification → synthesis → three audit roles → filing → extraction → citations | any stage skipped, or a citation that does not resolve to a passage |
| 12 | Three authentic sessions, truthful tier | a `future:` session reference, a repeated session, or a tier reported above what was achieved |
| 13 | Accepted terminal state | terminal without the completion contract evaluating true |
| 14 | Exactly-once writeback | a second writeback, or a missing one |
| 15 | Exactly-once follow-on launch | two follow-ons, or none |
| 16 | Visible in Work, Ideas, Knows, progress and the constellation | present in rows and absent from a surface |
| 17 | Genuine Needs You park and **same-mission** resume | a replacement mission, or a park with no answering transition |

---

## 5. What this document does not authorize

It authorizes nothing. It is a plan, frozen so that it cannot be adjusted to
fit a result. Running it needs a production mutation, and that needs one
explicit authorization from the operator enumerating the exact number and order
of real production mutations, the spending ceiling, the canary and the
rollback. That request is in `docs/STEP-12A-EVIDENCE.md`.

---

## 6. Reconciliation with the permit conversation — 2026-09-05

On 2026-09-04 the owner sent a real message about permit data into an
**existing** Russell conversation, and the question arose whether that turn
could serve as this scenario's live run. It cannot, and the reasons are recorded
here so that the scope is decided against the frozen document rather than
against which records happen to pass.

**The message is a different message.** Frozen above:

> Do Michigan's larger counties publish building-permit records in a form we
> could actually consume — an open-data portal or a feed — and on what terms? I
> want to know before we design any discovery around it.

Actually sent:

> I want Deal Dispatch to continuously collect public permit data as a new lead
> and intelligence source. Decide whether it is genuinely worth adding. Do
> whatever bounded research and planning you're already authorized to do, but do
> not build the scraper yet.

They are about the same subject and they ask for different things. The frozen
one is a bounded factual question with a named expected attachment
(`Discovery Logic`) and a probe question derived from it. The one sent asks for
a worth-it judgment about an ongoing capability. Condition 2 is judged against
the frozen wording, and swapping the wording after the fact is adjusting the
standard to fit the result.

**It is an existing thread, which is the disqualifying problem.** §3's anchor is
the conversation, and everything is walked from it by foreign key — *every*
candidate with that `conversation_id`, every merge, every probe, every mission.
Pinning `ACCEPTANCE_SCOPE.conversationId` to a thread that already has history
would let rows created before this scenario existed satisfy its gates. That is
precisely what a frozen scope is for, so the thread is preserved as real project
history and is **not** the acceptance scope.

**One reply cannot satisfy the chain in any case.** The scenario needs a second,
deliberately reworded message for semantic dedupe (condition 4), a person's
override of a stored priority (5), a probe inside `GENERAL_LIGHT_PROBE_V1` (6),
one atomic budget reservation (8), one fragment researched, verified,
synthesised and audited by three separate sessions (11, 12), exactly one
follow-on (15), and a genuine out-of-authority park that a person answers and
the **same** mission resumes from (17). A conversational reply that discusses
capturing a candidate is not evidence that any of that happened, and the prose
of a reply is never evidence for a row.

**What a clean run therefore is.** One **new** conversation, the frozen message
sent verbatim, the near-duplicate sent after the first is captured, and then the
scenario's own steps. Nothing about the seventeen conditions changes, no scope
is chosen after the fact, and the permit thread keeps every message, candidate
and attempt it already has.
