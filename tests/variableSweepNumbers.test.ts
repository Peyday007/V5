/**
 * The sweep's numbers stay sane (production, 2026-11-19, `goals plan` on three
 * new goals): a supplier cost evidenced from $0 printed "evidence reaches
 * ×47021304453333.80", and the sweep's closed-form "strongest overall" read
 * 29.6% beside an engine reading of 3.0% with nothing saying which was which.
 */
import { describe, expect, it } from 'vitest';
import { evidenceMultiple, renderSweep, REQUIREMENT_BOUND, type FastReading, type VariableSweep } from '../server/services/goals/reasoning/variables.ts';
import type { ModelInput } from '../server/services/cash/goalScenario.ts';

const input = (low: number | null, high: number | null, value: number | null = null) => ({ value, low, high, provenance: 'ASSUMED', source: null, note: '' }) as unknown as ModelInput;

describe('evidenceMultiple', () => {
  it('reads the favourable end of a range as a multiple of its middle', () => {
    expect(evidenceMultiple(input(10, 30), false)).toBeCloseTo(1.5);
    expect(evidenceMultiple(input(10, 30), true)).toBeCloseTo(2);
    expect(evidenceMultiple(input(null, null, 5), false)).toBe(1);
  });

  it('a cost evidenced from zero reaches the bound, never middle ÷ 1e-9', () => {
    // The production case: direct cost 0–94,042, middle 47,021.
    expect(evidenceMultiple(input(0, 94_042.6), true)).toBe(REQUIREMENT_BOUND);
    // A range far wider than the bound is held at it too, in either direction.
    expect(evidenceMultiple(input(1e-6, 1_000), true)).toBe(REQUIREMENT_BOUND);
    expect(evidenceMultiple(input(0, 1e9), false)).toBeLessThanOrEqual(REQUIREMENT_BOUND);
    // No middle: nothing to multiply.
    expect(evidenceMultiple(input(0, 0), true)).toBe(1);
  });
});

describe('renderSweep', () => {
  const reading = (reach: number, mean: number): FastReading => ({ feasible: true, mean, p10: 0, p50: mean, p90: mean, reach, committed: 0, binding: 'CAPITAL' });
  const sweep = {
    sentence: 'fast reading: … strongest overall (fast ranking, before the engine) $133,369, 29.6%, 2 assumption(s); …',
    screened: 0,
    factorial: 0,
    local: 0,
    conditionReads: 0,
    elapsedMs: 0,
    stopped: 'COMPLETE',
    variables: [],
    conditions: [],
    approaches: [],
    strategies: [],
    bestMathematical: null,
    requirements: [
      { condition: 'supplier-cost', family: 'SUPPLY', needed: null, evidencedTop: REQUIREMENT_BOUND, inEvidence: false },
      { condition: 'reply', family: 'DEMAND', needed: null, evidencedTop: 1.97, inEvidence: false },
    ],
    sensitive: [],
    directions: [],
    baseline: reading(0.001, 1366),
    bestDecisionSignature: 'sig-best',
  } as unknown as VariableSweep;

  it('never prints a multiple past the bound', () => {
    const text = renderSweep(sweep).join('\n');
    expect(text).toContain(`supplier-cost      no multiple up to ×${REQUIREMENT_BOUND} reaches the requirement · evidence reaches ×${REQUIREMENT_BOUND} or beyond`);
    expect(text).toContain('evidence reaches ×1.97');
    expect(text).not.toMatch(/×\d{4,}/);
  });

  it('puts the engine reading of the strongest overall beside the fast ranking', () => {
    const engine = new Map([['sig-best', { reach: 0.03, settledP50: 2_622_189 }]]);
    const first = renderSweep(sweep, engine)[0]!;
    expect(first).toContain('strongest overall (fast ranking, before the engine)');
    expect(first).toContain('The engine reads the strongest overall at reach 3.0%, p50 $2,622,189.');
    // Without an engine reading, nothing is claimed for it.
    expect(renderSweep(sweep)[0]).not.toContain('The engine reads');
  });
});
