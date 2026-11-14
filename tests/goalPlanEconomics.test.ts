/**
 * The goal planner's reconstruction stays inside economics (§99, §101, §102 repair, 2026-11-14).
 *
 * Production read a $10K / 30-day / $3K goal's "best" plan at p50 $34,533,142: price moves compounded past
 * their clamp, a bought channel and a partner each counted the whole market again, supplier cost vanished
 * under prepaid fulfilment, a deposit pulled every world's cash to the fast end, and nothing asked whether
 * the number was plausible. Each test below is one of those mechanisms, held at the family level.
 */
import { describe, expect, it } from 'vitest';
import { demandWorlds, evaluateGoalPortfolio, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { buildOperators, movableOpenings, reconstructPlan, RETURN_BOUND, type StrategyState } from '../server/services/goals/reconstruction.ts';
import { applyProgram, makeDirection, recombine, type Transform } from '../server/services/goals/reasoning/directions.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';

const limits = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 600, seed: 11 };
const baseline = evaluateGoalPortfolio({ ...limits, openings: GOAL_10K_OPENINGS });
const openings = movableOpenings(GOAL_10K_OPENINGS, baseline);
const input = { openings, portfolio: limits, baseline, required: 0.9 };
const base: StrategyState = { openings, committed: 0, changes: [] };
const ctx = { operators: buildOperators({ input, base }), operatorsFor: (t: string) => buildOperators({ input, base, target: t }), remaining: limits.remaining };
const card = (id: string) => GOAL_10K_OPENINGS.find((o) => o.opportunity.id === id)!;
const fixed = (v: number): ModelInput => ({ value: v, low: v, high: v, provenance: 'EVIDENCE', source: null, note: '' });

describe('Q-1: moves of one family never stack', () => {
  it('holds every opening within ×4 of its card\'s unit price, whatever program reaches it', () => {
    const programs: Transform[][] = [
      [{ op: 'PRICE', factor: 1.3, scope: 'FAST_CASH' }, { op: 'PRICE', factor: 3.375, scope: 'OUTREACH' }, { op: 'PRICE', factor: 4, scope: 'TOP' }],
      [{ op: 'OPERATOR', key: 'transaction:bundle' }, { op: 'PRICE', factor: 4, scope: 'ALL' }, { op: 'PRICE', factor: 4, scope: 'ALL' }, { op: 'OPERATOR', key: 'transaction:retainer' }],
      [{ op: 'OPERATOR', key: 'partner:', target: 'arr_ai_reception' }, { op: 'PRICE', factor: 4, scope: 'id:arr_ai_reception' }, { op: 'PRICE', factor: 2.5, scope: 'ALL' }],
    ];
    for (const program of programs) {
      const { state } = applyProgram(base, program, ctx);
      for (const o of state.openings as PlannedOpening[]) {
        const id = o.opportunity.id.split('~')[0]!;
        const units = o.terms?.units ?? 1;
        const keep = o.opportunity.id.endsWith('~partner') ? 0.8 : 1;
        expect(o.terms?.priceFactor ?? 1).toBeLessThanOrEqual(4 + 1e-9);
        expect((o.price.high ?? 0) / units).toBeLessThanOrEqual(4 * keep * (card(id).price.high ?? 0) + 1e-6);
      }
      // One transaction shape per opening.
      expect(state.changes.filter((c) => c.dimension === 'TRANSACTION').length).toBeLessThanOrEqual(1);
    }
  });

  it('a larger capacity budget replaces a smaller one, and recombination keeps one move per family', () => {
    const { state } = applyProgram(base, [{ op: 'OPERATOR', key: 'capacity:cold-email-prewarmed@375' }, { op: 'OPERATOR', key: 'capacity:cold-email-prewarmed@3000' }], ctx);
    expect(state.changes.filter((c) => c.op?.startsWith('capacity:cold-email-prewarmed@'))).toHaveLength(1);
    expect(state.committed).toBeLessThanOrEqual(3000);
    const d = (name: string, program: Transform[]) => makeDirection({ name, stance: name, origin: 'ALGORITHM', thinking: '', from: 'BASELINE', program });
    const r = recombine(recombine(d('A', [{ op: 'PRICE', factor: 2.5, scope: 'TOP' }]), d('B', [{ op: 'PRICE', factor: 4, scope: 'TOP' }, { op: 'OPERATOR', key: 'capacity:cold-email-prewarmed@375' }])), d('C', [{ op: 'OPERATOR', key: 'capacity:cold-email-prewarmed@3000' }, { op: 'OPERATOR', key: 'transaction:bundle' }]));
    expect(r.program.filter((t) => t.op === 'OPERATOR' && t.key.startsWith('capacity:cold-email-prewarmed@'))).toHaveLength(1);
    expect(r.program.filter((t) => t.op === 'PRICE')).toHaveLength(1);
  });
});

describe('Q-2: a higher price shrinks the market as well as the close', () => {
  it('moves volume by the demand curve', () => {
    const { state } = applyProgram(base, [{ op: 'PRICE', factor: 4, scope: 'id:cop_lists' }], ctx);
    const lists = state.openings.find((o) => o.opportunity.id === 'cop_lists')!;
    expect(lists.volume.high!).toBeCloseTo(300 * Math.pow(4, -1.2), 6);
  });
});

describe('Q-3: the target is cash kept, and prepaid fulfilment only lifts the ceiling', () => {
  const gifts = openings.filter((o) => o.opportunity.id === 'arr_gifts');
  const read = (funded: boolean, ceiling: number | null) =>
    evaluateGoalPortfolio({ ...limits, capitalCeiling: ceiling, openings: gifts.map((o) => ({ ...o, fundedByBuyer: funded })), contactsPerDay: fixed(2000) }).best!;

  it('fundedByBuyer leaves reach unchanged where the ceiling does not bind', () => {
    expect(read(true, null).reach).toBe(read(false, null).reach);
  });

  it('under a binding ceiling it changes overSpend, and its reach is what the plan keeps with no ceiling at all', () => {
    const funded = read(true, 3000);
    const owner = read(false, 3000);
    expect(funded.overSpend).toBe(0);
    expect(owner.overSpend).toBeGreaterThan(0.5);
    expect(funded.reach).toBe(read(false, null).reach);
    // An 80% supplier cost is not cash kept: reach is read on kept cash, not on gross receipts.
    expect(funded.keptP50!).toBeLessThan(funded.settledP50 * 0.5);
  });
});

describe('Q-4: a deposit brings forward a share, not the whole sale', () => {
  it('keeps the balance at the opening\'s own timing, so some worlds still settle late', () => {
    const o: PlannedOpening = { ...card('arr_cleaning'), deposit: { low: 0.3, high: 0.5, days: 10 } };
    const w = demandWorlds(o, 1, 30, fixed(300), 2000, 11);
    let late = 0;
    let shareBelowHalf = 0;
    for (let i = 0; i < 2000; i++) {
      if (w.days[i]! > 10 && w.cash[i]! > 0) late++;
      const total = w.cash[i]! + w.early!.cash[i]!;
      if (total > 0 && w.early!.cash[i]! / total <= 0.5 + 1e-9) shareBelowHalf++;
    }
    expect(late).toBeGreaterThan(100);
    expect(shareBelowHalf).toBeGreaterThan(100);
  });
});

describe('Q-6: clones of an opening sell into one market', () => {
  it('a bought channel and a partner never sell more deals together than one draw of the market', () => {
    const one = (id: string, extra: Partial<PlannedOpening>): PlannedOpening =>
      ({
        opportunity: { id, title: id } as ModelledOpportunity['opportunity'], index: id.length, tier: 'QUALIFIED', repeatable: true,
        price: fixed(400), capital: fixed(0), hours: fixed(0), daysToCash: fixed(1), close: fixed(1), respond: fixed(1), directCost: fixed(0), volume: fixed(50),
        agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false, ...extra,
      }) as PlannedOpening;
    const channel = (r: string) => ({ label: r, perDay: fixed(500), resource: `channel:${r}`, riskGroup: `channel:${r}` });
    const market = [one('m', {}), one('m~paid', { marketKey: 'm', channel: channel('paid') }), one('m~partner', { marketKey: 'm', channel: channel('partner') })];
    const p = evaluateGoalPortfolio({ remaining: 30_000, daysLeft: 30, capitalCeiling: null, beforeProof: null, perWeek: null, resources: '1000 emails a day', openings: market, worlds: 400, seed: 3 });
    // Without the shared market the three copies settle 3 × 50 × 400 = 60,000 in every world.
    expect(p.best!.reach).toBe(0);
    for (const c of [p.best!, ...p.alternatives]) expect(c.settledP90).toBeLessThanOrEqual(50 * 400 + 1e-6);
  });
});

const r = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: limits, baseline, required: 0.9, explore: null });

describe('Q-5, C-4, C-14: the floor, the critic and the interval', () => {
  it('reads the as-is floor on the plan with every assumed move taken away', () => {
    expect(r.floor).not.toBeNull();
    expect(r.floor!.changes.some((c) => c.basis === 'ASSUMPTION')).toBe(false);
  });

  it('the plan concluded with is plausible, and its p50 stays within the bound on the money behind it', () => {
    expect(r.best.implausible ?? []).toHaveLength(0);
    expect(r.best.settledP50 / Math.max(1, r.best.committed + (limits.capitalCeiling ?? 0))).toBeLessThanOrEqual(RETURN_BOUND);
    expect(r.best.worlds).toBeGreaterThan(0);
    expect(Array.isArray(r.flags)).toBe(true);
  });

  it('a $1M goal on $3K reaches no more than every estimate at its favourable end does, and is never concluded on an implausible reading', async () => {
    const big = { ...limits, remaining: 1_000_000 };
    const b = evaluateGoalPortfolio({ ...big, openings: GOAL_10K_OPENINGS });
    const m = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: big, baseline: b, required: 0.9, explore: { sweepMs: 3000, maxVariations: 10_000, maxMs: 20_000 } });
    expect(m.best.reach).toBeLessThanOrEqual(m.headroom.reach + 0.02);
    expect(m.best.implausible ?? []).toHaveLength(0);
  }, 120_000);
});
