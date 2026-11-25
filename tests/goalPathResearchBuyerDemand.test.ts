/**
 * CAPABILITY:GOAL_PLAN.EVIDENCE.BUYER_PRICE — "no payer", "undated signal", "price a guess".
 *
 * Production read 0 of 56 considered openings with a reachable buyer, current
 * demand and a supported price. `researchGoalPaths` turned an opening's missing
 * links into questions through a table with no entry for REACHABLE_BUYER or
 * CURRENT_DEMAND, so outside a deep dive nothing ever asked who pays, how they
 * are reached, or for a dated sign of demand; and an opening below the
 * materiality floor was asked its price alone, with no payer to read it against.
 *
 * These drive the real pass over real opening rows and assert the needs it raises.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { researchGoalPaths, MAX_OPEN_PATH_QUESTIONS } from '../server/services/goals/pathResearch.ts';
import type { ChainLink, ConsideredOpening, PlanReading } from '../server/services/goals/plan.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `buyer-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function opening(title: string): Promise<string> {
  const o = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'PRODUCTIZED_SERVICE',
    currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
    opportunitySignal: 'RECURRING_OUTSOURCED_WORK',
  });
  return o.id;
}

function considered(id: string, missing: ChainLink[], supportedReach: number): ConsideredOpening {
  return {
    opportunityId: id,
    title: `Opening ${id}`,
    modelled: true,
    missing,
    supportedReach,
    potentialReach: supportedReach,
    competitiveAward: false,
    volumeEstablished: true,
    paysOnce: false,
    stage: 'A_THEORETICAL',
  };
}

/** The smallest reading the pass reads: a target, the considered openings, nothing else ranked. */
function reading(openings: ConsideredOpening[], remainingCents = 1_000_000): PlanReading {
  return { considered: openings, target: { remainingCents }, researchPriority: [], sales: [], executionPolicy: 'BUILD' } as unknown as PlanReading;
}

async function askedOn(id: string): Promise<string[]> {
  return (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.opportunityId === id).map((one) => one.requestKey ?? '');
}

describe('EVIDENCE.BUYER_PRICE: path research asks for the buyer and the demand a plan is judged on', () => {
  it('reproduces the failure: an opening missing REACHABLE_BUYER and CURRENT_DEMAND is asked who pays, how they are reached and for a dated signal', async () => {
    const id = await opening('Monthly owner reports');
    // Large enough to be worth every question: the gap is 10 000, this could bring all of it.
    await researchGoalPaths({ reading: reading([considered(id, ['REACHABLE_BUYER', 'CURRENT_DEMAND'], 10_000)]), projectId, now, dryRun: false });
    const asked = await askedOn(id);
    // Before the change none of these was ever raised: the table had no entry for either link.
    expect(asked).toContain(`question:${id}:payer`);
    expect(asked).toContain(`question:${id}:access`);
    expect(asked).toContain(`question:${id}:buyingEvidence`);
    const signal = (await listNeeds({ projectId, states: ['OPEN'] })).find((one) => one.requestKey === `question:${id}:buyingEvidence`)!;
    // The date asked for is the request's own, never a page's modification date.
    expect(signal.nextStep).toMatch(/date it was published/);
    expect(signal.nextStep).toMatch(/never when the page was last modified/);
  });

  it('below the floor, who pays is asked beside what they pay — never the price alone', async () => {
    const id = await opening('A small report');
    // No price on the card (potential reach unknown) and supported reach 0 of a 10 000 gap: the pass narrows to the
    // price question, and now keeps the payer beside it.
    await researchGoalPaths({ reading: reading([{ ...considered(id, ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE'], 0), potentialReach: null }]), projectId, now, dryRun: false });
    const asked = await askedOn(id);
    expect(asked).toContain(`question:${id}:revenueRange`);
    expect(asked).toContain(`question:${id}:payer`);
    // Still narrow: the rest waits until the price says it is worth asking.
    expect(asked).not.toContain(`question:${id}:buyingEvidence`);
    expect(asked).not.toContain(`question:${id}:access`);
  });

  it('does not ask again what a source already established, and the question cap still bounds the pass', async () => {
    const known = await opening('Already evidenced');
    for (const [field, value] of [
      ['payer', 'Property managers'],
      ['access', 'The state directory of licensed property managers'],
      ['buyingEvidence', 'Posted asking for a monthly owner report'],
    ] as const) {
      await recordCardFact({ projectId, opportunityId: known, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${known}`, decidedBy: 'BRAIN' });
    }
    const others = [] as string[];
    for (let i = 0; i < 6; i += 1) others.push(await opening(`Other opening ${i}`));
    await researchGoalPaths({
      reading: reading([considered(known, ['REACHABLE_BUYER', 'CURRENT_DEMAND'], 10_000), ...others.map((id) => considered(id, ['REACHABLE_BUYER', 'CURRENT_DEMAND'], 10_000))]),
      projectId,
      now,
      dryRun: false,
    });
    expect(await askedOn(known)).toEqual([]);
    const all = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.requestKey?.startsWith('question:'));
    expect(all.length).toBeLessThanOrEqual(MAX_OPEN_PATH_QUESTIONS);
    expect(all.length).toBeGreaterThan(0);
  });
});
