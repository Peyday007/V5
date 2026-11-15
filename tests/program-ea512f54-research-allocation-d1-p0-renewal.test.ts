/**
 * RES-15-4 (S-0148), finding F4: the family's priority window is a recorded
 * decision, not a code date.
 *
 * Before this, `renewFamily` returned an object nothing persisted, so the
 * priority lapsed on the date written in `INTERMEDIATION_FAMILY` unless the
 * source was edited and redeployed. This proves a person can renew it from
 * the terminal, that the renewal is an append-only row saying who and why,
 * that the readers of the window (discovery order and the room offer) honour
 * it after the code date, that a later decision supersedes an earlier one
 * (including shortening it), and that only the Cash Mode owner or an enabled
 * administrator may decide it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { familyCurrent, INTERMEDIATION_FAMILY } from '../server/services/cash/intermediationPositions.ts';
import { FAMILY_RENEWED_KIND, familyDeclarationFor, recordFamilyRenewal } from '../server/services/cash/familyPriority.ts';
import { runFamilyPriorityCommand } from '../server/services/cash/familyPriorityCli.ts';
import { offerToFamily } from '../server/services/cash/researchRoom.ts';
import { discoveryOrder, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { isIntermediationBucket } from '../server/services/cash/intermediationBuckets.ts';

let projectId = '';
let ownerId = '';
let ownerEmail = '';
const suffix = (): string => Math.random().toString(36).slice(2, 10);
/** After the window written in code has ended. */
const LAPSED = '2027-03-01T00:00:00.000Z';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  ownerEmail = `family-owner-${suffix()}@example.test`;
  ownerId = (await createUser({ email: ownerEmail, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: ownerId, actorUserId: ownerId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('renewing the intermediation family priority', () => {
  it('lapses on the code date with no recorded decision', async () => {
    const declaration = await familyDeclarationFor(projectId);
    expect(declaration).toEqual(INTERMEDIATION_FAMILY);
    expect(familyCurrent(declaration, LAPSED)).toBe(false);
  });

  it('a renewal from the terminal is a row, and every reader honours it after the code date', async () => {
    const renewed = await runFamilyPriorityCommand(
      ['renew', '--project', projectId, '--as', ownerEmail, '--review-by', '2027-06-01', '--reason', 'intermediation is still the fastest family'],
      new Date(LAPSED),
    );
    expect(renewed.code).toBe(0);
    expect(renewed.out).toMatch(/CURRENT/);
    expect(renewed.out).not.toMatch(/NOT CURRENT/);

    const rows = await cashEventsOfKindInProject(projectId, FAMILY_RENEWED_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorRef: ownerId });
    expect(rows[0]!.detail).toMatchObject({
      familyKey: INTERMEDIATION_FAMILY.key,
      reviewBy: '2027-06-01T00:00:00.000Z',
      previousReviewBy: INTERMEDIATION_FAMILY.reviewBy,
      reason: 'intermediation is still the fastest family',
    });

    const declaration = await familyDeclarationFor(projectId);
    expect(familyCurrent(declaration, LAPSED)).toBe(true);
    // The code declaration is untouched; the record is what moved.
    expect(INTERMEDIATION_FAMILY.reviewBy).toBe('2027-02-14');

    const room = { room: 3, cap: 3, inFlight: 0, reason: 'free slots' } as unknown as Parameters<typeof offerToFamily>[0];
    expect(offerToFamily(room, { kind: null, familyWaiting: 2, now: LAPSED }).family).toBeUndefined();
    const offered = offerToFamily(room, { kind: null, familyWaiting: 2, now: LAPSED, declaration });
    expect(offered.family?.heldForFamily).toBe(2);
    expect(offered.family?.reviewBy).toBe('2027-06-01T00:00:00.000Z');

    const ordered = discoveryOrder(SEARCH_BUCKETS, [], LAPSED, declaration);
    const firstOther = ordered.findIndex((one) => !isIntermediationBucket(one));
    const lastFamily = ordered.map((one) => isIntermediationBucket(one)).lastIndexOf(true);
    expect(lastFamily).toBeGreaterThanOrEqual(0);
    expect(lastFamily).toBeLessThan(firstOther);
  });

  it('the newest decision governs, so a person can also end the priority early without a redeploy', async () => {
    expect((await recordFamilyRenewal({ projectId, actorUserId: ownerId, reviewBy: '2027-06-01', reason: 'extend' })).status).toBe('RECORDED');
    await tick();
    expect((await recordFamilyRenewal({ projectId, actorUserId: ownerId, reviewBy: '2026-12-01', reason: 'retire early' })).status).toBe('RECORDED');
    const declaration = await familyDeclarationFor(projectId);
    expect(declaration.reviewBy).toBe('2026-12-01T00:00:00.000Z');
    expect(familyCurrent(declaration, '2026-12-15T00:00:00Z')).toBe(false);
    expect(await cashEventsOfKindInProject(projectId, FAMILY_RENEWED_KIND)).toHaveLength(2);
  });

  it('refuses a stranger, a missing reason and a date that is not after the window began', async () => {
    const strangerEmail = `stranger-${suffix()}@example.test`;
    const stranger = await createUser({ email: strangerEmail, displayName: 'Stranger', password: 'correct horse battery staple' });
    const refused = await recordFamilyRenewal({ projectId, actorUserId: stranger.id, reviewBy: '2027-06-01', reason: 'mine now' });
    expect(refused).toMatchObject({ status: 'REFUSED', refusal: 'NOT_AUTHORIZED' });
    expect((await runFamilyPriorityCommand(['renew', '--project', projectId, '--as', strangerEmail, '--review-by', '2027-06-01', '--reason', 'x'])).code).toBe(1);
    expect(await recordFamilyRenewal({ projectId, actorUserId: ownerId, reviewBy: '2027-06-01', reason: '  ' })).toMatchObject({ refusal: 'REASON_REQUIRED' });
    expect(await recordFamilyRenewal({ projectId, actorUserId: ownerId, reviewBy: 'someday', reason: 'x' })).toMatchObject({ refusal: 'INVALID_REVIEW_DATE' });
    expect(await recordFamilyRenewal({ projectId, actorUserId: ownerId, reviewBy: '2026-01-01', reason: 'x' })).toMatchObject({ refusal: 'NOT_AFTER_SINCE' });
    expect((await runFamilyPriorityCommand(['renew', '--project', projectId, '--as', ownerEmail])).code).toBe(2);
    expect(await cashEventsOfKindInProject(projectId, FAMILY_RENEWED_KIND)).toHaveLength(0);
    expect(familyCurrent(await familyDeclarationFor(projectId), LAPSED)).toBe(false);
  });
});
