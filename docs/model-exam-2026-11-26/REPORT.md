# Model intelligence examination: four models, 30 questions, graded blind (2026-11-26)

This is a diagnosis of model capability only. Nothing in Brain was changed or used. No Brain prompt, critic, parser, reviewer, coordinator or research worker took part.

## Method

**Questions**
- There are 30 fresh, independent commercial scenarios, for example espresso grinders, backflow testing and hospital beds. The full list is in `build.py`.
- They span the 20 capabilities named in the assignment, and many questions exercise several at once. The question-to-capability map is in `key.json`.
- Every question contains all the facts, costs, prices, dates and source evidence needed to answer it. No question supplies an opportunity, route or plan.
- Q15 has a second turn that brings new evidence, to test revision.

**Identical conditions**
- Every model got the same neutral system prompt: *"experienced business analyst; use only the information given; say where you rely on anything not stated; under ~1,200 words."*
- Every model got the same user prompt and the same follow-up turn.
- Settings were temperature 0.2 and max_tokens 16,000.
- No web search and no tools.
- Each question was a separate, independent conversation, so no model saw another model's answer.

**Shortest existing method**
- The open models were called directly over their OpenAI-compatible endpoints from a branch-only workflow (`run.mjs`), using the existing secrets:
  - gpt-oss-120b on the production RunPod GPU pod;
  - Qwen and the fallback through the existing switchboard.
- Claude Opus was called through the existing headless `claude -p` CLI with tools, MCP, settings and repository context all disabled. Nothing was purchased.

**Models**

| label | what was asked for | what actually served it |
|---|---|---|
| `gptoss120b` | `openai/gpt-oss-120b` on the production GPU | gpt-oss-120b (30/30) |
| `qwen38_27b` | `groq/qwen/qwen3.8-27b` (free Groq route) | Qwen3.8-27B for 29 answers; see Reliability |
| `fallback_auto` | `auto/best-coding`, the production fallback combo | **poolside/laguna-xs-2.1** (30/30) |
| `claude_opus` | the strongest Claude available without purchase (Opus 5.5 via the session's Claude Code) | Opus 5.5 |

**Raw responses**
- Every attempt is recorded under `raw/` and merged into `results/`. Each record keeps the full text, the reasoning text when returned, the finish reason, token usage, the model that actually served it and the latency.

**Blind grading** (`grade.py`)
- The predetermined key and its critical errors were written before any model ran (`key.json`).
- For each question, a fresh grader process received the question, the key and the four answers, shuffled under anonymous letters. It saw no model names and had no tools.
- It scored seven dimensions (reasoning, commercial, evidence, constraints, strategy, revision, format) and gave an overall score out of 10.
- An answer counts as "correct" only with a score of at least 7 and no critical error.

**Grader independence check**
- The grader is a Claude model, and one examinee is Claude, so two checks were added:
  1. The grader was blind.
  2. `mechanical.py` checks with plain regular expressions, not a model, whether each answer contains the key's load-bearing numbers on the five most numeric questions.
- The mechanical check agrees with the grader's ordering (see below).
- The grader also failed Claude where Claude was wrong: Q05 (critical error) and Q12. It is not lenient to Claude.

**Two passes**
- Pass 1 is the single identical run.
- Pass 2 re-asked, with byte-identical prompts, only the items where pass 1 got no answer from the named model. These were serving failures, re-asked so they would not be scored as reasoning:
  - gpt-oss was re-asked with streaming, so that the pod proxy's 100-second idle cut could not end the reply;
  - Qwen was re-asked accepting only replies Qwen itself served.
- No answer was re-asked because it was wrong.

## Results per model

### Headline

| | **Claude Opus** | **gpt-oss-120b** | **Qwen3.8-27B** | **Fallback (laguna-xs-2.1)** |
|---|---|---|---|---|
| **Correct out of 30** | **28** | **14** | **14** (29 answered) | **1** |
| Mean score /10 (all 30) | 9.07 | 6.33 | 6.00 | 3.13 |
| **Commercial planning** (11 Qs exercising caps 2, 8, 18, 20) | **10/11**, mean 8.7 | 4/11, mean 6.4 | 1/11, mean 4.4 | 0/11, mean 2.7 |
| Complete executable plan (cap 20: Q15, Q20, Q28, Q30) | **4/4** | 0/4 | 0/4 | 0/4 |
| Critical errors | 1 | 5 | 5 | 19 |
| Constraint violations | 3 | 8 | 6 | 22 |
| Evidence-interpretation errors | 1 | 61 | 46 | 86 |
| Unsupported assumptions | 36, nearly all explicitly labelled as assumptions (the instruction asked for that) | 46 | 41 | 40 |
| Mechanical key-number check (9 values, no model involved) | 8/9 | 7/9 | 9/9 | 4/9 |

### Dimension means (0–2, blind grader)

| dimension | Claude | gpt-oss | Qwen | Fallback |
|---|---|---|---|---|
| Reasoning correctness | **1.97** | 1.13 | 1.03 | 0.23 |
| Commercial feasibility | **1.97** | 1.20 | 1.28 | 0.50 |
| Evidence interpretation | **1.93** | 1.00 | 1.10 | 0.40 |
| Constraint preservation | **1.90** | 1.67 | 1.66 | 1.10 |
| Strategy generation | **1.95** | 1.57 | 1.20 | 0.57 |
| Ability to revise | **2.00** | 1.00 | 1.50 | 0.33 |
| Format and completeness | 2.00 | 1.87 | 1.79 | 1.37 |

### Response reliability (serving, kept separate from reasoning)

| | Claude | gpt-oss-120b | Qwen (Groq via switchboard) | Fallback |
|---|---|---|---|---|
| First-attempt answers | 30/30 | 19/30 | 7/30 that Qwen itself served | 30/30 |
| Empty replies | 0 | **0** | 15 in pass 1: the route caps output at 4,096 tokens and the reasoning used all of it | 0 |
| Timeouts | 0 | **11 first-attempt HTTP 524s** (Cloudflare idle cut at ~100 s in front of the pod); 6 still failed on a non-streaming retry | 0 | 0 |
| Silently served by a different model | 0 | 0 | **44 attempts** answered by `nvidia/nemotron-3.5-super-vl-120b-a12b` under the Qwen name | 0 |
| Unanswered after all attempts | 0 | **0** (streaming fixed all 6) | 1 (Q23) | 0 |
| Median latency | – | 53–75 s | 5–45 s | ~18 s |

The 524s and empty replies are infrastructure failures, not intelligence:
- With streaming, gpt-oss answered all 6 previously failed items on the first try, in 48–118 s.
- Qwen's empty replies carry `finish_reason: length` with all 4,096 completion tokens spent on reasoning, although the request asked for 16,000.

### Performance by reasoning capability (correct / questions exercising it, mean score)

| # | capability | Claude | gpt-oss | Qwen | Fallback |
|---|---|---|---|---|---|
| 1 | constraints without invented restrictions | 1/2 · 8.0 | **2/2 · 8.5** | 1/2 · 6.0 | 0/2 · 2.5 |
| 2 | strategy discovery from evidence | **2/2 · 9.0** | 2/2 · 7.0 | 0/2 · 5.0 | 0/2 · 3.5 |
| 3 | facts vs assumptions | **3/3 · 9.3** | 3/3 · 7.3 | 3/3 · 7.7 | 0/3 · 4.7 |
| 4 | who actually pays | **4/4 · 9.2** | 2/4 · 6.8 | 2/4 · 6.5 | 0/4 · 3.2 |
| 5 | economics with capital and settlement timing | **5/6 · 8.3** | 1/6 · 5.3 | 1/6 · 4.0 | 0/6 · 2.5 |
| 6 | unreachable targets | **3/3 · 9.0** | 1/3 · 6.0 | 0/3 · 4.7 | 0/3 · 3.0 |
| 7 | delegation, subcontracting, brokerage | **5/5 · 9.2** | 2/5 · 6.4 | 3/5 · 6.0 | 0/5 · 2.6 |
| 8 | compare and select strategies | **3/4 · 8.5** | 2/4 · 7.0 | 0/4 · 4.5 | 0/4 · 2.5 |
| 9 | contradictions between sources | **2/2 · 9.5** | 2/2 · 7.5 | 2/2 · 7.5 | 0/2 · 5.0 |
| 10 | unsupported criticism | **3/3 · 9.3** | 1/3 · 6.0 | 1/3 · 6.7 | 0/3 · 1.7 |
| 11 | deadlines, dependencies, calendars, capacity | **4/4 · 9.2** | 1/4 · 5.2 | 2/4 · 5.5 | 0/4 · 1.2 |
| 12 | constraint preservation through a complex decision | **4/5 · 8.6** | 3/5 · 7.0 | 2/5 · 5.2 | 0/5 · 2.0 |
| 13 | evidence that does not establish the conclusion | **3/3 · 9.7** | 2/3 · 6.3 | 2/3 · 7.0 | 0/3 · 5.3 |
| 14 | useful questions when information is missing | **2/2 · 9.5** | 1/2 · 5.5 | 1/2 · 6.5 | 0/2 · 4.0 |
| 15 | revision on new evidence | **2/2 · 9.0** | 0/2 · 6.0 | 0/2 · 2.5 | 0/2 · 3.0 |
| 16 | real opportunity vs event, prize or unrelated payment | **2/2 · 9.5** | 1/2 · 7.5 | 2/2 · 8.5 | 1/2 · 6.0 |
| 17 | unfamiliar industries | **3/3 · 9.0** | 3/3 · 7.3 | 0/3 · 4.3 | 0/3 · 3.0 |
| 18 | causal chain from discovery to collection | **4/4 · 8.8** | 1/4 · 5.8 | 1/4 · 3.8 | 0/4 · 2.5 |
| 19 | self-evaluation without invented objections | **3/3 · 9.3** | 1/3 · 6.0 | 1/3 · 6.7 | 0/3 · 1.7 |
| 20 | complete, feasible, executable plan | **4/4 · 8.8** | 0/4 · 5.2 | 0/4 · 3.8 | 0/4 · 2.5 |

Per-question scores are in `summary.json` (`per_question`), and every graded line item is in `grades.json`.

### Examples of genuine reasoning failures (from the blind grader, verbatim where possible)

**Claude Opus (2 wrong)**
- **Q05:** It ignored the 500-unit minimum order. It bought 1,151 units ($8,000 ÷ $6.95) instead of two 500-unit runs, which inflated the monthly profit to about $3,002 against the key's ~$2,600. This was a critical error.
- **Q12:** It recommended O4 alone. It treated O5 as a "likely breach" of the no-alcohol rule, because O5 sells beer accessories, which is an invented restriction, and so missed the O4+O5 combination.

**gpt-oss-120b (16 wrong)**
- **Q20, rock salt plan:** It "phased" a $17,650 outlay under the $15k cap by paying for later loads out of 30-day receipts. That breaks the stated full-prepayment rule and contradicts its own timeline.
- **Q22:** It deducted the full loan payment and depreciation together, a double count that understates profit (~$2,950).
- **Q19, self-evaluation:** It compared one week's billing ($660) with monthly costs ($1,440) and declared its own plan "financially untenable". It invented a reason to reject.
- **Q05:** It undercounted capital per run ($1,875 instead of $3,475), so it claimed 2,000 units could be in the pipeline.
- **Q11:** A misaligned calendar put the rework on "Mon Nov 21", which is a Sunday, and gave a delivery date of December 21 instead of December 20.
- **Q13:** It claimed a letter of intent "obligates the hotels to the stated purchase".

**Qwen3.8-27B (15 wrong, 1 unanswered)**
- **Q20:** The executive summary claims $13,600 profit, while its own body computes about $34 and calls the plan not viable.
- **Q06:** The headline says "60 of those 84 beds… $18,900", which contradicts its own correct $37,560 analysis.
- **Q27:** It called the estate's 14-day payout a fatal cash gap, although buyer proceeds arrive before the estate is paid. It also rejected the opportunity for lack of antiques expertise, which is a critical error.
- **Q08:** It assumed only one lot at a time, although $10k funds two concurrently. That is an invented restriction.
- **Q21:** It recommended video interpreting at $117–150 an hour against $72 of Medicaid reimbursement.

**Fallback, laguna-xs-2.1 (29 wrong)**
- **Q01:** It read "I personally will not make phone calls" as banning third-party callers, and it removed the commission rep. It invented a restriction.
- **Q07:** It had the English-only owner sign the Portuguese translation certification.
- **Q11:** Its calendar arithmetic was wrong from task 2 onward. It reported the baseline as late (December 19) and recommended paying the mill.
- **Q05:** It added receivables to costs that were already paid and concluded the owner "cannot operate at all".
- **Q10:** It accepted the critic's claim that the owner pays the subcontractor before being paid, although payables are net-45 and receivables net-30.

## Answers

**A. Which existing model is most capable of the work Brain requires?**
- **Claude Opus, by a wide margin:**
  - 28/30 correct, against 14, 14 and 1 for the others;
  - 10/11 on commercial planning;
  - 4/4 complete executable plans, where every other model scored 0/4;
  - it leads on 19 of the 20 capabilities.
- **Among the self-hosted and free models, gpt-oss-120b is the strongest.** It ties Qwen on 14/30 but leads on planning (4/11 vs 1/11), strategy, unfamiliar industries and serving reliability once streamed.
- **The production fallback, `auto/best-coding`, is not usable for reasoning.** It actually serves laguna-xs-2.1, which scored 1/30.

**B. Can our available models independently produce credible business strategies and plans when given sufficient information?**
- **Claude Opus, yes, on this evidence.**
  - Given complete facts and no Brain machinery, it produced a correct, feasible, executable plan on all four full-plan questions (Q15, Q20, Q28, Q30; mean 8.8).
  - It also correctly declared the unreachable targets unreachable (3/3).
- **gpt-oss-120b, Qwen and the fallback, no.** None produced a complete executable plan that passed: 0/4 each.
  - gpt-oss's plans are often directionally right (mean 5.2 on cap 20), but they break a stated rule or an arithmetic step somewhere in the chain.

**C. What reasoning weaknesses are genuinely attributable to the models themselves?**

Measured outside Brain, with complete information:

| model | weaknesses that belong to the model itself |
|---|---|
| gpt-oss-120b and Qwen | • Multi-step cash and capital timing (cap 5: 1/6 each) and calendar arithmetic (cap 11: 1/4 and 2/4), e.g. wrong weekday, double-counted loan principal and depreciation, wrong capital per run.<br>• Internal inconsistency between a headline and its own body (Qwen Q06 and Q20).<br>• Revising after new evidence (cap 15: 0/2 each).<br>• Self-evaluation that invents objections (gpt-oss Q19).<br>• Holding every constraint through a long plan (cap 20: 0/4).<br>• Evidence misreading is frequent: 61 and 46 graded instances. |
| Fallback (laguna-xs-2.1) | • Fails almost everything: reasoning mean 0.23/2.<br>• It invents owner restrictions on its own (Q01), with no Brain prompt present. |
| Claude Opus | • Two isolated slips:<br>&nbsp;&nbsp;– one minimum-order-quantity oversight (Q05);<br>&nbsp;&nbsp;– one over-cautious reading of a rule (Q12, invented restriction). |

**D. Which failures previously blamed on model intelligence disappear when the models operate outside Brain?**

This compares against `docs/INTELLIGENCE-TEST-30Q-2026-11-26.md` and `docs/INTELLIGENCE-INTEGRATION-DIAGNOSIS-2026-11-26.md`.

- **gpt-oss "empty replies 50% of the time" disappears.**
  - Outside Brain, gpt-oss returned `content:""` in 0 of 47 attempts.
  - Inside Brain it was 3 of 8 proposal turns and 6 of 12 route asks.
  - The empty content is therefore produced by how Brain's path calls or reads gpt-oss, not by the model. This exam does not diagnose which part of that path; Brain was not modified or inspected for it.
- **The gpt-oss "timeouts" (HTTP 524) were never intelligence.** They are reproduced outside Brain (11/30) and are the RunPod proxy's ~100 s idle cut. With streaming they disappear: 6/6 answered.
- **"The model planned badly" was largely the fallback model, not gpt-oss.**
  - Whenever gpt-oss failed to serve inside Brain, `auto/best-coding` (laguna-xs-2.1) planned and criticised instead.
  - That model scores 1/30 here and 0/4 on calendars and windows.
  - The critic's misreadings recorded before ("net 30 outside 60 days", "December after a window that includes December") match this model's measured weakness, not a ceiling on gpt-oss or Claude.
- **"The owner's refusals were invented" is partly a Brain prompt effect and partly the fallback model's own.**
  - The fallback invents a restriction here with no Brain prompt at all (Q01, critical error).
  - gpt-oss and Qwen did not (cap 1: 2/2 and 1/2).
- **"A stronger model alone gave 0/3 usable" (the earlier control) does not reproduce once the information is complete and self-contained.** Claude scores 4/4 on full plans here. The earlier control ran on open goals with research-gathered facts, so its 0/3 is not evidence of a model ceiling.
- **Still present outside Brain, and genuinely the open models':** gpt-oss's arithmetic, calendar and constraint breaks inside long plans (see C).

**E. Does existing model capacity appear sufficient for the 9/10 planning objective, or is there evidence of a specific capability gap?**

- **Existing capacity appears sufficient in one model: Claude Opus.**
  - It is already available to us; no purchase was made or is needed.
  - It answered 28/30 (93%) and 10/11 planning questions (91%) correctly, at or above the 9/10 bar, on unfamiliar objectives given complete facts.
- **There is a specific, measured capability gap in the models Brain's production planner uses today.**
  - gpt-oss-120b is at 14/30 (47%) and 4/11 planning, with 0/4 complete plans.
  - The fallback is at 1/30.
  - The gap is in multi-step economics and timing, calendars, revision and end-to-end constraint holding (caps 5, 11, 15, 20). It is not in recognising facts, contradictions or opportunities, where gpt-oss is mostly correct.
  - On this evidence gpt-oss-120b cannot carry the 9/10 objective alone.
- **No purchase of a stronger model is recommended.**
  - The strongest model tested is one we already have, and it meets the bar.
  - Nothing here shows that the existing models as a set cannot do the required reasoning.

**Limits of this exam**
- There are 30 questions with one sample per model at temperature 0.2. A difference of a few questions between gpt-oss and Qwen is within noise; the gaps to Claude (+14) and to the fallback (−13) are not.
- Grading used a Claude-family grader. It was mitigated by blinding and corroborated by the model-free key-number check, which ranks Qwen 9/9, Claude 8/9, gpt-oss 7/9 and the fallback 4/9 on the most numeric items.
- Qwen ran under a 4,096-token output cap imposed by its route. That cap may depress its scores on the longest planning questions, so its 0/4 on full plans is a lower bound for the model, not a ceiling.
- Claude ran through its CLI's own output limit rather than max_tokens=16,000. Its answers averaged 6.8k characters, against 7.8k for gpt-oss and 7.9k for Qwen, so it was not advantaged by length.

## Files

All paths are relative to this directory.

| file | contents |
|---|---|
| `build.py` | the questions |
| `questions.json`, `key.json` | the generated question set and predetermined key |
| `run.mjs` | the model caller |
| `raw/` | every attempt, both passes |
| `results/` | merged answers per model |
| `reliability.json` | the serving tally |
| `grade.py` | the blind grader |
| `grades.json` | every graded item |
| `aggregate.py` → `summary.json` | per-model aggregates |
| `mechanical.py` → `mechanical.json` | the model-free cross-check |
