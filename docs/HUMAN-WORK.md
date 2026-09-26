# Getting work done through people

§41's labor kernel decides **whether** a person is needed for a task and which of
six reasons makes it so. Until this, nothing came after that decision: no row said
which person, on what terms, with whose authorization, what they were told, what
they handed back, or whether it met the need. `server/services/humanwork/`,
`server/repos/humanWork.ts` and migrations `094_human_work.sql` /
pg `085_human_work.sql` are that half.

## The five steps, and the row each one is

| Step | What it is | Where it lives | Who acts |
|---|---|---|---|
| 1. A person is necessary | the exact work, why a person, what Brain prepares first, the acceptance standard | `human_work_orders` — refused unless the task's **live labor allocation** names a human layer and a reason | project ADMIN |
| 2. Find and qualify | who could do it and the evidence for believing so | `human_work_candidates` — `TEAM_MEMBER` (a real account), `EXISTING_RELATIONSHIP` (attested by a person), `RESEARCHED` (a gated claim with a source) | coordinator (WRITE) |
| 3. Prepare engagement | scope, deliverables, schedule, compensation and its basis, access, confidentiality, ownership | `human_work_engagements` (`PROPOSED`) + a **Needs You** card | coordinator prepares; project ADMIN decides |
| 4. Coordinate delivery | the ask reaching them, their acceptance, updates, questions, changes, handoffs, access granted | `human_work_events` (append-only), engagement `INVITED` → `ENGAGED` | assignee, coordinator |
| 5. Verify and close | each acceptance condition judged against the actual deliverable; repair; acceptance; money and time | `human_work_deliverables`, `human_work_reviews`, `human_work_costs` | reviewer ≠ assignee; project ADMIN accepts (Brain only for no-charge, fully row-read results) |

## Rules that are in the schema rather than in a sentence

- **A researched possibility is not a person who agreed.** A candidate row holds no
  agreement. `ENGAGED` is written only by the worker accepting in Brain
  (`ACCEPTED_IN_BRAIN`) or by a coordinator attesting it with the evidence named
  (`ATTESTED_BY_COORDINATOR`) — two values, never folded together. A team member
  accepts on their own page; nobody can attest for them.
- **An unanswered invitation is not an engagement.** Every engagement move is a
  compare-and-swap naming the state it comes from. Nothing can be reported on,
  handed in or paid for before `ENGAGED`.
- **An assigned task is not a delivered result.** A result is accepted only when
  every condition reads MET *now*:
  - `ACCOUNT_FOUNDATION` — a dimension of `foundationReading()` (the one People
    renders) reads PASS, re-read on every evaluation;
  - `DOCUMENT_READY` — the latest deliverable is a registered document Brain
    actually read (§9);
  - `PERSON_REVIEW` — judged MET on the **latest** round by somebody other than
    the assignee. A `NOT_MET` must name the repair; a repair is a new round.
- **A claimed skill is not proof.** `CLAIMED_BY_CANDIDATE` is recorded and never
  counted in `qualification.evidenced`.
- **No commitment without a person's decision on the concrete terms.** The card
  says who, what, the cost and its basis, the access, confidentiality and
  ownership — and what approving does *not* do (send anything outside Brain,
  grant access, pay anybody). `resolveEngagementDecision` re-reads the answerer's
  authority from rows and puts the card back unless they administer the project.
- **Money is bounded twice.** No charge → `NO_CHARGE`. A standing commercial
  authority that covers `ENGAGE_CONTRACTOR` is never bypassed: the approval holds
  the amount under it (`commitSpend`) or is not carried out. Otherwise the
  approver's decision on that exact amount is the ceiling (`DIRECT_APPROVAL`).
  A payment needs a reference and cannot exceed what was approved; outstanding is
  derived (agreed or incurred, less paid) and survives acceptance and
  cancellation.
- **History is never overwritten.** Events, deliverables, reviews and costs are
  append-only; the repository has no `DELETE` and no `UPDATE` of them, asserted by
  reading the file.

## Keeping people and projects apart

The assignee is given **no project membership**. `/api/assignments` is decided by
one comparison — the engagement's `assignee_user_id` against the authenticated
principal — and returns a brief built field by field from the order and terms:
the work, why them, scope, deliverables, schedule, compensation, access,
confidentiality, ownership, the order's `shared_context` and the acceptance
conditions. Nothing else from the project is in it. An assignment that is not
yours is the same 404, byte for byte, as one that does not exist. Access is
recorded by the coordinator as it is granted (`ACCESS_GRANTED`); Brain grants
nothing (`ACCESS_EXPANSION` is on the list no grant carries).

## What Brain can and cannot do to reach somebody

Brain holds exactly **one** channel to a person: an assignment on a team member's
own Home page. It holds no email, messaging or marketplace integration. So for
anybody outside the team, Brain composes the exact message (`invitationDraft`)
and a person sends it and records the channel and reference; the view names the
missing channel as a blocker rather than pretending. A team member who cannot
sign in is reported as a blocker naming the People control that fixes it.

## Reliability feeds the next staffing decision

`qualify()` reads every earlier engagement with the same person (by account, by
claim, or by name for an attested relationship): completed, accepted first time,
on time against the last scheduled date, declined, cancelled, paid. Derived,
never stored, and shown beside the candidate the next time.

## Russell

`humanWorkView()` produces one headline per open order — *who is doing what, what
it costs, whether the result meets the need* — and Russell's project briefing
carries them as `peopleWorking`. A result waiting to be accepted and a way in a
team member needs are counted as decisions in `needsYou`; the engagement card
itself is already a Needs You request.

## Surfaces

- `/labor` — "Work done by people": each order's headline, agreement, next action
  and who owes it, blockers, conditions with how each was judged, money, the
  message to send, candidates with reliability, and **Accept the result**.
- Home — "Your assignments", above every early return: accept or decline, report
  progress, ask a question, hand in.
- `npm run humanwork -- show` and `.github/workflows/humanwork.yml`.
- `npm run humanwork -- connect-capacity --project … --member … --admin …` runs the
  reviewed `CONNECT_CLAUDE_CAPACITY` recipe.

Opening orders, adding candidates and preparing terms from a browser are the
routes under `/api/projects/:id/human-work/…`; the screen renders and acts on
existing work but does not yet have forms for those three.

## A member who cannot sign in

An assignment reaches a team member on their own Home page, so a member whose
`SIGN_IN` foundation dimension is `BLOCKED` cannot receive it. The order reports
that as a blocker for a Brain administrator, quoting the foundation's own
remedy. For an account holding a passkey and no PIN — the shape the PIN
migration left behind — that remedy is a recovery link from People & capacity;
redeeming it sets a PIN, the blocker clears on the next read, and the
assignment is there. Issuing and sending that link is a person's action.
