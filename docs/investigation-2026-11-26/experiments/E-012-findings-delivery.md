# E-012: findings delivery at REF (`findingsOf`, `projectEvidenceClaims`; W1e)

**Hypothesis.**
- At REF, the 120 cap and lane rotation show the decisive verified facts that the c52d6d3 40-newest cut.
- Refuted claims are filtered.
- Past the cap, selection is by relevance.

**Inputs.**
- `docs/intelligence-test-2026-11-26/verified/v_{p02,p06,p10}.json`, selected and ordered exactly as `tools/batch.py` did (EXACT|FUZZY, follow-up rounds first).
- The selection is shaped as the `ResearchClaim` the probe supplied.
- Decisive facts are named by `INTELLIGENCE-TEST-30Q-2026-11-26.md`. For p10:
  - agency 10–20% of spend / £1,000 a month;
  - 52% of small businesses budget under $1,000;
  - cold email $152.73 per booked meeting;
  - $100–500 per client.

**Command.** `node --import tsx docs/investigation-2026-11-26/experiments/harness/e012_findings.ts`

**Raw output.** `raw/E-012/result.json`, `stdout.txt`

## Results

| goal | supplied | dropped as duplicate | shown at REF (120) | p10 decisive shown at REF | in the c52d6d3 record (final_p10_cap, 40 newest) | REF algorithm at 40 |
|---|---|---|---|---|---|---|
| p02 | 111 | 6 (exact repeats across rounds) | 105 (all) | — | — | — |
| p06 | 111 | 0 | 111 (all) | — | — | — |
| p10 | 135 | 9 (exact repeats) | **120** of 126 | **4 of 4** | **0 of 4** | 2 of 4 |

- Every dropped "near-duplicate" is the same statement supplied twice from two rounds; no distinct fact is lost.
- For p10, W1e changes the recorded known-bad behaviour (category C: verified, not delivered). The repair works on this evidence.

## Fault injection

**F1: refuted or contested claim passed to `findingsOf`.**
- `contradictionState: 'REFUTED'` is filtered.
- `'CONTESTED'` is **shown**, with no marker that it is disputed.
- The DB read filters only `REFUTED` (`server/repos/research.ts:1193`, static).

**F2: 200 recent low-relevance claims ahead of the 135.**
- Lane rotation keeps every decisive fact.
- 42 of the 120 slots go to the injected noise.
- The selection never asks whether a claim bears on the goal or decision. It is lane round-robin plus recency.

**F3: 400 recent noise claims, read as production reads.**
- Production reads `projectEvidenceClaims(projectId, FINDINGS_SHOWN*3 = 360)`, ordered `created_at DESC` (`routeProposal.ts:1595`).
- **0 real claims reach `findingsOf`**, so 0 are shown.
- The newest-first DB limit cuts by **recency before** the lane rotation can act. A project with more than 360 newer claims hides older decisive facts entirely.
- On the main ask, `proposeGoalRoutes` passes its own `FINDINGS_COUNTED` (600) list instead (`:1971-1979`), so the limit there is 600. Same mechanism.

## Diagnostics

| question | detects known-bad? | passes known-good? | catches injection? |
|---|---|---|---|
| C21-P (shown vs verified) | yes; the repair fixes the recorded p10 case | yes | **no**: the recency cut at the DB read is not caught |
| C21-X (delivery + dedupe + refuted filter) | yes | yes | **partial**: CONTESTED is shown unmarked |
| C19-I (refuted never shown) | — | yes | REFUTED caught; CONTESTED not |
