# E-014: Brain's standing operating rule versus what the owner offered (W1g, d5beaf6)

**Hypothesis.**
- When the owner offers their own work, no prompt still states "the owner does no physical work".
- Discovery no longer adds the online-only focus.

**Inputs.** Nine owner texts:
- (a) labour or equipment offered: p02 drone, p06 15 hours;
- (b) nothing offered;
- (c) physical work refused, and p10 "can't put any hours in";
- four offer phrasings, to test whether the offer regex sees them (C03-F).

For each text the harness builds:
- REF `routePrompt`, `critiquePrompt` and `directionPrompt`;
- `discoveryFocusFor`;
- the full goal-lens discovery statement as `openGoalRound` builds it: `questionFor(goalBucket(... discoveryFocusFor ...), ..., frame)` at `discovery.ts:1345`.

**Command.** `node --import tsx docs/investigation-2026-11-26/experiments/harness/e014_operating_rule.ts`

**Raw output.**
- `raw/E-014/result.json`
- `discovery_question_p06_with_frame.txt` (full text)
- `execution_frame_sentence.txt`

## Results

| owner | offer read | route / critic / direction prompt | discovery focus | discovery question still says "owner does no physical work"? |
|---|---|---|---|---|
| p02 drone ("I can fly about 20 hours a week") | offered | **lifted**: standing sentence replaced ✓ | lifted ✓ | **yes** |
| p06 ("I can put in 15 hours") | offered | lifted ✓ | lifted ✓ | **yes** |
| licensed electrician | offered | lifted ✓ | lifted ✓ | **yes** |
| offers nothing | — | standing sentence | online-only | yes (correct) |
| refuses physical work | refused | standing sentence | online-only | yes (correct) |
| p10 no hours | not offered | standing sentence | online-only | yes (correct) |
| "a couple of evenings a week" | **missed** | standing sentence | online-only | yes |
| "Got a pressure washer and my Saturdays" | **missed** | standing sentence | online-only | yes |
| "I don't mind driving or doing deliveries" | **missed** | standing sentence | online-only | yes |

**Route path.** The lift works. LIMITS carries "For this goal the owner offered their own work (…), so the standing rule … does not apply", and the STEP 2 direct-means line is present.

**Discovery path: W1g fixes only half of it.**
- `discoveryFocusFor` is lifted.
- But `questionFor` then unconditionally appends `executionFrameSentence(frame)`, or `OPERATING_MODEL_SENTENCE` when there is no frame (`discovery.ts:1881`).
- That sentence says the operation "holds no professional licence … or local physical presence, and takes no employment or hourly positions", says to "Leave out job postings, hourly positions", and ends with "the owner does no physical work".
- So one discovery question for the drone pilot or the p06 owner says both "look first for work buyers book and pay the owner for directly, in person included" and "the owner does no physical work … holds no licence".
- It also excludes the hourly gig work (TaskRabbit) that the 30Q graders named as p06's strongest route.

**Offer detection (C03-F).** 3 of 4 ordinary offer phrasings are missed. Those owners are then treated under the standing rule everywhere: PHYSICAL rejections in `parseRoutes` and online-only discovery.

## Diagnostics

| question | detects known-bad? | passes known-good? | catches injection? |
|---|---|---|---|
| C03-P (every prompt states the lift) | route prompts yes; **the discovery question no** | yes (b and c are correct) | — |
| C03-I (the lift changes discovery) | **partially**: the focus changes, but the contradicting sentence remains | — | — |
| C03-F (regex misses an offer) | **yes, FAIL**: 3 of 4 missed | electrician and "fly" read ✓ | — |
| C03-R (gates read the same resolution) | the focus and the frame sentence disagree inside one question | | |
