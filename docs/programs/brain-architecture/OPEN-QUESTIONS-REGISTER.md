# Brain architecture — owner decisions and open questions register

Requirement **GOV-11** (source items S-0097, S-0098). It sits beside `release-01.pdf`,
the verbatim program source (§96/§97). It records rules and open questions, not
project state; the program, its map and its plan live in the database.

**Appended releases mapped: 0** — the base source (`release-01.pdf`) only. This
number is the count of releases appended to the program (§97) that this register has
been re-mapped against.

## How this register is kept

These rules are checked, not trusted: `checkRegister` in
`server/services/goals/openQuestions.ts` reads this file and holds every rule below
against the program source, and `checkRegisterOnProduction` runs the same check
against the program's stored source on production and this file at the revision
production runs. A paraphrase, a removed entry, a default in an `OPEN` row or an
answer without its pointer and appended wording fails it
(`tests/program-ea512f54-factory-program-d0-p1-open-questions.test.ts`).

The check also runs on the live Brain, not only in that test. The goals tick
(`server/services/goals/tick.ts`) runs `reconcileRegisterIfDue` every five minutes:
it compares this file at the running revision with the program's stored source and
its appended releases, and records a `PROGRAM_REGISTER_BEHIND` factory event when the
outcome turns bad — including when a release has been appended since the number
above — and `PROGRAM_REGISTER_CURRENT` when a re-map brings it back. It records only
when the outcome changes. A release that lists further decisions or questions under
the same lead-in adds numbered entries after the existing ones; each must be present
and verbatim.

- Every clause below is the owner's wording, copied verbatim from the source. Nothing is
  paraphrased, summarised or completed.
- An entry's **Status** is the only field that changes. Answering a question is a
  re-map of that entry (`OPEN` → `ANSWERED`, plus a pointer to the release or requirement
  that carries the answer). The quoted clause is never rewritten.
- An `OPEN` question carries **no default value and no decision**. Nothing in Brain may
  treat the absence of an answer as a favourable assumption (§7.39).
- Figures, categories and examples are data, never a whitelist (R01-A1, §18.1).
- The owner will continue adding and refining the architecture. A new release appends
  new entries here; it never removes one.
- Vocabulary is the program owner's (§96/§97): no new status set. `OPEN` and `ANSWERED`
  describe a question, not a requirement, and do not appear in the program's own status.

## Decisions established by the owner (source S-0097)

| ID | Status | Clause (verbatim) |
|---|---|---|
| GOV-11-D1 | DECIDED | Financial milestones such as 10K/100K/1M are examples, not hard-coded progressions. |
| GOV-11-D2 | DECIDED | Near-term collected-money objectives matter, but substantial reinvestment is expected during the build phase. |
| GOV-11-D3 | DECIDED | Different businesses are permitted to have different extraction, growth and creative-funding roles. |
| GOV-11-D4 | DECIDED | The range of commercial possibilities must not be limited to Brain’s database or to presently fashionable AI services. |
| GOV-11-D5 | DECIDED | Ideas should morph repeatedly, combine across markets and generate new opportunities from their own transformed elements. |
| GOV-11-D6 | DECIDED | The user will continue adding and refining the architecture; preserve the unabridged intent. |
| GOV-11-D7 | DECIDED | Avoid repeated rhetorical restatements and oversimplified explanations. Engage at a technical and strategic level. |

## To define as the user continues (source S-0098)

| ID | Status | Question (verbatim) | Answer |
|---|---|---|---|
| GOV-11-Q1 | OPEN | Exact mechanics and representation of the ‘thinking map’ and idea-transforming operations. | none recorded |
| GOV-11-Q2 | OPEN | What degree of novelty/diversity is useful, and how the system should prioritize emerging branches. | none recorded |
| GOV-11-Q3 | OPEN | Capital-governance policies and financial structures for differing business archetypes. | none recorded |
| GOV-11-Q4 | OPEN | How aggressively future objectives may consume scarce resources from present obligations. | none recorded |
| GOV-11-Q5 | OPEN | Exact target levels for concurrent research throughput, worker utilization and minimum exploration. | none recorded |
| GOV-11-Q6 | OPEN | Full product interaction and visualization requirements. | none recorded |
| GOV-11-Q7 | OPEN | Calibration/decision rules for optional or mandatory confidence thresholds in future goals. | none recorded |

## Re-mapping an answer

When the owner answers a question, in a new release or in a message: change that row's
Status to `ANSWERED`, put the release number or requirement id in **Answer**, and append
the owner's wording verbatim beneath the table under a `### GOV-11-Qn` heading. Leave the original
question text as it is.

When a release is appended to the program, whether or not it answers anything: read it,
re-map every entry it answers or adds, and then set **Appended releases mapped** to the
program's new release count. Until that number moves, the register is reported behind.
