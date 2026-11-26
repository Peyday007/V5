# Gate B: independent diagnostic-validity review

**Reviewer:** Gate B. I did not write any of the experiments.
**Reference:** REF `2d79f7d`. `git diff 2d79f7d HEAD -- server` is empty, because HEAD `b5e248b` adds only investigation files.
**Scope:** I judged whether each diagnostic actually detects the defect it claims. I read the harness code, the raw outputs and the real source lines. The summaries were not used as evidence.

**Constraints I kept to:**
- no edits to `server/`, `tests/`, `scripts/` or `experiments/`;
- no production calls and no model calls.

**Machine-readable findings:** `reviews/gate_b_findings.json`, 56 entries:

| verdict | count |
|---|---|
| VERIFIED_DIAGNOSTIC | 6 |
| PARTIAL | 6 |
| CLASS_OK | 17 |
| CLASS_WRONG | 14 |
| SPEC_DEFECT | 13 |

## 0. Reproduction (my own reruns)

**Isolated copy.** The harnesses write into `experiments/raw/`. I did not want to overwrite them, so I copied the harness to `reviews/gateb_checks/harness/`:
- import depth adjusted by one level;
- output root set to `reviews/gateb_checks/raw/`.

**Results:**

| check | result |
|---|---|
| `extract_probes.py` regenerated from `docs/intelligence-test-2026-11-26/planner/*.txt` and `raw/E-002/eval.txt` | `probes.json` is **byte-identical**. The known-bad inputs are the recorded replies, verbatim. |
| E-010, E-011, E-012, E-013, E-014, E-015 (`node --import tsx …`) | every output file is **byte-identical** to `experiments/raw/` (`cmp`) |
| `e015_e016.sandbox.test.ts` (vitest, sandbox DB) | 5/5 pass. `chain.json` and `lessons.json` differ **only in `at` timestamps**. |
| Recorded-reply tally behind E-001 | reproduces exactly: 12 gpt-oss replies, 6 `content ""` with error null at 47.2–85.4 s; 6 non-empty at 45.9–73.4 s (3.7–5.0 KB) |
| Imports | every harness imports Brain's real exported functions from `server/` (and `tests/helpers.ts` for the sandbox). Nothing is reimplemented, with one exception: E-012 F3 simulates the DB `LIMIT` with an array slice (see GB-06). |

**New checks I added** (`reviews/gateb_checks/harness/gb_checks.sandbox.test.ts`, output in `raw/gb_checks.json`):

*GB-S: readStream sensitivity controls*

| case | result |
|---|---|
| S1: error event, no content | error kept |
| S2: error event after content | **error null** |
| S3: reset, no content | error kept |
| S4: reset after content | **error null** |
| S5: clean stream with `[DONE]` | read correctly, `completionTokens` 7 |
| S6: reasoning-only stream, `finish_reason: length`, usage 4000 | `content ""`, `completionTokens: 4000` in `chatFor` |
| S7: `askModel` on S6 | returns only `{content, error}`, so the 4000 is **discarded** |

*GB-G: `createGoal` on E-013's paraphrases*
- Reader alone (`interpreter: null`), one fresh sandbox project per phrase.

## 1. Per-experiment verdicts

| target | verdict | summary |
|---|---|---|
| E-001 | **PARTIAL** | Sound reasoning, but the deciding datum is missing. |
| E-002 | **PARTIAL** | The parse-silence finding is VERIFIED. The cause attribution is overclaimed. |
| E-010 | **PARTIAL** | Real functions, faithful replay. One control is mis-specified and one injection's "correct" answer is undefined. |
| E-011 | **PARTIAL** | The co-rule defeat is VERIFIED. The true-violation controls contradict the documented REPAIR contract. |
| E-012 (delivery, dedupe, filter) | **VERIFIED_DIAGNOSTIC** | — |
| E-012 F3 (recency cut) | **PARTIAL** | Simulated, not executed through the DB read. |
| E-013 | **VERIFIED_DIAGNOSTIC** (scope: `readObjective`) | Downstream claim corrected by GB-G. |
| E-014 | **VERIFIED_DIAGNOSTIC** | — |
| E-015 | **VERIFIED_DIAGNOSTIC** | Code-path detection confirmed. Production relevance of cases (iv) and (viii) is not shown. |
| E-016 | **VERIFIED_DIAGNOSTIC** | — |
| L-001 | **VERIFIED_DIAGNOSTIC** | — |

### E-001 (GB-01): PARTIAL

**What holds.**
- At E0 (`c52d6d3`), the probe made **one non-streamed** call at 4000 tokens:
  - `git show c52d6d3:scripts/planningEval.ts:675`: `chat(...,4000)`, no `askModel`;
  - `chatFor` had no `stream` flag.
- On that path an idle cut can only appear as HTTP 524 with an error, after about 100 s. The empties came back at 200, under 100 s, with error null.
- So **H1a is refuted for the empty-body symptom**. That is established.
- H1b is graded "supported, not established", which is correct.

**What is missing.**
- The deciding datum existed and was thrown away. At E0, `chatFor` read `usage.completion_tokens` on the non-streamed path, but the probe printed only `content`.
- The proposed decisive run asks for "non-streamed at 16000 tokens". That is confounded: the exam measured streamed gpt-oss answers at up to 118 s (`model-exam REPORT.md:98`), so a non-streamed 16000-token call can itself hit the 524.
- The run must be streamed, with `finish_reason` and usage captured (see GB-12).

### E-002 (GB-02): PARTIAL

**Faithful input.** 111 facts, `supplied: 111` as recorded. Served by `a8c46995`.

**The truncation is real, not a print artefact.**
- The probe prints `content.slice(0,9000)`.
- This content is 2,103 chars and ends in `"grounds": {"channel`.

**VERIFIED.** The result is silent `{routes:[], rejected:[]}`. E-010 reproduces it deterministically through REF `routesJson` → `parseRoutes(null)`.

**NOT justified.** The write-up calls the cause "the same mechanism as E-001 … SUPPORTED, strengthened".
- On `a8c4699` the reply passed through `readStream`.
- `readStream` returns `error: content.trim() ? null : error` (`modelBench.ts:166`).
- A stream that was reset, or carried an error event, after partial content therefore leaves *exactly* this record. GB-S S2 and S4 demonstrate it.
- The record cannot separate a length stop from a stream drop.

**A weak indication, conditional on H1b.**
- 80.5 s for one 4000-token attempt matches the E0 rates (about 47–85 tok/s).
- A 4000 + 8000 retry inside 80 s would need about 150 tok/s.
- So this was probably a single attempt, which is the probe's limit (2).

### E-010 (GB-03): PARTIAL

**What holds.** These are faithful replays of recorded known-bad outputs, and detection is verified for:
- W1d: the p10 `OWNER_FIT` routes are now kept;
- W1c: it does not fire without the CPA field (`knownBad_cpaOmitted` is kept);
- E-002: the truncation gives silent zero.

**Defects in the diagnostic.**
1. **Mis-specified control.** "The graders' correct HOURS rejections no longer fire ✗" is not a Brain defect at the level tested.
   - Commit `4baa4dc` moved the whole-target hours check, on purpose, from `parseRoutes` to the plan (`withoutSpareOwnerWork`, `plan.ts:1309`).
   - A parser-level control will always "fail" now.
   - The plan-level check, which would decide the question, was not run.
2. **Undefined expectation in the injection.**
   - The scenario is `knownBad_spendOverCapital`: $65,655 of total acquisition spend against $5,000 of capital.
   - It assumes total spend must stay under the capital limit. But CPA $15 is below the $19.57 margin, so the spend is recycled from proceeds.
   - The register's own C29-F expects "payable-from-proceeds" to be distinguished.
   - Without a cash-timing model, "not caught" is not an established defect.
3. **Miscount.** The write-up says "17 non-empty". The actual count is 19 replies: 18 from E0 (12 non-empty, 6 empty) and 1 from E1.

### E-011 (GB-04): PARTIAL

**VERIFIED.** W1b is all-or-nothing on the rule list.
- `critiqueJson`, which is unchanged between `c52d6d3` and REF, sets `failed` to the named rules **plus** the score-derived ones.
- `numericOnly` requires *every* failed rule to be WINDOW or CAPITAL (`routeProposal.ts:1268`).
- So any co-rule, named or score-derived, keeps the false drop. The 4 recorded false WINDOW drops still drop.

**Valid injections.** F999 and the no-rule DROP: `applyCritique` never reads `why` or the cited refs.

**Not justified.** The "true WINDOW/CAPITAL violation is kept ✗" controls are scored as Brain defects.
- The REF critic prompt says: *"When you dispute one of the route's own figures … REPAIR it to the figure the findings show … DROP only for what no changed figure can fix."*
- The REPAIR control drops correctly.
- So these controls measure critic **non-compliance** with a documented contract. They show a residual risk (the route is kept at score −100, and the objection stays on record), not a demonstrated defect.

**Reconstruction caveat.**
- The record holds only the text after `applyCritique`, so every recorded drop was rebuilt with verdict DROP.
- At REF, a `KEEP` verdict that fails only on score still drops (`verdict === 'KEEP' && failed.length > 0`).
- So the "1 of 10 changed" (the CAPITAL-only p06 drop) is conditional on the original verdict having been DROP.

### E-012 (GB-05: VERIFIED_DIAGNOSTIC; GB-06: F3 PARTIAL)

**Known-bad confirmed independently.** I recounted the recorded `final_p10_cap` PROBE findings against the 4 decisive patterns and got `[0,0,0,0]`. At REF the count is 4 of 4.

**"No distinct fact lost" is correct.**
- `findingsOf` dedupes on the whole normalized statement.
- The inputs carry `tools/batch.py`'s 280-char cut. I rechecked that no two statements collide under that cut while differing in full: 0 for both p02 and p10.

**The CONTESTED probe is self-contaminated.**
- The injected text itself contains "(contested)", so the harness output cannot show whether Brain adds a marker.
- The conclusion still stands by code: `findingsOf` filters only REFUTED (`:1524`) and emits the claim text unchanged.

**F3 is not executed.**
- It slices a JS array to 360. It does not call `projectEvidenceClaims`.
- The static basis is correct: `research.ts:1193-1195` has `ORDER BY c.created_at DESC … LIMIT ?`.
- The read sizes are `FINDINGS_SHOWN*3` (`routeProposal.ts:1595`) and `FINDINGS_COUNTED = 600` (`:1971`).
- Missing: a sandbox run that inserts more than 600 newer claims and calls `proposeGoalRoutes`.

### E-013 (GB-07): VERIFIED_DIAGNOSTIC for `readObjective`, downstream corrected

**What holds.**
- Real `readObjective`.
- Controls pass: dec1125c 3/3, and the 2 plain controls.
- The new-paraphrase expectations are fair human readings.
- 11 of 14 misses are silent; I checked against the `unread` arrays.

**Limits.**
- The fm1126a set is *reconstructed*, not a recorded failure.
- 2/12 is the rate on a constructed set, not a population rate.

**GB-G downstream, which corrects E-013's "Consequence" paragraph:**

| miss | what happens at goal creation | vs E-013 |
|---|---|---|
| capital ("Budget is capped at $4k", "I'm not putting a cent in", "no more than two grand") | goal created with `capitalCeilingCents: null` | E-013 is **right** |
| amount ("ten thousand bucks", "Half a grand", "twenty-five hundred dollars") | **goal created with `target: null`**, reading kind OTHER | silent, and **worse** than E-013 states |
| window ("within a fortnight", "this weekend") | `createGoal` **refuses** loudly: "do not state a deadline … nothing was created" | **not** silent downstream |

The production `objectiveAssist` second reading was not tested. It triggers only on a missing amount, a missing deadline or unplaced money, and then may fill capital and hours.

### E-014 (GB-08): VERIFIED_DIAGNOSTIC

- The harness bucket text is shorter than `openGoalRound`'s (`discovery.ts:1310-1330`).
- That does not affect the finding: `questionFor` appends `executionFrameSentence(frame)` or `OPERATING_MODEL_SENTENCE` **unconditionally** (`:1880-1881`), and `openGoalRound` passes the frame (`:1345`).
- Controls b and c are correct.
- 3 of 4 offer phrasings are missed (`result.json`).
- The effect on model behaviour (for example TaskRabbit being excluded) is an inference, not a measurement.

### E-015 (GB-09): VERIFIED_DIAGNOSTIC

**Real code paths.** `chatFor` → `readStream`, `askModel`, and the real `proposeGoalRoutes`.

**Sensitivity is proven by GB-S.**
- The erasure happens **only when content arrived**: S1 vs S2, S3 vs S4.
- The clean-stream control reads correctly: S5.
- An H1b-shaped reply exposes `completionTokens: 4000` in `chatFor`, but `askModel` discards it: S6, S7.

**Relevance caveat.**
- (iv) the unclosed `<think>` and (viii) the final SSE line without a newline are real code fragilities.
- Neither is shown to occur on the production gpt-oss path. That path has a separate reasoning channel, and its SSE ends with a blank line and `[DONE]`.
- Its "candidate, not established" for E-002 is correctly hedged.

### E-016 (GB-10): VERIFIED_DIAGNOSTIC

- Real chain, with a positive control: ask 2 at +6 h contains `LESSON-ALPHA`.
- Ask 3 at +31 h does not.
- The code confirms the cause:
  - lessons come only from `ROUTE_EVENT` rows since `now − max(DAY, interval)` (`:1946`);
  - a null rethink is filtered out (`:2023`), not written over.
- Static claims confirmed by grep: no `readGoalPlan` or committee read in `routeProposal.ts`; replacements are filed with `score: null` (`:1914`).

### L-001 (GB-11): VERIFIED_DIAGNOSTIC

**Confirmed.**
- No `bench/planningReliability` file references the proposer, the critic, `chatFor`, `askModel` or discovery.
- `readGoalPlan` does not reach `armRouteProposal`. Only `widenGoalSearch` (`plan.ts:5854-5877`) does, and it is called from the tick paths (`:6556`, `:6570`, `:6647`).
- No suite in `tests/` combines discovery, the proposer and the plan; all proposer tests use scripted models.

**Nuance the lead omits.** The bench *does* go through `createGoal`, and therefore `readObjective` (`world.ts:243`). So it can observe RC15 objective misreads when its cases carry such phrasings.

## 2. Causal discrimination: empty and truncated gpt-oss replies (GB-12)

| claim | status |
|---|---|
| E0 empties are not the proxy idle cut | **ESTABLISHED**: non-streamed, 200, error null, under 100 s |
| Brain's record cannot tell a length stop, a reasoning-only reply, a stream drop or a stream error apart | **ESTABLISHED**: `readStream:166`; `askModel` drops `completionTokens`; no `finish_reason` read anywhere in `server/` except a type in `providers/openai.ts` |
| A truncated reply parses to silent zero routes and zero rejections | **ESTABLISHED** (E-002, E-010) |
| E0 empties come from reasoning exhausting `max_tokens` (H1b) | **SUPPORTED only**: a budget 4–5× below the exam's, Qwen's analogous `finish_reason: length`, and a similar latency profile. No usage or `finish_reason` was recorded. |
| E-002's truncation is H1b | **NOT SEPARATED** from a stream reset or error erased by `readStream` |
| H1c (answer misplaced in the reasoning field, or template) for E0 | **NOT EXCLUDED** |
| Idle cut for E-002 | implausible while streaming, but the maximum inter-chunk gap was not recorded |

**Minimal separating experiment.** A probe variant that records, per attempt:
- `max_tokens`;
- `finish_reason`;
- `usage.completion_tokens` (with `stream_options.include_usage`);
- whether `[DONE]` arrived;
- any reader exception;
- reasoning-delta chars;
- the maximum inter-chunk gap.

Replay the E-002 prompt 5 or more times, streamed, at 4000 and at 16000 tokens.

Predictions:

| hypothesis | prediction |
|---|---|
| H1b (length stop) | `length`, tokens equal to `max_tokens`, `[DONE]` received |
| stream drop | no `finish_reason`, no `[DONE]`, a reader error or early close |
| H1c | `stop`, empty content, JSON in the reasoning |
| idle cut | an inter-chunk gap of 100 s or more |

## 3. Register sample (25 rows) and overrides

**Sample result:** 15 CLASS_OK and 10 CLASS_WRONG (GB-20 to GB-44).

| row | class given | verdict | reason |
|---|---|---|---|
| C01-R | REUSABLE | WRONG | `target.ts` reads via `readObjective`, which W1i changed |
| C02-M | REUSABLE | OK | model exam |
| C13-P | REUSABLE | OK | source reader unchanged |
| C14-X | REUSABLE | WRONG | RC6 queue path changed after E0 (585d3fb, 3c4dbd2, 5c34d37, a38fe9b); REF≠PROD in `freeLane/capacity.ts` |
| C16-I | REUSABLE | WRONG | evidence is a commit ref (code); `groundsOf` is in a W1 file |
| C17-P | REUSABLE | OK | — |
| C18-R | REUSABLE | WRONG | "9fb993c." is code; W1 file |
| C38-P | REUSABLE | WRONG | a constant name; `routeAskDue` is inside changed hunks (+1364, +1378) |
| C38-F | REUSABLE | WRONG | a constant name; W1 file |
| C01-P | RECHECK | OK | E-013 confirms |
| C03-F | RECHECK | OK | — |
| C06-I | RECHECK | OK | — |
| C09-R | RECHECK | WRONG | code reading labelled VALID |
| C12-I | RECHECK | OK | — |
| C22-I | RECHECK | WRONG | code reading labelled VALID |
| C25-F | RECHECK | WRONG | evidence "None." |
| C30-I | RECHECK | WRONG | evidence "No repair." |
| C35-F | RECHECK | OK | — |
| C06-P | INCOMPLETE | OK | — |
| C10-R | INCOMPLETE | OK | — |
| C13-F | INCOMPLETE | OK | — |
| C17-R | INCOMPLETE | OK | — |
| C35-I | INCOMPLETE | OK | — |
| C01-I | UNVERIFIED | OK | — |
| C34-X | UNVERIFIED | OK | — |

**Rule-level defects in `build_register.py`.**

- **GB-48: touched is tested before code-only.** All 15 CODE_ONLY rows on touched paths are labelled "VALID BUT NEEDS RECHECK": C02-F, C03-I, C04-R, C05-I, C05-F, C08-I, C19-I, C22-P, C23-F, C25-R, C25-F, C30-I, C31-R, C31-F, C37-R. The "VALID" asserts a measurement that does not exist.
- **GB-49: only W1 files count as changed.** E0 predates 8 non-W1 server changes:
  - `operatingModel.ts`, `decide.ts`, `goalWork.ts`, `workQueue.ts`, `freeLane/worker.ts`, `freeLane/capacity.ts`, `cashPortfolio.ts`, `infra.ts`.
  - Pre-W1 commits on W1 files also changed behaviour: 4baa4dc changed HOURS (E-010).
  - The RC6 queue and capacity rows C07-R, C11-R, C14-P and C14-X are wrongly "REUSABLE".
  - The rule should diff each row's measurement revision against REF.
- **GB-50: name-based component regex.** It misses symbols that live in W1 files:
  - `groundsOf`: C16-I, C18-R, C18-I, C18-F;
  - `routeAskDue`: C38-P;
  - `target.ts`: C01-R.

  Separately, the kind detection labels hashes and constant names as BEHAVIORAL: C15-I, C16-F, C17-X, C38-F.

**Overrides.**

- **C23-M (GB-45): CLASS_WRONG.**
  - The mechanism part is right: the map's "proxy idle cut" is contradicted for the empties.
  - But the question is "Same prompt, larger max_tokens → Answers". Its PASS evidence (exam: streaming + 16000 + exam prompts) is confounded and not Brain's prompt.
  - Nothing shows a larger budget *failing*.
  - Correct class: **INCOMPLETE (confounded)**, with the note "map attribution contradicted".
- **C07-M (GB-46): CLASS_OK, and more strongly than the override says.**
  - The test names the *direction* prompt.
  - The 30Q control used Brain's final *route* prompt (`control_prompt_*.txt`; 30Q doc line 35), and the exam used its own prompts.
  - Neither measures the test.
- **C36-P (GB-47): CLASS_OK as mixed.**
  - The production half (fm1126a f01) is a valid behavioural FAIL on `plan.ts`, which is unchanged `c52d6d3`..REF, but it rests on n=1.
  - Recommend splitting it: a reusable production FAIL, plus the exam half as MODEL_ISOLATION.

## 4. Spec-defective questions: the test as written cannot detect its intended failure (GB-60 to GB-72)

| question | why the test cannot detect the failure |
|---|---|
| **C23-F** | Tests only empty content. Truncated, reasoning-only, unclosed-`<think>` and error-erased partial replies all pass (E-015, E-002). |
| **C23-M** | The exam changed prompt, streaming and budget together, with no `finish_reason` or usage. It cannot separate H1a, H1b and H1c. |
| **C23-P** | "≥95% valid" cannot be read from production records: a fallback's success hides the primary's failure, and a reply truncated after one complete route counts as an answer. |
| **C23-I** | Same reason: which model failed, and why, is not kept on success. |
| **C30-F** | Scoped to loss "to a field rule". Rule-less whole-output loss (a truncated reply) is excluded by construction. |
| **C31-F** | One-sided. Overruling every WINDOW-only drop passes. It needs a true-violation pair and the co-rule case. |
| **C30-P** | Parser-level ground truth for HOURS, which 4baa4dc moved to the plan. It reports FAIL without a defect. |
| **C21-P** | Measured through probe-supplied claims, which bypass the DB `ORDER BY created_at DESC LIMIT`. It cannot see the recency cut. |
| **C03-P** | "Every prompt states the lift" passes a question that states the lift *and* the contradicting standing sentence. |
| **C03-I** | Satisfied by the focus sentence alone, and it pointed at `REMOTE_AI_FOCUS`, which W1g fixed. It cannot see `questionFor`'s appended frame sentence. |
| **C04-R** | "Shown in routeContext" passes at the next ask (+6 h) while lessons die after 24 h. It needs a horizon. |
| **C01-P** | "Recheck on the next batch" detects nothing if the batch reuses the repaired phrase classes. It needs held-out paraphrases and a check that a miss is named in `unread`. |
| **C25-P / C25-I** (economics injections) | No rule defines whether acquisition spend is bounded by capital or recycled from proceeds, so "spend over capital caught" has no correct answer. |

## 5. Outstanding objections

1. **The cause of E-002's truncation is unresolved.** Do not treat RC1-a (the budget) as the E1 mechanism until the GB-12 probe has run. The repair candidates differ: raising the budget vs. surfacing stream errors and `finish_reason`.
2. **E-010's HOURS "control fails" and E-011's "true violation kept" should be withdrawn as defects.** They should be restated as untested plan-level and critic-compliance questions. The decisive checks are:
   - `withoutSpareOwnerWork` on the 13 × 2 h route;
   - a live critic shown a route with hidden net-120 terms: does it REPAIR?
3. **E-013's downstream claim needs correcting per GB-G.**
   - Window misses are refused, not silent.
   - Amount misses create a goal with no target. This is a stronger and separate defect.
   - The production `objectiveAssist` path remains untested.
4. **E-012 F3 should be executed through `projectEvidenceClaims`** before it is cited as observed.
5. **The register's classes should be regenerated** after fixing GB-48, GB-49 and GB-50. Until then, treat every "VALID …" label whose kind is CODE_ONLY or NONE, and every RC6 "REUSABLE" label, as unverified.
6. **The E-010 write-up and summary say "17 recorded replies".** The count is 19: 18 from E0 (12 non-empty, 6 empty) and 1 from E1.
