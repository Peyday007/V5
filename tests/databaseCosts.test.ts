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
  });
});
