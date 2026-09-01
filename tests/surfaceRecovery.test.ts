/**
 * Recovering a fragment the execution surface broke — and every way that must
 * not happen.
 *
 * The interesting cases are the refusals. A mechanism that can requeue blocked
 * research is one step away from a mechanism for re-running research until it
 * passes, and the only thing standing between those two is the set of guards
 * below. So most of this file is attempts to get a recovery that should be
 * refused, and the inversion tests assert that removing a guard lets one
 * through.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getFragment,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import {
  assignNextBin,
  createBin,
  getBin,
  putBinUnitResult,
  type BinProof,
} from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import {
  evaluateContract,
  hashUnitValue,
  parseProbeOutcome,
  readSurfaceProbe,
  SURFACE_PROBE_OUTCOMES,
} from '../server/services/bins/contracts.ts';
import {
  namesSurfaceFailure,
  recoverFragmentAfterSurfaceChange,
  SurfaceRecoveryRefused,
} from '../server/services/research/surfaceRecovery.ts';
import { listEvents } from '../server/repos/events.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let workerId = '';

const SURFACE_BLOCK =
  'This is not a search-strategy failure; it is an access-refused condition in this ' +
  "worker's execution environment. EGRESS_BLOCKED on legislature.mi.gov.";

const INSUFFICIENCY_BLOCK =
  'No accepted evidence in: operative_definition. The pages cited did not support the claims.';

function probeManifest(hosts: string[]): BinManifest {
  return {
    objective: 'Establish what this surface reaches.',
    why: 'Four failures were being reported as one.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: hosts.map((host, index) => ({
      key: `h${index + 1}`,
      establishes: `Whether ${host} is reachable.`,
      input: host,
      transform: 'probe',
      dependsOn: [],
    })),
    acceptableSources: ['the declared URL'],
    excludedSources: ['a cached copy'],
    evidence: ['one reading per host'],
    outputs: ['readings'],
    authorizedActions: ['read the declared hosts'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['every host has a reading'],
  };
}

/** A probe bin, optionally driven to COMPLETE with the given readings. */
async function makeProbe(
  readings: Record<string, string>,
  over: { complete?: boolean } = {},
): Promise<string> {
  const hosts = Object.keys(readings);
  const bin = await createBin({
    projectId,
    kind: 'SURFACE_PROBE',
    title: 'probe',
    objective: 'Establish what this surface reaches.',
    manifest: probeManifest(hosts),
    completionContract: 'SURFACE_PROBE_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  if (over.complete === false) return bin.id;

  const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
  const proof: BinProof = {
    binId: assigned.bin.id,
    leaseId: assigned.leaseId,
    leaseGeneration: assigned.leaseGeneration,
    workerId,
  };
  const manifestHosts = probeManifest(hosts).units;
  for (const [index, host] of hosts.entries()) {
    await putBinUnitResult({
      binId: bin.id,
      unitKey: manifestHosts[index]!.key,
      value: readings[host]!,
      contentHash: hashUnitValue(readings[host]!),
      leaseId: proof.leaseId,
      leaseGeneration: proof.leaseGeneration,
      submittedBy: workerId,
    });
  }
  const outcome = await requestCompletion({ workerId, proof });
  expect(outcome.state).toBe('COMPLETE');
  return bin.id;
}

/** A packet whose first fragment is blocked, with three stranded behind it. */
async function blockedPacket(
  over: { blockedReason?: string; attempt?: number; maxRepairs?: number } = {},
): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded licensing question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a bounded licensing question',
    assignment: 'the four things that answer it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(orchestration.id, { status: 'NEEDS_HUMAN' });

  const base = {
    orchestrationId: orchestration.id,
    projectId,
    layerId,
    geography: 'Michigan',
    requiredEvidence: [{ id: 'operative_definition', description: 'the statute', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['Michigan Occupational Code (MCL) full text'],
    excludedSourceTypes: ['law-firm articles'],
    completionCriteria: ['a quoted primary provision'],
    minIndependentSources: 1,
    maxRepairs: over.maxRepairs ?? 2,
  } as unknown as Parameters<typeof createFragments>[0][number];

  await createFragments([
    {
      ...base,
      fragmentIndex: 0,
      fragmentKey: 'licence-trigger',
      question: 'What conduct triggers the licence?',
      dependsOn: [],
      attempt: over.attempt ?? 2,
    },
    {
      ...base,
      fragmentIndex: 1,
      fragmentKey: 'real-property-condition',
      question: 'Does it depend on real property?',
      dependsOn: [{ key: 'licence-trigger', kind: 'HARD' }],
      attempt: 1,
    },
    {
      ...base,
      fragmentIndex: 2,
      fragmentKey: 'exemption-inclusion',
      question: 'Is there a carve-out?',
      dependsOn: [
        { key: 'licence-trigger', kind: 'HARD' },
        { key: 'real-property-condition', kind: 'HARD' },
      ],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const fragments = await currentFragments(orchestration.id);
  const at = new Date().toISOString();
  for (const fragment of fragments) {
    await updateFragment(fragment.id, {
      status: 'BLOCKED',
      completedAt: at,
      blockedReason:
        fragment.fragmentKey === 'licence-trigger'
          ? (over.blockedReason ?? SURFACE_BLOCK)
          : 'Not researched: it depends on licence-trigger (BLOCKED), and that never arrives. ' +
            'Answering it would rest on a foundation nobody established. Repair the dependency ' +
            'and this fragment can be retried.',
    });
  }
  return orchestration.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  workerId = (await createWorker({ name: 'w', createdByType: 'SYSTEM', createdById: 't' })).id;
});

/* ========================================================================= */

describe('a probe records what a surface reaches, and never judges it', () => {
  it('accepts a reading for every declared host, whatever it says', async () => {
    // Every host refused, and the bin is still SATISFIED. Reporting bad news is
    // the job; a contract that only passed on good news would be a contract
    // nobody could use to establish that the surface is shut.
    const binId = await makeProbe({
      'https://a.example': 'HOST_NOT_ALLOWED policy refused a.example before the request left',
      'https://b.example': 'ORIGIN_REJECTED 403 bot wall',
    });
    const bin = (await getBin(binId))!;
    expect(bin.state).toBe('COMPLETE');
    expect((await evaluateContract(bin)).satisfied).toBe(true);
  });

  it('refuses a reading that is not in the vocabulary', async () => {
    const binId = await makeProbe(
      { 'https://a.example': 'it seemed to work fine' },
      { complete: false },
    );
    const bin = (await getBin(binId))!;
    const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
    const proof: BinProof = {
      binId: bin.id,
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.leaseGeneration,
      workerId,
    };
    await putBinUnitResult({
      binId: bin.id,
      unitKey: 'h1',
      value: 'it seemed to work fine',
      contentHash: hashUnitValue('it seemed to work fine'),
      leaseId: proof.leaseId,
      leaseGeneration: proof.leaseGeneration,
      submittedBy: workerId,
    });
    const verdict = await evaluateContract((await getBin(bin.id))!);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/do not begin with one of/);
  });

  it('refuses a host with no reading at all', async () => {
    const binId = await makeProbe({ 'https://a.example': 'RETRIEVED ok' }, { complete: false });
    const verdict = await evaluateContract((await getBin(binId))!);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no reading/);
  });

  it('parses only the five outcomes, and keeps the detail separate', async () => {
    for (const outcome of SURFACE_PROBE_OUTCOMES) {
      expect(parseProbeOutcome(`${outcome} some detail`)).toBe(outcome);
    }
    expect(parseProbeOutcome('RETRIEVEDISH nope')).toBeNull();
    expect(parseProbeOutcome('')).toBeNull();

    const binId = await makeProbe({
      'https://a.example': 'RETRIEVED https://a.example 200 4096 bytes; "339.2501"',
    });
    const [reading] = await readSurfaceProbe((await getBin(binId))!);
    expect(reading!.outcome).toBe('RETRIEVED');
    expect(reading!.detail).toMatch(/339\.2501/);
    expect(reading!.submittedBy).toBe(workerId);
  });
});

/* ========================================================================= */

describe('recovery requires the failure to have been the surface', () => {
  it('recovers a fragment whose recorded reason names an execution-surface failure', async () => {
    const orchestrationId = await blockedPacket();
    const probeBinId = await makeProbe({
      'https://www.legislature.mi.gov/': 'RETRIEVED 200 51200 bytes; "339.2501"',
    });

    const result = await recoverFragmentAfterSurfaceChange({
      fragmentKey: 'licence-trigger',
      orchestrationId,
      probeBinId,
      reason: 'network access changed from Trusted to Full',
      actor: { type: 'SYSTEM', id: 'test' },
    });

    // The counter is history; the ceiling is what moved.
    expect(result.attemptBefore).toBe(2);
    expect(result.attemptAfter).toBe(3);
    expect(result.maxRepairsBefore).toBe(2);
    expect(result.maxRepairsAfter).toBe(4);

    // The failed attempt is still there, still BLOCKED, still saying why.
    const previous = (await getFragment(result.previousFragmentId))!;
    expect(previous.status).toBe('BLOCKED');
    expect(previous.attempt).toBe(2);
    expect(previous.blockedReason).toMatch(/EGRESS_BLOCKED/);

    // And what it stranded is live again — only that.
    expect(result.unblockedDependents.sort()).toEqual([
      'exemption-inclusion',
      'real-property-condition',
    ]);
    const live = await currentFragments(orchestrationId);
    expect(live.find((f) => f.fragmentKey === 'real-property-condition')!.status).toBe('QUEUED');
    expect(live.find((f) => f.fragmentKey === 'licence-trigger')!.attempt).toBe(3);
  });

  it('refuses a fragment blocked because its evidence did not clear the gate', async () => {
    // The inversion that matters most. A network change does not make refused
    // research good, and this must never become a way to re-run it.
    const orchestrationId = await blockedPacket({ blockedReason: INSUFFICIENCY_BLOCK });
    const probeBinId = await makeProbe({ 'https://a.example': 'RETRIEVED 200 ok' });

    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'network opened',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(SurfaceRecoveryRefused);

    try {
      await recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'network opened',
        actor: { type: 'SYSTEM', id: 'test' },
      });
    } catch (error) {
      expect((error as SurfaceRecoveryRefused).reasons.join(' ')).toMatch(
        /correctly refused|did not clear the gate/i,
      );
    }
    // Nothing moved.
    const live = await currentFragments(orchestrationId);
    expect(live.every((fragment) => fragment.status === 'BLOCKED')).toBe(true);
  });

  it('reads the surface marker out of either recorded field', () => {
    expect(namesSurfaceFailure({ blockedReason: SURFACE_BLOCK, repairReason: null } as never)).toBe(true);
    expect(namesSurfaceFailure({ blockedReason: null, repairReason: 'EGRESS_BLOCKED again' } as never)).toBe(true);
    expect(namesSurfaceFailure({ blockedReason: INSUFFICIENCY_BLOCK, repairReason: null } as never)).toBe(false);
  });
});

/* ========================================================================= */

describe('recovery requires evidence the surface actually changed', () => {
  it('refuses when the probe recorded no successful retrieval', async () => {
    const orchestrationId = await blockedPacket();
    const probeBinId = await makeProbe({
      'https://www.legislature.mi.gov/': 'HOST_NOT_ALLOWED still refused by the environment',
    });
    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'operator says it is open',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(/no host RETRIEVED/);
  });

  it('refuses a probe that has not finished', async () => {
    const orchestrationId = await blockedPacket();
    const probeBinId = await makeProbe(
      { 'https://a.example': 'RETRIEVED 200 ok' },
      { complete: false },
    );
    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'x',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(/not COMPLETE/);
  });

  it('refuses a bin that is not a probe at all', async () => {
    const orchestrationId = await blockedPacket();
    const other = await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'not a probe',
      objective: 'something else',
      manifest: {
        ...probeManifest(['https://a.example']),
        units: [
          { key: 'u1', establishes: 'x', input: 'abc', transform: 'upper', dependsOn: [] },
        ],
      },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId: other.id,
        reason: 'x',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(/not a SURFACE_PROBE_V1 bin/);
  });

  it('refuses a probe that succeeded before the fragment was blocked', async () => {
    // A probe from before the change proves the surface was open then, which is
    // exactly what was not true when the fragment failed.
    const probeBinId = await makeProbe({ 'https://a.example': 'RETRIEVED 200 ok' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const orchestrationId = await blockedPacket();

    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'x',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(/no host RETRIEVED after this fragment was blocked/);
  });
});

/* ========================================================================= */

describe('what recovery refuses on principle', () => {
  it('refuses a terminal packet', async () => {
    const orchestrationId = await blockedPacket();
    const probeBinId = await makeProbe({ 'https://a.example': 'RETRIEVED 200 ok' });
    await updateOrchestration(orchestrationId, { status: 'COMPLETE' });

    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'x',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(/terminal packet/i);
  });

  it('refuses a fragment that is not blocked', async () => {
    const orchestrationId = await blockedPacket();
    const probeBinId = await makeProbe({ 'https://a.example': 'RETRIEVED 200 ok' });
    const live = await currentFragments(orchestrationId);
    await updateFragment(live.find((f) => f.fragmentKey === 'licence-trigger')!.id, {
      status: 'ACCEPTED',
    });

    await expect(
      recoverFragmentAfterSurfaceChange({
        fragmentKey: 'licence-trigger',
        orchestrationId,
        probeBinId,
        reason: 'x',
        actor: { type: 'SYSTEM', id: 'test' },
      }),
    ).rejects.toThrow(/not BLOCKED/);
  });

  it('leaves a dependent that failed its own gate exactly where it is', async () => {
    // "Naturally unblock its dependents" means the ones it stranded. A
    // dependent that ran and failed carries a different reason and is not this
    // mechanism's business.
    const orchestrationId = await blockedPacket();
    const live = await currentFragments(orchestrationId);
    const strandedId = live.find((f) => f.fragmentKey === 'real-property-condition')!.id;
    await updateFragment(strandedId, { blockedReason: INSUFFICIENCY_BLOCK });
    const probeBinId = await makeProbe({ 'https://a.example': 'RETRIEVED 200 ok' });

    const result = await recoverFragmentAfterSurfaceChange({
      fragmentKey: 'licence-trigger',
      orchestrationId,
      probeBinId,
      reason: 'network opened',
      actor: { type: 'SYSTEM', id: 'test' },
    });

    expect(result.unblockedDependents).not.toContain('real-property-condition');
    expect(result.unblockedDependents).not.toContain('exemption-inclusion');

    // Its failed attempt is untouched — still BLOCKED, still saying why.
    const failed = (await getFragment(strandedId))!;
    expect(failed.status).toBe('BLOCKED');
    expect(failed.attempt).toBe(1);
    expect(failed.blockedReason).toBe(INSUFFICIENCY_BLOCK);
  });

  it('writes one audited recovery row naming the probe it relied on', async () => {
    const orchestrationId = await blockedPacket();
    const probeBinId = await makeProbe({
      'https://www.legislature.mi.gov/': 'RETRIEVED 200 51200 bytes',
    });
    await recoverFragmentAfterSurfaceChange({
      fragmentKey: 'licence-trigger',
      orchestrationId,
      probeBinId,
      reason: 'network access changed from Trusted to Full',
      actor: { type: 'SYSTEM', id: 'step10-surface-recovery' },
    });

    const events = (await listEvents(projectId, 200)).filter(
      (event) => event.eventType === 'RESEARCH_SURFACE_RECOVERY',
    );
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload['probeBinId']).toBe(probeBinId);
    expect(payload['attemptBefore']).toBe(2);
    expect(payload['maxRepairsBefore']).toBe(2);
    expect(payload['maxRepairsAfter']).toBe(4);
    expect(payload['authorizedBy']).toBe('SYSTEM:step10-surface-recovery');
    expect(String(payload['reachedHosts'])).toMatch(/legislature\.mi\.gov/);
  });
});
