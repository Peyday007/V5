# What can we actually do? — the decision layer

`server/services/decision/`, `server/domain/decision.ts`, `server/repos/objectives.ts`,
`client/src/russell/ObjectiveBrief.tsx`. The rules are in CLAUDE.md §50; this is how
it works and how to read it.

## The journey

1. **A person asks Russell.** In any conversation attached to a project, a message
   like *"what can we actually do?"*, *"what should we do first?"*, *"what do you
   recommend?"* or *"how can we make money from this?"* enters the decision lane
   (`asksForDecision`). It is deterministic on the person's own words and answered in
   the same request, with no model and no fleet activation.
2. **The objective is resolved from records.** An objective stated in the same
   message ("our goal is to …") is recorded as the person's. Otherwise one already
   open in the conversation is reused. Otherwise the project's recorded objective is
   adopted: for a Cash sprint that is `CANONICAL_CASH_OBJECTIVE` plus any operator
   constraints. If nothing records one, Russell asks the one question it cannot
   answer — what the person is trying to achieve — and takes the reply.
3. **Context is read, not asked.** Project purpose, constraints (grant prohibitions,
   sprint state), resources (deployable cash measured from the money ledger, research
   capacity, messaging capability) and authority (research grant, commercial grant)
   come from rows (`context.ts`).
4. **Every candidate path is put to the same eight tests** (`paths.ts`): demand,
   reach, production, delivery, cost, time, capacity, authority.
   - Cash openings are read from the engine card, the monetization ledger's
     best possibility for them, `readCapability`, `cashPosition` and the grants. They
     qualify only when Cash's own tier and card standard say so.
   - Dealflow deals are read from the dealflow view. Their questions stay the dealflow
     kernel's.
   - For non-revenue projects, ideas and software requests are read, and the
     buyer-shaped tests are `NOT_APPLICABLE`.
5. **The decision is pure** (`decide`):
   - Rejections need a sourced, measured or decided NOT_MET.
   - A qualifying path is recommended with its first execution step.
   - Otherwise the first open test on the leading path is the one research step.
   - Otherwise it is a justified STOP.
   - Order is lexicographic, and ties fall to the owning machinery's own ranking.
6. **The step becomes work, where a grant already covers it** (`act.ts`):
   - The existing deep dive is steered to that opening first.
   - An idea is captured for the loop to judge and launch.
   - A commercial action or a code change is prepared and left at the boundary a
     person owns, with the concrete action attached.
7. **The result comes back.** The Russell tick re-derives every live brief. When the
   recommendation changes, a row is appended to `russell_objective_decisions` and
   Russell posts the change, and what caused it, in the objective's conversation. The
   thread payload and Home carry the live brief.

## Reading it

- **In Russell:** the conversation shows the live brief under the thread, and Home
  lists each objective's headline, step and what it needs.
- **Over HTTP:**
  - `GET /api/russell/projects/:id/objectives`
  - `GET /api/russell/objectives/:id`
  - `POST /api/russell/objectives/:id/advance`
  - `POST /api/russell/projects/:id/objectives` adopts the recorded objective.
  - `POST /api/russell/objectives/:id/close`
- **On the deployed Brain:** dispatch `decision-report.yml`, which runs
  `scripts/decision-report.sh` inside the container. It is read-only. For a sprint
  whose objective has not been adopted yet, it composes the brief transiently and
  writes nothing.

## What it does not do

- It performs no external action. A commercial action is prepared, never sent.
- It creates no grant.
- It spends nothing beyond what an existing grant already allows.
- It invents no probability, margin or price. Economics are shown with their kind —
  sourced, measured, estimate, decided or unknown — and a margin is withheld when
  either half is unknown.
