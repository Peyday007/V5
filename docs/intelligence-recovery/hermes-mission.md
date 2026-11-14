SURGE B — INTELLIGENCE RECOVERY. You direct it.

Owner's order (2026-11-14): make Brain understand the economic world more deeply, persist and reuse that knowledge, reconstruct uncertain quantities from evidence, plan with honest uncertainty, and improve its decisions. Surge A (another operation) owns runtime reliability: database pressure, event loop, deploys. Do not commission work in those areas; record them as EXTERNAL_CONSTRAINT.

Your job each run:
1. Keep the inventory true: brain_operator_inventory list; upsert any finding below that is missing (key SURGE-B:<id>), with its capability, symptom, severity and verification criteria. Never mark VERIFIED_FIXED without a run id, deploy, or measured number.
2. Decide what matters next by what blocks planning quality most, and say why (brain_operator_decide for any non-trivial choice).
3. Commission engineering only for a confirmed, owned cause not already being repaired (status REPAIRING means a repair is in flight — do not duplicate it). Commission evidence/research where the cause is not established.
4. Read brain_operator_engineering; re-attempt (brain_operator_reattempt) a commission that stalled or failed; record lessons.
5. After a repair is released, require verification: read the goal plan again and compare to the baseline below.

Root causes found (status as of 23:00Z; part 2 released in PR #901, Deploy 1070):
IB-1 knowledge grows only inside a cash sprint (W-1..W-4) — RELEASED, AWAITING VERIFICATION (census growth without a sprint)
IB-2 economic facts hand-entered, undated, logistics-shaped vocabulary (W-5,6,7,10,13) — RELEASED, AWAITING VERIFICATION (construction_facts > 0)
IB-3 Hermes could not be given a mission or track work (H2-1,2,5,7,9,11) — released in PR #897
IB-4 evidence lifecycle thin: claims lack method, sample size, validity window (W-11, W-12) — ROOT CAUSE CONFIRMED, unowned
IB-5 two construction vocabularies; transfer only under a goal (W-8) — ROOT CAUSE CONFIRMED, unowned
IB-6 constructed arrangements never persisted (K-1..K-8) — RELEASED, AWAITING VERIFICATION (monetization_paths rows with design_signature)
IB-7 arrangement selection arbitrary: 12 picked by hash order; unknowns ranked at midpoint (S-1..S-17) — RELEASED, AWAITING VERIFICATION (S-10, S-13 open)
IB-8 acceptance gates mutually exclusive: no plan can be ACCEPTED before the cash is collected (Q2-1..Q2-12) — RELEASED, AWAITING VERIFICATION
Also from independent evaluation: E-1 deposit+milestone counted $0 — RELEASED; I-1 presale refused as implausible on gross receipts — RELEASED; L-1 contradictory sources pooled silently — RELEASED.
Also DISCOVERED, unowned: H2-3 deficiencies come from only three detectors; H2-6 research only via a commission; S-9 repeat reads counted independent; S-16 factorial screen drops combination-only levels; W-9 one Detroit reference pack applied to any logistics subject; K-6 positions/roles/flows not stored.

Baseline (production 19:53Z): 52 sectors, 91 nodes, 11 buyer populations, 7 needs, 7 supplier categories, 2 transaction types, 1 project mapped; 498 openings, 49 with payer and price; 16,762 sourced claims; 0 construction facts; 0 stored arrangements; 100 plan readings on one goal, 0 accepted, 0 outcomes.

Received from Surge A: A-O6 research rounds ending without a report — REPAIRING (do not duplicate). A-10K the $10K plan has no buyer-validated opening and unmeasured conversion — an evidence gap: decide and commission the research or measurement that would let a plan certify on sized evidence (never on assumption). A-CAP starting capital chain — reviewed, not a defect.
Independent evaluation: 18/18 cases pass on the released code (baseline 11/18). Planning-speed target: initial plan 1-5 min; baseline 26m41s for the $10K goal.
