/**
 * A repair never re-offers the rung the failed attempt itself ran under, and a
 * ladder with no fresh rung left is "unresolved" rather than another attempt.
 *
 * Pure: buildRepairPlan takes values, so the failure class is reproduced with
 * the exact shape production stores (a fragment whose repairPlan names the
 * strategy it used).
 */
import { describe, expect, it } from 'vitest';
import { buildRepairPlan } from '../server/services/research/repair.ts';
import type { GateResult } from '../server/services/research/gate.ts';
import type { RepairPlan, RepairStrategy, ResearchFragment } from '../server/domain/types.ts';

const GATE = {
  integrity: 'PASS',
  sufficiency: 'INSUFFICIENT',
  unresolvedRetrieval: [],
  claims: [],
  acceptedClaims: 0,
  rejectedClaims: 0,
  independentSources: 0,
  coverage: [],
  duplicateSourceGroups: [],
  failedConditions: ['COVERAGE'],
  reasons: ['no coverage'],
  unresolvedGaps: [],
} as unknown as GateResult;

function planUsing(strategies: RepairStrategy[]): RepairPlan {
  return { strategies } as unknown as RepairPlan;
}

function fragment(strategies: RepairStrategy[] | null): ResearchFragment {
  return {
    question: 'What is the market size?',
    missingEvidence: null,
    blockedReason: null,
    minIndependentSources: 1,
    repairPlan: strategies ? planUsing(strategies) : null,
  } as unknown as ResearchFragment;
}

function plan(failed: ResearchFragment, history: ResearchFragment[], remainingBudget = 3) {
  return buildRepairPlan({
    fragment: failed,
    gate: GATE,
    history,
    claims: [],
    splitRequired: false,
    remainingBudget,
  });
}

describe('repair plan exhaustion', () => {
  it('does not re-offer the strategy the failed attempt used, even when history omits it', () => {
    const failed = fragment(['FIND_PRIMARY_DATA']);
    const next = plan(failed, []);
    expect(next.strategies).not.toContain('FIND_PRIMARY_DATA');
    expect(next.strategies).not.toContain('MARK_UNRESOLVED');
    expect(next.strategies.length).toBeGreaterThan(0);
  });

  it('still excludes strategies from earlier attempts in history', () => {
    const earlier = fragment(['FIND_PRIMARY_DATA']);
    const failed = fragment(['TRY_DIFFERENT_REPOSITORIES']);
    const next = plan(failed, [earlier]);
    expect(next.strategies).not.toContain('FIND_PRIMARY_DATA');
    expect(next.strategies).not.toContain('TRY_DIFFERENT_REPOSITORIES');
  });

  it('yields MARK_UNRESOLVED when the failed attempt used the last fresh rung', () => {
    const all: RepairStrategy[] = [
      'FIND_PRIMARY_DATA',
      'TRY_DIFFERENT_REPOSITORIES',
      'USE_OFFICIAL_FILINGS',
      'USE_REGULATORY_RECORDS',
      'USE_PROCUREMENT_RECORDS',
      'USE_CLASSIFICATION_CODES',
      'CHANGE_TERMINOLOGY',
      'NARROW_THE_CLAIM',
      'REPLACE_ESTIMATE_WITH_RANGE',
      'MARK_UNRESOLVED',
    ];
    const earlier = fragment(all.slice(0, -2));
    const failed = fragment(['REPLACE_ESTIMATE_WITH_RANGE', 'MARK_UNRESOLVED']);
    expect(plan(failed, [earlier]).strategies).toEqual(['MARK_UNRESOLVED']);
  });

  it('yields MARK_UNRESOLVED on the last attempt regardless of fresh rungs', () => {
    expect(plan(fragment(null), [], 1).strategies).toEqual(['MARK_UNRESOLVED']);
  });
});
