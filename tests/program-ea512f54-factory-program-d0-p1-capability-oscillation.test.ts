/**
 * GOV-22-1 repair: an open capability need that names no transaction is still
 * evidence the need exists. Before the fix such a need promoted a requirement
 * (its workaround cost beat a zero build cost) and the next pass demoted it
 * because only transaction-bearing needs counted as "still needed" — so the
 * production pass alternated promote/demote forever, writing a new map version
 * each minute.
 */
import { describe, expect, it } from 'vitest';
import type { ProgramRequirement, RequirementMap, RequirementReading } from '../server/domain/factoryProgram.ts';
import type { CashNeed } from '../server/domain/types.ts';
import {
  CAPABILITY_EVENT_KINDS,
  capabilityRowsFromProgram,
  reconcilePreparedCapabilities,
  type CapabilityPorts,
} from '../server/services/goals/capabilityPromotion.ts';

const requirement = (key: string, over: Partial<ProgramRequirement> = {}) =>
  ({ key, outputs: [], dependsOn: [], interactsWith: [], ...over }) as unknown as ProgramRequirement;

const unattachedNeed = (projectId: string, state: CashNeed['state'] = 'OPEN') =>
  ({ id: `need-${projectId}`, projectId, opportunityId: null, requestKey: 'capability:SEND_A_MESSAGE', state, expectedCostCents: 500 }) as unknown as CashNeed;

/** In-memory ports that keep the map and the event log between passes, as production does. */
function statefulPorts(needs: () => CashNeed[]) {
  let map: RequirementMap = { requirements: [requirement('msg', { prepared: true, outputs: ['SEND_A_MESSAGE'] })], context: [] };
  let version = 1;
  const transitions: string[] = [];
  const recorded: string[] = [];
  const p: CapabilityPorts = {
    async programs() {
      return [{ id: 'fpg', map, mapVersion: version, readings: [{ key: 'msg', status: 'MAPPED' } as RequirementReading], edgesOf: (r) => r.dependsOn }];
    },
    async openNeeds() {
      return needs();
    },
    async opportunity() {
      return null;
    },
    async promotedHere() {
      const last = [...transitions].reverse()[0];
      return new Set(last === 'P' ? ['msg'] : []);
    },
    async proposeMap(input) {
      map = input.map;
      version += 1;
      return { version };
    },
    async record(kind) {
      recorded.push(kind);
      if (kind === CAPABILITY_EVENT_KINDS.promoted) transitions.push('P');
      if (kind === CAPABILITY_EVENT_KINDS.demoted) transitions.push('D');
    },
    async parallelWorkers() {
      return 4;
    },
  };
  return { p, transitions, recorded, version: () => version, map: () => map };
}

describe('an unattached open need does not oscillate', () => {
  it('counts as evidence the need still exists for a requirement promoted here', () => {
    const rows = capabilityRowsFromProgram({
      map: { requirements: [requirement('msg', { outputs: ['SEND_A_MESSAGE'] })], context: [] },
      readings: [{ key: 'msg', status: 'MAPPED' } as RequirementReading],
      edgesOf: (r) => r.dependsOn,
      needs: [unattachedNeed('b1')],
      opportunities: new Map(),
      promotedHere: new Set(['msg']),
    });
    expect(rows.capabilities.find((c) => c.id === 'msg')!.needStillExists).toBe(true);
    // No transaction is invented for a need that names none.
    expect(rows.blocked).toEqual([]);
  });

  it('promotes once and then holds across passes while the need stays open', async () => {
    const s = statefulPorts(() => [unattachedNeed('b1')]);
    for (let i = 0; i < 4; i++) await reconcilePreparedCapabilities(s.p);
    expect(s.transitions).toEqual(['P']);
    expect(s.version()).toBe(2);
    expect(s.map().requirements[0]!.prepared).toBeUndefined();
  });

  it('demotes once the unattached need is resolved, and then stays put', async () => {
    let open = true;
    const s = statefulPorts(() => [unattachedNeed('b1', open ? 'OPEN' : 'RESOLVED')]);
    await reconcilePreparedCapabilities(s.p);
    await reconcilePreparedCapabilities(s.p);
    open = false;
    for (let i = 0; i < 3; i++) await reconcilePreparedCapabilities(s.p);
    expect(s.transitions).toEqual(['P', 'D']);
    expect(s.map().requirements).toHaveLength(1);
    expect(s.map().requirements[0]!.prepared).toBe(true);
  });
});
