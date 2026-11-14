/**
 * Open-world construction (ARCH-01): roles no record represents are listed per
 * flow, constructed through the existing construction path and evaluated; the
 * evaluation moves with observed inputs; and the probe reader only reads.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createNode, listConstraintsForProject, listNodes } from '../server/repos/industry.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { recordConstructionFact } from '../server/repos/construction.ts';
import { assembleEvidence, evidenceFromMap } from '../server/services/industry/construction/service.ts';
import { lastMileDelivery } from '../server/services/industry/construction/references.ts';
import { constructBusinesses } from '../server/services/industry/construction/businesses.ts';
import { commercialRoles } from '../server/services/industry/construction/roles.ts';
import {
  OBSERVED_INPUTS,
  adaptation,
  adaptationToRecorded,
  observedInputOf,
  heldFromRows,
  MAX_OPEN_WORLD_LENSES,
  openWorld,
  openWorldForProject,
  openWorldHoldsOnRows,
  openWorldLenses,
  represented,
  withObserved,
  type ObservedInput,
} from '../server/services/industry/construction/openWorld.ts';
import { opportunityField } from '../server/services/industry/construction/origins.ts';

const NOTHING_HELD = { texts: [] };

describe('unrepresented roles, constructed and evaluated', () => {
  it('lists the unrepresented roles of every flow and constructs a business for each through the existing path', () => {
    const e = lastMileDelivery();
    const reading = openWorld(e, NOTHING_HELD);
    expect(reading.flows).toBe(e.flows.length);
    expect(reading.arrangements.length).toBeGreaterThan(0);
    const businessKeys = new Set(constructBusinesses(e).map((b) => b.key));
    const roleIds = new Set(commercialRoles(e).flatMap((s) => s.roles.map((r) => r.roleId)));
    for (const a of reading.arrangements) {
      expect(businessKeys.has(a.business.key)).toBe(true);
      expect(roleIds.has(a.roleId)).toBe(true);
      expect(['VIABLE', 'CONDITIONAL', 'NOT_VIABLE', 'UNPRICED']).toContain(a.viability);
      expect(typeof a.rank).toBe('number');
    }
    // More than one kind of role is constructed: not a single play.
    expect(new Set(reading.arrangements.map((a) => a.roleId)).size).toBeGreaterThan(2);
  });

  it('produces and scores an arrangement no record row represents, and leaves out what rows already hold', () => {
    const e = lastMileDelivery();
    const open = openWorld(e, NOTHING_HELD);
    const broker = open.arrangements.find((a) => a.roleId === 'broker_agent');
    expect(broker).toBeDefined();
    expect(broker!.midContribution === null || Number.isFinite(broker!.midContribution)).toBe(true);

    const held = heldFromRows([{ name: 'Freight broker network', description: null, retiredAt: null }], [{ title: 'Reseller of courier capacity', industry: null }]);
    const reading = openWorld(e, held);
    expect(reading.representedRoles.length).toBeGreaterThan(0);
    expect(reading.arrangements.some((a) => a.roleId === 'broker_agent')).toBe(false);
    expect(reading.arrangements.length).toBeLessThan(open.arrangements.length);
    // Something nobody holds is still constructed.
    expect(reading.arrangements.length).toBeGreaterThan(0);
  });

  it('a retired record does not count as held', () => {
    const role = commercialRoles(lastMileDelivery()).flatMap((s) => s.roles).find((r) => r.roleId === 'broker_agent')!;
    expect(represented(role, heldFromRows([{ name: 'broker', description: null, retiredAt: '2026-01-01T00:00:00Z' }], []))).toBe(false);
    expect(represented(role, heldFromRows([{ name: 'broker', description: null, retiredAt: null }], []))).toBe(true);
  });

  it('carries the field seeds that touch the industry', () => {
    const e = lastMileDelivery();
    const seeds = opportunityField({ nodes: [{ id: 'n1', kind: 'SECTOR', name: e.industry, description: null, retiredAt: null }], opportunities: [], goals: [], constraints: [] });
    const reading = openWorld(e, NOTHING_HELD, seeds);
    expect(reading.arrangements[0]!.seeds.map((s) => s.origin)).toContain('MEMORY');
  });
});

describe('adaptation to observed inputs', () => {
  const e = lastMileDelivery();
  const base = openWorld(e, NOTHING_HELD);
  const changes: [ObservedInput, { factor: number }][] = [
    ['PRICE', { factor: 0.5 }],
    ['DEMAND', { factor: 0.5 }],
    ['CAPACITY', { factor: 0.5 }],
    ['FINANCING', { factor: 3 }],
    ['CASH', { factor: 3 }],
  ];
  for (const [input, change] of changes) {
    it(`re-evaluates when an observed ${input.toLowerCase()} figure changes`, () => {
      const after = openWorld(withObserved(e, input, change), NOTHING_HELD);
      expect(adaptation(base, after).changed).toBe(true);
    });
  }

  it('an unchanged input changes nothing, and an absent figure is never invented', () => {
    expect(adaptation(base, openWorld(withObserved(e, 'PRICE', { factor: 1 }), NOTHING_HELD)).changed).toBe(false);
    const bare = { ...e, facts: e.facts.filter((f) => !(OBSERVED_INPUTS.PRICE as readonly string[]).includes(f.key)) };
    expect(withObserved(bare, 'PRICE', { factor: 2 }).facts.length).toBe(bare.facts.length);
  });
});

describe('no new mechanism', () => {
  it('reads through existing repositories and writes nothing', () => {
    const source = readFileSync('server/services/industry/construction/openWorld.ts', 'utf8');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s/);
    expect(source).not.toMatch(/createNode|createOpportunity|recordConstraint|setInterval|setTimeout/);
  });
});

describe('adaptation to recorded rows', () => {
  const e = lastMileDelivery();
  const map = { actors: e.actors, segments: e.segments, flows: e.flows, chokepoints: e.chokepoints, adjacencies: e.adjacencies, gates: e.gates, failures: e.failures, provenance: [] };
  const fact = (key: 'price_per_unit' | 'buyer_payment_days', low: number, high: number) => ({ key, segment: null, low, high, status: 'OBSERVED' as const, measures: key, source: { title: 'buyer quote', url: null, kind: 'OUTCOME' as const } });

  it('re-evaluates on recorded observed rows, and names the inputs they move', () => {
    const reacted = adaptationToRecorded({ text: e.industry, industry: e.industry, map, recorded: [fact('price_per_unit', 2, 3), fact('buyer_payment_days', 90, 120)] }, assembleEvidence, NOTHING_HELD);
    expect(reacted.observed).toHaveLength(2);
    expect(reacted.inputs).toEqual(['FINANCING', 'PRICE']);
    expect(reacted.changed).toBe(true);
  });

  it('invents nothing: with no observed row recorded there is no adaptation to show', () => {
    const reacted = adaptationToRecorded({ text: e.industry, industry: e.industry, map, recorded: [] }, assembleEvidence, NOTHING_HELD);
    expect(reacted.observed).toHaveLength(0);
    expect(reacted.changed).toBe(false);
    expect(reacted.after).toBe(reacted.before);
    expect(reacted.detail).toMatch(/no observed/);
  });

  it('classifies every observed key into exactly one input', () => {
    for (const [input, keys] of Object.entries(OBSERVED_INPUTS)) for (const k of keys) expect(observedInputOf(k)).toBe(input);
  });

  it('the probe reader overlays no invented figure', () => {
    const source = readFileSync('server/services/industry/construction/openWorld.ts', 'utf8');
    const probe = source.slice(source.indexOf('export async function openWorldHoldsOnRows'));
    expect(probe).not.toMatch(/withObserved|set:\s*\{\s*low|factor:/);
    expect(probe).toMatch(/listConstructionFacts/);
  });
});

describe('openWorldHoldsOnRows (r01.arch-01)', () => {
  afterAll(teardown);

  it('says so on an empty map, refuses without recorded observations, holds once a real row is recorded, and writes nothing', async () => {
    const { project } = await freshProject();
    expect((await openWorldHoldsOnRows()).ok).toBe(false);

    const root = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'commercial cleaning', origin: 'SEED' });
    const buyer = await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'property managers', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: buyer.node.id, kind: 'TRANSACTION_TYPE', name: 'monthly janitorial contract', description: 'paid monthly per building', origin: 'SEED' });

    const tables = ['industry_nodes', 'cash_opportunities', 'opportunity_constraints', 'project_events', 'construction_facts'];
    const count = async () => Promise.all(tables.map(async (t) => (await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0]!.n));

    // Arrangements exist, but no observation is recorded: adaptation is not claimed.
    const unobserved = await openWorldHoldsOnRows();
    expect(unobserved.ok).toBe(false);
    expect(unobserved.detail).toMatch(/no cash, demand, price, capacity or financing fact is recorded/);

    const user = await createUser({ email: `ow-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    const goal = await createWorkstream({ projectId: project.id, title: 'Cleaning', intent: 'I want to enter commercial cleaning with 5000 dollars.', purpose: 'LONG_TERM', createdByUserId: user.id });
    await recordConstructionFact({
      projectId: project.id,
      workstreamId: goal.id,
      fact: { key: 'price_per_unit', segment: null, low: 40, high: 55, status: 'OBSERVED', measures: 'a property manager quoted per building visit', sourceTitle: 'buyer quote', sourceUrl: null },
      recordedBy: `person:${user.id}`,
    });

    const before = await count();
    const held = await openWorldHoldsOnRows();
    expect(await count()).toEqual(before);
    expect(held.ok, held.detail).toBe(true);
    expect(held.detail).toMatch(/roles no record represents/);
    expect(held.detail).toMatch(/recorded price row/);
  });
});

describe('the running Brain constructs from a project’s own rows (ARCH-01)', () => {
  afterAll(teardown);

  it('builds arrangements from the recorded map, offers them as lenses, and re-reads them when the rows change', async () => {
    const { project } = await freshProject();
    const rows = async () => ({ nodes: await listNodes(project.id), constraints: await listConstraintsForProject(project.id), opportunities: await listOpportunities({ projectId: project.id }) });
    expect(await openWorldForProject(await rows())).toEqual([]);

    const root = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'commercial cleaning', origin: 'SEED' });
    const buyer = await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'property managers', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: buyer.node.id, kind: 'TRANSACTION_TYPE', name: 'monthly janitorial contract', description: 'paid monthly per building', origin: 'SEED' });
    const first = await openWorldForProject(await rows());
    expect(first).toHaveLength(1);
    expect(first[0]!.subject).toBe('commercial cleaning');
    const roles = first[0]!.reading.arrangements.map((a) => a.roleId);
    expect(roles.length).toBeGreaterThan(0);

    const lenses = openWorldLenses(first);
    expect(lenses.length).toBeGreaterThan(0);
    expect(lenses.length).toBeLessThanOrEqual(MAX_OPEN_WORLD_LENSES);
    for (const lens of lenses) {
      expect(lens.key).toBe(`openworld:${root.node.id}:${lens.arrangement.flowKey}:${lens.arrangement.roleId}`);
      expect(lens.arrangement.viability).not.toBe('NOT_VIABLE');
      expect(lens.angle).toContain(lens.arrangement.roleLabel);
    }
    // The same rows give the same keys, so a lens keeps its history across passes.
    expect(openWorldLenses(await openWorldForProject(await rows())).map((l) => l.key)).toEqual(lenses.map((l) => l.key));

    // A record that now represents one of those roles changes what is constructed next.
    const role = first[0]!.reading.arrangements[0]!;
    await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: `${role.roleLabel} network`, origin: 'SEED' });
    const after = await openWorldForProject(await rows());
    expect(after[0]!.reading.arrangements.some((a) => a.roleId === role.roleId)).toBe(false);
    expect(after[0]!.reading.representedRoles.length).toBeGreaterThan(first[0]!.reading.representedRoles.length);
  });

  it('interleaves subjects so one cannot take every slot, and caps the set', () => {
    const e = lastMileDelivery();
    const reading = openWorld(e, NOTHING_HELD);
    const two = [{ rootId: 'a', subject: 'A', reading }, { rootId: 'b', subject: 'B', reading }];
    const lenses = openWorldLenses(two, 4);
    expect(lenses).toHaveLength(4);
    expect(lenses.map((l) => l.subject)).toEqual(['A', 'B', 'A', 'B']);
  });
});
