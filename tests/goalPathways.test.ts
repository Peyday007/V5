/**
 * The goal-to-transaction reasoning loop (§93), on openings shaped like the
 * $10K goal's production pool on 2026-11-08: a supplier's own price page
 * (Rev.com, $1.99 a minute), one publication paying $50 a puzzle, and a
 * constructed arrangement priced only by reconstruction.
 */
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';
import {
  informationValue,
  livingPortfolio,
  pathwayOf,
  readPathways,
  reasoningFailures,
  renderPathways,
  requiredStructures,
  type TransactionPathway,
} from '../server/services/goals/pathways.ts';
import { mergeDiagnosis, pathwayTurn } from '../server/services/goals/plan.ts';

const NOW = new Date('2026-11-08T03:00:00Z');
const unknown = (low: number, high: number, note = 'swept'): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note });
const evidence = (value: number, note = 'a gated claim'): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note });
const assumed = (value: number, note = 'a person said'): ModelInput => ({ value, low: value, high: value, provenance: 'ASSUMPTION', source: null, note });

function opening(over: Partial<CashOpportunity>): CashOpportunity {
  return {
    id: 'cop_x',
    projectId: 'prj_1',
    title: 'x',
    mechanism: 'OTHER',
    industry: null,
    payer: null,
    reachableChannel: null,
    buyingSignal: null,
    signalObservedAt: null,
    offerScope: null,
    priceCents: null,
    currency: 'USD',
    fulfillmentOwner: null,
    economicsNote: null,
    expiresAt: null,
    requiredCapabilities: [],
    opportunitySignal: null,
    state: 'EVIDENCE_CARD',
    ...over,
  } as unknown as CashOpportunity;
}

function modelled(o: CashOpportunity, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: o,
    index: 1,
    tier: 'CANDIDATE',
    repeatable: false,
    price: unknown(10, 1000),
    capital: unknown(0, 375),
    hours: unknown(1, 40),
    daysToCash: unknown(3, 60),
    close: unknown(0.02, 0.5),
    respond: unknown(0.002, 0.15),
    directCost: unknown(0, 100),
    volume: assumed(1),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

const rev = modelled(
  opening({ id: 'cop_rev', title: 'Rev.com publishes a per-minute price of $1.99 for its human transcription', payer: null, reachableChannel: 'Rev pricing page: email and telephone support' }),
  { price: evidence(1.99, 'Rev pricing page'), directCost: evidence(79, 'Rev subscription') },
);
const sudoku = modelled(
  opening({
    id: 'cop_sudoku',
    title: 'Artisanal Sudoku (a Substack publication of variant-Sudoku puzzles) pays $50 per puzzle submission',
    payer: 'Artisanal Sudoku, editor jwsinclair',
    reachableChannel: 'email with a link to the puzzle',
    buyingSignal: 'its submission page says contributors are paid $50',
    offerScope: 'one original variant-Sudoku puzzle',
    fulfillmentOwner: 'Brain (puzzle solver)',
  }),
  { price: assumed(50, 'its submission page'), daysToCash: unknown(1, 30) },
);
const constructed = modelled(opening({ id: 'arr_db8ca023bf0a', title: 'Constructed: Reverse: pool several buyers’ purchases with one supplier' }), {
  repeatable: true,
  price: { value: null, low: 300, high: 3000, provenance: 'ASSUMPTION', source: null, note: 'reconstructed', inferred: { tier: 'COMPARABLE', justified: false, p10: 300, p50: 1170, p90: 3000, observations: 4 } },
  volume: unknown(1, 200),
  estimated: { arrangementKey: 'db8ca023bf0a', tier: 'COMPARABLE', observations: 4 },
});
const ctx = { remaining: 10_000, daysLeft: 19, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: ['CONTACT_BUYER'], now: NOW };

describe('backward from the goal', () => {
  const s = requiredStructures({ remaining: 10_000, daysLeft: 19, currency: 'USD', perArrangement: 375, spendCeiling: 3000, outreachPerDay: { low: 10, high: 60, stated: false } });

  it('solves high-ticket, mid, high-frequency, recurring and combined structures from the figures', () => {
    const kinds = new Set(s.structures.map((one) => one.kind));
    for (const kind of ['HIGH_TICKET', 'MID_TICKET', 'HIGH_FREQUENCY', 'RECURRING', 'COMBINATION']) expect(kinds.has(kind as never)).toBe(true);
    const one = s.structures.find((x) => x.deals === 1)!;
    expect(one.netPerDeal).toBe(10_000);
    expect(s.structures.find((x) => x.deals === 1000)!.netPerDeal).toBe(10);
  });

  it('rejects only arithmetic impossibilities: a thousand deals need buyers who come to the offer', () => {
    const thousand = s.structures.find((x) => x.deals === 1000)!;
    expect(thousand.verdict).toBe('NEEDS_INBOUND_CHANNEL');
    expect(s.structures.find((x) => x.deals === 3)!.verdict).toBe('OUTREACH_CAN_CARRY');
    expect(s.minimumNetForOutreach).toBeGreaterThan(100);
    expect(s.searchBrief).toMatch(/supplier's published price/);
  });

  it('a recurring buyer pays once with 19 days left, and says so', () => {
    const recurring = s.structures.find((x) => x.kind === 'RECURRING')!;
    expect(recurring.paymentsPerBuyer).toBe(1);
    expect(recurring.reason).toMatch(/pays once before the deadline/);
  });

  it('nothing settles with no days left', () => {
    const none = requiredStructures({ remaining: 10_000, daysLeft: 1, currency: 'USD', perArrangement: null, spendCeiling: null, outreachPerDay: { low: 10, high: 60, stated: false } });
    expect(none.structures.every((x) => x.verdict === 'IMPOSSIBLE')).toBe(true);
  });
});

describe('a transaction model per opening', () => {
  it('separates proven, estimated and unknown on every field', () => {
    const p = pathwayOf(sudoku, null, ctx);
    expect(p.buyer.status).toBe('PROVEN');
    expect(p.channel.status).toBe('PROVEN');
    expect(p.revenuePerDeal.status).toBe('ESTIMATED');
    expect(p.daysToCash.status).toBe('UNKNOWN');
    expect(p.acquisitionCost.status).toBe('ESTIMATED');
    expect(p.counts.proven + p.counts.estimated + p.counts.unknown).toBe(14);
    expect(p.dependencies).toContain('CONTACT_BUYER');
  });

  it('a supplier\'s price page is supply without a buyer, and Brain constructs the buyer side against its price', () => {
    const p = pathwayOf(rev, null, ctx);
    expect(p.gaps).toContain('SUPPLY_WITHOUT_BUYER');
    expect(p.gaps).toContain('NO_MARGIN');
    const flip = p.moves.find((m) => m.gap === 'SUPPLY_WITHOUT_BUYER' && m.action === 'CONSTRUCT')!;
    expect(flip.construct).toMatch(/supplier's own buyers below its published 1\.99/);
    expect(flip.variant!.revenuePerDeal.status).toBe('ESTIMATED');
    // The construction never invents our cost: it stays unknown.
    expect(flip.variant!.costPerDeal.status).toBe('UNKNOWN');
    expect(p.moves.some((m) => m.gap === 'NO_MARGIN')).toBe(true);
    expect(p.executable).toBe(false);
  });

  it('one small buyer is transferred to its population instead of dropped, and its sale proceeds blocked only by the permission', () => {
    const p = pathwayOf(sudoku, null, ctx);
    expect(p.gaps).toContain('ONE_BUYER');
    const transfer = p.moves.find((m) => m.gap === 'ONE_BUYER')!;
    expect(transfer.action).toBe('CONSTRUCT');
    expect(transfer.mustHit).toMatch(/20 buyers like it at 50 USD carry a tenth/);
    const sell = p.moves.find((m) => m.action === 'SELL')!;
    expect(sell.construct).toMatch(/once CONTACT_BUYER is granted; everything else proceeds now/);
    expect(p.fit.verdict).toBe('TOO_SMALL_AS_IS');
    expect(p.fit.lever.variable).toBe('VOLUME');
  });

  it('a constructed estimate is never executable and says why', () => {
    const p = pathwayOf(constructed, null, ctx);
    expect(p.origin).toBe('CONSTRUCTED');
    expect(p.executable).toBe(false);
    expect(p.notExecutable.join(' ')).toMatch(/constructed/);
    expect(p.revenuePerDeal.status).toBe('ESTIMATED');
  });

  it('a closed opening contributes nothing', () => {
    const closed = modelled(opening({ id: 'cop_closed', title: 'Ticket resale', expiresAt: '2026-10-13T00:00:00Z' }), { price: evidence(649) });
    const p = pathwayOf(closed, null, ctx);
    expect(p.gaps).toContain('CLOSED');
    expect(p.contribution.p90).toBe(0);
  });
});

describe('the quantity shapes the search', () => {
  it('ranks the unknowns by how far they move the plan', () => {
    const pathways = [pathwayOf(constructed, null, ctx), pathwayOf(sudoku, null, ctx)];
    const ranked = informationValue(pathways, { remaining: 10_000, daysLeft: 19, outreachPerDay: 60, leaders: new Set(['arr_db8ca023bf0a']), marginal: pathways[0]!.contribution.p50 });
    expect(ranked.length).toBeGreaterThan(0);
    for (let i = 1; i < ranked.length; i += 1) {
      const a = ranked[i - 1]!;
      const b = ranked[i]!;
      expect(Number(a.changesPlan) > Number(b.changesPlan) || (a.changesPlan === b.changesPlan && a.swing >= b.swing)).toBe(true);
    }
    const arr = ranked.find((r) => r.opportunityId === 'arr_db8ca023bf0a' && r.variable === 'conversion')!;
    const small = ranked.find((r) => r.opportunityId === 'cop_sudoku' && r.variable === 'conversion')!;
    expect(arr.swing).toBeGreaterThan(small.swing * 10);
    expect(arr.field).toBe('conversionRates');
  });
});

describe('a living portfolio', () => {
  it('combines under the gap, keeps a fallback outside the leader\'s group, and counts gross apart from net', () => {
    const pathways: TransactionPathway[] = [pathwayOf(constructed, null, ctx), pathwayOf(sudoku, null, ctx), pathwayOf(rev, null, ctx)];
    const p = livingPortfolio(pathways, { remaining: 10_000, capitalCeiling: 3000 });
    expect(p.leading).not.toBeNull();
    // No margin: Rev is never a member.
    expect(p.leading!.members).not.toContain('cop_rev');
    expect(p.leading!.net.p50).toBeLessThanOrEqual(10_000);
    expect(p.leading!.gross.p50).toBeGreaterThanOrEqual(p.leading!.net.p50);
    expect(p.note).toMatch(/never a probability/);
    expect(p.permissions).toContain('CONTACT_BUYER');
  });
});

describe('its own reasoning failures', () => {
  it('names an acquisition problem and a repeated gap as method changes', () => {
    const supply = [1, 2, 3, 4].map((n) =>
      pathwayOf(modelled(opening({ id: `cop_s${n}`, title: `Vendor ${n} publishes its pricing page at $${n * 10} per page` }), { price: evidence(n * 10) }), null, ctx),
    );
    const failures = reasoningFailures(supply, [
      { state: 'ABANDONED', found: 0 },
      { state: 'ABANDONED', found: 0 },
      { state: 'HARVESTED', found: 0 },
      { state: 'ABANDONED', found: 0 },
    ]);
    const causes = failures.map((f) => f.cause);
    expect(causes).toContain('CONSTRUCTION_FAILURE');
    expect(causes).toContain('ACQUISITION_FAILURE');
    expect(causes).toContain('REPEATED_GAP');
    // The method's own failures lead, and a repeated cause is kept once.
    const merged = mergeDiagnosis(failures, [{ cause: 'NO_BUYER', evidence: 'e', instruction: 'i' }, { cause: 'ACQUISITION_FAILURE', evidence: 'dup', instruction: 'dup' }]);
    expect(merged[0]!.cause).toBe(failures[0]!.cause);
    expect(merged.filter((f) => f.cause === 'ACQUISITION_FAILURE')).toHaveLength(1);
  });
});

describe('the whole reading', () => {
  it('produces next actions — sell, construct, research — and renders every field', () => {
    const reading = readPathways({
      modelled: [rev, sudoku, constructed],
      considered: [],
      target: { remainingCents: 1_000_000, daysLeft: 19, currency: 'USD', capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500 },
      portfolio: null,
      permissionsMissing: ['CONTACT_BUYER', 'a message provider'],
      rounds: [],
      now: NOW,
    });
    expect(reading.nextActions[0]!.action).toBe('SELL');
    expect(reading.nextActions[0]!.blockedBy).toContain('CONTACT_BUYER');
    expect(reading.nextActions.some((a) => a.action === 'CONSTRUCT' && a.opportunityId === 'cop_rev')).toBe(true);
    expect(reading.measures.pathways).toBe(3);
    expect(reading.measures.variants).toBeGreaterThan(0);
    expect(reading.measures.proceedWithoutEngineering).toBe(1);
    const lines = renderPathways(reading).join('\n');
    expect(lines).toMatch(/reasoning {3}goal-to-transaction loop/);
    expect(lines).toMatch(/structure HIGH_TICKET/);
    expect(lines).toMatch(/buyer P Artisanal Sudoku/);
    expect(lines).toMatch(/leading/);
  });
});

describe('pathway constructions take turns with the arrangements', () => {
  it('goes after an arrangement, never twice running, and never first', () => {
    expect(pathwayTurn([], 'wst_g')).toBe(false);
    expect(pathwayTurn([{ bucketId: 'goal-wst_g-mx-abc', openedAt: '2026-11-08T01:00:00Z' }], 'wst_g')).toBe(true);
    expect(pathwayTurn([{ bucketId: 'goal-wst_g-mx-abc', openedAt: '2026-11-08T01:00:00Z' }, { bucketId: 'goal-wst_g-mx-pw123', openedAt: '2026-11-08T02:00:00Z' }], 'wst_g')).toBe(false);
    // Another goal's rounds and lens rounds are not this goal's construction.
    expect(pathwayTurn([{ bucketId: 'goal-wst_g-open', openedAt: '2026-11-08T03:00:00Z' }, { bucketId: 'goal-wst_h-mx-pw1', openedAt: '2026-11-08T04:00:00Z' }, { bucketId: 'goal-wst_g-mx-abc', openedAt: '2026-11-08T01:00:00Z' }], 'wst_g')).toBe(true);
  });
});
