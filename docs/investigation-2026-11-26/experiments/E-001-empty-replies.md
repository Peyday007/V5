# E-001 — What produces gpt-oss's empty replies inside Brain? (lead, observational)

**Question.** RC1 attributes empty route-ask replies to the GPU proxy's ~100 s idle cut, and W1j (streaming) was merged as the fix. Is that the mechanism?

**Primary evidence (E0, serving revision c52d6d3).**
`grep -h '^PROBE reply' docs/intelligence-test-2026-11-26/planner/*.txt`, tallied:

| model | replies | content "" | error on empty | latency of empties | latency of non-empty |
|---|---|---|---|---|---|
| gpu:openai/gpt-oss-120b | 12 | **6** | **null (all 6)** | 47.2–85.4 s | 45.9–73.4 s (3.7–5.0 KB) |
| free:auto/best-coding | 6 | 0 | — | — | 7.7–41.6 s |

**Code at the time and at REF.**
- Route ask budgets: proposer 3500/4000, critic 3000, direction critic 2500 tokens (`routeProposal.ts:1874,1898,2037,2062,2097`). Model exam: 16000 tokens, gpt-oss 0/47 empty.
- `chatFor` (`cheap/modelBench.ts:81-131`) and `readStream` (`:133-166`) **record no `finish_reason`**. A length-truncated reasoning reply and a genuinely empty one are indistinguishable in Brain's records.

**Competing explanations.**
- **H1a: proxy idle cut.** *Refuted for the empty-body symptom.* Every empty reply came back below 100 s with no error. The idle cut produces HTTP 524, a different symptom with an error: 2 of 3 question asks, and 11/30 in the exam. H1a is **supported** for the 524 symptom only.
- **H1b: reasoning tokens use up `max_tokens`, so `content` is empty.** *Supported, not established.*
  - Empties and successes have the same latency profile, which fits generation stopping at a cap.
  - The budget is 4–5× smaller than the exam's 16000, which produced zero empties.
  - The Qwen route in the exam showed exactly this pattern with `finish_reason: length`.
  - Missing: a recorded `finish_reason` or `completion_tokens` for a Brain-path empty.
- **H1c: Brain reads the reply wrong** (a content field Brain ignores, or `stripThink` removing the whole answer). *Unresolved.* It is not excluded by the evidence above. `stripThink` removes text only up to `</think>`, so a reply that never closes its think block keeps its text. Whether that fits depends on the template.

**Decisive experiment (bounded, read-only, not run yet).**
- Send one recorded empty prompt (`final_p02_cap.txt` PROBE prompt) to the production gpt-oss endpoint twice, at `max_tokens` 4000 and 16000, non-streamed, and record `finish_reason`, `usage.completion_tokens` and `reasoning_content` length.
- Predictions:
  - H1b: at 4000, `finish_reason=length` with completion tokens ≈ 4000 and content empty; at 16000, content present.
  - H1c: content empty, or present but discarded, regardless of budget.
- Cost: two GPU requests on the existing pod, through the existing read-only `planning-eval` probe path. No new infrastructure.

**Consequence for the register.**
- C23-M is recorded **CONTRADICTED**.
- RC1 is split into:
  - **RC1-a** (empty body under a reasoning budget): supported.
  - **RC1-b** (524 idle cut on non-streamed turns): established by the model exam's streaming re-ask; W1j deployed but not verified on Brain's path.
- The W1a retry at twice the budget (7000–8000 tokens) is a prediction to check. Whether 2× is enough is unknown.
