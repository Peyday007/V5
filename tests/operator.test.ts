/**
 * Brain's operator (§106): the moot rule, the bounded actions, the operator's
 * authority on the MCP door, its memory, and the stream Brain reads back.
 *
 * Production, 2026-11-12: the $10K goal read BLOCKED on four "accept a report
 * with unresolved questions" cards whose missions had moved on. Brain's routine
 * decision answered each, the answer failed ("the mission moved out of Needs You
 * before the answer could be applied"), the failure reopened the card, and the
 * next tick answered it again — for four days.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { askHuman, getHumanRequest, getMission } from '../server/repos/russellMissions.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { launch } from '../server/services/russell/launch.ts';
import { getDb } from '../server/db/database.ts';
import { NEEDS_HUMAN_CHOICES } from '../server/services/russell/needsHuman.ts';
import { moot, operatorBrief, operatorDue, operatorModels, OPERATOR_TOOL_NAMES } from '../server/domain/operator.ts';
import { readRequests, withdrawMootRequest } from '../server/services/operator/actions.ts';
import { validateFix } from '../server/services/operator/factory.ts';
import { isMemoryName, readOperatorMemory, storeOperatorMemory, startOperatorRun } from '../server/repos/operator.ts';
import { ensureOperatorIdentity, parseOperatorStream } from '../server/services/operator/run.ts';
import { findTool } from '../server/mcp/tools.ts';
import { OPERATOR_SCOPES, type Principal } from '../server/domain/types.ts';

describe('moot', () => {
  const base = { resumeKey: 'russell:x', missionId: 'rms_1', packetStatus: 'NEEDS_HUMAN' };
  it('is moot once the mission has left NEEDS_HUMAN, whatever it moved to', () => {
    for (const state of ['RUNNING', 'WAITING', 'DONE', 'FAILED', 'CANCELLED']) {
      expect(moot({ ...base, missionState: state }).moot).toBe(true);
    }
  });
  it('is not moot while the mission still waits on the card, or when it cannot be read', () => {
    expect(moot({ ...base, missionState: 'NEEDS_HUMAN' }).moot).toBe(false);
    expect(moot({ ...base, missionState: null }).moot).toBe(false);
    expect(moot({ ...base, missionId: null, missionState: null }).moot).toBe(false);
  });
  it('never touches a card that is not about a research mission', () => {
    expect(moot({ ...base, resumeKey: 'capability-authority:x', missionState: 'DONE' }).moot).toBe(false);
    expect(moot({ ...base, resumeKey: 'cash-reconsider:x', missionState: 'DONE' }).moot).toBe(false);
  });
});

describe('cadence, models, brief', () => {
  it('runs when due and never overlaps a run', () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(operatorDue({ lastStartedAt: null, running: false, nowMs: now, intervalMinutes: 60 })).toBe(true);
    expect(operatorDue({ lastStartedAt: '2026-11-12T09:30:00Z', running: false, nowMs: now, intervalMinutes: 60 })).toBe(false);
    expect(operatorDue({ lastStartedAt: '2026-11-12T08:59:00Z', running: false, nowMs: now, intervalMinutes: 60 })).toBe(true);
    expect(operatorDue({ lastStartedAt: null, running: true, nowMs: now, intervalMinutes: 60 })).toBe(false);
  });
  it('thinks with capacity Brain already has: the free switchboard first, the GPU last', () => {
    const models = operatorModels({
      lane: { url: 'http://northline-cheap.flycast/v1', key: 'k', models: ['free-combo'] },
      pod: { url: 'https://pod-8000.proxy.runpod.net', key: 'p', model: 'Qwen/Qwen3-4B' },
    });
    expect(models.map((m) => m.label)).toEqual(['free:free-combo', 'gpu:Qwen/Qwen3-4B']);
    expect(models[1]!.baseUrl).toBe('https://pod-8000.proxy.runpod.net/v1');
    expect(operatorModels({ lane: { url: 'http://x', key: null, models: ['auto'] }, pod: null }).map((m) => m.baseUrl)).toEqual(['http://x/v1']);
    expect(operatorModels({ lane: null, pod: null })).toEqual([]);
  });
  it('the brief names only tools the operator is given', () => {
    const brief = operatorBrief({ nowIso: '2026-11-12T00:00:00Z', runId: 'opr_x' });
    for (const name of brief.match(/brain_operator_[a-z_]+/g) ?? []) {
      expect(OPERATOR_TOOL_NAMES as readonly string[]).toContain(name);
    }
    for (const name of OPERATOR_TOOL_NAMES) expect(findTool(name)).not.toBeNull();
  });
});

describe('the stream Brain reads back', () => {
  it('keeps every tool event and the last result', () => {
    const text = [
      '{"type":"system","model":"m"}',
      '{"type":"heartbeat","at":1}',
      '{"type":"tool","tool":"mcp__brain__brain_operator_goals","ok":true}',
      'not json',
      '{"type":"tool","tool":"mcp__brain__brain_operator_submit_fix","ok":false}',
      '{"type":"result","final":"done","error":null,"model":"m","memory":{"memories/MEMORY.md":"x"}}',
    ].join('\n');
    const parsed = parseOperatorStream(text);
    expect(parsed.final).toBe('done');
    expect(parsed.toolCalls).toEqual([
      { tool: 'mcp__brain__brain_operator_goals', ok: true },
      { tool: 'mcp__brain__brain_operator_submit_fix', ok: false },
    ]);
    expect(parsed.memory).toEqual({ 'memories/MEMORY.md': 'x' });
  });
  it('a stream with no result is a failure, not a success', () => {
    expect(parseOperatorStream('{"type":"tool","tool":"t","ok":true}').error).toMatch(/without a result/);
  });
});

describe('a fix sent to Factory must be buildable', () => {
  const good = {
    title: 'Moot requests reopen for ever',
    problem: 'A card whose mission has left NEEDS_HUMAN is answered, fails to apply, and is reopened every tick.',
    evidence: 'rhr_4efe387d8e1d47109095: "the mission moved out of Needs You before the answer could be applied"',
    ownerPaths: ['server/services/russell/needsHuman.ts'],
    acceptance: 'A test shows an answered card whose mission is RUNNING is withdrawn, not reopened.',
    runId: null,
  };
  it('accepts a complete description', () => expect(validateFix(good)).toBeNull());
  it('refuses thin or escaping descriptions', () => {
    expect(validateFix({ ...good, evidence: 'trust me' })).toMatch(/evidence/);
    expect(validateFix({ ...good, ownerPaths: [] })).toMatch(/owner_paths/);
    expect(validateFix({ ...good, ownerPaths: ['../etc/passwd'] })).toMatch(/not a repository-relative/);
    expect(validateFix({ ...good, ownerPaths: ['/abs/path.ts'] })).toMatch(/not a repository-relative/);
  });
});

describe('with a database', () => {
  let projectId = '';
  let missionId = '';

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    const layerId = (await fixture.layerByName('Monetization Logic')).id;
    const userId = (
      await createUser({ email: `op-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })
    ).id;
    await createGoal({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'standing', allowedWork: ['RESEARCH'], maxMissions: 1, maxFragments: 1, maxConcurrent: 1, maxProbes: 1 });
    const captured = await capture({ title: 'Florida licensing', statement: 'establish the Florida broker licence position', projectId, visibility: 'SHARED' });
    const launched = await launch({
      projectId,
      layerId,
      candidateId: captured.candidate!.id,
      visibility: 'SHARED',
      title: 'Florida broker licensing',
      assignment: 'Under Florida law as in force in 2026, is a broker licence required?',
      objective: 'Settle the Florida position.',
      whyNow: 'The layer names Florida as open.',
      acceptableSources: ['Florida Statutes'],
      excludedSources: [],
      evidence: ['the exact section'],
      startedBy: { kind: 'PERSON', id: userId },
      envelopeId: 'RUSSELL_STATE_LICENSING_V1',
      authorizedBy: userId,
    });
    missionId = launched.mission!.id;
  });

  async function card(): Promise<string> {
    const { request } = await askHuman({
      projectId,
      missionId,
      authorityNeeded: 'Deciding whether this project accepts a report with unresolved questions in it',
      whyNotRussell: 'y',
      choices: [NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
      resumeKey: `russell:${missionId}`,
    });
    return request.id;
  }

  it('withdraws a card whose mission moved on, keeps the row, and records the action', async () => {
    const id = await card();
    await getDb().run("UPDATE russell_missions SET state = 'RUNNING', waiting_on = NULL WHERE id = ?", [missionId]);
    const reading = (await readRequests(projectId)).find((one) => one.requestId === id)!;
    expect(reading.moot).toBe(true);
    const result = await withdrawMootRequest({ requestId: id, runId: null, projectIds: [projectId] });
    expect(result.ok).toBe(true);
    expect((await getHumanRequest(id))!.state).toBe('WITHDRAWN');
    const events = await getDb().all<{ payload: string }>("SELECT payload FROM project_events WHERE event_type = 'OPERATOR_WITHDREW_MOOT_REQUEST' AND project_id = ?", [projectId]);
    expect(events).toHaveLength(1);
  });

  it('refuses while the mission still waits on the card, and outside the projects it directs', async () => {
    const id = await card();
    await getDb().run("UPDATE russell_missions SET state = 'NEEDS_HUMAN', waiting_on = 'HUMAN' WHERE id = ?", [missionId]);
    expect((await withdrawMootRequest({ requestId: id, runId: null, projectIds: [projectId] })).ok).toBe(false);
    await getDb().run("UPDATE russell_missions SET state = 'RUNNING', waiting_on = NULL WHERE id = ?", [missionId]);
    expect((await withdrawMootRequest({ requestId: id, runId: null, projectIds: ['prj_other'] })).ok).toBe(false);
    expect((await getHumanRequest(id))!.state).toBe('OPEN');
    expect((await getMission(missionId))!.state).toBe('RUNNING');
  });

  it('acting needs operator:act; an ordinary research worker is refused the same way as a missing project', async () => {
    const tool = findTool('brain_operator_continue_idle')!;
    const worker: Principal = {
      type: 'WORKER', id: 'wkr_x', handle: 'w', displayName: 'w', isBrainAdmin: false, mustChangePassword: false,
      credentialId: 'wcr_x', authMethod: 'WORKER_CREDENTIAL' as Principal['authMethod'], requestId: 'r',
      memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_x', role: null, scopes: ['project:read', 'queue:read'], active: true } as unknown as Principal['memberships'][number]],
    };
    await expect(tool.run({}, { principal: worker, requestId: 'r' })).rejects.toThrow();
    const operator: Principal = { ...worker, memberships: [{ ...worker.memberships[0]!, scopes: [...OPERATOR_SCOPES] }] };
    const out = await findTool('brain_operator_history')!.run({}, { principal: operator, requestId: 'r' });
    expect(out.value).toHaveProperty('runs');
  });

  it('the operator identity reaches every project with the operator scopes only', async () => {
    const workerId = await ensureOperatorIdentity();
    const rows = await getDb().all<{ scopes: string }>("SELECT scopes FROM project_memberships WHERE principal_type = 'WORKER' AND principal_id = ? AND project_id = ?", [workerId, projectId]);
    expect(JSON.parse(rows[0]!.scopes)).toEqual([...OPERATOR_SCOPES]);
    expect(await ensureOperatorIdentity()).toBe(workerId);
  });

  it('memory is Brain rows: replaced by each run, bounded, and only memory or skill files', async () => {
    const run = await startOperatorRun('m');
    await storeOperatorMemory(run.id, { 'memories/MEMORY.md': 'a', 'skills/withdraw-moot/SKILL.md': 'b', '../etc/passwd': 'x', 'memories/notes.txt': 'y' });
    expect(await readOperatorMemory()).toEqual({ 'memories/MEMORY.md': 'a', 'skills/withdraw-moot/SKILL.md': 'b' });
    await storeOperatorMemory(run.id, { 'memories/MEMORY.md': 'c' });
    expect(await readOperatorMemory()).toEqual({ 'memories/MEMORY.md': 'c' });
    expect(isMemoryName('skills/../x/SKILL.md')).toBe(false);
  });
});
