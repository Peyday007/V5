import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { openDiscovery, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listLearnedSubjects } from '../server/repos/searchMethods.ts';
import {
  learnedLensesForProject, learnSubject, lensFor, subjectKeyFor, SUBJECT_LENS_PREFIX,
} from '../server/services/knowledge/subjects/subjects.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `subjects-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const o = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
  expect(o.ok).toBe(true);
}

describe('learned subjects as discovery lenses', () => {
  it('stores a subject with its source, merges it beside the constants and opens a round for it', async () => {
    await activated();
    const s = await learnSubject({ scope: 'PROJECT', projectId, label: 'Mobile Notary Services', origin: 'research',
      sourceRef: 'claim:clm_123', description: 'signing agents' });
    expect(s.sourceRef).toBe('claim:clm_123');

    const lenses = await learnedLensesForProject(projectId);
    expect(lenses.map((l) => l.id)).toEqual([`${SUBJECT_LENS_PREFIX}${s.id}`]);

    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 5 });
    expect(opened.map((o) => o.bucketId)).toContain(`${SUBJECT_LENS_PREFIX}${s.id}`);
    expect(opened).toHaveLength(SEARCH_BUCKETS.length + 1); // constants stay, subject is added
    expect((await listRounds(projectId)).some((r) => r.bucketId === `${SUBJECT_LENS_PREFIX}${s.id}`)).toBe(true);
  });

  it('survives a restart: it is a row, and re-learning it is one subject', async () => {
    const a = await learnSubject({ scope: 'PROJECT', projectId, label: 'Dock Leveler Repair', origin: 'research', sourceRef: 'claim:a' });
    const b = await learnSubject({ scope: 'PROJECT', projectId, label: ' dock  leveler repair ', origin: 'research', sourceRef: 'claim:b' });
    expect(b.id).toBe(a.id);
    expect(await listLearnedSubjects({ projectIds: [projectId], userId: null })).toHaveLength(1);
  });

  it('runs the same path for a non-cash target', async () => {
    const s = await learnSubject({ scope: 'PROJECT', projectId, label: 'County parcel records', kind: 'DATASET',
      origin: 'research', sourceRef: 'doc:1' });
    expect(s.subjectKey).toBe(subjectKeyFor('County parcel records', 'DATASET'));
    expect(lensFor(s).question).toMatch(/public datasets/);
  });

  it("does not offer another project's subject, but does offer a GENERAL one", async () => {
    const other = await freshProject();
    await learnSubject({ scope: 'PROJECT', projectId: other.project.id, label: 'Private thing', origin: 'research', sourceRef: 'x' });
    await learnSubject({ scope: 'GENERAL', label: 'Shared method area', origin: 'research', sourceRef: 'y' });
    const labels = (await learnedLensesForProject(projectId)).map((l) => l.title);
    expect(labels).toEqual(['Learned subject: Shared method area']);
  });

  it('refuses a subject with no source', async () => {
    await expect(learnSubject({ scope: 'PROJECT', projectId, label: 'x', origin: 'research', sourceRef: ' ' })).rejects.toThrow(/source/);
  });
});
