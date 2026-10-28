/**
 * Research the path to the money for the openings a goal's plan rests on.
 *
 * A plan is only as good as the facts under each opening, and most of them
 * start unknown: how long until money is actually in the account, what it
 * costs, what has to go out first, what buyers really pay. The scenario engine
 * sweeps an unknown; it never learns it. So for the openings closest to being
 * a realistic plan — judged on every opening Brain holds, not only the few the
 * simulation fits — each missing fact that published sources can settle
 * becomes one narrow research need through the ordinary path: `raiseNeed`, the
 * same question key the engine-gap pass uses, `startDependentWork` turning it
 * into an idea, and the standing research grant deciding whether it runs. The
 * answer lands on the card through the evidence gate and the next plan reading
 * uses it.
 *
 * It asks for the path rather than a number: each step between first contact
 * and money in the account, who decides it, how long it takes and the payment
 * terms — because that is what turns "3 to 60 days" into a fact.
 *
 * What research cannot settle is not asked here: whether buyers will say yes
 * is a test, and reaching them is a permission.
 */
import { getOpportunity, listNeeds } from '../../repos/cashPortfolio.ts';
import { raiseNeed } from '../cash/needs.ts';
import { questionKey } from '../cash/conditions.ts';
import { diveOwnsItsQuestions } from '../cash/operate.ts';
import { parseBlockerKey } from '../../domain/types.ts';
import type { ChainLink, PlanReading } from './plan.ts';

/** At most this many openings per goal get path research at once. */
export const PATH_RESEARCH_OPENINGS = 4;
/** And at most this many path questions open per goal at once. */
export const MAX_OPEN_PATH_QUESTIONS = 8;

const FIELDS_FOR: Partial<Record<ChainLink, { field: string; ask: string }[]>> = {
  SETTLES_IN_TIME: [
    {
      field: 'timeToFirstCash',
      ask:
        'Lay out the path from first contact to money actually in the seller’s account: each step, who decides it, ' +
        'how long each takes, and the published payment or payout terms — then state the days from start to usable cash.',
    },
  ],
  ECONOMICS: [
    { field: 'directCosts', ask: 'Find the published costs of delivering one sale: tools, materials, fees, subcontracted work, shipping.' },
    { field: 'requiredCapital', ask: 'State the most money that goes out before any comes back for one sale, and when it goes out.' },
  ],
  OFFER_AND_PRICE: [
    { field: 'revenueRange', ask: 'Find what buyers are published as actually paying for this — a figure or a range, each with its source and date.' },
  ],
};

export async function researchGoalPaths(input: { reading: PlanReading; projectId: string }): Promise<string[]> {
  const raised: string[] = [];
  const considered = input.reading.considered;
  const ids = new Set(considered.map((one) => one.opportunityId));
  const open = await listNeeds({ projectId: input.projectId, states: ['OPEN'] });
  const keys = new Set(open.map((one) => one.requestKey).filter((one): one is string => !!one));
  let openHere = open.filter((one) => one.opportunityId && ids.has(one.opportunityId) && one.requestKey?.startsWith('question:')).length;

  // Ways that pay in steps first; an award only when nothing else is left.
  const order = [...considered].sort((a, b) => Number(a.competitiveAward) - Number(b.competitiveAward));
  let openings = 0;
  for (const one of order) {
    if (openings >= PATH_RESEARCH_OPENINGS || openHere >= MAX_OPEN_PATH_QUESTIONS) break;
    const asks = one.missing.flatMap((link) => FIELDS_FOR[link] ?? []);
    if (asks.length === 0) continue;
    const opportunity = await getOpportunity(one.opportunityId);
    if (!opportunity || diveOwnsItsQuestions(opportunity)) continue;
    openings += 1;
    for (const { field, ask } of asks) {
      if (openHere >= MAX_OPEN_PATH_QUESTIONS) break;
      const key = questionKey(opportunity.id, field);
      if (keys.has(key)) continue;
      const need = await raiseNeed({
        projectId: input.projectId,
        opportunityId: opportunity.id,
        actorRef: 'BRAIN',
        blockedAction: `The path to money for "${opportunity.title.slice(0, 120)}"`,
        whyItMatters:
          'A goal plan rests on this opening, and until this is established from sources its numbers are a sweep of guesses rather than a plan.',
        recommendedPath: ask,
        setupEffort: 'One bounded look.',
        nextStep: ask,
        completionCondition: `The ${field} is recorded on this card.`,
        blocksState: 'EXECUTING',
        requestKey: key,
        blockerKey: parseBlockerKey(`FIELD:${field}`),
      });
      if (!need.ok) continue;
      keys.add(key);
      openHere += 1;
      raised.push(need.value.id);
    }
  }
  return raised;
}
