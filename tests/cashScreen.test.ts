import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { screenOpportunity, type ScreenFacts, type ScreenLimits } from '../server/services/cash/screen.ts';
import { describeNotWorthResearching, notWorthResearching } from '../server/services/cash/worthResearching.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const NOW = '2026-10-30T00:00:00.000Z';
const limits: ScreenLimits = { metric: 'COLLECTED_CASH', daysLeft: 20, capitalCeilingCents: 500_000, capitalBeforeProofCents: null };
const clear: ScreenFacts = {
  capitalRequiredCents: 100_000, noCapitalRoute: null, daysToPayment: 7, expiresAt: null, duplicateOf: null,
  requirements: [], capabilities: [], exclusions: [], hasPayer: true, hasPrice: true, typeHasHistory: true,
  sourceObservedAt: '2026-10-25T00:00:00.000Z',
};
const screen = (over: Partial<ScreenFacts>, l: ScreenLimits = limits) => screenOpportunity({ ...clear, ...over }, l, NOW);

describe('the deterministic screen', () => {
  it('clears an opportunity nothing known rules out', () => {
    expect(screen({}).verdict).toBe('CLEAR');
  });

  it('rejects capital above the goal ceiling, naming the limit, and not under a higher ceiling', () => {
    const v = screen({ capitalRequiredCents: 900_000 });
    expect(v).toMatchObject({ verdict: 'REJECT', reason: 'CAPITAL_TOO_HIGH', limit: 'capital ceiling' });
    expect(screen({ capitalRequiredCents: 900_000 }, { ...limits, capitalCeilingCents: 2_000_000 }).verdict).toBe('CLEAR');
  });

  it('also reads the capital-before-proof limit', () => {
    const v = screen({ capitalRequiredCents: 300_000 }, { ...limits, capitalCeilingCents: 5_000_000, capitalBeforeProofCents: 200_000 });
    expect(v).toMatchObject({ verdict: 'REJECT', limit: 'capital before proof' });
  });

  it('holds, with the route as the question, when a no-capital route is named', () => {
    const v = screen({ capitalRequiredCents: 900_000, noCapitalRoute: 'a finder fee' });
    expect(v).toMatchObject({ verdict: 'HOLD', reason: 'NO_CAPITAL_ROUTE_TO_CONFIRM' });
    expect((v as { question: string }).question).toContain('a finder fee');
  });

  it('rejects payment after the deadline for cash goals only', () => {
    expect(screen({ daysToPayment: 45 })).toMatchObject({ verdict: 'REJECT', reason: 'PAID_TOO_LATE' });
    expect(screen({ daysToPayment: 45 }, { ...limits, metric: 'SETTLED_CASH' }).verdict).toBe('REJECT');
    expect(screen({ daysToPayment: 45 }, { ...limits, metric: 'CONTRIBUTION' }).verdict).toBe('CLEAR');
    expect(screen({ daysToPayment: 45 }, { ...limits, daysLeft: null }).verdict).toBe('CLEAR');
  });

  it('rejects expired, duplicate, excluded and ineligible', () => {
    expect(screen({ expiresAt: '2026-10-01' })).toMatchObject({ reason: 'EXPIRED' });
    expect(screen({ duplicateOf: 'cop_1' })).toMatchObject({ reason: 'DUPLICATE' });
    expect(screen({ requirements: ['SAM.gov registration'], exclusions: ['sam.gov registration'] })).toMatchObject({ reason: 'EXCLUDED_REQUIREMENT' });
    expect(screen({ requirements: ['state licence'], capabilities: ['email'] })).toMatchObject({ reason: 'NOT_ELIGIBLE' });
  });

  it('holds on a missing fact, naming it, and never rejects or clears on a gap', () => {
    const v = screen({ hasPayer: false, daysToPayment: null });
    expect(v).toMatchObject({ verdict: 'HOLD', reason: 'MISSING_FACTS' });
    expect((v as { missing: string[] }).missing).toEqual(['who pays', 'when payment arrives']);
    expect(screen({ capitalRequiredCents: null })).toMatchObject({ verdict: 'HOLD' });
  });

  it('lets a known broken limit reject even while other facts are missing', () => {
    expect(screen({ capitalRequiredCents: 900_000, hasPayer: false }).verdict).toBe('REJECT');
  });

  it('holds when eligibility cannot be checked, the source is stale, or the type is unfamiliar - never rejects', () => {
    expect(screen({ requirements: ['licence'], capabilities: null })).toMatchObject({ verdict: 'HOLD', reason: 'ELIGIBILITY_UNKNOWN' });
    expect(screen({ sourceObservedAt: '2026-01-01T00:00:00.000Z' })).toMatchObject({ verdict: 'HOLD', reason: 'STALE_SOURCE' });
    expect(screen({ typeHasHistory: false })).toMatchObject({ verdict: 'HOLD', reason: 'UNFAMILIAR_TYPE' });
  });
});

describe('worthResearching reads the screen', () => {
  beforeEach(async () => { await freshProject(); });
  const opp = { sourceClaimId: null, expiresAt: null } as unknown as CashOpportunity;
  const rowCount = async () => {
    const db = getDb();
    const n = async (t: string) => Number((await db.get<{ c: number | string }>(`SELECT COUNT(*) AS c FROM ${t}`))?.c ?? 0);
    return [await n('research_orchestrations'), await n('research_fragments'), await n('bins'), await n('work_items')];
  };

  it('stops research on a REJECT, says why, and creates nothing', async () => {
    const before = await rowCount();
    const reason = await notWorthResearching(opp, { now: NOW, screen: { facts: { ...clear, capitalRequiredCents: 900_000 }, limits } });
    expect(reason).toMatchObject({ kind: 'SCREENED_OUT', reason: 'CAPITAL_TOO_HIGH' });
    expect(describeNotWorthResearching(reason!)).toContain('capital ceiling');
    expect(await rowCount()).toEqual(before);
  });

  it('does not stop research on a HOLD, and behaves as before with no screen', async () => {
    expect(await notWorthResearching(opp, { now: NOW, screen: { facts: { ...clear, hasPayer: false }, limits } })).toBeNull();
    expect(await notWorthResearching(opp, { now: NOW })).toBeNull();
  });
});
