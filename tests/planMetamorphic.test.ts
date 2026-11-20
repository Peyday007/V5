/**
 * Metamorphic properties of the commercial planner.
 *
 * Each test changes one thing about a goal or an opening, holds everything
 * else fixed (the seed and the worlds included), and states the direction the
 * planner's answer may move — never the answer itself. A planner that passes
 * one example can still break any of these; they are what "the plan is read
 * from the world" means, stated generally:
 *
 *   ENGINE (`evaluateGoalPortfolio` over the $10K goal's openings, fixed seed):
 *     E1  raising an opening's capital never raises reach, and never makes it a member
 *     E2  renaming an opening (its title; its id) changes nothing the engine computes
 *     E4  making an established input less known (UNKNOWN over a range that contains it)
 *         never raises reach and never makes the opening a member (invariant 39)
 *     E6  tightening a capital limit (ceiling, weekly, before proof) never raises reach
 *     E7  lengthening the deadline never lowers reach (within Monte Carlo tolerance; see there)
 *     R6  loosening the ceiling never lowers the reconstructed plan's reach (`reconstructPlan`)
 *
 *   PLAN (`readGoalPlan` over seeded goals, the harness of `planTransfer.test.ts`):
 *     P3  a monthly recurring target keeps its monthly unit through to the plan
 *     P5  every opening or arrangement a step names belongs to the adopted strategy
 *     P6  tightening a goal's capital never raises the reach it reports
 *     P7  lengthening a goal's deadline never lowers the reach it reports
 *     P8  a price filed in one project never prices a goal in another
 *
 * A property the planner breaks is kept as `it.fails`, with the defect, where
 * it lives and why it is not fixed here written above it: the test turns red
 * the day the defect is fixed, and is then made an ordinary `it`.
 *
 * The engine is pure in its input and seeded, so most engine comparisons are
 * exact (a tolerance of 1e-9). Only where the changed input alters how many
 * random draws a world consumes (the deadline: a longer window contacts more
 * prospects, and a binomial over ≤400 trials draws once per trial, so every
 * later draw moves) is a Monte Carlo tolerance allowed, and it is stated there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';
import { reconstructPlan, type Reconstruction, type StrategyChange } from '../server/services/goals/reconstruction.ts';
import { freshProject, teardown } from './helpers.ts';
import { evaluateGoalPortfolio, forgetHeldEvaluations, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { ARRANGEMENT_ID_PREFIX, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { adoptReconstruction, forgetGoalReadings, planSteps, readGoalPlan, type PlanReading } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { clearConstructionMemo } from '../server/services/cash/construct.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashMechanism } from '../server/domain/types.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims } from '../server/repos/research.ts';

const EXACT = 1e-9;
const WORLDS = 600;
const SEED = 7;

type Limits = Omit<Parameters<typeof evaluateGoalPortfolio>[0], 'openings'>;
/** The $10K goal's limits, without the measured record (its authority rule is not under test) and without market history. */
const LIMITS: Limits = { ...GOAL_10K_LIMITS, measuredCapacity: GOAL_10K_LIMITS.measuredCapacity, knowledge: null, causal: false, worlds: WORLDS, seed: SEED };

const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: { kind: 'OTHER', ref: 'test' }, note: '' });
const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
const mid = (x: ModelInput) => x.value ?? ((x.low ?? 0) + (x.high ?? x.low ?? 0)) / 2;

const evaluate = (openings: PlannedOpening[], over: Partial<Limits> = {}) => evaluateGoalPortfolio({ ...LIMITS, ...over, openings });
const reachOf = (p: ReturnType<typeof evaluate>) => p.best?.reach ?? 0;
const isMember = (p: ReturnType<typeof evaluate>, id: string) => (p.best?.members ?? []).some((m) => m.opportunityId === id);

/**
 * An established figure that still takes its world's draw. `sampler` returns a
 * figure with a `value` without drawing, and an UNKNOWN range draws once a
 * world, so replacing one by the other shifts every later draw of the opening's
 * stream: the two readings would be different samples, and the comparison
 * would measure Monte Carlo noise (±1 standard error, either way), not the
 * planner. A degenerate triangular distribution is established (`established`:
 * EVIDENCE with a non-RANGE distribution), always reads `v`, and consumes the
 * same one draw the widened range does — common random numbers, so the only
 * difference between the two readings is how much is known.
 */
const drawnEvidence = (v: number): ModelInput => ({ value: null, low: v, high: v, provenance: 'EVIDENCE', source: { kind: 'OTHER', ref: 'test' }, note: '', distribution: { kind: 'TRIANGULAR', min: v, mode: v, max: v } });

/** The fixture with every input established at its range's middle: the "known" world input-widening starts from. */
const KNOWN: ModelledOpportunity[] = GOAL_10K_OPENINGS.map((o) => ({
  ...o,
  price: drawnEvidence(mid(o.price)),
  // Capital is never drawn (`capitalAtStart` reads it): an established figure is its value.
  capital: evidence(Math.min(300, mid(o.capital))),
  daysToCash: drawnEvidence(mid(o.daysToCash)),
  close: drawnEvidence(mid(o.close)),
  respond: drawnEvidence(mid(o.respond)),
  directCost: drawnEvidence(mid(o.directCost)),
  volume: drawnEvidence(Math.round(mid(o.volume))),
}));
const valueOf = (x: ModelInput) => x.value ?? x.low!;

const replace = (openings: ModelledOpportunity[], id: string, over: Partial<ModelledOpportunity>) => openings.map((o) => (o.opportunity.id === id ? { ...o, ...over } : o));

beforeAll(() => forgetHeldEvaluations());

describe('engine: metamorphic properties of evaluateGoalPortfolio', () => {
  function capitalLadder(over: Partial<Limits>): string[] {
    const ladder = [0, 25, 50, 74, 76, 100, 200, 300, 375, 400, 1_000];
    const broken: string[] = [];
    for (const base of [GOAL_10K_OPENINGS, KNOWN]) {
      for (const o of base) {
        let prev: { reach: number; member: boolean; capital: number } | null = null;
        for (const capital of ladder) {
          const p = evaluate(replace(base, o.opportunity.id, { capital: evidence(capital) }), over);
          const now = { reach: reachOf(p), member: isMember(p, o.opportunity.id), capital };
          if (prev && now.reach > prev.reach + EXACT) broken.push(`${base === KNOWN ? 'known' : 'fixture'} ${o.opportunity.id}: capital ${prev.capital}→${capital} raised reach ${prev.reach}→${now.reach}`);
          if (prev && now.member && !prev.member) broken.push(`${base === KNOWN ? 'known' : 'fixture'} ${o.opportunity.id}: capital ${prev.capital}→${capital} made it a member`);
          prev = now;
        }
      }
    }
    return broken;
  }

  /*
   * Fixed 2026-11-20. It failed because a world whose direct costs passed the
   * spending ceiling failed outright, so anything that capped an opening's
   * deals (a larger capital → fewer lots, `stakeCycles`) raised reach. Now the
   * ceiling funds only the sales it can (`ceilingShare`, quant/portfolio.ts),
   * and a stake line is recycled only where its deal is its lot, never capped
   * below what fresh money funds (`stakeCycles`, goals/portfolio.ts).
   */
  it('E1a raising an opening\'s established capital never raises reach, and never makes it a member', () => {
    expect(capitalLadder({})).toEqual([]);
  }, 120_000);

  it('E1b the same with no spending ceiling (capital still held to the per-week and before-proof limits)', () => {
    expect(capitalLadder({ capitalCeiling: null })).toEqual([]);
  }, 120_000);

  /** The same openings read twice, the second time under other names: everything the engine computes must be the same. */
  function sameReading(rename: (o: ModelledOpportunity, i: number) => ModelledOpportunity['opportunity']) {
    for (const base of [GOAL_10K_OPENINGS, KNOWN]) {
      const renamed = base.map((o, i) => ({ ...o, opportunity: rename(o, i) }));
      const back = new Map(renamed.map((o, i) => [o.opportunity.id, base[i]!.opportunity.id]));
      const p = evaluate(base);
      const q = evaluate(renamed);
      expect(q.best?.reach).toBe(p.best?.reach);
      expect(q.best?.settledP50).toBe(p.best?.settledP50);
      expect((q.best?.members ?? []).map((m) => `${back.get(m.opportunityId)}@${m.share}`).sort()).toEqual((p.best?.members ?? []).map((m) => `${m.opportunityId}@${m.share}`).sort());
      expect(q.basis).toBe(p.basis);
      expect(q.demand.map((d) => d.refused ?? d.heldOut ?? null)).toEqual(p.demand.map((d) => d.refused ?? d.heldOut ?? null));
    }
  }

  it('E2a renaming an opening (its title: what a person calls it) changes no reach, no settled figure and no membership', () => {
    sameReading((o, i) => ({ ...o.opportunity, title: `Something else entirely ${String.fromCharCode(90 - i)}` }));
  }, 60_000);

  /*
   * Fixed 2026-11-20: an activity's resample stream was seeded by its key
   * (`${opportunity.id}@${share}`); it is now seeded by `stream`, the
   * opening's index and share — what its demand worlds are seeded by.
   */
  it('E2b renaming an opening\'s id changes no reach', () => {
    sameReading((o, i) => ({ ...o.opportunity, id: `zz_renamed_${i}` }));
  }, 60_000);

  /*
   * Invariant 39. With common random numbers (see `drawnEvidence`) and a
   * control that relabels the same figure UNKNOWN at zero width (which reads
   * identically — so nothing but the width moves), widening an established
   * input to an UNKNOWN range a quarter either side of it must not raise
   * reach. It once did (`cop_lists` days to cash 0.6717 → 0.6733 at seed 7):
   * an UNKNOWN range was sampled uniformly, so wherever reach is convex in it
   * not knowing paid. Fixed 2026-11-20: `sampler` folds an unestablished
   * input's draw onto the unfavourable half of its range (goals/portfolio.ts).
   */
  let widening: { reach: string[]; member: string[]; control: string[] } | null = null;
  /** Each established input of each opening, widened to UNKNOWN a quarter either side, against the established reading. */
  function widen() {
    if (widening) return widening;
    const base = evaluate(KNOWN);
    const fields = ['price', 'capital', 'daysToCash', 'close', 'respond', 'directCost', 'volume'] as const;
    widening = { reach: [], member: [], control: [] };
    for (const o of KNOWN) {
      for (const field of fields) {
        const v = valueOf(o[field] as ModelInput);
        // Less known: the same figure, now one point of an UNKNOWN range that contains it, a quarter either side.
        const widened = unknown(v * 0.75, field === 'close' || field === 'respond' ? Math.min(1, v * 1.25) : v * 1.25);
        const p = evaluate(replace(KNOWN, o.opportunity.id, { [field]: widened }));
        // The control: the same figure merely relabelled UNKNOWN (zero width) reads what the established one does.
        if (field !== 'capital') {
          const control = evaluate(replace(KNOWN, o.opportunity.id, { [field]: unknown(v, v) }));
          if (Math.abs(reachOf(control) - reachOf(base)) > EXACT) widening.control.push(`${o.opportunity.id}.${field}: relabelling it UNKNOWN at the same figure moved reach ${reachOf(base).toFixed(4)}→${reachOf(control).toFixed(4)}`);
        }
        if (reachOf(p) > reachOf(base) + EXACT) widening.reach.push(`${o.opportunity.id}.${field}: reach ${reachOf(base).toFixed(4)}→${reachOf(p).toFixed(4)}`);
        if (isMember(p, o.opportunity.id) && !isMember(base, o.opportunity.id)) widening.member.push(`${o.opportunity.id}.${field}: became a member`);
      }
    }
    return widening;
  }

  it('E4a making an established input less known never raises reach (invariant 39)', () => {
    expect(widen().reach).toEqual([]);
  }, 120_000);

  it('E4b making an established input less known never makes the opening a member, and relabelling alone moves nothing', () => {
    expect(widen().member).toEqual([]);
    expect(widen().control).toEqual([]);
  }, 120_000);

  /** One capital limit tightened step by step from absent, everything else the $10K goal's: each step that raised reach. */
  function tightening(limit: 'capitalCeiling' | 'perWeek' | 'beforeProof', ladder: Array<number | null>): string[] {
    const broken: string[] = [];
    for (const base of [GOAL_10K_OPENINGS, KNOWN]) {
      let prev: { reach: number; at: number | null } | null = null;
      for (const at of ladder) {
        const reach = reachOf(evaluate(base, { [limit]: at }));
        if (prev && reach > prev.reach + EXACT) broken.push(`${base === KNOWN ? 'known' : 'fixture'}: ${limit} ${prev.at}→${at} raised reach ${prev.reach}→${reach}`);
        prev = { reach, at };
      }
    }
    return broken;
  }

  it('E6a tightening the capital ceiling, or the before-proof limit, never raises reach', () => {
    expect(tightening('capitalCeiling', [null, 100_000, 10_000, 3_000, 1_500, 750, 400, 200, 50, 0])).toEqual([]);
    expect(tightening('beforeProof', [null, 3_000, 750, 375, 200, 100, 50, 0])).toEqual([]);
  }, 120_000);

  /*
   * Fixed 2026-11-20. The starting capital was `perWeek ?? beforeProof ??
   * capitalCeiling`, so stating a weekly limit above the before-proof one
   * loosened the plan. Decision (coordinator): "at most $X before the first
   * sale" is total exposure before proof, so the starting capital is the
   * minimum of the stated pre-proof limits.
   */
  it('E6b stating a weekly capital limit never raises reach', () => {
    expect(tightening('perWeek', [null, 3_000, 750, 375, 200, 100, 50, 0])).toEqual([]);
  }, 120_000);

  it('E7 lengthening the deadline never lowers reach (Monte Carlo tolerance: the window changes how many draws a world consumes)', () => {
    /*
     * Why a tolerance here and nowhere else: a longer window contacts more
     * prospects, and `binomial` draws once per trial up to 400, so every draw
     * after the first world's moves; the two readings are different samples
     * of the worlds. 2 000 worlds put one standard error of a reach at most
     * 0.011; 0.03 is under three of them.
     */
    const TOLERANCE = 0.03;
    const broken: string[] = [];
    for (const base of [GOAL_10K_OPENINGS, KNOWN]) {
      let prev: { reach: number; days: number } | null = null;
      for (const days of [7, 14, 21, 30, 45, 60, 90]) {
        const reach = reachOf(evaluate(base, { daysLeft: days, worlds: 2_000 }));
        if (prev && reach < prev.reach - TOLERANCE) broken.push(`${base === KNOWN ? 'known' : 'fixture'}: deadline ${prev.days}→${days} lowered reach ${prev.reach}→${reach}`);
        prev = { reach, days };
      }
    }
    expect(broken).toEqual([]);
  }, 120_000);

  /*
   * FAILS (defect, server/services/goals/reconstruction.ts, the greedy round
   * search in `reconstructPlan` with the operator budgets of
   * `buildOperators` ~866). Deterministic with exploration off. On the $10K
   * goal (measured record, seed 3, 400 worlds) the strongest reconstruction
   * reads 0.882 at a 3 000 ceiling (bundle + `cold-email-prewarmed@750`) and
   * 0.845 at 10 000 (bundle + `cold-email-new-mailboxes@375`), although
   * every move of the first is equally feasible under the looser ceiling and
   * the baseline itself is monotone (0.5075 → 0.64). The looser ceiling adds
   * a 10 000 budget to every operator, the greedy path keeps a different
   * move first, and the family rule (`family`: a smaller purchase of a lever
   * already made is never re-tried) leaves it at a weaker local optimum.
   * Owned by another worker: reported.
   * 2026-11-20: holds on these figures since the engine fixes of E1a/E4a/E6b
   * (a ceiling that funds only what it can, unknowns folded to their
   * unfavourable half, starting capital the tightest pre-proof limit) moved
   * both readings; the greedy path dependence above is not itself fixed.
   */
  it('R6 loosening the capital ceiling never lowers the reconstructed plan\'s reach (exploration off, deterministic)', async () => {
    const at = async (ceiling: number) => {
      const limits = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 400, seed: 3, capitalCeiling: ceiling };
      const baseline = evaluateGoalPortfolio({ ...limits, openings: GOAL_10K_OPENINGS });
      return (await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: limits, baseline, required: 0.9, explore: null })).best.reach;
    };
    const tight = await at(3_000);
    const loose = await at(10_000);
    expect(loose, `ceiling 3000 → 10000: reconstructed reach ${tight} → ${loose}`).toBeGreaterThanOrEqual(tight - EXACT);
  }, 120_000);
});

/*
 * ─── The planner, over seeded goals ──────────────────────────────────────────
 *
 * The world of `planTransfer.test.ts`, reduced to what these properties read:
 * found openings in five sectors (one recurring), and two map projects whose
 * sectors are the same and whose only price is filed in the second.
 */

interface Held {
  title: string;
  mechanism: CashMechanism;
  industry: string;
  payer: string;
  capture: string;
  priceCents: number;
  costCents: number;
  capitalCents: number;
  days: number;
  hours: number;
  volume: string;
  recurring: boolean;
}

const WORLD: Held[] = [
  {
    title: 'Vendor-compliance spreadsheet for property managers', mechanism: 'PRODUCTIZED_SERVICE', industry: 'property management',
    payer: 'Property managers', capture: 'Sell the finished compliance spreadsheet to each manager.', priceCents: 60_000, costCents: 1_000, capitalCents: 0, days: 5, hours: 1,
    volume: '400 property managers are listed in the state directory; each needs one.', recurring: false,
  },
  {
    title: 'Monthly bookkeeping retainer for dental practices', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'dental practices',
    payer: 'Dental practice owners', capture: 'Bill each practice a monthly retainer; a subcontracted bookkeeper does the work.', priceCents: 90_000, costCents: 45_000, capitalCents: 0, days: 30, hours: 1,
    volume: '250 independent dental practices are listed in the state dental board directory; each pays monthly.', recurring: true,
  },
  {
    title: 'Resale of liquidated restaurant kitchen equipment', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'restaurant equipment',
    payer: 'Restaurant operators', capture: 'Buy a liquidated lot at auction and resell it to an opening restaurant.', priceCents: 1_400_000, costCents: 800_000, capitalCents: 800_000, days: 21, hours: 4,
    volume: '30 liquidation auctions a month are listed by the regional auctioneer; 40 restaurants open each month.', recurring: false,
  },
  {
    title: 'Post-construction cleanup for general contractors', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning',
    payer: 'General contractors', capture: 'Sell the final cleanup and subcontract a crew.', priceCents: 120_000, costCents: 60_000, capitalCents: 0, days: 10, hours: 2,
    volume: '80 general contractors are listed in the state licensing board; each needs cleanup per project.', recurring: false,
  },
  {
    title: 'Farm grant planning service for Pennsylvania farm operators', mechanism: 'PRODUCTIZED_SERVICE', industry: 'farm grant planning',
    payer: 'Pennsylvania farm operators', capture: 'Prepare the grant application plan for each farm and invoice on submission.', priceCents: 1_500_000, costCents: 300_000, capitalCents: 1_200_000, days: 6, hours: 3,
    volume: '120 Pennsylvania farm operators apply for the Farm Vitality Planning Grant each round, per the state agriculture department.', recurring: false,
  },
];

const NOW = new Date();
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

let projectId = '';
let userId = '';
/** Two map projects with the same sectors; only `pricedMapId` has a price filed for its dental practices. */
let unpricedMapId = '';
let pricedMapId = '';

/** A sourced, accepted claim a price fact can cite, on the project it is filed in. */
async function priceClaim(onProject: string, suffix: string): Promise<string> {
  const layerId = (await listLayers(onProject))[0]!.id;
  const run = await createRun({ projectId: onProject, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'price' });
  const orchestration = await createOrchestration({ projectId: onProject, layerId, runId: run.id, title: 'price', assignment: 'price', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: onProject, layerId, fragmentIndex: 0, fragmentKey: `price-${suffix}`, question: 'What dental practices pay',
      requiredEvidence: [{ id: 'figure', description: 'a published price', necessity: 'REQUIRED' }], acceptableSourceTypes: ['price list'], excludedSourceTypes: [],
      completionCriteria: ['a price'], dependsOn: [], minIndependentSources: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: `A dental practice pays $200 per compliance report ${suffix}`, sourceUrl: `https://example.org/price/${suffix}`, sourceTitle: 'Price list', sourcePublisher: 'example.org',
      sourceDate: '2026-10-01', evidenceExcerpt: '$200 per report', evidenceLocator: 'table 1', evidenceLane: 'figure', retrievedAt: '2026-11-01', confidence: 0.9,
      validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const, contentHash: `pm-${suffix}`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

async function seedMap(name: string, priced: boolean): Promise<string> {
  const id = (await createProject({ name, slug: `plan-metamorphic-${Math.random().toString(36).slice(2, 8)}` })).id;
  expect((await activate({ projectId: id, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  const actorRef = `person:${userId}`;
  for (const [sector, buyers] of [['Dentistry', ['Dental practices', 'Orthodontic clinics']], ['Property management', ['Residential property managers']]] as Array<[string, string[]]>) {
    const root = await seedSubject({ projectId: id, name: sector, actorRef });
    for (const buyer of buyers) {
      const node = await seedSubject({ projectId: id, name: buyer, kind: 'BUYER_TYPE', parentId: root.node.id, actorRef });
      if (priced && buyer === 'Dental practices') {
        for (const [suffix, low, high] of [['d1', 150, 250], ['d2', 200, 300]] as const) {
          // The claim and the fact are both the priced project's own.
          const claimId = await priceClaim(id, `${suffix}-${id}`);
          await recordClaimFact({
            projectId: id, nodeId: node.node.id, claimId, key: 'price_per_unit', segment: `map_${node.node.id}`, low, high, status: 'OBSERVED',
            measures: 'a dental practice pays per compliance report', sourceTitle: 'Price list', sourceUrl: `https://example.org/${claimId}`, sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
          });
        }
      }
    }
  }
  return id;
}

/** The goal the words make, the only live target on its project (earlier goals there are retired first). */
async function goalOn(project: string, words: string): Promise<string> {
  await getDb().run(`UPDATE workstreams SET cancelled_at = ? WHERE target_project_id = ? AND cancelled_at IS NULL`, [NOW.toISOString(), project]);
  const created = await createGoal({ projectId: project, objective: words, actorRef: `person:${userId}`, userId, now: new Date(NOW.getTime() - 60_000) });
  expect(created.ok, created.ok ? '' : created.reason).toBe(true);
  return created.ok ? created.goal.id : '';
}

/** The reconstruction's evaluation budget per read: below the transfer harness's 400 to keep the suite near 90s; a property must hold at any budget. */
const PLAN_EVALUATIONS = 150;
const readings = new Map<string, PlanReading>();
async function planFor(project: string, words: string): Promise<PlanReading> {
  const hit = readings.get(`${project}|${words}`);
  if (hit) return hit;
  const p = (await readGoalPlan({ goalId: await goalOn(project, words), evaluations: PLAN_EVALUATIONS }))!;
  expect(p).not.toBeNull();
  readings.set(`${project}|${words}`, p);
  return p;
}

/** The reach a reading reports: its defensible probability, else its candidate's reach; nothing to pursue reads 0. */
/** Two goals are two samples: each reads worlds seeded by its own id (plan.ts:1755). The tolerance of E7, for the same reason. */
const PLAN_TOLERANCE = 0.03;
const headline = (p: PlanReading): number => p.acceptance.probability?.value ?? p.acceptance.candidate?.reach ?? 0;

const titleOf = (p: PlanReading): Map<string, string> => new Map([...(p.portfolio?.demand ?? []).map((d) => [d.opportunityId, d.title] as const), ...p.considered.map((c) => [c.opportunityId, c.title] as const)]);

/** The openings a text names in quotes, resolved against the reading's own titles (a quote may be cut at 50 or 80). */
function namedIn(text: string, titles: Map<string, string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]{12,})"/g)) {
    const q = m[1]!.replace(/…$/, '');
    for (const [id, title] of titles) if (title === q || (q.length >= 20 && title.startsWith(q))) out.push(id);
  }
  return out;
}

/**
 * P5, checked on every reading this suite takes: every step belongs to the
 * strategy the plan adopted.
 *   - An adopted reconstruction's steps are its own moves and its sale: no
 *     step is an arrangement's, and every opening a move brings in or changes
 *     is one of its members (a move that leaves an opening out names a
 *     non-member by design, as does a sale the plan lists beside it).
 *   - Otherwise an arrangement's steps are the candidate's own arrangement,
 *     when the candidate names members.
 *   - No step sells an opening the portfolio refused or held out on a limit.
 */
function stepsBelongToAdopted(p: PlanReading): { structure: string[]; members: string[] } {
  const out = { structure: [] as string[], members: [] as string[] };
  const titles = titleOf(p);
  // A candidate names its constructed arrangements among its ids (`arr_…`).
  const candidate = new Set(p.acceptance.candidate?.opportunityIds ?? []);
  const sold = new Set(p.sales.map((s) => s.opportunityId));
  const barred = new Set((p.portfolio?.demand ?? []).filter((d) => d.refused || d.heldOut).map((d) => d.opportunityId));
  const reconstructed = p.adoption.source === 'RECONSTRUCTED' && p.acceptance.candidate?.source === 'RECONSTRUCTED';
  for (const s of p.steps) {
    const names = namedIn(`${s.label} ${s.detail}`, titles);
    // A sale the reading holds: its opening is the candidate's or one of the plan's own sales, and never one a limit barred.
    if (s.label.startsWith('Sell "') && (!reconstructed || s.detail.includes('Beside the reconstructed plan'))) {
      for (const n of names.slice(0, 1)) {
        if (!sold.has(n) && !candidate.has(n)) out.structure.push(`"${s.label}" sells an opening neither in the candidate nor among the plan's sales`);
        if (barred.has(n)) out.structure.push(`"${s.label}" sells an opening the portfolio refused or held out on a limit`);
      }
    }
    if (reconstructed) {
      if (s.arrangement) out.structure.push(`"${s.label}" is an arrangement's step inside an adopted reconstruction`);
      // A move that leaves an opening out names a non-member by design; so does a sale listed beside the reconstruction.
      if (/^Leave out/i.test(s.label) || s.detail.includes('Beside the reconstructed plan')) continue;
      for (const n of names) {
        if (!candidate.has(n)) out.members.push(`"${s.label.slice(0, 90)}" names ${titles.get(n)} (${n}), not a member of the adopted reconstruction [${[...candidate].join(', ')}]; its strongest plan's members: ${JSON.stringify(p.reconstruction?.best.members ?? [])}`);
      }
    } else if (s.arrangement && candidate.size > 0 && !candidate.has(`${ARRANGEMENT_ID_PREFIX}${s.arrangement.key}`)) {
      out.structure.push(`"${s.label}" is built from arrangement ${s.arrangement.key}, outside the candidate [${[...candidate].join(', ')}]`);
    }
  }
  return out;
}

const RECURRING_TITLE = WORLD.find((h) => h.recurring)!.title;

describe('plan: metamorphic properties of readGoalPlan over seeded goals', () => {
  beforeAll(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    clearConstructionMemo();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `pm-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(projectId))!.id;
    for (const h of WORLD) {
      const o = await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title: h.title, mechanism: h.mechanism, currency: 'USD', industry: h.industry,
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
        requiredCapabilities: ['PRODUCE_SPREADSHEET'],
      } as Parameters<typeof createOpportunity>[0]);
      const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
      await fact(CAPTURE_KEY, h.capture);
      await fact('payer', h.payer);
      await fact('delivery', 'Brain produces or subcontracts it.');
      await updateOpportunity(o.id, {
        payer: h.payer, price_cents: h.priceCents, offer_scope: h.title, reachable_channel: 'Published business email addresses',
        buying_signal: 'Posted asking for this work', signal_observed_at: inDays(-3), peak_funding_cents: h.capitalCents, human_hours: h.hours, industry: h.industry,
      } as never);
      await fact('price', `$${h.priceCents / 100}${h.recurring ? ' a month' : ''}`);
      await fact('timeToFirstCash', `${h.days} days`);
      await fact('directCosts', `$${h.costCents / 100}`);
      if (h.capitalCents > 0) await fact('exposure', `$${h.capitalCents / 100}`);
      await fact('buyerVolume', h.volume);
    }
    unpricedMapId = await seedMap('Plan metamorphic map A (no price)', false);
    pricedMapId = await seedMap('Plan metamorphic map B (priced)', true);
  }, 60_000);

  afterAll(async () => {
    for (const [key, p] of readings) {
      console.log(`METAMORPHIC ${JSON.stringify({ goal: key.split('|')[1], adoption: p.adoption.source, candidate: p.acceptance.candidate?.source ?? null, reach: headline(p), status: p.acceptance.status, members: p.acceptance.candidate?.opportunityIds ?? [], lead: p.lead ? `${p.lead.buyers} (${p.lead.price.basis})` : null, unpriced: (p.unpriced ?? []).map((u) => u.buyer), steps: p.steps.map((s) => s.label) })}`);
    }
    await teardown();
  });

  it('P3 a monthly recurring target keeps its monthly unit through to the plan', async () => {
    const p = await planFor(projectId, 'Earn $2,000 a month in recurring revenue within 60 days using no up-front capital.');
    // The reading is of a run-rate, and says so.
    expect(p.target.scope?.recurring).toBe('MONTHLY');
    expect(p.target.metricLabel).toMatch(/a month/);
    expect(p.target.targetCents).toBe(200_000);
    // The engine is asked for the monthly figure, not a total over the window.
    if (p.portfolio) expect(p.portfolio.limits.target).toBe(2_000);
    // Only revenue that recurs can move a run-rate: no one-off opening is a member of what the plan pursues.
    const titles = titleOf(p);
    const oneOff = new Set([...titles].filter(([, t]) => WORLD.some((h) => !h.recurring && h.title === t)).map(([id]) => id));
    for (const id of [...(p.acceptance.candidate?.opportunityIds ?? []), ...(p.portfolio?.best?.members.map((m) => m.opportunityId) ?? [])]) {
      expect(oneOff.has(id), `a one-off opening (${titles.get(id)}) is a member of a monthly plan`).toBe(false);
    }
    // The recurring opening is read, never excluded as out of scope.
    expect(p.excluded.map((e) => e.title)).not.toContain(RECURRING_TITLE);
    // A sentence that states the target in money states it per month.
    for (const text of [p.summary, p.acceptance.sentence]) {
      if (/2,000|2000/.test(text)) expect(text, text.slice(0, 300)).toMatch(/a month|per month|monthly|run-rate/i);
    }
  }, 120_000);

  const CAPITAL_WORDS = {
    '$10,000': 'Collect $15,000 of settled cash within 30 days with at most $10,000 of capital.',
    '$1,000': 'Collect $15,000 of settled cash within 30 days with at most $1,000 of capital.',
    none: 'Collect $15,000 of settled cash within 30 days using no up-front capital.',
  } as const;
  async function capitalStep(from: keyof typeof CAPITAL_WORDS, to: keyof typeof CAPITAL_WORDS): Promise<void> {
    const a = await planFor(projectId, CAPITAL_WORDS[from]);
    const b = await planFor(projectId, CAPITAL_WORDS[to]);
    // Each goal's worlds are seeded by its own id (plan.ts:1755), so two goals are two samples: the tolerance of E7.
    expect(headline(b), `capital ${from} → ${to}: reach ${headline(a)} → ${headline(b)}`).toBeLessThanOrEqual(headline(a) + PLAN_TOLERANCE);
  }

  it('P6a tightening a goal\'s capital never raises the reach it reports ($10,000 → $1,000)', async () => {
    await capitalStep('$10,000', '$1,000');
  }, 120_000);

  /*
   * FAILS (defect, server/services/industry/construction/intent.ts:491/528,
   * `readObjective`). "using no up-front capital" is read as no capital limit
   * at all: capitalCeiling null, no before-proof limit, and no assumed one
   * (LITTLE_CAPITAL matches "little|minimal|…|hardly any" capital, never
   * "no"/"zero"/"without"). The engine then has no spending ceiling, so the
   * subcontracted cleanup's $600-a-deal crews are unbounded, while the same
   * goal "with at most $1,000 of capital" is held to $1,000 of spend: on this
   * world the zero-capital goal reads 0.898 against 0.434 for $1,000 (and
   * 0.724 for $10,000). The owner who said "none" is planned as if money were
   * unlimited. The fix is in the goal's reading (no/zero/without up-front
   * capital → a before-proof limit of 0, with the direct costs a buyer's
   * payment funds still allowed), outside this suite's files: reported.
   */
  it('P6b tightening a goal\'s capital to none never raises the reach it reports ($1,000 → none)', async () => {
    await capitalStep('$1,000', 'none');
  }, 120_000);

  it('P7 lengthening a goal\'s deadline never lowers the reach it reports', async () => {
    let prev: { reach: number; days: number } | null = null;
    for (const days of [30, 90]) {
      const p = await planFor(projectId, `Collect $15,000 of settled cash within ${days} days using no up-front capital.`);
      expect(p.target.daysLeft).toBeGreaterThanOrEqual(days - 1);
      const reach = headline(p);
      // The plan searches every window with its own seeded worlds and its own strategy search, so a near-tie may read a hair lower (PLAN_TOLERANCE).
      if (prev) expect(reach, `deadline ${prev.days} → ${days} days: reach ${prev.reach} → ${reach}`).toBeGreaterThanOrEqual(prev.reach - PLAN_TOLERANCE);
      prev = { reach, days };
    }
  }, 120_000);

  it('P8 a price filed in one project never prices a goal in another', async () => {
    const words = 'Generate $5,000 within 30 days in a single industry the owner names: dentistry.';
    const priced = await planFor(pricedMapId, words);
    const unpriced = await planFor(unpricedMapId, words);
    // The control: the project that holds the price reads its dental practices as priced.
    expect((priced.unpriced ?? []).map((u) => u.buyer), 'the priced project still sends its own priced population to price research').not.toContain('Dental practices');
    // The other project holds no price for the same population: it is sent to price research, and never led as priced.
    expect((unpriced.unpriced ?? []).map((u) => u.buyer)).toContain('Dental practices');
    if (unpriced.lead?.buyers === 'Dental practices') expect(unpriced.lead.price.basis).not.toBe('OWN');
    // And no figure from the other project's facts reaches its model: nothing it models is priced 150–300 per report.
    for (const d of unpriced.portfolio?.demand ?? []) {
      if (/dental/i.test(d.title)) expect(d.price.p50 === 0 || d.price.p50 < 150 || d.price.p50 > 300, `${d.title}: priced ${d.price.p50}`).toBe(true);
    }
  }, 120_000);
  /*
   * P5 runs last and reads every plan the tests above read (`readings`).
   * P5a: the structure of the steps. P5b: a reconstruction's moves name only
   * its members.
   */
  it('P5a every step belongs to the adopted strategy: no arrangement steps in a reconstruction, arrangement steps from the candidate, no sale of a barred opening', () => {
    expect(readings.size).toBeGreaterThanOrEqual(5);
    const broken = [...readings].flatMap(([key, p]) => stepsBelongToAdopted(p).structure.map((one) => `${key.split('|')[1]}: ${one}`));
    expect(broken).toEqual([]);
  });

  /*
   * The member half of P5 on these reads is logged, not asserted: whether a
   * reconstruction keeps a move on a non-member depends on the plan's seed
   * (sha256 of the goal id, plan.ts:1755) and its time-bounded exploration.
   * It was seen in 3 of 4 runs of the "$10,000 of capital" goal; P5b and P5c
   * below pin the two mechanisms deterministically, on the pure functions
   * that build a reconstructed plan's steps and members.
   */
  it('P5 (diagnostic) moves of an adopted reconstruction that name a non-member, on these reads', () => {
    for (const [key, p] of readings) for (const one of stepsBelongToAdopted(p).members) console.log(`P5-MEMBER ${key.split('|')[1]}: ${one}`);
  });

});

/*
 * P5's member half, on the pure functions an adopted reconstruction's plan is
 * built by (`adoptReconstruction`, `planSteps`), so it does not depend on a
 * seed. The reconstruction is the shape production plan reads produced
 * ("$10,000 of capital" above): a partner move on the restaurant-equipment
 * opening, kept, while the strongest combination sells only the
 * vendor-compliance spreadsheet.
 */
describe('plan steps: a reconstruction\'s moves belong to its members', () => {
  const A = { id: 'cop_sheet', title: 'Vendor-compliance spreadsheet for property managers' };
  const B = { id: 'cop_kitchen', title: 'Resale of liquidated restaurant kitchen equipment' };
  const partnerOn = (o: { id: string; title: string }): StrategyChange => ({
    dimension: 'PARTNER', op: 'partner:referral-partner', clone: `${o.id}~partner`, label: 'referral-partner',
    detail: `sell "${o.title.slice(0, 80)}" through a partner who already serves its buyers (a supplier or complementary vendor), paying 10–20%`,
    // An ESTIMATE here: these tests read how members resolve, and a reconstruction resting only on assumptions is never adopted (invariant 39).
    cost: 0, basis: 'ESTIMATE', startDay: { low: 5, high: 10 },
  });
  const reconstructionOf = (changes: StrategyChange[], members: string[]): Reconstruction => {
    const best = { key: 'best', changes, members, reach: 0.8, settledP10: 0, settledP50: 9_000, settledP90: 20_000, basis: 'COVERAGE', committed: 0, feasible: true, why: null, worlds: 400, implausible: [] };
    // No assumed move, so the plan without assumptions is the plan itself.
    return { required: 0.9, requiredReply: null, flags: [], baseline: { reach: 0.3, settledP50: 1_000 }, best, established: best } as unknown as Reconstruction;
  };
  const titles = new Map([[A.id, A.title], [B.id, B.title]]);

  /*
   * FAILS (defect, server/services/goals/plan.ts `planSteps` ~2795, fed by
   * reconstruction.ts's kept state). An adopted reconstruction lists every
   * change it kept as a step, whether or not the opening the change acts on
   * (or its clone) is in its strongest combination: the partner clone is added
   * to the state (reconstruction.ts ~1008, `partner:referral-partner`) and the
   * change kept, the optimizer never puts the clone in the best combination,
   * and the plan tells a person to sign a partner for an opening it does not
   * sell. Either the reconstruction drops a change whose opening is not a
   * member, or `planSteps` does not list it; both files belong to other
   * workers: reported.
   */
  it.fails('P5b no step of an adopted reconstruction acts on an opening outside its strongest combination', () => {
    const r = reconstructionOf([partnerOn(B)], [A.title.slice(0, 50)]);
    const steps = planSteps({ adoption: { source: 'RECONSTRUCTED', hypothetical: false, reason: 'test' }, reconstruction: r, sales: [], nextTest: null, permissionsMissing: [], titles, adoptedIds: new Set([A.id]) });
    const named = steps.filter((s) => !/^Leave out/i.test(s.label)).flatMap((s) => namedIn(`${s.label} ${s.detail}`, titles).map((id) => `${s.label}: ${id}`));
    expect(named.filter((one) => !one.endsWith(A.id))).toEqual([]);
  });

  /*
   * FAILS (defect, server/services/goals/plan.ts `adoptReconstruction`
   * ~2418). A reconstruction names its members by title cut at 50
   * characters, and a partner clone is titled
   * `${original.slice(0, 50)} via a referral partner`. For an original under
   * 50 characters the clone's member name is the whole original title plus
   * " via a referral partn…", which none of the three resolution rules match
   * (not its id; not an original's 50-character prefix; and the third rule
   * asks whether the *original* starts with the *member*, the wrong way
   * round): the member is dropped from `candidate.opportunityIds`. The plan
   * then sells, through the partner, an opening its candidate does not list.
   * "Resale of liquidated restaurant kitchen equipment" is 49 characters.
   * Reported (plan.ts belongs to another worker).
   */
  it.fails('P5c a partner clone among a reconstruction\'s members resolves to the opening it sells', () => {
    const clone = `${B.title.slice(0, 50)} via a referral partner`.slice(0, 50);
    const r = reconstructionOf([partnerOn(B)], [A.title.slice(0, 50), clone]);
    const adopted = adoptReconstruction({ reconstruction: r, baseline: null, openings: [{ opportunity: A }, { opportunity: B }] });
    expect(adopted.adoption.source).toBe('RECONSTRUCTED');
    expect(adopted.candidate?.opportunityIds ?? []).toContain(B.id);
  });

  it('P5c (control) a partner clone of an opening titled over 50 characters resolves', () => {
    const long = { id: 'cop_long', title: 'Post-construction cleanup for general contractors in three counties' };
    const clone = `${long.title.slice(0, 50)} via a referral partner`.slice(0, 50);
    const r = reconstructionOf([partnerOn(long)], [clone]);
    const adopted = adoptReconstruction({ reconstruction: r, baseline: null, openings: [{ opportunity: long }] });
    expect(adopted.candidate?.opportunityIds ?? []).toContain(long.id);
  });
});

afterAll(() => forgetHeldEvaluations());
