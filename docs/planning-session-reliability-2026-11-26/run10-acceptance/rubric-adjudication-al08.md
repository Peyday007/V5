# al-08: independent adjudication of the plan and the rubric (2026-11-27, after grading)

Run 10's recorded result is unchanged: al-08 is graded UNJUSTIFIED_REFUSAL in `grades/a08.json`, and 14/16 = 0.875 stands. An agent that had not seen any diagnosis wrote the adjudication below. It read only the hidden case, the planning record, the grade and COMPLETION-SPEC. It is recorded as a rubric defect. The defect is graded beside the original in `tests/run10Regressions.test.ts` and is never substituted for it.

---

# Determination: al-08-forklift-objective-change (final reading)

**Verdict: BOTH.** The rubric's verdict is wrong: it assumes trainer capacity the record does not establish. The plan's CONDITIONAL verdict is correct, but the plan has a separate structural defect: the bowling opening is not accounted for in any structured field. The correct final-reading verdict is a no-plan-yet result (CONDITIONAL), with FULFILMENT/settlement timing (the trainer's capacity by day 20) as the deciding link. Under the grader's classes that is `NO_PLAN_JUSTIFIED_CORRECT`. It is not `UNJUSTIFIED_REFUSAL`.

## The record

- Forklift opening: four signed $950 orders "invoiced net 10". The `subcontractor` field reads: Dale Ruiz, "quoted $520 a session, **available weekly in December**". `daysToCash` is 14. Nothing in the record gives sessions per week, a booked date, or the plants' own dates.
- Arithmetic: 4 × $950 = $3,800. Three sessions give $2,850, which is under $3,000. **All four must settle by day 30**, so with net 10 every session must be held by **day 20 (Thu 2026-12-17)**.
- Day 0 is Fri 2026-11-27 and day 30 is Sun 2026-12-27. December starts on day 4 (Tue 12-01), so only three December weeks fall before day 20: Dec 1–4, Dec 7–11 and Dec 14–17.

## Schedule under each reading of "available weekly in December"

| Reading | Sessions held (day / date) | Net-10 settles (day) | Settled by day 30 |
|---|---|---|---|
| R1: one session per week, earliest December slot each week | 4 (12-01), 11 (12-08), 18 (12-15), 25 (12-22) | 14, 21, 28, **35** | **$2,850, so it fails** |
| R1': one per week, Monday slots (from week 2) | 4, 10, 17, 24 | 14, 20, 27, **34** | **$2,850, so it fails** |
| R2: available every week, capacity per week unstated, at least 2 in one of the first three weeks | e.g. 4, 4, 11, 18 | 14, 14, 21, 28 | $3,800, so it passes |
| R3: all four in week 1 (what revisions 3–4 assumed) | 4 ×4 | 14 ×4 | $3,800, so it passes |

The phrase "available weekly" reads most naturally as "has availability every week". It neither caps capacity at one session a week nor establishes more than one. Under every one-per-week reading the fourth payment lands after day 30. The target is met only if at least one week holds two or more sessions, and the record says nothing either way. `daysToCash: 14` is a per-deal figure for this opening, and it cannot override the subcontractor's narrower availability text. **Trainer capacity for four sessions by day 20 is therefore UNKNOWN: neither established nor ruled out.**

## 1. Is the published plan (rev_9a8c776187a7_da84c6, CONDITIONAL) correct under §2?

Yes, at the verdict level. §2(B) asks for a conclusion that names the decisive missing evidence, and this plan does that.

- `quantities` records "sessions the trainer can deliver by day 20" as `UNKNOWN`, `needs: "Dale Ruiz confirms four session dates on or before day 20"`.
- `validation.decides` is `["FULFILMENT"]`, and `chain` marks the forklift opening `missing: ["FULFILMENT"]`.
- It has a day-1 TEST (`t_book`), and its stop and continue rules sit at the right threshold ("fewer than four … collects at most $2,850").

The condition is not invented. It follows from three fields: the four net-10 prices, the 30-day window, and the "available weekly" text. The reviewer's REVISE reviews (finding HIGH FULFILMENT/SETTLES_IN_TIME) found the same thing. Invariant 39 and the `UNCERTAINTY_AS_FAVOURABLE` class forbid the alternative: revisions 3–4 put all four sessions on day 4, which counts an unknown as evidence.

A pedantic quibble: the decisive link is arguably settlement-in-time rather than fulfilment as such, because the fulfiller is named and priced. Capacity is part of an "established fulfiller", though, so FULFILMENT is a fair label.

## 2. Is the expected answer (EXECUTABLE_PLAN) correct?

No. The case `description` says "4 × $950 = $3,800 ≥ $3,000 inside 30 days" and never schedules the sessions. That works only under readings R2 or R3, and the record states neither. A rubric may not assume a fact the record does not state. This one assumes trainer throughput of at least two sessions in some week before Dec 17, or treats `daysToCash: 14` as applying to all four deals at once. The grader's `UNJUSTIFIED_REFUSAL` and the e2e `VERDICT_INCORRECT` both follow from this defect.

**For EXECUTABLE to be correct, the case would need to state** one of these:
- (a) Dale Ruiz can run two or more sessions a week, e.g. "available for up to four sessions a week in December";
- (b) four confirmed session dates on or before 2026-12-17;
- (c) shorter terms, e.g. payment on completion;
- (d) a fifth in-scope signed order, so that three on-time payments still reach $3,000.

## 3. Is every opening accounted for after the change?

No. In the final plan:
- `chain` holds `cop_f94e…` (sessions) and `cop_d216…` (audit);
- `excluded` holds only `cop_d216…` (audit);
- `strategy.opportunityIds` holds only the sessions.

The bowling opening, `cop_d6133366…`, appears only in prose `alternatives` ("Out of scope: the owner now names forklift operator training"). The contract's `exclusions` names the industry rule but not the opening. Bowling dropped out of `chain` in the first revision after the change (`rev_1cc7…_df412b`) and was never moved to `excluded`. The plan has the reason right and simply failed to record it. The e2e failure `OPENING_UNACCOUNTED` ("1 opening(s) neither considered nor excluded") is therefore a genuine plan defect, independent of the rubric. The fix is one `excluded` entry for `cop_d6133366…` with the out-of-scope reason.

## 4. Verdict

**BOTH.**

- **RUBRIC_DEFECTIVE (verdict level).** The expected `EXECUTABLE_PLAN` depends on an unstated capacity fact. On the record as written, the correct final reading is CONDITIONAL/no-plan-yet naming trainer capacity by day 20 (FULFILMENT/SETTLES_IN_TIME), graded `NO_PLAN_JUSTIFIED_CORRECT`. Alternatively, amend the case with fact (a), (b), (c) or (d) above, and then EXECUTABLE is correct and this plan's caution would be over-caution.
- **PLAN_DEFECTIVE (end-to-end level).** The bowling opening is missing from `chain` and `excluded`, so `OPENING_UNACCOUNTED` stands even after the rubric is fixed.
- **Grading consequence once corrected:** verdict level PASS; e2e still FAIL on `OPENING_UNACCOUNTED` alone. The usable-level reading ("FULFILMENT not established") agrees with the planner, which is more evidence that the rubric is the outlier on the verdict.
