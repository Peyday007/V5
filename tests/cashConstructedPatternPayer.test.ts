/**
 * CONSTRUCTION.ROUNDS_FILE, "pattern claims with no payer": production read 0
 * of 27 constructed rounds filing an opening, because the rounds' gated
 * demand_pattern claims were untagged and did not say their buyers pay, and
 * `signalledClaims` reads an untagged pattern only where its own text does
 * (`PATTERN_BUYING_WORDS`). The constructed question now asks for the payer in
 * the claim itself, and `patternStatesPayer` is the harvest's own rule, so the
 * question and the reading cannot drift. No bar moves: a pattern that names no
 * payer still files nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  composeConstruction,
  OPENING_SENTENCE,
  PATTERN_PAYER_SENTENCE,
  patternStatesPayer,
  type ConstructionJob,
  type Primitive,
} from '../server/services/cash/construct.ts';
import { patternStatesBuying } from '../server/repos/research.ts';
import { targetProperties, type GoalLimits } from '../server/services/cash/properties.ts';

function job(): ConstructionJob {
  const limits: GoalLimits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: 50_000, capitalBeforeProofCents: null, bestReachCents: null };
  const now = new Date('2026-11-14T00:00:00Z');
  const p = (name: string): Primitive => ({ name, claimId: null, from: 'INDUSTRY_MAP', ref: `ref:${name}` });
  return {
    sectors: [{ name: 'facilities', demand: [p('property managers')], needs: [p('recurring floor cleaning')], supply: [p('commercial cleaning crews')] }],
    opportunities: [],
    precedent: [],
    capability: { name: 'documents', claimId: null, from: 'CAPABILITY', ref: 'deliverables' },
    priced: [],
    tiedUp: [],
    input: { projectId: 'p', currency: 'USD', delivers: ['documents'], capitalCeilingCents: 50_000, daysLeft: 30, limits, now },
    limits,
    targets: targetProperties(limits).map((one) => one.property),
    exclusions: [],
    now,
  };
}

/** The recorded shape: a gated, dated pattern that never says anybody pays. */
const RECORDED = 'Agencies repeatedly commission monthly reports (examples March 2026, May 2026)';
/** The same pattern, written as the question now asks. */
const ASKED = 'Agencies pay freelance analysts $400 for monthly reports (examples March 2026, May 2026)';

describe('a constructed pattern claim must say who pays (CONSTRUCTION.ROUNDS_FILE)', () => {
  it('reproduces the recorded failure: a pattern with no payer is not one the harvest reads', () => {
    expect(patternStatesPayer(RECORDED)).toBe(false);
    expect(patternStatesBuying(RECORDED)).toBe(false);
  });

  it('a pattern written as the question asks is one the harvest reads', () => {
    expect(patternStatesPayer(ASKED)).toBe(true);
    expect(patternStatesBuying(ASKED)).toBe(true);
    expect(patternStatesPayer(null)).toBe(false);
    expect(patternStatesPayer('')).toBe(false);
  });

  it('the payer requirement is part of the opening sentence every constructed question carries', () => {
    expect(OPENING_SENTENCE).toContain(PATTERN_PAYER_SENTENCE);
    expect(PATTERN_PAYER_SENTENCE).toMatch(/names who pays and says that they pay/);
    // The template the sentence offers satisfies the harvest's own rule.
    expect(patternStatesPayer('these buyers pay this kind of supplier this price for this work')).toBe(true);
    // No quoted phrase: the free lane would read it as a search query.
    expect(PATTERN_PAYER_SENTENCE).not.toContain('"');
  });

  it('every constructed question — reverse and confirm-or-refute — asks for the payer in the claim', async () => {
    const out = await composeConstruction(job());
    expect(out.length).toBeGreaterThan(0);
    const origins = new Set(out.map((one) => one.origin));
    expect(origins.has('REVERSE')).toBe(true);
    expect([...origins].some((one) => one !== 'REVERSE')).toBe(true);
    for (const one of out) expect(one.question).toContain(PATTERN_PAYER_SENTENCE);
  });
});
