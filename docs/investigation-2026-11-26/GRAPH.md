# Unified causal failure graph: lead draft v1 (to be challenged by Gate C)

**Edge types**
- `cause → mechanism → failed capability → consequence → FINAL`.
- Dotted edges conceal (one failure hides another from detection).
- Thick edges amplify (one failure makes another worse).

Node IDs match `ROOT-CAUSES.md` (CR-xx), `maps/C/requirements.json` (Q-Rxxx) and the experiments (E-xxx).

```mermaid
flowchart LR
  %% shared mechanism classes
  M1[M1 model text trusted without contract]
  M2[M2 owner facts read by regex / injected text]
  M3[M3 no per-goal state, no arbiter]
  M4[M4 evaluation & observability blind to failing path]
  INF[CR-08 research supply starved]
  MOD[CR-02 production models below bar]

  M1 --> CR01[CR-01 incomplete turns accepted]
  M1 --> CR03[CR-03 unverified critic veto]
  M1 --> CR04[CR-04 economics only if model volunteers fields]
  M1 --> CR16[CR-16 silent discard in parsers]
  M2 --> CR05[CR-05 standing rule injected as owner limit]
  M2 --> CR06[CR-06 objective reader silent misreads]
  M2 --> CR13[CR-13 operator goals never searched]
  M3 --> CR09[CR-09 no shared goal record / lessons expire]
  M3 --> CR10[CR-10 15 generators, 18 selectors, project-wide openings]
  M3 --> CR11[CR-11 readiness unreachable by research]
  M3 --> CR14[CR-14 fuzzy buyer identity closes question]
  INF --> CR07[CR-07 findings by recency not relevance]
  M4 --> CR12[CR-12 suite never runs discovery→research→proposer→critic]

  %% capabilities (Map C)
  CR06 --> CAP_INTERP[Q-R001..004 interpret objective & owner]
  CR05 --> CAP_INTERP
  CR13 --> CAP_DISC[Q-R016 discover opportunities]
  CR15[CR-15 inquiry anchoring] --> CAP_INQ[Q-R023..025 decisive unknowns & questions]
  INF --> CAP_RES[Q-R027..030 research & verify]
  CR07 --> CAP_DELIV[Q-R045 provenance / delivery to planner]
  CR14 --> CAP_BUYER[Q-R035 buyer existence]
  CR01 --> CAP_TURN[Q-R056 model-output validation]
  CR16 --> CAP_TURN
  MOD --> CAP_REASON[Q-R040..047 economics, cash, timing]
  CR04 --> CAP_REASON
  CR03 --> CAP_CRIT[Q-R052..057 critique & calibration]
  CR09 --> CAP_STATE[Q-R008/009/076 shared understanding & learning]
  CR10 --> CAP_SELECT[Q-R061..063 compare & single arbiter]
  CR11 --> CAP_READY[Q-R072 readiness ≠ money approval]
  CR10 --> CAP_PLAN[Q-R066..071 executable plan from structured model]

  %% consequences
  CAP_INTERP --> X_WRONG[wrong limits / invented refusals]
  CAP_DISC --> X_NOROUTE[no owner-read routes]
  CAP_INQ --> X_NARROW[narrow / anchored strategies]
  CAP_RES --> X_NOFACTS[0 relevant facts reach planning]
  CAP_DELIV --> X_NOFACTS
  CAP_TURN --> X_FALLBACK[weak fallback plans or zero routes]
  CAP_REASON --> X_BADMATH[unsound economics]
  CAP_CRIT --> X_VETO[sound routes dropped / bad kept]
  CAP_BUYER --> X_BADMATH
  CAP_STATE --> X_REPEAT[same mistake each ask; contradictory readings]
  CAP_SELECT --> X_GENERIC[generic constructed strategy chosen]
  CAP_READY --> X_NEEDS[NEEDS_EVIDENCE forever]
  CAP_PLAN --> X_NOSTEPS[1 research step, no executable plan]

  X_WRONG --> FINAL((unusable plan))
  X_NOROUTE --> FINAL
  X_NARROW --> FINAL
  X_NOFACTS --> FINAL
  X_FALLBACK --> FINAL
  X_BADMATH --> FINAL
  X_VETO --> FINAL
  X_REPEAT --> FINAL
  X_GENERIC --> FINAL
  X_NEEDS --> FINAL
  X_NOSTEPS --> FINAL

  %% interactions
  CR01 ==>|hands reasoning to laguna 1/30| MOD
  CR04 ==> CR03
  CR03 ==> CR04
  X_NOFACTS -.->|conceals| CR03
  X_NOFACTS -.->|conceals| CR04
  X_NOFACTS -.->|conceals| CR07
  CR12 -.->|conceals all M1-M3| FINAL
  CR12 ==>|repairs tuned to batch / component tests| LOOP[local repair declared done]
  LOOP ==> FINAL
  FINAL ==>|next eval fails| LOOP
  CR16 -.->|truncation counted as 'no answer'| CR01
```

## Reading the graph

1. **Two independent entry failures, either of which alone yields an unusable plan:**
   - **INF.** No facts reach planning.
   - **M1 with MOD.** The model turn fails, or is answered by the weakest model.
   - Fixing either one alone leaves the other blocking. This is measured: supplying facts moved 0/3 to 0–1/3, and a strong model inside Brain's machinery scored 0/3.
2. **Hidden downstream failures, exposed by controlling upstream:**
   - CR-03 (critic), CR-04 (economics) and CR-07 (selection) were invisible in production because no facts arrived.
   - The supplied-facts experiments (30Q, E-002, E-010–E-012) exposed each of them independently. This is the owner's Section 11 "upstream conceals downstream" case.
3. **The feedback loop (CR-12 into LOOP into FINAL into LOOP)** explains the campaign history:
   - Repairs are tuned to the batch that failed and verified by component tests.
   - In E-010–E-016 the W1 repairs change little of the recorded failure, and E-002 on production still yields nothing.
4. **Structural ceiling (M3).** Even a good model-written route enters as one opening among project-wide constructed arrangements that read nothing of the owner. Deterministic selection then picks by assumption-only reach.
   - The live $10k reading at 05:40Z: chosen strategy only_o3, reach 0.97 with basis ASSUMPTION_ONLY, supported reach 0, committee FAIL.

## Correctly functioning paths (recorded so they are not "repaired")

These pass in Brain's own deterministic replays:
- **MARGIN, DEADLINE and CAPITAL single-sale parser rejections** (E-010 control).
- **REFUTED claims are filtered** (E-012).
- **Exact-duplicate dedupe** (E-012).
- **The empty-reply 2× retry, then fallback** (E-015).
- **Route-prompt lift for owners who offer labour** (E-014).
- **Tuned objective phrasings 7/7** (E-013).
- **The committee correctly blocks acceptance** on unsupported deal counts. This is observed on the live $10k reading and on wst_db2e.

Not re-verified here:
- **Verification of quotes against re-read pages.** It was an evaluation tool (30Q `verify.py`), not a production mechanism.

## Untested interactions (recorded, not silently passed)

- Research and planning feedback over multiple days on E1 (requires a live goal re-plan).
- Queue/worker recovery under DB contention while a goal is planning.
- GPU throttling (the event loop caps concurrency) interacting with the route-ask latency budget.
- Whether CR-13 affects any live goal (Map B pending).
