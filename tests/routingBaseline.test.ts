import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { ensureBaseline, readBaseline, replayWorkload, runBaselineCommand, storeBaseline } from '../server/services/routing/baseline/index.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
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

  // The finding this answers: the harness had no caller outside this file, so
  // production never held a baseline. ensureBaseline is what the command runs.
  describe('recording against the stored workload', () => {
    const lane = { BRAIN_CHEAP_LLM_URL: 'http://lane.invalid/v1', BRAIN_CHEAP_LLM_MODELS: 'm-a,m-b' } as NodeJS.ProcessEnv;
    const tag = () => Math.random().toString(36).slice(2, 10);

    it('replays the feed items production stored and records one baseline row', async () => {
      const t = tag();
      await insertFeedItems('baseline-test', [
        { externalId: `${t}-1`, url: `https://x.invalid/${t}/1`, title: 'Need a spreadsheet cleaned', body: 'spreadsheet', organization: `Org ${t}`, publishedAt: now.toISOString() },
        { externalId: `${t}-2`, url: `https://x.invalid/${t}/2`, title: 'Senior engineer', body: null, organization: `Other ${t}`, publishedAt: now.toISOString() },
      ]);
      let calls = 0;
      const r = await ensureBaseline({ projectId, now, env: lane, completer: async (...a) => { calls += 1; return stub(...a); } });
      expect(r.status).toBe('RECORDED');
      if (r.status !== 'RECORDED') return;
      expect(r.readings.workload.items).toBeGreaterThanOrEqual(2);
      expect(r.readings.cheapCalls).toBe(calls);
      const back = await readBaseline(projectId, 'routing-baseline-v1');
      expect(back!.id).toBe(r.id);

      // The first baseline is the comparison point: a second run keeps it and asks no model.
      let again = 0;
      const second = await ensureBaseline({ projectId, now, env: lane, completer: async (...a) => { again += 1; return stub(...a); } });
      expect(second.status).toBe('EXISTS');
      expect(again).toBe(0);
      if (second.status === 'EXISTS') expect(second.id).toBe(r.id);
    });

    it('records nothing, and says why, when no lane could be measured', async () => {
      const r = await ensureBaseline({ projectId, now, env: {} as NodeJS.ProcessEnv, completer: stub });
      expect(r.status).toBe('NOT_RECORDED');
      expect(await readBaseline(projectId, 'routing-baseline-v1')).toBeNull();
    });

    it('runs as a command and refuses without a project', async () => {
      const lines: string[] = [];
      expect(await runBaselineCommand([], (l) => lines.push(l), lane)).toBe(2);
      expect(await runBaselineCommand(['--project', projectId], (l) => lines.push(l), {} as NodeJS.ProcessEnv)).toBe(1);
      expect(lines.join('\n')).toMatch(/NOT RECORDED/);
    });
  });
});
