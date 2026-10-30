import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createNode } from '../server/repos/industry.ts';
import { recordVariable } from '../server/repos/economy.ts';
import { recordRelationship, relationshipsOf, whatItDependsOn } from '../server/services/economy/relationships/graph.ts';
import { activityModelInputs, goalInputFor, inGoalUnits, modelInputsFrom } from '../server/services/economy/relationships/variables.ts';
import { compareArrangements, compareReadings, type ArrangementReading } from '../server/services/economy/relationships/arrangements.ts';
import type { ActivityVariable } from '../server/domain/economy.ts';
import { industryEconomics } from '../server/services/industry/economics.ts';

let projectId = '';
beforeEach(async () => { projectId = (await freshProject()).project.id; });

const est = (activityRef: string, name: string, value: number, unit: string, operatorKind: 'ESTABLISHED_OPERATOR' | 'REPRODUCIBLE_BY_NEW_OPERATOR' = 'REPRODUCIBLE_BY_NEW_OPERATOR') =>
  recordVariable({ projectId, activityRef, name, value, unit, status: 'ESTIMATE', basis: 'operator interview', operatorKind });

describe('relationships on the industry map', () => {
  it('requires industry endpoints to be in this project, and refuses self-edges', async () => {
    const a = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Freight', origin: 'SEED' });
    const b = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Trailers', origin: 'SEED' });
    const base = { projectId, relation: 'SUPPLIES', status: 'ESTIMATE', basis: 'trade press', operatorKind: 'ESTABLISHED_OPERATOR' } as const;
    await expect(recordRelationship({ ...base, fromKind: 'NODE', fromRef: a.node.id, toKind: 'NODE', toRef: 'ind_missing' })).rejects.toThrow(/No industry node/);
    await expect(recordRelationship({ ...base, fromKind: 'NODE', fromRef: a.node.id, toKind: 'NODE', toRef: a.node.id })).rejects.toThrow(/itself/);
    await expect(recordRelationship({ ...base, projectId: 'prj_other', fromKind: 'NODE', fromRef: a.node.id, toKind: 'NODE', toRef: b.node.id })).rejects.toThrow(/No industry node/);
    const ok = await recordRelationship({ ...base, fromKind: 'NODE', fromRef: b.node.id, toKind: 'NODE', toRef: a.node.id });
    expect(ok.created).toBe(true);
    const seen = await relationshipsOf(projectId, a.node.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.direction).toBe('IN');
  });

  it('follows what an activity requires through suppliers, once each, without looping', async () => {
    const link = (fromRef: string, toRef: string, relation: 'REQUIRES' | 'SUPPLIES') =>
      recordRelationship({ projectId, fromKind: 'ACTIVITY', fromRef, toKind: 'ACTIVITY', toRef, relation, status: 'ESTIMATE', basis: 'x', operatorKind: 'ESTABLISHED_OPERATOR' });
    await link('haul', 'truck', 'REQUIRES');
    await link('dealer', 'truck', 'SUPPLIES');
    await link('truck', 'haul', 'REQUIRES'); // a cycle
    const deps = await whatItDependsOn(projectId, 'haul');
    expect(deps.map((d) => d.ref).sort()).toEqual(['dealer', 'truck']);
  });
});

describe('variables reach the goal model with provenance', () => {
  it('converts units, keeps the source, and never hands one operator kind the other\'s figures', async () => {
    await est('a', 'Revenue per transaction', 250000, 'cents', 'ESTABLISHED_OPERATOR');
    await est('a', 'upfront capital', 1000000, 'cents');
    await est('a', 'conversion', 5, 'percent');
    await recordVariable({ projectId, activityRef: 'a', name: 'payment timing', value: null, status: 'UNKNOWN', operatorKind: 'REPRODUCIBLE_BY_NEW_OPERATOR' });
    await est('a', 'revenue per transaction', 99, 'cents', 'ESTABLISHED_OPERATOR');

    const established = await activityModelInputs(projectId, 'a', 'ESTABLISHED_OPERATOR');
    expect(established.price).toMatchObject({ value: 0.99, provenance: 'ASSUMPTION' }); // the newer reading
    const newcomer = await activityModelInputs(projectId, 'a', 'REPRODUCIBLE_BY_NEW_OPERATOR');
    expect(newcomer.price).toBeUndefined(); // the established operator's price is not theirs
    expect(newcomer.capital).toMatchObject({ value: 10000, provenance: 'ASSUMPTION' });
    expect(newcomer.close).toMatchObject({ value: 0.05 });
    expect(newcomer.daysToCash).toMatchObject({ value: null, provenance: 'UNKNOWN', source: null });
  });

  it('keeps a verified claim as the source, and reports a unitless money figure as unknown', async () => {
    const verified: ActivityVariable = { id: 'avr_1', projectId, activityRef: 'b', name: 'price', value: 12, unit: 'dollars', status: 'VERIFIED', sourceClaimId: 'clm_9', basis: null, operatorKind: 'ESTABLISHED_OPERATOR', createdAt: 'now' };
    expect(modelInputsFrom([verified], 'ESTABLISHED_OPERATOR').price).toMatchObject({ value: 12, provenance: 'EVIDENCE', source: { kind: 'CLAIM', ref: 'clm_9' } });
    await recordVariable({ projectId, activityRef: 'b', name: 'upfront capital', value: 500, status: 'ESTIMATE', basis: 'guess', operatorKind: 'ESTABLISHED_OPERATOR' });
    const got = await activityModelInputs(projectId, 'b', 'ESTABLISHED_OPERATOR');
    expect(got.capital).toMatchObject({ value: null, provenance: 'UNKNOWN' });
    expect(got.capital!.note).toMatch(/needs a unit/);
  });

  it('knows which names feed the model and leaves the rest open', () => {
    expect(goalInputFor('  Money   Tied Up ')).toBe('capital');
    expect(goalInputFor('refund rate')).toBeNull();
    expect(inGoalUnits('daysToCash', { value: 2, unit: 'weeks' })).toEqual({ value: 14 });
  });

  it('shows an industry its relationships and inputs, and nothing from another project', async () => {
    const n = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Freight', origin: 'SEED' });
    await est(n.node.id, 'price', 40, 'dollars');
    const e = await industryEconomics(projectId, n.node.id);
    expect(e!.inputs.REPRODUCIBLE_BY_NEW_OPERATOR.price!.value).toBe(40);
    expect(e!.inputs.ESTABLISHED_OPERATOR.price).toBeUndefined();
    expect(await industryEconomics('prj_other', n.node.id)).toBeNull();
  });
});

describe('comparing arrangements for one need', () => {
  async function arrangement(ref: string, price: number, margin: number | null, capital: number, days: number) {
    await est(ref, 'revenue per transaction', price, 'dollars');
    if (margin !== null) await est(ref, 'margin', margin, 'percent');
    await est(ref, 'upfront capital', capital, 'dollars');
    await est(ref, 'payment timing', days, 'days');
  }

  it('orders by what is kept, then capital, then speed, and says why', async () => {
    await arrangement('direct', 1000, 40, 300, 30);   // keeps 400
    await arrangement('broker', 1000, 10, 0, 10);     // keeps 100
    await arrangement('referral', 100, 50, 0, 5);     // keeps 50
    const c = await compareArrangements({ projectId, operatorKind: 'REPRODUCIBLE_BY_NEW_OPERATOR', activities: { DIRECT_SALE: 'direct', BROKERAGE: 'broker', REFERRAL: 'referral' } });
    expect(c.ordered.map((r) => r.arrangement)).toEqual(['DIRECT_SALE', 'BROKERAGE', 'REFERRAL']);
    expect(c.ordered[0]!.netPerDeal).toBe(400);
    expect(c.reasons['BROKERAGE']).toMatch(/Below DIRECT_SALE/);
  });

  it('puts an arrangement whose margin is unestablished after every known one, naming what is missing', async () => {
    await arrangement('direct', 10, 10, 0, 1);        // keeps 1
    await arrangement('resale', 100000, null, 0, 1);  // huge price, margin unknown
    const c = await compareArrangements({ projectId, operatorKind: 'REPRODUCIBLE_BY_NEW_OPERATOR', activities: { DIRECT_SALE: 'direct', RESALE: 'resale' } });
    expect(c.ordered.map((r) => r.arrangement)).toEqual(['DIRECT_SALE', 'RESALE']);
    expect(c.ordered[1]!.netPerDeal).toBeNull();
    expect(c.ordered[1]!.missing).toContain('margin');
  });

  it('is deterministic when nothing differs', () => {
    const r = (arrangement: ArrangementReading['arrangement']): ArrangementReading => ({ arrangement, activityRef: arrangement, netPerDeal: 1, capital: 1, daysToCash: 1, netProvenance: 'ASSUMPTION', missing: [] });
    const c = compareReadings([r('RESALE'), r('BROKERAGE')]);
    expect(c.ordered.map((x) => x.arrangement)).toEqual(['BROKERAGE', 'RESALE']);
    expect(c.reasons['RESALE']).toMatch(/Level with/);
  });
});
