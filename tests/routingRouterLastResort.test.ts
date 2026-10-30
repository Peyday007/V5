import { describe, expect, it } from 'vitest';
import { routeBin, type RoutingCandidate } from '../server/services/dispatch/router.ts';
import type { Bin, FleetAccount, FleetRoutine } from '../server/domain/types.ts';

const NOW = '2026-10-30T12:00:00.000Z';

function candidate(id: string, preference: 'NORMAL' | 'LAST_RESORT', over: Partial<RoutingCandidate> = {}): RoutingCandidate {
  const account = {
    id: `acc_${id}`, provider: 'claude', name: `Account ${id}`, kind: 'CAPACITY', planLabel: null,
    declaredPlanPower: null, state: 'ENABLED', stateReason: null, retryAt: null,
    lastRefusalAt: null, lastRefusalReason: null, createdAt: NOW, updatedAt: NOW,
  } as unknown as FleetAccount;
  const routine = {
    id: `rtn_${id}`, accountId: account.id, name: `Routine ${id}`, state: 'ENABLED',
    lastFiredAt: null, retryAt: null, capabilities: [],
  } as unknown as FleetRoutine;
  return {
    routine, account, servesFamilies: null, accountInFlight: 0, routineInFlight: 0,
    routineTarget: 4, accountTarget: 4, workerActive: true, servesProjects: ['prj_1'], routingPreference: preference, ...over,
  } as RoutingCandidate;
}

const bin = { id: 'bin_x', projectId: 'prj_1', requiredCapabilities: [], manifest: {}, state: 'READY', workloadClass: 'GENERAL_RESEARCH' } as unknown as Bin;
const run = (candidates: RoutingCandidate[]) =>
  routeBin({ bin, candidates, fleetPolicy: null, fleetInFlight: 0, now: NOW, needsWeb: false });

describe('routeBin LAST_RESORT preference', () => {
  it('never picks a LAST_RESORT account while an eligible NORMAL one can take the bin', () => {
    const r = run([candidate('owner', 'LAST_RESORT'), candidate('friend', 'NORMAL')]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.id).toBe('acc_friend');
      expect(r.considered.some((c) => c.routineId === 'rtn_owner' && c.verdict.includes('LAST_RESORT'))).toBe(true);
    }
  });

  it('selects a LAST_RESORT account when the NORMAL one is at target, and records why', () => {
    const r = run([candidate('owner', 'LAST_RESORT'), candidate('friend', 'NORMAL', { routineInFlight: 4 })]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.account.id).toBe('acc_owner');
      expect(r.reason).toContain('LAST_RESORT');
      expect(r.reason).toContain('rtn_friend');
    }
  });

  it('treats an absent preference as NORMAL', () => {
    const r = run([candidate('a', 'NORMAL', { routingPreference: undefined })]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
