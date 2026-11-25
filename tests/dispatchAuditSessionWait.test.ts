/**
 * An audit role nobody can take yet holds the bin, not only its intent.
 *
 * Production, 2026-11-24: engineering:watchdog recorded idle capacity beside
 * executable work in 112 of 144 ten-minute windows, the dispatch pass it asked
 * for each time firing nothing. One cause was this branch of `dispatchTick`: a
 * research bin whose only open work is an audit role no surface's next session
 * may take was deferred as an *intent* (`NO_ELIGIBLE_AUDIT_SESSION`), while the
 * bin itself stayed inside `FIREABLE_SQL`. The watchdog, the Factory line
 * reading and the candidate pages all read that predicate, so the bin counted
 * as executable work beside free capacity for the whole wait — and the pass
 * the watchdog then requested deferred it again.
 *
 * The repair is the one the refire guard already uses: `deferBinFires` moves
 * the bin's `dispatch_not_before` to the deferral's retry time. The assigner
 * ignores that column, so a session that arrives may still take the bin.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker } from '../server/repos/fleet.ts';
import { bindRoutineConnector, ensureConnector, attachClient } from '../server/repos/connectors.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { assignNextBin, createBin, getBin, listDispatchesForBin } from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { idleCounts } from '../server/services/engineering/watchdog.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
const realFetch = globalThis.fetch;
let fires: string[] = [];

interface Surface {
  workerId: string;
  accountId: string;
  routineId: string;
  tokenId: string;
}

const tag = () => Math.random().toString(36).slice(2, 8);

async function surface(name: string): Promise<Surface> {
  const account = await createAccount({ provider: 'anthropic', name: `${name}-${tag()}` });
  const worker = await createWorker({ name: `${name}-worker-${tag()}`, createdByType: 'SYSTEM', createdById: 'test' });
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const secret = `AUDIT_WAIT_${name.toUpperCase()}_${tag().toUpperCase()}`;
  process.env[secret] = 'not-a-real-token';
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_${name}_${tag()}`,
    name: `${name} routine`,
    tokenSecretName: secret,
  });
  await bindRoutineWorker(routine.id, worker.id);
  const connector = await ensureConnector({ accountId: account.id, resource: 'https://brain.example/mcp', workerId: worker.id });
  const clientId = `client_${name}_${tag()}`;
  await attachClient({ clientId, connectorId: connector.id, source: 'OPERATOR' });
  await bindRoutineConnector(routine.id, connector.id);
  const tokenId = newId('otk');
  const now = new Date();
  await getDb().run(
    `INSERT INTO oauth_tokens (id, token_digest, token_prefix, kind, client_id, worker_id, created_at, expires_at)
     VALUES (?, ?, ?, 'ACCESS', ?, ?, ?, ?)`,
    [tokenId, `digest_${tokenId}`, tokenId.slice(0, 8), clientId, worker.id, now.toISOString(),
      new Date(now.getTime() + 50 * 60_000).toISOString()],
  );
  return { workerId: worker.id, accountId: account.id, routineId: routine.id, tokenId };
}

function manifest(): BinManifest {
  return {
    objective: 'Audit a packet',
    why: 'A research bin.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['claims'],
    outputs: ['a filed report'],
    authorizedActions: ['research'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is filed'],
  };
}

async function auditingPacket(): Promise<string> {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a packet being audited',
    assignment: 'audit it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(orchestration.id, { status: 'AUDITING' });
  return orchestration.id;
}

async function pass(orchestrationId: string, by: Surface, passKey: 'SYNTHESIS' | 'AUDIT', ordinal: number): Promise<void> {
  const at = new Date(Date.now() - 60_000).toISOString();
  await getDb().run(
    `INSERT INTO research_passes (id, orchestration_id, pass_key, ordinal, attempt, status, provider, prompt,
       prompt_sha256, started_at, completed_at, executor_worker_id, executor_routine_id, executor_account_id,
       executor_session_ref)
     VALUES (?, ?, ?, ?, 1, 'COMPLETE', 'WORKER', 'p', 'sha', ?, ?, ?, ?, ?, ?)`,
    [newId('rps'), orchestrationId, passKey, ordinal, at, at, by.workerId, by.routineId, by.accountId, by.tokenId],
  );
}

/** A research bin whose only open work is an adversarial audit both surfaces already sat in. */
async function aBinNoSurfaceCanAudit(): Promise<string> {
  const author = await surface('author');
  const primary = await surface('primary');
  const orchestrationId = await auditingPacket();
  const created = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'a research packet',
    objective: 'audit it',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 20,
  });
  await pass(orchestrationId, author, 'SYNTHESIS', 4);
  await pass(orchestrationId, primary, 'AUDIT', 5);
  await enqueueWork({
    projectId,
    workType: 'RESEARCH_AUDIT',
    orchestrationId,
    payload: { role: 'ADVERSARIAL' },
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  return created.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  fires = [];
  resetNetworkBlockCache();
  globalThis.fetch = (async (url: string | URL | Request) => {
    fires.push(String(url));
    return new Response(JSON.stringify({ claude_code_session_id: `cse_wait_${fires.length}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetNetworkBlockCache();
});

describe('an audit role no surface can take yet', () => {
  it('defers the bin’s fires to the deferral’s retry time, not only its intent', async () => {
    const binId = await aBinNoSurfaceCanAudit();

    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(fires).toHaveLength(0);
    const intent = (await listDispatchesForBin(binId))[0]!;
    expect(intent.lastErrorKind).toBe('NO_ELIGIBLE_AUDIT_SESSION');

    const held = (await getBin(binId))!;
    expect(held.dispatchNotBefore).not.toBeNull();
    // Both are written from the same retryAfterMs, a statement apart.
    expect(Math.abs(Date.parse(held.dispatchNotBefore!) - Date.parse(intent.nextAttemptAt))).toBeLessThan(5_000);
  });

  it('is not counted as executable work beside idle capacity while it waits, and is again once the wait passes', async () => {
    const binId = await aBinNoSurfaceCanAudit();
    // The recorded failure class: before the tick, the bin reads as executable.
    expect((await idleCounts()).executableWork).toBe(1);

    await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect((await idleCounts()).executableWork).toBe(0);

    const held = (await getBin(binId))!;
    const after = new Date(Date.parse(held.dispatchNotBefore!) + 1_000);
    expect((await idleCounts(after)).executableWork).toBe(1);
  });

  it('remains assignable to a session that arrives during the wait', async () => {
    const binId = await aBinNoSurfaceCanAudit();
    await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect((await getBin(binId))!.dispatchNotBefore).not.toBeNull();

    const arriving = await createWorker({ name: `arriving-${tag()}`, createdByType: 'SYSTEM', createdById: 'test' });
    const assigned = await assignNextBin({ workerId: arriving.id, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(binId);
  });
});
