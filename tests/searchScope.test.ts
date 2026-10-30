import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createSearchMethod, getSearchMethod, listSearchMethods, upsertLearnedSubject, listLearnedSubjects } from '../server/repos/searchMethods.ts';
import { privateDataIn, shareAsGeneral } from '../server/services/knowledge/scope/index.ts';
import type { SearchReader } from '../server/domain/searchIntelligence.ts';

const A: SearchReader = { projectIds: ['prj_aaaaaaaa'], userId: null };
const B: SearchReader = { projectIds: ['prj_bbbbbbbb'], userId: null };
const method = (projectId: string, key: string, finds = 'public tenders for fabricated trailers') =>
  createSearchMethod({
    scope: 'PROJECT', projectId, methodKey: key, finds, sources: ['https://example.gov/tenders'],
    checkProcedure: 'open the notice and confirm a deadline and a buyer',
  });

describe('search scope', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('keeps what one project learned unreadable from another', async () => {
    const m = await method('prj_aaaaaaaa', 'private-a');
    await upsertLearnedSubject({ scope: 'PROJECT', projectId: 'prj_aaaaaaaa', subjectKey: 'sub-a', label: 'A only', origin: 'test' } as never);
    expect(await getSearchMethod(A, m.id)).not.toBeNull();
    expect(await getSearchMethod(B, m.id)).toBeNull();
    expect((await listSearchMethods(B)).map((x) => x.id)).not.toContain(m.id);
    expect((await listLearnedSubjects(B)).map((x) => x.subjectKey)).not.toContain('sub-a');
  });

  it('shares a method with no private data as a GENERAL one readable from both, starting unproven', async () => {
    const m = await method('prj_aaaaaaaa', 'shareable');
    const shared = await shareAsGeneral(A, m.id);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.method.scope).toBe('GENERAL');
    expect(shared.method.trustState).toBe('PROPOSED');
    expect(await getSearchMethod(A, shared.method.id)).not.toBeNull();
    expect(await getSearchMethod(B, shared.method.id)).not.toBeNull();
    expect(await getSearchMethod(B, m.id)).toBeNull();
  });

  it('refuses to share a definition holding private data, and says what it found', async () => {
    const leaky = await method('prj_aaaaaaaa', 'leaky', 'ask jane.doe@example.com about the Acme Corp account');
    const r = await shareAsGeneral(A, leaky.id, { terms: ['Acme Corp'] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.found).toEqual(expect.arrayContaining(['an email address', 'the private term "Acme Corp"']));
    expect((await listSearchMethods(B)).some((x) => x.methodKey === 'leaky')).toBe(false);
  });

  it('cannot share a method the reader cannot see', async () => {
    const m = await method('prj_aaaaaaaa', 'hidden');
    expect((await shareAsGeneral(B, m.id)).ok).toBe(false);
  });

  it('spots ids, credentials and long tokens', () => {
    const base = { finds: 'x', usefulWhen: null, sources: [], requiredInputs: [], query: null, checkProcedure: 'y', limits: null };
    expect(privateDataIn({ ...base, query: 'project prj_abc12345' })).toContain('a Brain identifier');
    expect(privateDataIn({ ...base, query: 'brnw_abcdefghijklmnop' })).toContain('a credential');
    expect(privateDataIn(base)).toEqual([]);
  });
});
