/**
 * Where a capability-gap loop stands is read by replaying its rows (AUTO-20-2).
 *
 * The finding this holds untrue: `outstanding` and `next` used to come from
 * "step never recorded", so a loop VERIFY sent back to ACQUIRE reported
 * next=null; and `openGapLoops` treated every un-integrated loop as resumable,
 * so a gap whose VALUE judgment abandoned the direction resurfaced forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import {
  GapStepRefused,
  gapStateFrom,
  openGapLoops,
  readGapLoop,
  recordGapStep,
  type GapLoopStep,
} from '../server/services/selfmodel/gapLoop.ts';

let clock = 0;
function row(step: GapLoopStep, detail: Record<string, unknown> = {}) {
  clock += 1;
  return {
    at: new Date(Date.UTC(2026, 10, 1, 0, 0, clock)).toISOString(),
    provider: step,
    reason: step.toLowerCase(),
    measures: JSON.stringify({ detail }),
  };
}

const throughVerify = () => [
  row('NOTICE', { observation: 'supplier capacity repeatedly missing' }),
  row('HYPOTHESIS', { enables: 'x', measure: 'y', failureMode: 'z', cause: 'MISSING_DATASET' }),
  row('SEARCH_EXISTING', { searched: ['capabilities'] }),
  row('VALUE', { chosen: 'build an integration', alternatives: 'buy access; abandon' }),
  row('ACQUIRE', { owner: 'factory' }),
];

describe('gapStateFrom replays send-backs', () => {
  it('a failed VERIFY sends the loop back to ACQUIRE, even though ACQUIRE was recorded before', () => {
    const state = gapStateFrom('g1', [...throughVerify(), row('VERIFY', { baseline: 'b', comparison: 'worse', passed: false })]);
    expect(state.next).toBe('ACQUIRE');
    expect(state.outstanding).toEqual(['ACQUIRE', 'VERIFY', 'INTEGRATE', 'CONTINUE']);
    expect(state.integrated).toBe(false);
  });

  it('a failed VERIFY after a completed loop reopens it rather than leaving next=null', () => {
    const rows = [
      ...throughVerify(),
      row('VERIFY', { baseline: 'b', comparison: 'better', outcome: 'PASSED' }),
      row('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }),
      row('CONTINUE', { resumed: 'portfolio' }),
    ];
    expect(gapStateFrom('g2', rows).next).toBeNull();
    const reopened = gapStateFrom('g2', [...rows, row('VERIFY', { baseline: 'b', comparison: 'regressed', outcome: 'REGRESSED' })]);
    expect(reopened.next).toBe('ACQUIRE');
    expect(reopened.integrated).toBe(false);
  });

  it('a re-acquisition after a failure then passing verification completes the loop', () => {
    const state = gapStateFrom('g3', [
      ...throughVerify(),
      row('VERIFY', { baseline: 'b', comparison: 'worse', passed: false }),
      row('ACQUIRE', { owner: 'factory' }),
      row('VERIFY', { baseline: 'b', comparison: 'better', passed: true }),
      row('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }),
      row('CONTINUE', { resumed: 'portfolio' }),
    ]);
    expect(state.outstanding).toEqual([]);
    expect(state.next).toBeNull();
    expect(state.integrated).toBe(true);
  });

  it('a new ACQUIRE after INTEGRATE un-integrates the loop: the new piece needs its own check', () => {
    const state = gapStateFrom('g4', [
      ...throughVerify(),
      row('VERIFY', { baseline: 'b', comparison: 'better' }),
      row('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }),
      row('ACQUIRE', { owner: 'factory' }),
    ]);
    expect(state.integrated).toBe(false);
    expect(state.next).toBe('VERIFY');
  });

  it('an explicit reopens sends the loop back to the named step', () => {
    const state = gapStateFrom('g5', [...throughVerify(), row('VERIFY', { baseline: 'b', comparison: 'c', reopens: 'HYPOTHESIS' })]);
    expect(state.next).toBe('HYPOTHESIS');
  });

  it('an abandoning VALUE closes the loop: nothing outstanding, next=null, not integrated', () => {
    const state = gapStateFrom('g6', [
      row('NOTICE', { observation: 'o' }),
      row('VALUE', { chosen: 'abandon the direction', alternatives: 'build; buy' }),
    ]);
    expect(state.abandoned).toBe(true);
    expect(state.outstanding).toEqual([]);
    expect(state.next).toBeNull();
    expect(state.integrated).toBe(false);
  });

  it('a later VALUE that proceeds lifts the abandonment', () => {
    const state = gapStateFrom('g7', [
      row('NOTICE', { observation: 'o' }),
      row('VALUE', { chosen: 'x', alternatives: 'y', decision: 'ABANDON' }),
      row('VALUE', { chosen: 'buy permitted access', alternatives: 'abandon' }),
    ]);
    expect(state.abandoned).toBe(false);
    expect(state.next).toBe('HYPOTHESIS');
  });
});

describe('openGapLoops on the database', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  it('resumes a loop VERIFY sent back and never an abandoned one', async () => {
    const key = (name: string) => `gap:test:${name}`;
    await recordGapStep({ gapKey: key('sent-back'), step: 'NOTICE', summary: 'n', detail: { observation: 'o' } });
    await recordGapStep({
      gapKey: key('sent-back'),
      step: 'HYPOTHESIS',
      summary: 'h',
      detail: { enables: 'e', measure: 'm', failureMode: 'f', cause: 'UNAVAILABLE_PROVIDER' },
    });
    await recordGapStep({ gapKey: key('sent-back'), step: 'SEARCH_EXISTING', summary: 's', detail: { searched: ['code'] } });
    await recordGapStep({ gapKey: key('sent-back'), step: 'VALUE', summary: 'v', detail: { chosen: 'build', alternatives: 'buy' } });
    await recordGapStep({ gapKey: key('sent-back'), step: 'ACQUIRE', summary: 'a', detail: { owner: 'factory' } });
    await recordGapStep({ gapKey: key('sent-back'), step: 'VERIFY', summary: 'v', detail: { baseline: 'b', comparison: 'c', passed: false } });

    await recordGapStep({ gapKey: key('abandoned'), step: 'NOTICE', summary: 'n', detail: { observation: 'o' } });
    await recordGapStep({ gapKey: key('abandoned'), step: 'SEARCH_EXISTING', summary: 's', detail: { searched: ['code'] } });
    await recordGapStep({ gapKey: key('abandoned'), step: 'VALUE', summary: 'v', detail: { chosen: 'abandon', alternatives: 'build' } });

    const open = await openGapLoops();
    const keys = open.map((state) => state.gapKey);
    expect(keys).toContain(key('sent-back'));
    expect(keys).not.toContain(key('abandoned'));
    expect(open.find((state) => state.gapKey === key('sent-back'))?.next).toBe('ACQUIRE');

    await expect(
      recordGapStep({ gapKey: key('abandoned'), step: 'ACQUIRE', summary: 'a', detail: { owner: 'factory' } }),
    ).rejects.toBeInstanceOf(GapStepRefused);
    expect((await readGapLoop(key('abandoned'))).abandoned).toBe(true);
  });

  it('refuses a reopens that names no step or points forward', async () => {
    await expect(
      recordGapStep({ gapKey: 'gap:test:bad', step: 'NOTICE', summary: 'n', detail: { observation: 'o', reopens: 'VERIFY' } }),
    ).rejects.toBeInstanceOf(GapStepRefused);
    await expect(
      recordGapStep({ gapKey: 'gap:test:bad', step: 'NOTICE', summary: 'n', detail: { observation: 'o', reopens: 'NOPE' } }),
    ).rejects.toBeInstanceOf(GapStepRefused);
  });
});
