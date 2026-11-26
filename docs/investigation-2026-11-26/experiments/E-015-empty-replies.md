# E-015: empty, failed and truncated replies (askModel, chatFor and readStream, the real ask chain)

**Hypothesis.**
- W1a (retry an empty reply at twice the budget) and W1j (streaming) handle empty, 524 and reasoning replies.
- The record distinguishes why a reply failed and which model answered.

**Setup.** Two harnesses, both without network:
- `harness/e015_empty_replies.ts` drives the real `chatFor` with a scripted `fetch` (SSE or JSON responses), then `askModel`.
- `harness/e015_e016.sandbox.test.ts` drives the real `proposeGoalRoutes` on a sandbox SQLite DB built with the repository's test helpers, with scripted chat models.
  - The truncated reply is the exact E-002 content.
  - Run with `npx vitest run --config docs/investigation-2026-11-26/experiments/harness/vitest.config.ts docs/investigation-2026-11-26/experiments/harness/e015_e016.sandbox.test.ts`.

**Raw output.** `raw/E-015/result.json`, `chain.json`, `stdout.txt`, `vitest_stdout.txt`

## chatFor / askModel (`result.json`)

| case | what Brain gets | askModel does |
|---|---|---|
| (i) content "" then an answer | "" error null | retries at 8000 (2×) and uses the answer ✓ |
| (ii) "" twice | — | error "an empty reply twice …" → the next model ✓ |
| (iii) HTTP 524 | error "HTTP 524 …" | **no retry**; the next model |
| (iv) stream with an unclosed `<think>` holding a draft JSON | the whole text, `<think>` included | **accepted**: `parseRoutes` keeps the route "DRAFT-FROM-REASONING" from inside the reasoning |
| (v) answer only in `delta.reasoning_content` | "" | ignored → retried → error; the JSON inside the reasoning is never read |
| (vi) partial content, then a stream `error` event | partial content, **error null** | accepted as a success |
| (vii) partial content, then a connection reset | partial content, **error null** | accepted as a success |
| (viii) last SSE line without a trailing newline | that line is **silently dropped** (the buffer is not flushed at end of stream) | the truncated text is accepted |
| (ix) non-streamed `finish_reason: "length"`, cut mid-list | the truncated text; `completionTokens` 4000 | accepted; 1 of 2 routes kept, nothing flags it |
| (x) streamed `finish_reason: "length"` | same | same |

**Where any reply is checked for `finish_reason` or truncation (lead (c)):**
- **Nowhere.** `chatFor` and `readStream` never read `finish_reason` (`modelBench.ts:109-125,154-157`).
- `askModel` drops `completionTokens` (`routeProposal.ts:1439` keeps only content and error).
- `readStream` returns `error: content.trim() ? null : error` (`:166`), which actively **erases** a stream error whenever any content arrived.

**A new mechanism consistent with E-002** (2,103 chars cut mid-JSON, error null, on a8c4699 with W1j streaming): a stream that ends or errors mid-answer is recorded exactly so.
- This is a candidate, not established: an E-002-style reply can come from (vi), (vii) or a `length` stop, and Brain's record cannot tell them apart.

## The real ask chain (lead (b), `chain.json`)

| scenario | outcome | what the goal's event records |
|---|---|---|
| primary returns the E-002 truncated text, fallback valid | the fallback's routes are filed (`model: "fallback"`) | **nothing about the primary's failure**. The PROPOSED detail has no failures field (keys: outcome, model, filed, …); the `failures` list is used only in the NO_ANSWER reason |
| truncated from every model | NO_ANSWER, reason "primary: no parseable routes; fallback: no parseable routes" | recorded, but truncation is indistinguishable from unparseable prose |
| primary truncated **after one complete route** | the primary's 1 route is accepted and filed; the second route is silently lost | no truncation marker |
| primary "" twice (4000, then 8000), fallback valid | the fallback's routes are filed | `model: "fallback"`; the primary's two empty turns are **not recorded** |

**Answers to the coordinator's lead:**
- **(a)** Confirmed: zero routes, zero rejections (E-010).
- **(b)** In `proposeGoalRoutes`:
  - A truncated reply with **no** complete route falls through to the next model (`:2103-2106`). It is recorded only if every model fails, as NO_ANSWER "no parseable routes".
  - A truncated reply with **one or more** complete routes is accepted.
  - On success, earlier models' failures are not on the event. The `model` label says who answered; nothing says the primary failed, or why.
  - The eval probe (`scripts/planningEval.ts:735-749`) has no fall-through and records the critique as "unreadable".
- **(c)** Nothing in the chain checks `finish_reason` or truncation.

## Diagnostics

| question | detects known-bad? | passes known-good? | catches injection? |
|---|---|---|---|
| C23-F (empty treated as an error and retried) | yes ✓ (i, ii) | yes | **no** for reasoning-only (v), unclosed think (iv), or truncated with error null (vi–x) |
| C23-R (a failed answer retried) | 524 is not retried, only fallen through | — | — |
| C23-I (fallback quality equals primary) | **cannot be measured from the record**: a fallback's success hides the primary's failure | | |
| C30-F (whole output lost) | a truncation with no complete route → NO_ANSWER without its cause; with one route → partial loss is invisible | | |
