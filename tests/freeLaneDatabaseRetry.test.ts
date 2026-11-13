/**
 * CAPABILITY:GOAL_PLAN.COMPUTE.DATABASE — free-lane Brain tool calls wait out
 * the database failures the database owner classifies (pool exhausted,
 * connection terminated, query/statement timeout), and never repeat a mutation
 * whose outcome a lost connection left unknown (invariant 26).
 */
import { describe, expect, it } from 'vitest';
import { databaseRetryable, pressuredWait, PRESSURED_WAIT_CAP_MS, retryNotReached } from '../server/services/freeLane/worker.ts';

const noSleep = async (): Promise<void> => undefined;

function poolTimeout(): Error {
  const error = new Error('The database pool had no free connection within 10000ms: 8/8 connection(s) in use, 0 idle, 40 caller(s) waiting, ceiling 8.');
  Object.defineProperty(error, 'brainPool', { value: true, enumerable: false });
  return error;
}

function statementTimeout(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
}

/** The recorded failure class, in the driver's and the pool's own words. */
const RECORDED: (() => Error)[] = [
  () => new Error('Connection terminated unexpectedly'),
  () => new Error('Client was closed and is not queryable'),
  () => new Error('Query read timeout'),
  statementTimeout,
  () => new Error('timeout exceeded when trying to connect'),
  poolTimeout,
];

describe('free-lane database retry', () => {
  it('answers a read-only Brain tool after every recorded database failure', async () => {
    let calls = 0;
    const read = async () => {
      const fail = RECORDED[calls];
      calls += 1;
      if (fail) throw fail();
      return 'answered';
    };
    const backoff = RECORDED.map(() => 1);
    await expect(retryNotReached(read, backoff, { readOnly: true, sleep: noSleep, pressure: () => null })).resolves.toBe('answered');
    expect(calls).toBe(RECORDED.length + 1);
  });

  it('never repeats a mutation whose outcome a lost connection or timeout left unknown', async () => {
    for (const unknown of [() => new Error('Connection terminated unexpectedly'), statementTimeout, () => new Error('Client was closed and is not queryable')]) {
      let calls = 0;
      const write = async () => {
        calls += 1;
        throw unknown();
      };
      await expect(retryNotReached(write, [1, 1, 1], { readOnly: false, sleep: noSleep, pressure: () => null })).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it('repeats a mutation when nothing ran: the pool never handed it a connection', async () => {
    let calls = 0;
    const write = async () => {
      calls += 1;
      if (calls < 3) throw calls === 1 ? poolTimeout() : new Error('timeout exceeded when trying to connect');
      return 'submitted';
    };
    await expect(retryNotReached(write, [1, 1, 1], { readOnly: false, sleep: noSleep, pressure: () => null })).resolves.toBe('submitted');
    expect(calls).toBe(3);
  });

  it('never retries an error that is not the database', async () => {
    let calls = 0;
    const refused = async () => {
      calls += 1;
      throw new Error('claims[0].sourceUrl is required');
    };
    await expect(retryNotReached(refused, [1, 1], { readOnly: true, sleep: noSleep, pressure: () => null })).rejects.toThrow(/sourceUrl/);
    expect(calls).toBe(1);
    expect(databaseRetryable(new Error('claims[0].sourceUrl is required'), true)).toBe(false);
    expect(databaseRetryable(new Error('The database did not answer in time.'), false)).toBe(false);
  });

  it('still throws past the backoff', async () => {
    let calls = 0;
    const down = async () => {
      calls += 1;
      throw new Error('Connection terminated unexpectedly');
    };
    await expect(retryNotReached(down, [1, 1], { readOnly: true, sleep: noSleep, pressure: () => null })).rejects.toThrow(/Connection terminated/);
    expect(calls).toBe(3);
  });

  it('waits longer while callers are queued on the pool, and never past the cap', async () => {
    expect(pressuredWait(1_000, null)).toBe(1_000);
    expect(pressuredWait(1_000, { waiting: 0, max: 8 })).toBe(1_000);
    expect(pressuredWait(1_000, { waiting: 8, max: 8 })).toBe(2_000);
    expect(pressuredWait(1_000, { waiting: 593, max: 8 })).toBe(4_000);
    expect(pressuredWait(9_000, { waiting: 593, max: 8 })).toBe(PRESSURED_WAIT_CAP_MS);

    const waits: number[] = [];
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls < 3) throw poolTimeout();
      return 'answered';
    };
    await expect(
      retryNotReached(read, [1_000, 3_000], {
        readOnly: true,
        pressure: () => ({ waiting: 16, max: 8 }),
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).resolves.toBe('answered');
    expect(waits).toEqual([3_000, 9_000]);
  });
});
