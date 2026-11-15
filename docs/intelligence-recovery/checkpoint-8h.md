# BRAIN INTELLIGENCE RECOVERY — EIGHT-HOUR WAKE-UP STATUS (2026-11-15 03:42Z)

Operation start 2026-11-14 19:42Z. Full inventory: `docs/INTELLIGENCE-RECOVERY-2026-11-14.md`.
Production evidence: Goals runs 43634448117 (baseline census), 43654436460 / 43667549093 (census after
releases), 43654511789 / 43667546686 (plan reads), Agents runs 43654508964 / 43670283980 (Hermes).

## A. Is the operation complete?
No. Five releases have shipped: PR #897, #901, #905, #906 and #909, deployed as 1066, 1070 and 1075. Part 5
(PR #909) is deploying in Deploy 1079: 1078 stood down when PR #910 superseded it. Several capabilities work on production, measured below. Others are released
but not yet seen working on production's data.

## B. What materially improved (measured on production)
| capability | 19:53Z baseline | now | source |
|---|---|---|---|
| constructed arrangements durably stored | 0 | 404 (404 unique signatures) | census 02:25Z |
| arrangements evaluated in a goal model | 0 | 12 | census 02:25Z |
| arrangements in a best combination | 0 | 1 | census 02:25Z |
| commercial positions stored | not stored | 14 | census 02:25Z |
| constructed money flows | not stored | 247 | census 02:25Z |
| $10K plan read time | 26 min 41 s | 71 s | plan read 02:23Z |
| independent evaluation (cases A–Q + goal sizes) | 11/18 | 18/18 | evaluator suite |
| Hermes directing | no mission, no inventory | runs on its own schedule with the mission; commissions, re-attempts, decides | operator-show 02:59Z |

## C. Knowledge base (production, 02:25Z)
52 industries, 12 subcategories, 91 nodes (17 discovered), 11 buyer populations, 7 needs, 7 supplier categories,
2 transaction types; 498 openings (49 with payer and price); 16,817 sourced observations from 4,950 sources;
404 stored arrangements (BROKER 17, PRODUCE 360, SUBCONTRACT 16, POOL 11); 14 positions; 247 money flows;
0 construction facts; 0 researched, transferred or evidenced arrangements; 103 plan readings, 0 accepted,
0 outcomes. Growth since baseline is in arrangements, positions, flows and evaluation. Industries, nodes and
facts have not grown yet; the repairs for that shipped in part 5.

## D. Findings
About 100 findings, grouped under 8 root causes (IB-1 to IB-8), plus the independent-evaluation findings
(E-1, I-1, L-1, G2), the production findings (P-SPEED, P-ADMIT, PRICE-POOL) and the adversarial
production-gap findings (F1–F9). Status at the checkpoint:
- 12 verified on production;
- 16 released before part 5;
- 21 released in parts 3–5;
- 8 released but not yet verified;
- 1 handed to Surge A (F9.1);
- 1 not a defect (A-CAP);
- A-10K is an evidence gap, not a code defect, and is directed to Hermes.

New failure categories found by the adversarial pass:
- a gate on a fact kind production never writes;
- a writer whose only reader is off the path that failed;
- uniform sampling across pooled prices that span orders of magnitude;
- a capability that only runs on worker threads;
- model output refused for its shape.

## E. Repairs completed
- Persistent arrangement library.
- World expansion without a sprint.
- Dated construction facts.
- One acceptance rule: comparables can certify with margin; assumptions never do.
- Quantitative selection with diversity.
- Milestone tranches counted (E-1), presale plausibility judged on margin (I-1), contradictions surfaced (L-1).
- Transfers name their material differences (G2).
- Claim lifecycle: method, sample size, validity, invalidation; decay instead of a cliff.
- Adaptive stance budget (S-9/S-10), interaction-safe screening (S-16), invented designs as candidates (S-11).
- Hermes: deficiency detectors and direct research commission.
- A research fragment whose lanes are all conditional is no longer failed by the verifier (A-O6).
- Arrangements admitted to the goal model (P-ADMIT).
- Plan speed (P-SPEED-2).
- Comparable prices and capital owned by the opening's own evidence (F4/F6).
- Real precedents (F1), facts reaching value (F2), fact back-fill (F3).
- Standing arrangement research (F7).

## F. Tests
Each release passed its affected tests and Deploy's full suite:
- part 2: 2,999 tests;
- part 3: 3,703;
- part 4: 519;
- part 5: 3,445, with 2 failures fixed afterwards (a stricter transfer fixture, and a load flake).

The Postgres suite gate passed on every deploy.

## G. Quantitative reconstruction and acceptance
- Comparable and component evidence reconstructs inputs with intervals.
- Three sized comparables certify at 90% only with margin: 5th-percentile reach of 98.75% in case O.
- Unsized, single-source, assumed and contested evidence never certifies.
- The production $10K plan is correctly CANDIDATE_ONLY.
- Its post-part-4 figures were inflated by F4: p90 of $101M. The repair shipped in part 5.

## H. Strategic reasoning
- Multidirectional search is live: 255 combinations searched, and reconstruction across capacity, capital, cash timing, price and transaction.
- Stance budgets now learn from yield.
- Model-proposed methods were all refused for their shape (F9.2); the fix shipped in part 5.
- The variable sweep is abandoned on production because no evaluation thread is running (F9.1, Surge A).

## I. Hermes
- Model: auto/best-coding on the free switchboard.
- Production runs:
  - opr_a1f7…: 29 calls;
  - opr_7842…: 22 calls, self-scheduled;
  - opr_1981…: 23 calls, self-scheduled, with 2 commissions, a re-attempt, submit_fix and 3 decisions;
  - one failure on database pool exhaustion (Surge A).
- Hermes directs through Brain's own tools without a Claude prompt.
- Still unverified: that its commissions complete and that it verifies a released repair.

## J. Resources and spending
- Additional spending by Surge B: $0. Combined across both surges: about $0.30/day (Surge A's 4 GB VM).
- Remaining authorized budget: about $99.70.
- Engineering ran on this session's agents plus Brain's own Factory and Hermes. No new paid resources were needed.
- The bottleneck was verification on production, not compute.

## K. Remaining work, critical path, forecast
- Critical path: Deploy 1079 (carries part 5) → production census and plan read → confirm:
  - facts are back-filed;
  - transfers fire;
  - arrangements are researched;
  - prices are sane after F4;
  - stance learning and model directions work.
- Remaining owned items:
  - verify the eight released-but-unverified rows;
  - the A-10K evidence gap: only sized evidence or measured outreach closes it.
- Surge A handoffs: F9.1 evaluator threads, `whyNotDiving` serial queries, repeated `listOpportunities`, pool exhaustion.
- Forecast: production verification of part 5 within about 2 hours. The 48-hour target (19:42Z on 11-16) remains plausible.
- Owner decisions needed: none.
