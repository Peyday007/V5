import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createMethod, getMethod, listMethods, listRuns, listSubjects, moveTrust, recordRun, recordSubject } from '../server/repos/searchMethods.ts';

describe('search intelligence repository', () => {
  let projectId: string;
  beforeEach(async () => { projectId = (await freshProject()).project.id; });

  it('stores a subject once per scope with its source, and survives a re-ask', async () => {
    const a = await recordSubject({ scope: 'PROJECT', projectId, targetKind: 'supplier', name: 'Pallet racking', source: 'research:x' });
    const b = await recordSubject({ scope: 'PROJECT', projectId, targetKind: 'supplier', name: '  pallet   RACKING ', source: 'research:y' });
    expect(b.id).toBe(a.id);
    expect(a.source).toBe('research:x');
    expect(await listSubjects({ projectId, userId: null })).toHaveLength(1);
  });

  it('refuses a subject with no source', async () => {
    await expect(recordSubject({ scope: 'GENERAL', targetKind: 'dataset', name: 'x', source: ' ' })).rejects.toThrow(/where it came from/);
  });

  it('scopes reads: another project sees only GENERAL, a user sees their own', async () => {
    await recordSubject({ scope: 'PROJECT', projectId, targetKind: 'a', name: 'private', source: 's' });
    await recordSubject({ scope: 'USER', userId: 'u1', targetKind: 'a', name: 'mine', source: 's' });
    await recordSubject({ scope: 'GENERAL', targetKind: 'a', name: 'shared', source: 's' });
    const names = async (v: { projectId: string | null; userId: string | null }) => (await listSubjects(v)).map((s) => s.name).sort();
    expect(await names({ projectId: 'other', userId: 'u2' })).toEqual(['shared']);
    expect(await names({ projectId, userId: 'u1' })).toEqual(['mine', 'private', 'shared']);
  });

  it('creates methods PROPOSED, hides private ones, and moves trust once', async () => {
    const m = await createMethod({ scope: 'PROJECT', projectId, name: 'm', finds: 'things', sources: ['https://x.test'] });
    expect(m.trustState).toBe('PROPOSED');
    expect(m.sources).toEqual(['https://x.test']);
    expect(await getMethod({ projectId: 'other', userId: null }, m.id)).toBeNull();
    expect(await listMethods({ projectId: 'other', userId: null })).toHaveLength(0);
    expect(await moveTrust(m.id, 'PROPOSED', 'TESTING')).toBe(true);
    expect(await moveTrust(m.id, 'PROPOSED', 'TESTING')).toBe(false);
  });

  it('records runs with their cause', async () => {
    const m = await createMethod({ scope: 'GENERAL', name: 'g', finds: 'f' });
    await recordRun({ methodId: m.id, relevant: 3, aiJobsAvoided: 2 });
    await recordRun({ methodId: m.id, failureCause: 'SOURCE_UNAVAILABLE' });
    const runs = await listRuns(m.id);
    expect(runs.map((r) => r.failureCause)).toEqual([null, 'SOURCE_UNAVAILABLE']);
    expect(runs[0]?.aiJobsAvoided).toBe(2);
  });
});
