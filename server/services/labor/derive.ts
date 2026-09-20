/**
 * Where workflows and tasks come from when nobody types them in.
 *
 * ---------------------------------------------------------------------------
 * Two origins, and there is deliberately no third
 * ---------------------------------------------------------------------------
 *
 * `SEED` is a person naming a workflow. §2 of the brief is a design act — *if
 * this business were invented today with Brain available from its first day,
 * how would it operate* — and no amount of reading rows answers it. A Brain
 * that decomposed a business out of a sentence somebody wrote would be §8's
 * model prose deciding what exists, at the table that decides who gets paid.
 *
 * `DERIVED` is this module, and it reads exactly one thing: an opening's own
 * `required_capabilities`. That column already says what delivering this
 * opening needs, `readCapability` already answers whether Brain has each one,
 * and `operate.ts` already raises a need from it — so each entry is a unit of
 * production that has been declared rather than inferred. Nothing here parses
 * a delivery method, splits a sentence or invents a step.
 *
 * ---------------------------------------------------------------------------
 * Why that is enough to make the kernel live
 * ---------------------------------------------------------------------------
 *
 * §29 records the same lesson four times over: a mechanism nothing calls is
 * not a mechanism. A labor kernel that waited for somebody to type in a
 * workflow would have been exactly that — correct, tested, and reachable by
 * nobody, for as long as it took anybody to notice. Deriving from the
 * portfolio that already exists means it has something to say on the first
 * tick after it is deployed, against openings nobody had to revisit.
 *
 * ---------------------------------------------------------------------------
 * It never un-derives
 * ---------------------------------------------------------------------------
 *
 * A capability removed from an opening leaves its task exactly where it is,
 * with every allocation decision and necessity answer ever recorded against
 * it. Retiring is a person's, through `retireTask`. §5 at a derivation: the
 * tick that created a row is not entitled to destroy the decisions somebody
 * made about it.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { createTask, createWorkflow } from '../../repos/labor.ts';
import { CAPABILITIES } from '../cash/capabilities.ts';
import type { CashOpportunity, CashOpportunityState, LaborTask, LaborWorkflow } from '../../domain/types.ts';

/**
 * The states whose delivery is worth decomposing.
 *
 * `DISCOVERED` is absent: an opening nobody has qualified has no established
 * payer, so there is nothing yet for a workflow to deliver and deriving one
 * would fill the map with production plans for work that will mostly be
 * declined. `DECLINED` and `ARCHIVED` are absent for the obvious reason, and
 * `COLLECTED` is present because a delivered opening is exactly the one whose
 * human remainder is worth measuring afterwards.
 */
const DELIVERABLE: readonly CashOpportunityState[] = Object.freeze([
  'EVIDENCE_CARD',
  'READY',
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
]);

const BY_CAPABILITY = new Map(CAPABILITIES.map((one) => [one.id, one]));

export interface Derived {
  workflows: LaborWorkflow[];
  tasks: LaborTask[];
  /** Capabilities named by an opening that Brain has no word for. */
  unrecognized: { opportunityId: string; capabilityId: string }[];
  /**
   * Openings whose derived workflow name is already held by one somebody wrote.
   *
   * Reported rather than resolved, because the resolution is a person's: rename
   * one of them, or attach the opening to theirs. Nothing is written for such
   * an opening, so re-running produces the same report rather than accumulating.
   */
  collided: { opportunityId: string; workflowId: string; name: string }[];
}

export async function deriveFromPortfolio(projectId: string): Promise<Derived> {
  const out: Derived = { workflows: [], tasks: [], unrecognized: [], collided: [] };

  const opportunities = await listOpportunities({ projectId });
  for (const opportunity of opportunities) {
    if (!DELIVERABLE.includes(opportunity.state)) continue;
    if (opportunity.requiredCapabilities.length === 0) continue;

    const created = await createWorkflow({
      projectId,
      name: workflowNameFor(opportunity),
      description:
        `Everything that has to happen for this opening to be delivered and paid for: ` +
        `${opportunity.title}`,
      origin: 'DERIVED',
      opportunityId: opportunity.id,
    });
    if (created.created) out.workflows.push(created.workflow);

    /*
     * A name collision with a workflow somebody wrote is reported, not adopted.
     *
     * `labor_workflows` has two unique indexes over a derived row — the name
     * and the opening — and the insert can lose on the *name* one: a person
     * declared a workflow called this and it names no opening. Writing this
     * opening's tasks into theirs would be Brain deciding the two are the same
     * thing, which is exactly the confidently-derived wrong answer §25
     * records. The first version of this loop did that, having read the
     * fallback row as a success.
     */
    if (created.workflow.opportunityId !== opportunity.id) {
      out.collided.push({
        opportunityId: opportunity.id,
        workflowId: created.workflow.id,
        name: created.workflow.name,
      });
      continue;
    }

    /*
     * A retired workflow keeps its tasks and gains no new ones.
     *
     * Somebody decided this is no longer how the work is done, and a tick that
     * kept adding to it would be overruling them once per capability. The
     * workflow row stays, so the decision and everything under it is still
     * readable.
     */
    if (created.workflow.retiredAt !== null) continue;

    for (const capabilityId of opportunity.requiredCapabilities) {
      const definition = BY_CAPABILITY.get(capabilityId.trim());
      if (!definition) {
        /*
         * Reported, never filed. A task whose output Brain cannot state is a
         * task the necessity test cannot ask anything about — question 1 is
         * NOT NULL for exactly this reason — and composing an output from a
         * word nobody recognises would be inventing the thing being assessed.
         */
        out.unrecognized.push({ opportunityId: opportunity.id, capabilityId: capabilityId.trim() });
        continue;
      }
      const task = await createTask({
        projectId,
        workflowId: created.workflow.id,
        name: definition.id,
        // Question 1, answered from the capability's own declaration rather
        // than from anything about this particular opening — the output is a
        // property of the capability, and two openings needing it need the
        // same thing.
        output: definition.does,
        origin: 'DERIVED',
        capabilityId: definition.id,
      });
      if (task.created) out.tasks.push(task.task);
    }
  }

  return out;
}

/**
 * A stable name, so re-deriving finds the row rather than making a second one.
 *
 * Built from the opening's title rather than its id, because a person reading
 * the map should recognise what it is about — and the opening is on the row as
 * a foreign key anyway, which is what `createWorkflow` actually looks it up
 * by. A renamed opening therefore keeps its workflow and its whole history.
 */
export function workflowNameFor(opportunity: Pick<CashOpportunity, 'title'>): string {
  const title = opportunity.title.replace(/\s+/g, ' ').trim();
  const clipped = title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
  return `Delivering: ${clipped}`;
}
