# E-010: parser replay of recorded replies through REF `parseRoutes`

**Hypothesis.** The wave-1 parser repairs (W1c economics/ACQUISITION, W1d OWNER_FIT kept) change what the recorded E0 replies yield. Correct rejections (MARGIN, HOURS, DEADLINE, CAPITAL) persist.

**Epochs.**
- Known-bad inputs are the recorded raw replies: 12 E0 probes on c52d6d3, plus the coordinator's E1 case (E-002, a8c4699).
- Known-good controls and the injected cases are constructed.

**Inputs.**
- `raw/E-010/probes.json`, extracted verbatim by `harness/extract_probes.py` from `docs/intelligence-test-2026-11-26/planner/{probe1,final}_*.txt` and `raw/E-002/eval.txt`.
- The REF context is built per case (`harness/lib.ts`):
  - objective, amount, window, capital and hours as recorded;
  - `hoursPerWeek` 20 for p02, as the recorded prompt states;
  - REF `ownerLabourOffer`;
  - the recorded findings;
  - today = 2026-11-26.

**Command.** `node --import tsx docs/investigation-2026-11-26/experiments/harness/e010_parser_replay.ts`

**Raw output.**
- `raw/E-010/replay.json`
- `constructed.json`
- `controls_p06.json`
- `lead_truncated_e002.json`
- `stdout.txt`

## Result: recorded replies (17 non-empty, 6 empty)

| case | recorded (c52d6d3) | REF | changed by |
|---|---|---|---|
| probe1_p10_all | 0 kept; 2 × OWNER_FIT | **2 kept** | W1d (repair works) |
| final_p06_all | 1 kept; HOURS (2 h/sale × 13 = 26 h > 15) | **2 kept** | 4baa4dc (pre-W1, "one sale must fit") |
| probe1_p06_cap | 1 kept; HOURS (1 h × 17 = 17 h > 15) | **2 kept** | 4baa4dc |
| final_p06_cap | MARGIN (cost 62 = price 62) | MARGIN | unchanged (correct) |
| final_p10_cap | BRAIN_DELIVERABLE | BRAIN_DELIVERABLE | unchanged |
| the other 11 | identical | identical | — |
| final_p02_cap | 6 kept | 4 kept | **recording artefact**: content was cut at 9000 chars when recorded; not a behaviour change |
| E-002 (a8c4699) | `{routes:[],rejected:[]}` | `{routes:[],rejected:[]}` | — (see lead (a)) |

**Controls on the p06 limits** (`controls_p06.json`). These rejections still fire, so the rule itself works:
- one sale over the hours (20 h against 15);
- MARGIN;
- DEADLINE (8 days against 7);
- CAPITAL ($5 against $0).

What no longer fires is the HOURS rejection the 30Q graders called **correct** (2 of the 3 correct rejections). REF now keeps any route where a single sale fits and leaves the sum to the plan.
- That is a deliberate change (4baa4dc).
- But the graders' "correct rejection persists" control **fails**.
- Whether the plan-level sum (`withoutSpareOwnerWork`) catches it is not tested here.

**W1c (economics), constructed** (`constructed.json`, p10 limits: $20,000 / 90 days / $5,000):

| route | REF |
|---|---|
| $45 beanie, $25.43 cost, **$38.99 CPA given**, 445 buyers | **rejected ACQUISITION** ✓ |
| same route, **no `acquisitionCostPerSale` field**: every recorded reply, because the field did not exist pre-W1c | **kept**; the line says "states no cost to win a buyer … needs 1022 sales … only 445 buyers" |
| CPA $15 (below the margin), so 4,377 sales cost **$65,655** in acquisition against a **$5,000** capital limit | **kept**; nothing compares acquisition spend with capital, and the COMPUTED line does not mention capital |
| sound control ($400, $100 cost, $50 CPA) | kept, not flagged ✓ |

The recorded "445 sales from $3k at $38.99" route (probe1_p10_cap) is **still kept by the REF parser**, because its reply has no CPA field. It is flagged only in prose (`buyersShort`). The ACQUISITION rule depends entirely on the model volunteering the field.

## Lead (a): the E-002 truncated content

- **Input:** 2,103 chars, error null, ending inside `"grounds": {"channel`.
- **REF `routesJson`:** `null`. The first route never closes, so nothing can be salvaged.
- **`parseRoutes(null)`:** `{routes: [], rejected: []}`.
- **Confirmed:** the result is silent zero routes and zero rejections. The text itself carries no marker that it was truncated.

## What this shows and does not show

**Shows:**
- the deterministic code path, given fixed model output;
- W1d changes the recorded outcome;
- W1c changes it only when the model fills a new field;
- the HOURS change predates W1.

**Does not show:** how a live model answers the REF prompt. The REF prompt asks for `acquisitionCostPerSale`, so a live reply may now carry it.

## Diagnostics

| question | detects known-bad? | passes known-good? | catches injection? |
|---|---|---|---|
| C30-P (rejections correct) | yes: OWNER_FIT false rejections are gone at REF | **no**: the graders' "correct" HOURS rejections no longer fire | n/a |
| C30-F (output lost to a field rule) | yes, OWNER_FIT case | yes | E-002 truncation is lost with no rule (see E-015) |
| C09-F (false reject) | yes | yes (4 controls) | — |
| C25-P / C25-F / C25-I (economics) | **partly**: only with a CPA field | yes | **no**: spend over capital is not caught |
