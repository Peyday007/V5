import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createSearchMethod, recordMethodRun } from '../server/repos/searchMethods.ts';
import { computeMethodMetrics, trustInput, MIN_JUDGED_FOR_TRUST } from '../server/services/research/searchMetrics/compute.ts';
import { readMethodMetrics } from '../server/services/research/searchMetrics/read.ts';
import { discoveryMethodMetrics } from '../server/services/cash/discoveryYield.ts';
import type { SearchReader } from '../server/domain/searchIntelligence.ts';

const reader: SearchReader = { projectIds: [], userId: null };
const mk = (key: string) => createSearchMethod({ scope: 'GENERAL', methodKey: key, finds: 'x', sources: ['s'], checkProcedure: 'c' });

describe('per-method metrics', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('counts runs, time, and AI jobs consumed versus avoided from rows', async () => {
    const m = await mk('a');
    await recordMethodRun({ methodId: m.id, executor: 'CODE', outcome: 'FOUND', surfaced: 5, confirmed: 3, rejected: 1, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:02.000Z' });
    await recordMethodRun({ methodId: m.id, executor: 'CLAUDE', outcome: 'SOURCE_UNAVAILABLE', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:10.000Z' });
    const [r] = await readMethodMetrics(reader);
    expect(r?.metrics).toMatchObject({ runs: 2, relevant: 5, verified: 3, falsePositives: 1, searchTimeMs: 12000, computeMs: 2000, aiJobsConsumed: 1, aiJobsAvoided: 1 });
    expect(r?.metrics.outcomes.SOURCE_UNAVAILABLE).toBe(1);
    expect(r?.metrics.downstream).toBeNull();
    expect(r?.metrics.duplicates).toBeNull();
  });

  it('volume alone never raises trust input', () => {
    const lots = computeMethodMetrics('m', []);
    lots.relevant = 100000;
    expect(trustInput(lots)).toEqual({ judged: 0, precision: null, sufficient: false });
    const t = trustInput({ verified: MIN_JUDGED_FOR_TRUST, falsePositives: 0 });
    expect(t.precision).toBe(1);
  });

  it('attaches cash bucket outcomes to a method sharing the bucket key, and reports non-cash as unknown', async () => {
    const { project } = await freshProject();
    await mk('some-non-cash-method');
    const pid = project.id;
    const rows = await discoveryMethodMetrics(pid, reader);
    expect(rows.every((x) => x.metrics.downstream === null)).toBe(true);
  });
});
