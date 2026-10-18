# Opportunity intelligence: production baseline, 2026-10-18

Taken before any Opportunity Intelligence change was released, so every later
"up" or "down" has a measured denominator. Read-only: Cash report #97
(run 39088488312) inside the released container, `SERVING_REVISION
36a2b7026404d955b9c2731a1a85ecc3ded6936b`, at 2026-10-18 02:00Z. Project:
Cash Mode 1 (`prj_22fb4fec295f403a8a22`), ACTIVE, research grant concurrency 6,
policy UNCAPPED, no commercial grant, money ledger empty.

## Portfolio (255 opportunities)

| tier | count |
|---|---|
| SIGNAL | 204 |
| CANDIDATE | 50 |
| QUALIFIED | 0 |
| READY_TO_TEST | 1 |

State: 254 DISCOVERED, 1 READY. Openings found 255, of which 143 re-found an
opening already held (43 distinct openings found more than once).

Why no deep dive is running, per opportunity (`whyNotDiving`):

| reason | count |
|---|---|
| DUPLICATE | 143 |
| ROUNDS_SPENT (two-dive lifetime limit reached) | 61 |
| AWAITING_PERSON | 28 |
| DISQUALIFIED | 21 |
| EXPIRED | 2 |

Nothing recorded can bring a ROUNDS_SPENT, DISQUALIFIED or EXPIRED opening
back, so 84 openings are permanently dead ends.

## Research yield, last 7 days (2026-10-11 → 2026-10-18)

- Fragments judged: 1,177. Accepted: 163 (**13.8%**). Blocked: 1,014.
- Claims submitted: 1,915. Accepted: 1,362. **Accepted claims inside BLOCKED
  fragments: 709**, which the archive check cannot reuse. Unread: 341.
- Block causes, classified by a report, not stored:

| cause | fragments |
|---|---|
| SOURCE_ACCESS | 458 |
| SOURCES_UNREADABLE | 134 |
| VERIFIER_INSUFFICIENT | 134 |
| NO_GATE_VERDICT | 129 |
| REQUIRED_LANE_EMPTY | 79 |
| NOTHING_SURVIVED | 39 |
| WORK_FAULTED | 28 |
| INDEPENDENT_SOURCES_SHORT | 9 |
| MOSTLY_REJECTED | 2 |
| UNCLASSIFIED | 2 |

- Source-access blocks are mostly DNS failures with no Routine attributed
  (161). The largest attributed ones are Airyn 2-A (45 DNS, 23 unreadable) and
  Airyn 2-C (20 DNS).

## Packets (all time)

960 packets: COMPLETE 88, NEEDS_HUMAN 203, CANCELLED 647, RESEARCHING 9,
QUEUED 7, AWAITING_REPAIR 5, AUDITING 1. Fragments 1,721: ACCEPTED 232,
BLOCKED 1,333.

## Session usage (from docs/FRIEND-ACCOUNT-USAGE-AUDIT-2026-10-17.md)

Over 7 days, 3,470 sessions were started on Airyn's and Caleb's accounts. They
produced 80 accepted completions and 5,615 hand-backs.

Over the 24 hours before the hand-back fix (36a2b70, released 2026-10-18
00:42Z):

| account | fires | arrived | accepted completions |
|---|---|---|---|
| Airyn | 558 | 389 | 1 (845 releases) |
| Caleb | 106 | 32 | — |
| Brain Research A | 182 | — | 212 passes |

## What the release will be judged against

- QUALIFIED and READY_TO_TEST counts and their per-week throughput (0 and 1
  today).
- The share of fragments accepted (13.8%). The plan also tracks requirements
  closed by the archive against requirements asked (no figure today).
- ROUNDS_SPENT and DISQUALIFIED openings that are reconsidered when a real
  change arrives (0 today: nothing can reconsider).
- Accepted completions per session started, against the audit figures above.

## Refinement (Closeout report #127, run 39088490640, same revision)

- Deep-dive states: NOT_STARTED 144, COMPLETE 14, NEEDS_PERSON 28, BLOCKED 69.
- Slots in flight: 0 of 2. Rounds cap: 2. Stall backstop: 6h.
- Verdict printed by Brain: "no opening is eligible". **Refinement is
  stopped**: every opening is DUPLICATE, ROUNDS_SPENT, AWAITING_PERSON,
  DISQUALIFIED or EXPIRED. The research slots that remain are spent on
  monetization commissions. The live holder was a VJN.com expected-revenue
  question.
