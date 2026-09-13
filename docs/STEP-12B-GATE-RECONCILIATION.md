# Step 12B — reconciling A–Q with the frozen acceptance conditions

The owner rejected the completion claim with a specific finding: *"The reporter
at deployed revision `386356f` only allows G and K to return PASS. The other
fifteen gates have no evidence-driven PASS path."*

That is correct, and it is checkable from the source rather than inferred from
the output. Here are the verdict expressions as they stood:

| Gate | Expression | Can it PASS? |
| --- | --- | --- |
| A | `seen.answeredTurns > 0 ? 'PARTIAL' : blocker.verdict` | no |
| B | `judgedCandidates > 0 && auditPasses > 0 ? 'PARTIAL' : blocker.verdict` | no |
| C | `classified === 100 && dedupeFailed.length === 0 ? 'PARTIAL' : 'NOT_RUN'` | no |
| D | `derivationHeld ? 'PARTIAL' : 'NOT_RUN'` | no |
| E | `live && sixAnswers ? 'PARTIAL' : 'NOT_RUN'` | no |
| F | `offersHeld && singleAnswerDoesNotPark ? 'PARTIAL' : 'NOT_RUN'` | no |
| G | `complete === LAB_MODES.length ? 'PASS' : 'PARTIAL'` | **yes** |
| H | `maps && /emptyReason/.test(maps) ? 'PARTIAL' : 'NOT_RUN'` | no |
| I | `failed.length === 0 && workerRefused ? 'PARTIAL' : 'NOT_RUN'` | no |
| J | `… ? 'PARTIAL' : 'NOT_RUN'` | no |
| K | `removalTest ? 'PASS' : 'NOT_RUN'` | **yes** |
| L | `ticking ? 'PARTIAL' : halted ? 'BLOCKED' : blocker.verdict` | no |
| M | `… ? 'PARTIAL' : 'NOT_RUN'` | no |
| N | `trace && trace.steps.length > 1 ? 'PARTIAL' : 'NOT_RUN'` | no |
| O | *(rewritten — see below)* | now yes |
| P | `upgrade ? 'PARTIAL' : 'NOT_RUN'` | no |
| Q | `… ? 'PARTIAL' : 'NOT_RUN'` | no |

**This was not a threshold that had not been reached. It was the absence of a
branch.** Every one of those gates ended its detail with a sentence beginning
*"NOT established here: …"*, and that sentence was written as permanent prose
rather than as a condition something could satisfy. A scenario whose unmet
condition is a paragraph is a scenario nobody can finish.

## How a gate is judged now

Each gate declares its conditions. All conditions met is `PASS`. A condition
that was **exercised and did not hold** is `FAIL`, naming it — never `NOT_RUN`,
which asserts nothing has happened and is the opposite of what occurred. A
condition that genuinely could not be exercised in this environment is
`PARTIAL`, and it must name which environment can exercise it, because *"we
could not look here"* and *"we looked and it is not there"* are different facts
with different remedies.

Three conditions are allowed to be permanently out of reach, and each says so in
the row rather than in a footnote: a decision that is the owner's, a capability
this version declares and refuses, and a measurement that needs a real Cowork
surface and therefore spends the subscription.

## The mapping, and what each gate was missing

`P`/`A`/`T`/`R` refer to the 52 frozen conditions in `docs/STEP-12B-MATRIX.md`.

| Gate | Frozen conditions | What was missing |
| --- | --- | --- |
| A | P3, P4, A9, R4 | Counted turns; never drove continuity across a restart mid-turn. |
| B | A1, A3, A4, A5 | Counted rows; never drove a judgment a person overrode end to end. |
| C | P5, A1, A3 | Drove the merge; the repeat was never named by a worker from a live conversation. |
| D | P11 | Five derived lenses answered; the five *asked* lenses need a reader, which is the design and must be stated as such rather than as a shortfall. |
| E | P17 | Read the live connection; never drove a site command through to a launched mission. |
| F | P8, R3 | Drove `choicesFor`'s three shapes; never drove a real park → answer → move. |
| G | P10, T1–T5 | **All eight modes reach COMPLETE — but reaching COMPLETE is not producing what T3/T4/T5 name.** T3 wants a limit found *or honestly bounded*, T4 a *defensible recommendation*, T5 quality measured *separately from throughput*. The gate asserted the state and not the content. |
| H | P6, P12 | Diagram/outline parity at 390px was driven; desktop and intermediate were not. |
| I | P14, R1, R2 | **The human invitation/acceptance journey does not exist in this repository.** Only worker invitations do. Unpassable until built. |
| J | P13 | One journey driven; no mission on a phone, one browser, one orientation. |
| K | P18, R11 | **Asserted that `tests/operatorConsoleRemoved.test.ts` exists.** File existence is "the code looks like it would", which this reporter's own header refuses. It never checked the route, the client, or that `/legacy` holds the declared seven operations and nothing more. |
| L | A8, A9, R4 | One reading of the cycle row; no measured window. |
| M | P3, P7, P19 | Four readers compared in an isolated database; never over HTTP against versioned production state. |
| N | P9, T7, T8 | One dispatch traced; never across a workload mix. |
| O | P20 | **Consumed nothing.** The design gate lived in a markdown table whose top row read `— pending —`. |
| P | R7, R10, R13 | `upgrade:populated` proves both chains; the hosted pre/post-restart halves are the Deploy workflow's and were never read back. |
| Q | P15, R5, T6, R1 | Canary cycle driven in isolation; the invitation clause is I's, and blocked on the same missing journey. |

## Corrections to the frozen matrix itself

The matrix is frozen in the sense §26 means — the contract does not move once
building starts — but a row that has become **untrue** is a different thing from
a row somebody wants to change, and leaving it is how a document stops being
worth reading.

- **T3, T4 and T5 read `DECLARED AND REFUSED`, and that is stale.** §6 of the
  matrix argues at length that five pressure modes cannot run because they would
  put real pressure on real surfaces. `services/fleet/lab.ts` now runs all five
  against `repos/workQueue.ts` — claiming, leasing, fencing, contention and
  recovery, in-process, in the isolated `TECHNICAL` scope, costing nothing
  external — and every result carries `PROVIDER_UNTESTED` because what a real
  Cowork surface holds is the one thing there that spends money. So the honest
  status is *runs, and bounds the queue rather than the provider*, and the
  reason §6 gave for refusing them remains true of the half that is still
  refused. The correction is recorded rather than applied quietly, because the
  refusal was argued for in detail and the argument was half right.
- **The design gate's own row reads `— pending —` beside four sub-decisions
  marked `APPROVED 2026-09-12`, and I first called that a contradiction. It is
  not, and the correction matters more than the original observation.** They are
  records of two different things. The four are direction decisions taken
  against a hand-drawn preview which states of itself *"Nothing in it is
  implemented. It is a proposal to approve."* The pending row is the approval of
  the complete design. **No approval of the complete design is recorded at
  either stage**, and the row is an accurate record rather than an oversight.

  Four approved sub-decisions are not an overall approval, and nothing may infer
  one from them: a person choosing between two drawn rail layouts has said
  something about rail layouts, not that the product looks right. The four were
  the questions the preview called out as genuinely a person's, never the whole
  of what a design approval covers.

  The distinction is now structural rather than a convention.
  `design_approvals` binds every row to a revision and to a digest over an
  enumerated set of renders **of the built product**; a direction sub-decision
  has no render set, so the table cannot hold one.
