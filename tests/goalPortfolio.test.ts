/**
 * The goal's combined plan from the quant engine (owner, 2026-11-03): demand
 * estimated from verified rates, the combination chosen under the spending,
 * capital and timing limits, shared outreach counted as one risk, and a
 * probability only when every input is evidence.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio, statedContactsPerDay } from '../server/services/goals/portfolio.ts';
import { readRate } from '../server/services/quant/knowledge.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const fixed = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });

function opening(id: string, over: Partial<ModelledOpportunity> = {}, index = 1): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close: fixed(0.2),
    respond: fixed(0.02),
    directCost: fixed(100),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

const limits = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day from two warmed mailboxes', worlds: 1500, seed: 7 };

describe('demand estimated by the quant engine, world by world', () => {
  it('builds sales from contacts, reply and close, and a probability only when every input is evidence', () => {
    const result = evaluateGoalPortfolio({ ...limits, openings: [opening('a')] });
    const d = result.demand[0]!;
    // 40 a day for 21 selling days.
    expect(d.contacted.p50).toBe(840);
    // ~17 interested, ~3 deals at the median.
    expect(d.interested.p50).toBeGreaterThan(10);
    expect(d.deals.p50).toBeGreaterThanOrEqual(2);
    expect(d.deals.p50).toBeLessThanOrEqual(5);
    expect(d.revenue.p50).toBe(d.deals.p50 * 1500);
    expect(d.justified).toBe(true);
    expect(result.basis).toBe('PROBABILITY');
    expect(result.best?.members[0]?.share).toBe(1);
  });

  it('is coverage, not a probability, while the outreach or a rate is only swept, and says which', () => {
    const result = evaluateGoalPortfolio({ ...limits, resources: null, openings: [opening('a', { respond: swept(0.002, 0.15) })] });
    expect(result.basis).toBe('COVERAGE');
    expect(result.demand[0]!.unestablished).toEqual(expect.arrayContaining(['reply rate', 'outreach a day']));
    expect(result.missing.join(' ')).toMatch(/reply rate/);
  });

  it('refuses an arrangement that ties up more at its start than one may before it proves itself, including an unknown that could', () => {
    const result = evaluateGoalPortfolio({
      ...limits,
      openings: [opening('a', { capital: fixed(500) }), opening('b', { capital: swept(0, 1500) }, 2), opening('c', {}, 3)],
    });
    expect(result.demand.find((d) => d.opportunityId === 'a')!.refused).toMatch(/ties up 500/);
    expect(result.demand.find((d) => d.opportunityId === 'b')!.refused).toMatch(/not established and could be up to 1500/);
    expect(result.best?.members.map((m) => m.opportunityId)).toEqual(['c']);
  });

  it('never gives two openings more than the whole shared outreach', () => {
    const result = evaluateGoalPortfolio({ ...limits, openings: [opening('a'), opening('b', {}, 2), opening('c', {}, 3)] });
    const used = result.best!.members.reduce((sum, m) => sum + (m.share ?? 0), 0);
    expect(used).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('adds a one-off beside the repeatable line, since it needs no outreach', () => {
    const oneOff = opening('x', { repeatable: false, price: fixed(2000), close: fixed(0.9), volume: fixed(1) }, 2);
    const result = evaluateGoalPortfolio({ ...limits, openings: [opening('a'), oneOff] });
    expect(result.best!.members.map((m) => m.opportunityId).sort()).toEqual(['a', 'x']);
    expect(result.best!.members.find((m) => m.opportunityId === 'x')!.share).toBeNull();
  });

  it('does not count cash that settles after the deadline, or a world over the spending ceiling', () => {
    const late = evaluateGoalPortfolio({ ...limits, openings: [opening('a', { daysToCash: fixed(30) })] });
    expect(late.best?.reach ?? 0).toBe(0);
    const costly = evaluateGoalPortfolio({ ...limits, openings: [opening('a', { directCost: fixed(1400), respond: fixed(0.2) })] });
    expect(costly.best!.overSpend).toBeGreaterThan(0.9);
    expect(costly.best!.reach).toBe(0);
  });
});

describe('a published rate, read from a researched sentence', () => {
  it('reads the rate the sentence names, never the other one', () => {
    expect(readRate('Woodpecker measured an average cold email reply rate of 3.43% across 20M emails.', 'respond')).toEqual({ kind: 'POINT', value: 0.0343 });
    expect(readRate('Agencies report closing 10–25% of qualified calls.', 'close')).toEqual({ kind: 'RANGE', low: 0.1, high: 0.25 });
    expect(readRate('Agencies report closing 10–25% of qualified calls.', 'respond')).toBeNull();
    const both = 'The reply rate was 5%, and of the interested prospects 20% converted to a sale.';
    expect(readRate(both, 'respond')).toEqual({ kind: 'POINT', value: 0.05 });
    expect(readRate(both, 'close')).toEqual({ kind: 'POINT', value: 0.2 });
    expect(readRate('The market grew 40% last year.', 'close')).toBeNull();
  });

  it('reads the outreach a day the owner stated, and nothing else', () => {
    expect(statedContactsPerDay('We can send 60 emails a day.')).toBe(60);
    expect(statedContactsPerDay('Budget around 2000 to 3000 dollars, not fixed.')).toBeNull();
  });
});

describe('a candidate fingerprint stays indexable', () => {
  it('keeps a short statement whole and bounds a long one by a digest of the whole', async () => {
    const { fingerprintOf, FINGERPRINT_MAX } = await import('../server/repos/russellCandidates.ts');
    expect(fingerprintOf('A fee charged the buyer')).toBe(fingerprintOf('charge the buyer a fee'.replace('charge', 'charged')));
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const key = fingerprintOf(long);
    expect(key.length).toBeLessThanOrEqual(FINGERPRINT_MAX);
    expect(fingerprintOf(long)).toBe(key);
    expect(fingerprintOf(`${long} extra`)).not.toBe(key);
  });
});
