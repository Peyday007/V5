# E-002: Known-bad replay of p02 final-cap on production after the wave-1 repairs (E1)

**What was run.**
- Command: `planning-eval.yml probe --run dec1125c --case p02`, run 45769722129, 2026-11-26 06:39–06:42Z.
- Served by **`a8c46995f6`**, the production revision with W1a–W1j deployed.
- Input: the exact 111 verified facts of the recorded E0 failure `docs/intelligence-test-2026-11-26/planner/final_p02_cap.txt`. They were rebuilt with the recording's own `tools/batch.py` rule, and the supplied count of 111 matches the recording.
- The probe writes nothing to the database.
- Raw output: `raw/E-002/eval.txt`. Input: `raw/E-002/b2_p02_cap.b64`.

**E0 recording vs E1 replay.**

| step | E0 (c52d6d3, pre-repair) | E1 (a8c4699, post-repair) |
|---|---|---|
| findings shown | 40 of 111 (cap 40) | **105 of 111** (W1e cap 120; **6 still dropped** as near-duplicates) |
| primary model reply | gpt-oss `content:""`, error null, 85 s | gpt-oss `content` **2,103 chars, cut off mid-JSON** (`"grounds": {"channel`), error null, 80.5 s |
| fallback | free:auto/best-coding answered and planned | **not tried**: the probe stops at the first non-empty reply (`if (r.error \|\| !r.content) continue; … break`) |
| parseRoutes | 6 routes kept | `{"routes":[],"rejected":[]}`: **zero routes and zero rejections**, no error |
| critique | dropped all 6 (false WINDOW and CAPITAL claims) | `{"error":"unreadable"}`, called with an empty route list |
| owner receives | nothing | **nothing** |

**What it shows.**
1. **The outcome is unchanged on E1.** In this single replay the wave-1 repairs did not turn the known-bad case into a plan. The cause moved: the critic veto is not reached, because the failure now happens one step earlier.
2. **A truncated reply is treated as a success.** `askModel` (`routeProposal.ts:1436-1447`) retries only on *wholly empty* content. A reply that stops mid-JSON passes as an answer. Nothing records `finish_reason` (`modelBench.ts:81-166`), so the record cannot say *why* it stopped.
   - This is the same mechanism as E-001's empty replies: the completion budget (4000/8000 tokens with hidden reasoning) runs out. It shows up as a second symptom.
   - Status (corrected by Gate B GB-12): **NOT SEPARATED** — a dropped stream erased by `readStream:166` leaves an identical record; see GATE-B.md §2. The reply was cut mid-token-stream at a latency comparable to the empties, with no error.
3. **The parser discards destructively and reports nothing.** `parseRoutes(routesJson(content))` on a truncated object yields no routes and **no rejection**. The loss is not counted as a parse failure, so neither the probe nor production can tell "the model proposed nothing" from "the model's answer was cut off".
   - This is a new defect in the parsing class (RC9 family).
   - It conceals RC1-a from every downstream reading.
4. **The near-duplicate filter still drops 6 of 111 after W1e**, which claims the filter now compares whole statements. The 6 may be genuine duplicates. That needs a check against the 111 inputs (E-012 in the causal replay covers it).

**Limits.**
- One sample at temperature 0.3. This does not measure the empty or truncation *rate* on E1.
- It does not show whether the first attempt was empty and this was the 2× retry, or this was the first attempt. The probe records only the final `askModel` result.
- Not graded by an independent grader. Grading is moot when no route survives.

**Prediction it supports.** If the completion budget is the mechanism, then raising the route-ask budget toward the model exam's 16,000 tokens, or disabling or limiting reasoning effort, should remove both the empty and the truncated replies. Recording `finish_reason` should then show `length` on every such reply today.
- Decisive check: one request at 4000 vs 16000 tokens with `finish_reason` captured, as specified in E-001.
- That check needs a probe variant that records `finish_reason`, so it remains to be done.

**Register impact:**
- C23-P, C23-F and C39-P: E0 FAIL, E1 **FAIL again** (current production).
- C30-F (destructive parse): FAIL with a new mechanism.
- C21-P: findings delivery improved, 105/111 shown at E1.
- W1a (empty retry): **does not cover truncation**.
- W1e: improved delivery, observed on E1.
