/**
 * F9.2 (adversarial findings, 2026-11-15): Brain's reasoning model proposed 16
 * methods on production and all 16 were refused as off-shape, and 2 of 4 calls
 * were lost to the free lane's HTTP 429.
 *
 * The prompt marked a method's design `{...optional}`; models answer an
 * optional object with `null`, `{}` or a placeholder, and the parser read every
 * such method as a malformed design. Every other refusal was silent, so
 * nothing recorded why. Now form is read leniently (case, numeric strings, ids
 * with or without `id:`, an empty optional design), meaning is still refused
 * with a reason for every refusal, the prompt says how to write what it asks
 * for, and a rate-refused call backs off and is asked once more.
 */
import { describe, expect, it } from 'vitest';
import { extractJsonPayload, parseInvented, type InventBrief } from '../server/services/goals/reasoning/directions.ts';
import { inventDirections, inventPrompt } from '../server/services/goals/reasoning/invent.ts';
import type { LaneConfig } from '../server/services/cheap/lane.ts';

const brief: InventBrief = {
  remaining: 1000,
  daysLeft: 10,
  required: 0.9,
  baseline: { reach: 0, settledP50: 0 },
  greedy: { reach: 0, settledP50: 0, changes: [] },
  binding: [],
  structural: false,
  stancesTried: [],
  bestKnown: [],
  operators: [{ key: 'partner:referral-partner', dimension: 'CHANNEL' }, { key: 'timing:deposit', dimension: 'TIMING' }],
  openings: [{ id: 'cop_1', title: 'A', price: 100, close: 0.1, respond: 0.1, volume: 5, daysToCash: 10, outreach: true, agreed: false }],
  designs: { structures: [{ key: 'BROKER', label: 'connect the buyer with a supplier for a commission' }], funding: ['ON_DELIVERY'], aggregation: ['SINGLE'], repeat: ['ONE_OFF'] },
};
const method = (over: Record<string, unknown>) => ({ name: 'M', stance: 'NEW ANGLE', thinking: 'Sees the problem differently.', from: 'BASELINE', program: [{ op: 'FOCUS', count: 1 }], ...over });

describe('the method contract between prompt and parser', () => {
  it('reads an optional design written empty as no design, and the program\'s form leniently', () => {
    const parsed = parseInvented(
      JSON.stringify({
        methods: [
          method({ name: 'null design', design: null }),
          method({ name: 'empty design', design: {} }),
          method({ name: 'placeholder design', design: '...' }),
          method({ name: 'lower-case ops', program: [{ op: 'price', factor: '1.5', scope: 'small_ticket' }, { op: 'operator', key: 'TIMING:DEPOSIT', target: 'id:cop_1' }] }),
          method({ name: 'bare id scope', program: [{ op: 'DROP', scope: 'cop_1' }, { op: 'FOCUS', count: '2' }] }),
          method({ name: 'designed', program: [], design: { structure: 'broker', population: 'independent veterinary clinics' } }),
        ],
      }),
      brief,
    );
    expect(parsed.rejections).toEqual([]);
    expect(parsed.refused).toBe(0);
    expect(parsed.directions.map((d) => d.name)).toEqual(['null design', 'empty design', 'placeholder design', 'lower-case ops', 'bare id scope', 'designed']);
    expect(parsed.directions.find((d) => d.name === 'lower-case ops')!.program).toEqual([
      { op: 'PRICE', factor: 1.5, scope: 'SMALL_TICKET' },
      { op: 'OPERATOR', key: 'timing:deposit', target: 'cop_1' },
    ]);
    expect(parsed.directions.find((d) => d.name === 'bare id scope')!.program[0]).toEqual({ op: 'DROP', scope: 'id:cop_1' });
    expect(parsed.directions.find((d) => d.name === 'designed')!.design?.design.base).toBe('BROKER');
  });

  it('still refuses what is off-shape in meaning, and says why for every refusal', () => {
    const parsed = parseInvented(
      JSON.stringify({
        methods: [
          method({ name: 'unknown operator', program: [{ op: 'OPERATOR', key: 'nope' }] }),
          method({ name: 'unknown opening', program: [{ op: 'DROP', scope: 'id:cop_404' }] }),
          method({ name: 'invented op', program: [{ op: 'TELEPORT' }] }),
          method({ name: 'too long', program: Array.from({ length: 7 }, () => ({ op: 'FOCUS', count: 1 })) }),
          method({ name: '', program: [{ op: 'FOCUS', count: 1 }] }),
          method({ name: 'no steps', program: [] }),
        ],
      }),
      brief,
    );
    expect(parsed.directions).toHaveLength(0);
    expect(parsed.refused).toBe(6);
    expect(parsed.rejections).toHaveLength(6);
    expect(parsed.rejections[0]).toMatch(/"unknown operator": .*not one of the operators/);
    expect(parsed.rejections[1]).toMatch(/not a scope or an opening held/);
    expect(parsed.rejections[2]).toMatch(/outside the vocabulary/);
    expect(parsed.rejections[3]).toMatch(/7 steps/);
    expect(parsed.rejections[4]).toMatch(/"unnamed": it has no name/);
    expect(parsed.rejections[5]).toMatch(/empty and it carries no design/);
  });

  it('C53: refuses a method that names no stance or no thinking, however valid its program, and says which is missing', () => {
    const parsed = parseInvented(
      JSON.stringify({
        methods: [
          method({ name: 'deposit first', stance: undefined, program: [{ op: 'OPERATOR', key: 'timing:deposit', target: 'cop_1' }] }),
          method({ name: 'partner channel', thinking: '   ', program: [{ op: 'OPERATOR', key: 'partner:referral-partner' }] }),
          method({ name: 'bare focus', stance: '', thinking: '' }),
          method({ name: 'kept', program: [{ op: 'FOCUS', count: 1 }] }),
        ],
      }),
      brief,
    );
    expect(parsed.directions.map((d) => d.name)).toEqual(['kept']);
    expect(parsed.refused).toBe(3);
    expect(parsed.rejections).toEqual(['"deposit first": it has no stance', '"partner channel": it has no thinking', '"bare focus": it has no stance, thinking']);
  });

  it('the prompt says to leave an unused design out, and how ids are written', () => {
    const prompt = inventPrompt(brief, 0, []);
    expect(prompt).toMatch(/Leave "design" out of a method that brings in no new arrangement/);
    expect(prompt).not.toContain('{...optional}');
    expect(prompt).toMatch(/written bare in "target"/);
    // The reply template's own example step is one the parser accepts.
    const template = /Reply exactly: (\{.*\})/.exec(prompt)![1]!.replace(/"design":\{[^}]*\},/, '');
    const parsed = parseInvented(template.replace('BASELINE or GREEDY', 'GREEDY'), brief);
    expect(parsed.rejections).toEqual([]);
    expect(parsed.directions).toHaveLength(1);
  });
});

describe('a rate refusal from the free lane', () => {
  const lane: LaneConfig = { url: 'http://lane.invalid', key: null, models: ['a', 'b'], dailyBudget: 100, timeoutMs: 1000 };

  it('backs off and asks once more, on the next model slot, inside the same budget', async () => {
    const asked: string[] = [];
    const completer = async (_c: LaneConfig, model: string) => {
      asked.push(model);
      if (asked.length === 1) throw new Error('cheap lane HTTP 429');
      return JSON.stringify({ methods: [method({ name: 'after retry' })] });
    };
    const got = await inventDirections(brief, { config: lane, completer, calls: 1, env: {}, backoffMs: 5 });
    expect(asked).toEqual(['a', 'b']);
    expect(got.error).toBeNull();
    expect(got.directions.map((d) => d.name)).toEqual(['after retry']);
  });

  it('retries a rate refusal once only, and any other failure not at all', async () => {
    const asked: string[] = [];
    const limited = async (_c: LaneConfig, model: string): Promise<string> => {
      asked.push(model);
      throw new Error('cheap lane HTTP 429');
    };
    const twice = await inventDirections(brief, { config: lane, completer: limited, calls: 1, env: {}, backoffMs: 5 });
    expect(asked).toEqual(['a', 'b']);
    expect(twice.error).toMatch(/1 retried after a rate refusal/);

    asked.length = 0;
    const failing = async (_c: LaneConfig, model: string): Promise<string> => {
      asked.push(model);
      throw new Error('cheap lane HTTP 500');
    };
    const failed = await inventDirections(brief, { config: lane, completer: failing, calls: 1, env: {}, backoffMs: 5 });
    expect(asked).toEqual(['a']);
    expect(failed.error).toMatch(/HTTP 500/);
  });
});

describe('an answer that is JSON inside something else (production 2026-11-15: "the answer is not JSON" x2)', () => {
  const answer = JSON.stringify({ methods: [method({ name: 'one' }), method({ name: 'two', program: [{ op: 'DROP', scope: 'REST' }] })] });
  const names = (text: string) => parseInvented(text, brief).directions.map((d) => d.name);

  it('reads a fenced ```json block, with or without prose around it', () => {
    expect(names('```json\n' + answer + '\n```')).toEqual(['one', 'two']);
    expect(names('Here are my methods:\n\n```json\n' + answer + '\n```\n\nLet me know {if} you need more.')).toEqual(['one', 'two']);
    expect(names('```\n' + answer + '\n```')).toEqual(['one', 'two']);
  });

  it('reads the object out of prose, even when the prose holds braces of its own', () => {
    expect(names('Sure! ' + answer + ' I hope these {ideas} help.')).toEqual(['one', 'two']);
    expect(names('<think>maybe {"methods": []} is too few</think>' + answer)).toEqual(['one', 'two']);
  });

  it('reads an array wrapper: the list itself, or the object wrapped in one', () => {
    expect(names(JSON.stringify([method({ name: 'one' }), method({ name: 'two' })]))).toEqual(['one', 'two']);
    expect(names('[' + answer + ']')).toEqual(['one', 'two']);
    expect(names('Answer:\n' + JSON.stringify([method({ name: 'solo' })]))).toEqual(['solo']);
  });

  it('tolerates commas that close nothing, and keeps the complete methods of an answer cut off mid-list', () => {
    expect(names('{"methods":[' + JSON.stringify(method({ name: 'one' })) + ',],}')).toEqual(['one']);
    const cut = '{"methods":[' + JSON.stringify(method({ name: 'one' })) + ',' + JSON.stringify(method({ name: 'two' })) + ',{"name":"thr';
    expect(names(cut)).toEqual(['one', 'two']);
  });

  it('refuses what holds no JSON at all, quoting the first 80 characters of it', () => {
    const prose = 'I cannot produce methods for this goal because the openings do not show enough about the buyers to reason with.';
    const parsed = parseInvented(prose, brief);
    expect(parsed.refused).toBe(1);
    expect(parsed.rejections).toEqual([`the answer is not JSON (begins: "${prose.slice(0, 80)}")`]);
    expect(parseInvented('   ', brief).rejections).toEqual(['the answer is empty']);
    expect(extractJsonPayload('no braces here')).toBeUndefined();
  });

  it('asks the lane for a JSON object, and says so in the prompt', async () => {
    const seen: (boolean | undefined)[] = [];
    const lane: LaneConfig = { url: 'http://lane.invalid', key: null, models: ['a'], dailyBudget: 100, timeoutMs: 1000 };
    const got = await inventDirections(brief, {
      config: lane,
      completer: async (_c, _m, system, _p, options) => {
        seen.push(options?.json);
        expect(system).toMatch(/no markdown fences/);
        return '```json\n' + answer + '\n```';
      },
      calls: 1,
      env: {},
    });
    expect(seen).toEqual([true]);
    expect(got.directions.map((d) => d.name)).toEqual(['one', 'two']);
    expect(inventPrompt(brief, 0, [])).toMatch(/no markdown fence and no words around it/);
  });
});
