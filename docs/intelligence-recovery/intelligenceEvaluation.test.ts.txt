/**
 * Surge B — independent intelligence evaluation (2026-11-14).
 *
 * HOW TO RUN
 *
 *     npx vitest run tests/intelligenceEvaluation.test.ts
 *
 * Every case prints one measured line to stdout, prefixed `INTEL_EVAL `, with
 * the case id, PASS/FAIL per assertion, verdict, reach, strategies considered,
 * distinct mechanisms and elapsed ms:
 *
 *     npx vitest run tests/intelligenceEvaluation.test.ts 2>&1 | grep '^INTEL_EVAL '
 *
 * The baseline taken on the code before the Surge B repairs is
 * `docs/intelligence-recovery/evaluation-baseline.md`.
 *
 * WHAT THIS IS
 *
 * The evaluator's cases, written from the owner's requirements
 * (`docs/INTELLIGENCE-RECOVERY-2026-11-14.md`) and the public planning
 * interfaces only — never from the repair branches. Each `describe` is one
 * concrete economic world (openings, claims with sourced figures, industry
 * nodes) and an objective; each assertion states what a competent economic
 * planner must do with it. Failures on the unrepaired code are expected and
 * are the point: an assertion is never relaxed to match what the code does.
 *
 * Every assertion inside a case runs even when an earlier one fails (each is
 * recorded), and the case fails at the end if any did.
 *
 * Entry points used: `constructArrangements` (§81/§82 construction over the
 * project's rows), `pickEstimatedArrangements` (what enters the goal model),
 * `evaluateGoalPortfolio` (the quant engine's combination), `reconstructPlan`
 * (§99 strategy reconstruction), `judgeAcceptance` (the acceptance rule),
 * `reconstruct` / `toScenarioInput` (§79 quantitative reconstruction),
 * `requiredStructures` (the arithmetic of a goal), and `readGoalPlan` (the
 * whole goal plan read over the database).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { evaluateGoalPortfolio, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { reconstructPlan, type Reconstruction } from '../server/services/goals/reconstruction.ts';
import { requiredStructures } from '../server/services/goals/pathways.ts';
import { judgeAcceptance, readGoalPlan, forgetGoalReadings } from '../server/services/goals/plan.ts';
import { estimateInput, pickEstimatedArrangements, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { clearConstructionMemo, constructArrangements, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import { toScenarioInput } from '../server/services/quant/export.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import type { Observation, QuantityNode } from '../server/domain/quant.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { getDb } from '../server/db/database.ts';
import { SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';
import type { CashMechanism, Layer, OpportunitySignal } from '../server/domain/types.ts';

/* ------------------------------------------------------------------ */
/* Measurement harness                                                 */
/* ------------------------------------------------------------------ */

interface MeasuredLine {
  case: string;
  assertions: Record<string, 'PASS' | 'FAIL'>;
  verdict: string | null;
  reach: number | null;
  strategies: number | null;
  mechanisms: number | null;
  ms: number;
  values: Record<string, unknown>;
}

function evaluation(id: string) {
  const t0 = performance.now();
  const line: MeasuredLine = { case: id, assertions: {}, verdict: null, reach: null, strategies: null, mechanisms: null, ms: 0, values: {} };
  const failures: string[] = [];
  return {
    line,
    /** One assertion: recorded PASS/FAIL, never stops the case early. */
    async check(name: string, fn: () => unknown | Promise<unknown>): Promise<boolean> {
      try {
        await fn();
        line.assertions[name] = 'PASS';
        return true;
      } catch (error) {
        line.assertions[name] = 'FAIL';
        failures.push(`${name}: ${(error as Error).message.split('\n').slice(0, 3).join(' ')}`);
        return false;
      }
    },
    measure(values: Partial<Omit<MeasuredLine, 'case' | 'assertions' | 'values' | 'ms'>> & Record<string, unknown>): void {
      for (const [k, v] of Object.entries(values)) {
        if (k === 'verdict' || k === 'reach' || k === 'strategies' || k === 'mechanisms') (line as unknown as Record<string, unknown>)[k] = v;
        else line.values[k] = v;
      }
    },
    done(): void {
      line.ms = Math.round(performance.now() - t0);
      console.log(`INTEL_EVAL ${JSON.stringify(line)}`);
      if (failures.length > 0) throw new Error(`${id}: ${failures.length} assertion(s) failed\n  - ${failures.join('\n  - ')}`);
    },
  };
}

const round = (x: number | null | undefined, d = 4): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/* ------------------------------------------------------------------ */
/* Pure-model fixtures (the quant engine's view of an opening)          */
/* ------------------------------------------------------------------ */

const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'nobody has established it' });
const fixed = (value: number, note = 'published figure'): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: { kind: 'CLAIM', ref: `clm_${note.replace(/\W+/g, '_').slice(0, 20)}` }, note });
const evidenced = (low: number, high: number, note = 'published range'): ModelInput => ({ value: null, low, high, provenance: 'EVIDENCE', source: { kind: 'CLAIM', ref: `clm_${note.replace(/\W+/g, '_').slice(0, 20)}` }, note });

function opening(id: string, title: string, index: number, over: Partial<ModelledOpportunity> & { mechanism?: string; paymentTerms?: string; payer?: string }): PlannedOpening {
  const { mechanism, paymentTerms, payer, ...rest } = over;
  return {
    opportunity: { id, title, mechanism: mechanism ?? 'PRODUCTIZED_SERVICE', payer: payer ?? null, paymentTerms: paymentTerms ?? null, createdAt: '2026-11-14T00:00:00Z' } as unknown as ModelledOpportunity['opportunity'],
    index,
    tier: 'QUALIFIED',
    repeatable: true,
    price: swept(100, 500),
    capital: swept(0, 100),
    hours: fixed(0),
    daysToCash: swept(3, 15),
    close: swept(0.05, 0.25),
    respond: swept(0.005, 0.03),
    directCost: swept(0, 50),
    volume: swept(10, 200),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...rest,
  };
}

interface Limits { remaining: number; daysLeft: number; capitalCeiling: number; beforeProof: number; perWeek: number; resources: string }

function portfolioOf(limits: Limits, openings: PlannedOpening[], seed = 7, worlds = 1000) {
  return evaluateGoalPortfolio({ ...limits, openings, worlds, seed });
}

async function planOf(limits: Limits, openings: PlannedOpening[], seed = 7, worlds = 600): Promise<{ baseline: ReturnType<typeof evaluateGoalPortfolio>; r: Reconstruction; ms: number }> {
  const t = performance.now();
  const portfolio = { ...limits, worlds, seed };
  const baseline = evaluateGoalPortfolio({ ...portfolio, openings });
  const r = await reconstructPlan({ openings, portfolio, baseline, required: 0.9, explore: null });
  return { baseline, r, ms: Math.round(performance.now() - t) };
}

function strategiesConsidered(r: Reconstruction): number {
  return r.rounds.reduce((n, one) => n + one.tried.length, 0);
}

/** A reconstructed reading names its members by (truncated) title; map them back to opening ids. */
function memberIds(members: readonly string[], openings: readonly PlannedOpening[]): string[] {
  return [...new Set(members.map((m) => openings.find((o) => o.opportunity.id === m || o.opportunity.title.startsWith(m) || m.startsWith(o.opportunity.title))?.opportunity.id ?? m))];
}

function verdictOf(p: ReturnType<typeof evaluateGoalPortfolio>, missing: (id: string) => string[] = () => []) {
  const ids = [...new Set((p.best?.members ?? []).map((m) => m.opportunityId))];
  return judgeAcceptance({ achieved: false, chosen: null, portfolio: p, measuredChance: null, considered: ids.map((id) => ({ opportunityId: id, missing: missing(id) as never })) });
}

/** A conversion rate reconstructed from comparable populations (§79), exported exactly as the goal model's inference exports it. */
function comparableRate(key: string, obs: Array<Observation['value']>, now = new Date('2026-11-14T00:00:00Z')) {
  const node: QuantityNode = {
    key,
    label: key,
    unit: 'share',
    kind: 'RATE',
    min: 0,
    max: 1,
    context: { opportunity: 'target', mechanism: 'SERVICE_FEE', industry: 'dental' },
    material: ['mechanism'],
    freshDays: 1095,
    observations: obs.map((value, i) => ({
      id: `${key}-src${i}`,
      value,
      context: { opportunity: `other${i}`, mechanism: 'SERVICE_FEE', industry: `industry${i}` },
      lineage: [`url:publisher${i}.example/study`],
      source: { kind: 'CLAIM' as const, ref: `claim-${key}-${i}` },
      observedAt: '2026-06-01T00:00:00Z',
    })),
  };
  const est = reconstruct({ nodes: [node] }, key, now).estimates[key]!;
  // The production conversion, not a copy of it (a copy dropped the sample the assurance reads).
  const input: ModelInput = estimateInput(est);
  return { input, est };
}

/* ================================================================== */
/* Pure cases                                                          */
/* ================================================================== */

describe('E — unusual payment structure: deposit at signing + milestone payment', () => {
  // A $20,000 equipment-integration contract: 30% deposit at signing (day 3),
  // 40% at the day-20 commissioning milestone, 30% balance net 30 after final
  // acceptance (~day 100). Goal: $10,000 settled in 45 days. One signed buyer
  // pays $14,000 inside the window, so the goal is reachable on one deal; the
  // $6,000 balance is not.
  const limits: Limits = { remaining: 10_000, daysLeft: 45, capitalCeiling: 0, beforeProof: 0, perWeek: 0, resources: '40 emails a day from two warmed mailboxes' };
  const terms = '30% deposit at signing, 40% on the commissioning milestone at day 20, 30% balance net 30 after final acceptance';
  const contract = (over: Partial<PlannedOpening> = {}) =>
    opening('o_integration', 'Grain-dryer controls integration for a farm co-op', 1, {
      repeatable: false,
      paymentTerms: terms,
      price: fixed(20_000, 'signed contract price'),
      capital: fixed(0),
      directCost: fixed(2_000, 'subcontractor quote'),
      daysToCash: fixed(100, 'final balance after acceptance'),
      close: fixed(1, 'contract signed'),
      respond: fixed(1, 'contract signed'),
      volume: fixed(1, 'one contract'),
      agreed: true,
      agreedValue: 20_000,
      agreedDeals: 1,
      deposit: { low: 0.3, high: 0.3, days: 3 },
      ...over,
    });

  it('counts deposit and milestone cash inside the window, and not the balance', async () => {
    const e = evaluation('E');
    const p = portfolioOf(limits, [contract()]);
    const v = verdictOf(p);
    e.measure({ verdict: v.status, reach: round(p.best?.reach ?? 0), strategies: p.searched, mechanisms: 1, settledP50: p.best?.settledP50 ?? null, basis: p.basis, refused: p.demand[0]?.refused ?? null, missing: p.missing.slice(0, 3) });
    await e.check('E1 milestone tranche counted: reach >= 0.9 ($14K of $20K settles by day 20)', () => expect(p.best?.reach ?? 0).toBeGreaterThanOrEqual(0.9));
    await e.check('E2 balance after the deadline is not counted: settledP50 <= $14,000', () => expect(p.best?.settledP50 ?? 0).toBeLessThanOrEqual(14_000 + 1));
    await e.check('E3 settled cash inside window >= $14,000 (deposit + milestone)', () => expect(p.best?.settledP50 ?? 0).toBeGreaterThanOrEqual(14_000 - 1));
    // Control: the deposit alone ($6,000) cannot reach $10,000.
    const depositOnly = portfolioOf(limits, [contract({ opportunity: { ...contract().opportunity, paymentTerms: '30% deposit at signing, 70% balance net 30 after final acceptance' } as never })]);
    e.measure({ depositOnlyReach: round(depositOnly.best?.reach ?? 0) });
    await e.check('E4 control: deposit-only terms do not reach $10K (reach < 0.5)', () => expect(depositOnly.best?.reach ?? 0).toBeLessThan(0.5));
    e.done();
  }, 120_000);
});

describe('H — a goal needing several simultaneous revenue streams', () => {
  // $30,000 in 30 days. Three evidenced streams, each capped by its published
  // market: 20 deals at $1,000, 15 at $1,200, 25 at $600. No single stream can
  // pay $30,000; any two together nearly can, all three comfortably.
  const limits: Limits = { remaining: 30_000, daysLeft: 30, capitalCeiling: 5_000, beforeProof: 2_000, perWeek: 2_000, resources: '150 emails a day from five warmed mailboxes' };
  const common = { capital: fixed(0), directCost: fixed(50), close: evidenced(0.3, 0.45, 'comparable close'), respond: evidenced(0.08, 0.12, 'comparable reply'), daysToCash: evidenced(3, 8, 'published terms') };
  const openings = [
    opening('o_bookkeeping', 'Month-end bookkeeping catch-up for landscapers', 1, { ...common, mechanism: 'PRODUCTIZED_SERVICE', price: fixed(1_000), volume: fixed(20, 'association directory, 20 firms') }),
    opening('o_permits', 'Permit-application packets for solar installers', 2, { ...common, mechanism: 'CAPABILITY_ARBITRAGE', price: fixed(1_200), volume: fixed(15, 'state register, 15 installers') }),
    opening('o_menu', 'Allergen menu relabelling for restaurant groups', 3, { ...common, mechanism: 'SUBCONTRACTED_FULFILMENT', price: fixed(600), volume: fixed(25, 'chamber list, 25 groups') }),
  ];

  it('combines streams: the portfolio beats any single strategy', async () => {
    const e = evaluation('H');
    const p = portfolioOf(limits, openings);
    const singles = openings.map((o) => ({ id: o.opportunity.id, reach: portfolioOf(limits, [o]).best?.reach ?? 0 }));
    const members = [...new Set((p.best?.members ?? []).map((m) => m.opportunityId))];
    const mechanisms = new Set(openings.filter((o) => members.includes(o.opportunity.id)).map((o) => (o.opportunity as unknown as { mechanism: string }).mechanism));
    e.measure({ verdict: verdictOf(p).status, reach: round(p.best?.reach ?? 0), strategies: p.searched, mechanisms: mechanisms.size, members, singleReach: singles, settledP50: p.best?.settledP50 ?? null, settledP10: p.best?.settledP10 ?? null, overSpend: p.best?.overSpend ?? null, capitalShort: p.best?.capitalShort ?? null });
    await e.check('H1 best combination has >= 2 simultaneous streams', () => expect(members.length).toBeGreaterThanOrEqual(2));
    await e.check('H2 portfolio reach > every single stream reach', () => expect(p.best?.reach ?? 0).toBeGreaterThan(Math.max(...singles.map((s) => s.reach))));
    await e.check('H3 no single stream reaches the goal (reach < 0.05 each)', () => expect(Math.max(...singles.map((s) => s.reach))).toBeLessThan(0.05));
    await e.check('H4 portfolio reach >= 0.5', () => expect(p.best?.reach ?? 0).toBeGreaterThanOrEqual(0.5));
    e.done();
  }, 120_000);
});

describe('I — capital restructuring: presale beats self-funding under a capital ceiling', () => {
  // Refurbished-pallet-racking resale to warehouses: buy at $1,400, sell at
  // $2,200, cash 20 days after purchase. Ceiling $1,500 — one unit at a time if
  // self-funded (~3 turns, ~$2.4K margin). Buyers of racking routinely pay a
  // deposit or prepay at order; with the buyer's money funding the purchase the
  // ceiling stops binding.
  const limits: Limits = { remaining: 12_000, daysLeft: 60, capitalCeiling: 1_500, beforeProof: 1_500, perWeek: 1_500, resources: '60 emails a day; up to $1,500 of my own money' };
  const racking = opening('o_racking', 'Refurbished pallet racking resold to 3PL warehouses', 1, {
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    paymentTerms: 'buyers commonly pay 50% at order, balance on delivery',
    price: fixed(2_200),
    directCost: fixed(1_400, 'dealer liquidation price'),
    capital: fixed(1_400, 'unit bought before resale'),
    daysToCash: evidenced(15, 25, 'freight and install lead time'),
    close: evidenced(0.15, 0.3, 'comparable close'),
    respond: evidenced(0.03, 0.06, 'comparable reply'),
    volume: fixed(60, 'published count of 3PL sites in the region'),
  });

  it('chooses a prepaid / presale structure over self-funded purchasing', async () => {
    const e = evaluation('I');
    const { baseline, r, ms } = await planOf(limits, [racking]);
    const restructured = r.best.changes.filter((c) => ['CAPITAL', 'CASH_TIMING', 'TRANSACTION'].includes(c.dimension) && /prepa|pre-?sale|deposit|buyer.?s money|funded by|up-?front|at order/i.test(`${c.label} ${c.detail} ${c.op ?? ''}`));
    e.measure({ verdict: verdictOf(baseline).status, reach: round(r.best.reach), strategies: strategiesConsidered(r), mechanisms: 1, baselineReach: round(baseline.best?.reach ?? 0), committed: r.best.committed, changes: r.best.changes.map((c) => `${c.dimension}:${c.label}`), planMs: ms });
    await e.check('I1 self-funded baseline is capital-bound (reach < 0.3)', () => expect(baseline.best?.reach ?? 0).toBeLessThan(0.3));
    await e.check('I2 the chosen plan restructures capital (prepaid/deposit/presale)', () => expect(restructured.length).toBeGreaterThan(0));
    await e.check('I3 restructured plan reach exceeds self-funded by >= 0.2', () => expect(r.best.reach - (baseline.best?.reach ?? 0)).toBeGreaterThanOrEqual(0.2));
    await e.check('I4 committed capital stays within the $1,500 ceiling', () => expect(r.best.committed).toBeLessThanOrEqual(1_500 + 1e-6));
    e.done();
  }, 240_000);
});

describe('J — insufficient evidence: a plan with stated uncertainty, never certified', () => {
  // Mobile bike-repair for corporate campuses: nothing measured, every input a sweep.
  const limits: Limits = { remaining: 8_000, daysLeft: 30, capitalCeiling: 500, beforeProof: 200, perWeek: 100, resources: '50 emails a day' };
  const openings = [
    opening('o_bike', 'On-site bike tune-up days for corporate campuses', 1, { price: swept(400, 1_500), close: swept(0.02, 0.4), respond: swept(0.002, 0.08), volume: swept(1, 150), daysToCash: swept(5, 45) }),
    opening('o_ebike', 'E-bike fleet maintenance contracts for couriers', 2, { price: swept(300, 2_500), close: swept(0.02, 0.4), respond: swept(0.002, 0.08), volume: swept(1, 80), daysToCash: swept(10, 60) }),
  ];

  it('constructs a plan, states what is assumed, and does not certify it', async () => {
    const e = evaluation('J');
    const { baseline, r, ms } = await planOf(limits, openings);
    const v = verdictOf(baseline, () => ['CONVERSION', 'MARKET_VOLUME']);
    e.measure({ verdict: v.status, reach: round(r.best.reach), strategies: strategiesConsidered(r), mechanisms: 1, basis: r.confidence.basis, assumed: r.confidence.assumed.length, planMs: ms, assurance: baseline.assurance?.status ?? null });
    await e.check('J1 a plan is constructed (members non-empty)', () => expect(r.best.members.length).toBeGreaterThan(0));
    await e.check('J2 reach basis is COVERAGE, not probability', () => expect(r.confidence.basis).toBe('COVERAGE'));
    await e.check('J3 the uncertainty is stated (assumed inputs listed)', () => expect(r.confidence.assumed.length).toBeGreaterThan(0));
    await e.check('J4 not certified: acceptance is not ACCEPTED', () => expect(v.status).not.toBe('ACCEPTED'));
    await e.check('J5 a candidate is still named for pursuit (CANDIDATE_ONLY)', () => expect(v.status).toBe('CANDIDATE_ONLY'));
    await e.check('J6 engine assurance does not claim 90%', () => expect(baseline.assurance?.claimsAtLeast90 ?? false).toBe(false));
    e.done();
  }, 240_000);
});

describe('K — economically infeasible goal: $1M in 48 hours with $0', () => {
  const limits: Limits = { remaining: 1_000_000, daysLeft: 2, capitalCeiling: 0, beforeProof: 0, perWeek: 0, resources: 'No money, 30 emails a day.' };
  const openings = [
    opening('o_consult', 'One-day operations consulting engagement', 1, { price: swept(1_000, 5_000), capital: fixed(0), directCost: fixed(0), daysToCash: swept(7, 30), volume: swept(1, 20) }),
    opening('o_templates', 'Spreadsheet templates on a marketplace', 2, { price: swept(9, 49), capital: fixed(0), directCost: fixed(0), daysToCash: swept(0, 2), volume: swept(0, 40) }),
  ];

  it('reports infeasibility with the binding constraint named', async () => {
    const e = evaluation('K');
    const { baseline, r, ms } = await planOf(limits, openings);
    const v = verdictOf(baseline);
    const s = requiredStructures({ remaining: limits.remaining, daysLeft: limits.daysLeft, currency: 'USD', perArrangement: 0, spendCeiling: 0, outreachPerDay: { low: 10, high: 30, stated: true } });
    e.measure({ verdict: v.status, reach: round(r.best.reach), strategies: strategiesConsidered(r), mechanisms: 1, structural: r.structural, limitation: r.limitation, planMs: ms });
    await e.check('K1 reach < 0.01', () => expect(r.best.reach).toBeLessThan(0.01));
    await e.check('K2 reported as structurally infeasible', () => expect(r.structural).toBe(true));
    await e.check('K3 the binding constraint is named (time/capital/market)', () => expect(r.limitation ?? '').toMatch(/deadline|days?|hours|time|capital|market|volume|capacity/i));
    await e.check('K4 never ACCEPTED', () => expect(v.status).not.toBe('ACCEPTED'));
    await e.check('K5 every non-instant structure is IMPOSSIBLE by arithmetic', () => expect(s.structures.filter((x) => x.kind !== 'INSTANT').every((x) => x.verdict === 'IMPOSSIBLE')).toBe(true));
    await e.check('K6 even instant sales need a $1M/48h inbound volume the openings cannot hold (settledP90 < 1% of target)', () => expect(r.best.settledP90).toBeLessThan(10_000));
    e.done();
  }, 240_000);
});

describe('L — contradictory sources: the contradiction is surfaced, not averaged', () => {
  // What a grain co-op pays a season for combine-harvester rental, about the
  // same population: one source (a co-op survey) says $8,000; another (an
  // extension-office budget) says $45,000 for the same thing.
  it('reports the disagreement and keeps both ends in the interval', async () => {
    const e = evaluation('L');
    const node: QuantityNode = {
      key: 'season_rent',
      label: 'combine rental paid per season by a grain co-op',
      unit: 'USD',
      kind: 'POSITIVE',
      min: 0,
      max: 1_000_000,
      context: { payer: 'grain co-ops', industry: 'agricultural equipment rental' },
      material: ['payer'],
      freshDays: 1095,
      observations: [
        { id: 'survey', value: { kind: 'POINT', value: 8_000, sampleSize: 60 }, context: { payer: 'grain co-ops', industry: 'agricultural equipment rental' }, lineage: ['url:coop-survey.example/2026'], source: { kind: 'CLAIM', ref: 'clm_survey' }, observedAt: '2026-05-01T00:00:00Z', measures: 'season rental, co-op member survey' },
        { id: 'extension', value: { kind: 'POINT', value: 45_000, sampleSize: 40 }, context: { payer: 'grain co-ops', industry: 'agricultural equipment rental' }, lineage: ['url:extension.example/budget'], source: { kind: 'CLAIM', ref: 'clm_extension' }, observedAt: '2026-04-01T00:00:00Z', measures: 'season rental, extension custom-rate budget' },
      ],
    };
    const est = reconstruct({ nodes: [node] }, 'season_rent', new Date('2026-11-14T00:00:00Z')).estimates['season_rent']!;
    const surfaced = JSON.stringify({ trace: est.trace, excluded: est.excluded, extra: Object.fromEntries(Object.entries(est).filter(([k]) => /contradict|conflict|disagree/i.test(k))) });
    e.measure({ verdict: est.tier, reach: null, strategies: null, mechanisms: null, p10: round(est.p10, 0), p50: round(est.p50, 0), p90: round(est.p90, 0), heterogeneity: round(est.heterogeneity), distributionJustified: est.distributionJustified });
    await e.check('L1 the contradiction is surfaced (trace/excluded/field names it)', () => expect(surfaced).toMatch(/contradict|conflict|disagree|inconsisten/i));
    await e.check('L2 not silently averaged: interval spans both sources (p10 <= 8,800 and p90 >= 40,500)', () => {
      expect(est.p10).toBeLessThanOrEqual(8_800);
      expect(est.p90).toBeGreaterThanOrEqual(40_500);
    });
    await e.check('L3 a contradicted figure is not exported as a confident distribution', () => expect(est.distributionJustified).toBe(false));
    e.done();
  });
});

describe('M/N — the obvious strategy is inferior to a less obvious combination', () => {
  // Obvious: one $15,000 fleet-telematics install, close 30%, paid net 60 after
  // install — most of its money lands after the 45-day deadline.
  // Less obvious: two small, evidenced, fast-settling lines (driver-file audits
  // and DOT compliance calendars for the same fleets) that together carry $15K.
  const limits: Limits = { remaining: 15_000, daysLeft: 45, capitalCeiling: 1_000, beforeProof: 300, perWeek: 300, resources: '120 emails a day from four warmed mailboxes' };
  const obvious = opening('o_telematics', 'Fleet telematics installation (one large contract)', 1, {
    mechanism: 'SUBCONTRACTED_FULFILMENT', repeatable: false, price: fixed(15_000), directCost: fixed(6_000), capital: fixed(0),
    daysToCash: evidenced(50, 90, 'net 60 after install'), close: evidenced(0.25, 0.35, 'comparable close'), respond: evidenced(0.05, 0.1, 'comparable reply'), volume: fixed(1),
  });
  const audits = opening('o_audits', 'Driver qualification file audits for small fleets', 2, {
    mechanism: 'PRODUCTIZED_SERVICE', price: fixed(450), directCost: fixed(20), capital: fixed(0), daysToCash: evidenced(2, 7, 'card at order'),
    close: evidenced(0.25, 0.4, 'comparable close'), respond: evidenced(0.06, 0.1, 'comparable reply'), volume: fixed(40, 'FMCSA census, carriers in region'),
  });
  const calendars = opening('o_calendars', 'DOT compliance calendars (annual) for the same fleets', 3, {
    mechanism: 'CAPABILITY_ARBITRAGE', price: fixed(300), directCost: fixed(5), capital: fixed(0), daysToCash: evidenced(1, 5, 'card at order'),
    close: evidenced(0.3, 0.45, 'comparable close'), respond: evidenced(0.06, 0.1, 'comparable reply'), volume: fixed(30, 'FMCSA census, carriers in region'),
  });

  it('M: the portfolio engine chooses the combination over the obvious large deal', async () => {
    const e = evaluation('M');
    const p = portfolioOf(limits, [obvious, audits, calendars]);
    const alone = portfolioOf(limits, [obvious]).best?.reach ?? 0;
    const members = [...new Set((p.best?.members ?? []).map((m) => m.opportunityId))];
    e.measure({ verdict: verdictOf(p).status, reach: round(p.best?.reach ?? 0), strategies: p.searched, mechanisms: members.length, members, obviousAloneReach: round(alone) });
    await e.check('M1 chosen combination contains both less-obvious lines', () => expect(members).toEqual(expect.arrayContaining(['o_audits', 'o_calendars'])));
    await e.check('M2 chosen reach > the obvious strategy alone', () => expect(p.best?.reach ?? 0).toBeGreaterThan(alone));
    await e.check('M3 the obvious deal alone reaches < 0.25 (cash lands after deadline)', () => expect(alone).toBeLessThan(0.25));
    e.done();
  }, 120_000);

  it('N: strategy reconstruction keeps the combination as the plan', async () => {
    const e = evaluation('N');
    const { baseline, r, ms } = await planOf(limits, [obvious, audits, calendars]);
    const ids = memberIds(r.best.members, [obvious, audits, calendars]);
    e.measure({ verdict: verdictOf(baseline).status, reach: round(r.best.reach), strategies: strategiesConsidered(r), mechanisms: ids.length, members: ids, planMs: ms });
    await e.check('N1 reconstructed plan members include both less-obvious lines', () => expect(ids).toEqual(expect.arrayContaining(['o_audits', 'o_calendars'])));
    await e.check('N2 reconstructed plan is not the obvious deal alone', () => expect(ids.length === 1 && ids[0] === 'o_telematics').toBe(false));
    await e.check('N3 reconstructed reach >= 0.5', () => expect(r.best.reach).toBeGreaterThanOrEqual(0.5));
    e.done();
  }, 240_000);
});

describe('O — comparables but no Brain operating history', () => {
  const limits = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '100 emails a day from three warmed mailboxes' };
  const target = (over: Partial<PlannedOpening>) =>
    opening('cop_target', 'Recall-reminder service for independent dental practices', 1, {
      price: fixed(1_500), capital: fixed(60), hours: fixed(2), daysToCash: fixed(3), directCost: fixed(10), ...over,
    });
  const volumeEvidenced = (n: number): ModelInput => ({ ...fixed(n), value: null, distribution: { kind: 'EMPIRICAL', values: Array(101).fill(n) }, inferred: { tier: 'DIRECT', justified: true, p10: n, p50: n, p90: n, observations: 600 } });

  it('three sized comparables enter as evidence with an interval; a stronger variant certifies; unsized never does', async () => {
    const e = evaluation('O');
    // 1. Three independent sized comparables: 40/200, 46/200, 36/200 closed.
    const close = comparableRate('close', [{ kind: 'COUNT', successes: 40, trials: 200 }, { kind: 'COUNT', successes: 46, trials: 200 }, { kind: 'COUNT', successes: 36, trials: 200 }]);
    const respond = comparableRate('respond', [{ kind: 'COUNT', successes: 40, trials: 200 }, { kind: 'COUNT', successes: 44, trials: 200 }, { kind: 'COUNT', successes: 38, trials: 200 }]);
    const one = target({ close: close.input, respond: respond.input, volume: volumeEvidenced(500) });
    const p = evaluateGoalPortfolio({ ...limits, openings: [one], worlds: 2000, seed: 7 });
    const v = verdictOf(p);
    const unest = p.demand[0]?.unestablished ?? [];

    // 2. A stronger evidenced variant: the same three populations measured at 10× the sample.
    const closeS = comparableRate('close_strong', [{ kind: 'COUNT', successes: 400, trials: 2000 }, { kind: 'COUNT', successes: 460, trials: 2000 }, { kind: 'COUNT', successes: 360, trials: 2000 }]);
    const respondS = comparableRate('respond_strong', [{ kind: 'COUNT', successes: 400, trials: 2000 }, { kind: 'COUNT', successes: 440, trials: 2000 }, { kind: 'COUNT', successes: 380, trials: 2000 }]);
    const strong = target({ close: closeS.input, respond: respondS.input, volume: volumeEvidenced(500) });
    const ps = evaluateGoalPortfolio({ ...limits, openings: [strong], worlds: 2000, seed: 7 });
    const vs = verdictOf(ps);

    // 3. Unsized-only evidence: the same rates, published without a sample.
    const closeU = comparableRate('close_unsized', [{ kind: 'POINT', value: 0.2 }, { kind: 'POINT', value: 0.23 }, { kind: 'POINT', value: 0.18 }]);
    const respondU = comparableRate('respond_unsized', [{ kind: 'POINT', value: 0.2 }, { kind: 'POINT', value: 0.22 }, { kind: 'POINT', value: 0.19 }]);
    const unsized = target({ close: closeU.input, respond: respondU.input, volume: volumeEvidenced(500) });
    const pu = evaluateGoalPortfolio({ ...limits, openings: [unsized], worlds: 2000, seed: 7 });
    const vu = verdictOf(pu);

    e.measure({
      verdict: v.status, reach: round(p.best?.reach ?? 0), strategies: p.searched, mechanisms: 1,
      closeTier: close.est.tier, closeP10: round(close.est.p10), closeP90: round(close.est.p90), basis: p.basis, assurance: p.assurance?.status ?? null, range: p.assurance?.range ?? null,
      strongVerdict: vs.status, strongBasis: vs.probability?.basis ?? null, strongAssurance: ps.assurance?.status ?? null, strongReach: round(ps.best?.reach ?? 0),
      unsizedVerdict: vu.status, unsizedAssurance: pu.assurance?.status ?? null, unsizedTier: closeU.est.tier,
    });
    await e.check('O1 conversion estimate is COMPARABLE evidence, not ASSUMED', () => {
      expect(close.est.tier).toBe('COMPARABLE');
      expect(close.input.provenance).toBe('EVIDENCE');
    });
    await e.check('O2 the plan treats close as established (not in unestablished)', () => expect(unest.join(' ')).not.toMatch(/close/i));
    await e.check('O3 plan is constructed with a probability basis', () => {
      expect(p.best).not.toBeNull();
      expect(p.basis).toBe('PROBABILITY');
    });
    await e.check('O4 plan carries a defensible interval (assurance range, not CALIBRATION_UNAVAILABLE)', () => {
      expect(p.assurance?.status).not.toBe('CALIBRATION_UNAVAILABLE');
      expect(p.assurance?.range).not.toBeNull();
    });
    await e.check('O5 stronger evidenced variant is certified ACCEPTED at 90% (EVIDENCED_PORTFOLIO)', () => {
      expect(vs.status).toBe('ACCEPTED');
      expect(vs.probability?.basis).toBe('EVIDENCED_PORTFOLIO');
    });
    await e.check('O6 unsized-only evidence is never certified', () => {
      expect(vu.status).not.toBe('ACCEPTED');
      expect(pu.assurance?.claimsAtLeast90 ?? false).toBe(false);
    });
    e.done();
  }, 120_000);
});

describe('Selection — a strong DIRECT arrangement among 30 ordinary ones is kept regardless of its key', () => {
  function arrangement(key: string, over: Partial<ConstructedArrangement> & { p50: number; tier?: string; observations?: number; repeat?: 'ONE_OFF' | 'RECURRING_COHORT' | 'SUBSCRIPTION' }): ConstructedArrangement {
    const { p50, tier = 'MECHANISM', observations = 3, repeat = 'RECURRING_COHORT', ...rest } = over;
    return {
      key,
      structure: 'BROKER',
      design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat },
      origin: 'FORWARD',
      precedent: null,
      sector: 'property services',
      demand: { name: `buyers ${key}`, claimId: null, from: 'INDUSTRY_MAP', ref: `ind_${key}` },
      need: null,
      supply: null,
      label: `Broker work for population ${key}`,
      properties: [],
      targetsMet: [],
      emergent: [],
      stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
      evidenced: 1,
      value: { tier, p10: p50 / 3, p50, p90: p50 * 3, observations },
      unknownParts: ['buyers', 'conversion'],
      relatedOpenings: [],
      question: `Who buys brokered work for ${key}?`,
      ...rest,
    } as unknown as ConstructedArrangement;
  }
  const ordinary = Array.from({ length: 30 }, (_, i) => arrangement(`ord${String(i).padStart(2, '0')}`, { p50: 300 }));
  const strongWith = (key: string) => arrangement(key, { p50: 3_000, tier: 'DIRECT', observations: 20, repeat: 'SUBSCRIPTION', evidenced: 3 } as never);

  it('keeps the strong arrangement whatever its key string', async () => {
    const e = evaluation('SEL');
    const keys = ['aa-strong', 'zz-strong', 'ffffffffffff', '000000000000', 'strong-3', '9c1e5b7a2d40'];
    const kept: Record<string, boolean> = {};
    for (const key of keys) {
      const picked = pickEstimatedArrangements([...ordinary, strongWith(key)], { projectId: 'prj_eval', currency: 'USD', beforeProofCents: 37_500, remaining: 10_000, exclusions: [] });
      kept[key] = picked.some((one) => one.estimated?.arrangementKey === key);
    }
    // And a strong DIRECT one-off worth most of the goal.
    const oneOff = arrangement('mm-oneoff', { p50: 9_000, tier: 'DIRECT', observations: 20, repeat: 'ONE_OFF' });
    const pickedOneOff = pickEstimatedArrangements([...ordinary, oneOff], { projectId: 'prj_eval', currency: 'USD', beforeProofCents: 900_000, remaining: 10_000, exclusions: [] });
    const oneOffKept = pickedOneOff.some((one) => one.estimated?.arrangementKey === 'mm-oneoff');
    e.measure({ verdict: null, reach: null, strategies: 31, mechanisms: null, kept, oneOffKept });
    for (const key of keys) await e.check(`SEL key "${key}" kept`, () => expect(kept[key]).toBe(true));
    await e.check('SEL strong DIRECT $9K one-off kept over $300 MECHANISM designs', () => expect(oneOffKept).toBe(true));
    e.done();
  });
});

describe('Goals of different sizes', () => {
  const sizes: Array<{ id: string; limits: Limits; openings: PlannedOpening[]; measured?: typeof GOAL_10K_RECORD; extra: (r: Reconstruction, o: PlannedOpening[], lim: Limits) => Array<[string, () => void]> }> = [
    {
      id: 'SIZE-100-48h',
      limits: { remaining: 100, daysLeft: 2, capitalCeiling: 0, beforeProof: 0, perWeek: 0, resources: 'No money to spend.' },
      openings: [
        opening('o_templates', 'Spreadsheet templates sold on a marketplace listing', 1, { mechanism: 'PRODUCTIZED_SERVICE', price: swept(9, 29), directCost: fixed(0), capital: fixed(0), daysToCash: swept(0, 2), volume: swept(0, 15), close: swept(0.02, 0.1) }),
        opening('o_gig', 'Posted data-cleanup gig', 2, { mechanism: 'CAPABILITY_ARBITRAGE', repeatable: false, price: swept(40, 120), capital: fixed(0), directCost: fixed(0), daysToCash: swept(1, 7), volume: swept(1, 1), close: swept(0.1, 0.4) }),
      ],
      extra: (r) => [['spends nothing', () => expect(r.best.committed).toBeLessThanOrEqual(1e-6)], ['a plan is constructed (reach > 0)', () => expect(r.best.reach).toBeGreaterThan(0)]],
    },
    {
      id: 'SIZE-10K-30d',
      limits: GOAL_10K_LIMITS,
      openings: GOAL_10K_OPENINGS,
      measured: GOAL_10K_RECORD,
      extra: (r) => [
        ['committed <= $3K', () => expect(r.best.committed).toBeLessThanOrEqual(3_000)],
        ['settledP50 < $100K (no fantasy median)', () => expect(r.best.settledP50).toBeLessThan(100_000)],
      ],
    },
    {
      id: 'SIZE-100K-90d',
      limits: { remaining: 100_000, daysLeft: 90, capitalCeiling: 10_000, beforeProof: 1_000, perWeek: 2_500, resources: 'Up to $10,000; 200 emails a day.' },
      openings: [
        opening('o_crm', 'CRM implementation for 20–50 person firms', 1, { mechanism: 'PRODUCTIZED_SERVICE', price: swept(4000, 12000), directCost: swept(1500, 5000), close: swept(0.03, 0.15), daysToCash: swept(14, 45), volume: swept(10, 300) }),
        opening('o_audit', 'Fixed-price workflow audit', 2, { mechanism: 'CAPABILITY_ARBITRAGE', price: swept(1500, 3000), directCost: swept(200, 600), close: swept(0.05, 0.2), daysToCash: swept(7, 21), volume: swept(20, 400) }),
        opening('o_support', 'Monthly admin support retainer', 3, { mechanism: 'SUBCONTRACTED_FULFILMENT', price: swept(800, 2000), directCost: swept(300, 900), close: swept(0.04, 0.15), daysToCash: swept(30, 30), volume: swept(10, 150) }),
      ],
      extra: (r, _o, lim) => [
        ['committed <= ceiling', () => expect(r.best.committed).toBeLessThanOrEqual(lim.capitalCeiling + 1e-6)],
      ],
    },
    {
      id: 'SIZE-1M-1y',
      limits: { remaining: 1_000_000, daysLeft: 365, capitalCeiling: 50_000, beforeProof: 5_000, perWeek: 10_000, resources: 'Up to $50,000; 300 emails a day.' },
      openings: [
        opening('o_wholesale', 'Restaurant supply wholesale route', 1, { mechanism: 'SUPPLY_DEMAND_MISMATCH', price: swept(2000, 6000), directCost: swept(1500, 4800), capital: swept(1500, 4800), close: swept(0.05, 0.25), daysToCash: swept(15, 45), volume: swept(50, 1500) }),
        opening('o_private', 'Private-label cleaning products to janitorial firms', 2, { mechanism: 'JIGSAW_COMBINATION', price: swept(3000, 9000), directCost: swept(1800, 6000), capital: swept(1800, 6000), close: swept(0.03, 0.12), daysToCash: swept(30, 60), volume: swept(30, 800) }),
        opening('o_saas', 'Inventory-count software subscription for distributors', 3, { mechanism: 'PRODUCTIZED_SERVICE', price: swept(200, 600), directCost: swept(5, 40), capital: fixed(0), close: swept(0.02, 0.1), daysToCash: swept(1, 30), volume: swept(100, 3000) }),
      ],
      extra: (r, _o, lim) => [
        ['committed <= ceiling', () => expect(r.best.committed).toBeLessThanOrEqual(lim.capitalCeiling + 1e-6)],
      ],
    },
  ];

  for (const s of sizes) {
    it(s.id, async () => {
      const e = evaluation(s.id);
      const t = performance.now();
      const portfolio = { ...s.limits, ...(s.measured ? { measuredRates: s.measured } : {}), worlds: 600, seed: 11 };
      const baseline = evaluateGoalPortfolio({ ...portfolio, openings: s.openings });
      const r = await reconstructPlan({ openings: s.openings, portfolio, baseline, required: 0.9, explore: null });
      const ms = Math.round(performance.now() - t);
      const v = verdictOf(baseline, () => ['CONVERSION']);
      const ids = memberIds(r.best.members, s.openings);
      const mechanisms = new Set(s.openings.filter((o) => ids.includes(o.opportunity.id)).map((o) => (o.opportunity as unknown as { mechanism?: string }).mechanism ?? o.opportunity.id));
      e.measure({ verdict: `${v.status}${r.structural ? '/STRUCTURAL' : ''}`, reach: round(r.best.reach), strategies: strategiesConsidered(r), mechanisms: mechanisms.size, settledP50: Math.round(r.best.settledP50), committed: r.best.committed, members: ids, basis: r.confidence.basis, asHeldReach: round(baseline.best?.reach ?? 0), planMs: ms });
      await e.check('reconstruction is never worse than the plan as held', () => expect(r.best.reach).toBeGreaterThanOrEqual((baseline.best?.reach ?? 0) - 0.02));
      await e.check('basis is COVERAGE when any change is assumed', () => {
        if (r.best.changes.some((c) => c.basis === 'ASSUMPTION')) expect(r.confidence.basis).toBe('COVERAGE');
      });
      for (const [name, fn] of s.extra(r, s.openings, s.limits)) await e.check(name, fn);
      e.done();
    }, 300_000);
  }
});

/* ================================================================== */
/* Database cases: the planner over a project's own rows               */
/* ================================================================== */

let projectId = '';
let userId = '';
let cashModeId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

async function freshWorld(): Promise<void> {
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  userId = (await createUser({ email: `ie-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
}

/** Claims accepted at the gate inside an orchestration of their own. */
async function gatedClaims(claims: Array<{ claim: string; lane?: string; sourceUrl: string; signal?: OpportunitySignal }>): Promise<string[]> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a question' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a question', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: ['a forecast'], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: one.claim, evidenceLocator: 'the page', evidenceLane: one.lane ?? SIGNAL_LANE, opportunitySignal: one.signal ?? null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${one.claim}|${one.sourceUrl}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return inserted.map((one) => one.id);
}

/** An industry on the map, each node established by a gated claim. */
async function sector(name: string, parts: { buyer: string; bottleneck: string; supply: string }): Promise<void> {
  const [, buyer, bottleneck, supply] = await gatedClaims([
    { claim: `${name} is a sector.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(name)}` },
    { claim: `${parts.buyer} buy in ${name}.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.buyer)}` },
    { claim: `${parts.bottleneck} is a recurring problem.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.bottleneck)}` },
    { claim: `${parts.supply} serve this.`, lane: 'structure', sourceUrl: `https://example.test/${encodeURIComponent(parts.supply)}` },
  ]);
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: parts.buyer, origin: 'DISCOVERED', sourceClaimId: buyer ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: parts.bottleneck, origin: 'DISCOVERED', sourceClaimId: bottleneck ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: parts.supply, origin: 'DISCOVERED', sourceClaimId: supply ?? null });
}

async function goal(amountCents: number, days = 30, capitalCents: number | null = null): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents, currency: 'USD', projectId, capitalCeilingCents: capitalCents, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

async function heldOpening(input: { title: string; priceCents: number; mechanism?: CashMechanism; payer?: string; industry?: string; volume?: string; signal?: OpportunitySignal; play?: boolean; sourceClaimId?: string; capture?: string; days?: string }) {
  const o = await createOpportunity({
    projectId, cashModeId, ownerUserId: userId, title: input.title, mechanism: input.mechanism ?? 'PRODUCTIZED_SERVICE', currency: 'USD',
    sourceClaimId: input.sourceClaimId ?? `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: input.signal ?? 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
    requiredCapabilities: input.play === false ? [] : ['PRODUCE_SPREADSHEET'],
    ...(input.industry ? { industry: input.industry } : {}),
  } as Parameters<typeof createOpportunity>[0]);
  const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  await fact(CAPTURE_KEY, input.capture ?? 'Sell the work to each buyer.');
  await fact('payer', input.payer ?? 'Property managers');
  await fact('delivery', 'Brain produces it.');
  await updateOpportunity(o.id, { payer: input.payer ?? 'Property managers', price_cents: input.priceCents, offer_scope: input.title, reachable_channel: 'Published emails', buying_signal: 'Posted asking', signal_observed_at: inDays(-2), peak_funding_cents: 0, human_hours: 2, ...(input.industry ? { industry: input.industry } : {}) } as never);
  await fact('price', `$${input.priceCents / 100}`);
  await fact('timeToFirstCash', input.days ?? '7 days');
  await fact('directCosts', '$10');
  if (input.volume) await fact('buyerVolume', input.volume);
  return o;
}

describe('A — an unfamiliar industry: agricultural equipment rental cooperatives', () => {
  beforeEach(freshWorld);

  it('decomposes the industry and constructs an arrangement with a named payer and supplier', async () => {
    const e = evaluation('A');
    await sector('Agricultural equipment rental cooperatives', {
      buyer: 'Grain farms of 500 to 2000 acres',
      bottleneck: 'Combine harvester shortage in the ten-day harvest window',
      supply: 'Equipment dealers with idle demo fleets',
    });
    // One sourced price for this buyer: a co-op published $3,500 for a harvest-week combine rental.
    await heldOpening({ title: 'Harvest-week combine rental for a grain farm', priceCents: 350_000, payer: 'Grain farms of 500 to 2000 acres', industry: 'Agricultural equipment rental cooperatives', mechanism: 'SUPPLY_DEMAND_MISMATCH', play: false, signal: 'PAID_TASK_OR_CONTRACT' });
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 60, now });
    const inIndustry = built.filter((one) => one.origin !== 'REVERSE' && one.sector === 'Agricultural equipment rental cooperatives');
    const named = inIndustry.filter((one) => one.demand?.name && one.supply?.name && one.supply.from !== 'CAPABILITY');
    const picked = pickEstimatedArrangements(built, { projectId, currency: 'USD', beforeProofCents: 300_000, remaining: 25_000, exclusions: [] });
    const pickedIndustry = picked.filter((one) => (one.opportunity as unknown as { industry: string | null }).industry === 'Agricultural equipment rental cooperatives');
    const sample = named[0];
    e.measure({ verdict: null, reach: null, strategies: built.length, mechanisms: new Set(inIndustry.map((one) => one.structure)).size, inIndustry: inIndustry.length, named: named.length, pickedFromIndustry: pickedIndustry.length, sample: sample ? { label: sample.label, payer: sample.demand.name, supplier: sample.supply?.name, tier: sample.value.tier, unknownParts: sample.unknownParts } : null });
    await e.check('A1 at least one arrangement in the new industry', () => expect(inIndustry.length).toBeGreaterThan(0));
    await e.check('A2 an arrangement names payer AND supplier from the map', () => {
      expect(named.length).toBeGreaterThan(0);
      expect(named.some((one) => one.demand.name === 'Grain farms of 500 to 2000 acres' && one.supply!.name === 'Equipment dealers with idle demo fleets')).toBe(true);
    });
    await e.check('A3 the arrangement is decomposed into named parts to establish', () => expect(sample?.unknownParts ?? []).toEqual(expect.arrayContaining(['buyers', 'value'])));
    await e.check('A4 >= 2 distinct capture structures constructed for the industry', () => expect(new Set(inIndustry.map((one) => one.structure)).size).toBeGreaterThanOrEqual(2));
    await e.check('A5 an arrangement from the new industry enters the goal model as an estimate', () => expect(pickedIndustry.length).toBeGreaterThan(0));
    e.done();
  }, 180_000);
});

describe('G — cross-industry transfer of a pooled-purchasing precedent', () => {
  beforeEach(freshWorld);

  it('carries the pooled design to a new buyer population, names the differences, and does not count the precedent as independent evidence', async () => {
    const e = evaluation('G');
    // Precedent: dental group purchasing — practices pool consumables orders; three
    // openings all priced from ONE published study (one lineage).
    const study = 'clm_dental_gpo_study';
    const precedent = await heldOpening({ title: 'Pooled consumables purchasing for independent dental practices', priceCents: 400_000, mechanism: 'JIGSAW_COMBINATION', payer: 'Independent dental practices', industry: 'Dental care', sourceClaimId: study, capture: 'Pool orders across practices and keep a margin on the volume discount.', play: false, signal: 'PAID_TASK_OR_CONTRACT' });
    await heldOpening({ title: 'Pooled glove orders, dental', priceCents: 380_000, mechanism: 'JIGSAW_COMBINATION', payer: 'Independent dental practices', industry: 'Dental care', sourceClaimId: study, play: false, signal: 'PAID_TASK_OR_CONTRACT' });
    await heldOpening({ title: 'Pooled sterilisation pouches, dental', priceCents: 420_000, mechanism: 'JIGSAW_COMBINATION', payer: 'Independent dental practices', industry: 'Dental care', sourceClaimId: study, play: false, signal: 'PAID_TASK_OR_CONTRACT' });
    // A different buyer population on the map, in another industry.
    await sector('Veterinary care', { buyer: 'Independent veterinary clinics', bottleneck: 'High per-unit cost of vaccines and consumables', supply: 'Veterinary distributors offering volume tiers' });
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: 500_000, daysLeft: 60, now });
    const transfers = built.filter((one) => one.origin === 'TRANSFER' && one.structure === 'POOL' && one.demand.name === 'Independent veterinary clinics');
    const t = transfers.find((one) => one.precedent?.opportunityId === precedent.id) ?? transfers[0];
    const text = t ? JSON.stringify(t) : '';
    e.measure({ verdict: null, reach: null, strategies: built.length, mechanisms: new Set(built.map((one) => one.structure)).size, transfers: transfers.length, tier: t?.value.tier ?? null, observations: t?.value.observations ?? null, label: t?.label ?? null });
    await e.check('G1 a TRANSFER of the pooled design to veterinary clinics exists, naming the dental precedent', () => {
      expect(t).toBeDefined();
      expect(t!.precedent?.opportunityId).toBeDefined();
    });
    await e.check('G2 the transfer names material differences between the populations', () =>
      expect(text.replace(/a different buyer/gi, '')).toMatch(/material difference|differences?\s*[:=]|differs? (?:in|on|by)|unlike (?:dental|the precedent)|"differences"/i));
    await e.check('G3 the precedent does not raise the target to DIRECT/COMPARABLE evidence', () => expect(['DIRECT', 'COMPARABLE']).not.toContain(t?.value.tier));
    await e.check('G4 three dental figures from one study count as at most one observation', () => expect(t?.value.observations ?? 0).toBeLessThanOrEqual(1));
    e.done();
  }, 180_000);
});

describe('Q — new evidence changes the best plan', () => {
  beforeEach(freshWorld);

  it('re-reads after a sourced claim lands and changes the chosen strategy', async () => {
    const e = evaluation('Q');
    // A: $250 monthly HOA reserve summaries, market sized by a registry (400 boards, monthly).
    // B: $900 monthly cost-segregation memos for small landlords, market nobody has sized yet.
    // Goal: $6,000 in 30 days. A sourced claim then sizes B's market.
    const a = await heldOpening({ title: 'Monthly reserve-fund summaries for HOA boards', priceCents: 25_000, payer: 'HOA boards', volume: 'The state HOA registry lists 400 boards in the metro; each needs the summary monthly.' });
    const b = await heldOpening({ title: 'Cost-segregation memos for small landlords', priceCents: 90_000, payer: 'Small landlords' });
    const id = await goal(600_000, 30);
    const t1 = performance.now();
    const first = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const ms1 = Math.round(performance.now() - t1);
    // New evidence: B's market is sized — 900 landlords, each buying monthly; B alone can now carry the goal.
    const fact = 'The state landlord association lists 900 small landlords who commission cost-segregation memos; each buys monthly.';
    const [claim] = await gatedClaims([{ claim: fact, lane: 'structure', sourceUrl: 'https://example.test/assessor' }]);
    await recordCardFact({ projectId, opportunityId: b.id, field: 'buyerVolume', kind: 'EVIDENCE', value: fact, claimId: claim!, decidedBy: 'BRAIN' });
    forgetKnowledge();
    const t2 = performance.now();
    const second = (await readGoalPlan({ goalId: id, evaluations: 2_000 }))!;
    const ms2 = Math.round(performance.now() - t2);
    const strategyOf = (r: typeof first) => {
      const c = r.strategies.find((x) => x.key === r.chosen);
      return c ? { key: c.key, ids: c.opportunityIds, verdict: c.verdict, reach: round(c.sweep.goalMetShare) } : null;
    };
    const before = strategyOf(first);
    const after = strategyOf(second);
    const tag = (i: string) => (i === a.id ? 'A' : i === b.id ? 'B' : i);
    e.measure({
      verdict: `${first.verdict}->${second.verdict}`, reach: after?.reach ?? null, bestReachMoney: second.bestReach ?? null, strategies: second.strategies.length, mechanisms: null,
      chosenBefore: before ? { ...before, ids: before.ids.map(tag) } : null, chosenAfter: after ? { ...after, ids: after.ids.map(tag) } : null,
      strategiesBefore: first.strategies.map((x) => `${x.key}:${x.opportunityIds.map(tag).join('+')}:${x.verdict}:${round(x.sweep.goalMetShare)}`),
      strategiesAfter: second.strategies.map((x) => `${x.key}:${x.opportunityIds.map(tag).join('+')}:${x.verdict}:${round(x.sweep.goalMetShare)}`),
      readMs: [ms1, ms2],
    });
    await e.check('Q1 (world check) before the evidence, the chosen plan does not rest on unsized B', () => expect(before?.ids ?? []).not.toContain(b.id));
    await e.check('Q2 after the evidence, the chosen strategy changes', () => expect(JSON.stringify([...(after?.ids ?? [])].sort())).not.toBe(JSON.stringify([...(before?.ids ?? [])].sort())));
    await e.check('Q3 after the evidence, the chosen strategy includes the newly sized B', () => expect(after?.ids ?? []).toContain(b.id));
    await e.check('Q4 after the evidence, B is no longer missing MARKET_VOLUME', () => expect(second.considered.find((c) => c.opportunityId === b.id)?.missing ?? ['?']).not.toContain('MARKET_VOLUME'));
    e.done();
  }, 300_000);
});

describe('Persistence — constructed arrangements survive a restart', () => {
  beforeEach(freshWorld);

  it('keeps constructed arrangements in database rows after in-memory caches are cleared', async () => {
    const e = evaluation('PERSIST');
    await sector('Agricultural equipment rental cooperatives', { buyer: 'Grain farms of 500 to 2000 acres', bottleneck: 'Combine harvester shortage in the ten-day harvest window', supply: 'Equipment dealers with idle demo fleets' });
    await heldOpening({ title: 'Harvest-window logistics sheet', priceCents: 20_000, play: false, signal: 'PAID_TASK_OR_CONTRACT' });
    const id = await goal(2_500_000, 60, 300_000);
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 60, now });
    await readGoalPlan({ goalId: id, evaluations: 1_000 });
    // Simulate a restart: every in-process cache is gone.
    clearConstructionMemo();
    forgetGoalReadings();
    forgetKnowledge();
    const db = getDb();
    let tables: string[] = [];
    try {
      tables = (await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((one) => one.name);
    } catch {
      tables = (await db.all<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`)).map((one) => one.name);
    }
    // Storage may extend an existing owner (the monetization path tables, per the owner's reuse-existing-tables rule) rather than add a table.
    const candidates = tables.filter((one) => (/arrangement|construct/i.test(one) && !/^construction_facts$/.test(one)) || /^monetization_path/.test(one));
    let rowsWithKeys = 0;
    let rows = 0;
    for (const table of candidates) {
      const all = await db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      rows += all.length;
      const blob = JSON.stringify(all);
      rowsWithKeys += built.filter((one) => one.origin !== 'REVERSE' && blob.includes(one.key)).length;
    }
    e.measure({ verdict: null, reach: null, strategies: built.length, mechanisms: new Set(built.map((one) => one.structure)).size, tables: candidates, rows, constructedKeysFound: rowsWithKeys });
    await e.check('P1 a table holds constructed arrangements', () => expect(candidates.length).toBeGreaterThan(0));
    await e.check('P2 rows exist after caches are cleared', () => expect(rows).toBeGreaterThan(0));
    await e.check('P3 the constructed (forward) arrangements are found by key in the rows', () => expect(rowsWithKeys).toBeGreaterThan(0));
    e.done();
  }, 300_000);
});
