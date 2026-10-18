# Friend account usage audit — 2026-10-17

A read-only accounting of what Brain did with Airyn's and Caleb's Claude Routines
between **2026-10-10 19:27Z and 2026-10-17 19:35Z** (7 days), and in the last 24 hours.

Nothing was launched, dispatched, probed, deployed or changed to produce it. Every
figure comes from a read-only report run inside the released container
(`f3778119`), via the existing workflows:

| reading | workflow run |
|---|---|
| dispatch history, one row per fire (7d) | Connection report #99 (`--hours 168 --history`) |
| per-worker work ledger and MCP calls (7d) | Connection report #100 (`--hours 168`) |
| per-worker work ledger and MCP calls (24h) | Connection report #101 (`--hours 24`) |
| account and worker mapping | Fleet #505 (`attribution`), #506 (`show`) |
| every live bin, attempts and generations | Fleet #507 (`work-audit`) |
| in-flight fires, unrouted reasons, event totals | Dispatch diagnose #24 |
| research yield, gate outcomes, source blocks | Cash report #96 |
| refinement, research passes by executor (24h) | Closeout report #126 (`refinement`) |
| Factory campaigns | Factory #669 (`campaigns`) |
| two bins' full event trails | Step 10 #366, #367 (`trace`) |

**Labels.** *Measured* = a count of Brain's own rows. *Estimate* = arithmetic or
judgment on top of them, said so where used. *Unavailable* = Brain holds no row
that could answer it.

---

## 0. Urgent — still happening now

1. **Caleb 3-A is firing sessions that never reach Brain.** 54 consecutive fires
   since 2026-10-17 02:33Z, zero arrivals (last arrival 02:28:05Z). Every fire
   returned a Claude session id (`cse_…`), so a session was started in Caleb's
   account each time. It is still `ENABLED` because its no-show counter reads
   `unanswered=2`: an unanswered fire is only counted while its bin stays at the
   same generation, and Airyn's sessions keep taking those bins first, so Caleb's
   misses are never counted and the 3-strike quarantine never trips.
2. **A hand-back → re-fire loop is multiplying fires, mostly on Airyn's account.**
   A live session takes a bin, finds nothing it can claim, releases it; the
   release advances the bin's generation, which creates a brand-new dispatch
   intent, which fires another Routine. Observed live on
   `bin_63116d5b02044be6ae4c`: 5 fires in 2 min 29 s (Airyn 2-A, Caleb 3-A,
   Airyn 2-D, Airyn 2-C, Airyn 2-A), zero research done, bin exhausted.
3. **Airyn's account has no concurrency target** (`target=—`, routed as
   `0/∞ on the Routine, n/∞ on the account`). Brain's account and Caleb's are
   capped at 4. Nothing bounds how many of Airyn's Routines are fired at once.

---

## 1. Account-by-account usage

Who owns what, from `fleet attribution` / `fleet show`:

| account | Routines | Brain worker |
|---|---|---|
| **Airyn** | Airyn 2-A, 2-B, 2-C, 2-D (research); Factory surface 2 (Factory) | worker-12 `wkr_9826…`; Factory = worker-10 `wkr_f8e1…` (shared) |
| **Caleb** | Caleb 3-A (enabled), 3-B, 3-C, 3-D (quarantined since 10-12/10-12/10-14); Factory surface 3 (quarantined) | worker-04 `wkr_1db1…`; Factory = worker-10 (shared) |
| "Brain Research A" (comparison) | Brain Research A, 1-B, 1-C, 1-D; Factory surface 1 | worker-05 `wkr_1cdd…` |

The "Brain Research A" account is registered to the Brain owner
(`usr_14439966…`), not to Airyn or Caleb. Its legacy handle `airynworker2` is a
lookup key and attributes nothing; confirm whose Claude subscription it actually is.

### Fires and arrivals per Routine (measured, `bin_events`)

"Fired" = `DISPATCH_SENT` (Brain started a Claude session). "Arrived" = the
fired session checked in to Brain. Probe = recovery probe fire (also a real session).

| Routine | 7d fired | 7d arrived | 7d wrong connector | 7d no-show / infra | 7d probes | 24h fired | 24h arrived |
|---|---:|---:|---:|---:|---:|---:|---:|
| Airyn 2-A | 1,648 | 1,491 | 0 | 20 / 10 | 8 | 139 | 91 |
| Airyn 2-B | 222 | 166 | 5 | 0 / 3 | 10 | 140 | 103 |
| Airyn 2-C | 649 | 569 | 450 | 3 / 2 | 36 | 140 | 106 |
| Airyn 2-D | 213 | 142 | 5 | 1 / 1 | 12 | 139 | 89 |
| Factory surface 2 (Airyn) | 24 | 17 | 0 | 0 | 0 | 0 | 0 |
| **Airyn total** | **2,756** | **2,385** | **460** | **24 / 16** | **66** | **558** | **389** |
| Caleb 3-A | 431 | 141 | 0 | 17 / 5 | 8 | 106 | 32 |
| Caleb 3-B | 23 | 6 | 0 | 3 / 0 | 8 | 0 | 0 (1 probe) |
| Caleb 3-C | 59 | 10 | 0 | 3 / 1 | 11 | 0 | 0 (6 probes) |
| Caleb 3-D | 201 | 21 | 0 | 9 / 1 | 13 | 0 | 0 (6 probes) |
| Factory surface 3 (Caleb) | 0 | 0 | 2 | 0 | 8 | 0 | 0 (1 probe) |
| **Caleb total** | **714** | **178** | **2** | **32 / 7** | **48** | **106** | **32** |
| Brain Research A/1-B/1-C/1-D | 1,161 | 976 | 0 | 7 / 7 | 4 | 182 | 178 |

Daily fires, Airyn 2-A: 199, 398, 235, 362, 244, 103, 107 (10-11 → 10-17); peak
48 fires in one hour (10-12 05h and 10-14 05h).

Median fire→arrival: 13–43 s. **Session time occupied is unavailable**: Brain records
when a session was fired, when it checked in and its tool calls, but not when the
Claude session ended.

### What arrived sessions did (measured, bin ledger by worker, 7d / 24h)

| worker (account) | bins handed out | completions accepted | handed back unfinished | completions refused | work items claimed |
|---|---:|---:|---:|---:|---:|
| Airyn research `wkr_9826` — 7d | 4,408 | **75** | 4,221 | 502 | 1,440 |
| Airyn research — 24h | 863 | **1** | 845 | 54 | 297 |
| Caleb research `wkr_1db1` — 7d | 368 | **5** | 329 | 52 | 163 |
| Caleb research — 24h | 56 | **0** | 51 | 4 | 19 |
| Brain Research A acct `wkr_1cdd` — 7d | 1,350 | 33 | 1,065 | 783 | 1,456 |
| Brain Research A acct — 24h | 210 | 8 | 166 | 101 | 236 |
| Factory `wkr_f8e1` — 7d (all on 10-11/12) | 33 | 33 | 0 | 2 | — |

MCP tool calls, Airyn's research worker, 7d: `check_in` 5,038, `bin_next_item`
7,163 (930 failed), `bin_release` 4,248, `bin_manifest` 3,490 (1,994 failed),
`report_blocker` 2,291 (1,253 failed). Against that: `submit_claims` 411
(241 accepted), `submit_audit` 391 (245 accepted), `submit_verification` 164
(90 accepted), `submit_synthesis` 20 (13 accepted).

Research passes completed in the last 24h (measured, `research_passes` by executor):
Airyn 101 (61 audit, 27 targeted research, 17 verification, 1 synthesis);
Caleb 8; Brain Research A account 212.

---

## 2. What they worked on

Almost everything was **Cash Mode 1** (`prj_22fb4fec…`): 289 of 352 live bins,
and every research completion above. Factory work this week was one campaign's
tail on 10-11/12 (PR #191 merged 10-12) — **no Factory work since 10-12**.

Live bins by category (measured from `fleet work-audit`; "hand-offs" = generation
count, i.e. times the bin was given out or handed back):

| category | live bins | hand-offs | exhausted |
|---|---:|---:|---:|
| Deep dives on existing openings (Qualify / Payer / Access / Price…) | 148 | 1,630 | 78 |
| Monetization-ledger questions (Competition / Scalability / Required relationships / Exposure…) | ~82 | ~770 | ~35 |
| New opportunity discovery (the 10 Cash buckets) | 70 | 547 | 17 |
| Design renders of Brain's own UI | 28 | 167 | 28 |
| Industry / dealflow / puzzle / goal-budget proofs / other | ~24 | ~300 | ~10 |
| Factory | 2 | 7 | 2 |

Highest-volume subjects (live bins / hand-offs):

| subject | bins | hand-offs | note |
|---|---:|---:|---|
| VJN.com / Dujo.com domain appraisals (one trade-press observation) | 62 | 609 | market evidence, not a buyer; still being researched right now |
| City of St. Louis procurement notices | 46 | 492 | at least 2 openings closed 10-13 |
| Puzzles / Sudoku | 17 | 190 | |
| Library of Congress / NEH grants | 17 | 189 | 21 openings disqualified: for-profits not eligible |
| Copart / IAA auto brokers | 17 | 123 | |
| Sneaker / ticket resale prices | 13 | 151 | market evidence |
| GitHub bug bounty | 13 | 132 | |
| NJ Dept of Health RFQ | 10 | 142 | |
| Texas surplus jewelry auction | 7 | 72 | |
| GoTranscript / Rev per-minute prices | 3 | 86 | market evidence; one bin alone has 49 hand-offs |

The ten discovery questions ("Who is publicly asking to pay for work right now",
"Where the same deliverable has two published prices", …) each exist as 5–8
separate packets. Of 252 openings found, **140 re-found an opening already held**.

**Repeated / old low-value work: yes.** The research holding Brain's slots at
19:33Z today was "Competition: Referral fee — Appraise.net valued VJN.com…",
"Scalability: Referral fee — …VJN.com…" and "Access for … domain-name appraisal
software" — the same single domain-appraisal observation, asked again under new
headings.

---

## 3. Waste

**Demonstrated** (Brain's own rows show the session could not or did not produce anything):

| cause | evidence | size |
|---|---|---|
| Hand-back → re-fire loop | release creates a fresh dispatch intent; worker checkpoints: "brain_bin_next_item returned nothing claimable… No research or submissions made" | 5,615 hand-backs in 7d (Airyn 4,221, Caleb 329, other 1,065); 97% of Airyn's 4,408 hand-outs ended unfinished |
| Caleb's dead connector | 3-A: 54 straight fires since 02:33Z, 0 arrivals; 3-B/C/D quarantined but probed daily | ~74 unanswered 3-A fires in 24h (106 − 32); 48 probe fires on Caleb's account in 7d, 29 of Caleb's probe readings `NO_MCP` |
| Wrong connector | Airyn's research Routines (mostly 2-C) arrived as the Factory worker and were given nothing | 460 sessions, 10-11 → 10-14 (stopped 10-14) |
| No network access in the Routine's environment | "No network egress to source hosts (ENOTFOUND)"; Airyn 2-A 45 DNS failures + 5 environment denials, 2-C 20 DNS failures | 438 fragments blocked on source access + 126 unreadable in 7d |
| Assignments that cannot progress | design-render bins sent to research Routines with no browser: "No render was submitted" | 28 bins, all exhausted (~84 attempts) |
| Verification / audit failures | `submit_claims` 170 failed, `submit_audit` 127 failed, `submit_verification` 62 failed (Airyn, 7d) | — |

**Legitimate work that failed:** 969 of 1,120 fragments judged in 7d were blocked;
367 packets ended "no fragment cleared its evidence gate". Some of that is the
network problem above; some is research honestly finding nothing.

**Estimate (judgment, not measured): research that cannot change a commercial
decision.** The commercial grant is ABSENT and the messaging, invoicing and
payment providers are MISSING, so no Cash result can currently lead to contacting,
quoting or billing anyone. 182 monetization questions asked, 6 answered, 137
unresolved. Deep dives on expired, disqualified and duplicate openings sit here too.

---

## 4. Return on usage (7d unless marked)

| result | measured |
|---|---|
| Research packets completed | 63 (all accounts; per-account split not recorded per packet) |
| Fragments with accepted evidence | 151 of 1,120 judged |
| Claims accepted | 1,283 of 1,811 submitted |
| Newly qualified opportunities | **0** (sprint-wide: qualified=0) |
| Ready-to-test opportunities | **1** (sprint-wide, ever) |
| Factory units / PRs | one campaign completed on 10-11/12 (PR #191), partly via Airyn's Factory surface 2; nothing since |
| Real commercial outcomes | **0** — money ledger has 0 entries; $0 |
| Completed bins per fire | Airyn 75 / 2,756 = 2.7%; Caleb 5 / 714 = 0.7%; Brain Research A acct 33 / 1,161 = 2.8% |
| Research passes per fire (24h) | Airyn 101 / 558 = 0.18; Caleb 8 / 106 = 0.08; Brain Research A acct 212 / 182 = 1.16 |

Value producers: the Brain Research A account's Routines (about one research pass
per fire). Capacity consumers without results: Airyn's Routines (~6× fewer passes
per fire, largely the release loop and no network egress) and Caleb 3-A.

---

## 5. Actual Claude limits

**Brain does not have per-account Claude usage.** No token counts, no subscription
percentage, no cost. What it does have:

- fire counts per Routine, with the Claude session id (`cse_…`) of each fire;
- provider refusals: Claude refused Airyn 2-A fires 36 times (`fleet show`,
  `refusals=36`), Airyn's account carried a provider cool-off until 10-17 01:35Z,
  and 79 `PROVIDER_ALLOWANCE` events exist all-time — the closest thing to
  evidence that limits are being hit;
- a table for a person to type in what an account's usage screen says
  (`fleet_allowance_reports`); none of the readings above print it.

To reconcile Brain's history with real usage, each account holder would need to
export, from their own Claude account: the usage page readings over time (each
limit window), the Routine run list with session ids, start/end times and
durations, and any per-session token figures Claude shows. The session ids join
to Brain's `DISPATCH_SENT` rows directly.

---

## 6. Biggest confirmed waste, and the smallest safe corrections

Not implemented. Ordered by size.

1. **The hand-back → re-fire loop.** Smallest fix: when a worker releases a bin
   because nothing is claimable, do not create a new dispatch intent until the
   bin has an item `brain_bin_next_item` would actually hand out (the same
   predicate, so the two cannot disagree). Immediate operator stopgap: give
   Airyn's account a concurrency target like the other two
   (`fleet set-target`, scope ACCOUNT, Airyn, 2–4) — a reversible row.
2. **Caleb 3-A's dead connector.** Immediate: quarantine Caleb 3-A
   (`fleet set-state`, reversible) and have Caleb fix the connector selection in
   his Claude Routines. Fix: count a fire whose own session never arrived as a
   no-show even when another session took the bin; stop daily probes of 3-B/C/D
   until Caleb says it is fixed.
3. **Research Brain cannot use.** Stop deep dives and monetization questions on
   openings that are duplicates, expired, disqualified or market evidence only
   (VJN.com, Rev/GoTranscript, sneaker resale, NEH, closed St. Louis bids), and
   route design-render bins only to a surface with a browser. Ask Airyn to allow
   network access in his Routines' environment, or stop sending research to 2-A
   until he does.
