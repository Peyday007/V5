/**
 * Search intelligence schema: scope-filtered reads, guarded transitions,
 * first-label-stands examples, and additive migrations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createLearnedDetector,
  createSearchMethod,
  getSearchMethod,
  listDetectorExamples,
  listLearnedDetectors,
  listLearnedSubjects,
  listMethodRuns,
  listSearchMethods,
  recordDetectorExample,
  recordMethodRun,
  retireLearnedSubject,
  setDetectorMode,
  setMethodTrust,
  upsertLearnedSubject,
} from '../server/repos/searchMethods.ts';
import { scopeProblem, type SearchReader } from '../server/domain/searchIntelligence.ts';

let projectA = '';
let projectB = '';
let readerA: SearchReader;
let readerB: SearchReader;

beforeEach(async () => {
  projectA = (await freshProject()).project.id;
  projectB = (await freshProject()).project.id;
  readerA = { projectIds: [projectA], userId: 'usr_a' };
  readerB = { projectIds: [projectB], userId: 'usr_b' };
});

describe('scope rules', () => {
  it('requires the identity a scope names, and none for GENERAL', () => {
    expect(scopeProblem({ scope: 'PROJECT' })).not.toBeNull();
    expect(scopeProblem({ scope: 'USER' })).not.toBeNull();
    expect(scopeProblem({ scope: 'GENERAL', projectId: 'p' })).not.toBeNull();
    expect(scopeProblem({ scope: 'GENERAL' })).toBeNull();
    expect(scopeProblem({ scope: 'PROJECT', projectId: 'p' })).toBeNull();
  });

  it('refuses an inconsistent row in the database as well', async () => {
    await expect(
      getDb().run(
        `INSERT INTO learned_subjects (id, scope, subject_key, label, origin, created_at, updated_at)
         VALUES ('x', 'PROJECT', 'k', 'l', 'o', 'a', 'a')`,
      ),
    ).rejects.toThrow();
  });
});

describe('learned subjects', () => {
  it('is idempotent by scope and key, and filtered by reader', async () => {
    const first = await upsertLearnedSubject({ scope: 'PROJECT', projectId: projectA, subjectKey: 'tankers', label: 'Tankers', origin: 'test' });
    const again = await upsertLearnedSubject({ scope: 'PROJECT', projectId: projectA, subjectKey: 'tankers', label: 'Other', origin: 'test' });
    expect(again.id).toBe(first.id);
    await upsertLearnedSubject({ scope: 'GENERAL', subjectKey: 'public', label: 'Public', origin: 'test' });
    await upsertLearnedSubject({ scope: 'USER', userId: 'usr_b', subjectKey: 'mine', label: 'Mine', origin: 'test' });

    const a = (await listLearnedSubjects(readerA)).map((s) => s.subjectKey).sort();
    const b = (await listLearnedSubjects(readerB)).map((s) => s.subjectKey).sort();
    expect(a).toEqual(['public', 'tankers']);
    expect(b).toEqual(['mine', 'public']);
  });

  it('retires without deleting', async () => {
    const s = await upsertLearnedSubject({ scope: 'GENERAL', subjectKey: 'old', label: 'Old', origin: 'test' });
    expect(await retireLearnedSubject(s.id)).toBe(true);
    expect(await retireLearnedSubject(s.id)).toBe(false);
    expect(await listLearnedSubjects(readerA)).toHaveLength(0);
    expect(await listLearnedSubjects(readerA, { includeRetired: true })).toHaveLength(1);
  });
});

describe('search methods and runs', () => {
  const base = { methodKey: 'm', finds: 'x', sources: ['https://example.test'], checkProcedure: 'open and read' };

  it('keeps another project\'s method invisible, by list and by id', async () => {
    const m = await createSearchMethod({ scope: 'PROJECT', projectId: projectA, ...base });
    expect(m.trustState).toBe('PROPOSED');
    expect(m.sources).toEqual(['https://example.test']);
    expect(await getSearchMethod(readerA, m.id)).not.toBeNull();
    expect(await getSearchMethod(readerB, m.id)).toBeNull();
    expect(await listSearchMethods(readerB)).toHaveLength(0);
    expect(await listMethodRuns(readerB, m.id)).toEqual([]);
  });

  it('moves trust only from the state the caller read', async () => {
    const m = await createSearchMethod({ scope: 'GENERAL', ...base });
    expect(await setMethodTrust(m.id, 'PROPOSED', 'TESTING', 'first run')).toBe(true);
    expect(await setMethodTrust(m.id, 'PROPOSED', 'PROVEN', 'stale')).toBe(false);
    expect((await listSearchMethods(readerA, { trustState: 'TESTING' }))[0]?.trustReason).toBe('first run');
  });

  it('records the three kinds of empty result as different outcomes', async () => {
    const m = await createSearchMethod({ scope: 'GENERAL', ...base });
    for (const outcome of ['SOURCE_UNAVAILABLE', 'NOTHING_SUITABLE', 'FALSE_POSITIVES'] as const) {
      await recordMethodRun({ methodId: m.id, executor: 'CODE', outcome });
    }
    const runs = await listMethodRuns(readerA, m.id);
    expect(runs.map((r) => r.outcome).sort()).toEqual(['FALSE_POSITIVES', 'NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE']);
    await expect(
      getDb().run(
        `INSERT INTO search_method_runs (id, method_id, executor, outcome, started_at, finished_at)
         VALUES ('r', ?, 'CODE', 'EMPTY', 'a', 'a')`,
        [m.id],
      ),
    ).rejects.toThrow();
  });
});

describe('learned detectors', () => {
  it('starts in SHADOW, promotes with a guard, and keeps the first label', async () => {
    const d = await createLearnedDetector({ scope: 'PROJECT', projectId: projectA, detectorKey: 'd', definition: { all: ['a'] }, threshold: 0.8 });
    expect(d.mode).toBe('SHADOW');
    expect(d.definition).toEqual({ all: ['a'] });
    expect(await setDetectorMode(d.id, 'SHADOW', 'ACTIVE')).toBe(true);
    expect(await setDetectorMode(d.id, 'SHADOW', 'ACTIVE')).toBe(false);

    expect(await recordDetectorExample({ detectorId: d.id, itemRef: 'i1', fired: true, verdict: 'CONFIRMED', labelledBy: 'u' })).toBe(true);
    expect(await recordDetectorExample({ detectorId: d.id, itemRef: 'i1', fired: true, verdict: 'REJECTED', labelledBy: 'u' })).toBe(false);
    expect((await listDetectorExamples(readerA, d.id))[0]?.verdict).toBe('CONFIRMED');
    expect(await listDetectorExamples(readerB, d.id)).toEqual([]);
    expect(await listLearnedDetectors(readerB)).toHaveLength(0);
    expect(await listLearnedDetectors(readerA, { mode: 'ACTIVE' })).toHaveLength(1);
  });
});
