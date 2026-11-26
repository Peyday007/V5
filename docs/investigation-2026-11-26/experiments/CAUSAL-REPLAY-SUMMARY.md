# Causal replay and fault injection: summary (E-010 to E-016)

All runs are local and deterministic, against REF `2d79f7d`, with no LLM and no production access. Brain's real exported functions are imported; nothing in `server/`, `tests/` or `scripts/` was edited.

**Runner.**
- `node --import tsx <harness>.ts`
- The sandbox chain test: `npx vitest run --config docs/investigation-2026-11-26/experiments/harness/vitest.config.ts <file>`
- Dependencies were installed outside the repository (scratchpad, symlinked at `/home/user/node_modules`).

**Epochs.**
- Known-bad inputs are the E0 recorded replies and critiques (serving revision c52d6d3), plus E-002 (E1, a8c4699).
- Everything else is a constructed control or an injection.

| exp | what was replayed or injected | repair under test | recorded known-bad changed at REF? | known-good control | injected fault caught? | questions |
|---|---|---|---|---|---|---|
| E-010 | 17 recorded replies → `parseRoutes`; constructed economics; E-002 truncation | W1c, W1d | **W1d yes** (p10 OWNER_FIT ×2 now kept). **W1c no** on recorded replies: they have no CPA field, so the 445-sales route is still kept. HOURS ×2 now kept (4baa4dc, pre-W1) | MARGIN, DEADLINE, CAPITAL and one-sale HOURS persist ✓. The graders' "correct" HOURS rejections **no longer fire** ✗ | **no**: $65,655 acquisition spend against a $5,000 capital limit is kept and not shown against capital | C30-P/F, C09-F, C25-P/F/I |
| E-011 | 10 recorded critiques → `applyCritique`; snow route; controls; F999 | W1b | **1 of 10** (the CAPITAL-only $5 fee drop is now kept). The p02 net-30 ×3 and p10 Printful window misreadings **still drop**: every one was paired with a second rule | **fails**: a true WINDOW or CAPITAL violation the route's figures hide is kept when the critic names only that rule | **no**: an invented F999 citation and a ruleless DROP both drop the route | C31-F, C05-I/F, C29-F |
| E-012 | 111/111/135 verified facts → `findingsOf`; refuted, contested, 200 and 400 noise claims | W1e | **yes**: p10 decisive facts 0/4 (record) → 4/4 | dedupe removes only exact repeats ✓; REFUTED filtered ✓ | **partial**: CONTESTED shown unmarked. With 400 newer claims, the 360/600 newest-first DB limit shows 0 real facts. Selection is by lane and recency, never relevance | C21-P/X, C19-I |
| E-013 | `readObjective` on 3 dec1125c, 7 reconstructed fm1126a classes, 2 controls, 12 new paraphrases | W1i | batch classes 7/7 ✓ | controls 2/2 ✓ | **new paraphrases fully correct 2/12** (33/47 fields). 11 of 14 misses are silent (no `unread`). "Zero budget" → no capital limit | C01-P/F |
| E-014 | route, critic, direction prompts and the discovery question for 9 owners | W1g, d5beaf6 | route prompts lifted ✓. **The discovery question still appends "owner does no physical work … no licence … no hourly positions"** beside the lifted focus | no-offer and refusal owners correct ✓ | offer regex misses 3 of 4 ordinary phrasings | C03-P/I/F/R |
| E-015 | scripted `fetch` into `chatFor`/`askModel`; the real `proposeGoalRoutes` with truncated and empty models | W1a, W1j | empty → 2× retry → fallback ✓ | — | **no** for: an unclosed `<think>` (draft JSON accepted), `reasoning_content`, mid-stream error or reset (error erased → null), `finish_reason: length`, a final SSE line without a newline (dropped). No `finish_reason` is read anywhere. A fallback's success hides the primary's failure on the goal record | C23-F/R/I, C30-F |
| E-016 | the real chain, 3 asks over 31 h | W1h | lessons reach ask 2 (+6 h) ✓, **lost by ask 3 (+31 h)**: the 24 h event lookback | — | — | C04-R, C22-I/R, C32-R |

## Repairs that did not change the recorded behaviour

- **W1b**: 4 of 5 recorded false window drops still drop. The rule-name test is defeated by any co-rule.
- **W1c**: does not fire on the recorded "445 sales at $38.99 CPA" route without the new field. Acquisition spend is never compared with capital.
- **W1g**: discovery still states the standing rule beside the lift.
- **W1h**: holds lessons for 24 h only.
- **W1i**: does not generalise beyond the batch's phrase classes.

## New defects found

1. `readStream` erases a stream error whenever partial content arrived (`modelBench.ts:166`). It also drops a final unterminated SSE line. This is a candidate mechanism for E-002's 2,103-char reply with error null.
2. `stripThink` keeps an unclosed `<think>` block, so a reasoning draft can be filed as a route.
3. `finish_reason` and `completionTokens` are never recorded, so truncation cannot be seen.
4. A successful fallback's event omits the primary's failure.
5. `applyCritique` keeps true hidden WINDOW and CAPITAL violations, and accepts drops that cite non-existent findings or no rule at all.
6. Capital and hours misreads in `readObjective` are silent, and a null becomes no limit.
7. Replacements are filed uncritiqued (static).
8. The plan verdict and committee questions never reach the route ask (static).

## Answers to the coordinator's lead (E-002)

- **(a)** Confirmed: silent `{routes: [], rejected: []}`.
- **(b)** In the production chain, a truncated reply with no complete route falls through to the next model. It is recorded only as NO_ANSWER "no parseable routes" if all models fail. One complete route is accepted silently.
- **(c)** No `finish_reason` or truncation check exists anywhere.
