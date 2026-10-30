import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  addExample, createDetector, createMethod, finishRun, getMethod, listDetectors, listExamples, listMethods, listRuns,
  listSubjects, recordSubject, setDetectorMode, setTrustState, startRun,
} from '../server/repos/searchMethods.ts';

beforeEach(async () => { await freshProject(); });
afterEach(async () => { await teardown(); });

const A = { projectId: 'pa', userId: 'ua' };
const B = { projectId: 'pb', userId: 'ub' };

describe('search intelligence schema', () => {
  it('filters every read by project and user, and shares only GENERAL', async () => {
    await createMethod({ scope: 'PROJECT', projectId: 'pa', name: 'a-private', finds: 'x' });
    await createMethod({ scope: 'USER', userId: 'ua', name: 'a-user', finds: 'x' });
    const g = await createMethod({ scope: 'GENERAL', name: 'general', finds: 'x' });
    expect((await listMethods(A)).map((m) => m.name).sort()).toEqual(['a-private', 'a-user', 'general']);
    expect((await listMethods(B)).map((m) => m.name)).toEqual(['general']);
    expect((await listMethods({})).map((m) => m.id)).toEqual([g.id]);
    const priv = (await listMethods(A)).find((m) => m.name === 'a-private')!;
    expect(await getMethod(priv.id, B)).toBeNull();
    expect(await listRuns(priv.id, B)).toEqual([]);
  });
  it('refuses a scope without its owner at both the repository and the database', async () => {
    await expect(createMethod({ scope: 'PROJECT', name: 'n', finds: 'x' })).rejects.toThrow(/PROJECT/);
    await expect(createMethod({ scope: 'GENERAL', projectId: 'pa', name: 'n', finds: 'x' })).rejects.toThrow(/GENERAL/);
    await expect(getDb().run(`INSERT INTO search_methods (id, scope, name, finds, created_at, updated_at) VALUES ('x','PROJECT','n','f','t','t')`)).rejects.toThrow();
  });
  it('starts a method PROPOSED and moves trust only with a guard', async () => {
    const m = await createMethod({ scope: 'GENERAL', name: 'm', finds: 'x' });
    expect(m.trustState).toBe('PROPOSED');
    expect(await setTrustState({ id: m.id, from: 'TESTING', to: 'PROVEN' })).toBe(false);
    expect(await setTrustState({ id: m.id, from: 'PROPOSED', to: 'TESTING' })).toBe(true);
    expect((await getMethod(m.id, {}))!.trustState).toBe('TESTING');
  });
  it('keeps the three ways a run can find nothing apart, and the first result stands', async () => {
    const m = await createMethod({ scope: 'PROJECT', projectId: 'pa', name: 'm', finds: 'x' });
    const run = await startRun({ methodId: m.id, projectId: 'pa' });
    expect(await finishRun({ id: run, examined: 10, kept: 0, falsePositives: 0, outcome: 'SOURCE_UNAVAILABLE', failureCause: 'HTTP 503' })).toBe(true);
    expect(await finishRun({ id: run, examined: 10, kept: 5, falsePositives: 0, outcome: 'FOUND' })).toBe(false);
    expect((await listRuns(m.id, A))[0]).toMatchObject({ outcome: 'SOURCE_UNAVAILABLE', failureCause: 'HTTP 503' });
    const r2 = await startRun({ methodId: m.id });
    await expect(getDb().run(`UPDATE search_method_runs SET outcome = 'BAD' WHERE id = ?`, [r2])).rejects.toThrow();
  });
  it('stores detectors as data starting SHADOW, with examples, and subjects once per scope', async () => {
    const d = await createDetector({ scope: 'USER', userId: 'ua', definition: { rule: 'x' }, threshold: 0.9 });
    expect(d).toMatchObject({ mode: 'SHADOW', threshold: 0.9, definition: { rule: 'x' } });
    expect(await setDetectorMode({ id: d.id, from: 'ACTIVE', to: 'SHADOW' })).toBe(false);
    expect(await setDetectorMode({ id: d.id, from: 'SHADOW', to: 'ACTIVE' })).toBe(true);
    expect(await addExample({ detectorId: d.id, itemRef: 'i1', label: 'POSITIVE' })).toBe(true);
    expect(await addExample({ detectorId: d.id, itemRef: 'i1', label: 'NEGATIVE' })).toBe(false);
    expect(await listExamples(d.id, A)).toEqual([{ itemRef: 'i1', label: 'POSITIVE' }]);
    expect(await listExamples(d.id, B)).toEqual([]);
    expect(await listDetectors(B)).toEqual([]);
    const s1 = await recordSubject({ scope: 'PROJECT', projectId: 'pa', subject: 'tankers' });
    const s2 = await recordSubject({ scope: 'PROJECT', projectId: 'pa', subject: 'tankers' });
    expect(s2.id).toBe(s1.id);
    expect(await listSubjects(B)).toEqual([]);
  });
});
