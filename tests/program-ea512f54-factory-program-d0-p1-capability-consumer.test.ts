/**
 * GOV-22-1: the reconciliation in `goals/priority.ts` has a production caller.
 * Rows are built from a program's reading and open cash needs, decisions are
 * applied to the requirement's `prepared` flag through the coordinator's map
 * revision, every transition is recorded, and the goals tick runs the pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementReading } from '../server/domain/factoryProgram.ts';
import type { CashNeed, CashOpportunity } from '../server/domain/types.ts';
import {
  CAPABILITY_EVENT_KINDS,
  applyDecisions,
  capabilityOfNeed,
  capabilityRowsFromProgram,
  reconcilePreparedCapabilities,
  suppliedCapabilities,
  type CapabilityPorts,
} from '../server/services/goals/capabilityPromotion.ts';

function requirement(key: string, over: Partial<ProgramRequirement> = {}): ProgramRequirement {
  return {
    key,
    outputs: [],
    dependsOn: [],
    interactsWith: [],
    ...over,
  } as unknown as ProgramRequirement;
}

const need = (opportunityId: string, capability: string, state: CashNeed['state'] = 'OPEN') =>
  ({ id: `need-${opportunityId}-${capability}`, projectId: 'prj', opportunityId, requestKey: `capability:${opportunityId}:${capability}`, state }) as unknown as CashNeed;

const opportunity = (id: string, priceCents: number | null, projectId = 'prj') => ({ id, projectId, priceCents }) as unknown as CashOpportunity;

const reading = (key: string, status: RequirementReading['status']) => ({ key, status }) as RequirementReading;

function ports(over: {
  map: RequirementMap;
  readings: RequirementReading[];
  needs: CashNeed[];
  opportunities: CashOpportunity[];
  promotedHere?: string[];
  refuse?: boolean;
}) {
  const proposed: { map: RequirementMap; reason: string }[] = [];
  const recorded: { kind: string; detail: Record<string, unknown> }[] = [];
  const p: CapabilityPorts = {
    async programs() {
      return [{ id: 'fpg', map: over.map, readings: over.readings, edgesOf: (r) => r.dependsOn }];
    },
    async openNeeds() {
      return over.needs;
    },
    async opportunity(id) {
      return over.opportunities.find((o) => o.id === id) ?? null;
    },
    async promotedHere() {
      return new Set(over.promotedHere ?? []);
    },
    async proposeMap(input) {
      proposed.push(input);
      return { version: over.refuse ? null : 7 };
    },
    async record(kind, detail) {
      recorded.push({ kind, detail });
    },
    async parallelWorkers() {
      return null;
    },
  };
  return { p, proposed, recorded };
}

describe('linking cash rows to requirements', () => {
  it('reads the capability of an open need only', () => {
    expect(capabilityOfNeed(need('opp', 'RESEARCH_A_QUESTION'))).toBe('RESEARCH_A_QUESTION');
    expect(capabilityOfNeed(need('opp', 'RESEARCH_A_QUESTION', 'RESOLVED'))).toBeNull();
    expect(capabilityOfNeed({ requestKey: 'question:opp:price', state: 'OPEN' })).toBeNull();
  });

  it('takes the supplied capabilities from the requirement outputs, never from prose', () => {
    expect([...suppliedCapabilities({ outputs: ['capability:SEND_EMAIL', 'TAKE_PAYMENT', 'a sentence about email'] })].sort()).toEqual(['SEND_EMAIL', 'TAKE_PAYMENT']);
  });

  it('builds blocked rows from needs and capability rows from not-started requirements', () => {
    const map: RequirementMap = {
      requirements: [
        requirement('cap', { prepared: true, outputs: ['TAKE_PAYMENT'], dependsOn: ['base'] }),
        requirement('base'),
        requirement('busy', { outputs: ['TAKE_PAYMENT'] }),
      ],
      context: [],
    };
    const rows = capabilityRowsFromProgram({
      map,
      readings: [reading('cap', 'MAPPED'), reading('base', 'PRODUCTION_VERIFIED'), reading('busy', 'BUILDING' as RequirementReading['status'])],
      edgesOf: (r) => r.dependsOn,
      needs: [need('o1', 'TAKE_PAYMENT'), need('o2', 'TAKE_PAYMENT'), need('o3', 'UNSUPPLIED')],
      opportunities: new Map([['o1', opportunity('o1', 5000)], ['o2', opportunity('o2', null)]]),
      promotedHere: new Set(),
    });
    expect(rows.blocked.filter((b) => b.capabilityId === 'cap').map((b) => [b.transactionId, b.valueCents])).toEqual([['o1', 5000], ['o2', null]]);
    expect(rows.blocked.some((b) => b.transactionId === 'o3')).toBe(false);
    const cap = rows.capabilities.find((c) => c.id === 'cap');
    expect(cap).toMatchObject({ status: 'SPECIFIED', prepared: true, prerequisitesMet: true, needStillExists: true, interfaceChanged: null });
    expect(rows.capabilities.some((c) => c.id === 'busy')).toBe(false);
  });
});

describe('the pass applies and records decisions', () => {
  const map: RequirementMap = {
    requirements: [requirement('cap', { prepared: true, outputs: ['TAKE_PAYMENT'] }), requirement('other', { prepared: true })],
    context: [],
  };

  it('promotes a prepared requirement two valued transactions are blocked on, through the map revision', async () => {
    const { p, proposed, recorded } = ports({
      map,
      readings: [reading('cap', 'MAPPED'), reading('other', 'MAPPED')],
      needs: [need('o1', 'TAKE_PAYMENT'), need('o2', 'TAKE_PAYMENT')],
      opportunities: [opportunity('o1', 5000), opportunity('o2', 7000, 'prj2')],
    });
    const report = await reconcilePreparedCapabilities(p);
    expect(report).toEqual([{ programId: 'fpg', promoted: ['cap'], demoted: [], refused: false }]);
    expect(proposed).toHaveLength(1);
    const revised = proposed[0]!.map.requirements;
    expect(revised.find((r) => r.key === 'cap')!.prepared).toBeUndefined();
    expect(revised.find((r) => r.key === 'other')!.prepared).toBe(true);
    expect(revised).toHaveLength(2);
    expect(recorded).toEqual([
      expect.objectContaining({ kind: CAPABILITY_EVENT_KINDS.promoted, detail: expect.objectContaining({ requirement: 'cap', mapVersion: 7 }) }),
    ]);
  });

  it('does nothing when nothing is blocked, and an unvalued single need promotes nothing', async () => {
    const { p, proposed } = ports({
      map,
      readings: [reading('cap', 'MAPPED'), reading('other', 'MAPPED')],
      needs: [need('o1', 'TAKE_PAYMENT')],
      opportunities: [opportunity('o1', null)],
    });
    expect(await reconcilePreparedCapabilities(p)).toEqual([]);
    expect(proposed).toHaveLength(0);
  });

  it('demotes only what it promoted once the need vanished, and keeps the requirement', async () => {
    const live: RequirementMap = { requirements: [requirement('cap', { outputs: ['TAKE_PAYMENT'] }), requirement('owner-live')], context: [] };
    const { p, proposed, recorded } = ports({
      map: live,
      readings: [reading('cap', 'MAPPED'), reading('owner-live', 'SPECIFIED')],
      needs: [],
      opportunities: [],
      promotedHere: ['cap'],
    });
    const report = await reconcilePreparedCapabilities(p);
    expect(report).toEqual([{ programId: 'fpg', promoted: [], demoted: ['cap'], refused: false }]);
    const revised = proposed[0]!.map.requirements;
    expect(revised.map((r) => [r.key, r.prepared])).toEqual([['cap', true], ['owner-live', undefined]]);
    expect(recorded[0]).toMatchObject({ kind: CAPABILITY_EVENT_KINDS.demoted, detail: { requirement: 'cap', requirementRetained: true } });
  });

  it('records nothing when the coordinator refuses the revision', async () => {
    const { p, recorded } = ports({
      map,
      readings: [reading('cap', 'MAPPED'), reading('other', 'MAPPED')],
      needs: [need('o1', 'TAKE_PAYMENT'), need('o2', 'TAKE_PAYMENT')],
      opportunities: [opportunity('o1', 5000), opportunity('o2', 7000)],
      refuse: true,
    });
    expect(await reconcilePreparedCapabilities(p)).toEqual([{ programId: 'fpg', promoted: [], demoted: [], refused: true }]);
    expect(recorded).toHaveLength(0);
  });

  it('applyDecisions changes nothing but prepared', () => {
    const out = applyDecisions(map, { promotions: [{ id: 'cap', decision: { promote: true, reasons: [], evidence: [] } }], demotions: [] });
    const { prepared: _prepared, ...rest } = map.requirements[0]!;
    expect(out.requirements[0]).toStrictEqual(rest);
    expect(out.requirements[1]).toBe(map.requirements[1]);
  });
});

describe('the running Brain calls it', () => {
  it('the goals tick runs the capability pass', () => {
    const tick = readFileSync(new URL('../server/services/goals/tick.ts', import.meta.url), 'utf8');
    expect(tick).toMatch(/import \{ reconcilePreparedCapabilitiesIfDue[^}]*\} from '\.\/capabilityPromotion\.ts'/);
    expect(tick).toMatch(/report\.capabilities = await reconcilePreparedCapabilitiesIfDue\(\)/);
  });
});
