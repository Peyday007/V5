import { describe, expect, it } from 'vitest';
import { classifyContradiction } from '../server/services/research/contradictions.ts';

function scoped(claim: string) {
  return {
    claim,
    geography: 'US',
    timeframe: null,
    population: null,
    definition: null,
    claimType: 'STATISTIC',
    sourcePublisher: null,
  };
}

describe('quantity-aware contradiction classification', () => {
  it('does not let a shared year hide a real conflict', () => {
    const r = classifyContradiction(
      scoped('In 2024 the market was $5 billion'),
      scoped('In 2024 the market was $8 billion'),
    );
    expect(r.kind).toBe('DIRECT_FACTUAL_CONFLICT');
  });

  it('does not let a shared percentage hide a magnitude conflict', () => {
    const r = classifyContradiction(
      scoped('The market grew 12% to $5 billion'),
      scoped('The market grew 12% to $9 billion'),
    );
    expect(r.kind).toBe('DIRECT_FACTUAL_CONFLICT');
  });

  it('does not scale months to millions', () => {
    const r = classifyContradiction(
      scoped('The contract runs 5 months'),
      scoped('The contract runs 5 million'),
    );
    expect(r.kind).toBe('DIRECT_FACTUAL_CONFLICT');
  });

  it('still resolves identical figures that share a year', () => {
    const r = classifyContradiction(
      scoped('In 2024 the market was $5 billion'),
      scoped('The market was $5 billion in 2024'),
    );
    expect(r.kind).toBe('RESOLVED_BY_CONTEXT');
  });

  it('does not read the same figures stated in a different order as a conflict', () => {
    const r = classifyContradiction(
      scoped('Revenue was $5 billion and costs were $2 billion'),
      scoped('Costs were $2 billion and revenue was $5 billion'),
    );
    expect(r.kind).toBe('RESOLVED_BY_CONTEXT');
  });

  it('still reports a conflict when a figure genuinely differs, in any order', () => {
    const r = classifyContradiction(
      scoped('Revenue was $5 billion and costs were $2 billion'),
      scoped('Costs were $2 billion and revenue was $9 billion'),
    );
    expect(r.kind).toBe('DIRECT_FACTUAL_CONFLICT');
  });
});
