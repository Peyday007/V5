/**
 * A design render routes to a surface with a checkout, against the fleet's real
 * shape (ORIGINATED:FAILURE_PATTERN:design-render).
 *
 * The recorded class: 7 of 11 DESIGN_RENDER bins in 7 days ended NEEDS_HUMAN
 * with "The bin used all 3 attempts without satisfying DESIGN_RENDER_V1 v1.
 * Outstanding: No render was submitted". The cause is routing: a render bin
 * named no repository and carried a `GENERAL_` class, so `familyOf` made it
 * GENERAL, and every surface that has a checkout serves FACTORY only. It was
 * fired only at surfaces where `npm run design -- render` cannot run.
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
 * The render bin is the one `openDesignRender` actually builds, read back from
 * the database, so a test cannot pass on a bin production does not create.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  REFUSAL_SCOPE,
  binScopeRefusal,
  routeBin,
  type RoutingCandidate,
} from '../server/services/dispatch/router.ts';
import {
  DESIGN_RENDER_REQUIRED_CAPABILITIES,
  DESIGN_RENDER_WORKLOAD_CLASS,
  openDesignRender,
} from '../server/services/design/render.ts';
import {
  classesForFamilies,
  decideBinRouting,
  derivedFamiliesFrom,
  familyOf,
  repositoryIdOf,
  type WorkerRouting,
} from '../server/services/bins/routing.ts';
import { getBin } from '../server/repos/bins.ts';
import { listSurfaces, openCycle } from '../server/repos/design.ts';
import { seedDesignSurfaces } from '../server/services/design/surfaces.ts';
import { BRAIN_REPOSITORY_ID } from '../server/domain/binPurpose.ts';
import type { Bin, FleetAccount, FleetRoutine, Principal } from '../server/domain/types.ts';

const NOW = '2026-11-19T04:00:00.000Z';

function surface(
  id: string,
  projectId: string,
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
    servesProjects: [projectId],
    workerActive: true,
    routineInFlight: 0,
    accountInFlight: 0,
    routineTarget: null,
    accountTarget: null,
  };
}

function fleet(projectId: string) {
  return {
    /** No explicit routing row: families derived from membership, repositories unknown. */
    general: surface(
      'rtn_general',
      projectId,
      [],
      derivedFamiliesFrom([{ active: true, scopes: ['research:write'] }]),
      null,
    ),
    /** An explicit FACTORY-only routing row, with a checkout of Brain's repository. */
    factory: surface('rtn_factory', projectId, ['repository'], ['FACTORY'], [BRAIN_REPOSITORY_ID]),
  };
}

/** The render bin production opens, read back from its row. */
async function productionRenderBin(): Promise<Bin> {
  const { project } = await freshProject();
  await seedDesignSurfaces();
  const target = (await listSurfaces())[0]!;
  const cycle = await openCycle({
    triggerKind: 'OWNER_REQUEST',
    triggerRef: null,
    surfaceKeys: [target.surfaceKey],
    revision: null,
  });
  const binId = await openDesignRender({ cycle, pass: 0, projectId: project.id, surfaces: [target] });
  return (await getBin(binId))!;
}

function route(target: Bin, candidates: RoutingCandidate[]) {
  return routeBin({ bin: target, candidates, fleetPolicy: null, fleetInFlight: 0, now: NOW });
}

describe('the fleet shapes these tests use are the ones production builds', () => {
  it('a surface without an explicit routing row serves RESEARCH and GENERAL only', () => {
    const { general, factory } = fleet('prj_x');
    expect(general.servesFamilies).toEqual(['RESEARCH', 'GENERAL']);
    for (const candidate of [general, factory]) expect(Array.isArray(candidate.servesFamilies)).toBe(true);
  });
});

describe('the recorded failure class: a render shaped as general work', () => {
  it('could only ever reach a surface with no checkout', async () => {
    // The bin as it was built before the fix: a GENERAL_ class and no repository.
    const before = {
      ...(await productionRenderBin()),
      workloadClass: 'GENERAL_DESIGN_RENDER',
      requiredCapabilities: [],
      manifest: { ...(await productionRenderBin()).manifest, repository: undefined },
    } as Bin;
    const { general, factory } = fleet(before.projectId);
    expect(familyOf(before)).toBe('GENERAL');
    expect(binScopeRefusal(factory, before)).toBe('FAMILY');
    const decision = route(before, [factory, general]);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.routine.id).toBe('rtn_general');
      expect(decision.routine.capabilities).not.toContain('repository');
    }
  });
});

describe('a design render as production now opens it', () => {
  it('is repository work on Brain’s own repository, needing a checkout', async () => {
    const bin = await productionRenderBin();
    expect(bin.workloadClass).toBe(DESIGN_RENDER_WORKLOAD_CLASS);
    expect(familyOf(bin)).toBe('FACTORY');
    expect(repositoryIdOf(bin)).toBe(BRAIN_REPOSITORY_ID);
    expect(bin.requiredCapabilities).toEqual([...DESIGN_RENDER_REQUIRED_CAPABILITIES]);
    expect(bin.requiredCapabilities).toContain('repository');
    // And a Factory worker's candidate query, scoped by class prefix, covers it.
    const { prefixes, allowsNull } = classesForFamilies(['FACTORY']);
    expect(prefixes.some((prefix) => bin.workloadClass!.startsWith(prefix))).toBe(true);
    expect(allowsNull).toBe(false);
  });

  it('is fired at the surface with a checkout, whichever order the fleet is listed in', async () => {
    const bin = await productionRenderBin();
    const { general, factory } = fleet(bin.projectId);
    for (const candidates of [[general, factory], [factory, general]]) {
      const decision = route(bin, candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_factory');
    }
    expect(binScopeRefusal(factory, bin)).toBeNull();
    expect(binScopeRefusal(general, bin)).toBe('FAMILY');
  });

  it('is never fired at a surface with no checkout, even one that says it serves every family', async () => {
    const bin = await productionRenderBin();
    const { general } = fleet(bin.projectId);
    const unknownFamilies = { ...general, servesFamilies: null } as unknown as RoutingCandidate;
    expect(binScopeRefusal(unknownFamilies, bin)).toBe('CAPABILITY');
    const decision = route(bin, [general, unknownFamilies]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
  });

  it('is not fired at a Factory surface for another repository', async () => {
    const bin = await productionRenderBin();
    const other = surface('rtn_other', bin.projectId, ['repository'], ['FACTORY'], ['someone/else']);
    expect(binScopeRefusal(other, bin)).toBe('REPOSITORY');
  });

  it('is handed over by the assigner to the Factory worker that the router fired', async () => {
    const bin = await productionRenderBin();
    const principal = {
      memberships: [{ active: true, projectId: bin.projectId, scopes: ['queue:claim'] }],
    } as unknown as Principal;
    const factoryWorker: WorkerRouting = {
      workerId: 'wkr_factory',
      families: ['FACTORY'],
      repositories: [BRAIN_REPOSITORY_ID],
      capabilities: ['repository'],
      reason: 'explicit',
      explicit: true,
    };
    expect(decideBinRouting({ bin, principal, routing: factoryWorker }).ok).toBe(true);
    const generalWorker: WorkerRouting = {
      ...factoryWorker,
      workerId: 'wkr_general',
      families: ['RESEARCH', 'GENERAL'],
      repositories: [],
      capabilities: [],
      explicit: false,
    };
    const refused = decideBinRouting({ bin, principal, routing: generalWorker });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe('FAMILY_NOT_SERVED');
  });
});

describe('other classes are unchanged on the same fleet', () => {
  it('routes general and research classes to the general surface, and factory units to the Factory one', () => {
    const { general, factory } = fleet('prj_render');
    const make = (workloadClass: string | null) =>
      ({
        id: `bin_${workloadClass ?? 'none'}`,
        projectId: 'prj_render',
        state: 'READY',
        priority: 5,
        requiredCapabilities: [],
        workloadClass,
        manifest: {},
        createdAt: NOW,
      }) as unknown as Bin;
    for (const workloadClass of ['GENERAL_DESIGN_REVIEW', 'RESEARCH_LIGHT', null]) {
      expect(binScopeRefusal(general, make(workloadClass))).toBeNull();
      expect(binScopeRefusal(factory, make(workloadClass))).toBe('FAMILY');
      const decision = route(make(workloadClass), [factory, general]);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_general');
    }
    expect(binScopeRefusal(factory, make('FACTORY_UNITS'))).toBeNull();
    expect(binScopeRefusal(general, make('FACTORY_UNITS'))).toBe('FAMILY');
  });
});
