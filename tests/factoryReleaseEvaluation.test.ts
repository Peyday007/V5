/**
 * GOV-17-3: every release is evaluated once, against the one before it, for
 * commercial output and newly unlocked causal links, read from rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { evaluateRelease, releaseEvaluationHoldsOnRows, releaseEvaluations } from '../server/services/factory/program/releaseEvaluation.ts';

beforeEach(async () => {
  await freshProject();
});
afterEach(async () => {
  await teardown();
});

describe('the post-deploy evaluation', () => {
  it('records a baseline, then what each later release changed, once per revision', async () => {
    const first = await evaluateRelease({ programId: 'fpg_x', revision: 'a'.repeat(40), verifiedRequirements: ['R-1'] });
    expect(first?.previousRevision).toBeNull();
    expect(first?.commercialOutputIncreased).toBe(false);
    expect(first?.causalLinkUnlocked).toBe(false);
    expect(first?.snapshot.settledCents).toBe(0);

    expect(await evaluateRelease({ programId: 'fpg_x', revision: 'a'.repeat(40), verifiedRequirements: ['R-1', 'R-2'] })).toBeNull();

    const second = await evaluateRelease({ programId: 'fpg_x', revision: 'b'.repeat(40), verifiedRequirements: ['R-2', 'R-1', 'R-3'] });
    expect(second?.previousRevision).toBe('a'.repeat(40));
    expect(second?.newlyVerified).toEqual(['R-2', 'R-3']);
    expect(second?.causalLinkUnlocked).toBe(true);
    expect(second?.commercialOutputIncreased).toBe(false);

    // Another program's releases are its own.
    await evaluateRelease({ programId: 'fpg_y', revision: 'b'.repeat(40), verifiedRequirements: [] });
    expect((await releaseEvaluations('fpg_x')).map((e) => e.revision)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('the probe passes only for a revision compared with an earlier release', async () => {
    expect((await releaseEvaluationHoldsOnRows(null)).ok).toBe(false);
    await evaluateRelease({ programId: 'fpg_x', revision: 'a'.repeat(40), verifiedRequirements: [] });
    const baseline = await releaseEvaluationHoldsOnRows('a'.repeat(40));
    expect(baseline.ok).toBe(false);
    expect(baseline.detail).toMatch(/first evaluated release/);
    expect((await releaseEvaluationHoldsOnRows('c'.repeat(40))).detail).toMatch(/no post-deploy evaluation/);
    await evaluateRelease({ programId: 'fpg_x', revision: 'b'.repeat(40), verifiedRequirements: ['R-1'] });
    const result = await releaseEvaluationHoldsOnRows('b'.repeat(40));
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toMatch(/unlocked R-1/);
  });
});
