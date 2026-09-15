/**
 * Two cash decisions that overlap, forced to overlap.
 *
 * ---------------------------------------------------------------------------
 * The finding, and why the race test that already existed could not catch it
 * ---------------------------------------------------------------------------
 *
 * `commit()` inserts its provisional row and then sums the holds ranked ahead
 * of it against the ceiling. On SQLite that is sound, because a write
 * transaction is globally exclusive. On Postgres every transaction runs on its
 * own pooled client at the default READ COMMITTED, so **each one sees its own
 * insert and not the other's**: two $80 commitments against a $100 ceiling each
 * sum to $80, both pass, and $160 is held. Sequence ranking cannot count an
 * invisible row.
 *
 * `cashAuthority.test.ts` already races two distinct-key commitments through
 * `Promise.all`. It is a real test and it cannot settle this, because it does
 * not force both transactions to reach their arithmetic before either commits —
 * so it passes when the race does not happen, which is most of the time.
 *
 * ---------------------------------------------------------------------------
 * What makes this one deterministic
 * ---------------------------------------------------------------------------
 *
 * A third connection takes the project's cash lock and **holds it open**. Both
 * commitments then block at the first statement of their own transactions,
 * which is the moment before the arithmetic. They are provably simultaneous —
 * the blocking is enforced by a row lock rather than by a sleep — and releasing
 * the holder lets exactly one of them through at a time.
 *
 * Without `serializeCash` neither would block, both would reach the sum with
 * the other invisible, and both would be held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, postgresTestConnection, testDatabaseKind } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { commit, createAuthority, listCommitments } from '../server/repos/cashAuthority.ts';
import { cashLockTicket } from '../server/repos/cashLock.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';

let projectId = '';
let userId = '';
let authorityId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `race-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const authority = await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    // $100 of ceiling, and $100 of actual money.
    maxCommittedCents: 10_000,
    maxPerActionCents: 10_000,
    maxConcurrent: 5,
    currency: 'USD',
  });
  authorityId = authority.id;
  await recordMoney({
    projectId,
    kind: 'CAPITAL_IN',
    amountCents: 10_000,
    currency: 'USD',
    recordedBy: userId,
    idempotencyKey: 'seed-capital',
  });
});

/**
 * A barrier that opens when both callers have arrived, or after a moment.
 *
 * It is how the overlap is forced *without* depending on the thing under test.
 * `deployableAfter` is evaluated inside `commit`'s own transaction, after the
 * insert — so a commitment parked there is provably past its insert and inside
 * its transaction. Two of them parked together is exactly the state the
 * Postgres finding is about.
 *
 * The timeout is what keeps it honest in both directions. With the lock, the
 * second caller cannot reach the barrier until the first has committed, so the
 * first waits out the timeout and proceeds — and the arithmetic it then does
 * sees the other hold, because there is no other hold yet. Without the lock,
 * both arrive, both are released immediately, and both compute their sum with
 * the other's row invisible. The money assertion is what tells them apart.
 */
function barrier(parties: number, timeoutMs: number): () => Promise<void> {
  let arrived = 0;
  let open: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open?.();
    await Promise.race([opened, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  };
}

function eightyDollars(key: string) {
  return {
    authorityId,
    projectId,
    amountCents: 8_000,
    currency: 'USD',
    purpose: `A test spend (${key})`,
    expectedResult: 'Something worth 8000 cents',
    stopCondition: 'It does not work',
    idempotencyKey: key,
    createdBy: userId,
    deployableAfter: async () =>
      (await cashPosition({ projectId, currency: 'USD' })).deployableCents,
  };
}

describe('two commitments cannot both take the last of the money', () => {
  it('holds one of two overlapping $80 commitments against a $100 ceiling', async () => {
    const [first, second] = await Promise.all([
      commit(eightyDollars('race-a')),
      commit(eightyDollars('race-b')),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    const held = (await listCommitments(projectId))
      .filter((one) => one.state === 'HELD')
      .reduce((total, one) => total + one.amountCents, 0);
    expect(held).toBe(8_000);
  });

  it('refuses a key reused for a different request rather than replaying the first', async () => {
    const taken = await commit(eightyDollars('same-key'));
    expect(taken.ok).toBe(true);

    // The same key, a different amount. Answering this with the first
    // commitment and a success is the one shape a caller cannot detect,
    // because it is indistinguishable from their own retry.
    const changed = await commit({ ...eightyDollars('same-key'), amountCents: 1_000 });
    expect(changed.ok).toBe(false);
    expect(changed.replayed).toBe(false);
    expect(changed.reason).toContain('already names a different commitment');

    // And the genuine retry still replays, because that is what the key is for.
    const retried = await commit(eightyDollars('same-key'));
    expect(retried.ok).toBe(true);
    expect(retried.replayed).toBe(true);
    expect(retried.commitment!.id).toBe(taken.commitment!.id);

    expect(await listCommitments(projectId)).toHaveLength(1);
  });

  it('cannot both clear the ceiling from inside their own transactions', async () => {
    /*
     * The outcome, forced rather than raced.
     *
     * Both commitments are parked at `deployableAfter` — inside their
     * transactions, past their inserts — before either is allowed to finish.
     * That is the state the Postgres finding describes, and it is produced here
     * by a barrier rather than by timing, so the test means the same thing on
     * every run and on both backends.
     */
    const meet = barrier(2, 750);
    const together = (key: string) => ({
      ...eightyDollars(key),
      deployableAfter: async () => {
        await meet();
        return (await cashPosition({ projectId, currency: 'USD' })).deployableCents;
      },
    });

    const [first, second] = await Promise.all([
      commit(together('meet-a')),
      commit(together('meet-b')),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const held = (await listCommitments(projectId))
      .filter((one) => one.state === 'HELD')
      .reduce((total, one) => total + one.amountCents, 0);
    // $160 here is the defect: two transactions each summing only their own
    // hold against a $100 ceiling.
    expect(held).toBe(8_000);
  });

  it('serializes through a row the claimant does not supply', async () => {
    await commit(eightyDollars('ticket-a'));
    // The lock is taken by every cash decision, so the count rises with them.
    // It is a diagnostic rather than a control, which is why nothing reads it
    // to decide anything.
    expect(await cashLockTicket(projectId, 'USD')).toBeGreaterThan(0);
  });
});

/*
 * The Postgres half, which is the backend the finding is actually about.
 *
 * Skipped on SQLite rather than faked: a single-writer database cannot exhibit
 * two transactions reading a stale sum, and a test that pretended to would be
 * evidence of nothing.
 */
const pg = postgresTestConnection();
describe.skipIf(pg === null)('forced overlap, on the backend that can lose', () => {
  let holder: { query(sql: string, params?: unknown[]): Promise<unknown>; end(): Promise<void> };

  afterEach(async () => {
    await holder?.end().catch(() => undefined);
  });

  it('blocks both commitments at the lock and lets exactly one through', async () => {
    const driver = await import('pg');
    const client = new driver.default.Client({ connectionString: pg!.connectionString });
    await client.connect();
    holder = client as unknown as typeof holder;
    await client.query(`SET search_path TO ${pg!.schema}`);

    // The lock row has to exist before it can be held; the first real caller
    // creates it, so one commitment is taken and released first.
    const seeded = await commit({ ...eightyDollars('seed'), amountCents: 0 });
    expect(seeded.ok).toBe(true);

    // Take the project's cash lock from outside and keep the transaction open.
    await client.query('BEGIN');
    await client.query(
      'UPDATE cash_locks SET ticket = ticket + 1 WHERE project_id = $1 AND currency = $2',
      [projectId, 'USD'],
    );

    let settledA = false;
    let settledB = false;
    const a = commit(eightyDollars('forced-a')).then((result) => {
      settledA = true;
      return result;
    });
    const b = commit(eightyDollars('forced-b')).then((result) => {
      settledB = true;
      return result;
    });

    // Both are inside their own transactions and neither has reached its
    // arithmetic. This is the overlap the pooled race could not guarantee.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settledA).toBe(false);
    expect(settledB).toBe(false);

    await client.query('COMMIT');

    const [first, second] = await Promise.all([a, b]);
    // One of them summed the other's hold, because the lock made it visible.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    const held = (await listCommitments(projectId))
      .filter((one) => one.state === 'HELD')
      .reduce((total, one) => total + one.amountCents, 0);
    expect(held).toBe(8_000);
  });
});

describe('the backend this suite ran against', () => {
  it('says which, so a green run cannot be mistaken for both', () => {
    expect(['sqlite', 'postgres']).toContain(testDatabaseKind);
  });
});
