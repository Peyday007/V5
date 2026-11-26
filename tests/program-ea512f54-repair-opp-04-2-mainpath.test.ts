/**
 * OPP-04 repair, episode 2, finding F2: a goal whose model priced one opening still reads its
 * other constructed designs as marked pathways.
 *
 * Before: the refused path read every in-scope partial arrangement, but the main path read them
 * only when the model had priced and considered nothing — so one modelled opening silently
 * dropped every other unpriced design from the goal's pathways, which S-0061 forbids ("an unknown
 * is not ... a reason to abandon a partial arrangement"). Both paths now read them, as PARTIAL
 * pathways kept apart from the priced CONSTRUCTED estimates the plan compares.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createNode } from '../server/repos/industry.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { MAX_PARTIAL_PATHWAYS } from '../server/services/goals/pathways.ts';
import { pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  userId = (await createUser({ email: `f2-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function sector(name: string, parts: { buyer: string; bottleneck: string; supply: string }): Promise<void> {
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: parts.buyer, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: parts.bottleneck, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: parts.supply, origin: 'SEED' });
}

async function heldOpening(payer: string) {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title: 'One small report', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'PAID_TASK_OR_CONTRACT', source: 'A publisher', requiredCapabilities: [],
  });
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, 'Sell the work to each buyer.');
  await fact('payer', payer);
  await fact('delivery', 'Brain produces it.');
  await updateOpportunity(o.id, { payer, price_cents: 20_000, offer_scope: 'One report', reachable_channel: 'Published emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-2), peak_funding_cents: 0, human_hours: 2 });
  await fact('price', '$200');
  await fact('timeToFirstCash', '7 days');
  await fact('directCosts', '$10');
  return o;
}

async function goal(amountCents: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

describe('F2: the main path keeps a goal\'s unpriced designs beside its modelled ones', () => {
  it('reads partial arrangements as marked PARTIAL pathways even when the model priced something', async () => {
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'After-hours phone coverage', supply: 'Remote answering services' });
    const held = await heldOpening('Independent veterinary clinics');
    const id = await goal(600_000);
    const reading = (await readGoalPlan({ goalId: id, evaluations: 1_000 }))!;
    expect(reading.refusal ?? null).toBeNull();
    const all = reading.pathways!.pathways;
    const modelled = all.filter((p) => p.origin !== 'PARTIAL');
    const partial = all.filter((p) => p.origin === 'PARTIAL');
    // The model priced something: the held opening is a pathway, so this is the main path.
    expect(modelled.some((p) => p.opportunityId === held.id)).toBe(true);
    // The finding: its other in-scope designs are kept, not dropped.
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThanOrEqual(MAX_PARTIAL_PATHWAYS);
    expect(reading.pathways!.measures.partial).toBe(partial.length);
    // Never duplicated, never favourable, never leading, and every input marked.
    const modelledIds = new Set(modelled.map((p) => p.opportunityId));
    expect(partial.every((p) => !modelledIds.has(p.opportunityId) && p.opportunityId.startsWith('arr_'))).toBe(true);
    expect(new Set(all.map((p) => p.opportunityId)).size).toBe(all.length);
    expect(partial.every((p) => !p.executable && p.contribution.p90 === 0 && p.gross.p90 === 0)).toBe(true);
    for (const p of partial) expect(reading.pathways!.portfolio.leading?.members ?? []).not.toContain(p.opportunityId);
    for (const p of all) expect(pathwayProblem(p)).toBeNull();
    // Each partial pathway names its cheapest next move.
    expect(partial.every((p) => p.moves.some((m) => m.action === 'RESEARCH' || m.action === 'CONSTRUCT'))).toBe(true);
    // The priced constructed estimates the plan compares are still exactly the priced arrangements.
    expect(all.filter((p) => p.origin === 'CONSTRUCTED').length).toBe(reading.portfolio!.demand.filter((d) => d.opportunityId.startsWith('arr_')).length);
  }, 180_000);
});
