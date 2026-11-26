/**
 * A goal whose own words offer the requester's labour or assets may have
 * routes the requester performs personally, inside the hours its words state;
 * every other goal keeps §91's refusal of the owner's physical work
 * (integration owner, 2026-11-25; §105: a goal's constraint binds that goal).
 *
 *   - the predicate records the phrase that offers, never infers an offer from
 *     silence, and an explicit refusal wins over any offer;
 *   - the offering goal's owner-performed route is filed, and one over its
 *     stated hours is still refused;
 *   - a silent goal and a refusing goal in the same project refuse the same
 *     route as the owner's physical work;
 *   - the offering goal's route is not withheld as physical by the delivery
 *     reading or left out of its plan, and nothing about it reaches the
 *     project's other goals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, researchedFindings } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, discoveryAllowed } from '../server/services/cash/lifecycle.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { createOpportunity, getOpportunity, opportunitiesWithRecordPrefix, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { goalRoutePrefix, routeRecordId } from '../server/domain/routeOrigin.ts';
import { breaksOperatingModel, operatingFit, ownerLabourOffer } from '../server/domain/operatingModel.ts';
import { deliveryReading } from '../server/services/cash/answers.ts';
import { openingOwnerLabour } from '../server/services/goals/ownerLabour.ts';
import { readGoalPlan } from '../server/services/goals/plan.ts';
import { proposeGoalRoutes, ROUTE_EVENT, settleRouteAsks, type RouteDeps } from '../server/services/goals/routeProposal.ts';
import type { ChatFn } from '../server/services/cheap/modelBench.ts';

describe('whether a goal offers the requester\'s labour', () => {
  it('records the offering phrase, reads silence as no offer, and lets a refusal win', () => {
    for (const [text, evidence] of [
      ['Need $800 by Christmas. My weekends are free.', /weekends are free/i],
      ["I've got a pickup truck and want $1,000 this month.", /got a pickup truck/i],
      ["I'm a photographer with my own gear and can shoot events.", /photographer/i],
      ['I can give it 20 hours a week.', /give it 20 hours/i],
    ] as const) {
      const read = ownerLabourOffer(text);
      expect(read.offered, text).toBe(true);
      if (read.offered) expect(read.evidence).toMatch(evidence);
    }
    expect(ownerLabourOffer('Collect $3,000 within 30 days using at most $500.')).toEqual({ offered: false, refused: null });
    expect(ownerLabourOffer('I can put in $200.')).toEqual({ offered: false, refused: null });
    const refused = ownerLabourOffer("I've got a van, but I'm not doing any of the work.");
    expect(refused.offered).toBe(false);
    if (!refused.offered) expect(refused.refused).toMatch(/not doing any of the work/);
    // The resources the intake kept verbatim count as the goal's own words.
    expect(ownerLabourOffer('Make $1,500 in three weeks.', 'a cargo van, weekends free').offered).toBe(true);

    const fit = operatingFit({ title: 'Weekend junk removal', offerScope: 'junk removal with my truck', fulfillmentOwner: 'The owner, personally' });
    expect(fit.kind).toBe('OWNER_PHYSICAL');
    expect(breaksOperatingModel(fit)).toBe(true);
    expect(breaksOperatingModel(fit, ownerLabourOffer('My weekends are free.'))).toBe(false);
    expect(breaksOperatingModel(fit, ownerLabourOffer("My weekends are free but I won't do any physical work."))).toBe(true);
  });
});

const OFFERING = "I've got a pickup truck and I can give it 10 hours a week. I'd like $1,200 within 30 days and can put in $100.";
const SILENT = "I'd like $1,200 within 30 days and can put in $100.";
const REFUSING = "I've got a pickup truck, but I'm not doing any of the work. I'd like $1,200 within 30 days and can put in $100.";

const haul = {
  title: 'Weekend junk removal with the pickup', buyerKind: 'LOCAL_CONSUMER', mechanism: 'PRODUCTIZED_SERVICE', industry: 'Home services', payer: 'Households clearing garages',
  offer: 'Junk removal, one truckload', price: 150, monthly: false, channel: 'Neighbourhood groups and local listings', performer: 'OWNER', fulfiller: 'The owner, with the pickup',
  directCost: 30, capital: 0, ownerHoursPerDeal: 3, daysToFirstCash: 3, buyerCount: 5000, volumeBasis: 'households in the town', assumptions: 'Households pay on the day.',
  ownerFit: 'Uses the owner\'s pickup truck and free weekends', searches: { price: ['junk removal price'], demand: ['junk removal wanted'], volume: ['households'] },
};
/** One clear-out at 60 hours is more than 10 hours a week give over the 30 days. */
const tooLong = { ...haul, title: 'Full house clear-outs', payer: 'Estate executors', offer: 'A whole house cleared', price: 150, ownerHoursPerDeal: 60 };

let projectId = '';

/** A project of its own, with Cash Mode on, so each goal holds its own target. */
async function project(tag: string): Promise<{ projectId: string; ownerId: string }> {
  const fixture = await freshProject();
  const id = fixture.project.id;
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`labour-${tag}-${id.slice(-6)}`, id]);
  const owner = await createUser({ email: `labour-${tag}-${id.slice(-6)}@example.com`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId: id, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
  return { projectId: id, ownerId: owner.id };
}

async function goalWith(where: { projectId: string; ownerId: string }, objective: string): Promise<string> {
  const goal = await createGoal({ projectId: where.projectId, objective, actorRef: 'test', userId: where.ownerId });
  if (!goal.ok) throw new Error(`no goal: ${goal.reason}`);
  await settleRouteAsks();
  await getDb().run('DELETE FROM workstream_events WHERE kind = ?', [ROUTE_EVENT]);
  return goal.goal.id;
}

function stub(routes: unknown[]): RouteDeps {
  const chat: ChatFn = async () => ({ content: JSON.stringify({ routes }), toolCalls: [], ms: 1, completionTokens: 1, error: null });
  return { chats: async () => [{ label: 'stub', chat }], claims: researchedFindings, delivers: async () => [], startDives: async () => [] };
}

describe("a goal's offer of the requester's labour binds that goal only", () => {
  let home: { projectId: string; ownerId: string };
  beforeEach(async () => {
    home = await project('a');
    projectId = home.projectId;
  });

  it('files the owner-performed route for the offering goal within its hours, and refuses it for silent and refusing goals', async () => {
    const offering = await goalWith(home, OFFERING);
    const a = await proposeGoalRoutes({ goalId: offering, now: new Date() }, stub([haul, tooLong]));
    expect(a.kind).toBe('PROPOSED');
    if (a.kind !== 'PROPOSED') return;
    expect(a.filed).toHaveLength(1);
    expect(a.rejected.map((one) => [one.title, one.rule])).toEqual([['Full house clear-outs', 'HOURS']]);

    // The filed route is the offering goal's to perform: not withheld as physical, not left out of its plan.
    const [route] = await opportunitiesWithRecordPrefix(projectId, goalRoutePrefix(offering));
    expect(route).toBeDefined();
    expect((await openingOwnerLabour(route!))?.offered).toBe(true);
    const delivery = await deliveryReading(route!);
    expect(delivery.kind === 'WITHHOLD' ? delivery.bar : null).not.toBe('PHYSICAL');
    const reading = (await readGoalPlan({ goalId: offering, now: new Date(), evaluations: 50 }))!;
    expect(reading.excluded.filter((one) => one.opportunityId === route!.id && /physical work/.test(one.reason))).toEqual([]);

    // freshProject starts a clean database, so the other goals come after the offering goal's checks.
    for (const [tag, objective] of [['silent', SILENT], ['refusing', REFUSING]] as const) {
      const goalId = await goalWith(await project(tag), objective);
      const b = await proposeGoalRoutes({ goalId, now: new Date() }, stub([haul]));
      expect(b.kind, tag).toBe('PROPOSED');
      if (b.kind !== 'PROPOSED') continue;
      expect(b.filed, tag).toHaveLength(0);
      // A refusal of all work also reads as no owner hours, which refuses it first; either way the owner performs none of it.
      expect(b.rejected.map((one) => one.rule), tag).toEqual(tag === 'silent' ? ['PHYSICAL'] : [expect.stringMatching(/^(PHYSICAL|HOURS)$/)]);
    }
  }, 120_000);

  it("another goal in the same project keeps the refusal for the same work", async () => {
    await goalWith(home, OFFERING);
    // A second goal on the same project, saying nothing about the requester's work.
    const other = await createGoal({ projectId, objective: 'Keep our supplier list current this quarter.', actorRef: 'test', userId: home.ownerId });
    if (!other.ok) throw new Error(other.reason);
    const mode = await discoveryAllowed(projectId);
    if (!mode.mode) throw new Error('no cash mode');
    const created = await createOpportunity({
      projectId, cashModeId: mode.mode.id, ownerUserId: mode.mode.ownerUserId, title: haul.title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', industry: haul.industry,
      source: 'test', externalRecordId: routeRecordId(other.goal.id, 'haul'), requiredCapabilities: [],
    });
    await updateOpportunity(created.id, { offer_scope: haul.offer, fulfillment_owner: 'The owner, personally' });
    const opening = (await getOpportunity(created.id))!;
    expect((await openingOwnerLabour(opening))?.offered).toBe(false);
    const delivery = await deliveryReading(opening);
    expect(delivery).toMatchObject({ kind: 'WITHHOLD', bar: 'PHYSICAL' });
    expect(await openingOwnerLabour({ externalRecordId: null })).toBeNull();
  }, 120_000);
});
