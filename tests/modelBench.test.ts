import { describe, expect, it } from 'vitest';
import {
  GOAL_ID,
  chooseModel,
  firstJson,
  summarize,
  taskAssumption,
  taskToolPlan,
  taskToolRecovery,
  type ChatFn,
  type ChatResult,
  type Message,
} from '../server/services/cheap/modelBench.ts';

const reply = (over: Partial<ChatResult>): ChatResult => ({ content: '', toolCalls: [], ms: 10, completionTokens: 5, error: null, ...over });
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`) => ({ id, name, args, raw: JSON.stringify(args) });

/** A competent operator: reads the goal (again after "busy"), its plan, withdraws the moot request, reports. */
function competent(): ChatFn {
  return async (messages: Message[]) => {
    const tools = messages.filter((m) => m['role'] === 'tool').map((m) => String(m['content']));
    const last = tools[tools.length - 1] ?? '';
    if (tools.length === 0) return reply({ toolCalls: [call('brain_operator_goal', { goal_id: GOAL_ID })] });
    if (last.includes('temporarily busy')) return reply({ toolCalls: [call('brain_operator_goal', { goal_id: GOAL_ID }, 'c2')] });
    if (last.includes('"requests"')) {
      const moot = /"id":"(rhr_[a-z0-9]+)","question":"Accept/.exec(last)![1]!;
      return reply({ toolCalls: [call('brain_operator_goal_plan', { goal_id: GOAL_ID }), call('brain_operator_withdraw_moot_request', { request_id: moot })] });
    }
    return reply({ content: 'Report: withdrew the moot request; the plan needs buyers and prices.' });
  };
}

describe('model benchmark on Brain tasks (§108)', () => {
  it('scores a competent operator fully on the tool plan and the recovery', async () => {
    expect((await taskToolPlan(competent())).score).toBe(1);
    const recovery = await taskToolRecovery(competent());
    expect(recovery.score).toBe(1);
  });

  it('scores an operator that invents ids and writes tool calls as text low', async () => {
    const inventor: ChatFn = async (messages) =>
      messages.some((m) => m['role'] === 'tool')
        ? reply({ content: 'done' })
        : reply({ toolCalls: [call('brain_operator_goal', { goal_id: 'wst_dummy' })] });
    const r = await taskToolPlan(inventor);
    expect(r.score).toBeLessThan(0.5);
    expect(r.notes.join(' ')).toMatch(/invented ids: wst_dummy/);
    const texter: ChatFn = async () => reply({ content: 'brain_operator_goal({"goal_id":"x"})' });
    expect((await taskToolPlan(texter)).notes.join(' ')).toMatch(/written as text/);
  });

  it('grades a judged answer by code', async () => {
    const good: ChatFn = async () => reply({ content: '```json\n{"flawed":true,"assumption":"treats a p50 from coverage of assumed inputs as a probability; reach is 1.5%","correct_reading":"not established"}\n```' });
    expect((await taskAssumption(good)).score).toBe(1);
    const bad: ChatFn = async () => reply({ content: '{"flawed":false,"assumption":"","correct_reading":"fine"}' });
    expect((await taskAssumption(bad)).score).toBeLessThan(0.5);
    expect(firstJson('prose {"a":{"b":"}"}} tail')).toEqual({ a: { b: '}' } });
  });

  it('chooses by tool gate, then quality per dollar', () => {
    const t = (task: string, score: number) => ({ task, score, toolCalls: 2, toolOk: 2, ms: 1000, completionTokens: 1, error: null, notes: [] });
    const a = summarize({ label: 'a', url: '', key: null, model: 'a', usdPerHour: 0.16 }, [t('tool_plan', 1), t('tool_recovery', 1), t('diagnose', 0.9)], { requests: 6, ok: 6, wallMs: 6000 });
    const b = summarize({ label: 'b', url: '', key: null, model: 'b', usdPerHour: 0.33 }, [t('tool_plan', 1), t('tool_recovery', 1), t('diagnose', 0.95)], { requests: 6, ok: 6, wallMs: 6000 });
    const c = summarize({ label: 'c', url: '', key: null, model: 'c', usdPerHour: 0.1 }, [t('tool_plan', 0.2), t('tool_recovery', 0.2), t('diagnose', 1)], null);
    expect(chooseModel([a, b, c]).winner?.label).toBe('a');
    expect(chooseModel([c]).winner).toBeNull();
  });
});
