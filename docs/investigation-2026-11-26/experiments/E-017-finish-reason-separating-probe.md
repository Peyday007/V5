# E-017: The separating probe for truncation (U-01, Gate B §2)

**What was run.**
- Workflow: `planning-eval.yml finishprobe --run dec1125c --case p02`, run 45774422897, 2026-11-26 07:19Z.
- Served from production. The `finishprobe` command lived in `scripts/planningEval.ts` at commit c456093 on the investigation branch; it was removed after the run, so the branch carries no code change. `server/` was never changed.
- Input: the same 111 facts as E-002. 105 findings were shown, giving a 35,437-character prompt.
- Each of three arms sent one raw streamed request to the first challenger model, `gpu:openai/gpt-oss-120b`, on the existing GPU.
- For each request the probe recorded what `readStream` discards: `finish_reason`, `usage`, whether `[DONE]` arrived, stream error events, reasoning length, the time to the first content token and the largest gap between chunks.
- It wrote nothing to the database.
- Raw output: `raw/E-017/eval.txt`.

**Results.**

| arm | finish_reason | completion tokens | reasoning chars | content chars | [DONE] | errors | largest chunk gap | first content | ms | routes parsed |
|---|---|---|---|---|---|---|---|---|---|---|
| A: 4000 tokens (the production route-ask budget) | **length** | **4000 / 4000** | 11,112 | 4,085, cut mid-route | yes | none | 1.98 s | 30.4 s | 41,090 | 2 (a third was cut off) |
| B: 16000 tokens | stop | 5,046 | 13,859 | 5,418, complete JSON | yes | none | 0.56 s | 38.6 s | 55,810 | 3 |
| C: 4000 tokens, reasoning_effort low | stop | 1,384 | 1,069 | 3,884, complete JSON | yes | none | 3.50 s | 6.6 s | 18,694 | 2 |

**What it establishes.**
1. **H1b, reasoning-budget exhaustion, is ESTABLISHED as the truncation mechanism on this prompt.**
   - Under the production budget, the model spent most of its 4,000 tokens reasoning and stopped with `finish_reason: length` in the middle of the answer.
   - The same prompt completes with 16,000 tokens (it used 5,046) and with low reasoning effort at 4,000 (it used 1,384).
   - The prompt, the model and the time were held constant, so the budget is the variable that separates them.
2. **A stream drop or reset is EXCLUDED for this sample.**
   - `[DONE]` arrived, there was no error event, and no trailing buffer was left.
   - The largest gap between chunks was 2 s, far below any idle cut.
   - This excludes the stream explanation for this sample only. E-015's finding stands: `readStream` *would* hide a drop.
3. **H1c, the answer placed in the reasoning field, is EXCLUDED for this server.**
   - Reasoning arrives in a separate delta field that `readStream` ignores.
   - The answer arrives in `content`, and `content` carries no `<think>` text.
4. **The partial loss is reproduced on production (CR-16).**
   - The truncated reply in arm A still parses to 2 routes, and the third route is lost with no record.
   - `askModel`'s empty-only retry would accept this reply as a success.
5. **The production budget sits below what this model needs on a full-findings prompt.**
   - The completed arm needed 5,046 tokens. The route-ask budget is 4,000, or 8,000 on the empty retry.
   - The empty retry is never reached when a partial answer arrives.
   - This holds for findings-heavy prompts. W1e raised the findings cap to 120, which made the prompt about 9k tokens and increased the reasoning load.

**Interaction newly shown.** W1e (more findings delivered) together with the fixed 4,000-token budget gives a longer reasoning chain under an unchanged budget, which means more truncation. One repair (W1e) increased the incidence of the CR-01 symptom. This explains E-002, where E1 truncated while E0 had been mostly empty or fallback.

**Limits.**
- n = 1 per arm at temperature 0.3, on one prompt. This is the decisive separating test Gate B specified, not a rate.
- E0's *empty* replies (rather than truncated ones) are not re-run here. Their budget explanation is consistent with this result but remains SUPPORTED: a reply that is all reasoning, with `length` before any content, gives `content ""`.

**Prediction for the correction.** If route asks carry a budget adequate to this model's measured reasoning use, or a bounded reasoning effort, and a reply with `finish_reason: length` is treated as a failed turn, then arm A's outcome disappears. The proof is a replay of the E-002 and E-001 prompts with `finish_reason` recorded, showing zero accepted `length` turns.
