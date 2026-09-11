/**
 * A scope that cannot distinguish the callers it separates is not a scope.
 *
 * Assignment was "the oldest ready bin in the projects this worker may claim
 * from", and project scoping was present and did nothing — because one worker
 * identity served every surface in the fleet and held membership on the research
 * project. So a session started to implement a software repository checked in and
 * was handed a Step 12A research item. The ACC-14 trace is what established it.
 *
 * Each test below is one crossing that must be impossible, and every one of them
 * is decided from a row the worker does not own: the bin's own columns and
 * manifest, and a `worker_routing` row an operator wrote.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createWorker, setWorkerRouting } from '../server/repos/identity.ts';
import { createBin, getBin, listBins } from '../server/repos/bins.ts';
import { binAdmission, checkIn, workerRoutingFor } from '../server/services/bins/service.ts';
import {
  allAdmissions,
  decideBinRouting,
  familyOf,
  repositoryIdOf,
  workloadAdmission,
} from '../server/services/bins/routing.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import type {
  Bin,
  BinManifest,
  FleetAccount,
  FleetRoutine,
  Principal,
} from '../server/domain/types.ts';

let fixture: TestProject;

const OAKWOOD = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

beforeEach(async () => {
  fixture = await freshProject();
});

/** A worker principal with one real membership, as authentication produces one. */
function principalFor(workerId: string, scopes: string[]): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `cred_${workerId}`,
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        projectId: fixture.project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes,
        active: true,
      },
    ],
    requestId: `req_${workerId}`,
  } as unknown as Principal;
}

function manifest(over: Partial<BinManifest> = {}): BinManifest {
  return {
    objective: 'Do the declared thing.',
    why: 'a routing test',
    lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a stored value'],
    outputs: ['one result'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a result'],
    ...over,
  };
}

/** A research/audit bin, as Russell's launch writes one. */
async function researchBin(): Promise<Bin> {
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'RESEARCH_PACKET',
    title: 'A Step 12A packet',
    objective: 'Establish something from primary sources.',
    manifest: manifest(),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'RESEARCH',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
}

/** A factory bin, as the remote plane writes one: its manifest names a remote. */
async function factoryBin(remote = OAKWOOD): Promise<Bin> {
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title: 'Implement a unit and push it',
    objective: 'Move a branch.',
    manifest: manifest({
      repository: {
        remote,
        ref: 'main',
        baseSha: BASE,
        integrationBranch: 'factory/campaign/x',
        pullRequest: null,
      },
    }),
    completionContract: 'FACTORY_UNITS_V1',
    workloadClass: 'FACTORY_UNIT',
    requiredCapabilities: ['repository', 'repository-write'],
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
}

async function worker(name: string): Promise<string> {
  return (await createWorker({ name, createdByType: 'SYSTEM', createdById: 't' })).id;
}

/* ========================================================================= */

describe('a factory worker cannot claim research', () => {
  /*
   * Item 5 of the correction, and the crossing ACC-14 actually observed. A worker
   * registered for repository work is registered *exhaustively*: the families on
   * its row are the only ones it may be handed, so research is not a fallback it
   * drops to when its own queue is empty.
   */
  it('refuses a Step 12A research bin to a worker registered for the factory', async () => {
    const workerId = await worker('factory-surface');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/oakwood-junk-removal'],
      capabilities: [],
      reason: 'a factory surface',
      setBy: 'test',
    });
    const principal = principalFor(workerId, ['queue:claim', 'queue:complete', 'research:write']);
    const bin = await researchBin();

    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_factory' });
    const verdict = await admit(bin);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('FAMILY_NOT_SERVED');

    // And the check-in is not handed it either — the candidate query is scoped, so
    // it is never even considered. `research:write` on the membership does not
    // re-open what the routing row closed.
    const arrival = await checkIn({ principal, workerId, sessionRef: 'cse_factory' });
    expect(arrival.assigned).toBe(false);
  });
});

describe('a research worker cannot claim factory repository work', () => {
  /*
   * Item 6. The default is what does the work here: a worker with no routing row
   * serves the families its scopes imply, and no scope implies repository work.
   * So this holds for every worker that exists today without anybody having
   * written a row for it — which is the only way a boundary introduced into a
   * running system is worth anything.
   */
  it('refuses an implementation bin to a worker with no routing row', async () => {
    const workerId = await worker('research-surface');
    const principal = principalFor(workerId, ['queue:claim', 'queue:complete', 'research:write']);
    const routing = await workerRoutingFor(workerId, principal);
    expect(routing.explicit).toBe(false);
    expect(routing.families).toContain('RESEARCH');
    expect(routing.families).not.toContain('FACTORY');

    const bin = await factoryBin();
    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_research' });
    const verdict = await admit(bin);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('FAMILY_NOT_SERVED');

    const arrival = await checkIn({ principal, workerId, sessionRef: 'cse_research' });
    expect(arrival.assigned).toBe(false);
  });

  it('refuses it even when the bin carries no workload class at all', async () => {
    // The manifest is the work; the class is a label. A factory bin written by a
    // path that forgot the label is still repository work.
    const unlabelled = await createBin({
      projectId: fixture.project.id,
      kind: 'DETERMINISTIC_CHECK',
      title: 'Unlabelled repository work',
      objective: 'Move a branch without saying so.',
      manifest: manifest({
        repository: {
          remote: OAKWOOD,
          ref: 'main',
          baseSha: BASE,
          integrationBranch: 'factory/campaign/x',
          pullRequest: null,
        },
      }),
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    const bin = (await getBin(unlabelled.id))!;
    expect(familyOf(bin)).toBe('FACTORY');

    const workerId = await worker('research-surface-2');
    const principal = principalFor(workerId, ['queue:claim', 'research:write']);
    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_r2' });
    expect((await admit(bin)).ok).toBe(false);
  });
});

describe('an unauthorized repository does not cross a scope', () => {
  /*
   * Item 10's other half: onboarding a repository must create isolated
   * authorization. A factory worker authorized for one repository is not thereby
   * authorized for the next one, so a new repository cannot silently inherit the
   * executor of the last.
   */
  it('refuses a repository this factory worker was not registered for', async () => {
    const workerId = await worker('factory-elsewhere');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/some-other-site'],
      capabilities: [],
      reason: 'authorized for a different repository',
      setBy: 'test',
    });
    const principal = principalFor(workerId, ['queue:claim', 'queue:complete']);
    const bin = await factoryBin();
    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_elsewhere' });
    const verdict = await admit(bin);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('REPOSITORY_NOT_AUTHORIZED');
    // The refusal names the repository it was asked about and not the list it
    // would have allowed: invariant 23's shape at a new boundary.
    expect(verdict.reason).not.toContain('some-other-site');
  });

  it('refuses a project this worker holds no membership on', async () => {
    const workerId = await worker('other-project');
    const bin = await researchBin();
    const decision = decideBinRouting({
      bin,
      principal: {
        ...principalFor(workerId, ['queue:claim']),
        memberships: [],
      } as unknown as Principal,
      routing: {
        workerId,
        families: ['RESEARCH', 'GENERAL'],
        repositories: [],
        capabilities: [],
        reason: 'general',
        explicit: true,
      },
    });
    expect(decision.ok).toBe(false);
    expect(decision.refusal).toBe('PROJECT_OUT_OF_SCOPE');
  });
});

describe('a retired surface claims nothing', () => {
  /*
   * Item 11's first case. A worker retired from active dispatch is retired by its
   * scope, not by being asked nicely: an explicit row listing no family is the
   * only configuration in this system that means "serves nothing", and it is what
   * retirement writes.
   */
  it('refuses every family to a worker whose routing row lists none', async () => {
    const workerId = await worker('retired-surface');
    await setWorkerRouting({
      workerId,
      families: [],
      repositories: [],
      capabilities: [],
      reason: 'retired from active dispatch; kept for historical attribution',
      setBy: 'test',
    });
    const principal = principalFor(workerId, ['queue:claim', 'queue:complete', 'research:write']);

    for (const bin of [await researchBin(), await factoryBin()]) {
      const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_retired' });
      expect((await admit(bin)).ok).toBe(false);
    }
    // And nothing is offered to it at all, so it cannot take work by arriving.
    const arrival = await checkIn({ principal, workerId, sessionRef: 'cse_retired' });
    expect(arrival.assigned).toBe(false);
    // The bins are still there for somebody who may have them.
    expect((await listBins({ projectId: fixture.project.id })).length).toBeGreaterThanOrEqual(2);
  });
});

describe('independence is still asked, and is asked after scope', () => {
  /*
   * Item 11's fifth case. The routing boundary is additional to the audit
   * independence floor and replaces none of it: a worker in scope for the family
   * is still refused a role its own lineage disqualifies it from.
   */
  it('refuses a review to the session that implemented the work', async () => {
    const { ensureChangeRequest, approveChangeRequest, ensureCampaign } = await import(
      '../server/repos/factory.ts'
    );
    const { recordFactoryEvent } = await import('../server/repos/factoryFleet.ts');
    const { FACTORY_EVENT_KINDS } = await import('../server/services/factory/metrics.ts');
    const { createReviewBin } = await import('../server/services/factory/remote.ts');
    const { createUser } = await import('../server/repos/identity.ts');
    const approver = (
      await createUser({
        email: `approver-${Math.random().toString(36).slice(2)}@example.invalid`,
        displayName: 'Approver',
        password: 'a-long-enough-test-password',
        isBrainAdmin: true,
        createdByType: 'SYSTEM',
        createdById: 'test',
      })
    ).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `independence-${Math.random()}`,
      objective: 'Guard something.',
      expectedOutcome: 'It is guarded.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'asserted', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approver,
      authorityId: null,
    });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    const reviewBin = await createReviewBin(campaign, changeRequest, BASE, 1);

    const workerId = await worker('factory-reviewer');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/oakwood-junk-removal'],
      capabilities: [],
      reason: 'a factory surface',
      setBy: 'test',
    });
    const principal = principalFor(workerId, ['queue:claim', 'queue:complete']);

    // In scope for the family, and still refused because this session wrote the
    // code being judged.
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.unitImplemented,
      evidenceClass: 'MEASURED',
      sessionId: 'cse_wrote_it',
      detail: { unitKey: 'u', binId: 'bin_x' },
    });
    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_wrote_it' });
    const verdict = await admit((await getBin(reviewBin.id))!);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('implemented part of this campaign');

    // A different session of the same in-scope worker is admitted.
    const other = await binAdmission({ workerId, principal, sessionRef: 'cse_did_not' });
    expect((await other((await getBin(reviewBin.id))!)).ok).toBe(true);
  });
});

describe('the dispatcher does not send work to a surface that cannot be handed it', () => {
  /*
   * Item 11's last case, and the one that cost the most: a ready eligible bin sat
   * waiting for an unrelated hourly cron because the dispatcher kept choosing the
   * surface it could fire, that surface kept being refused the work, and the
   * surface that could take it arrived on a schedule nobody had tied to the work.
   *
   * Asked of `routeBin` directly, because that is a pure function over a recorded
   * snapshot: the decision is replayable and the test does not need a fleet.
   */
  function routine(over: Partial<FleetRoutine>): FleetRoutine {
    return {
      id: 'rtn_1',
      accountId: 'acct_1',
      routineRef: 'trig_1',
      name: 'surface',
      routineVersion: null,
      baseUrl: null,
      tokenSecretName: 'S',
      tokenDigest: null,
      workerId: 'wkr_1',
      capabilities: [],
      state: 'ENABLED',
      stateReason: null,
      fireGeneration: 1,
      consecutiveFailures: 0,
      consecutiveNoShows: 0,
      totalFires: 0,
      totalRefusals: 0,
      lastFiredAt: null,
      lastCheckInAt: null,
      retryAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    } as FleetRoutine;
  }
  const account = {
    id: 'acct_1',
    provider: 'anthropic',
    name: 'primary',
    planLabel: null,
    declaredPlanPower: null,
    state: 'ENABLED',
    stateReason: null,
    retryAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as FleetAccount;

  it('refuses to fire a research surface for repository work, by name', async () => {
    const bin = await factoryBin();
    const decision = routeBin({
      bin,
      candidates: [
        {
          routine: routine({}),
          account,
          servesFamilies: ['RESEARCH', 'GENERAL'],
          routineInFlight: 0,
          accountInFlight: 0,
          routineTarget: null,
          accountTarget: null,
        },
      ],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: '2026-09-12T00:00:00.000Z',
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
      expect(decision.considered[0]?.verdict).toContain('does not serve FACTORY');
    }
  });

  it('chooses the surface that does serve the family, over one that does not', async () => {
    const bin = await researchBin();
    const decision = routeBin({
      bin,
      candidates: [
        {
          routine: routine({ id: 'rtn_factory', workerId: 'wkr_factory' }),
          account,
          servesFamilies: ['FACTORY'],
          routineInFlight: 0,
          accountInFlight: 0,
          routineTarget: null,
          accountTarget: null,
        },
        {
          routine: routine({ id: 'rtn_research', workerId: 'wkr_research' }),
          account,
          servesFamilies: ['RESEARCH', 'GENERAL'],
          routineInFlight: 0,
          accountInFlight: 0,
          routineTarget: null,
          accountTarget: null,
        },
      ],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: '2026-09-12T00:00:00.000Z',
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.routine.id).toBe('rtn_research');
  });

  it('treats a Routine bound to no worker as eligible, because the fire is not the boundary', async () => {
    const bin = await factoryBin();
    const decision = routeBin({
      bin,
      candidates: [
        {
          routine: routine({ workerId: null, capabilities: ['repository', 'repository-write'] }),
          account,
          servesFamilies: null,
          routineInFlight: 0,
          accountInFlight: 0,
          routineTarget: null,
          accountTarget: null,
        },
      ],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: '2026-09-12T00:00:00.000Z',
    });
    // Firing it costs an activation; the assigner still refuses the work, so the
    // unknown can waste a fire and can never hand over the wrong bin.
    expect(decision.ok).toBe(true);
  });
});

describe('a correctly scoped worker is still handed its own work', () => {
  /*
   * The boundary has to be checked in the direction that can pass, too. A guard
   * that refuses everything satisfies every test above and stops the product, and
   * item 8's failure mode is exactly that: a ready eligible bin waiting while the
   * only surface that could take it is never offered it.
   */
  it('admits a Deal Dispatch research bin to the research worker, and hands it over', async () => {
    const workerId = await worker('wkr-research-positive');
    const principal = principalFor(workerId, ['queue:claim', 'research:write']);
    const bin = await researchBin();

    // No explicit row: the derived scope is what its own scopes imply.
    const routing = await workerRoutingFor(workerId, principal);
    expect(routing.explicit).toBe(false);
    expect(routing.families).toContain('RESEARCH');

    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_positive' });
    expect((await admit(bin)).ok).toBe(true);

    // And the family filter on the candidate query does not hide it either: the
    // two must agree, or the bin is invisible to the caller the hook would admit.
    const handed = await checkIn({ workerId, principal, sessionRef: 'cse_positive' });
    expect(handed.assigned).toBe(true);
    if (handed.assigned) expect(handed.assignment.binId).toBe(bin.id);
  });

  it('hands the same worker nothing once it is registered for the factory alone', async () => {
    const workerId = await worker('wkr-research-then-factory');
    const principal = principalFor(workerId, ['queue:claim', 'research:write']);
    const bin = await researchBin();
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: [OAKWOOD],
      capabilities: [],
      reason: 'registered for one repository and nothing else',
      setBy: 'test',
    });
    const handed = await checkIn({ workerId, principal, sessionRef: 'cse_factory_only' });
    expect(handed.assigned).toBe(false);
    // The bin is still ready: it was not consumed, refused or retired by asking.
    expect((await getBin(bin.id))!.state).toBe('READY');
  });
});

describe('the queue is the other entrance, and it asks the same question', () => {
  /*
   * A bin is not the only way a worker reaches research work. The Step 5 queue
   * hands out RESEARCH_AUDIT and RESEARCH_FRAGMENT items directly — at the MCP
   * tool, the HTTP route and the bin drain — so a worker registered for one
   * repository could otherwise have claimed a Step 12A audit role by asking the
   * queue for it instead of waiting to be handed a bin. That is the same crossing
   * one layer down, and a guard on one entrance is not a guard.
   */
  it('refuses a research work item to a worker registered for the factory', async () => {
    const { enqueueWork, claimWork, getWorkItem } = await import('../server/repos/workQueue.ts');
    const workerId = await worker('wkr-queue-factory');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: [OAKWOOD],
      capabilities: [],
      reason: 'one repository, and no research',
      setBy: 'test',
    });
    const principal = principalFor(workerId, ['queue:claim', 'research:write']);
    const item = await enqueueWork({
      projectId: fixture.project.id,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'PRIMARY' },
      requiredScopes: ['queue:claim', 'research:write'],
      createdByType: 'SYSTEM',
    });

    const routing = await workerRoutingFor(workerId, principal);
    const refusals: string[] = [];
    const claimed = await claimWork({
      admit: allAdmissions([workloadAdmission(routing)]),
      onSkip: (skipped, reason) => refusals.push(`${skipped.id}: ${reason}`),
      workerId,
      credentialId: `cred_${workerId}`,
      scopes: [{ projectId: fixture.project.id, scopes: ['queue:claim', 'research:write'] }],
      limit: 1,
    });
    expect(claimed).toHaveLength(0);
    expect(refusals.join(' ')).toContain('RESEARCH_AUDIT is RESEARCH work');

    // And the refusal cost the item nothing: no lease, no attempt, no generation.
    const after = (await getWorkItem(item.id))!;
    expect(after.state).toBe('QUEUED');
    expect(after.attemptCount).toBe(0);
    expect(after.leaseGeneration).toBe(item.leaseGeneration);
  });

  it('hands the same item to the research worker', async () => {
    const { enqueueWork, claimWork } = await import('../server/repos/workQueue.ts');
    const workerId = await worker('wkr-queue-research');
    const principal = principalFor(workerId, ['queue:claim', 'research:write']);
    await enqueueWork({
      projectId: fixture.project.id,
      workType: 'RESEARCH_FRAGMENT',
      requiredScopes: ['queue:claim', 'research:write'],
      createdByType: 'SYSTEM',
    });
    const claimed = await claimWork({
      admit: allAdmissions([workloadAdmission(await workerRoutingFor(workerId, principal))]),
      workerId,
      credentialId: `cred_${workerId}`,
      scopes: [{ projectId: fixture.project.id, scopes: ['queue:claim', 'research:write'] }],
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
  });
});

describe('a repository id comes from the manifest, not from a name', () => {
  it('reads owner/name from the remote, in every spelling', async () => {
    for (const remote of [OAKWOOD, `${OAKWOOD}.git`, `${OAKWOOD}/`, OAKWOOD.toUpperCase()]) {
      const bin = await factoryBin(remote);
      expect(repositoryIdOf(bin)).toBe('peyday007/oakwood-junk-removal');
    }
  });

  it('refuses repository work whose manifest names nothing to authorize', async () => {
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'FACTORY_UNITS',
      title: 'Repository work with no repository',
      objective: 'Nothing to authorize.',
      manifest: manifest(),
      completionContract: 'FACTORY_UNITS_V1',
      workloadClass: 'FACTORY_UNIT',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    const workerId = await worker('factory-no-repo');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/oakwood-junk-removal'],
      capabilities: [],
      reason: 'a factory surface',
      setBy: 'test',
    });
    const principal = principalFor(workerId, ['queue:claim']);
    const admit = await binAdmission({ workerId, principal, sessionRef: 'cse_norepo' });
    const verdict = await admit((await getBin(bin.id))!);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('REPOSITORY_NOT_NAMED');
  });
});

describe('retiring obsolete work leaves the history and takes the claim away', () => {
  /*
   * Both halves, because doing one without the other is what leaves a worker Brain
   * can still be sent for a settled question: an expired lease is claimable work,
   * so a LEASED bin whose session is gone is not finished just because nothing is
   * running.
   */
  it('cancels a non-terminal bin, fences its last owner, and keeps every row', async () => {
    const { retireBin, listBinEvents } = await import('../server/repos/bins.ts');
    const bin = await researchBin();

    const outcome = await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: 'operator:test',
      reason: 'the project this belonged to is retired',
    });
    expect(outcome.ok).toBe(true);
    const after = (await getBin(bin.id))!;
    expect(after.state).toBe('CANCELLED');
    // Fenced: a late completion from whoever held it matches nothing.
    expect(after.leaseGeneration).toBe(bin.leaseGeneration + 1);
    expect(after.terminalReason).toContain('retired');
    // And the reason is on the ledger with the actor.
    const events = await listBinEvents(bin.id, 20);
    expect(events.some((event) => event.eventType === 'BIN_TERMINAL')).toBe(true);
  });

  it('refuses a finished bin rather than rewriting it', async () => {
    const { retireBin } = await import('../server/repos/bins.ts');
    const bin = await researchBin();
    await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: 'operator:test',
      reason: 'first time',
    });
    const again = await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration + 1,
      operator: 'operator:test',
      reason: 'second time',
    });
    expect(again.ok).toBe(false);
    expect(again.refusal).toBe('ALREADY_TERMINAL');
  });

  it('refuses a generation the operator was not reasoning about', async () => {
    const { retireBin } = await import('../server/repos/bins.ts');
    const bin = await researchBin();
    const stale = await retireBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration + 7,
      operator: 'operator:test',
      reason: 'acting on a bin that has moved',
    });
    expect(stale.ok).toBe(false);
    expect(stale.refusal).toBe('STALE_GENERATION');
    expect((await getBin(bin.id))!.state).toBe('READY');
  });
});
