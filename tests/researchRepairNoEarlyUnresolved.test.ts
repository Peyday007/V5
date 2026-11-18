/**
 * A non-final repair is a search, never a search paired with "give up".
 *
 * Recorded failure class CAPABILITY:RESEARCH.RECOVERY.RETRY ("repeated
 * failure", "retry repeating the same strategy"): the condition-keyed ladder
 * ends in DEFAULT_LADDER's MARK_UNRESOLVED, so with one search rung left and
 * attempts still paid for, the plan read [<rung>, 'MARK_UNRESOLVED'] and the
 * worker was told both to search and to say it is not established and stop.
 *
 * Pure: buildRepairPlan takes values, so the shape production stores (a
 * fragment whose repairPlan names the strategies it used) reproduces it.
 */
import { describe, expect, it } from 'vitest';
import { buildRepairPlan, describeRepairPlan } from '../server/services/research/repair.ts';
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

/** Every rung the COVERAGE ladder plus the default ladder offers, except the last search rung. */
const ALL_BUT_ONE: RepairStrategy[] = [
  'FIND_PRIMARY_DATA',
  'TRY_DIFFERENT_REPOSITORIES',
  'USE_OFFICIAL_FILINGS',
  'USE_REGULATORY_RECORDS',
  'USE_PROCUREMENT_RECORDS',
  'USE_CLASSIFICATION_CODES',
  'CHANGE_TERMINOLOGY',
  'NARROW_THE_CLAIM',
];

function fragment(strategies: RepairStrategy[] | null): ResearchFragment {
  return {
    fragmentKey: 'market-size',
    question: 'What is the market size?',
    geography: null,
    timeframe: null,
    missingEvidence: null,
    blockedReason: null,
    minIndependentSources: 1,
    repairPlan: strategies ? ({ strategies } as unknown as RepairPlan) : null,
  } as unknown as ResearchFragment;
}

function plan(
  failed: ResearchFragment,
  history: ResearchFragment[],
  remainingBudget: number,
  blockCause: 'SOURCES_UNREADABLE' | null = null,
) {
  return buildRepairPlan({
    fragment: failed,
    gate: GATE,
    history,
    claims: [],
    splitRequired: false,
    remainingBudget,
    blockCause,
  });
}

describe('repair plan: no early MARK_UNRESOLVED', () => {
  it('offers the last search rung alone, not paired with MARK_UNRESOLVED, while attempts remain', () => {
    const earlier = fragment(ALL_BUT_ONE.slice(0, 6));
    const failed = fragment(ALL_BUT_ONE.slice(6));
    const next = plan(failed, [earlier], 2);
    expect(next.strategies).toEqual(['REPLACE_ESTIMATE_WITH_RANGE']);
    expect(next.strategies).not.toContain('MARK_UNRESOLVED');
    expect(describeRepairPlan(next)).not.toMatch(/say so explicitly, list where you looked, and stop/);
  });

  it('never pairs MARK_UNRESOLVED with a search on the default ladder either', () => {
    const noConditions = { ...GATE, failedConditions: [] } as unknown as GateResult;
    const next = buildRepairPlan({
      fragment: fragment(['FIND_PRIMARY_DATA', 'TRY_DIFFERENT_REPOSITORIES', 'CHANGE_TERMINOLOGY']),
      gate: noConditions,
      history: [],
      claims: [],
      splitRequired: false,
      remainingBudget: 3,
    });
    expect(next.strategies).toEqual(['NARROW_THE_CLAIM']);
  });

  it('still answers MARK_UNRESOLVED alone when no search rung is left', () => {
    const earlier = fragment(ALL_BUT_ONE);
    const failed = fragment(['REPLACE_ESTIMATE_WITH_RANGE']);
    expect(plan(failed, [earlier], 3).strategies).toEqual(['MARK_UNRESOLVED']);
  });

  it('still answers MARK_UNRESOLVED alone on the last attempt', () => {
    expect(plan(fragment(null), [], 1).strategies).toEqual(['MARK_UNRESOLVED']);
  });

  it('leaves the unreadable ladder unchanged', () => {
    expect(plan(fragment(null), [], 3, 'SOURCES_UNREADABLE').strategies).toEqual([
      'RESOLVE_CANONICAL_LINK',
      'INSPECT_ARCHIVED_SOURCES',
    ]);
    expect(plan(fragment(null), [], 1, 'SOURCES_UNREADABLE').strategies).toEqual(['MARK_UNRESOLVED']);
  });
});
