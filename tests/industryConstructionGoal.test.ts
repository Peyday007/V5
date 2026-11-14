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
import { listConstructionFacts, listProjectConstructionFacts, recordConstructionFact } from '../server/repos/construction.ts';
import { goalConstruction, seedGoalIndustry, subtreeFor } from '../server/services/industry/construction/service.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { fileFinding } from '../server/services/industry/expand.ts';
import type { IndustryRound, ResearchClaim } from '../server/domain/types.ts';

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
    expect(c.execution!.mode).toBe('RESEARCH_BESIDE_SELLING');
    expect(c.execution!.researchBesideSale.length).toBeGreaterThan(0);
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

/* ------------------------------------------------- Surge B repairs (W-5, W-6, W-13) */

let claimSeq = 0;
function claim(fields: Partial<ResearchClaim>): ResearchClaim {
  claimSeq += 1;
  return {
    id: `rcl_sb_${Date.now().toString(36)}_${claimSeq}`,
    claim: 'a claim',
    claimType: 'SOURCED_FACT',
    sourceUrl: 'https://example.test/source',
    sourceTitle: 'trade association survey',
    sourcePublisher: 'Roofing Contractors Association',
    sourceDate: '2026-09-15',
    retrievedAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    primarySource: false,
    sourced: true,
    derived: false,
    accepted: true,
    structuralFinding: null,
    structuralSubject: null,
    structuralQualifier: null,
    structuralAmountCents: null,
    ...fields,
  } as ResearchClaim;
}

/** A node-creating finding names its claim by foreign key, so that claim is written as the research engine writes one. */
async function persistClaim(c: ResearchClaim): Promise<void> {
  const { getDb } = await import('../server/db/database.ts');
  const { createOrchestration } = await import('../server/repos/research.ts');
  const { createRun } = await import('../server/repos/runs.ts');
  const layer = await getDb().all<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [projectId]);
  const run = await createRun({ projectId, layerId: layer[0]!.id, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({ projectId, layerId: layer[0]!.id, runId: run.id, title: 'construction fixture', assignment: 'map the industry', provider: 'WORKER' });
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, ?, NULL, ?, NULL, NULL, 'lane-1',
             ?, 0.9, 'UNCHALLENGED', NULL, 'VALID', NULL, 1, 0, '[]', 1, ?, ?)`,
    [c.id, orchestration.id, c.claim, c.sourceUrl, c.sourceTitle, c.sourceDate, c.retrievedAt, `hash-${c.id}`, c.createdAt] as never[],
  );
}

function emptyOut(): Parameters<typeof fileFinding>[0]['out'] {
  return { nodes: [], constraints: [], capital: [], settled: [], refused: [], origins: [] };
}

describe('research reaches the economics (W-5, W-6, W-13)', () => {
  it('a gated claim that states an amount becomes a project-level fact, OBSERVED, with the claim as lineage, once', async () => {
    const root = (await seedSubject({ projectId, name: 'commercial roofing', actorRef: `person:${userId}` })).node;
    const round = { id: 'ird_x', nodeId: root.id, purpose: 'MAP', opportunityId: null } as IndustryRound;
    const byNodeId = new Map((await listNodes(projectId)).map((n) => [n.id, n]));
    const out = emptyOut();
    const sourced = claim({ claim: 'Commercial roof repairs average $4.50 per square foot', structuralFinding: 'UNIT_ECONOMIC', structuralSubject: 'price_per_unit', structuralAmountCents: 450 });
    expect(await fileFinding({ projectId, claim: sourced, round, byNodeId, out })).toBe(true);
    // Filed again on the next pass: one claim is one fact.
    expect(await fileFinding({ projectId, claim: sourced, round, byNodeId, out })).toBe(false);
    const inferred = claim({ claimType: 'INFERENCE', claim: 'margins probably near 20%', structuralFinding: 'UNIT_ECONOMIC', structuralSubject: 'broker_take_rate', structuralAmountCents: 20 });
    expect(await fileFinding({ projectId, claim: inferred, round, byNodeId, out })).toBe(true);
    const facts = await listProjectConstructionFacts(projectId);
    expect(facts).toHaveLength(2);
    const price = facts.find((f) => f.key === 'price_per_unit')!;
    expect(price).toMatchObject({ workstreamId: null, nodeId: root.id, sourceClaimId: sourced.id, status: 'OBSERVED', low: 4.5, high: 4.5 });
    expect(price.source.claimId).toBe(sourced.id);
    expect(price.observedAt).toBe('2026-09-15T00:00:00.000Z');
    expect(Date.parse(price.validUntil!)).toBeGreaterThan(Date.parse(price.observedAt!));
    // A hypothesis stays a hypothesis; nothing a machine files is VERIFIED.
    expect(facts.find((f) => f.key === 'broker_take_rate')!.status).toBe('ASSUMPTION');
    expect(facts.every((f) => f.status !== 'VERIFIED')).toBe(true);
    expect(out.origins.filter((o) => o.kind === 'FACT')).toHaveLength(2);
  });

  it('role findings write through the same path: terms become a fact, an unlisted role is kept, an unknown buyer waits', async () => {
    const root = (await seedSubject({ projectId, name: 'commercial roofing', actorRef: `person:${userId}` })).node;
    await createNode({ projectId, parentId: root.id, kind: 'BUYER_TYPE', name: 'property management companies', origin: 'SEED' });
    const round = { id: 'ird_x', nodeId: root.id, purpose: 'SCAN', opportunityId: null } as IndustryRound;
    const byNodeId = new Map((await listNodes(projectId)).map((n) => [n.id, n]));
    const buyer = [...byNodeId.values()].find((n) => n.kind === 'BUYER_TYPE')!;
    const out = emptyOut();
    expect(await fileFinding({ projectId, claim: claim({ structuralFinding: 'ROLE_TERMS', structuralSubject: 'broker_take_rate', structuralQualifier: 'broker_agent @ property management companies', structuralAmountCents: 12 }), round, byNodeId, out })).toBe(true);
    expect(await fileFinding({ projectId, claim: claim({ structuralFinding: 'ROLE_OCCUPANT', structuralSubject: 'RoofBid Exchange', structuralQualifier: 'reverse_auction_desk @ property management companies' }), round, byNodeId, out })).toBe(true);
    // A buyer-specific term about a buyer the map does not hold yet waits for it.
    expect(await fileFinding({ projectId, claim: claim({ structuralFinding: 'ROLE_TERMS', structuralSubject: 'financing_margin', structuralQualifier: 'transaction_financier @ hospitals', structuralAmountCents: 3 }), round, byNodeId, out })).toBe(false);
    expect(out.refused.at(-1)!.why).toMatch(/not a buyer type on the map yet/);
    const facts = await listProjectConstructionFacts(projectId);
    // A take rate is industry-wide by its key; the occupant is about the buyer that pays it.
    expect(facts.find((f) => f.key === 'broker_take_rate')).toMatchObject({ low: 0.12, roleId: 'broker_agent', segment: null });
    expect(facts.find((f) => f.key === 'role_occupants')).toMatchObject({ roleId: 'reverse_auction_desk', occupant: 'RoofBid Exchange', segment: `map_${buyer.id}` });
  });

  it('decomposes an unfamiliar industry from research alone: payer and supplier, and a financing position priced from claim-derived facts', async () => {
    const g = await createWorkstream({ projectId, title: 'Roofing', intent: 'I want to enter commercial roofing in Phoenix with 50000 dollars.', purpose: 'LONG_TERM', createdByUserId: userId });
    const goal = (await getWorkstream(g.id))!;
    const root = (await seedGoalIndustry(goal, 'commercial roofing', `person:${userId}`))!;
    const mapRound = { id: 'ird_map', nodeId: root.nodeId, purpose: 'MAP', opportunityId: null } as IndustryRound;
    let byNodeId = new Map((await listNodes(projectId)).map((n) => [n.id, n]));
    const out = emptyOut();
    // The breakdown: who pays, who supplies, and the transaction between them.
    for (const c of [
      claim({ structuralFinding: 'BUYER_TYPE', structuralSubject: 'property management companies', claim: 'property managers commission roof repairs for their portfolios' }),
      claim({ structuralFinding: 'FULFILMENT_SOURCE', structuralSubject: 'independent roofing crews', claim: 'licensed independent crews perform most repairs' }),
      claim({ structuralFinding: 'TRANSACTION_TYPE', structuralSubject: 'roof repair work order', structuralQualifier: 'property management companies -> independent roofing crews', claim: 'repairs are bought per work order, paid net 45' }),
    ]) {
      await persistClaim(c);
      expect(await fileFinding({ projectId, claim: c, round: mapRound, byNodeId, out })).toBe(true);
    }
    byNodeId = new Map((await listNodes(projectId)).map((n) => [n.id, n]));
    const tx = [...byNodeId.values()].find((n) => n.kind === 'TRANSACTION_TYPE')!;
    expect(tx).toMatchObject({ payer: 'property management companies', supplier: 'independent roofing crews' });
    // The unit economics research stated, in hundredths of each key's unit.
    const scan = { id: 'ird_scan', nodeId: root.nodeId, purpose: 'SCAN', opportunityId: null } as IndustryRound;
    const stated: [string, number, string | null][] = [
      ['price_per_unit', 1_200_000, null], // $12,000 per work order
      ['account_units_per_month', 200, null], // 2 work orders a month
      ['financing_margin', 4, 'property management companies'], // 4% per advance
      ['financing_term_days', 6_000, 'property management companies'], // 60 days
      ['default_rate', 1, null], // 1%
      ['capital_cost_rate', 10, null], // 10% a year
      ['account_win_rate', 10, null],
      ['outreach_cost_per_account', 5_000, null],
      ['sales_cycle_days', 3_000, null],
      ['overhead_per_month', 30_000, null],
    ];
    for (const [key, cents, buyer] of stated) {
      expect(await fileFinding({ projectId, claim: claim({ structuralFinding: 'UNIT_ECONOMIC', structuralSubject: key, structuralQualifier: buyer, structuralAmountCents: cents, claim: `${key} stated by the survey` }), round: scan, byNodeId, out })).toBe(true);
    }

    const read = (await goalConstruction(g.id, { now: new Date('2026-11-14T00:00:00Z') }))!;
    const c = read.construction;
    const buyer = [...byNodeId.values()].find((n) => n.kind === 'BUYER_TYPE')!;
    const crews = [...byNodeId.values()].find((n) => n.kind === 'FULFILMENT_SOURCE')!;
    // Who pays and who supplies, on the flow itself.
    const money = c.model.evidence.flows.find((f) => f.kind === 'MONEY' && f.source.kind === 'MAP')!;
    expect(money).toMatchObject({ from: `map_${buyer.id}`, to: `map_${crews.id}`, payer: 'property management companies', supplier: 'independent roofing crews' });
    expect(read.evidenceLayers.join(' ')).toMatch(/established by research on the map/);
    // A financing position, constructed for this buyer and priced from what research stated.
    const financing = c.entries.find((e) => e.key === `NONE/NETWORK/NONE/SINGLE/NONE/FINANCING@map_${buyer.id}`)!;
    expect(financing).toBeDefined();
    expect(financing.economics!.unpriced).toEqual([]);
    expect(financing.viability).not.toBe('UNPRICED');
    const margin = financing.economics!.inputs.find((f) => f.key === 'financing_margin')!;
    expect(margin.status).toBe('OBSERVED');
    expect(margin.segment).toBe(`map_${buyer.id}`);
    expect(margin.sources[0]!.claimId).toMatch(/^rcl_sb_/);
    // 2 orders × $12,000 × (4% − 1%) − capital cost on 60 days outstanding − overhead.
    const mid = financing.economics!.mid!;
    expect(mid.contribution).toBeCloseTo(24_000 * 0.03 - 48_000 * 0.1 / 12 - 300, 0);
    expect(mid.workingCapital).toBeCloseTo(48_000, 0);
    expect(financing.answers.whoPaysAndWhy).toMatch(/property management companies pays a financing margin/);

    // A price recorded against another industry's subtree is not this goal's.
    const other = (await seedSubject({ projectId, name: 'pool maintenance', actorRef: `person:${userId}` })).node;
    await fileFinding({ projectId, claim: claim({ structuralFinding: 'UNIT_ECONOMIC', structuralSubject: 'price_per_unit', structuralAmountCents: 9_900 }), round: { id: 'ird_pool', nodeId: other.id, purpose: 'SCAN', opportunityId: null } as IndustryRound, byNodeId, out });
    const again = (await goalConstruction(g.id, { now: new Date('2026-11-14T00:00:00Z') }))!.construction;
    const price = again.entries.find((e) => e.key === financing.key)!.economics!.inputs.find((f) => f.key === 'price_per_unit')!;
    expect([price.low, price.high]).toEqual([12_000, 12_000]);
    // Per-goal facts still answer beside research's, and are read first among equals by date.
    await recordConstructionFact({ projectId, workstreamId: g.id, fact: { key: 'financing_margin', segment: `map_${buyer.id}`, low: 0.05, high: 0.05, status: 'OBSERVED', measures: 'a manager accepted 5% for 60 days', sourceTitle: 'buyer quote', sourceUrl: null, observedAt: '2026-11-10T00:00:00.000Z' }, recordedBy: `person:${userId}` });
    const third = (await goalConstruction(g.id, { now: new Date('2026-11-14T00:00:00Z') }))!.construction;
    const newest = third.entries.find((e) => e.key === financing.key)!.economics!.inputs.find((f) => f.key === 'financing_margin')!;
    expect([newest.low, newest.high]).toEqual([0.05, 0.05]);
    expect(newest.superseded.map((f) => f.low)).toEqual([0.04]);
  });
});
