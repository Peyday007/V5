# Step 12B — the combined reading at the deployed revision

    dd1f9be279efce3adc82ec4c27e9797e79814eea
    8 PASS · 1 FAIL · 5 PARTIAL · 3 BLOCKED · 0 NOT_RUN · 0 CONFLICT   (of 17)

This is the join of two records that name the same revision, produced by
`scripts/step12b-combine.ts`, which **refuses** any other pairing: two
different revisions, a record taken over a dirty tree, or two runs that
looked at one scenario and disagreed (`CONFLICT`, counted against the
reading, never resolved by picking a winner).

| | |
| --- | --- |
| CHECKOUT | a pristine worktree at `dd1f9be`, revision attested by git |
| PRODUCTION | the container, revision attested by the sha stamped into the image at build time — [run 34773399528](https://github.com/Peyday007/V5/actions/runs/34773399528) |

Neither environment can answer everything, and that is a property of the
deployment rather than a gap in the reporter: `.dockerignore` deliberately keeps
`tests/`, `docs/` and `client/src` out of the image, so the repository half is
unreadable there; and a checkout has no fleet. The combiner joins **by condition
name**, which is what turns two PARTIALs into an answer instead of a guess.

---

## The reading

| | scenario | verdict | held |
| --- | --- | --- | --- |
| A | Conversation routing and continuity | **PASS** | 10/10 |
| B | Independent judgment | **PASS** | 12/12 |
| C | Priority and backlog | **PASS** | 13/13 |
| D | Discovery Frontier v1 | PARTIAL | 9/10 |
| E | Connected-site intelligence | **PASS** | 10/10 |
| F | Needs You | **PASS** | 11/11 |
| G | Capability Lab | PARTIAL | 7/8 |
| H | Visual maps | BLOCKED | 7/8 |
| I | Collaboration | **PASS** | 45/45 |
| J | Mobile | PARTIAL | 14/16 |
| K | Legacy removal | **PASS** | 4/4 |
| L | Always-on loop | **FAIL** | 16/17 |
| M | Product truth and named denominators | PARTIAL | 9/10 |
| N | Routing and latency explanation | **PASS** | 10/10 |
| O | Visual and interaction approval | BLOCKED | 1/2 |
| P | Migrations, restart and preserved integrations | BLOCKED | 7/8 |
| Q | Shared access and safe experiments | PARTIAL | 30/31 |

**Every required condition is in the denominator.** Nothing is exempt: the
`standing: true` flag that let a condition excuse itself from scoring was
removed, no code under `scripts/` writes a `deferredBy`, and the four shapes a
condition can take are `held: true`, `held: false` (a defect), `held: null` with
a `needs` (another environment can answer it), and `held: null` with an `awaits`
(a person must).

---

## The one FAIL, and what it is about

**L · "its cursor moved between two readings — a window, not a timestamp"**
read `2026-09-13T18:02:40.809Z → 2026-09-13T18:02:40.809Z`. Byte-identical.

The sixteen conditions beside it held, including the two the owner named:

    a mission completed and the project believes something because of it
      mission rms_683d8907fcb94e94bb63 (DONE), packet CANCELLED, document
      doc_d7fb8b7ed5aa4edfac25 with bytes, knowledge rkn_6a597fe75e0145af9a27
      (CONCLUSION)

    and the conclusion cites the document it came from and the audit that judged it
      provenance names the document: yes; names audit aud_6d16af754e3a4215bf5a:
      yes; filed under a layer: yes

    the deployed loop is running, and carries no recorded error
      RUNNING, no error, last ran 20s ago

**The row beside it is what makes the diagnosis checkable rather than a
hypothesis**: a loop that last ran twenty seconds ago is ticking. The cursor
reading is a measurement whose window is narrower than the thing it measures.
The image excludes `tests/`, `docs/` and `client/src`, so the repository half of
the report is skipped and the reporter step took **fifteen seconds** against a
`RUSSELL_TICK_MS` of 30,000 — so both readings fall inside one tick, every time,
whatever the loop is doing.

Two independent container readings at this same revision, three minutes apart,
say what the loop actually did:

    17:59:40.794Z  →  18:02:40.809Z     180,015 ms — six whole ticks

recorded in `docs/evidence/step12b-loop-cursor.json` with both run ids and both
artifact digests. **That file awards nothing.** No code reads it, L reads FAIL at
this revision and stays FAIL, and a reporter that consumed its own hand-written
evidence would be grading its own exam.

The fix is in the reporter: `reReadCycle` polls for a window two ticks wide. It
can still fail — a loop that has genuinely stopped produces the same timestamp
for seventy-five seconds and the condition says so, now with the window printed
beside it. What changed is that *"it did not move"* means the loop did not tick,
rather than that the report was quick. **That fix is not at `dd1f9be`**, so the
reading above is the honest one for what is deployed.

---

## The three BLOCKED, and who each is waiting on

**O — the owner.** The complete design, bound to this revision and these bytes.
Nothing under `scripts/` can write that row and a test enforces it by refusing
any import of the writer outside `admin.ts`. The render set exists and digests
consistently; the judgement is a person's.

**H — the same decision.** Seven of eight conditions held, including every map
opened by pressing its own tab at phone width and photographed, and the
constellation measured at every width with overlaps at none. The eighth is
*whether the maps are any good*, which O covers.

**P — a Deploy run at this revision.** Both migration chains upgrade populated
data and preserve every pre-existing row, on both backends. The eighth condition
is the hosted check either side of a real restart of a real machine, and it is
the `Deploy` workflow's own record. A deploy of `dd1f9be` has produced one —
[run 34771692417](https://github.com/Peyday007/V5/actions/runs/34771692417),
`beforeRestart: true`, `afterRestart: true` — but that record is necessarily
written *after* the revision it attests to, so it is not in the tree at
`dd1f9be` and the condition reads BLOCKED there. It is committed on the branch
above this one.

## The five PARTIAL, and what each is missing

| | what is still open | who can answer it |
| --- | --- | --- |
| D | an asked lens has been answered by a reader on real work | a person reading |
| G | how much a real Cowork surface holds | a measurement that spends the subscription |
| J | the question a person typed was answered rather than left waiting; and its result was inspected there | the deployed phone interface |
| M | the same comparison made over HTTP with an authenticated principal | a signed-in read |
| Q | the same canary cycle against the deployed fleet | the deployed fleet |

**J's two are deliberately open and are not closable from here.** The journey
walks the sequence — a person overrules Russell's priority from the phone,
Russell launches that idea, its packet parks outside the preauthorized envelope,
the person answers with a thumb, the same mission carries on, and the work is
identifiable on screen by the ids Brain wrote for it. What is not proved is a
*question typed by a person being answered* and *its result inspected through
the deployed interface*, because that needs a worker on the deployed fleet, and
the container cannot run the journey at all: `journey.json` is produced by
`scripts/visual-qa.ts`, which the image excludes. Closing them would mean
writing journey rows into a production project that holds real research. That is
the owner's decision, not the reporter's.
