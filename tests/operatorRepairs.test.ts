/**
 * Repairs to Brain's operator (§106, §108, §109), each from what Hermes' own runs
 * showed on production, 2026-11-13:
 *
 *   H-3  reading capacity, deficiencies, history, engineering and integrations
 *        needed operator:act; capacity and continue_idle ran past the 180 s
 *        MCP call limit.
 *   H-4  MODEL, STRATEGY, EVIDENCE, PERSON and WATCH wrote a lesson and nothing
 *        else, and the operator reported work "queued" that nothing ran.
 *   H-5  the decision challenger put the GPU's 4B model first and could run for
 *        360 s inside a 180 s call.
 *   H-6  a run's success was credited to the first model in its chain even when
 *        a fallback did the work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], answer: null as null | { bucketId: string; candidateId: string; round: number } }));
vi.mock('../server/services/cash/discovery.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/cash/discovery.ts')>();
  return {
    ...original,
    openGoalDiscovery: vi.fn(async (input: Record<string, unknown>) => {
      discovery.calls.push(input);
      return discovery.answer;
    }),
  };
});

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream, listLinks } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { OPERATOR_SCOPES, type Principal } from '../server/domain/types.ts';
import { cachedUtilization, forgetUtilization, utilizationWithin, type PoolReading } from '../server/services/engineering/watchdog.ts';
import { continueIdleCapacity, forgetContinuation } from '../server/services/operator/actions.ts';
import { challengeDecision, challengerModels, parameterBillions } from '../server/services/operator/decisions.ts';
import { creditedModel, operatorModelRecord } from '../server/services/operator/run.ts';
import { finishOperatorRun, startOperatorRun } from '../server/repos/operator.ts';
import { recordEvent } from '../server/repos/events.ts';
import type { OperatorModel } from '../server/domain/operator.ts';

const pool = (name: PoolReading['pool'], waiting = 1): PoolReading => ({ pool: name, waiting, running: 0, capacity: 2, idle: waiting > 0, because: 'test' });
const later = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

function principal(projectId: string, scopes: string[]): Principal {
  return {
    type: 'WORKER', id: 'wkr_r', handle: 'r', displayName: 'r', isBrainAdmin: false, mustChangePassword: false,
    credentialId: 'wcr_r', authMethod: 'WORKER_CREDENTIAL' as Principal['authMethod'], requestId: 'r',
    memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_r', role: null, scopes, active: true } as unknown as Principal['memberships'][number]],
  };
}

describe('H-3: reading operator state needs project:read, not operator:act', () => {
  let projectId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('serves the project-free read tools to a reader, keeps Brain-wide records behind operator:act, and refuses alike', async () => {
    const reader = principal(projectId, ['project:read']);
    for (const name of ['brain_operator_integrations']) {
      const out = await findTool(name)!.run({}, { principal: reader, requestId: 'r' });
      expect(out.value, name).toBeTruthy();
    }
    // History, deficiencies and engineering carry every project's goals, lessons and events (review F1):
    // a reader of one project gets the same refusal as a stranger.
    for (const name of ['brain_operator_history', 'brain_operator_deficiencies', 'brain_operator_engineering']) {
      const refused = await findTool(name)!.run({}, { principal: reader, requestId: 'r' }).then(() => null, (e: Error) => e.message);
      expect(refused, `${name} must refuse a mere reader`).not.toBeNull();
    }
    const stranger = principal('prj_not_mine', ['project:read']);
    const noScope = principal(projectId, ['queue:read']);
    const errors: string[] = [];
    for (const who of [stranger, noScope]) {
      for (const name of ['brain_operator_capacity', 'brain_operator_integrations', 'brain_operator_history', 'brain_operator_deficiencies', 'brain_operator_engineering']) {
        const error = await findTool(name)!.run({}, { principal: who, requestId: 'r' }).then(() => null, (e: unknown) => e as Error);
        expect(error, `${name} must refuse`).not.toBeNull();
        errors.push(JSON.stringify({ message: error!.message, code: (error as unknown as { code?: unknown }).code }));
      }
    }
    // One shape for every refusal: nothing tells "you may not" from "it is not there".
    expect(new Set(errors).size).toBe(1);
    // Acting still needs operator:act.
    await expect(findTool('brain_operator_continue_idle')!.run({}, { principal: reader, requestId: 'r' })).rejects.toThrow();
  });

  it("refuses one goal's lessons to a reader the same way as a goal that does not exist", async () => {
    const other = (await freshProject()).project.id;
    const g = await createWorkstream({ projectId: other, title: 'elsewhere', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: null });
    const reader = principal(projectId, ['project:read']);
    const forbidden = await findTool('brain_operator_history')!.run({ goal_id: g.id }, { principal: reader, requestId: 'r' }).then(() => null, (e: Error) => e.message);
    const absent = await findTool('brain_operator_history')!.run({ goal_id: 'wst_nothing' }, { principal: reader, requestId: 'r' }).then(() => null, (e: Error) => e.message);
    expect(forbidden).not.toBeNull();
    expect(forbidden).toBe(absent);
  });
});

describe('H-3: capacity answers inside the call limit', () => {
  beforeEach(() => forgetUtilization());

  it('serves a live reading when it finishes within the bound', async () => {
    const reading = await utilizationWithin(1_000, async () => [pool('ROUTINES')]);
    expect(reading).toMatchObject({ source: 'LIVE', ageSeconds: 0 });
    expect(reading.pools!.map((p) => p.pool)).toEqual(['ROUTINES']);
    expect(cachedUtilization()!.pools.map((p) => p.pool)).toEqual(['ROUTINES']);
  });

  it('serves the last reading with its age when a live read is slow, and the slow read becomes the next answer', async () => {
    await utilizationWithin(1_000, async () => [pool('ROUTINES', 3)]);
    const started = Date.now();
    const slow = await utilizationWithin(50, () => later(300, [pool('FACTORY', 7)]));
    expect(Date.now() - started).toBeLessThan(250);
    expect(slow.source).toBe('CACHED');
    expect(slow.pools![0]!.pool).toBe('ROUTINES');
    expect(slow.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(slow.note).toMatch(/did not finish within/);
    // A second caller during the slow read waits on it rather than starting another.
    let second = 0;
    await utilizationWithin(10, async () => {
      second += 1;
      return [];
    });
    expect(second).toBe(0);
    await later(350, null);
    expect(cachedUtilization()!.pools[0]!.pool).toBe('FACTORY');
  });

  it('says plainly when it holds no reading at all', async () => {
    const none = await utilizationWithin(20, () => later(200, [pool('ROUTINES')]));
    expect(none).toMatchObject({ source: 'NONE', pools: null, readAt: null });
    await later(250, null);
  });
});

describe('H-3: continue_idle starts its pass in the background and returns what it started', () => {
  beforeEach(() => forgetContinuation());

  it('reports a pass that finished in time with what it continued', async () => {
    const out = await continueIdleCapacity('opr_t', { waitMs: 1_000, pass: async () => ({ pools: [pool('FACTORY')], recorded: ['FACTORY'], continued: ['FACTORY'] }) });
    expect(out).toMatchObject({ finished: true, continued: ['FACTORY'], recordedIdle: ['FACTORY'] });
  });

  it('returns at once while a slow pass runs, claims nothing moved, never starts a second, and reports how it ended', async () => {
    let release: (v: { pools: PoolReading[]; recorded: string[]; continued: string[] }) => void = () => undefined;
    const pass = () => new Promise<{ pools: PoolReading[]; recorded: string[]; continued: string[] }>((resolve) => { release = resolve; });
    const started = Date.now();
    const first = await continueIdleCapacity('opr_t', { waitMs: 30, pass });
    expect(Date.now() - started).toBeLessThan(500);
    expect(first).toMatchObject({ finished: false, running: true });
    expect(first['continued']).toBeUndefined();
    let again = 0;
    const second = await continueIdleCapacity('opr_t', { waitMs: 30, pass: async () => { again += 1; return { pools: [], recorded: [], continued: [] }; } });
    expect(second).toMatchObject({ started: false, running: true });
    expect(again).toBe(0);
    release({ pools: [pool('ROUTINES')], recorded: [], continued: ['ROUTINES'] });
    await later(10, null);
    const third = await continueIdleCapacity('opr_t', { waitMs: 1_000, pass: async () => ({ pools: [], recorded: [], continued: [] }) });
    expect(third['previous']).toMatchObject({ continued: ['ROUTINES'], error: null });
  });
});

describe('H-4: every intervention says what it started and what it only recorded', () => {
  let projectId = '';
  let userId = '';
  beforeEach(async () => {
    discovery.calls.length = 0;
    discovery.answer = null;
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `rep-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  async function goal(): Promise<string> {
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId })).ok).toBe(true);
    return g.id;
  }

  const request = (over: Record<string, unknown> = {}) => ({
    goalId: null as string | null,
    deficiency: 'REPEATED_STRATEGIC_MISTAKE',
    title: 'The search keeps asking the same lens',
    observed: 'Every round for the goal returned openings the plan cannot use, and the next round asked the same way again.',
    evidence: 'goal_plan_readings: NOT_VIABLE three times; rounds mx-1, mx-2 found nothing usable',
    cause: null as string | null,
    ownerPaths: [] as string[],
    recurrence: 3,
    expectedBenefit: 'A round that can find an opening the plan can use.',
    acceptance: 'A round asked from a different angle returns a usable opening.',
    metric: null,
    blocksGoal: true,
    share: 0.4,
    proposed: 'STRATEGY',
    runId: 'opr_t',
    ...over,
  });

  it('STRATEGY opens a research round for the goal through the goal-round door, and links it', async () => {
    const goalId = await goal();
    discovery.answer = { bucketId: `goal-${goalId}-remote`, candidateId: 'rcd_round1', round: 1 };
    const { commission } = await import('../server/services/operator/director.ts');
    const result = await commission(request({ goalId }));
    expect(result.intervention).toBe('STRATEGY');
    expect(result.started).toEqual(['goal research round rcd_round1']);
    expect(result.roundCandidateId).toBe('rcd_round1');
    expect(result.reason).toContain('opened research round 1');
    expect(discovery.calls).toHaveLength(1);
    expect(String(discovery.calls[0]!['diagnosis'])).toContain('The search keeps asking the same lens');
    expect((discovery.calls[0]!['goal'] as { id: string }).id).toBe(goalId);
    const links = await listLinks(goalId);
    expect(links.some((l) => l.ref === 'rcd_round1' && l.relation === 'PURSUES')).toBe(true);
  });

  it('says nothing was opened when the door refuses, and never implies queued work', async () => {
    const goalId = await goal();
    const { commission } = await import('../server/services/operator/director.ts');
    const result = await commission(request({ goalId }));
    expect(result.started).toEqual([]);
    expect(result.reason).toContain('none opened now');
    expect(result.recordedOnly).toEqual(expect.arrayContaining(['a request for the next goal pass to re-read the plan']));
    expect(result.reason).not.toMatch(/queued/i);
  });

  it('EVIDENCE asks the goal search again beside the cause research', async () => {
    const brain = (await getProjectBySlug('brain-architecture'))?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brain, name: 'Methods', orderIndex: 0 });
    const admin = `admin-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await createUser({ email: admin, displayName: 'Admin', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setImprovementSwitch(true, admin, 'test');
    const goalId = await goal();
    discovery.answer = { bucketId: `goal-${goalId}-x`, candidateId: 'rcd_ev', round: 2 };
    const { commission } = await import('../server/services/operator/director.ts');
    const result = await commission(request({ goalId, proposed: 'EVIDENCE' }));
    expect(result.intervention).toBe('EVIDENCE');
    expect(result.started).toContain('goal research round rcd_ev');
    expect(result.reason).toContain('Goal research: opened research round 2');
  });

  it('MODEL, PERSON and WATCH start nothing and say so; MODEL names why no bench request exists', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const model = await commission(request({ proposed: 'MODEL', model_limited: true, modelLimited: true }));
    expect(model.intervention).toBe('MODEL');
    expect(model.started).toEqual([]);
    expect(model.reason).toContain('nothing started');
    expect(model.reason).toContain('runpod-bench');
    expect(model.recordedOnly![0]).toMatch(/^lesson /);
    const watch = await commission(request({ proposed: 'WATCH', recurrence: 1 }));
    expect(watch.started).toEqual([]);
    expect(watch.reason).toContain('nothing started');
    expect(discovery.calls).toHaveLength(0);
  });
});

describe('H-5: the challenger is the strongest model, never the 4B GPU model, and the challenge is bounded', () => {
  const m = (label: string, model: string): OperatorModel => ({ label, baseUrl: 'http://x/v1', model, apiKey: null });
  const ranked = [m('free:auto/best-coding', 'auto/best-coding'), m('gpu:Qwen/Qwen3-4B-AWQ', 'Qwen/Qwen3-4B-AWQ'), m('free:brain-a', 'brain-a')];

  it('keeps the ranked order (best first) and drops the weak GPU model', () => {
    expect(challengerModels(ranked).map((x) => x.label)).toEqual(['free:auto/best-coding', 'free:brain-a']);
    expect(challengerModels([m('gpu:Qwen/Qwen3-14B', 'Qwen/Qwen3-14B')]).map((x) => x.label)).toEqual(['gpu:Qwen/Qwen3-14B']);
    expect(parameterBillions('Qwen/Qwen3-4B-AWQ')).toBe(4);
    expect(parameterBillions('gpt-oss-20b')).toBe(20);
    expect(parameterBillions('auto/best-coding')).toBeNull();
  });

  it('asks the best model first and never the 4B', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      asked.push((JSON.parse(init.body) as { model: string }).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"PROCEED","hiddenAssumptions":[],"missingVariables":[],"strongerAlternative":null,"why":"ok"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const input = { kind: 'OTHER', goalId: null, question: 'q', options: [], chosen: 0, assumptions: [], whyNotHighestEv: null, prediction: { outcome: 'o', probability: 0.5, horizonDays: 1 }, irreversible: true } as never;
    await challengeDecision(input, { ok: true, problems: [], highImpact: true, options: [] } as never, ranked, fetchImpl);
    expect(asked[0]).toBe('auto/best-coding');
    expect(asked).not.toContain('Qwen/Qwen3-4B-AWQ');
  });

  it('ends every attempt inside the budget, however many models hang', async () => {
    let calls = 0;
    const hang = ((_url: string, init: { signal: AbortSignal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as unknown as typeof fetch;
    const many = [m('free:a', 'a'), m('free:b', 'b'), m('free:c', 'c'), m('free:d', 'd')];
    const input = { kind: 'OTHER', goalId: null, question: 'q', options: [], chosen: 0, assumptions: [], whyNotHighestEv: null, prediction: { outcome: 'o', probability: 0.5, horizonDays: 1 }, irreversible: true } as never;
    const started = Date.now();
    const challenge = await challengeDecision(input, { ok: true, problems: [], highImpact: true, options: [] } as never, many, hang, { budgetMs: 400, minAttemptMs: 50 });
    const elapsed = Date.now() - started;
    expect(challenge).toBeNull();
    expect(calls).toBe(1); // the first attempt is given the whole remaining budget, and nothing starts after it
    expect(elapsed).toBeLessThan(800);
  });
});

describe('H-6: a run is credited to the model that did the work', () => {
  it('matches the reported served model to its label in the chain, else the first', () => {
    const chain = 'free:auto/best-coding → gpu:Qwen/Qwen3-4B-AWQ';
    expect(creditedModel(chain, 'Qwen/Qwen3-4B-AWQ')).toBe('gpu:Qwen/Qwen3-4B-AWQ');
    expect(creditedModel(chain, 'auto/best-coding')).toBe('free:auto/best-coding');
    expect(creditedModel(chain, null)).toBe('free:auto/best-coding');
    expect(creditedModel(chain, 'something-else')).toBe('free:auto/best-coding');
    expect(creditedModel('', 'x')).toBeNull();
  });

  it('reads the reported model from each run\'s finished event', async () => {
    const projectId = (await freshProject()).project.id;
    await getDb().run('DELETE FROM operator_runs', []);
    const run = await startOperatorRun('free:auto/best-coding → gpu:Qwen/Qwen3-4B-AWQ');
    await finishOperatorRun({ id: run.id, state: 'DONE', summary: 'ok', toolCalls: [], error: null });
    const anchor = (await getDb().get<{ id: string }>('SELECT id FROM projects ORDER BY created_at, id LIMIT 1', []))!.id;
    void projectId;
    await recordEvent({ projectId: anchor, entityType: 'PROJECT', entityId: anchor, eventType: 'OPERATOR_RUN_FINISHED', payload: { runId: run.id, ok: true, model: 'Qwen/Qwen3-4B-AWQ' } });
    const record = await operatorModelRecord();
    expect(record.get('gpu:Qwen/Qwen3-4B-AWQ')).toEqual({ runs: 1, ok: 1 });
    expect(record.get('free:auto/best-coding')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/* Surge B: Hermes directs an intelligence recovery through Brain's own rows  */
/* ------------------------------------------------------------------------- */

describe('Surge B: a standing mission, a findings inventory, and the next attempt', () => {
  let projectId = '';
  const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('offers the new tools to Hermes, with the brief naming them, from the one registry', async () => {
    const { OPERATOR_TOOL_NAMES, operatorBrief } = await import('../server/domain/operator.ts');
    for (const name of ['brain_operator_inventory', 'brain_operator_reattempt']) {
      expect(OPERATOR_TOOL_NAMES as readonly string[]).toContain(name);
      expect(findTool(name)).not.toBeNull();
      expect(operatorBrief({ nowIso: 'now', runId: 'opr_x' })).toContain(name);
    }
  });

  it('a mission is a register row the brief opens with while it is open; the $10K goal is one goal among goals', async () => {
    const { setMission, closeMission, missionForBrief, openMissions } = await import('../server/services/operator/inventory.ts');
    const { operatorBrief } = await import('../server/domain/operator.ts');
    const key = `SURGE:T${uid()}`;
    expect((await setMission({ key, text: 'too short' }, { runId: null, actor: 'terminal' })).ok).toBe(false);
    expect((await setMission({ key: 'OPERATOR:X', text: 'Recover the intelligence of Brain end to end.' }, { runId: null, actor: 'terminal' })).ok).toBe(false);
    const set = await setMission({ key, text: "Recover Brain's intelligence: inventory every finding and verify each repair." }, { runId: null, actor: 'terminal' });
    expect(set).toMatchObject({ ok: true, created: true });
    const again = await setMission({ key, text: "Recover Brain's intelligence, version two: verify each repair on production." }, { runId: null, actor: 'terminal' });
    expect(again).toMatchObject({ ok: true, created: false });
    expect((await openMissions()).find((m) => m.key === key)?.text).toContain('version two');
    const text = await missionForBrief();
    expect(text).toContain('version two');
    const brief = operatorBrief({ nowIso: 'now', runId: 'opr_x', mission: text, goals: 'GOALS' });
    expect(brief.startsWith('STANDING MISSION')).toBe(true);
    expect(brief).toContain('a cash goal — such as collecting $10,000 of settled cash — is one goal among them');
    // The loop never advances a mission row (it is the operator's record, not engineering work).
    const { advanceNow } = await import('../server/services/improvement/loop.ts');
    expect((await advanceNow(set.ok ? set.mission.candidateId : '')).did).toBeNull();
    expect((await closeMission(key, { runId: null, actor: 'terminal' })).ok).toBe(true);
    expect(await missionForBrief()).not.toContain('version two');
  });

  it('inventory: list for a reader, change only for the operator, refuse incomplete findings, persist with history', async () => {
    const tool = findTool('brain_operator_inventory')!;
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const reader = principal(projectId, ['project:read']);
    const id = `H2-T${uid()}`;
    // Changing needs operator:act; the refusal is the same shape as elsewhere.
    await expect(tool.run({ action: 'upsert', id, capability: 'x', symptom: 'y', evidence: 'z', severity: 'MAJOR' }, { principal: reader, requestId: 'r' })).rejects.toThrow();
    // A new finding needs its fields; a bad id or severity is refused.
    expect((await tool.run({ action: 'upsert', id, capability: 'operator mission' }, { principal: operator, requestId: 'r' })).value).toMatchObject({ ok: false });
    expect((await tool.run({ action: 'upsert', id: 'bad id!', capability: 'a', symptom: 'b', evidence: 'c', severity: 'MAJOR' }, { principal: operator, requestId: 'r' })).value).toMatchObject({ ok: false });
    expect((await tool.run({ action: 'upsert', id, capability: 'a', symptom: 'b', evidence: 'c', severity: 'HUGE' }, { principal: operator, requestId: 'r' })).value).toMatchObject({ ok: false });
    const created = (await tool.run(
      { action: 'upsert', id, capability: 'operator mission input', symptom: 'A run cannot be given the mission.', evidence: 'domain/operator.ts:148; run.ts:243', severity: 'BLOCKING', owner: 'server/domain/operator.ts' },
      { principal: operator, requestId: 'r' },
    )).value as { ok: boolean; created: boolean; candidateId: string; item: { status: string } };
    expect(created).toMatchObject({ ok: true, created: true, item: { status: 'DISCOVERED' } });
    // ROOT_CAUSE_CONFIRMED needs a root cause; then it moves.
    expect((await tool.run({ action: 'set_status', id, status: 'ROOT_CAUSE_CONFIRMED' }, { principal: operator, requestId: 'r' })).value).toMatchObject({ ok: false });
    await tool.run({ action: 'upsert', id, root_cause: 'operatorBrief takes no mission input' }, { principal: operator, requestId: 'r' });
    expect((await tool.run({ action: 'set_status', id, status: 'ROOT_CAUSE_CONFIRMED' }, { principal: operator, requestId: 'r' })).value).toMatchObject({ ok: true, item: { status: 'ROOT_CAUSE_CONFIRMED' } });
    // A reader can list it; the row is in §87's register under SURGE-B:<id>, and the loop leaves it alone.
    const listed = (await tool.run({ action: 'list', id }, { principal: reader, requestId: 'r' })).value as { ok: boolean; item: { status: string }; history: unknown[] };
    expect(listed.item.status).toBe('ROOT_CAUSE_CONFIRMED');
    expect(listed.history.length).toBeGreaterThanOrEqual(3);
    const row = await getDb().get<{ kind: string; weakness_key: string }>('SELECT kind, weakness_key FROM improvement_candidates WHERE id = ?', [created.candidateId]);
    expect(row).toEqual({ kind: 'OPERATOR_INVENTORY', weakness_key: `SURGE-B:${id}` });
    const { advanceNow } = await import('../server/services/improvement/loop.ts');
    expect((await advanceNow(created.candidateId)).did).toBeNull();
    // It reaches the brief.
    const { inventoryBrief } = await import('../server/services/operator/inventory.ts');
    expect(await inventoryBrief()).toContain(id);
  });

  it('VERIFIED_FIXED is refused without a verification reference, and recorded for a fix outside any commission', async () => {
    const tool = findTool('brain_operator_inventory')!;
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const id = `H2-V${uid()}`;
    await tool.run({ action: 'upsert', id, capability: 'runpod ceiling', symptom: 'A 48 GB bench is impossible.', evidence: 'cheap-lane.yml:109', severity: 'MAJOR' }, { principal: operator, requestId: 'r' });
    const run = (args: Record<string, unknown>) => tool.run({ action: 'set_status', id, status: 'VERIFIED_FIXED', ...args }, { principal: operator, requestId: 'r' }).then((o) => o.value as { ok: boolean; reason?: string });
    // No criteria yet.
    expect((await run({ verification: { kind: 'WORKFLOW_RUN', ref: '43399029412', detail: 'runpod-bench ran a 48 GB pod beside production' } })).reason).toMatch(/verification_criteria/);
    await tool.run({ action: 'upsert', id, verification_criteria: 'runpod-bench benches the 48 GB recipe under the raised ceilings' }, { principal: operator, requestId: 'r' });
    expect((await run({})).ok).toBe(false);
    expect((await run({ verification: { kind: 'WORKFLOW_RUN', ref: 'yesterday', detail: 'runpod-bench ran a 48 GB pod beside production' } })).reason).toMatch(/run id/);
    expect((await run({ verification: { kind: 'MEASUREMENT', ref: 'bench', detail: 'it seemed to work well overall today' } })).reason).toMatch(/number/);
    expect((await run({ verification: { kind: 'DEPLOY', ref: 'abc', detail: 'deployed and the operator read it back' } })).reason).toMatch(/sha/);
    const ok = (await tool.run(
      { action: 'set_status', id, status: 'VERIFIED_FIXED', result: 'bench passed', verification: { kind: 'WORKFLOW_RUN', ref: '43399029412', detail: 'runpod-bench ran the 48 GB recipe at $0.33/h beside production' } },
      { principal: operator, requestId: 'r' },
    )).value as { ok: boolean; item: { status: string; verification: Record<string, unknown> } };
    expect(ok.ok).toBe(true);
    expect(ok.item.verification).toMatchObject({ kind: 'WORKFLOW_RUN', ref: '43399029412', source: 'OUTSIDE_COMMISSION' });
    const events = await getDb().all<{ detail: string }>(
      "SELECT e.detail FROM improvement_events e JOIN improvement_candidates c ON c.id = e.candidate_id WHERE c.weakness_key = ? AND e.kind = 'INVENTORY_CHANGED'",
      [`SURGE-B:${id}`],
    );
    expect(events.some((e) => e.detail.includes('43399029412'))).toBe(true);
    // A closed finding leaves the brief's open list.
    const { inventoryBrief } = await import('../server/services/operator/inventory.ts');
    expect(await inventoryBrief()).not.toContain(`- ${id} `);
  });

  it('re-attempt: refused for what is not a commission, still moving, or out of attempts; a failed one gets its next attempt', async () => {
    const admin = `admin-${uid().toLowerCase()}@example.com`;
    await createUser({ email: admin, displayName: 'Admin', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setImprovementSwitch(false, admin, 'test: no Factory submission from this test');
    const { upsertCandidate, decideCandidate, getCandidateByKey } = await import('../server/repos/improvement.ts');
    const tool = findTool('brain_operator_reattempt')!;
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const call = (args: Record<string, unknown>) => tool.run(args, { principal: operator, requestId: 'r' }).then((o) => o.value as { ok: boolean; reason: string; weaknessKey?: string; attempt?: number });
    await expect(tool.run({ candidate_id: 'imp_x', reason: 'Factory failed twice on the same unit.' }, { principal: principal(projectId, ['project:read']), requestId: 'r' })).rejects.toThrow();
    expect((await call({ candidate_id: 'imp_nothing', reason: 'Factory failed twice on the same unit.' })).ok).toBe(false);
    const directive = { origin: 'OPERATOR', runId: null, goalId: null, deficiency: 'RECURRING_OPERATIONAL_FAILURE', intervention: 'ENGINEERING', priority: 5, urgency: 'NORMAL', acceptance: 'a test proves it', expectedBenefit: 'x', evaluation: 'y' };
    const make = async (key: string, attempt = 1) =>
      (
        await upsertCandidate({
          weaknessKey: key, kind: 'OPERATOR:RECURRING_OPERATIONAL_FAILURE', title: 't', problem: 'p', metric: 'READY_OPPORTUNITIES_PER_DAY', downstreamMetric: null,
          ownerComponent: `server/x-${key}.ts`, frequency: 3, denominator: 3, scope: 'GENERAL', severity: 'MEDIUM', evidence: { directive, ownerPaths: [`server/x-${key}.ts`] }, attempt,
        })
      ).candidate;
    // Still moving: building and touched just now.
    const moving = await make(`OPERATOR:T:${uid()}`);
    const refusedMoving = await call({ candidate_id: moving.id, reason: 'I think it is going too slowly.' });
    expect(refusedMoving.ok).toBe(false);
    expect(refusedMoving.reason).toMatch(/stalled only after 24 h/);
    expect((await call({ candidate_id: moving.id, reason: 'short' })).ok).toBe(false);
    // Out of attempts.
    const last = await make(`OPERATOR:T:${uid()}#3`, 3);
    await decideCandidate(last.id, 'REVERTED', 'regressed');
    expect((await call({ candidate_id: last.id, reason: 'The third attempt regressed the metric.' })).reason).toMatch(/was the last/);
    // Failed: decided KEPT_NO_EFFECT → attempt 2, keyed KEY#2, carrying the directive and the operator's reason.
    const base = `OPERATOR:T:${uid()}`;
    const failed = await make(base);
    await decideCandidate(failed.id, 'KEPT_NO_EFFECT', 'no measured effect');
    const out = await call({ candidate_id: failed.id, reason: 'The change shipped and the metric did not move.' });
    expect(out).toMatchObject({ ok: true, weaknessKey: `${base}#2`, attempt: 2 });
    const second = (await getCandidateByKey(`${base}#2`))!;
    expect(second.parentId).toBe(failed.id);
    expect((second.evidence['directive'] as Record<string, unknown>)['minimumModelClass']).toBe('STRONGEST');
    expect(JSON.stringify(second.evidence['methodInadequacy'])).toContain('metric did not move');
    // The same again: a later attempt already exists.
    expect((await call({ candidate_id: failed.id, reason: 'The change shipped and the metric did not move.' })).ok).toBe(false);
  });
});
