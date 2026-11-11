/**
 * A learned subject reaches the search as a lens, walked through openDiscovery.
 *
 * The harvest test proves a finished mission teaches a subject and that the
 * subject is listed as a lens. This one proves the step after: the production
 * opener, `openDiscovery`, actually opens and records a round on that lens,
 * and that a project's private subject is never
 * opened for another project.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { learnSubject, SUBJECT_LENS_PREFIX } from '../server/services/knowledge/subjects/subjects.ts';
import { openDiscovery } from '../server/services/cash/discovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const user = await createUser({
    email: `walk-subj-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
  expect(outcome.ok).toBe(true);
});

describe('a learned subject, walked through openDiscovery', () => {
  it('opens a round on the learned lens', async () => {
    const subject = await learnSubject({
      scope: 'PROJECT', projectId, label: 'County parcel research', kind: 'MARKET',
      origin: 'harvest', sourceRef: 'claim:walk',
    });
    const opened = await openDiscovery({ projectId, limit: 200 });
    const lens = opened.find((one) => one.bucketId === `${SUBJECT_LENS_PREFIX}${subject.id}`);
    expect(lens).toBeDefined();
    const round = (await listRounds(projectId)).find((one) => one.bucketId === lens!.bucketId);
    expect(round).toMatchObject({ candidateId: lens!.candidateId, round: 1 });
  });

  it("never opens another project's private subject", async () => {
    const other = await learnSubject({
      scope: 'PROJECT', projectId: 'prj_someone_else', label: 'Someone else market', kind: 'MARKET',
      origin: 'harvest', sourceRef: 'claim:other',
    });
    const opened = await openDiscovery({ projectId, limit: 200 });
    expect(opened.some((one) => one.bucketId === `${SUBJECT_LENS_PREFIX}${other.id}`)).toBe(false);
  });
});
