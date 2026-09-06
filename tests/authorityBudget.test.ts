/**
 * Two limits, two questions.
 *
 * `ceilingFor` answered both with `Math.min(maxMissions, maxConcurrent)` over a
 * cumulative count that includes settled rows. A grant of **two missions, one
 * at a time** therefore permitted exactly **one mission, ever**, and silently
 * refused the automatic follow-on — with `maxConcurrent` appearing in that one
 * `Math.min` and nowhere else in the tree, so it never limited concurrency at
 * all.
 *
 * Anybody reading those numbers from their plain meaning would under-authorize
 * and not find out until a follow-on vanished. These tests hold the corrected
 * distinction in place: finishing a mission gives back concurrency and refunds
 * nothing cumulative.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  createGoal,
  releaseReservation,
  reserve,
  settleReservation,
} from '../server/repos/russellAuthority.ts';

let projectId = '';
let userId = '';
let goalId = '';

/** Exactly the limits the owner approved. */
const APPROVED = {
  maxMissions: 2,
  maxFragments: 12,
  maxConcurrent: 1,
  maxProbes: 3,
} as const;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `budget-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const goal = await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Research the discovery questions',
    allowedWork: ['RESEARCH'],
    ...APPROVED,
  });
  goalId = goal.id;
});

/** A mission reservation, through the same call `launch()` makes. */
function mission(key: string) {
  return reserve({ goalId, kind: 'MISSION' as const, idempotencyKey: key });
}

describe('the approved grant, through the real reservation path', () => {
  it('permits the first mission, refuses the second while it is active', async () => {
    const first = await mission('m1');
    expect(first.ok).toBe(true);

    const second = await mission('m2');
    // Refused on concurrency, not on the total — the distinction the old code
    // could not express, and the reason it refused the follow-on forever.
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/1 mission at a time/);
  });

  it('permits the follow-on once the first mission settles', async () => {
    const first = await mission('m1');
    expect((await mission('m2')).ok).toBe(false);

    // The mission finished. Concurrency comes back; the spend does not.
    expect(await settleReservation(first.reservation!.id)).toBe(true);

    const followOn = await mission('m2');
    expect(followOn.ok).toBe(true);
    expect(followOn.reservation).not.toBeNull();
  });

  it('refuses a third after two have consumed the grant, even with none active', async () => {
    const first = await mission('m1');
    await settleReservation(first.reservation!.id);
    const second = await mission('m2');
    expect(second.ok).toBe(true);
    await settleReservation(second.reservation!.id);

    const third = await mission('m3');
    // Nothing is running, so concurrency is free — and the grant is spent.
    // A settled mission still counts, which is the half of the distinction
    // that stops "one at a time" becoming "unlimited over time".
    expect(third.ok).toBe(false);
    expect(third.reason).toMatch(/allows 2 mission in total/);
  });

  it('gives back concurrency when a reservation is released rather than settled', async () => {
    const first = await mission('m1');
    expect((await mission('m2')).ok).toBe(false);

    // A launch that stood down. The slot returns and, unlike a settlement,
    // so does the cumulative allowance — nothing was spent.
    await releaseReservation({ reservationId: first.reservation!.id, reason: 'the launch stood down' });

    const retry = await mission('m3');
    expect(retry.ok).toBe(true);
    const andAnother = await mission('m4');
    expect(andAnother.ok).toBe(false);
    expect(andAnother.reason).toMatch(/at a time/);
  });

  it('bounds fragments and probes by their totals', async () => {
    // Twelve fragments across the grant, and the thirteenth refused. Fragments
    // have no separate concurrency limit, so the second check can never be the
    // one that stops them.
    for (let i = 0; i < APPROVED.maxFragments; i += 1) {
      expect((await reserve({ goalId, kind: 'FRAGMENT', idempotencyKey: `f${i}` })).ok).toBe(true);
    }
    expect((await reserve({ goalId, kind: 'FRAGMENT', idempotencyKey: 'f12' })).ok).toBe(false);

    for (let i = 0; i < APPROVED.maxProbes; i += 1) {
      expect((await reserve({ goalId, kind: 'PROBE', idempotencyKey: `p${i}` })).ok).toBe(true);
    }
    expect((await reserve({ goalId, kind: 'PROBE', idempotencyKey: 'p3' })).ok).toBe(false);
  });
});

describe('two requests racing for the last slot', () => {
  it('gives the concurrent slot to exactly one of them', async () => {
    const [a, b] = await Promise.all([mission('race-a'), mission('race-b')]);
    // Exactly one, never both and never neither. Both winning would spend a
    // slot twice; both standing down is the mutual abort the rank exists to
    // prevent, and is strictly worse than either one winning.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.reason).toMatch(/at a time/);
  });

  it('gives the last cumulative slot to exactly one of them', async () => {
    // Spend one of the two, and settle it so concurrency is not what decides.
    const first = await mission('m1');
    await settleReservation(first.reservation!.id);

    const [a, b] = await Promise.all([mission('last-a'), mission('last-b')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    // Whichever ranked second is over the total, not over concurrency.
    expect(loser.reason).toMatch(/in total/);
  });

  it('is idempotent by key, so a retry is not a second mission', async () => {
    const first = await mission('same-key');
    const again = await mission('same-key');
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.reservation!.id).toBe(first.reservation!.id);

    // And the grant still has its second mission, because the retry was the
    // same attempt rather than another one.
    await settleReservation(first.reservation!.id);
    expect((await mission('genuinely-second')).ok).toBe(true);
  });
});

describe('through the launch path, with the key launch actually uses', () => {
  /**
   * `launch()` keys a mission reservation `russell:mission:<candidate>:<goal>`,
   * which is stable per candidate on purpose — a retry must not become a second
   * mission. That stability is exactly what made a refusal permanent: the
   * released row was read back as a refusal forever, so a candidate refused
   * once on concurrency could never launch however free the fleet became.
   */
  function launchKey(candidateId: string): string {
    return `russell:mission:${candidateId}:${goalId}`;
  }

  it('lets the same candidate through once the slot frees, using its stable key', async () => {
    const busy = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-a') });
    expect(busy.ok).toBe(true);

    const blocked = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/at a time/);

    await settleReservation(busy.reservation!.id);

    // The same candidate, the same key, on the next tick. This is the case
    // that was permanently refused.
    const nowAllowed = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') });
    expect(nowAllowed.ok).toBe(true);
  });

  it('still refuses a genuine third candidate after the grant is spent', async () => {
    const a = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-a') });
    await settleReservation(a.reservation!.id);
    const b = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') });
    expect(b.ok).toBe(true);
    await settleReservation(b.reservation!.id);

    const c = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-c') });
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/in total/);
  });

  it('does not let a revived key spend the grant twice', async () => {
    const a = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-a') });
    const blocked = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') });
    expect(blocked.ok).toBe(false);
    await settleReservation(a.reservation!.id);

    // Revived and settled — one mission, not two, however many times its
    // reservation was attempted.
    const revived = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') });
    await settleReservation(revived.reservation!.id);

    const third = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-c') });
    expect(third.ok).toBe(false);
    expect(third.reason).toMatch(/in total/);
  });

  it('gives a revived key to one caller when two race for it', async () => {
    const busy = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-a') });
    await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') });
    await settleReservation(busy.reservation!.id);

    const [x, y] = await Promise.all([
      reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') }),
      reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-b') }),
    ]);
    // The same logical mission, so both callers succeed — one revived it and
    // the other replayed. What must never happen is two reservations.
    expect(x.ok && y.ok).toBe(true);
    expect(x.reservation!.id).toBe(y.reservation!.id);

    // And the grant still has nothing left to give a different candidate.
    await settleReservation(x.reservation!.id);
    const third = await reserve({ goalId, kind: 'MISSION', idempotencyKey: launchKey('cand-c') });
    expect(third.ok).toBe(false);
  });
});
