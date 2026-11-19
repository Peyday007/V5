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
 *
 * Every surface here is built in the shape production gives it, never with
 * `servesFamilies: null`. Null means "the question could not be asked", and the
 * router reads it as "serves every family". No surface Brain registers has it:
 * a Factory surface is onboarded with an explicit, exhaustive FACTORY-only
 * routing row (`services/factory/onboard.ts`), and any other worker serves
 * `derivedFamiliesFrom` its memberships (`dispatch/candidates.ts`). A test
 * built on null asserts a fleet that cannot exist. It passed while the real
 * fleet refused every render on FAMILY or CAPABILITY.
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
import { FACTORY_ROUTING_CAPABILITIES } from '../server/services/factory/onboard.ts';
import { derivedFamiliesFrom, familyOf } from '../server/services/bins/routing.ts';
import type { Bin, FleetAccount, FleetRoutine } from '../server/domain/types.ts';

const PROJECT = 'prj_render';
const REPOSITORY = 'peyday007/v5';
const NOW = '2026-11-19T04:00:00.000Z';

function bin(workloadClass: string | null, requiredCapabilities: string[] = []): Bin {
  return {
    id: `bin_${workloadClass ?? 'none'}`,
    projectId: PROJECT,
    kind: workloadClass === DESIGN_RENDER_WORKLOAD_CLASS ? 'DESIGN_RENDER' : 'GENERAL',
    completionContract: workloadClass === DESIGN_RENDER_WORKLOAD_CLASS ? 'DESIGN_RENDER_V1' : null,
    state: 'READY',
    priority: 5,
    requiredCapabilities,
    workloadClass,
    manifest: {},
    createdAt: NOW,
  } as unknown as Bin;
}

function surface(
  id: string,
  capabilities: readonly string[],
  scope: { families: string[]; repositories: string[] | null },
): RoutingCandidate {
  return {
    routine: {
      id,
      accountId: `acct_${id}`,
      routineRef: `trig_${id}`,
      name: id,
      state: 'ENABLED',
      capabilities: [...capabilities],
      retryAt: null,
      lastFiredAt: null,
    } as unknown as FleetRoutine,
    account: { id: `acct_${id}`, name: id, state: 'ENABLED', retryAt: null } as unknown as FleetAccount,
    servesFamilies: scope.families,
    servesRepositories: scope.repositories,
    servesProjects: [PROJECT],
    workerActive: true,
    routineInFlight: 0,
    accountInFlight: 0,
    routineTarget: null,
    accountTarget: null,
  };
}

/** A Factory surface exactly as `onboardFactoryRepository` registers it. */
const factory = surface('rtn_factory', FACTORY_ROUTING_CAPABILITIES, {
  families: ['FACTORY'],
  repositories: [REPOSITORY],
});
/** A research surface with no routing row: what its memberships imply. */
const research = surface('rtn_research', [], {
  families: derivedFamiliesFrom([{ active: true, scopes: ['work:claim', 'research:write'] }]),
  repositories: null,
});
/** A general surface with no routing row and no research scope. */
const general = surface('rtn_general', [], {
  families: derivedFamiliesFrom([{ active: true, scopes: ['work:claim'] }]),
  repositories: null,
});
const PRODUCTION_FLEET = [factory, research, general];

function route(target: Bin, candidates: RoutingCandidate[]) {
  return routeBin({ bin: target, candidates, fleetPolicy: null, fleetInFlight: 0, now: NOW });
}

describe('the surfaces in this file are the ones production registers', () => {
  it('gives every surface an explicit family scope, never the null that serves everything', () => {
    for (const candidate of PRODUCTION_FLEET) {
      expect(Array.isArray(candidate.servesFamilies)).toBe(true);
    }
    expect(factory.servesFamilies).toEqual(['FACTORY']);
    expect(research.servesFamilies).toEqual(['RESEARCH', 'GENERAL']);
    expect(general.servesFamilies).toEqual(['GENERAL']);
  });

  it('classifies a render bin as GENERAL work, which no Factory surface serves', () => {
    expect(familyOf(bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('GENERAL');
    expect(binScopeRefusal(factory, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('FAMILY');
  });
});

describe('a design render is routed to a surface with a checkout', () => {
  it('names the render lane’s own workload class', () => {
    expect(CAPABILITIES_IMPLIED_BY_CLASS[DESIGN_RENDER_WORKLOAD_CLASS]).toEqual(['repository']);
  });

  it('never fires a render at a surface without a checkout', () => {
    expect(binScopeRefusal(research, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('CAPABILITY');
    expect(binScopeRefusal(general, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('CAPABILITY');
  });

  /*
   * The objective, against the fleet as Brain builds it: some surface Brain
   * registers must be able to take a render. At d0aabc5 none can. The Factory
   * surface refuses it on FAMILY and every other surface on CAPABILITY, so the
   * bin waits as NO_CAPABLE_SURFACE (a BIN-scoped wait with no retryAt) and never
   * escalates. This test fails until the router or the render lane is changed so
   * that a real surface can be handed the work.
   */
  it('reaches some surface of the production fleet, whichever order it is listed in', () => {
    for (const candidates of [PRODUCTION_FLEET, [...PRODUCTION_FLEET].reverse()]) {
      const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), candidates);
      expect(decision.ok, decision.ok ? '' : `${decision.refusal}: ${decision.reason}`).toBe(true);
    }
  });

  it('refuses a render at routing, naming the capability, when only no-checkout surfaces exist', () => {
    const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), [research, general]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_CAPABLE_SURFACE');
      expect(decision.reason).toContain('repository');
      // A per-bin routing wait: the tick defers the intent, it does not charge an attempt.
      expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
    }
  });

  it('routes every other workload class exactly as before', () => {
    for (const workloadClass of ['GENERAL_DESIGN_REVIEW', 'RESEARCH_LIGHT', null]) {
      expect(binScopeRefusal(research, bin(workloadClass))).toBeNull();
      expect(route(bin(workloadClass), [research]).ok).toBe(true);
      // A surface with no research scope is refused research work on FAMILY, as before.
      expect(binScopeRefusal(general, bin(workloadClass))).toBe(
        familyOf(bin(workloadClass)) === 'GENERAL' ? null : 'FAMILY',
      );
    }
  });
});
