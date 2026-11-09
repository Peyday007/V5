/**
 * CAPABILITY:GOAL_PLAN.EVIDENCE.BUYER_PRICE: an opening with no payer, an
 * undated signal and an unsourced price used to raise no question, because
 * those chain links had no field to ask about. Each now raises one narrow
 * question through the ordinary path, inside the existing caps.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { getDb } from '../server/db/database.ts';
import { researchGoalPaths, MAX_OPEN_PATH_QUESTIONS, PATH_RESEARCH_OPENINGS } from '../server/services/goals/pathResearch.ts';
import type { PlanReading } from '../server/services/goals/plan.ts';

describe('buyer, demand and price questions', () => {
  it('raises one question per missing fact, within the caps', async () => {
    const { project } = await freshProject();
    const projectId = project.id;
    const owner = await createUser({ email: `bp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect cash.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(projectId))!.id;
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: owner.id, title: 'Unpriced opening', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
      sourceClaimId: 'clm_bp1', opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
    });
    const reading = {
      target: { remainingCents: 100_000 },
      considered: [{
        opportunityId: o.id, title: o.title, missing: ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE'],
        supportedReach: 1000, potentialReach: 1000, competitiveAward: false, volumeEstablished: true, paysOnce: false,
      }],
    } as unknown as PlanReading;

    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading, projectId, now: new Date(), trace });
    const text = trace.join('\n');
    expect(text).toMatch(/payer: asked/);
    expect(text).toMatch(/buyingEvidence: asked/);
    expect(text).toMatch(/revenueRange: asked/);
    expect(raised).toHaveLength(3);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => raised.includes(n.id));
    expect(needs.some((n) => /observed/.test(n.nextStep ?? ''))).toBe(true);
    expect(raised.length).toBeLessThanOrEqual(MAX_OPEN_PATH_QUESTIONS);
    expect(PATH_RESEARCH_OPENINGS).toBe(4);

    // Asked once: a second pass raises nothing new while the questions live.
    expect(await researchGoalPaths({ reading, projectId, now: new Date() })).toHaveLength(0);
  });
  it('asks how to reach the buyer when the payer is known and the channel is not', async () => {
    const { project } = await freshProject();
    const projectId = project.id;
    const owner = await createUser({ email: `bp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect cash.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(projectId))!.id;
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: owner.id, title: 'Payer known, no channel', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
      sourceClaimId: 'clm_bp2', opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
    });
    await getDb().run('UPDATE cash_opportunities SET payer = ? WHERE id = ?', ['Regional property managers', o.id]);
    const reading = {
      target: { remainingCents: 100_000 },
      considered: [{
        opportunityId: o.id, title: o.title, missing: ['REACHABLE_BUYER'],
        supportedReach: 1000, potentialReach: 1000, competitiveAward: false, volumeEstablished: true, paysOnce: false,
      }],
    } as unknown as PlanReading;

    const trace: string[] = [];
    const raised = await researchGoalPaths({ reading, projectId, now: new Date(), trace });
    const text = trace.join('\n');
    expect(text).toMatch(/access: asked/);
    expect(text).not.toMatch(/payer: asked/);
    expect(raised).toHaveLength(1);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((n) => raised.includes(n.id));
    expect(needs.some((n) => /channel/.test(n.nextStep ?? ''))).toBe(true);
  });
});
