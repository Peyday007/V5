/**
 * Where database time goes, measured in-process.
 *
 * The connection report could say the workload pool was 8/8 with callers queued
 * and could not say what held the eight. These readings are what answer it, so
 * what is pinned is that they are recorded from real statements and real
 * transactions, keep no parameter, and stay bounded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject, teardown } from './helpers.ts';
import {
  callerSite,
  connectionHolds,
  eventLoopReading,
  noteConnectionHold,
  noteStatement,
  resetLatencies,
  statementCosts,
} from '../server/db/infra.ts';
import { processReadings } from '../server/services/infra/incidents.ts';

beforeEach(async () => {
  await freshProject();
});

afterEach(async () => {
  await teardown();
});

describe('statement and connection-hold costs', () => {
  it('records statements by their text and never by their parameters', async () => {
    resetLatencies();
    await getDb().get('SELECT ? AS secret_value', ['do-not-keep-this']);
    const costs = statementCosts(50);
    const mine = costs.find((c) => c.key.includes('secret_value'));
    // SQLite has no adapter instrumentation; only Postgres records statements.
    if (getDb().dialect === 'postgres') expect(mine?.count).toBe(1);
    expect(JSON.stringify(costs)).not.toContain('do-not-keep-this');
  });

  it('attributes a transaction to the code that opened it', async () => {
    resetLatencies();
    await getDb().transaction(async () => {
      await getDb().get('SELECT 1 AS one');
    });
    if (getDb().dialect === 'postgres') {
      const holds = connectionHolds(50);
      expect(holds.some((h) => h.key.startsWith('transaction tests/databaseCosts.test.ts:'))).toBe(true);
    }
  });

  it('keeps the costliest statements when there are more than it holds', () => {
    resetLatencies();
    for (let i = 0; i < 400; i += 1) noteStatement(`SELECT ${i}`, i);
    const costs = statementCosts(5);
    expect(costs[0]?.key).toBe('SELECT 399');
    expect(costs.map((c) => c.key)).not.toContain('SELECT 0');
  });

  it('names the caller outside the database layer', () => {
    expect(callerSite()).toMatch(/^tests\/databaseCosts\.test\.ts:\d+$/);
  });

  it('writes both readings beside the liveness', () => {
    const readings = processReadings();
    expect(readings).toHaveProperty('statements');
    expect(readings).toHaveProperty('holds');
    // INF-2 and INF-3: the pool wait, connection churn and the event loop.
    expect(readings).toHaveProperty('checkouts');
    expect(readings).toHaveProperty('churn');
    expect(readings).toHaveProperty('eventLoop');
  });

  it('keeps the wait for a client apart from the time awaiting the answer', () => {
    resetLatencies();
    noteStatement('SELECT waited', 5, 4_000);
    noteStatement('SELECT waited', 7, 1_000);
    noteConnectionHold('transaction here:1', 50, 300);
    const statement = statementCosts(5).find((c) => c.key === 'SELECT waited');
    expect(statement).toMatchObject({ count: 2, totalMs: 12, maxMs: 7, waitTotalMs: 5_000, waitMaxMs: 4_000 });
    expect(connectionHolds(5)[0]).toMatchObject({ totalMs: 50, waitTotalMs: 300 });
  });

  it('measures how late the event loop ran, per window', async () => {
    eventLoopReading(); // start a fresh window
    await new Promise((resolve) => setTimeout(resolve, 60));
    const until = Date.now() + 250;
    while (Date.now() < until) {
      // A synchronous stall, the kind that makes every in-flight statement look slow.
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stalled = eventLoopReading();
    expect(stalled).not.toBeNull();
    expect(stalled!.max).toBeGreaterThanOrEqual(150);
    expect(stalled!.worstMs).toBeGreaterThanOrEqual(stalled!.max);
    // The next window starts clean; the worst ever is kept.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = eventLoopReading();
    expect(after!.max).toBeLessThan(stalled!.max);
    expect(after!.worstMs).toBeGreaterThanOrEqual(150);
  });
});
