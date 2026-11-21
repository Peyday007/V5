/**
 * CAPABILITY:GOAL_PLAN.COMPUTE.DATABASE — free-lane Brain tool calls wait out
 * the database failures the database owner classifies (pool exhausted,
 * connection terminated, query/statement timeout), and never repeat a mutation
 * whose outcome a lost connection left unknown (invariant 26).
 */
import { describe, expect, it } from 'vitest';
import { findTool } from '../server/mcp/tools.ts';
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
    await expect(retryNotReached(write, [1, 1, 1], { readOnly: false, idempotent: true, sleep: noSleep, pressure: () => null })).resolves.toBe('submitted');
    expect(calls).toBe(3);
  });

  it('never re-runs a non-idempotent mutation that committed through one checkout and then failed the next', async () => {
    for (const nothingRan of [poolTimeout, () => new Error('timeout exceeded when trying to connect')]) {
      const committed: string[] = [];
      let runs = 0;
      // One tool, two checkouts: the first commits, the second never gets a connection.
      const write = async () => {
        runs += 1;
        committed.push(`row-${runs}`);
        throw nothingRan();
      };
      await expect(retryNotReached(write, [1, 1, 1], { readOnly: false, idempotent: false, sleep: noSleep, pressure: () => null })).rejects.toThrow();
      expect(runs).toBe(1);
      expect(committed).toEqual(['row-1']);
      expect(databaseRetryable(nothingRan(), false, false)).toBe(false);
    }
  });

  it('re-runs an idempotent mutation after a later checkout failed, and its committed part lands once', async () => {
    const rows = new Map<string, number>();
    let runs = 0;
    const write = async () => {
      runs += 1;
      // Keyed by work item: a second run upserts the same row rather than adding one.
      rows.set('item-1', 1);
      if (runs < 2) throw poolTimeout();
      return 'submitted';
    };
    await expect(retryNotReached(write, [1, 1], { readOnly: false, idempotent: true, sleep: noSleep, pressure: () => null })).resolves.toBe('submitted');
    expect(runs).toBe(2);
    expect(rows.get('item-1')).toBe(1);
  });

  it('every mutating tool the free lane asks again declares itself idempotent, so the retry rests on a declaration', () => {
    for (const name of ['brain_complete_work', 'brain_fail_work', 'brain_release_work', 'brain_submit_claims', 'brain_submit_audit', 'brain_submit_synthesis', 'brain_propose_fragments']) {
      const tool = findTool(name);
      expect(tool, name).not.toBeNull();
      if (tool!.annotations.readOnlyHint) continue;
      expect(tool!.annotations.idempotentHint, name).toBe(true);
    }
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
