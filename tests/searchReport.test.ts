import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  createLearnedDetector,
  createSearchMethod,
  recordMethodRun,
  setDetectorMode,
  setMethodTrust,
  upsertLearnedSubject,
} from '../server/repos/searchMethods.ts';
import { buildSearchReport, renderSearchReport } from '../server/services/research/searchReport/index.ts';
import type { SearchReader } from '../server/domain/searchIntelligence.ts';

const reader: SearchReader = { projectIds: [], userId: null };
const mk = (key: string, extra: { version?: number; sources?: string[] } = {}) =>
  createSearchMethod({ scope: 'GENERAL', methodKey: key, finds: `finds ${key}`, sources: extra.sources ?? ['feed:a'], checkProcedure: 'c', ...(extra.version ? { version: extra.version } : {}) });

describe('the search report', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('is empty and honest on an empty Brain: counts zero, opportunities not measured', async () => {
    const report = await buildSearchReport(reader);
    expect(report.counts).toEqual({ known: 0, stillLearning: 0, automatic: 0, proven: 0, unproven: 0, retired: 0 });
    expect(report.newOpportunities).toBeNull();
    expect(report.newMethodsResearched).toBeNull();
  });

  it('separates proven from unproven, learning from automatic, from rows', async () => {
    const proven = await mk('proven', { sources: ['feed:a', 'feed:b'] });
    await recordMethodRun({ methodId: proven.id, executor: 'CODE', outcome: 'FOUND', surfaced: 12, confirmed: 10, rejected: 0 });
    await setMethodTrust(proven.id, 'PROPOSED', 'TESTING', 't');
    await setMethodTrust(proven.id, 'TESTING', 'PROVEN', 'p');

    const claimedProven = await mk('claimed');
    await recordMethodRun({ methodId: claimedProven.id, executor: 'CLAUDE', outcome: 'FOUND', surfaced: 1, confirmed: 1 });
    await setMethodTrust(claimedProven.id, 'PROPOSED', 'TESTING', 't');
    await setMethodTrust(claimedProven.id, 'TESTING', 'PROVEN', 'written without support');

    const fresh = await mk('fresh');
    const retired = await mk('retired');
    await setMethodTrust(retired.id, 'PROPOSED', 'RETIRED', 'gone');
    expect(fresh.id).toBeTruthy();

    const report = await buildSearchReport(reader);
    const by = Object.fromEntries(report.methods.map((m) => [m.methodKey, m]));
    expect(by['proven']).toMatchObject({ proven: true, stillLearning: false, automatic: true, precision: 1 });
    expect(by['claimed']).toMatchObject({ proven: false, stillLearning: true, automatic: false });
    expect(by['fresh']).toMatchObject({ proven: false, stillLearning: true, automatic: false, precision: null });
    expect(by['retired']).toMatchObject({ abandoned: true, automatic: false });
    expect(report.counts).toEqual({ known: 3, stillLearning: 2, automatic: 1, proven: 1, unproven: 2, retired: 1 });
    expect(report.sources).toEqual(['feed:a', 'feed:b']);
    expect(report.abandoned).toEqual(['retired']);
  });

  it('counts results and Claude usage as recorded, and never invents opportunities', async () => {
    const a = await mk('a');
    await recordMethodRun({ methodId: a.id, executor: 'CODE', outcome: 'FOUND', surfaced: 5, confirmed: 3, rejected: 1 });
    await recordMethodRun({ methodId: a.id, executor: 'CHEAP_LANE', outcome: 'NOTHING_SUITABLE' });
    await recordMethodRun({ methodId: a.id, executor: 'CLAUDE', outcome: 'SOURCE_UNAVAILABLE' });
    const report = await buildSearchReport(reader);
    expect(report.results).toEqual({ relevant: 5, verified: 3, falsePositives: 1 });
    expect(report.aiUsage).toEqual({ avoided: 2, consumed: 1 });
    expect(report.newOpportunities).toBeNull();
    const withDownstream = await buildSearchReport(reader, { downstream: new Map([['a', { useful: 4, qualified: 2 }]]) });
    expect(withDownstream.newOpportunities).toBe(2);
  });

  it('reports methods turned into code with their mode, and new and improved methods', async () => {
    const v1 = await mk('m');
    const v2 = await mk('m', { version: 2 });
    const d = await createLearnedDetector({ scope: 'GENERAL', detectorKey: 'det', methodId: v2.id, definition: { x: 1 }, threshold: 0.8 });
    let report = await buildSearchReport(reader, { since: '2000-01-01T00:00:00.000Z' });
    expect(report.turnedIntoCode).toEqual([{ methodKey: 'm', detectorKey: 'det', mode: 'SHADOW' }]);
    expect(report.methods.find((m) => m.version === 2)?.automatic).toBe(false);
    await setDetectorMode(d.id, 'SHADOW', 'ACTIVE');
    report = await buildSearchReport(reader, { since: '2000-01-01T00:00:00.000Z' });
    expect(report.methods.find((m) => m.version === 2)?.automatic).toBe(true);
    expect(report.improved).toEqual(['m']);
    expect(report.newMethodsResearched).toEqual(['m', 'm']);
    expect((await buildSearchReport(reader, { since: '2999-01-01T00:00:00.000Z' })).newMethodsResearched).toEqual([]);
    expect(v1.id).not.toBe(v2.id);
  });

  it('shows a reader only what their scope may see', async () => {
    const { project } = await freshProject();
    await createSearchMethod({ scope: 'PROJECT', projectId: project.id, methodKey: 'private', finds: 'x', sources: ['s'], checkProcedure: 'c' });
    await upsertLearnedSubject({ scope: 'PROJECT', projectId: project.id, subjectKey: 'k', label: 'K', origin: 'test' });
    expect((await buildSearchReport(reader)).counts.known).toBe(0);
    const mine = await buildSearchReport({ projectIds: [project.id], userId: null });
    expect(mine.counts.known).toBe(1);
    expect(mine.subjects.learned).toBe(1);
    expect(renderSearchReport(mine)).toContain('private');
  });
});
