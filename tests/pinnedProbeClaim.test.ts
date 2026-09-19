/**
 * A pinned bin is answered by the surface it names, or by nobody.
 *
 * This pins a production failure, from 2026-09-19, that made every per-surface
 * proof on a pooled account unreliable — and unreliable in the direction that
 * reads as success.
 *
 * `bins.pinned_routine_id` exists so a probe proves *one* Routine. It was read
 * by `routeBin` and by nothing else, so it bounded which surface Brain **fired**
 * and said nothing about who was allowed to **claim**. On a pool where four
 * Routines share one Claude connector — which is the documented topology — every
 * sibling session is an eligible claimer, and a sibling that is already awake
 * beats the dispatcher's next tick every time.
 *
 * What production recorded, from `step10 trace`:
 *
 *     BIN bin_16c5e13d832a44cfb7f7  COMPLETE
 *       title      Surface self-test for Brain Research 1-D
 *       ready      2026-09-19T08:52:20.721Z
 *       DISPATCH   (empty)
 *       EVENTS
 *         08:52:22.159Z  BIN_ASSIGNED  session claude-code-session_01NHKxvEWmtqBAvNxuLWcr1t
 *         08:52:30.532Z  BIN_TERMINAL  COMPLETE
 *
 * `cse_01NHKxvEWmtqBAvNxuLWcr1t` is the session Brain fired at **1-C**. 1-D was
 * never fired at all; its probe was gone 1.4 seconds after going READY.
 *
 * The lasting damage is not the lost probe. `proveSurface` reads the sessions
 * `creditDispatchArrival` attributed to a Routine's own dispatches, so a
 * substituted probe leaves the pinned surface's chain open permanently — and
 * every replacement probe is taken the same way, while each one looks like it
 * worked because the bin reaches COMPLETE. Two healthy surfaces read "35 fires,
 * arrivals, no closed chain" for exactly this reason.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import {
  assignNextBin,
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  getBin,
  markDispatchRoutine,
  markDispatchSent,
} from '../server/repos/bins.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { normalizeSessionRef, sameProviderSession } from '../server/domain/sessionRef.ts';
import type { BinManifest } from '../server/domain/types.ts';

let project: TestProject;
let workerId = '';
/** Two surfaces on one account, bound to one worker — the pooled shape. */
let routineC = '';
let routineD = '';

const MANIFEST: BinManifest = {
  objective: 'Return the sha-256 of one value carried in this manifest.',
  why: 'a bounded proof that this Routine runs as the worker it is bound to',
  lineage: { projectId: '', layerId: null, goal: null, orchestrationId: null },
  units: [{ key: 'echo', establishes: 'the surface answered', input: 'nonce', transform: 'sha256', dependsOn: [] }],
  acceptableSources: [],
  excludedSources: [],
  evidence: ['one unit result'],
  outputs: ['the sha-256 of the value in this manifest'],
  authorizedActions: ['submit the unit result', 'complete this bin'],
  prohibitedActions: ['anything with an external effect'],
  budgetUnits: 1,
  retry: { maxAttempts: 2, backoffSeconds: 30 },
  stoppingConditions: ['the declared unit has a result'],
};

beforeEach(async () => {
  project = await freshProject();
  const account = await createAccount({ provider: 'anthropic', name: 'pool-account' });
  const worker = await createWorker({
    name: 'pool-worker',
    displayName: 'pool-worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    principalType: 'WORKER',
    principalId: worker.id,
    projectId: project.project.id,
    role: 'MEMBER',
    scopes: ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  routineC = (
    await createRoutine({ accountId: account.id, routineRef: 'trig_C', name: '1-C', tokenSecretName: 'S_C' })
  ).id;
  routineD = (
    await createRoutine({ accountId: account.id, routineRef: 'trig_D', name: '1-D', tokenSecretName: 'S_D' })
  ).id;
});

async function probeBinFor(routineId: string, title: string): Promise<string> {
  const bin = await createBin({
    projectId: project.project.id,
    kind: 'DETERMINISTIC_CHECK',
    title,
    objective: 'Prove this surface can be fired and can finish a bin.',
    manifest: { ...MANIFEST, lineage: { ...MANIFEST.lineage, projectId: project.project.id } },
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'SURFACE_PROBE_RESEARCH_V1',
    pinnedRoutineId: routineId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 2,
  });
  return bin.id;
}

/** Brain fires the pinned surface and the provider answers with a session. */
async function fire(binId: string, routineId: string, routineRef: string, sessionRef: string): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = await claimDispatchIntent();
  expect(intent?.binId).toBe(binId);
  // Exactly the order `services/dispatch/loop.ts` uses: the routing decision is
  // recorded on the dispatch row before the fire, so a fire that fails still
  // says where it was aimed.
  await markDispatchRoutine(intent!.id, routineId);
  await markDispatchSent(intent!.id, { routineRef, routineId, sessionRef, projectId: bin.projectId });
}

function assign(sessionRef: string | null) {
  return assignNextBin({
    workerId,
    credentialId: 'cred_pool',
    projectIds: [project.project.id],
    sessionRef,
    families: { prefixes: ['SURFACE_PROBE', 'RESEARCH'], allowsNull: true },
  });
}

describe('the production sequence, reproduced', () => {
  it('refuses a sibling session the probe pinned to another surface', async () => {
    const dProbe = await probeBinFor(routineD, 'Surface self-test for Brain Research 1-D');
    // Brain has not fired 1-D yet — the tick has not come round. 1-C's session is
    // awake because it has just finished its own probe, and asks for more work.
    const stolen = await assign('claude-code-session_01NHKxvEWmtqBAvNxuLWcr1t');
    expect(stolen).toBeNull();

    // And the refusal cost the bin nothing: no attempt, no lease, no generation.
    const bin = (await getBin(dProbe))!;
    expect(bin.state).toBe('READY');
    expect(bin.attemptCount).toBe(0);
    expect(bin.leaseGeneration).toBe(0);
  });

  it('hands it to the session Brain actually fired at that surface', async () => {
    const dProbe = await probeBinFor(routineD, 'Surface self-test for Brain Research 1-D');
    await fire(dProbe, routineD, 'trig_D', 'cse_01DDDDDDDDDDDDDDDDDDDDDD');

    // The same sibling is still refused after the fire: the fire names a session.
    expect(await assign('claude-code-session_01NHKxvEWmtqBAvNxuLWcr1t')).toBeNull();

    // The fired session is spelled differently by the worker and is the same one.
    const assigned = await assign('claude-code-session_01DDDDDDDDDDDDDDDDDDDDDD');
    expect(assigned?.bin.id).toBe(dProbe);
  });

  it('leaves an unpinned bin claimable by anybody eligible, unchanged', async () => {
    const ordinary = await createBin({
      projectId: project.project.id,
      kind: 'RESEARCH_PACKET',
      title: 'ordinary work',
      objective: 'do the work',
      manifest: { ...MANIFEST, lineage: { ...MANIFEST.lineage, projectId: project.project.id } },
      completionContract: 'RESEARCH_PACKET_V1',
      workloadClass: 'RESEARCH',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      maxAttempts: 2,
    });
    const assigned = await assign('claude-code-session_01WHOEVER');
    expect(assigned?.bin.id).toBe(ordinary.id);
  });

  it('refuses a pinned bin to a session that reports nothing at all', async () => {
    // Fail closed. An arrival Brain cannot identify must not be able to answer a
    // proof, because the outcome it would produce is a false one.
    const dProbe = await probeBinFor(routineD, 'Surface self-test for Brain Research 1-D');
    await fire(dProbe, routineD, 'trig_D', 'cse_01DDDDDDDDDDDDDDDDDDDDDD');
    expect(await assign(null)).toBeNull();
    expect((await getBin(dProbe))!.attemptCount).toBe(0);
  });

  it('refuses a probe whose own fire has not happened yet', async () => {
    // There is no dispatch to compare against, so there is no session that may
    // answer it. It waits for its fire rather than being taken by the first
    // eligible caller.
    const cProbe = await probeBinFor(routineC, 'Surface self-test for Brain Research 1-C');
    expect(await assign('claude-code-session_01ANYBODY')).toBeNull();
    expect((await getBin(cProbe))!.state).toBe('READY');
  });

  it('does not let a fire at one surface unlock a bin pinned to another', async () => {
    const cProbe = await probeBinFor(routineC, 'Surface self-test for 1-C');
    await fire(cProbe, routineC, 'trig_C', 'cse_01CCCCCCCCCCCCCCCCCCCCCC');
    const dProbe = await probeBinFor(routineD, 'Surface self-test for 1-D');
    await fire(dProbe, routineD, 'trig_D', 'cse_01DDDDDDDDDDDDDDDDDDDDDD');

    // C's session gets C's probe and only C's probe, even though D's is ready
    // and D's fire has also gone out.
    const first = await assign('claude-code-session_01CCCCCCCCCCCCCCCCCCCCCC');
    expect(first?.bin.id).toBe(cProbe);
    const second = await assign('claude-code-session_01CCCCCCCCCCCCCCCCCCCCCC');
    expect(second).toBeNull();
    expect((await getBin(dProbe))!.state).toBe('READY');
  });
});

describe('two spellings of one session', () => {
  it('reads the provider form and the worker form as the same session', () => {
    expect(
      sameProviderSession('cse_01NHKxvEWmtqBAvNxuLWcr1t', 'claude-code-session_01NHKxvEWmtqBAvNxuLWcr1t'),
    ).toBe(true);
    expect(normalizeSessionRef('session_01NHKxvEWmtqBAvNxuLWcr1t')).toBe('01NHKxvEWmtqBAvNxuLWcr1t');
  });

  it('never reads absence as agreement', () => {
    // "We could not tell" must not read the same as "we checked".
    expect(sameProviderSession(null, null)).toBe(false);
    expect(sameProviderSession('cse_a', null)).toBe(false);
    expect(sameProviderSession('  ', 'cse_')).toBe(false);
    expect(sameProviderSession('cse_', 'claude-code-session_')).toBe(false);
  });

  it('compares an unrecognised spelling whole rather than mangling it', () => {
    // A normalizer that corrupts an input it does not know is worse than one
    // that declines to normalize it.
    expect(normalizeSessionRef('some_other_form')).toBe('some_other_form');
    expect(sameProviderSession('some_other_form', 'some_other_form')).toBe(true);
    expect(sameProviderSession('some_other_form', 'form')).toBe(false);
  });
});
