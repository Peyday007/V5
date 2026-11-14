/**
 * GOV-22-1 repair: the comparison is not inert on production rows.
 *
 * A reviewer found that every cost, urgency and interface input to the
 * capability comparison was null on production, that the production ports never
 * read free workers, and that the pass threw the ranking away — so "cheaper
 * reuse" and "changed interface" could never promote anything and no scheduler
 * consumed the comparison. These tests build the rows the production ports
 * would see and show each input is measured from them and that the ranking now
 * decides which promotions are applied.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementReading } from '../server/domain/factoryProgram.ts';
import type { CashNeed, CashOpportunity } from '../server/domain/types.ts';
import {
  CAPABILITY_EVENT_KINDS,
  FACTORY_BUILD_COST_CENTS,
  capabilityRowsFromProgram,
  reconcilePreparedCapabilities,
  type CapabilityPorts,
} from '../server/services/goals/capabilityPromotion.ts';
import { reconcileCapabilities } from '../server/services/goals/priority.ts';

function requirement(key: string, over: Partial<ProgramRequirement> = {}): ProgramRequirement {
  return { key, outputs: [], dependsOn: [], interactsWith: [], ...over } as unknown as ProgramRequirement;
}

interface NeedOver {
  opportunityId?: string | null;
  projectId?: string;
  expectedCostCents?: number | null;
  occurrence?: number;
}

const need = (capability: string, over: NeedOver = {}) => {
  const opportunityId = over.opportunityId === undefined ? 'o1' : over.opportunityId;
  return {
    id: `need-${opportunityId ?? 'none'}-${capability}-${over.projectId ?? 'prj'}`,
    projectId: over.projectId ?? 'prj',
    opportunityId,
    requestKey: `capability:${opportunityId ?? 'none'}:${capability}`,
    state: 'OPEN',
    expectedCostCents: over.expectedCostCents ?? null,
    occurrence: over.occurrence ?? 1,
  } as unknown as CashNeed;
};

const opportunity = (id: string, priceCents: number | null, over: { projectId?: string; deadline?: string | null } = {}) =>
  ({ id, projectId: over.projectId ?? 'prj', priceCents, deadline: over.deadline ?? null }) as unknown as CashOpportunity;

const reading = (key: string, status: RequirementReading['status']) => ({ key, status }) as RequirementReading;

function rows(input: { needs: CashNeed[]; opportunities: CashOpportunity[]; parallelWorkers?: number | null; map?: RequirementMap }) {
  const map = input.map ?? { requirements: [requirement('cap', { prepared: true, outputs: ['TAKE_PAYMENT'] })], context: [] };
  return capabilityRowsFromProgram({
    map,
    readings: map.requirements.map((r) => reading(r.key, 'MAPPED')),
    edgesOf: (r) => r.dependsOn,
    needs: input.needs,
    opportunities: new Map(input.opportunities.map((o) => [o.id, o])),
    promotedHere: new Set(),
    parallelWorkers: input.parallelWorkers,
  });
}

describe('every comparison input is measured from the rows', () => {
  it('reads urgency, workaround cost, build cost, reuse, uncertainty and opportunity cost', () => {
    const { capabilities } = rows({
      needs: [
        need('TAKE_PAYMENT', { opportunityId: 'o1', expectedCostCents: 4_000 }),
        need('TAKE_PAYMENT', { opportunityId: 'o2', expectedCostCents: 1_500 }),
        need('TAKE_PAYMENT', { opportunityId: null, projectId: 'prj-other' }),
      ],
      opportunities: [
        opportunity('o1', 50_000, { deadline: '2026-12-20T00:00:00.000Z' }),
        opportunity('o2', null, { deadline: '2026-12-01T00:00:00.000Z' }),
      ],
      parallelWorkers: 3,
    });
    const cap = capabilities.find((c) => c.id === 'cap')!;
    expect(cap.dueAt).toBe('2026-12-01T00:00:00.000Z');
    expect(cap.workaroundCostCents).toBe(5_500);
    expect(cap.buildCostCents).toBe(FACTORY_BUILD_COST_CENTS);
    expect(cap.otherBeneficiaries).toBe(1);
    expect(cap.uncertainty).toBe(0.5);
    expect(cap.opportunityCostCents).toBe(0);
    expect(cap.interfaceChanged).toBeNull();
  });

  it('leaves what no row states unknown: no need, no workaround figure, no worker reading', () => {
    const { capabilities } = rows({ needs: [need('TAKE_PAYMENT')], opportunities: [opportunity('o1', 9_000)], parallelWorkers: null });
    const cap = capabilities.find((c) => c.id === 'cap')!;
    expect(cap.workaroundCostCents).toBeNull();
    expect(cap.dueAt).toBeNull();
    expect(cap.opportunityCostCents).toBeNull();
    expect(cap.interfaceChanged).toBeNull();
    const idle = rows({ needs: [], opportunities: [] }).capabilities.find((c) => c.id === 'cap')!;
    expect(idle.uncertainty).toBeNull();
    expect(idle.otherBeneficiaries).toBeNull();
  });

  it('reads a need that came back after being met as a changed interface', () => {
    const { capabilities } = rows({ needs: [need('TAKE_PAYMENT', { occurrence: 2 })], opportunities: [opportunity('o1', 9_000)] });
    expect(capabilities.find((c) => c.id === 'cap')!.interfaceChanged).toBe(true);
  });
});

describe('cheaper reuse and a changed interface now promote on production-shaped rows', () => {
  it('a single blocked transaction whose paid workaround costs more than building promotes for WORKAROUND_COSTS_MORE', () => {
    const r = rows({ needs: [need('TAKE_PAYMENT', { expectedCostCents: 12_000 })], opportunities: [opportunity('o1', 9_000)] });
    const decision = reconcileCapabilities(r.capabilities, r.blocked, { parallelWorkers: null });
    expect(decision.promotions).toEqual([expect.objectContaining({ id: 'cap', decision: expect.objectContaining({ reasons: ['WORKAROUND_COSTS_MORE'] }) })]);
  });

  it('a capability whose need returned promotes for INTERFACE_CHANGED', () => {
    const r = rows({ needs: [need('TAKE_PAYMENT', { occurrence: 3 })], opportunities: [opportunity('o1', null)] });
    const decision = reconcileCapabilities(r.capabilities, r.blocked, { parallelWorkers: null });
    expect(decision.promotions.map((p) => p.decision.reasons)).toEqual([['INTERFACE_CHANGED']]);
  });

  it('a known worker count makes rows startable in rank order', () => {
    const map: RequirementMap = {
      requirements: [
        requirement('late', { prepared: true, outputs: ['SEND_EMAIL'] }),
        requirement('soon', { prepared: true, outputs: ['TAKE_PAYMENT'] }),
      ],
      context: [],
    };
    const r = rows({
      map,
      needs: [need('SEND_EMAIL', { opportunityId: 'a', expectedCostCents: 100 }), need('TAKE_PAYMENT', { opportunityId: 'b', expectedCostCents: 100 })],
      opportunities: [opportunity('a', 1_000, { deadline: '2027-03-01T00:00:00.000Z' }), opportunity('b', 1_000, { deadline: '2026-12-01T00:00:00.000Z' })],
      parallelWorkers: 1,
    });
    const decision = reconcileCapabilities(r.capabilities, r.blocked, { parallelWorkers: 1 });
    expect(decision.ranked.map((x) => [x.id, x.startable])).toEqual([['soon', true], ['late', false]]);
  });
});

describe('the pass consumes the ranking', () => {
  const map: RequirementMap = {
    requirements: [
      requirement('late', { prepared: true, outputs: ['SEND_EMAIL'] }),
      requirement('soon', { prepared: true, outputs: ['TAKE_PAYMENT'] }),
    ],
    context: [],
  };
  const needs = [need('SEND_EMAIL', { opportunityId: 'a', expectedCostCents: 500 }), need('TAKE_PAYMENT', { opportunityId: 'b', expectedCostCents: 500 })];
  const opps = [opportunity('a', 1_000, { deadline: '2027-03-01T00:00:00.000Z' }), opportunity('b', 1_000, { deadline: '2026-12-01T00:00:00.000Z' })];

  function ports(workers: number | null) {
    const proposed: RequirementMap[] = [];
    const recorded: { kind: string; detail: Record<string, unknown> }[] = [];
    const p: CapabilityPorts = {
      async programs() {
        return [{ id: 'fpg', map, readings: map.requirements.map((r) => reading(r.key, 'MAPPED')), edgesOf: (r) => r.dependsOn }];
      },
      async openNeeds() {
        return needs;
      },
      async opportunity(id) {
        return opps.find((o) => o.id === id) ?? null;
      },
      async promotedHere() {
        return new Set<string>();
      },
      async proposeMap(input) {
        proposed.push(input.map);
        return { version: 3 };
      },
      async record(kind, detail) {
        recorded.push({ kind, detail });
      },
      async parallelWorkers() {
        return workers;
      },
    };
    return { p, proposed, recorded };
  }

  it('with one free worker promotes only the most urgent and records the other as deferred, still prepared', async () => {
    const { p, proposed, recorded } = ports(1);
    expect(await reconcilePreparedCapabilities(p)).toEqual([{ programId: 'fpg', promoted: ['soon'], demoted: [], refused: false }]);
    const revised = proposed[0]!.requirements;
    expect(revised.find((r) => r.key === 'soon')!.prepared).toBeUndefined();
    expect(revised.find((r) => r.key === 'late')!.prepared).toBe(true);
    expect(recorded.map((e) => [e.kind, e.detail.requirement])).toEqual([
      [CAPABILITY_EVENT_KINDS.promoted, 'soon'],
      [CAPABILITY_EVENT_KINDS.deferred, 'late'],
    ]);
    expect(recorded[1]!.detail).toMatchObject({ rank: 1, parallelWorkers: 1, mapVersion: 3 });
  });

  it('with no free worker promotes nothing and writes nothing', async () => {
    const { p, proposed, recorded } = ports(0);
    expect(await reconcilePreparedCapabilities(p)).toEqual([]);
    expect(proposed).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('with workers unread still follows the measured blocker for both', async () => {
    const { p } = ports(null);
    const report = await reconcilePreparedCapabilities(p);
    expect(report[0]!.promoted.sort()).toEqual(['late', 'soon']);
  });

  it('the production ports read free workers from the fleet rows, not a constant', () => {
    const source = readFileSync(new URL('../server/services/goals/capabilityPromotion.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async parallelWorkers()', source.indexOf('productionCapabilityPorts')));
    expect(body.slice(0, 400)).toMatch(/idleCounts\(\)/);
    expect(body.slice(0, 400)).not.toMatch(/return null;\s*\n\s*\},\s*\n\s*\};/);
  });
});
