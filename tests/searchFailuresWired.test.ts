import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createSearchMethod, getSearchMethod, recordMethodRun } from '../server/repos/searchMethods.ts';
import { methodMayRun, runSearchMaintenance } from '../server/services/feeds/searchMaintenance.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';

const NOW = new Date('2026-10-31T00:00:00.000Z');
const failing = async (methodKey: string, outcome: 'SOURCE_UNAVAILABLE' | 'FALSE_POSITIVES', subjectId: string | null) => {
  const m = await createSearchMethod({ scope: 'GENERAL', methodKey, subjectId, finds: 'x', sources: ['s'], checkProcedure: 'c' });
  for (let i = 0; i < 3; i += 1) {
    await recordMethodRun({ methodId: m.id, executor: 'CODE', outcome, finishedAt: new Date(NOW.getTime() - (3 - i) * 3_600_000).toISOString() });
  }
  return m;
};

describe('failing search methods are judged by the running system', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('pauses an unreachable source, flags noise for revision, and asks for a method only when none can run', async () => {
    const down = await failing('down', 'SOURCE_UNAVAILABLE', 'subA');
    const noisy = await failing('noisy', 'FALSE_POSITIVES', 'subB');
    const report = await runSearchMaintenance(NOW);
    const by = new Map(report.methods.map((m) => [m.methodKey, m.decision]));
    expect(by.get('down')).toMatchObject({ action: 'PAUSE', cause: 'SOURCE_UNAVAILABLE' });
    expect(by.get('noisy')).toMatchObject({ action: 'REVISE', cause: 'HIGH_FALSE_POSITIVES' });
    // subA still has a method waiting; subB has nothing that may run or wait, so it needs one developed.
    expect(report.subjectsNeedingAMethod).toEqual([{ subjectId: 'subB', route: 'DEVELOP' }]);
    expect((await methodMayRun(down, NOW)).action).toBe('PAUSE');
    expect((await methodMayRun(noisy, NOW)).action).toBe('REVISE');
  });

  it('runs on the feeds tick: runDetectors judges methods before it detects', async () => {
    const m = await createSearchMethod({ scope: 'GENERAL', methodKey: 'earned', finds: 'x', sources: ['s'], checkProcedure: 'c' });
    await recordMethodRun({ methodId: m.id, executor: 'CODE', outcome: 'FOUND', surfaced: 3, confirmed: 3 });
    await runDetectors({ now: NOW });
    expect((await getSearchMethod({ projectIds: [], userId: null }, m.id))?.trustState).toBe('TESTING');
  });

  it('is reached from the feeds tick and not only from tests', () => {
    expect(readFileSync('server/services/feeds/detectors.ts', 'utf8')).toContain('runSearchMaintenance(');
    expect(readFileSync('server/services/russell/loop.ts', 'utf8')).toContain('await runDetectors()');
  });
});
