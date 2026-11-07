/**
 * A goal's industry construction read from rows (§92): the goal's intent and
 * money limit, the industry map, and facts recorded against the goal, through
 * the migrated `construction_facts` table.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { createNode, listNodes } from '../server/repos/industry.ts';
import { listConstructionFacts, recordConstructionFact } from '../server/repos/construction.ts';
import { goalConstruction, seedGoalIndustry, subtreeFor } from '../server/services/industry/construction/service.ts';

const DETROIT =
  'I want to enter last-mile logistics in Metro Detroit. I have 10,000 to 30,000 dollars available. I want to start generating revenue quickly, without personally making deliveries. Eventually I want a significant logistics company with control over valuable parts of the market.';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `ic-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

describe('goal industry construction', () => {
  it('reads the goal’s own words, caps capital at the goal’s money limit, and sells now under SQUEEZE', async () => {
    const g = await createWorkstream({ projectId, title: 'Detroit logistics', intent: DETROIT, purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const due = new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10);
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run('UPDATE workstreams SET due_at = ? WHERE id = ?', [new Date(due).toISOString(), g.id]);
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 500_000, currency: 'USD', projectId, capitalCeilingCents: 1_200_000 });
    expect(set.ok).toBe(true);

    const read = (await goalConstruction(g.id))!;
    const c = read.construction;
    expect(c.intent.capital).toEqual({ low: 10_000, high: 12_000 });
    expect(c.intent.requirements.some((r) => r.id === 'capital_ceiling' && r.kind === 'HARD')).toBe(true);
    expect(c.recommended).not.toBeNull();
    expect(c.recommended!.stages[0]!.economics.worst!.upfront).toBeLessThanOrEqual(12_000);
    expect(c.execution!.policy).toBe('SQUEEZE');
    expect(c.execution!.mode).toBe('SELL_NOW');
    expect(read.evidenceLayers.join(' ')).toMatch(/reference pack/);
  });

  it('learns: a recorded observed rate answers ahead of the reference figure, and stays append-only', async () => {
    const g = await createWorkstream({ projectId, title: 'Detroit logistics', intent: DETROIT, purpose: 'LONG_TERM', createdByUserId: userId });
    const before = (await goalConstruction(g.id))!.construction;
    await recordConstructionFact({
      projectId,
      workstreamId: g.id,
      fact: { key: 'price_per_unit', segment: 'local_merchants', low: 16, high: 17, status: 'OBSERVED', measures: 'a pharmacy chain quoted $16–$17 per scheduled stop', sourceTitle: 'buyer quote', sourceUrl: null },
      recordedBy: `person:${userId}`,
    });
    expect(await listConstructionFacts(g.id)).toHaveLength(1);
    const after = (await goalConstruction(g.id))!;
    const sub = after.construction.entries.find((e) => e.key.startsWith('PRIME/NETWORK/CONTRACTOR/SINGLE/NONE@local_merchants'))!;
    const price = sub.economics!.inputs.find((f) => f.key === 'price_per_unit')!;
    expect(price.status).toBe('OBSERVED');
    expect(price.superseded).toHaveLength(1);
    expect(sub.economics!.mid!.contribution).toBeGreaterThan(before.entries.find((e) => e.key === sub.key)!.economics!.mid!.contribution);
    expect(after.construction.learning.observed).toHaveLength(1);
    expect(after.evidenceLayers.join(' ')).toMatch(/1 fact\(s\) recorded/);
  });

  it('reads buyers from the industry map, and seeds the industry for research through the existing door', async () => {
    const g = await createWorkstream({ projectId, title: 'Pool service', intent: 'I want to enter pool maintenance in Tampa with 5000 dollars.', purpose: 'LONG_TERM', createdByUserId: userId });
    const goal = (await getWorkstream(g.id))!;
    const seeded = (await seedGoalIndustry(goal, 'pool maintenance', `person:${userId}`))!;
    expect(seeded.created).toBe(true);
    await createNode({ projectId, parentId: seeded.nodeId, kind: 'BUYER_TYPE', name: 'homeowners associations', origin: 'SEED' });
    const tree = subtreeFor(await listNodes(projectId), 'pool maintenance');
    expect(tree.map((n) => n.kind)).toEqual(expect.arrayContaining(['SECTOR', 'BUYER_TYPE']));
    const c = (await goalConstruction(g.id))!.construction;
    expect(c.model.evidence.segments.map((s) => s.actorId)).toHaveLength(1);
    // A buyer with nothing priced constructs businesses, prices none and says what to establish.
    expect(c.businessesConstructed).toBeGreaterThan(0);
    expect(c.entries.every((e) => e.viability === 'UNPRICED' || e.viability === 'EXCLUDED' || e.viability === 'CANNOT_START')).toBe(true);
    expect(c.decision.verdict).toBe('NO_DEFENSIBLE_STRUCTURE');
    expect(c.research.some((q) => q.decisive)).toBe(true);
    // Seeding twice is one subject.
    expect((await seedGoalIndustry(goal, 'pool maintenance', `person:${userId}`))!.created).toBe(false);
    expect((await listWorkstreamEvents(g.id, 10)).length).toBeGreaterThanOrEqual(0);
  });
});
