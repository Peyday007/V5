import { describe, expect, it } from 'vitest';
import type { RunOutcome, SearchMethodRun } from '../server/domain/searchIntelligence.ts';
import {
  BASE_RETRY_MS,
  classifyFailure,
  decideMethod,
  STALE_MS,
  subjectStatus,
} from '../server/services/research/searchFailures/index.ts';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
let n = 0;
function run(outcome: RunOutcome, atMs: number): SearchMethodRun {
  n += 1;
  return {
    id: `r${String(n).padStart(4, '0')}`, methodId: 'm', executor: 'CODE', outcome, failureCause: null,
    examined: 0, surfaced: 0, confirmed: 0, rejected: 0,
    startedAt: new Date(atMs).toISOString(), finishedAt: new Date(atMs).toISOString(),
  };
}
const seq = (outcome: RunOutcome, count: number, start = T0) =>
  Array.from({ length: count }, (_, i) => run(outcome, start + i * 60_000));
const iso = (ms: number) => new Date(ms).toISOString();

describe('classifying a failing method', () => {
  it('is not a failure until the streak is repeated, and a FOUND run breaks it', () => {
    expect(classifyFailure(seq('NOTHING_SUITABLE', 2), iso(T0 + 1e6))).toBeNull();
    const broken = [...seq('NOTHING_SUITABLE', 5), run('FOUND', T0 + 10 * 60_000)];
    expect(classifyFailure(broken, iso(T0 + 1e7))).toBeNull();
  });

  it('keeps unavailable, empty and noisy apart', () => {
    const now = iso(T0 + 1e6);
    expect(classifyFailure(seq('SOURCE_UNAVAILABLE', 3), now)).toBe('SOURCE_UNAVAILABLE');
    expect(classifyFailure(seq('NOTHING_SUITABLE', 3), now)).toBe('NO_SUITABLE_RESULTS');
    expect(classifyFailure(seq('FALSE_POSITIVES', 3), now)).toBe('HIGH_FALSE_POSITIVES');
  });

  it('reads a mixed streak as ERROR rather than guessing a cause', () => {
    const mixed = [run('SOURCE_UNAVAILABLE', T0), run('NOTHING_SUITABLE', T0 + 1), run('FALSE_POSITIVES', T0 + 2)];
    expect(classifyFailure(mixed, iso(T0 + 1e6))).toBe('ERROR');
  });

  it('calls an empty method stale only when it last found something long ago', () => {
    const found = run('FOUND', T0);
    const later = T0 + STALE_MS + 10 * 60_000;
    const empty = seq('NOTHING_SUITABLE', 3, later);
    expect(classifyFailure([found, ...empty], iso(later + 1e6))).toBe('STALE');
    const recent = seq('NOTHING_SUITABLE', 3, T0 + 3600_000);
    expect(classifyFailure([found, ...recent], iso(T0 + 1e7))).toBe('NO_SUITABLE_RESULTS');
  });
});

describe('deciding what to do with a method', () => {
  it('runs a healthy method', () => {
    expect(decideMethod(seq('FOUND', 3), iso(T0 + 1e6))).toMatchObject({ action: 'RUN', cause: null });
  });

  it('pauses a repeatedly empty method with a retry time instead of rerunning it', () => {
    const runs = seq('NOTHING_SUITABLE', 3);
    const last = T0 + 2 * 60_000;
    const decision = decideMethod(runs, iso(last + 1000));
    expect(decision.action).toBe('PAUSE');
    expect(decision.cause).toBe('NO_SUITABLE_RESULTS');
    expect(decision.retryAt).toBe(iso(last + BASE_RETRY_MS));
  });

  it('lets it try once more when the wait is over, and doubles the wait if that fails too', () => {
    const runs = seq('SOURCE_UNAVAILABLE', 3);
    const last = T0 + 2 * 60_000;
    expect(decideMethod(runs, iso(last + BASE_RETRY_MS)).action).toBe('RUN');
    const again = [...runs, run('SOURCE_UNAVAILABLE', last + BASE_RETRY_MS)];
    const decision = decideMethod(again, iso(last + BASE_RETRY_MS + 1000));
    expect(decision.action).toBe('PAUSE');
    expect(decision.retryAt).toBe(iso(last + BASE_RETRY_MS + 2 * BASE_RETRY_MS));
  });

  it('flags false positives for revision: waiting cannot fix noise', () => {
    const decision = decideMethod(seq('FALSE_POSITIVES', 4), iso(T0 + 1e6));
    expect(decision).toMatchObject({ action: 'REVISE', cause: 'HIGH_FALSE_POSITIVES', retryAt: null });
  });
});

describe('a failed method never retires its subject', () => {
  it('stays open and names what is left', () => {
    const now = iso(T0 + 1e6);
    const bad = { methodId: 'a', decision: decideMethod(seq('FALSE_POSITIVES', 3), now) };
    const waiting = { methodId: 'b', decision: decideMethod(seq('SOURCE_UNAVAILABLE', 3), now) };
    const fine = { methodId: 'c', decision: decideMethod(seq('FOUND', 3), now) };
    expect(subjectStatus([bad, waiting, fine])).toMatchObject({ open: true, runnable: ['c'], needsNewMethod: false, needRevision: ['a'] });
    const none = subjectStatus([bad]);
    expect(none).toMatchObject({ open: true, runnable: [], needsNewMethod: true });
    expect(subjectStatus([])).toMatchObject({ open: true, needsNewMethod: true });
  });
});
