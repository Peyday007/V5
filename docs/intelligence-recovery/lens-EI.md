# Lens E/I — root causes of evaluation failures E-1 and I-1

Repo HEAD cee8f7c. Both failures were reproduced with
`npx vitest run tests/zz-eval-tmp.test.ts -t "<case>"`. The temporary file was deleted afterwards.
Each candidate repair was applied only to a scratch copy
(`/tmp/claude-0/-home-user-V5/ee4d8d9c-4857-5ee6-ac4e-f365ba02baf5/scratchpad/wt`, made with `git archive HEAD`). The repository itself is unchanged.

---

## E-1 — a signed $20K contract with a deposit and a milestone counts $0

**Reproduced:** reach 0, settledP50 0, E1 and E3 FAIL. E4 passes only because nothing settles at all.

### Root cause
`server/services/goals/portfolio.ts` in `demandWorlds`:

- **:467** `const deposit = one.deposit && one.repeatable && one.agreedValue === 0 ? one.deposit : null;`
  The deposit tranche is applied only to repeatable openings that have not been agreed. A signed contract (`agreedValue > 0`) or a one-off (`!repeatable`) loses its deposit.
- **:513** `out.cash.push(one.agreedValue + balanceDeals * price);` puts the whole $20,000 at `days` = `daysToCash`, which is 100. That is after the 45-day deadline, so `quant/portfolio.ts:519` (`if (day <= deadlineDays) total += cash`) counts $0.
- Nothing reads `paymentTerms` into cash timing. The only terms readers are the `PREPAID`, `AFTER_DELIVERY` and `NET_DAYS` regexes in `settlementOf` (:947-951), and they are used only for settlement dates and graph labels. A "40% at the day-20 milestone" has no representation anywhere. The quant `Activity` (quant/portfolio.ts:78) carries at most one `early` tranche.
- The same exclusion is repeated in the analytic sweep at `server/services/goals/reasoning/variables.ts:292`, so reconstruction's variable sweep also ignores tranches on agreed money.

### Is the expectation right?
Yes. 30% at day 3 plus 40% at day 20 is $14,000 of cleared cash inside 45 days, against a $10,000 target. The balance ($6,000, around day 100) is correctly excluded. The kept cash is still at least $12K even after the $2K subcontract cost.

One fixture note: the deposit is given structurally (`deposit: {0.3, 0.3, days 3}`), but the milestone exists only in the `paymentTerms` prose. A card read from the database never has `deposit` (portfolio.ts:91 says only reconstruction sets it). So the repair must read the stated terms, which is also the production-relevant path. The fixture is not wrong, but it means the test exercises terms parsing, not the `deposit` field.

Secondary defect, not blocking: for agreed money `deals` is 0, so `spend = deals*cost` is 0, and the contract's $2K direct cost never leaves the kept cash.

### Minimal repair
1. In `goals/portfolio.ts`, next to `PREPAID` and `NET_DAYS`, add `paymentSchedule(terms, signingDay)`. It splits the stated terms into percentage tranches:
   - "at day N" is day N.
   - "at signing", "at order", "deposit" or "up-front" is the signing day (the `deposit.days` if one is given, else 0).
   - "balance", "net N" or "after acceptance" stays at `daysToCash`.
2. In `demandWorlds`, when `agreedValue > 0 || !repeatable`, emit `early = sold × (sum of pre-balance shares)` and put only the remainder in `cash`. Change :664 to `const revenue = full.early ? …`, so the demand estimate shows the split for these openings too.
3. The proper version turns `Activity.early` into an array of tranches. The four readers are quant/portfolio.ts:443-444, :521-526, :742-749 and :835-838, plus the time-scaling at :1086. The cheaper version, which is the one I verified, merges the pre-balance tranches at the latest of their days. That is conservative: cash never arrives earlier than stated. It only undercounts the deposit when the deadline falls between the deposit day and the milestone day.
4. Mirror the same condition in `reasoning/variables.ts:292`.

**Verified in the scratch copy:** E1–E4 all PASS (reach 1.0, settledP50 $14,000, deposit-only control reach 0).

### Assertions that prove it
- Evaluation E1: `p.best.reach >= 0.9`.
- E3: `settledP50 >= 14_000`.
- E2: `settledP50 <= 14_000` (the balance is not counted).
- E4: the deposit-only terms give reach below 0.5.
- Add a unit test: `paymentSchedule('30% deposit at signing, 40% … at day 20, 30% balance net 30 …', 3)` returns `{share: 0.7, day: 20}`. The deposit-only terms return `{share: 0.3, day: 3}`.

---

## I-1 — presale/prepaid is never chosen under a capital ceiling

**Reproduced:** reach 0, changes [], I2 and I3 FAIL.

### The baseline doc's diagnosis is wrong
`docs/intelligence-recovery/evaluation-baseline.md:58` says "prepaid-fulfilment leaves capital-at-start binding". It does not:

- I evaluated the opening directly, with `causal: false` and 600 worlds. Self-funded gives reach 0 with `overSpend = 1`: spend P50 is $32K against the $1,500 ceiling.
- With `fundedByBuyer: true` (the `capital:prepaid-fulfilment` operator), reach is **0.863**, capitalShort 0, overSpend 0.
- In `reconstructPlan`, round 1 shows `CAPITAL:prepaid-fulfilment reach 0.8633 feasible true`. It is then discarded.

### Root cause
`server/services/goals/reconstruction.ts`:

- **:284-285** (`flagsOf`): `behind = committed + capitalCeiling` is $1,500, and `if (b.settledP50 / behind > RETURN_BOUND)` with `RETURN_BOUND = 20` (:77). The prepaid plan's settled P50 is $50,600, which is 34× the $1,500. So it is flagged `RETURN` and treated as implausible.
- **:401** `improves()` requires `!a.implausible?.length`, so the 0.86 plan is never adopted.
- **:503-510** would fall back to the plan as held in any case.

The critic compares gross settled revenue with the owner's money. In a resale business, revenue is mostly recycled cost of goods: $1,400 of every $2,200 sale goes back to the dealer, and here it is paid out of the buyer's own prepayment. The money actually made is the kept cash P50 of $18,400, which is 12× and inside the bound. Even the self-funded baseline carries the same false flag. The critic's own text (:65 "turns a month's money twentyfold") describes a return, which is kept cash, not turnover.

### Is the expectation right?
Yes.
- **Self-funded:** about 23 deals would need around $32K of purchases through a $1,500 ceiling. That is infeasible, so reach is about 0.
- **Buyer pays at order** (the fixture's terms say "50% at order"; prepaid-fulfilment assumes full prepayment): the ceiling stops binding, and $18K kept against a $12K target in 60 days is a sound economic result.

The fixture is right.

### Minimal repair
At reconstruction.ts:285, judge `RETURN` on the kept cash:

```ts
const kept = b.keptP50 ?? b.settledP50;
if (kept / behind > RETURN_BOUND) out.push({ kind: 'RETURN', detail: `median kept ${money(kept)} is …` });
```

Also update the C-4 doc comment at :65.

**Verified in the scratch copy:** I1–I4 all PASS (reach 0.8633, changes `["CAPITAL:prepaid-fulfilment"]`, committed 0).

The $34.5M-on-$3K production reading that motivated the critic would still be flagged, unless almost all of it were cost. If a stricter guard is wanted, add a second bound on turnover against capital per turn. That is not needed here.

### Assertions that prove it
- Evaluation I2: the chosen plan has a `CAPITAL` change matching /prepa/.
- I3: `r.best.reach - baseline.reach >= 0.2`.
- I4: `committed <= 1500`.
- Add a unit test in `tests/goalReconstruction.test.ts`: a reading whose settledP50 is more than 20× behind but whose keptP50 is under 20× carries no `RETURN` flag. A reading whose keptP50 is more than 20× still does.

---

## Regression check (scratch copy, both repairs applied)
See the summary returned to the caller. The suites run were goalPlanEconomics, goalReconstruction and goalPlanCoherence, plus every test that imports goals/portfolio.ts.

Results with both repairs applied in the scratch copy:
- goalPlanEconomics, goalReconstruction and goalPlanCoherence: 42 of 42 pass.
- The 18 other test files that import goals/portfolio.ts: 145 of 147 passed in the batch run. The two failures were timing tests in `variableExploration` §102 (one ran 30 s). Rerunning that file alone passes 10/10 both in the scratch copy and in the unmodified repo, so the failures came from load during the batch, not from the repairs.
