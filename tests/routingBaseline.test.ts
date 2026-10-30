import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { readBaseline, replayWorkload, storeBaseline } from '../server/services/routing/baseline/index.ts';
import type { Workload } from '../server/services/routing/baseline/index.ts';
import type { Completer } from '../server/services/cheap/lane.ts';

const workload = JSON.parse(readFileSync(new URL('./fixtures/routing-baseline/workload.json', import.meta.url), 'utf8')) as Workload;
const now = new Date();
let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  workload.label = `routing-baseline-v1-${Math.random().toString(36).slice(2, 8)}`;
});

// A deterministic stand-in for the free models: keeps posts that name a business need.
const stub: Completer = async (_c, _m, _s, prompt) => {
  const keep = /spreadsheet|Website down/.test(prompt);
  return JSON.stringify(keep
    ? { verdict: 'KEEP', window: 'SHORT', deliverable: /Website/.test(prompt) ? 'WEBSITE' : 'DATASET', need: 'a finished piece of work', payer: 'the business', reason: 'clear need' }
    : { verdict: 'DROP', window: 'UNKNOWN', deliverable: 'NONE', need: '', payer: '', reason: 'no' });
};

describe('routing baseline', () => {
  it('replays the stored workload and counts what actually ran', async () => {
    let seen = 0;
    const r = await replayWorkload({ workload, now, completer: async (...a) => { seen += 1; return stub(...a); } });
    expect(r.workload.items).toBe(workload.items.length);
    expect(r.codeSignals).toBe(1);
    expect(r.codeCovered).toBe(3);
    expect(r.cheapItems).toBe(workload.items.length - 3);
    expect(r.cheapCalls).toBe(seen);
    expect(r.cheapCalls).toBe(r.cheapItems * 2); // two models, each asked once
    expect(r.cheapValidAnswers + r.cheapFailedAnswers).toBe(r.cheapItems);
    expect(r.shortlistEligible).toBe(2);
    expect(r.premiumJobsLaunched).toBe(0);
    expect(r.unknown).toContain('verification pass rate');
  });

  it('counts a failing model as failed answers, not as invented ones', async () => {
    const r = await replayWorkload({ workload, now, completer: async () => 'not json' });
    expect(r.cheapValidAnswers).toBe(0);
    expect(r.cheapFailedAnswers).toBe(r.cheapItems);
    expect(r.shortlistEligible).toBe(0);
  });

  it('stores a baseline row later reports can read, scoped to the project', async () => {
    const { id, readings } = await storeBaseline({ projectId, workload, now, completer: stub });
    const back = await readBaseline(projectId, workload.label);
    expect(back!.id).toBe(id);
    expect(back!.readings.shortlistEligible).toBe(readings.shortlistEligible);
    expect(back!.readings.workload.digest).toBe(readings.workload.digest);
    const other = (await freshProject()).project.id;
    expect(await readBaseline(other, workload.label)).toBeNull();
  });
});
