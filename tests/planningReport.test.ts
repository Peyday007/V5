import { describe, expect, it } from 'vitest';
import { planningReport, planningReportLines } from '../server/services/goals/planningReport.ts';

const target = { metric: 'SETTLED_CASH', metricLabel: 'settled cash', currency: 'USD', projectId: 'p', targetCents: 1_000_000, achievedCents: 0, remainingCents: 1_000_000, achieved: false, daysLeft: 16, counted: [], notCounted: [], since: '2026-11-03', capitalCeilingCents: 300_000, hoursCeiling: 0, resources: null, capitalBeforeProofCents: 37_500, capitalPerWeekCents: 75_000, proven: false } as never;

describe('the permanent planning report', () => {
  it('reports UNKNOWN, never the coverage figure, for the audited $10K candidate', () => {
    const r = planningReport(
      {
        target,
        verdict: 'NOT_VIABLE',
        summary: 'no performer is established',
        measuredChance: null,
        acceptance: { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: { label: 'x', opportunityIds: [], source: 'PATHWAYS', settledP50: 10000, reach: 0.9795, reachBasis: 'COVERAGE' }, shortfalls: ['the best combination counts money from arr_6f3b7a404ca5 whose price nobody has established'], sentence: '' } as never,
      },
      '2026-12-09T00:00:00.000Z',
    );
    expect(r.probability).toBe('UNKNOWN');
    expect(r.evidence).toMatch(/not a probability/);
    expect(r.commerciallyValidated).toBe(false);
    expect(r.blocker).toMatch(/arr_6f3b7a404ca5/);
    const text = planningReportLines(r).join('\n');
    expect(text).toContain('real-world probability: UNKNOWN');
    expect(text).not.toMatch(/real-world probability: \d/);
  });

  it('keeps an evidenced Monte Carlo out of the probability line', () => {
    const r = planningReport({ target, verdict: 'RECOMMENDABLE', summary: '', measuredChance: null, acceptance: { status: 'ACCEPTED', required: 0.9, probability: { value: 0.93, lowerBound: 0.91, basis: 'EVIDENCED_PORTFOLIO', sample: 2000, note: 'all inputs evidenced' }, accepted: { label: 'a', opportunityIds: [] }, candidate: null, shortfalls: [], sentence: '' } as never, commercialReality: { validated: true, failing: [] } }, null);
    expect(r.probability).toBe('UNKNOWN');
    expect(r.commerciallyValidated).toBe(true);
  });

  it('reports a probability measured against real outcomes', () => {
    const r = planningReport({ target, verdict: 'RECOMMENDABLE', summary: '', measuredChance: null, acceptance: { status: 'ACCEPTED', required: 0.9, probability: { value: 0.92, lowerBound: 0.9, basis: 'MEASURED_RECORD', sample: 40, note: '37 of 40 met' }, accepted: { label: 'a', opportunityIds: [] }, candidate: null, shortfalls: [], sentence: '' } as never, commercialReality: { validated: false, failing: ['arr_x: the buyer population is one organisation'] } }, null);
    expect(r.probability).toEqual({ value: 0.92, lowerBound: 0.9 });
    expect(r.commerciallyValidated).toBe(false);
    expect(r.blocker).toMatch(/one organisation/);
  });
});
