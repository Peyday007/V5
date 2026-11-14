/**
 * COM-13-1: the controllable commercial role, modelled separately from the
 * industry (`services/industry/construction/roles.ts`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createNode } from '../server/repos/industry.ts';
import { lastMileDelivery } from '../server/services/industry/construction/references.ts';
import { allPositions, mechanismsOf, positionKey } from '../server/services/industry/construction/businesses.ts';
import {
  CONTROL_DIMENSIONS,
  SEED_ROLES,
  commercialRoles,
  commercialRolesHoldOnRows,
  roleSetDefect,
  rolesForFlow,
  type FlowRoles,
} from '../server/services/industry/construction/roles.ts';
import type { Fact, FactKey, Gate, IndustryEvidence } from '../server/domain/construction.ts';

afterAll(async () => {
  await teardown();
});

const SRC = { title: 'test source', url: null, kind: 'SECONDARY' as const };

function fact(key: FactKey, low: number, high = low): Fact {
  return { key, segment: null, low, high, status: 'VERIFIED', source: SRC, measures: key };
}

/** A small market: one buyer, independent operators doing the physical work. */
function market(facts: Fact[], gates: Gate[] = [], extra: Partial<IndustryEvidence> = {}): IndustryEvidence {
  return {
    industry: 'office cleaning',
    geography: null,
    workUnit: 'cleaned office',
    capacityUnit: 'crew',
    needsEquipment: false,
    actors: [
      { id: 'offices', name: 'office managers', role: 'BUYER', description: 'buy recurring cleaning', status: 'VERIFIED', source: SRC },
      { id: 'crews', name: 'independent cleaning crews', role: 'OPERATOR', description: 'do the cleaning', status: 'VERIFIED', source: SRC },
    ],
    flows: [
      { from: 'offices', to: 'crews', kind: 'MONEY', terms: 'paid per cleaned office', status: 'VERIFIED', source: SRC },
      { from: 'crews', to: 'offices', kind: 'WORK', terms: 'the physical cleaning', status: 'VERIFIED', source: SRC },
    ],
    segments: [{ actorId: 'offices', buys: 'WORK', requires: [], acceptsIntermediary: true, channel: 'facility-manager referrals', firstTransaction: 'one office cleaned', status: 'VERIFIED', source: SRC }],
    gates,
    chokepoints: [],
    scale: [],
    failures: [],
    adjacencies: [],
    competition: [],
    bargaining: [],
    facts,
    provenance: [],
    ...extra,
  };
}

const roleOf = (set: FlowRoles, id: string) => set.roles.find((r) => r.roleId === id);

describe('commercial roles per flow (COM-13-1)', () => {
  it('gives every flow of a real reference pack a complete role set', () => {
    const e = lastMileDelivery();
    const sets = commercialRoles(e);
    expect(sets).toHaveLength(e.flows.length);
    for (const set of sets) {
      expect(roleSetDefect(set)).toBeNull();
      for (const role of set.roles) {
        expect(['YES', 'NO', 'UNKNOWN']).toContain(role.occupiable.answer);
        expect(role.controls.every((c) => CONTROL_DIMENSIONS.includes(c))).toBe(true);
        expect(role.duties.length).toBeGreaterThan(0);
        expect(role.risks.length).toBeGreaterThan(0);
        // Keyed by flow and role, never by industry.
        expect(role.key).toBe(`${set.flowKey}#${role.roleId}`);
        expect(role.key).not.toContain(e.industry);
      }
    }
    // Every seed except the gate-permitted capital arranger appears somewhere.
    const seen = new Set(sets.flatMap((s) => s.roles.map((r) => r.roleId)));
    for (const seed of SEED_ROLES.filter((s) => s.id !== 'capital_arranger')) expect(seen.has(seed.id)).toBe(true);
  });

  it('maps each role onto the existing §92 positions, with their own mechanisms', () => {
    const e = lastMileDelivery();
    const valid = new Set(allPositions(e.needsEquipment).map(positionKey));
    for (const set of commercialRoles(e)) {
      for (const role of set.roles) {
        expect(role.positions.length).toBeGreaterThan(0);
        for (const p of role.positions) {
          expect(valid.has(p.key)).toBe(true);
          expect(p.key).toBe(positionKey(p.position));
          expect(p.mechanisms).toEqual(mechanismsOf(p.position));
        }
      }
    }
  });

  it('keeps a role the evidence records that no seed names', () => {
    const e = market([], [], {});
    e.actors.push({ id: 'loadboard', name: 'regional load board', role: 'INTERMEDIARY', description: 'posts jobs to crews for a fee', status: 'ESTIMATE', source: SRC });
    const set = rolesForFlow(e, e.flows[0]!, 0);
    const kept = roleOf(set, 'evidence:regional_load_board');
    expect(kept).toBeDefined();
    expect(kept!.origin).toBe('EVIDENCE');
    expect(kept!.positions.length).toBeGreaterThan(0);
    expect(kept!.sources).toContainEqual(SRC);
    expect(roleSetDefect(set)).toBeNull();
  });

  it('lets two markets with different evidence produce different best roles', () => {
    const brokerMarket = market([fact('price_per_unit', 100), fact('broker_take_rate', 0.3), fact('contractor_rate_per_unit', 95)]);
    const primeMarket = market([fact('price_per_unit', 100), fact('broker_take_rate', 0.05), fact('contractor_rate_per_unit', 40)]);
    const a = rolesForFlow(brokerMarket, brokerMarket.flows[0]!, 0).best.roleIds;
    const b = rolesForFlow(primeMarket, primeMarket.flows[0]!, 0).best.roleIds;
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).toContain('broker_agent');
    expect(b).toContain('prime_contractor');
    expect(a.some((id) => b.includes(id))).toBe(false);
    // With nothing priced, nothing is best: no role is ranked by default.
    const none = market([]);
    const unpriced = rolesForFlow(none, none.flows[0]!, 0);
    expect(unpriced.best.roleIds).toEqual([]);
    expect(unpriced.roles.every((r) => r.controlValue.status === 'UNKNOWN' && r.controlValue.lowUsdPerUnit === null)).toBe(true);
  });

  it('keeps a physical service done by independent people as a remotely operable candidate', () => {
    const e = market([]);
    for (const set of commercialRoles(e)) {
      expect(set.physicalByOthers).toBe(true);
      expect(set.roles.some((r) => r.remotelyOperable)).toBe(true);
      expect(set.roles.flatMap((r) => r.positions).every((p) => p.position.supply !== 'SELF')).toBe(true);
    }
  });

  it('decides occupiability from recorded gates, and an unrecorded gate is UNKNOWN', () => {
    const open = market([]);
    expect(rolesForFlow(open, open.flows[0]!, 0).roles.every((r) => r.occupiable.answer === 'UNKNOWN' && r.occupiable.gates.length === 0)).toBe(true);

    const unstated: Gate = { id: 'janitorial_bond', name: 'janitorial service bond', kind: 'BOND', applies: { contract: ['PRIME'] }, upfrontLow: null, upfrontHigh: null, days: null, grants: ['INSURANCE_COVER'], status: 'VERIFIED', source: SRC };
    const half = market([], [unstated]);
    const primeUnknown = roleOf(rolesForFlow(half, half.flows[0]!, 0), 'prime_contractor')!;
    expect(primeUnknown.occupiable).toMatchObject({ answer: 'UNKNOWN', gates: ['janitorial_bond'] });
    expect(primeUnknown.duties).toContain('pass janitorial service bond');

    const stated: Gate = { ...unstated, upfrontLow: 200, upfrontHigh: 400, days: 5 };
    const full = market([], [stated]);
    const set = rolesForFlow(full, full.flows[0]!, 0);
    expect(roleOf(set, 'prime_contractor')!.occupiable).toMatchObject({ answer: 'YES', gates: ['janitorial_bond'] });
    // The bond binds PRIME only; an introduction still has no recorded gate.
    expect(roleOf(set, 'affiliate_referrer')!.occupiable.answer).toBe('UNKNOWN');

    const direct = market([], [stated]);
    direct.segments[0]!.acceptsIntermediary = false;
    const refused = rolesForFlow(direct, direct.flows[0]!, 0);
    expect(roleOf(refused, 'affiliate_referrer')!.occupiable.answer).toBe('NO');
    expect(roleOf(refused, 'representative')!.occupiable.answer).toBe('NO');
    expect(roleOf(refused, 'prime_contractor')!.occupiable.answer).toBe('YES');
  });

  it('enumerates the capital arranger only where a recorded gate permits it', () => {
    const none = market([]);
    const withheld = rolesForFlow(none, none.flows[0]!, 0);
    expect(roleOf(withheld, 'capital_arranger')).toBeUndefined();
    expect(withheld.withheld.map((w) => w.roleId)).toContain('capital_arranger');
    const licence: Gate = { id: 'lending', name: 'state commercial lending licence', kind: 'LICENCE', applies: {}, upfrontLow: 1000, upfrontHigh: 1500, days: 60, grants: ['OPERATING_AUTHORITY'], status: 'VERIFIED', source: SRC };
    const permitted = market([], [licence]);
    const arranger = roleOf(rolesForFlow(permitted, permitted.flows[0]!, 0), 'capital_arranger');
    expect(arranger).toBeDefined();
    expect(arranger!.controls).toContain('FINANCING');
  });
});

describe('commercialRolesHoldOnRows (r01.com-13-1)', () => {
  it('says so when no industry map records a flow, and holds on real rows once one does', async () => {
    const { project } = await freshProject();
    const empty = await commercialRolesHoldOnRows();
    expect(empty.ok).toBe(false);

    const root = await createNode({ projectId: project.id, parentId: null, kind: 'SECTOR', name: 'commercial cleaning', origin: 'SEED' });
    const buyer = await createNode({ projectId: project.id, parentId: root.node.id, kind: 'BUYER_TYPE', name: 'property managers', origin: 'SEED' });
    await createNode({ projectId: project.id, parentId: buyer.node.id, kind: 'TRANSACTION_TYPE', name: 'monthly janitorial contract', description: 'paid monthly per building', origin: 'SEED' });

    const held = await commercialRolesHoldOnRows();
    expect(held.ok).toBe(true);
    expect(held.detail).toMatch(/1 recorded flow\(s\)/);
  });
});
