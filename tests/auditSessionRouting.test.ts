/**
 * An audit role is fired at a surface whose next session the claim will admit.
 *
 * Production, 2026-10-20: after PRs #246–#250, about four parked packets
 * resumed an hour and about as many parked, and four of the six live resumed
 * rounds sat in AUDITING. The session an audit role is compared on is the
 * connector's access token, which every activation on one Claude account
 * presents for its whole hour — so a fire at whichever surface had headroom
 * often started the author's own session again, the claim refused it, and the
 * bin spent one of its three fires per thirty minutes learning that. A packet
 * one role from accepted then waited out the refire cool-off.
 *
 * These tests hold each part of the repair against the real dispatcher, queue
 * and assigner, with only the provider's fire endpoint simulated:
 *   - a waiting role is fired only at a surface whose predicted session the
 *     audit floor admits, and not at all when none would be;
 *   - nothing about the floor moved: the author is still refused at the claim;
 *   - a bin that made progress is not cooled off for the fires that produced it;
 *   - an arriving session is not told "nothing" because the oldest 25 bins
 *     happened to be ones it may not take;
 *   - within one priority, a packet being audited is offered before fresh work;
 *   - the live resumed-round cap is sized to the fleet, never below six.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker } from '../server/repos/fleet.ts';
import { bindRoutineConnector, ensureConnector, attachClient } from '../server/repos/connectors.ts';
import { enqueueWork, getWorkItemRow } from '../server/repos/workQueue.ts';
import {
  assignNextBin,
  BIN_REFIRE_LIMIT,
  createBin,
  listDispatchesForBin,
  recentFiresForBin,
} from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { auditAdmission, auditFireFit, ARRIVAL_MARGIN_MS } from '../server/services/research/auditAdmission.ts';
import { liveJudgeRoundCap, MAX_LIVE_JUDGE_ROUNDS } from '../server/services/research/judgeRound.ts';
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
  /** The provider trigger the dispatch row records. */
  routineRef: string;
  connectorId: string;
  /** The access token this surface's sessions present now. */
  tokenId: string;
}

const tag = () => Math.random().toString(36).slice(2, 8);

async function surface(name: string, tokenExpiresInMs = 50 * 60_000): Promise<Surface> {
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
  const secret = `AUDIT_ROUTE_${name.toUpperCase()}_${tag().toUpperCase()}`;
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
  const tokenId = await accessToken({ clientId, workerId: worker.id, expiresInMs: tokenExpiresInMs });
  return { workerId: worker.id, accountId: account.id, routineId: routine.id, routineRef: routine.routineRef, connectorId: connector.id, tokenId };
}

async function accessToken(input: { clientId: string; workerId: string; expiresInMs: number }): Promise<string> {
  const id = newId('otk');
  const now = new Date();
  await getDb().run(
    `INSERT INTO oauth_tokens (id, token_digest, token_prefix, kind, client_id, worker_id, created_at, expires_at)
     VALUES (?, ?, ?, 'ACCESS', ?, ?, ?, ?)`,
    [id, `digest_${id}`, id.slice(0, 8), input.clientId, input.workerId, now.toISOString(),
      new Date(now.getTime() + input.expiresInMs).toISOString()],
  );
  return id;
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

async function packet(status = 'AUDITING'): Promise<string> {
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
  await updateOrchestration(orchestration.id, { status: status as Parameters<typeof updateOrchestration>[1]['status'] });
  return orchestration.id;
}

async function bin(orchestrationId: string | null, maxAttempts = 20): Promise<string> {
  const created = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'a research packet',
    objective: 'audit it',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId: orchestrationId ?? undefined,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts,
  });
  return created.id;
}

/** A completed pass, recorded as the given surface's session did it. */
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

async function auditItem(orchestrationId: string, role: 'PRIMARY' | 'ADVERSARIAL' | 'JUDGE'): Promise<string> {
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_AUDIT',
    orchestrationId,
    payload: { role },
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  return item.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  fires = [];
  resetNetworkBlockCache();
  globalThis.fetch = (async (url: string | URL | Request) => {
    fires.push(String(url));
    return new Response(JSON.stringify({ claude_code_session_id: `cse_audit_${fires.length}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetNetworkBlockCache();
});

describe('a waiting audit role', () => {
  it('is fired only at a surface whose next session is not the author', async () => {
    // Registered second, so a router choosing by order alone would pick the author.
    const other = await surface('other');
    const author = await surface('author');
    const orchestrationId = await packet();
    const binId = await bin(orchestrationId);
    await pass(orchestrationId, author, 'SYNTHESIS', 4);
    await auditItem(orchestrationId, 'PRIMARY');

    // Asked many times, the fire never goes to the author's account.
    for (let tick = 0; tick < 3; tick += 1) await dispatchTick({ burst: 4, projectIds: [projectId] });
    const sent = (await listDispatchesForBin(binId)).filter((one) => one.state === 'SENT');
    expect(sent.length).toBeGreaterThan(0);
    for (const one of sent) expect(one.routineRef).toBe(other.routineRef);
  });

  it('is not fired at all when every surface would present a session already in the round', async () => {
    const author = await surface('author');
    const primary = await surface('primary');
    const orchestrationId = await packet();
    const binId = await bin(orchestrationId);
    await pass(orchestrationId, author, 'SYNTHESIS', 4);
    await pass(orchestrationId, primary, 'AUDIT', 5);
    await auditItem(orchestrationId, 'ADVERSARIAL');

    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(fires).toHaveLength(0);
    const intent = (await listDispatchesForBin(binId))[0]!;
    expect(intent.lastErrorKind).toBe('NO_ELIGIBLE_AUDIT_SESSION');
    // It waits for the first blocking credential to age out, not for a fixed default.
    const expected = Date.parse((await tokenExpiry(author.tokenId))) - ARRIVAL_MARGIN_MS;
    expect(Math.abs(Date.parse(intent.nextAttemptAt) - expected)).toBeLessThan(60_000);
  });

  it('is fired at a surface whose blocking credential ages out before a session could arrive', async () => {
    const author = await surface('author', ARRIVAL_MARGIN_MS / 2);
    const primary = await surface('primary');
    const orchestrationId = await packet();
    const binId = await bin(orchestrationId);
    await pass(orchestrationId, author, 'SYNTHESIS', 4);
    await pass(orchestrationId, primary, 'AUDIT', 5);
    await auditItem(orchestrationId, 'ADVERSARIAL');

    expect((await dispatchTick({ burst: 4, projectIds: [projectId] })).fired).toBe(1);
    const sent = (await listDispatchesForBin(binId)).find((one) => one.state === 'SENT');
    expect(sent?.routineRef).toBe(author.routineRef);
  });

  it('leaves routing untouched when the bin has non-audit work open', async () => {
    const author = await surface('author');
    const orchestrationId = await packet('RESEARCHING');
    await pass(orchestrationId, author, 'SYNTHESIS', 4);
    const row = (await getWorkItemRow(
      (await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', orchestrationId, createdByType: 'SYSTEM', createdById: 'test' })).id,
    ))!;
    const fit = await auditFireFit({
      items: [row],
      candidates: [{ routineId: author.routineId, workerId: author.workerId, accountId: author.accountId, connectorId: author.connectorId }],
    });
    expect(fit.applies).toBe(false);
  });

  it('changes nothing about the floor: the author is still refused at the claim', async () => {
    const author = await surface('author');
    const orchestrationId = await packet();
    await pass(orchestrationId, author, 'SYNTHESIS', 4);
    const row = (await getWorkItemRow(await auditItem(orchestrationId, 'PRIMARY')))!;
    const verdict = await auditAdmission({
      workerId: author.workerId,
      routineId: author.routineId,
      accountId: author.accountId,
      sessionRef: author.tokenId,
    })(row);
    expect(verdict.ok).toBe(false);
    expect(verdict.sessionBlocked).toBe(true);
  });
});

async function tokenExpiry(id: string): Promise<string> {
  const row = await getDb().get<{ expires_at: string }>('SELECT expires_at FROM oauth_tokens WHERE id = ?', [id]);
  return row!.expires_at;
}

describe('the refire guard', () => {
  it('counts only fires since the bin last made progress', async () => {
    const orchestrationId = await packet('RESEARCHING');
    const binId = await bin(orchestrationId);
    const earlier = new Date(Date.now() - 10 * 60_000).toISOString();
    for (let gen = 0; gen < BIN_REFIRE_LIMIT; gen += 1) {
      await getDb().run(
        `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
           next_attempt_at, routine_id, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, 'SENT', 1, 5, ?, NULL, ?, ?, ?)`,
        [newId('bdi'), binId, gen, earlier, earlier, earlier, earlier],
      );
    }
    expect(await recentFiresForBin(binId)).toBe(BIN_REFIRE_LIMIT);

    // A session those fires started finished an item in the bin afterwards.
    const item = await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', orchestrationId, createdByType: 'SYSTEM', createdById: 'test' });
    await getDb().run('UPDATE work_items SET bin_id = ? WHERE id = ?', [binId, item.id]);
    const ended = new Date(Date.now() - 5 * 60_000).toISOString();
    const finisher = await createWorker({ name: `finisher-${tag()}`, createdByType: 'SYSTEM', createdById: 'test' });
    await getDb().run(
      `INSERT INTO work_leases (id, work_item_id, project_id, attempt_number, worker_id, lease_generation, claimed_at, expires_at, ended_at, outcome)
       VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, 'SUCCEEDED')`,
      [newId('wls'), item.id, projectId, finisher.id, earlier, ended, ended],
    );
    expect(await recentFiresForBin(binId)).toBe(0);
  });
});

describe('assignment', () => {
  it('reaches an admissible bin past the first page of refused ones', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) ids.push(await bin(null));
    const target = ids[ids.length - 1]!;
    const worker = await createWorker({ name: `pager-${tag()}`, createdByType: 'SYSTEM', createdById: 'test' });
    const assigned = await assignNextBin({
      workerId: worker.id,
      projectIds: [projectId],
      admit: async (candidate) =>
        candidate.id === target ? { ok: true } : { ok: false, quiet: true, reason: 'not this one' },
    });
    expect(assigned?.bin.id).toBe(target);
  });

  it('offers a packet being audited before older fresh research at the same priority', async () => {
    const fresh = await bin(await packet('RESEARCHING'));
    const auditing = await bin(await packet('AUDITING'));
    const worker = await createWorker({ name: `stage-${tag()}`, createdByType: 'SYSTEM', createdById: 'test' });
    const assigned = await assignNextBin({ workerId: worker.id, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(auditing);
    expect(fresh).not.toBe(auditing);
  });
});

describe('resumed rounds', () => {
  it('are capped by the fleet, never below the old fixed floor', async () => {
    expect(await liveJudgeRoundCap()).toBeGreaterThanOrEqual(MAX_LIVE_JUDGE_ROUNDS);
  });
});
