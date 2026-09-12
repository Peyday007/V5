/**
 * A refusal must not outlive the moment it can stop being true.
 *
 * ---------------------------------------------------------------------------
 * The production shape this is written from
 * ---------------------------------------------------------------------------
 *
 * The audit floor is three distinct authenticated sessions, and a session is
 * the credential the request authenticated with. The Cowork connector presents
 * one OAuth access token, and that token lives an hour
 * (`ACCESS_TOKEN_TTL_MS`). So two activations of one Routine inside one hour
 * authenticate as the same session, and Brain correctly refuses the second the
 * next audit role.
 *
 * What was wrong is what happened next. `recordSessionRefusal` walked the
 * ladder — 1, 2, 5, 15, 30 minutes, then 30 minutes for ever — and nothing in
 * that loop knew the answer could not change until the token aged out. A
 * packet whose research was finished therefore completed its remaining roles at
 * the pace of the token clock rather than the ten-second dispatcher, re-firing
 * meanwhile at a surface whose answer was already known.
 *
 * The correction is a clamp and nothing else: the refusal, the ladder and the
 * comparison are untouched, and the retry point is additionally bounded by the
 * instant the blocking credential expires. It can only ever move a retry
 * earlier.
 *
 * ---------------------------------------------------------------------------
 * What these tests are careful to pin
 * ---------------------------------------------------------------------------
 *
 * Both directions, because a clamp that fires when it should not is worse than
 * no clamp: it would re-offer a bin to a session that is still ineligible, on a
 * tight loop, and the independence guard would refuse it every time. So the
 * bound applies **only** to a session-dimension refusal on a credential that
 * actually expires, and every other refusal keeps the ladder exactly as it was.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, type TestProject } from './helpers.ts';
import { createWorker } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  finishPass,
  startPass,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import {
  createBin,
  getBin,
  isDispatchable,
  listSessionRefusals,
  recordSessionRefusal,
  refusalBackoffMs,
} from '../server/repos/bins.ts';
import { retryAtWithin } from '../server/repos/util.ts';
import { issueToken, registerClient } from '../server/repos/oauth.ts';
import { completeWork } from '../server/repos/workQueue.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { distinctSessionPossibleAt } from '../server/services/research/sessionWindow.ts';
import { checkIn, nextItemInBin, release } from '../server/services/bins/service.ts';
import type { BinManifest, Principal, ResearchOrchestration } from '../server/domain/types.ts';

let fixture: TestProject;
let workerId = '';
let orchestration: ResearchOrchestration;
let binId = '';
let clientId = '';

/**
 * One worker, one credential per activation — production's shape exactly.
 *
 * `authMethod` is the real one for each case, because the whole point of the
 * bound is that it exists for an OAuth access token and does not exist for an
 * operator-issued `brnw_` credential, which never ages out.
 */
function session(credentialId: string, authMethod: Principal['authMethod']): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'window-worker',
    displayName: 'window-worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId,
    authMethod,
    memberships: [
      {
        projectId: fixture.project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: ['queue:claim', 'queue:complete', 'research:write'],
        active: true,
      } as unknown as Principal['memberships'][number],
    ],
    requestId: `req_${credentialId}`,
  };
}

function manifest(): BinManifest {
  return {
    objective: 'Audit the filed report.',
    why: 'A packet is finished when its audit is.',
    lineage: {
      projectId: fixture.project.id,
      layerId: null,
      goal: null,
      orchestrationId: orchestration.id,
    },
    units: [],
    acceptableSources: ['the filed document'],
    excludedSources: ['anything else'],
    evidence: ['three audit roles'],
    outputs: ['a verdict'],
    authorizedActions: ['read the document'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is terminal'],
  };
}

/** An access token for this worker, expiring in `ttlMs`. Never a real secret. */
async function accessToken(ttlMs: number): Promise<{ id: string; expiresAt: string }> {
  const token = await issueToken({
    kind: 'ACCESS',
    tokenPrefix: `pfx${Math.random().toString(36).slice(2, 10)}`,
    tokenDigest: 'd'.repeat(64),
    clientId,
    workerId,
    scope: 'project:read queue:claim',
    resource: null,
    ttlMs,
  });
  return { id: token.id, expiresAt: token.expiresAt };
}

beforeEach(async () => {
  fixture = await freshProject();
  workerId = (
    await createWorker({
      name: `window-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
  clientId = (
    await registerClient({
      clientName: 'session window test',
      redirectUris: ['https://example.invalid/cb'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    })
  ).clientId;

  const layer = await fixture.layerByName('Discovery Logic');
  const document = await addDocument(fixture, 'Discovery Logic', 'v1B', {
    contents: 'Which Michigan county offices accept electronic recording, and on what terms.',
  });
  const run = await createRun({
    projectId: fixture.project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'county e-recording acceptance',
  });
  orchestration = await createOrchestration({
    projectId: fixture.project.id,
    layerId: layer.id,
    runId: run.id,
    title: 'County electronic recording acceptance',
    assignment: 'the official sources that answer it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: fixture.project.id,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'official-record',
      question: 'Which county offices accept electronic recording, and on what terms?',
      geography: 'Michigan',
      requiredEvidence: [
        { id: 'official_source', description: 'the office or portal', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['county register of deeds or recording office'],
      excludedSourceTypes: ['vendor or software marketing pages'],
      completionCriteria: ['a quoted official statement of terms'],
      minIndependentSources: 1,
      maxRepairs: 2,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  for (const fragment of await currentFragments(orchestration.id)) {
    await updateFragment(fragment.id, {
      status: 'ACCEPTED',
      completedAt: new Date().toISOString(),
    });
  }
  await updateOrchestration(orchestration.id, {
    status: 'AUDITING',
    currentPass: 'AUDIT',
    documentId: document.id,
  });
  await advancePacket(orchestration.id);

  binId = (
    await createBin({
      projectId: fixture.project.id,
      layerId: layer.id,
      kind: 'RESEARCH_PACKET',
      title: 'County electronic recording acceptance',
      objective: 'Audit the filed report.',
      manifest: manifest(),
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      maxAttempts: 100,
    })
  ).id;
});

/** Take the bin, perform one audit role under this credential, hand it back. */
async function performRole(
  credentialId: string,
  authMethod: Principal['authMethod'],
  ordinal: number,
): Promise<void> {
  const principal = session(credentialId, authMethod);
  const arrival = await checkIn({ principal, workerId, sessionRef: credentialId });
  expect(arrival.assigned).toBe(true);
  if (!arrival.assigned) return;
  const proof = {
    binId: arrival.assignment.binId,
    leaseId: arrival.assignment.leaseId,
    leaseGeneration: arrival.assignment.leaseGeneration,
    workerId,
  };
  const next = await nextItemInBin({ principal, workerId, proof });
  expect(next.held).toBe(true);
  if (!next.held || !next.item) {
    await release(proof, 'nothing claimable');
    return;
  }
  const item = next.item;
  const pass = await startPass({
    orchestrationId: orchestration.id,
    passKey: 'AUDIT',
    ordinal,
    provider: 'WORKER',
    model: workerId,
    prompt: `audit pass ${ordinal}`,
    promptSha256: 'x'.repeat(64),
    executorWorkerId: workerId,
    executorSessionRef: credentialId,
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
  await completeWork(
    {
      workItemId: item.workItemId,
      workerId,
      leaseId: item.leaseId,
      leaseGeneration: item.leaseGeneration,
    },
    { summary: `${item.workType} done` },
  );
  await advancePacket(orchestration.id);
  await release(proof, 'role done');
}

describe('the clamp itself', () => {
  const floor = '2026-01-01T00:00:10.000Z';

  it('is the computed value when there is no bound', () => {
    expect(retryAtWithin('2026-01-01T00:30:00.000Z', null, floor)).toBe('2026-01-01T00:30:00.000Z');
  });

  it('takes the bound when the bound is earlier', () => {
    expect(retryAtWithin('2026-01-01T00:30:00.000Z', '2026-01-01T00:04:00.000Z', floor)).toBe(
      '2026-01-01T00:04:00.000Z',
    );
  });

  it('leaves the computed value alone when the bound is later', () => {
    expect(retryAtWithin('2026-01-01T00:01:00.000Z', '2026-01-01T00:59:00.000Z', floor)).toBe(
      '2026-01-01T00:01:00.000Z',
    );
  });

  it('never returns a point already passed, so a stale bound cannot make a tight loop', () => {
    expect(retryAtWithin('2026-01-01T00:30:00.000Z', '2025-06-01T00:00:00.000Z', floor)).toBe(floor);
  });
});

describe('when a different session can first turn up', () => {
  it('is the access token\'s own expiry', async () => {
    const token = await accessToken(4 * 60_000);
    expect(await distinctSessionPossibleAt(token.id)).toBe(token.expiresAt);
  });

  it('is unknown for a credential that does not age out, and for nothing at all', async () => {
    // An operator-issued `brnw_` credential is not an OAuth row, so this
    // resolves nothing and the ladder stays the whole answer.
    expect(await distinctSessionPossibleAt('cred_operator_issued')).toBeNull();
    expect(await distinctSessionPossibleAt(null)).toBeNull();
  });

  it('is unknown for a refresh token, which is never presented to a route', async () => {
    const refresh = await issueToken({
      kind: 'REFRESH',
      tokenPrefix: `pfx${Math.random().toString(36).slice(2, 10)}`,
      tokenDigest: 'd'.repeat(64),
      clientId,
      workerId,
      scope: 'project:read',
      resource: null,
      ttlMs: 30 * 24 * 60 * 60_000,
    });
    expect(await distinctSessionPossibleAt(refresh.id)).toBeNull();
  });
});

describe('a session-collision refusal is honoured no longer than the credential behind it', () => {
  it('clamps the very first rung when the credential expires inside it', async () => {
    const short = await accessToken(20_000);
    await performRole(short.id, 'OAUTH_BEARER', 5);

    /*
     * The same activation comes back. Its credential already holds PRIMARY on
     * this packet, so the floor refuses it ADVERSARIAL — correctly, and it will
     * keep refusing it until this token expires and the connector refreshes.
     *
     * The first rung is a minute. The answer can stop being true in twenty
     * seconds, so a minute is forty seconds of waiting for nothing.
     */
    const again = await checkIn({
      principal: session(short.id, 'OAUTH_BEARER'),
      workerId,
      sessionRef: short.id,
    });
    expect(again.assigned).toBe(false);

    const refusals = await listSessionRefusals(binId);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toMatch(/same session/i);
    expect(refusalBackoffMs(1)).toBe(60_000);
    expect(refusals[0]!.retryAt).toBe(short.expiresAt);

    // And the bin's fire backoff moved with it, so the dispatcher tries again
    // at the moment the condition can clear rather than a minute later.
    const bin = (await getBin(binId))!;
    expect(bin.dispatchNotBefore).toBe(short.expiresAt);
    expect(isDispatchable(bin, short.expiresAt)).toBe(true);
    expect(isDispatchable(bin, new Date(Date.parse(short.expiresAt) - 1000).toISOString())).toBe(
      false,
    );
  });

  /*
   * The deeper rungs, asked of the repository directly.
   *
   * `assignNextBin` has a cheap pre-filter that skips a bin whose backoff has
   * not elapsed, so a session cannot walk the ladder by asking again inside its
   * own backoff — which is the correct behaviour and also why the rungs beyond
   * the first are not reachable from `checkIn` without moving a clock. The
   * ladder is what this is about, so it is exercised where it is applied.
   */
  it('holds the last rung to the bound, which is where the hour was being lost', async () => {
    const bound = new Date(Date.now() + 4 * 60_000).toISOString();
    let last = '';
    for (let i = 0; i < 5; i += 1) {
      last = (
        await recordSessionRefusal({
          binId,
          sessionRef: 'cred_clamped',
          reason: 'ADVERSARIAL would share the same session as PRIMARY',
          notLaterThan: bound,
        })
      ).retryAt;
    }
    const refusal = (await listSessionRefusals(binId)).find((r) => r.sessionRef === 'cred_clamped')!;
    expect(refusal.refusals).toBe(5);
    expect(refusalBackoffMs(5)).toBe(1_800_000);
    expect(last).toBe(bound);
    expect(refusal.retryAt).toBe(bound);
  });

  it('leaves a credential that never ages out entirely alone', async () => {
    let record = null as Awaited<ReturnType<typeof recordSessionRefusal>> | null;
    for (let i = 0; i < 5; i += 1) {
      record = await recordSessionRefusal({
        binId,
        sessionRef: 'cred_operator_issued',
        reason: 'ADVERSARIAL would share the same session as PRIMARY',
        notLaterThan: null,
      });
    }
    // The last rung, exactly as before: there is no expiry to clamp to, and
    // inventing one would re-offer the bin to a session that is still refused.
    expect(record!.refusals).toBe(5);
    expect(Date.parse(record!.retryAt) - Date.parse(record!.lastAt)).toBe(1_800_000);
  });

  it('does not admit the refused session early — the bound shortens a wait, it does not lower a floor', async () => {
    const short = await accessToken(1_000);
    await performRole(short.id, 'OAUTH_BEARER', 5);

    /*
     * The token is expired by any reasonable clock, so the bound is in the past
     * and the retry point is the floor. That makes the *bin* fireable almost at
     * once, which is right — but the session itself is still refused, because
     * the independence comparison never consulted any of this.
     */
    const again = await checkIn({
      principal: session(short.id, 'OAUTH_BEARER'),
      workerId,
      sessionRef: short.id,
    });
    expect(again.assigned).toBe(false);

    const refusals = await listSessionRefusals(binId);
    const floorMs = Date.parse(refusals[0]!.retryAt) - Date.parse(refusals[0]!.lastAt);
    expect(floorMs).toBe(10_000);
  });
});
