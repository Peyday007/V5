import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../server/services/sources/browserWorkflow.ts';
import { reasonForRun, rowsFrom, verifyOutcome, type OutcomeExpectation } from '../server/services/sources/browser/verifyOutcome.ts';

const now = new Date('2026-11-12T12:00:00.000Z');

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  host: 'records.example.org',
  name: 'w',
  outcome: 'COMPLETED',
  steps: [{ index: 0, kind: 'navigate', ok: true, detail: 'ok' }],
  extracted: [{ name: 'table', text: 'id,date,amount\n1,2026-11-11,10\n2,2026-11-12,12.5', truncated: false }],
  downloads: [],
  finalUrl: 'https://records.example.org/reports/done',
  boundary: null,
  interfaceChanged: false,
  detail: '',
  ...over,
});

describe('ACQ-21-5 outcome verification', () => {
  it('passes a run that obtained what it promised and names every check it ran', () => {
    const expected: OutcomeExpectation = {
      finalState: { urlIncludes: '/reports', text: ['Done'], absentText: ['Error'] },
      datasets: [{ name: 'table', minRows: 2, requiredFields: ['id', 'date'], fieldTypes: { amount: 'number', date: 'date' }, dateField: 'date' }],
      freshness: { maxAgeHours: 48 },
    };
    const v = verifyOutcome(run(), expected, { now, finalPage: { text: 'Done. 2 records' } });
    expect(v.verified).toBe(true);
    expect(v.failureReason).toBeNull();
    expect(v.asOf).toBe('2026-11-12T00:00:00.000Z');
    const names = v.checks.map((c) => c.check);
    expect(names).toEqual([
      'run completed its steps',
      'final address includes "/reports"',
      'final page shows "Done"',
      'final page does not show "Error"',
      'dataset table has at least 2 row(s)',
      'dataset table carries id on every row',
      'dataset table carries date on every row',
      'dataset table amount is number',
      'dataset table date is date',
      'data is at most 48h old',
    ]);
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });

  it('a completed run with an empty dataset fails as EMPTY_DATASET', () => {
    const v = verifyOutcome(run({ extracted: [{ name: 'table', text: 'id,date\n', truncated: false }] }), { datasets: [{ name: 'table', requiredFields: ['id'] }] }, { now });
    expect(v.verified).toBe(false);
    expect(v.failureReason).toBe('EMPTY_DATASET');
    const none = verifyOutcome(run({ extracted: [{ name: 'table', text: '', truncated: false }] }), { datasets: [{ name: 'table' }] }, { now });
    expect(none.failureReason).toBe('EMPTY_DATASET');
  });

  it('a completed run that did not reach the expected state fails as STATE_MISMATCH', () => {
    const v = verifyOutcome(run({ finalUrl: 'https://records.example.org/login' }), { finalState: { urlIncludes: '/reports' } }, { now });
    expect(v.verified).toBe(false);
    expect(v.failureReason).toBe('STATE_MISMATCH');
    const absent = verifyOutcome(run(), { finalState: { text: ['Export ready'] } }, { now, finalPage: { text: 'Nothing here' } });
    expect(absent.failureReason).toBe('STATE_MISMATCH');
  });

  it('data older than the freshness window is STALE, and undated data cannot be judged fresh', () => {
    const old = run({ extracted: [{ name: 'table', text: 'id,date\n1,2026-10-01', truncated: false }] });
    const v = verifyOutcome(old, { datasets: [{ name: 'table', dateField: 'date' }], freshness: { maxAgeHours: 24 } }, { now });
    expect(v.failureReason).toBe('STALE');
    const undated = verifyOutcome(run(), { datasets: [{ name: 'table' }], freshness: { maxAgeHours: 24 } }, { now });
    expect(undated.failureReason).toBe('STALE');
  });

  it('checks downloads for presence, size, pinned hash and error-page text', () => {
    const r = run({ downloads: [{ name: 'csv', url: 'https://records.example.org/x.csv', sha256: 'abc', chars: 40, text: 'a,b\n1,2' }] });
    expect(verifyOutcome(r, { downloads: [{ name: 'csv', minChars: 10, sha256: 'abc' }] }, { now }).verified).toBe(true);
    expect(verifyOutcome(r, { downloads: [{ name: 'csv', sha256: 'def' }] }, { now }).failureReason).toBe('STATE_MISMATCH');
    expect(verifyOutcome(r, { downloads: [{ name: 'pdf' }] }, { now }).failureReason).toBe('EMPTY_DATASET');
    const errorPage = run({ downloads: [{ name: 'csv', url: 'u', sha256: 'x', chars: 50, text: '<html>Session expired</html>' }] });
    expect(verifyOutcome(errorPage, { downloads: [{ name: 'csv', absentText: ['Session expired'] }] }, { now }).verified).toBe(false);
  });

  it('a run that did not complete fails with the typed reason it stopped for', () => {
    expect(reasonForRun(run({ outcome: 'HANDOFF', boundary: 'AUTHENTICATION', detail: 'sign-in wall' }))).toBe('BOUNDARY');
    expect(reasonForRun(run({ outcome: 'FAILED', interfaceChanged: true, detail: 'NOT_FOUND' }))).toBe('LOCATOR_MISSING');
    expect(reasonForRun(run({ outcome: 'FAILED', detail: 'the site answered 429 Too Many Requests' }))).toBe('RATE_LIMITED');
    expect(reasonForRun(run({ outcome: 'FAILED', detail: 'workflow timed out' }))).toBe('TIMEOUT');
    expect(reasonForRun(run({ outcome: 'FAILED', detail: 'connection reset' }))).toBe('UNKNOWN_OUTCOME');
    const v = verifyOutcome(run({ outcome: 'FAILED', detail: 'connection reset' }), {}, { now });
    expect(v).toMatchObject({ verified: false, failureReason: 'UNKNOWN_OUTCOME' });
  });

  it('parses JSON, delimited and plain-line extracts into rows', () => {
    expect(rowsFrom('[{"a":1,"b":null}]')).toEqual([{ a: '1', b: '' }]);
    expect(rowsFrom('a\tb\n1\t2')).toEqual([{ a: '1', b: '2' }]);
    expect(rowsFrom('first\nsecond')).toEqual([{ value: 'first' }, { value: 'second' }]);
    expect(rowsFrom('  ')).toEqual([]);
    expect(rowsFrom('id,date', ['id', 'date'])).toEqual([]);
  });
});
