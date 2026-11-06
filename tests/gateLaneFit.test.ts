/**
 * A claim answers the question its lane asks (§88, gate condition LANE_FIT).
 *
 * Production, 2026-11-06 (cash-report 42260462536): the $10K goal's openings
 * had their payer and price lanes "answered" by market-size and company
 * descriptions, which the gate accepted because the source said them. These
 * are those sentences, and answers that must still pass.
 */
import { describe, expect, it } from 'vitest';
import { laneFitFailure } from '../server/services/research/gate.ts';

describe('laneFitFailure', () => {
  it('refuses the production sentences in the payer, price and cost lanes', () => {
    expect(laneFitFailure('payer', 'The shared services market is expected to grow significantly from 2026 to 2033')).toMatch(/who pays/);
    expect(laneFitFailure('payer', "HighRadius is a unified framework that integrates an organization's back and front office")).toMatch(/without saying that anybody pays/);
    expect(laneFitFailure('payer', 'IHPA is an independent authority on key drivers of decision making in the health care space.')).toMatch(/who pays/);
    expect(laneFitFailure('cost_evidence', 'The shared services market was valued at USD 12.25 billion in 2025, growing at a CAGR of 8.05%')).toMatch(/market/);
    expect(laneFitFailure('price_evidence', 'The market is projected to reach USD 22.75 billion by 2033')).toMatch(/market/);
  });

  it('passes genuine answers', () => {
    expect(laneFitFailure('payer', 'Mid-size hospitals contract with outsourced medical billing firms to handle claims.')).toBeNull();
    expect(laneFitFailure('payer', 'The county issued an RFP for janitorial services at its courthouse.')).toBeNull();
    expect(laneFitFailure('payer', 'Regional HVAC distributors pay agencies to qualify inbound leads.')).toBeNull();
    expect(laneFitFailure('price_evidence', 'Bookkeeping for a small business is typically $300 to $800 per month.')).toBeNull();
    expect(laneFitFailure('cost_evidence', 'A virtual assistant costs $15 to $25 per hour on the platform.')).toBeNull();
    // A finding about pricing that states no figure is still an answer; the card refuses to read it as one.
    expect(laneFitFailure('price_evidence', 'Comparable parcel-ownership research engagements are quoted on request.')).toBeNull();
  });

  it('leaves every other lane alone', () => {
    expect(laneFitFailure('timing', 'The shared services market is expected to grow significantly.')).toBeNull();
    expect(laneFitFailure(null, 'anything')).toBeNull();
    expect(laneFitFailure('demand_signal', 'HighRadius is a unified framework.')).toBeNull();
  });
});

describe('a lane-fit refusal is counted as its own kind of rejection', () => {
  it('is LANE_FIT in the improvement scoreboard, not a source problem', async () => {
    const { classifyClaimRejection } = await import('../server/domain/improvement.ts');
    const reason = laneFitFailure('payer', 'IHPA is an independent authority on key drivers of decision making.');
    expect(reason).toMatch(/source/);
    expect(classifyClaimRejection(reason)).toBe('LANE_FIT');
    expect(classifyClaimRejection(laneFitFailure('cost_evidence', 'The market was valued at USD 12.25 billion, a CAGR of 8.05%'))).toBe('LANE_FIT');
    expect(classifyClaimRejection('The claim has no usable source.')).toBe('SOURCE_PROBLEM');
  });
});
