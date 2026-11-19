/**
 * A design render routes on what its bin declares — no unproven class rule
 * (ORIGINATED:FAILURE_PATTERN:design-render, repair of attempt 2).
 *
 * The recorded class: 7 of 11 DESIGN_RENDER bins in 7 days ended NEEDS_HUMAN
 * with "The bin used all 3 attempts without satisfying DESIGN_RENDER_V1 v1.
 * Outstanding: No render was submitted". An earlier commit asserted the cause
 * was routing to surfaces with no checkout and made the router imply
 * `repository` for the render class; a reviewer found no production row
 * showing it. That rule is withdrawn: the contract now records where each
 * attempt was fired (tests/designRenderContract.test.ts), and routing is
 * decided from that. Until then a render routes like every other bin — and a
 * capability its opener does declare is still honoured exactly.
 */
import { describe, expect, it } from 'vitest';
import {
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

describe('a design render routes on its declared capabilities', () => {
  it('adds no capability the bin did not declare, so no surface is refused on an unproven cause', () => {
    const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), [research]);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.routine.id).toBe('rtn_research');
    expect(binScopeRefusal(research, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBeNull();
  });

  it('honours `repository` when the render bin declares it, whichever surface is listed first', () => {
    for (const candidates of [[research, checkout], [checkout, research]]) {
      const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository']), candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_checkout');
    }
    expect(binScopeRefusal(research, bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository']))).toBe('CAPABILITY');
  });

  it('refuses a declared `repository` render at routing, naming it, when no surface has a checkout', () => {
    const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository']), [research]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_CAPABLE_SURFACE');
      expect(decision.reason).toContain('repository');
      // A per-bin routing wait: the tick defers the intent, it does not charge an attempt.
      expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
    }
  });

  it('keeps every declared requirement', () => {
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
