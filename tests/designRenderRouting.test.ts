/**
 * A design render routes to a surface that has the checkout it needs
 * (ORIGINATED:FAILURE_PATTERN:design-render, repairs of attempt 2).
 *
 * The recorded class: 7 of 11 DESIGN_RENDER bins in 7 days ended NEEDS_HUMAN
 * with "The bin used all 3 attempts without satisfying DESIGN_RENDER_V1 v1.
 * Outstanding: No render was submitted". The render manifest says "Run this in
 * the checkout", but the bin named no repository, so `familyOf` made it GENERAL:
 * every surface with a checkout (a Factory surface, scoped by an explicit
 * FACTORY-only routing row) refused it by family, and it was fired only at
 * general surfaces that have no checkout. The producer had no consumer.
 *
 * The fix is the signal every Factory bin already carries: the render manifest
 * names Brain's repository (`renderRepository`). These tests build the bin from
 * that real manifest shape and route it against the two surface shapes
 * `candidates.ts` produces:
 *
 *   - a general surface: no explicit `worker_routing` row, so its families are
 *     derived from membership (`derivedFamiliesFrom`: RESEARCH + GENERAL) and
 *     its repositories are unknown (null);
 *   - a Factory surface: an explicit, exhaustive FACTORY-only routing row
 *     naming its repository (lower case, as `setWorkerRouting` writes it), and
 *     the `repository` capability.
 *
 * The first describe block reproduces the recorded failure class on the old
 * manifest shape (no repository) so the cause stays pinned as a cause.
 */
import { describe, expect, it } from 'vitest';
import {
  REFUSAL_SCOPE,
  binScopeRefusal,
  routeBin,
  type RoutingCandidate,
} from '../server/services/dispatch/router.ts';
import { readFileSync } from 'node:fs';
import {
  DESIGN_RENDER_REF,
  DESIGN_RENDER_REQUIRED_CAPABILITIES,
  DESIGN_RENDER_WORKLOAD_CLASS,
  renderRepository,
} from '../server/services/design/render.ts';
import { derivedFamiliesFrom, familyOf, repositoryIdOf } from '../server/services/bins/routing.ts';
import { BRAIN_REPOSITORY_ID, classifyBinPurpose } from '../server/domain/binPurpose.ts';
import type { Bin, FleetAccount, FleetRoutine } from '../server/domain/types.ts';

const PROJECT = 'prj_render';
const NOW = '2026-11-19T04:00:00.000Z';

function bin(
  workloadClass: string | null,
  requiredCapabilities: string[] = [],
  manifest: Record<string, unknown> = {},
): Bin {
  return {
    id: `bin_${workloadClass ?? 'none'}`,
    projectId: PROJECT,
    state: 'READY',
    priority: 5,
    requiredCapabilities,
    workloadClass,
    manifest,
    createdAt: NOW,
  } as unknown as Bin;
}

/** A render bin exactly as `openDesignRender` now builds its routing inputs. */
function renderBin(revision: string | null = 'a'.repeat(40)): Bin {
  return bin(DESIGN_RENDER_WORKLOAD_CLASS, [...DESIGN_RENDER_REQUIRED_CAPABILITIES], {
    repository: renderRepository({ revision }),
  });
}

/** A render bin as it was built when the 7 of 11 failed: no repository. */
function legacyRenderBin(): Bin {
  return bin(DESIGN_RENDER_WORKLOAD_CLASS, [...DESIGN_RENDER_REQUIRED_CAPABILITIES]);
}

/** As `setWorkerRouting` writes it: lower case. */
const REPO = BRAIN_REPOSITORY_ID;

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
  it('a surface without an explicit routing row serves RESEARCH and GENERAL', () => {
    expect(general.servesFamilies).toEqual(['RESEARCH', 'GENERAL']);
    // Neither surface is the null shape `servesFamily` waves through.
    for (const candidate of [general, factory]) expect(Array.isArray(candidate.servesFamilies)).toBe(true);
  });
});

describe('the recorded failure class: a render bin that names no repository', () => {
  it('is GENERAL, so the only surface with a checkout refuses it and it is fired where there is none', () => {
    expect(familyOf(legacyRenderBin())).toBe('GENERAL');
    expect(binScopeRefusal(factory, legacyRenderBin())).toBe('FAMILY');
    const decision = route(legacyRenderBin(), [factory, general]);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.routine.id).toBe('rtn_general');
  });
});

describe('a design render on the real fleet', () => {
  it('names Brain\'s repository at the canonical branch, so it is FACTORY work on that repository', () => {
    const repository = renderRepository({ revision: 'b'.repeat(40) });
    expect(repository.ref).toBe(DESIGN_RENDER_REF);
    expect(readFileSync('.github/CANONICAL_BRANCH', 'utf8').trim()).toBe(DESIGN_RENDER_REF);
    expect(repository.baseSha).toBe('b'.repeat(40));
    expect(repository.pullRequest).toBeNull();
    expect(renderRepository({ revision: null }).baseSha).toBe('');
    expect(renderRepository({ revision: 'not-a-sha' }).baseSha).toBe('');

    expect(familyOf(renderBin())).toBe('FACTORY');
    expect(repositoryIdOf(renderBin())).toBe(BRAIN_REPOSITORY_ID);
    // Seeing what Brain built is Brain work, by the repository rule rather than a keyword.
    expect(
      classifyBinPurpose({
        kind: 'DESIGN_RENDER',
        workloadClass: DESIGN_RENDER_WORKLOAD_CLASS,
        completionContract: 'DESIGN_RENDER_V1',
        title: 'Design render',
        objective: 'render',
        repositoryId: repositoryIdOf(renderBin()),
        project: null,
      }).basis,
    ).toBe('REPOSITORY:BRAIN');
  });

  it('goes to the checkout surface and never to a general one, whichever is listed first', () => {
    for (const candidates of [[general, factory], [factory, general]]) {
      const decision = route(renderBin(), candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.routine.id).toBe('rtn_factory');
    }
    expect(binScopeRefusal(factory, renderBin())).toBeNull();
    expect(binScopeRefusal(general, renderBin())).toBe('FAMILY');
    // An unstamped tree routes the same way: the repository, not the revision, decides.
    expect(binScopeRefusal(factory, renderBin(null))).toBeNull();
  });

  it('is not fired at all when no in-scope surface has the checkout: refused at BIN scope', () => {
    const decision = route(renderBin(), [general]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
      expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
    }
  });

  it('is not handed to a Factory surface onboarded for a different repository', () => {
    const elsewhere = surface('rtn_factory_other', ['repository'], ['FACTORY'], ['someone/else']);
    expect(binScopeRefusal(elsewhere, renderBin())).toBe('REPOSITORY');
    const decision = route(renderBin(), [elsewhere, general]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(REFUSAL_SCOPE[decision.refusal]).toBe('BIN');
    const both = route(renderBin(), [elsewhere, general, factory]);
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.routine.id).toBe('rtn_factory');
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
