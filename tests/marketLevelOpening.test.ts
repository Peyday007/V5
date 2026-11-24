/**
 * A market statistic is not a commercial opening (owner, 2026-11-24).
 *
 * Production researched "global eCommerce" market-size figures as if each were
 * a specific opening. `harvest` no longer files a claim whose basis is a
 * market's size; an opening filed before is not worth researching, durably, so
 * its queued research is released.
 */
import { describe, expect, it } from 'vitest';
import { claimBasis, isMarketLevelFigure } from '../server/services/cash/positionEvidence.ts';
import { describeNotWorthResearching, notWorthResearching } from '../server/services/cash/worthResearching.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const STAT = 'Global eCommerce sales are worth $6.3 trillion in 2025';

describe('market-level figures', () => {
  it('reads a market-size sentence as TOTAL_MARKET_SIZE, and a priced request as not', () => {
    expect(isMarketLevelFigure(STAT)).toBe(true);
    expect(claimBasis({ signal: 'ACTIVE_BUYER_DEMAND', claim: STAT })).toEqual(['TOTAL_MARKET_SIZE']);
    expect(isMarketLevelFigure('A dental clinic in Leeds asks for a bookkeeper at $40 an hour')).toBe(false);
  });

  it('judges an opening filed from a market statistic not worth researching', async () => {
    const opening = { id: 'cop_test', projectId: null, title: STAT, buyingSignal: STAT, payer: null, priceCents: null } as unknown as CashOpportunity;
    const reason = await notWorthResearching(opening, { now: new Date().toISOString() });
    expect(reason).toEqual({ kind: 'MARKET_LEVEL' });
    expect(describeNotWorthResearching(reason!)).toMatch(/market-level figure/);
  });

  it('keeps an opening that names a payer even when its sentence quotes a market size', async () => {
    const opening = { id: 'cop_test2', projectId: null, title: STAT, buyingSignal: STAT, payer: 'Acme Retail', priceCents: null } as unknown as CashOpportunity;
    const reason = await notWorthResearching(opening, { now: new Date().toISOString(), screen: null });
    expect(reason?.kind).not.toBe('MARKET_LEVEL');
  });
});
