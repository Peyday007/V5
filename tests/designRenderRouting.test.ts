/**
 * A render bin is fired only at a surface that can run the render
 * (ORIGINATED:FAILURE_PATTERN:design-render, attempt 2).
 *
 * The recorded class: 7 of 11 DESIGN_RENDER bins in 7 days ended NEEDS_HUMAN
 * with "The bin used all 3 attempts without satisfying DESIGN_RENDER_V1 v1.
 * Outstanding: No render was submitted". `openDesignRender` declares no
 * capability, so the router fired those bins at surfaces with no checkout, whose
 * sessions could submit nothing, and each fire spent an attempt. The router now
 * derives the `repository` capability from the render workload class.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES_IMPLIED_BY_CLASS,
  REFUSAL_SCOPE,
  binScopeRefusal,
  routeBin,
  type RoutingCandidate,
} from '../server/services/dispatch/router.ts';
import { DESIGN_RENDER_WORKLOAD_CLASS } from '../server/services/design/render.ts';
import type { Bin, FleetAccount, FleetRoutine } from '../server/domain/types.ts';

const PROJECT = 'prj_render';
const NOW = '2026-11-19T04:00:00.000Z';

function bin(workloadClass: string | null, requiredCapabilities: string[] = []): Bin {
  return {
    id: `bin_${workloadClass ?? 'none'}`,
    projectId: PROJECT,
    state: 'READY',
    priority: 5,
    requiredCapabilities,
    workloadClass,
    manifest: {},
    createdAt: NOW,
  } as unknown as Bin;
}

function surface(id: string, capabilities: string[]): RoutingCandidate {
  return {
    routine: {
      id,
      accountId: `acct_${id}`,
      routineRef: `trig_${id}`,
      name: id,
      state: 'ENABLED',
      capabilities,
      retryAt: null,
      lastFiredAt: null,
    } as unknown as FleetRoutine,
    account: { id: `acct_${id}`, name: id, state: 'ENABLED', retryAt: null } as unknown as FleetAccount,
    servesFamilies: null,
    servesRepositories: null,
    servesProjects: [PROJECT],
    workerActive: true,
    routineInFlight: 0,
    accountInFlight: 0,
    routineTarget: null,
    accountTarget: null,
  };
}

const research = surface('rtn_research', []);
const checkout = surface('rtn_checkout', ['repository']);

function route(target: Bin, candidates: RoutingCandidate[]) {
  return routeBin({ bin: target, candidates, fleetPolicy: null, fleetInFlight: 0, now: NOW });
}

describe('a design render is routed to a surface with a checkout', () => {
  it('names the render lane’s own workload class', () => {
    expect(CAPABILITIES_IMPLIED_BY_CLASS[DESIGN_RENDER_WORKLOAD_CLASS]).toEqual(['repository']);
  });

  it('never chooses a surface without a checkout for a render, whichever is listed first', () => {
    for (const candidates of [[research, checkout], [checkout, research]]) {
      const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_checkout');
    }
    expect(binScopeRefusal(research, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('CAPABILITY');
    expect(binScopeRefusal(checkout, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBeNull();
  });

  it('refuses a render at routing, naming the capability, when no surface has a checkout', () => {
    const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), [research]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_CAPABLE_SURFACE');
      expect(decision.reason).toContain('repository');
      // A per-bin routing wait: the tick defers the intent, it does not charge an attempt.
      expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
    }
  });

  it('keeps a declared requirement and adds the implied one once', () => {
    const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository', 'egress:example.org']), [
      checkout,
      surface('rtn_both', ['repository', 'egress:example.org']),
    ]);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.routine.id).toBe('rtn_both');
  });

  it('routes every other workload class exactly as before', () => {
    for (const workloadClass of ['GENERAL_DESIGN_REVIEW', 'RESEARCH_LIGHT', null]) {
      expect(binScopeRefusal(research, bin(workloadClass))).toBeNull();
      expect(route(bin(workloadClass), [research]).ok).toBe(true);
    }
  });
});
