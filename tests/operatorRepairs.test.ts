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

  it('serves every read-only operator tool to a reader, and refuses a non-member exactly as a missing thing', async () => {
    const reader = principal(projectId, ['project:read']);
    for (const name of ['brain_operator_integrations', 'brain_operator_history', 'brain_operator_deficiencies', 'brain_operator_engineering']) {
      const out = await findTool(name)!.run({}, { principal: reader, requestId: 'r' });
      expect(out.value, name).toBeTruthy();
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

  it("refuses one goal's lessons outside the reader's projects the same way as a goal that does not exist", async () => {
    const other = (await freshProject()).project.id;
    const g = await createWorkstream({ projectId: other, title: 'elsewhere', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: null });
    const reader = principal(projectId, ['project:read']);
    const forbidden = await findTool('brain_operator_history')!.run({ goal_id: g.id }, { principal: reader, requestId: 'r' }).then(() => null, (e: Error) => e.message);
    const absent = await findTool('brain_operator_history')!.run({ goal_id: 'wst_nothing' }, { principal: reader, requestId: 'r' }).then(() => null, (e: Error) => e.message);
    expect(forbidden).not.toBeNull();
    expect(forbidden).toBe(absent);
    const owner = principal(other, ['project:read']);
    expect((await findTool('brain_operator_history')!.run({ goal_id: g.id }, { principal: owner, requestId: 'r' })).value).toHaveProperty('learnings');
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
