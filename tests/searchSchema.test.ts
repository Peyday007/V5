/**
 * Search intelligence schema: scope-filtered reads, guarded trust and mode
 * moves, and rows that are never overwritten by a repeat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  addDetectorExample, addObservedLimit, createLearnedDetector, createSearchMethod, finishMethodRun,
  listDetectorExamples, listLearnedDetectors, listLearnedSubjects, listMethodRuns, listSearchMethods,
  readSearchMethod, setDetectorMode, setMethodTrust, startMethodRun, upsertLearnedSubject,
} from '../server/repos/searchMethods.ts';
import { mayRead, scopeKeyFor } from '../server/domain/searchIntelligence.ts';

const A = { projectIds: ['prj_a'], userId: 'usr_a' };
const B = { projectIds: ['prj_b'], userId: 'usr_b' };

beforeEach(async () => {
  await freshProject();
});

describe('scope', () => {
  it('names the owner of a scoped row', () => {
    expect(() => scopeKeyFor('PROJECT', null, null)).toThrow();
    expect(() => scopeKeyFor('USER', 'p', null)).toThrow();
    expect(scopeKeyFor('GENERAL', null, null)).toBe('GENERAL');
    expect(mayRead(A, { scope: 'PROJECT', projectId: 'prj_b', ownerUserId: null })).toBe(false);
  });

  it('filters reads by project, user and GENERAL in the statement', async () => {
    await upsertLearnedSubject({ scope: 'PROJECT', projectId: 'prj_a', subjectKey: 'x', label: 'A project', origin: 't' });
    await upsertLearnedSubject({ scope: 'PROJECT', projectId: 'prj_b', subjectKey: 'x', label: 'B project', origin: 't' });
    await upsertLearnedSubject({ scope: 'USER', ownerUserId: 'usr_a', subjectKey: 'x', label: 'A user', origin: 't' });
    await upsertLearnedSubject({ scope: 'GENERAL', subjectKey: 'x', label: 'General', origin: 't' });
    expect((await listLearnedSubjects(A)).map((s) => s.label).sort()).toEqual(['A project', 'A user', 'General']);
    expect((await listLearnedSubjects(B)).map((s) => s.label).sort()).toEqual(['B project', 'General']);
    expect((await listLearnedSubjects({ projectIds: [], userId: null })).map((s) => s.label)).toEqual(['General']);
  });

  it('answers absent and not-yours identically for a method', async () => {
    const m = await createSearchMethod({ scope: 'PROJECT', projectId: 'prj_a', name: 'n', finds: 'f' });
    expect(await readSearchMethod(A, m.id)).not.toBeNull();
    expect(await readSearchMethod(B, m.id)).toBeNull();
    expect(await readSearchMethod(B, 'smt_nope')).toBeNull();
    expect(await listSearchMethods(B)).toEqual([]);
  });
});

describe('subjects', () => {
  it('keeps one row per subject per scope and keeps the first', async () => {
    const one = await upsertLearnedSubject({ scope: 'GENERAL', subjectKey: 's', label: 'First', origin: 't' });
    const two = await upsertLearnedSubject({ scope: 'GENERAL', subjectKey: 's', label: 'Second', origin: 't' });
    expect(two.id).toBe(one.id);
    expect(two.label).toBe('First');
  });
});

describe('methods', () => {
  it('starts PROPOSED and moves trust only from the state read', async () => {
    const m = await createSearchMethod({ scope: 'GENERAL', name: 'n', finds: 'f', sources: ['s'] });
    expect(m.trustState).toBe('PROPOSED');
    expect(m.sources).toEqual(['s']);
    expect(await setMethodTrust(m.id, 'PROPOSED', 'TESTING', 'first run')).toBe(true);
    expect(await setMethodTrust(m.id, 'PROPOSED', 'PROVEN', 'stale read')).toBe(false);
    const read = await readSearchMethod(A, m.id);
    expect(read?.trustState).toBe('TESTING');
    expect(read?.trustReason).toBe('first run');
  });

  it('keeps observed limits once each', async () => {
    const m = await createSearchMethod({ scope: 'GENERAL', name: 'n', finds: 'f' });
    await addObservedLimit(m.id, 'rate limited');
    await addObservedLimit(m.id, 'rate limited');
    expect((await readSearchMethod(A, m.id))?.observedLimits).toEqual(['rate limited']);
  });

  it('records a run with its own outcome, once', async () => {
    const m = await createSearchMethod({ scope: 'GENERAL', name: 'n', finds: 'f' });
    const run = await startMethodRun(m.id, 'CODE');
    expect(run.outcome).toBe('RUNNING');
    const done = { itemsExamined: 10, itemsFound: 4, itemsAccepted: 1, falsePositives: 3, outcome: 'TOO_MANY_FALSE_POSITIVES' as const };
    expect(await finishMethodRun(run.id, done)).toBe(true);
    expect(await finishMethodRun(run.id, { ...done, outcome: 'FOUND' })).toBe(false);
    const [stored] = await listMethodRuns(m.id);
    expect(stored?.outcome).toBe('TOO_MANY_FALSE_POSITIVES');
    expect(stored?.falsePositives).toBe(3);
  });
});

describe('detectors', () => {
  it('starts SHADOW, moves mode on a guard, and keeps labels once', async () => {
    const d = await createLearnedDetector({ scope: 'GENERAL', ruleKey: 'r', definition: { all: ['x'] } });
    expect(d.mode).toBe('SHADOW');
    expect(d.threshold).toBeCloseTo(0.9);
    expect((await createLearnedDetector({ scope: 'GENERAL', ruleKey: 'r', definition: { all: ['y'] } })).id).toBe(d.id);
    expect(await setDetectorMode(d.id, 'SHADOW', 'ACTIVE', 'precision 0.95')).toBe(true);
    expect(await setDetectorMode(d.id, 'SHADOW', 'DEMOTED', 'late')).toBe(false);
    expect((await listLearnedDetectors(A, { mode: 'ACTIVE' })).length).toBe(1);
    expect(await addDetectorExample({ detectorId: d.id, itemRef: 'i1', label: 'POSITIVE', predicted: true, labelledBy: 'p' })).toBe(true);
    expect(await addDetectorExample({ detectorId: d.id, itemRef: 'i1', label: 'NEGATIVE', predicted: true, labelledBy: 'p' })).toBe(false);
    expect((await listDetectorExamples(d.id))[0]?.label).toBe('POSITIVE');
  });

  it('refuses an outcome or mode outside the closed sets', async () => {
    const d = await createLearnedDetector({ scope: 'GENERAL', ruleKey: 'r2', definition: {} });
    await expect(getDb().run(`UPDATE learned_detectors SET mode = 'LIVE' WHERE id = ?`, [d.id])).rejects.toThrow();
  });
});
