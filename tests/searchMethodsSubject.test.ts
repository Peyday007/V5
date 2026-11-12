/**
 * F4-2: compared methods must be for one subject, so production must say which
 * subject a method is for.
 *
 * Every method here is made by a production path — `recordRoundAsRun` for a
 * learned subject's lens, `shareAsGeneral` for the GENERAL copy — never by a
 * test that hands `createSearchMethod` a subject id, which is exactly how the
 * defect stayed hidden.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createSearchMethod, getSearchMethod, listMethodComparisons } from '../server/repos/searchMethods.ts';
import { learnSubject, lensFor } from '../server/services/knowledge/subjects/subjects.ts';
import {
  compareSubjectBuckets, methodForBucket, readerForProject, recordRoundAsRun, subjectOfBucket,
} from '../server/services/research/searchMethods/bucketMethods.ts';
import { compareMethods } from '../server/services/research/searchMethods/compare.ts';
import { shareAsGeneral } from '../server/services/knowledge/scope/share.ts';
import { runSearchCli } from '../server/services/research/searchReport/cli.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const found = { to: 'HARVESTED' as const, missionState: 'COMPLETED', found: 3, useful: 2, duplicates: 0 };

async function projectLens(label: string) {
  const subject = await learnSubject({ scope: 'PROJECT', projectId, label, kind: 'DATASET', origin: 'harvest', sourceRef: 'claim:c1' });
  return { subject, bucket: lensFor(subject) };
}

describe('a method knows its subject', () => {
  it('links the method a learned lens runs as to the subject it was asked through', async () => {
    const { subject, bucket } = await projectLens('county parcel datasets');
    expect(subjectOfBucket(bucket.id)).toBe(subject.id);
    const ran = await recordRoundAsRun(projectId, bucket, found);
    expect(ran?.method.subjectId).toBe(subject.id);
  });

  it('links a lens method recorded before the link existed, and never rewrites a stated subject', async () => {
    const { subject, bucket } = await projectLens('state grant listings');
    const old = await createSearchMethod({
      scope: 'PROJECT', projectId, methodKey: bucket.id, finds: 'x', sources: ['cash discovery round'], checkProcedure: 'c',
    });
    expect(old.subjectId).toBeNull();
    const linked = await methodForBucket(projectId, bucket);
    expect(linked.id).toBe(old.id);
    expect(linked.subjectId).toBe(subject.id);
    const again = await createSearchMethod({
      scope: 'PROJECT', projectId, methodKey: bucket.id, subjectId: 'another', finds: 'x', sources: ['s'], checkProcedure: 'c',
    });
    expect(again.subjectId).toBe(subject.id);
  });

  it('leaves a mechanism bucket, which asks about no one subject, without one', async () => {
    const method = await methodForBucket(projectId, { id: 'public-rfps', title: 'Public RFPs' });
    expect(method.subjectId).toBeNull();
  });
});

describe('comparing real methods for one subject', () => {
  it('the CLI compares a project lens method with a GENERAL lens on the same subject', async () => {
    const own = await projectLens('county parcel datasets');
    const general = await learnSubject({ scope: 'GENERAL', label: 'Parcel datasets for counties', kind: 'DATASET', origin: 'shared', sourceRef: 'test' });
    expect(general.subjectKey).toBe(own.subject.subjectKey);
    const a = (await recordRoundAsRun(projectId, own.bucket, found))!.method;
    const b = (await recordRoundAsRun(projectId, lensFor(general), found))!.method;

    const out = await runSearchCli(['compare', '--project', projectId, '--subject', own.subject.id, '--file', 'r.json'], {
      readFile: () => JSON.stringify({
        items: ['o1', 'o2', 'o3'],
        results: {
          [a.id]: { surfaced: ['o1', 'o2'], confirmed: ['o1', 'o2'], rejected: [] },
          [b.id]: { surfaced: ['o2', 'o3'], confirmed: ['o2'], rejected: ['o3'] },
        },
      }),
    });
    expect(out.code).toBe(0);
    expect(out.out).toContain('comparison');
    const [stored] = await listMethodComparisons(readerForProject(projectId), { subjectId: own.subject.id });
    expect(stored?.entries.map((e) => e.methodId)).toEqual([a.id, b.id]);
  });

  it('still refuses methods for different subjects', async () => {
    const one = await projectLens('county parcel datasets');
    const two = await projectLens('wind turbine suppliers');
    const a = (await recordRoundAsRun(projectId, one.bucket, found))!.method;
    const b = (await recordRoundAsRun(projectId, two.bucket, found))!.method;
    const r = await compareMethods(readerForProject(projectId), {
      subjectId: one.subject.id, items: ['x'],
      results: { [a.id]: { surfaced: ['x'], confirmed: [], rejected: [] }, [b.id]: { surfaced: ['x'], confirmed: [], rejected: [] } },
    });
    expect(r).toEqual({ ok: false, reason: 'Every compared method must be for the same subject.' });
  });

  it('a method shared as GENERAL stays for the same subject, so the copy and the original compare', async () => {
    const { subject, bucket } = await projectLens('county parcel datasets');
    const original = (await recordRoundAsRun(projectId, bucket, found))!.method;
    const shared = await shareAsGeneral(readerForProject(projectId), original.id);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.method.subjectId).not.toBeNull();
    // The private subject row is not what the GENERAL copy points at.
    expect(shared.method.subjectId).not.toBe(subject.id);
    const r = await compareMethods(readerForProject(projectId), {
      subjectId: subject.id, items: ['x', 'y'],
      results: {
        [original.id]: { surfaced: ['x'], confirmed: ['x'], rejected: [] },
        [shared.method.id]: { surfaced: ['y'], confirmed: [], rejected: ['y'] },
      },
    });
    expect(r.ok).toBe(true);
    // Another project reads the GENERAL copy, and its subject, but never the private row.
    const other = readerForProject('prj_someone_else');
    expect(await getSearchMethod(other, shared.method.id)).not.toBeNull();
    expect(await getSearchMethod(other, original.id)).toBeNull();
  });

  it('compares a subject\'s methods automatically on what their rounds filed, once per new data', async () => {
    const own = await projectLens('county parcel datasets');
    const general = await learnSubject({ scope: 'GENERAL', label: 'parcel datasets county', kind: 'DATASET', origin: 'shared', sourceRef: 'test' });
    const a = (await recordRoundAsRun(projectId, own.bucket, found))!.method;
    const b = (await recordRoundAsRun(projectId, lensFor(general), found))!.method;
    const other = await projectLens('wind turbine suppliers');
    await recordRoundAsRun(projectId, other.bucket, found);

    const yields = new Map([
      [own.bucket.id, { surfaced: ['o1', 'o2'], confirmed: ['o1'], rejected: [] }],
      [lensFor(general).id, { surfaced: ['o3', 'o4'], confirmed: [], rejected: ['o3'] }],
      [other.bucket.id, { surfaced: ['o9'], confirmed: ['o9'], rejected: [] }],
    ]);
    const first = await compareSubjectBuckets(projectId, own.subject.id, yields);
    expect(first?.ok).toBe(true);
    if (!first?.ok) return;
    expect(first.comparison.ranking.map((r) => r.methodId)).toEqual([a.id, b.id]);
    expect(first.comparison.items).toBe(4);
    // Nothing new: nothing written.
    expect(await compareSubjectBuckets(projectId, own.subject.id, yields)).toBeNull();
    expect(await listMethodComparisons(readerForProject(projectId), { subjectId: own.subject.id })).toHaveLength(1);
    // One method alone is not a comparison.
    expect(await compareSubjectBuckets(projectId, other.subject.id, yields)).toBeNull();
  });
});
