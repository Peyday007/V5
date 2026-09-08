/**
 * Two limits, two questions — and only one of them is still a limit.
 *
 * `ceilingFor` once answered both with `Math.min(maxMissions, maxConcurrent)`
 * over a cumulative count that includes settled rows. A grant of **two
 * missions, one at a time** therefore permitted exactly **one mission, ever**,
 * and silently refused the automatic follow-on — with `maxConcurrent`
 * appearing in that one `Math.min` and nowhere else in the tree, so it never
 * limited concurrency at all. Most of this file holds that corrected
 * distinction in place: finishing a mission gives back concurrency and refunds
 * nothing cumulative.
 *
 * The cumulative half is now the CAPPED policy, which the product no longer
 * issues and only grants that have already ended still carry. It is tested
 * here because those rows are real and the guard still has to be right about
 * them — not because a person is ever asked for those numbers again.
 *
 * What the product issues is UNCAPPED, and the last block is the one that
 * matters most: research keeps starting for as long as there is work worth
 * doing, on the subscription that is already paid for, while concurrency —
 * which is real provider capacity rather than an allowance — still refuses the
 * second simultaneous mission every time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { authorityFor } from '../server/services/russell/authority.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  createGoal,
  listReservations,
  releaseReservation,
  reserve,
  settleReservation,
} from '../server/repos/russellAuthority.ts';

let projectId = '';
let userId = '';
let goalId = '';

/**
 * A capped grant, of the shape grants used to have.
 *
 * Written out rather than taken from a constant because nothing produces these
 * numbers any more: they are the four the owner set on the live 12A grant, and
 * the guard still has to enforce them correctly for every grant that carries
 * them.
 */
const APPROVED = {
  workPolicy: 'CAPPED',
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

describe('what the card says and what the guard does', () => {
  it('counts an amount, not a row, so the two cannot disagree', async () => {
    /*
     * `spendOf` counted reservation rows while `totalsThroughMine` summed
     * `amount`. Every caller passes no amount today, so both came out the same
     * and nothing noticed — and `reserve` takes one, so the first reservation
     * of 2 would have enforced as 2 and displayed as 1. A person would read
     * "1 of 2 used" on the card and watch Russell refuse to start anything.
     *
     * §24's rule is that the contract a person is shown and the contract the
     * validator enforces are one object. This is the arithmetic half of it.
     */
    /*
     * A fragment, because a MISSION reservation of 2 is refused outright — the
     * concurrency ceiling is 1 and the guard sums `amount` there too, which is
     * itself the property under test. Fragments have no separate concurrency
     * limit, so this isolates the cumulative arithmetic.
     */
    const ten = await reserve({
      goalId,
      kind: 'FRAGMENT',
      idempotencyKey: 'weighted',
      amount: 10,
    });
    expect(ten.ok).toBe(true);
    expect(ten.reservation!.amount).toBe(10);

    // The card reads what the guard counted: ten of twelve, not one of twelve.
    const view = await authorityFor({ projectId });
    expect(view.grant!.spend.maxFragments.used, 'the card counted rows, not amount').toBe(10);
    expect(view.grant!.spend.maxFragments.limit).toBe(APPROVED.maxFragments);

    // And the guard agrees, which is the point of them sharing an expression:
    // three more would be thirteen, and thirteen is over.
    const over = await reserve({
      goalId,
      kind: 'FRAGMENT',
      idempotencyKey: 'three-more',
      amount: 3,
    });
    expect(over.ok).toBe(false);
    expect(over.refusedBy).toBe('IN_TOTAL');
    // Two more is exactly twelve, and twelve is allowed — the boundary is the
    // same on both sides.
    expect(
      (await reserve({ goalId, kind: 'FRAGMENT', idempotencyKey: 'two-more', amount: 2 })).ok,
    ).toBe(true);
    expect((await authorityFor({ projectId })).grant!.spend.maxFragments.used).toBe(12);

    // A MISSION reservation over the concurrency ceiling is refused by weight
    // too, which is the other half of the same arithmetic.
    const heavy = await reserve({
      goalId,
      kind: 'MISSION',
      idempotencyKey: 'heavy',
      amount: 2,
    });
    expect(heavy.ok).toBe(false);
    expect(heavy.refusedBy).toBe('AT_ONCE');
  });

  it('leaves an expired hold out of both, exactly as the guard does', async () => {
    const held = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'lapsing' });
    expect((await authorityFor({ projectId })).grant!.spend.maxMissions.used).toBe(1);

    await getDb().run(`UPDATE russell_budget_reservations SET expires_at = ? WHERE id = ?`, [
      '2020-01-01T00:00:00.000Z',
      held.reservation!.id,
    ]);
    // Not counted — which is why a live mission's hold has to be renewed rather
    // than left to lapse.
    const after = await authorityFor({ projectId });
    expect(after.grant!.spend.maxMissions.used).toBe(0);
    expect(after.grant!.spend.maxConcurrent.used).toBe(0);
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

describe('the uncapped policy the product issues', () => {
  /*
   * The correction this block exists for.
   *
   * Missions, fragments and probes were lifetime quotas, and reaching one
   * stopped Russell until a person topped it up. Nothing was scarce: the
   * subscription behind the work is already paid for, so the numbers measured
   * a starting point and then became a permanent ceiling — the exact thing the
   * original specification said must not happen.
   *
   * Every grant made through the authority card is UNCAPPED now. These tests
   * are the product promise: authorized work continues without anybody being
   * asked to replenish anything, and the limit that is real still holds.
   */
  let openProjectId = '';
  let openGoalId = '';

  beforeEach(async () => {
    const fixture = await freshProject();
    openProjectId = fixture.project.id;
    const user = await createUser({
      email: `uncapped-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    /*
     * Exactly what `POST /projects/:projectId/authority` writes: one real
     * limit, and zeroes in the three columns that no longer cap anything. If
     * the policy were ever read wrongly, those zeroes would refuse the *first*
     * mission — which is why they are the honest value to test against rather
     * than a large number that would hide the mistake.
     */
    const goal = await createGoal({
      projectId: openProjectId,
      ownerUserId: user.id,
      createdByUserId: user.id,
      name: 'Research the discovery questions',
      allowedWork: ['RESEARCH'],
      workPolicy: 'UNCAPPED',
      maxConcurrent: 1,
      maxMissions: 0,
      maxFragments: 0,
      maxProbes: 0,
    });
    openGoalId = goal.id;
  });

  it('keeps starting missions, one after another, with nobody asked for more', async () => {
    for (let i = 0; i < 25; i += 1) {
      const taken = await reserve({
        goalId: openGoalId,
        kind: 'MISSION',
        idempotencyKey: `open-${i}`,
      });
      expect(taken.ok, `mission ${i} was refused: ${taken.reason}`).toBe(true);
      await settleReservation(taken.reservation!.id);
    }

    // Twenty-five settled missions, and the twenty-sixth is as available as
    // the first. Under the old policy the third was a wall.
    const next = await reserve({ goalId: openGoalId, kind: 'MISSION', idempotencyKey: 'open-25' });
    expect(next.ok).toBe(true);
  });

  it('lets a fragment breakdown be as fine as the evidence needs', async () => {
    for (let i = 0; i < 40; i += 1) {
      expect(
        (await reserve({ goalId: openGoalId, kind: 'FRAGMENT', idempotencyKey: `frag-${i}` })).ok,
      ).toBe(true);
    }
    for (let i = 0; i < 20; i += 1) {
      expect(
        (await reserve({ goalId: openGoalId, kind: 'PROBE', idempotencyKey: `probe-${i}` })).ok,
      ).toBe(true);
    }
  });

  it('still refuses the second simultaneous mission, because that limit is real', async () => {
    /*
     * The half that must survive. Concurrency is what the fleet can actually
     * run at once, not an allowance, and removing quotas is not permission to
     * consume more at a time.
     */
    const running = await reserve({
      goalId: openGoalId,
      kind: 'MISSION',
      idempotencyKey: 'running',
    });
    expect(running.ok).toBe(true);

    const second = await reserve({
      goalId: openGoalId,
      kind: 'MISSION',
      idempotencyKey: 'at-the-same-time',
    });
    expect(second.ok).toBe(false);
    expect(second.refusedBy).toBe('AT_ONCE');
    expect(second.reason).toMatch(/1 mission at a time/);

    // And it is a wait rather than a wall: the moment the first finishes, the
    // next one starts, with nobody involved.
    await settleReservation(running.reservation!.id);
    expect(
      (await reserve({ goalId: openGoalId, kind: 'MISSION', idempotencyKey: 'at-the-same-time' }))
        .ok,
    ).toBe(true);
  });

  it('counts everything it has done, and shows no denominator to top up', async () => {
    const first = await reserve({ goalId: openGoalId, kind: 'MISSION', idempotencyKey: 'one' });
    await settleReservation(first.reservation!.id);
    const second = await reserve({ goalId: openGoalId, kind: 'MISSION', idempotencyKey: 'two' });
    await settleReservation(second.reservation!.id);
    await reserve({ goalId: openGoalId, kind: 'FRAGMENT', idempotencyKey: 'f', amount: 7 });
    await reserve({ goalId: openGoalId, kind: 'PROBE', idempotencyKey: 'p' });

    const view = await authorityFor({ projectId: openProjectId });
    // The history is intact — removing the stopping rule is not removing the
    // evidence — and the same `amount` arithmetic the guard uses.
    expect(view.grant!.spend.maxMissions.used).toBe(2);
    expect(view.grant!.spend.maxFragments.used).toBe(7);
    expect(view.grant!.spend.maxProbes.used).toBe(1);

    // And nothing to replenish: no ceiling on any of the three.
    expect(view.grant!.spend.maxMissions.limit).toBeNull();
    expect(view.grant!.spend.maxFragments.limit).toBeNull();
    expect(view.grant!.spend.maxProbes.limit).toBeNull();
    // The one that is real keeps its number.
    expect(view.grant!.spend.maxConcurrent.limit).toBe(1);

    // The sentences a person reads must agree with that, or the card is
    // promising a quota the validator does not enforce.
    expect(view.grant!.permits.join(' ')).not.toMatch(/at most \d+ (piece|pieces)/);
    expect(view.grant!.permits.join(' ')).toMatch(/as long as there is work worth doing/);
    expect(view.grant!.permits.join(' ')).toMatch(/at most 1 investigation at a time/);
  });

  it('never refuses in total, however much it has already done', async () => {
    for (let i = 0; i < 5; i += 1) {
      const taken = await reserve({
        goalId: openGoalId,
        kind: 'MISSION',
        idempotencyKey: `done-${i}`,
      });
      await settleReservation(taken.reservation!.id);
    }
    const next = await reserve({ goalId: openGoalId, kind: 'MISSION', idempotencyKey: 'next' });
    expect(next.ok).toBe(true);
    expect(next.refusedBy).toBeUndefined();

    // Every reservation is still on the record, settled and countable.
    const rows = await listReservations(openGoalId);
    expect(rows.filter((row) => row.state === 'SETTLED')).toHaveLength(5);
  });
});
