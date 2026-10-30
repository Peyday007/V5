import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { parseResult, type Completer, type LaneConfig } from '../server/services/cheap/lane.ts';
import {
  planExecution,
  routeRequest,
  settleUncertain,
  type MethodResult,
} from '../server/services/research/searchRouting/route.ts';

const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1'], dailyBudget: 100, timeoutMs: 1000 };
const method = { id: 'mth_1', looksFor: 'county RFQs for parcel data' };
const result = (id: string, codeVerdict: MethodResult['codeVerdict']): MethodResult => ({
  id,
  source: 'https://example.gov',
  title: `t ${id}`,
  body: 'body',
  codeVerdict,
});

describe('search routing', () => {
  it('creates no Claude job for execution, and routes only uncertain results to the lane', () => {
    const plan = planExecution([result('a', 'MATCH'), result('b', 'NO_MATCH'), result('c', 'UNCERTAIN')]);
    expect(plan.claudeJobs).toBe(0);
    expect(plan.routed.map((one) => one.route)).toEqual(['CODE', 'CODE', 'CHEAP_LANE']);
    expect(plan.routed.every((one) => (one.route as string) !== 'DEVELOP')).toBe(true);
  });

  it('develops only when no stored method exists', () => {
    expect(routeRequest(null)).toBe('DEVELOP');
    expect(routeRequest(method)).toBe('CODE');
  });

  it('refuses off-shape lane answers', () => {
    expect(parseResult('{"verdict":"KEEP","reason":"x"}')).toEqual({ verdict: 'KEEP', reason: 'x' });
    expect(parseResult('{"verdict":"MAYBE"}')).toBeNull();
    expect(parseResult('{"verdict":"KEEP","extra":1}')).toBeNull();
  });

  it('settles uncertain results through the lane and never turns silence into DROP', async () => {
    await freshProject();
    const calls: string[] = [];
    const completer: Completer = async (_c, model) => {
      calls.push(model);
      return '{"verdict":"KEEP","reason":"looks right"}';
    };
    const settled = await settleUncertain(method, [result('a', 'MATCH'), result('c', 'UNCERTAIN')], { config, completer });
    expect(calls).toEqual(['m1']);
    expect(settled).toEqual([
      { id: 'a', verdict: 'KEEP', by: 'CODE', reason: expect.any(String) },
      { id: 'c', verdict: 'KEEP', by: 'CHEAP_LANE', reason: 'looks right' },
    ]);
    const off = await settleUncertain(method, [result('d', 'UNCERTAIN')], { config: null });
    expect(off[0]).toMatchObject({ verdict: 'UNSURE', by: 'NONE' });
  });
});
