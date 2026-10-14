import { beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  databasePressure,
  ENTER_FAILURES,
  ENTER_P90_MS,
  LEAVE_P90_MS,
  MIN_SAMPLES,
  RECOVER_AFTER_MS,
  resetPressure,
} from '../server/db/pressure.ts';
import { countDatabaseFailure, noteStatement, resetInfraCounters } from '../server/db/infra.ts';
import { DEFERRABLE_UNDER_PRESSURE, runPass } from '../server/services/russell/loop.ts';

const fast = (n = MIN_SAMPLES) => Array.from({ length: n }, () => 40);
const slow = (n = MIN_SAMPLES) => Array.from({ length: n }, () => ENTER_P90_MS + 1);

describe('database pressure: entering and leaving', () => {
  beforeEach(() => resetPressure(0));

  it('stays NORMAL in healthy time', () => {
    expect(advance({ times: fast(200), failures: 0 }, 1_000).state).toBe('NORMAL');
  });

  it('enters SHEDDING when the 90th percentile reaches the pool checkout bound', () => {
    const reading = advance({ times: slow(), failures: 0 }, 1_000);
    expect(reading.state).toBe('SHEDDING');
    expect(reading.reason).toMatch(/90th-percentile/);
  });

  it('enters SHEDDING when the database could not answer three statements', () => {
    expect(advance({ times: [], failures: ENTER_FAILURES }, 1_000).state).toBe('SHEDDING');
  });

  it('does not decide on too few samples', () => {
    expect(advance({ times: slow(MIN_SAMPLES - 1), failures: ENTER_FAILURES - 1 }, 1_000).state).toBe('NORMAL');
  });

  it('a few slow statements among many fast ones are not pressure', () => {
    expect(advance({ times: [...fast(95), ...slow(5)], failures: 0 }, 1_000).state).toBe('NORMAL');
  });

  it('leaves only after five continuous healthy minutes', () => {
    advance({ times: slow(), failures: 0 }, 0);
    expect(advance({ times: fast(), failures: 0 }, 1_000).state).toBe('SHEDDING');
    expect(advance({ times: fast(), failures: 0 }, 1_000 + RECOVER_AFTER_MS - 1).state).toBe('SHEDDING');
    const back = advance({ times: fast(), failures: 0 }, 1_000 + RECOVER_AFTER_MS);
    expect(back.state).toBe('NORMAL');
    expect(back.reason).toMatch(/recovered/);
  });

  it('one bad window restarts the recovery clock', () => {
    advance({ times: slow(), failures: 0 }, 0);
    advance({ times: fast(), failures: 0 }, 1_000);
    advance({ times: fast(), failures: 1 }, 200_000);
    expect(advance({ times: fast(), failures: 0 }, 1_000 + RECOVER_AFTER_MS).state).toBe('SHEDDING');
  });

  it('a middling 90th percentile neither enters nor recovers', () => {
    const middling = Array.from({ length: 50 }, () => LEAVE_P90_MS + 1);
    expect(advance({ times: middling, failures: 0 }, 0).state).toBe('NORMAL');
    advance({ times: slow(), failures: 0 }, 1);
    expect(advance({ times: middling, failures: 0 }, 1 + RECOVER_AFTER_MS * 2).state).toBe('SHEDDING');
  });

  it('silence is not recovery', () => {
    advance({ times: slow(), failures: 0 }, 0);
    expect(advance({ times: [], failures: 0 }, RECOVER_AFTER_MS * 3).state).toBe('SHEDDING');
  });
});

describe('database pressure from what the adapter felt', () => {
  beforeEach(() => {
    resetInfraCounters();
    resetPressure();
  });

  it('reads the process\'s own statement times and failures', () => {
    for (let i = 0; i < 30; i++) noteStatement('SELECT 1', 5);
    expect(databasePressure().state).toBe('NORMAL');
    for (let i = 0; i < ENTER_FAILURES; i++) countDatabaseFailure('STATEMENT_TIMEOUT');
    expect(databasePressure().state).toBe('SHEDDING');
  });
});

describe('the Russell tick under pressure', () => {
  beforeEach(() => {
    resetInfraCounters();
    resetPressure();
  });

  it('defers optional passes and records them, and runs everything else', async () => {
    for (let i = 0; i < ENTER_FAILURES; i++) countDatabaseFailure('CONNECTION_LOST');
    expect(databasePressure().state).toBe('SHEDDING');
    const report = { passFailures: [] as { pass: string; error: string }[], deferred: [] as string[] };
    const ran: string[] = [];
    expect(await runPass(report, 'shared-findings', async () => ran.push('shared-findings'))).toBe(false);
    expect(await runPass(report, 'writeback', async () => ran.push('writeback'))).toBe(true);
    expect(await runPass(report, 'reconcile-bins', async () => ran.push('reconcile-bins'))).toBe(true);
    expect(ran).toEqual(['writeback', 'reconcile-bins']);
    expect(report.deferred).toEqual(['shared-findings']);
    expect(report.passFailures).toEqual([]);
  });

  it('runs optional passes when the database is answering', async () => {
    const report = { passFailures: [] as { pass: string; error: string }[], deferred: [] as string[] };
    let ran = false;
    expect(await runPass(report, 'shared-findings', async () => (ran = true))).toBe(true);
    expect(ran).toBe(true);
    expect(report.deferred).toEqual([]);
  });

  it('never defers the passes that serve work in flight', () => {
    for (const essential of [
      'writeback', 'abandoned-parks', 'terminal-packets', 'unworkable-packets', 'filing-recoveries',
      'goals', 'research-goals', 'answered-requests', 'launch', 'repair-launches', 'reconcile-bins',
      'renew-reservations', 'answered-turns', 'authority-resumed', 'worker-ownership',
    ]) {
      expect(DEFERRABLE_UNDER_PRESSURE.has(essential), essential).toBe(false);
    }
  });
});
