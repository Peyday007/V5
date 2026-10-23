/**
 * The cheap lane: free models sort, Brain validates, and nothing they say is
 * ever evidence. Off unless configured; cached by input; cross-checked when two
 * models are named; bounded per day.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  combine,
  laneConfig,
  laneReading,
  latestScreens,
  parseScreen,
  screenOpening,
  type Completer,
  type LaneConfig,
} from '../server/services/cheap/lane.ts';

const input = {
  title: 'County needs flood-zone parcel list before Nov 1 deadline',
  mechanism: 'PUBLISHED_REQUEST',
  source: 'https://example.gov/rfq',
  payer: 'Example County',
  buyingSignal: 'Posted RFQ',
  deadline: '2026-11-01',
  price: '1500.00 USD',
};

const config = (models: string[], dailyBudget = 100): LaneConfig => ({
  url: 'http://cheap.test/v1',
  key: null,
  models,
  dailyBudget,
  timeoutMs: 1000,
});

function scripted(answers: Record<string, string>): { completer: Completer; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    completer: async (_config, model) => {
      calls.push(model);
      return answers[model] ?? '';
    },
  };
}

const keep = '{"verdict":"KEEP","window":"SHORT","tags":["deadline","data"],"reason":"A county posted it."}';
const drop = '{"verdict":"DROP","window":"UNKNOWN","tags":[],"reason":"Needs a licence."}';

beforeEach(async () => {
  await freshProject();
});

describe('what the lane accepts as an answer', () => {
  it('takes a well-formed answer and refuses anything off-shape', () => {
    expect(parseScreen(`Sure! ${keep}`)?.verdict).toBe('KEEP');
    expect(parseScreen('{"verdict":"MAYBE"}')).toBeNull();
    expect(parseScreen('{"verdict":"KEEP","extra":1}')).toBeNull();
    expect(parseScreen('not json')).toBeNull();
  });

  it('turns two models that disagree into UNSURE, never into either verdict', () => {
    expect(combine([parseScreen(keep), parseScreen(drop)])?.verdict).toBe('UNSURE');
    expect(combine([parseScreen(drop), parseScreen(drop)])?.verdict).toBe('DROP');
    expect(combine([null, null])).toBeNull();
  });

  it('is off unless an address is set', () => {
    expect(laneConfig({})).toBeNull();
    expect(laneConfig({ BRAIN_CHEAP_LLM_URL: 'http://x/v1', BRAIN_CHEAP_LLM_MODELS: 'a,b,c' })?.models).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('screening an opening', () => {
  it('sends nothing when the lane is off', async () => {
    const { completer, calls } = scripted({ m1: keep });
    expect(await screenOpening('cop_1', input, { config: null, completer })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('asks each model once per input and reads the answer back from rows', async () => {
    const { completer, calls } = scripted({ m1: drop, m2: drop });
    const first = await screenOpening('cop_1', input, { config: config(['m1', 'm2']), completer });
    const again = await screenOpening('cop_1', input, { config: config(['m1', 'm2']), completer });
    expect(first?.verdict).toBe('DROP');
    expect(again?.verdict).toBe('DROP');
    expect(calls).toEqual(['m1', 'm2']);
    expect((await latestScreens(['cop_1'])).get('cop_1')?.verdict).toBe('DROP');
  });

  it('records a failed or off-shape answer as no signal, never as DROP', async () => {
    const failing: Completer = async () => {
      throw new Error('HTTP 429');
    };
    expect(await screenOpening('cop_2', input, { config: config(['m1']), completer: failing })).toBeNull();
    const garbled = scripted({ m1: 'I think it is fine' });
    expect(
      await screenOpening('cop_3', { ...input, title: 'other' }, { config: config(['m1']), completer: garbled.completer }),
    ).toBeNull();
    expect((await latestScreens(['cop_2', 'cop_3'])).size).toBe(0);
    expect((await laneReading()).failed).toBe(2);
  });

  it('stops at the daily budget', async () => {
    const { completer, calls } = scripted({ m1: keep });
    for (let i = 0; i < 4; i += 1) {
      await screenOpening(`cop_b${i}`, { ...input, title: `t${i}` }, { config: config(['m1'], 2), completer });
    }
    expect(calls).toHaveLength(2);
  });
});

describe('the lane is never evidence', () => {
  it('is read by no module that judges evidence, fills a card or decides a tier', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'server/services/research/gate.ts',
      'server/services/research/standards.ts',
      'server/services/cash/card.ts',
      'server/services/cash/tier.ts',
      'server/services/cash/engineCard.ts',
      'server/services/cash/answers.ts',
      'server/services/cash/money.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/cheap\/lane|cheap_results/);
    }
  });
});
