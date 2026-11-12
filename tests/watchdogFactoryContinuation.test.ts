/**
 * An idle Factory line is continued, not only recorded (§98, rule 9).
 *
 * Production, 2026-11-12: the watchdog recorded "FACTORY: 1 piece(s) of
 * executable work and 2 free surface(s), and nothing is running or arriving"
 * in 126 of 144 ten-minute windows, answered each time with "its own pass on
 * the next tick", and continued nothing. Factory stage bins are fired by the
 * dispatch tick, so an idle line gets the same guarded pass routines get —
 * and the pass runs once per reading even when both pools are idle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ factoryIdle: true, routinesIdle: false, passes: 0 }));

vi.mock('../server/services/factory/line.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/factory/line.ts')>();
  return {
    ...actual,
    readLine: async () => ({
      executable: { total: state.factoryIdle ? 1 : 0 },
      active: { leasedBins: 0, arriving: 0 },
      capacity: { freeSurfaces: 2 },
      unexplainedIdle: state.factoryIdle,
      because: state.factoryIdle
        ? '1 piece(s) of executable work and 2 free surface(s), and nothing is running or arriving. That is a fault, not a wait.'
        : 'nothing executable',
    }),
  };
});

vi.mock('../server/domain/engineering.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/domain/engineering.ts')>();
  return {
    ...actual,
    idleCheck: (input: Parameters<typeof actual.idleCheck>[0]) =>
      state.routinesIdle ? { idle: true, reason: '1 executable item(s), capacity is unexplainedly idle.' } : actual.idleCheck(input),
  };
});

vi.mock('../server/services/dispatch/loop.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/loop.ts')>();
  return {
    ...actual,
    dispatchTickIfIdle: async () => {
      state.passes += 1;
      return true;
    },
  };
});

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { watchUtilization } from '../server/services/engineering/watchdog.ts';

beforeEach(async () => {
  await freshProject();
  state.factoryIdle = true;
  state.routinesIdle = false;
  state.passes = 0;
});

describe('the watchdog continues an idle Factory line through the guarded dispatch pass', () => {
  it('runs one guarded pass for an idle Factory line and lists it as continued', async () => {
    const result = await watchUtilization({});
    expect(result.pools.find((one) => one.pool === 'FACTORY')?.idle).toBe(true);
    expect(state.passes).toBe(1);
    expect(result.continued).toContain('FACTORY');
    const row = await getDb().get<{ replacement_action: string }>(
      "SELECT replacement_action FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND attempted_action LIKE 'FACTORY:%'",
    );
    expect(row?.replacement_action).toBe('one guarded dispatch pass');
  });

  it('runs the pass once when routines and the Factory line are both idle', async () => {
    state.routinesIdle = true;
    const result = await watchUtilization({});
    expect(state.passes).toBe(1);
    expect(result.continued).toEqual(expect.arrayContaining(['ROUTINES', 'FACTORY']));
  });

  it('continues nothing when asked only to read', async () => {
    state.routinesIdle = true;
    const result = await watchUtilization({ continueWork: false });
    expect(state.passes).toBe(0);
    expect(result.continued).toEqual([]);
    expect(result.recorded).toContain('FACTORY');
  });

  it('runs no pass when the Factory line is not idle', async () => {
    state.factoryIdle = false;
    const result = await watchUtilization({});
    expect(result.continued).not.toContain('FACTORY');
    expect(state.passes).toBe(0);
  });
});
