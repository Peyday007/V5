/**
 * The capability-gap loop's position (AUTO-20-2, repair F7).
 *
 * Where a loop stands is read from its rows in order, not from which steps
 * were ever recorded: a verification that failed sends the loop back to
 * acquisition, a new decision reopens what followed it, and a VALUE decision to
 * abandon the direction concludes the loop so it is not resumed forever.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { gapStateFrom, openGapLoops, readGapLoop, recordGapStep, type GapLoopStep } from '../server/services/selfmodel/gapLoop.ts';

let clock = Date.parse('2026-11-01T00:00:00.000Z');
const row = (step: GapLoopStep, detail: Record<string, unknown> = {}) => ({
  at: new Date((clock += 1000)).toISOString(),
  provider: step,
  reason: step.toLowerCase(),
  measures: JSON.stringify({ detail }),
});
const head = () => [
  row('NOTICE', { observation: 'o' }),
  row('HYPOTHESIS', { cause: 'OTHER', enables: 'e', measure: 'm', failureMode: 'f' }),
  row('SEARCH_EXISTING', { searched: ['scan'] }),
  row('VALUE', { chosen: 'a Factory change', alternatives: 'x', ref: 'FACTORY:1' }),
  row('ACQUIRE', { owner: 'Factory', ref: 'FACTORY:1' }),
];

describe('gapStateFrom reads position from the rows in order', () => {
  it('a failed VERIFY sends the loop back to ACQUIRE', () => {
    const state = gapStateFrom('g', [...head(), row('VERIFY', { baseline: 'b', comparison: 'c', passed: false })]);
    expect(state.next).toBe('ACQUIRE');
    expect(state.outstanding).toEqual(['ACQUIRE', 'VERIFY', 'INTEGRATE', 'CONTINUE']);
    expect(state.integrated).toBe(false);
    expect(state.concluded).toBe(false);
  });

  it('a failing verdict reopens acquisition even after INTEGRATE was recorded', () => {
    const state = gapStateFrom('g', [
      ...head(),
      row('VERIFY', { baseline: 'b', comparison: 'c', passed: true }),
      row('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }),
      row('VERIFY', { baseline: 'b', comparison: 'c', verdict: 'REGRESSED' }),
    ]);
    expect(state.integrated).toBe(false);
    expect(state.next).toBe('ACQUIRE');
  });

  it('a passing VERIFY moves on to INTEGRATE', () => {
    const state = gapStateFrom('g', [...head(), row('VERIFY', { baseline: 'b', comparison: 'c', passed: true })]);
    expect(state.next).toBe('INTEGRATE');
  });

  it('a new ACQUIRE after INTEGRATE reopens verification and integration', () => {
    const state = gapStateFrom('g', [
      ...head(),
      row('VERIFY', { baseline: 'b', comparison: 'c', passed: true }),
      row('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }),
      row('ACQUIRE', { owner: 'Factory', ref: 'FACTORY:2' }),
    ]);
    expect(state.integrated).toBe(false);
    expect(state.next).toBe('VERIFY');
  });

  it('a VALUE decision to abandon concludes the loop', () => {
    const rows = head().slice(0, 3);
    rows.push(row('VALUE', { chosen: 'abandon the direction', alternatives: 'x', ref: 'ABANDON' }));
    const state = gapStateFrom('g', rows);
    expect(state.abandoned).toBe(true);
    expect(state.concluded).toBe(true);
    expect(state.next).toBeNull();
    expect(state.outstanding).toEqual([]);
  });

  it('a recurrence after abandoning reopens the loop', () => {
    const rows = head().slice(0, 3);
    rows.push(row('VALUE', { chosen: 'abandon', alternatives: 'x', decision: 'ABANDON' }), row('NOTICE', { observation: 'again' }));
    const state = gapStateFrom('g', rows);
    expect(state.abandoned).toBe(false);
    expect(state.concluded).toBe(false);
    expect(state.next).toBe('HYPOTHESIS');
  });
});

describe('openGapLoops does not resurface abandoned gaps', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('lists a working loop and omits one whose VALUE abandoned the direction', async () => {
    for (const key of ['gap:open', 'gap:abandoned']) {
      await recordGapStep({ gapKey: key, step: 'NOTICE', summary: 'n', detail: { observation: 'o' } });
      await recordGapStep({ gapKey: key, step: 'SEARCH_EXISTING', summary: 's', detail: { searched: ['scan'] } });
    }
    await recordGapStep({ gapKey: 'gap:abandoned', step: 'VALUE', summary: 'abandon', detail: { chosen: 'abandon', alternatives: 'x', abandon: true } });
    const open = (await openGapLoops(10)).map((state) => state.gapKey);
    expect(open).toContain('gap:open');
    expect(open).not.toContain('gap:abandoned');
    expect((await readGapLoop('gap:abandoned')).abandoned).toBe(true);
  });

  it('resumes a loop whose verification failed, at ACQUIRE', async () => {
    const key = 'gap:verify-failed';
    await recordGapStep({ gapKey: key, step: 'NOTICE', summary: 'n', detail: { observation: 'o' } });
    await recordGapStep({ gapKey: key, step: 'HYPOTHESIS', summary: 'h', detail: { cause: 'OTHER', enables: 'e', measure: 'm', failureMode: 'f' } });
    await recordGapStep({ gapKey: key, step: 'SEARCH_EXISTING', summary: 's', detail: { searched: ['scan'] } });
    await recordGapStep({ gapKey: key, step: 'VALUE', summary: 'v', detail: { chosen: 'a Factory change', alternatives: 'x' } });
    await recordGapStep({ gapKey: key, step: 'ACQUIRE', summary: 'a', detail: { owner: 'Factory' } });
    await recordGapStep({ gapKey: key, step: 'VERIFY', summary: 'v', detail: { baseline: 'b', comparison: 'c', passed: false } });
    const state = (await openGapLoops(10)).find((one) => one.gapKey === key);
    expect(state?.next).toBe('ACQUIRE');
  });
});
