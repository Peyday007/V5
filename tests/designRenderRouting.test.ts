/**
 * A design render routes on what its bin declares, against the fleet's real
 * shape (ORIGINATED:FAILURE_PATTERN:design-render, repairs of attempt 2).
 *
 * The recorded class: 7 of 11 DESIGN_RENDER bins in 7 days ended NEEDS_HUMAN
 * with "The bin used all 3 attempts without satisfying DESIGN_RENDER_V1 v1.
 * Outstanding: No render was submitted". An earlier commit made the router
 * imply `repository` for the render class on an unproven cause; that rule is
 * withdrawn and the contract now records where each attempt was fired
 * (tests/designRenderContract.test.ts).
 *
 * The surfaces here are the two shapes `candidates.ts` actually produces, not
 * the `servesFamilies: null` shape (which `servesFamily` reads as "serves
 * everything" and which no production surface has):
 *
 *   - a general surface: no explicit `worker_routing` row, so its families are
 *     derived from membership (`derivedFamiliesFrom`: RESEARCH + GENERAL) and
 *     its repositories are unknown (null);
 *   - a Factory surface: an explicit, exhaustive FACTORY-only routing row
 *     naming its repository, and the `repository` capability.
 *
 * A render bin carries no repository in its manifest, so `familyOf` makes it
 * GENERAL — and the consequence these tests pin is that in this shape a render
 * can never reach a Factory checkout surface by family, whatever it declares.
 */
import { describe, expect, it } from 'vitest';
import {
  REFUSAL_SCOPE,
  binScopeRefusal,
  routeBin,
  type RoutingCandidate,
} from '../server/services/dispatch/router.ts';
import { DESIGN_RENDER_WORKLOAD_CLASS } from '../server/services/design/render.ts';
import { derivedFamiliesFrom, familyOf } from '../server/services/bins/routing.ts';
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

const REPO = 'Peyday007/V5';

function surface(
  id: string,
  capabilities: string[],
  servesFamilies: string[],
  servesRepositories: string[] | null,
): RoutingCandidate {
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
    servesFamilies,
    servesRepositories,
    servesProjects: [PROJECT],
    workerActive: true,
    routineInFlight: 0,
    accountInFlight: 0,
    routineTarget: null,
    accountTarget: null,
  };
}

/** No explicit routing row: families derived from membership, repositories unknown. */
const general = surface('rtn_general', [], derivedFamiliesFrom([{ active: true, scopes: ['research:write'] }]), null);
/** An explicit FACTORY-only routing row, with a checkout. */
const factory = surface('rtn_factory', ['repository'], ['FACTORY'], [REPO]);

function route(target: Bin, candidates: RoutingCandidate[]) {
  return routeBin({ bin: target, candidates, fleetPolicy: null, fleetInFlight: 0, now: NOW });
}

describe('the fleet shapes these tests use are the ones production builds', () => {
  it('a surface without an explicit routing row serves RESEARCH and GENERAL, and a render is GENERAL', () => {
    expect(general.servesFamilies).toEqual(['RESEARCH', 'GENERAL']);
    expect(familyOf(bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('GENERAL');
    // Neither surface is the null shape `servesFamily` waves through.
    for (const candidate of [general, factory]) expect(Array.isArray(candidate.servesFamilies)).toBe(true);
  });
});

describe('a design render on the real fleet', () => {
  it('adds no capability the bin did not declare, and goes to the general surface, whichever is listed first', () => {
    for (const candidates of [[general, factory], [factory, general]]) {
      const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_general');
    }
    expect(binScopeRefusal(general, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBeNull();
  });

  it('never reaches a FACTORY-only checkout surface: it is refused by family, not by capability', () => {
    expect(binScopeRefusal(factory, bin(DESIGN_RENDER_WORKLOAD_CLASS))).toBe('FAMILY');
    expect(binScopeRefusal(factory, bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository']))).toBe('FAMILY');
    const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS), [factory]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
      expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
    }
  });

  it('declaring `repository` alone does not route it to a checkout: no general surface declares one', () => {
    const declared = bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository']);
    expect(binScopeRefusal(general, declared)).toBe('CAPABILITY');
    const decision = route(declared, [general, factory]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
  });

  it('honours a declared `repository` once a surface serving GENERAL declares it, and keeps every requirement', () => {
    const generalWithCheckout = surface(
      'rtn_general_checkout',
      ['repository', 'egress:example.org'],
      derivedFamiliesFrom([{ active: true, scopes: [] }]),
      null,
    );
    for (const candidates of [[general, factory, generalWithCheckout], [generalWithCheckout, factory, general]]) {
      const decision = route(bin(DESIGN_RENDER_WORKLOAD_CLASS, ['repository', 'egress:example.org']), candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_general_checkout');
    }
  });

  it('routes other classes by their own family on the same fleet', () => {
    for (const workloadClass of ['GENERAL_DESIGN_REVIEW', 'RESEARCH_LIGHT', null]) {
      expect(binScopeRefusal(general, bin(workloadClass))).toBeNull();
      expect(binScopeRefusal(factory, bin(workloadClass))).toBe('FAMILY');
      const decision = route(bin(workloadClass), [factory, general]);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_general');
    }
    expect(binScopeRefusal(factory, bin('FACTORY_UNITS'))).toBeNull();
    expect(binScopeRefusal(general, bin('FACTORY_UNITS'))).toBe('FAMILY');
  });
});
