# Research Intelligence v1 — the aftermath half

**Status:** a proposal. Every section below was authored by a reader and is
stored on the realization packet as `PROPOSED`. Nothing here is accepted, and
nothing here has been built.

**What produced it:** the capability kernel, run against the real
`Brain_Intelligence_Map.md`. §5.1's definition was promoted after an independent
audit, held against a 571-component reading of Brain itself, and the 28 gaps
that came out were classified by a reader. This is what those gaps say when they
are read together.

---

## The finding

**Everything this faculty is missing sits after the packet's own terminal
state.**

The run itself is live and proven: plan, fragment, verify, gate, synthesize,
audit. Nine of the requirements in §5.1 resolve to modules with rows in
production. Ten belong to other faculties' packets. What is left is seven
requirements, and every one of them is about what happens when a run ends:

| Requirement | Today |
|---|---|
| Belief-update proposals | nothing proposes a change to a held belief |
| Research lessons | nothing records what a run taught about researching |
| Suggested experiments or simulations | nothing turns an unknown into a proposed test |
| *A decision reached that could not be reached before* | nothing measures it |
| *An after-the-fact evaluation of which research choices were useful* | nothing scores a fragment |
| New questions and research gaps | exists, and dies with its packet |
| Contradictory evidence requires adversarial research | classified, and nothing pulls it |

A gap the judge names is unreadable as a question once its round is settled. A
contradiction is classified and nothing re-enters research because of one. A
fragment's cost is timed and never held against whether it contributed. So
*uncertainty must survive the pipeline* — the faculty's own invariant — stops
being true exactly at the packet boundary.

---

## What it would add

Three append-only tables and one derivation on the durable tick.

- **A per-fragment retrospective.** Attempts held against whether the fragment's
  claims were cited in the synthesis. That is the producer for the faculty's
  second evaluation requirement, and it is what makes the first measurable.
- **A standing question.** Opened from an audit gap whose classification permits
  research to stay open, or from a genuine contradiction — not a scope,
  timeframe, geography or population difference, which `contradictions.ts`
  already tells apart. Closed by a later packet's accepted claims, citing the
  claim that closed it.
- **Proposals.** A belief update to faculty 4, and a suggested test to faculty 9,
  each refused whole if it cites nothing.

Every input is a row Brain already writes. That is the finding rather than a
convenience: **the faculty's missing half needs no new evidence and no new
external access** — only a reader of what the runs already recorded.

One bounded model pass, and only for an audit gap that states a finding without
stating a question. It proposes a question and never a classification: the
classification is already a column, and a model answering it again would be
model output deciding state.

---

## What it may not do

- It applies nothing. Every output is a proposal to a faculty that owns the
  state, which is what makes *proposes what is true and what remains unknown*
  true rather than a word.
- It reads one packet in one project. A pass that could read another project's
  claims would be proposing beliefs from evidence this project never accepted.
- It reads no external source at all, needs no new scope and no new credential.
- It never re-opens a terminal packet or charges an attempt.

---

## How it would be proved

Three powers, each with a baseline, a test, an ablation and an adversarial case.
The full graph is on the packet; the shape is:

1. **A question survives its packet.** Two packets in one project, the second
   answering what the first left open — assert the question opens on the first
   and closes on the second, citing the claim that closed it. Ablation: with the
   table empty the second packet re-derives rather than finds, which is today's
   behaviour and the thing being changed.
2. **A fragment can be called worth running.** Three fragments — cited, accepted
   and uncited, blocked — must produce three distinct verdicts. A packet that
   filed nothing must say so rather than read as every fragment being worthless.
3. **A belief update is proposed rather than held.** Citing an accepted claim is
   stored; citing a rejected or unknown one is refused whole.

**What would not count**, stated because it is what would be reached for:

- The suite passing. That is evidence about the code and not about the power.
- A merged pull request. `prove.ts` refuses to move a dimension on one.
- Rows existing in the new tables. The question has to be read by
  `coverBeforeWork` and the retrospective by the evaluation, or it is a
  mechanism nothing calls for the seventh time.

---

## What it is waiting on

Two requirements in §5.1 name an authority, and the gap calculus sends anything
naming permission, authority, approval, consent, a credential or spending to a
person whatever machinery matched it:

- *Available tools, workers, budgets and time.*
- *Permission and privacy boundaries.*

Until a person answers those, `decisionReadiness` refuses and `compile` will not
produce a change request. That refusal is the design working, not a blocker in
the machinery: the last thing between a specified capability and a contract
somebody approves is the person.
