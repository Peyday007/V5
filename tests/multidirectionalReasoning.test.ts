/**
 * §101: Brain examines a goal from many genuinely different directions —
 * algorithmic, remembered and invented by its own model — evaluates them
 * concurrently, lets them challenge, combine and replace one another, and
 * learns which ways of reasoning work. The $10K goal is the regression case;
 * "before" is §99's reconstruction alone, exactly as it ran until this change.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { reconstructPlan, renderReconstruction } from '../server/services/goals/reconstruction.ts';
import { openEvaluator, inlineEvaluator } from '../server/services/goals/reasoning/evaluatorPool.ts';
import { distinct, explorationBudget, makeDirection, parseInvented, signatureOf, type InventBrief } from '../server/services/goals/reasoning/directions.ts';
import { inventDirections } from '../server/services/goals/reasoning/invent.ts';
import { loadLibrary, methodYield, recordExploration } from '../server/services/goals/reasoning/learning.ts';
import { freshProject, teardown } from './helpers.ts';
import type { LaneConfig } from '../server/services/cheap/lane.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';

const portfolioInput = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 1000, seed: 11 };
const baseline = evaluateGoalPortfolio({ ...portfolioInput, openings: GOAL_10K_OPENINGS });
const ids = GOAL_10K_OPENINGS.filter((o) => o.repeatable && o.agreedValue === 0).map((o) => o.opportunity.id);

/** A stand-in for Brain's free-lane model: it invents two methods with stances nobody wrote down, and one off-shape answer. */
const fakeLane: LaneConfig = { url: 'http://lane.invalid', key: null, models: ['a', 'b'], dailyBudget: 100, timeoutMs: 1000 };
let modelCalls = 0;
const fakeCompleter = async (_c: LaneConfig, _m: string, _s: string, prompt: string) => {
  modelCalls++;
  expect(prompt).toMatch(/invent OTHER ways of reasoning/);
  return JSON.stringify({
    methods: [
      { name: 'Sell the supplier, not the service', stance: 'SUPPLIER_FIRST', thinking: 'The suppliers already hold the buyers; sell through them and let the buyer prepay.', challenges: 'that Brain must find every buyer itself', from: 'BASELINE', program: [{ op: 'OPERATOR', key: 'partner:', target: ids[0] }, { op: 'OPERATOR', key: 'capital:prepaid' }, { op: 'OPERATOR', key: 'capacity:cold-email-new-mailboxes@375' }], ask: 'Which suppliers of this service publish a referral programme, and what commission do they pay?' },
      { name: 'Fewer, bigger, faster', stance: 'TEMPO', thinking: 'Only the large fast tickets can settle in time; put the small money behind them.', from: 'BASELINE', program: [{ op: 'DROP', scope: 'SMALL_TICKET' }, { op: 'OPERATOR', key: 'capacity:cold-email-prewarmed@375' }] },
      { name: 'Off-shape', stance: 'BROKEN', thinking: 'uses a step that does not exist', program: [{ op: 'TELEPORT' }] },
    ],
  });
};

const before = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9, explore: null });
const evaluator = openEvaluator(2);
const after = await reconstructPlan({
  openings: GOAL_10K_OPENINGS,
  portfolio: portfolioInput,
  baseline,
  required: 0.9,
  evaluator,
  explore: { invent: (brief) => inventDirections(brief, { config: fakeLane, completer: fakeCompleter, calls: 2, env: {} }) },
});
await evaluator.close();
const x = after.exploration!;
if (process.env.SHOW) console.log(renderReconstruction(after).join("\n"));

afterAll(async () => {
  await teardown();
});

describe('§101 regression: the $10K plan, before and after', () => {
  it('before: §99 alone walks one path and keeps a plan that rests on spending $2,999 before any cash is proven', () => {
    expect(before.exploration ?? null).toBeNull();
    expect(before.best.changes.some((c) => c.dimension === 'CAPACITY' && c.basis === 'ASSUMPTION' && c.cost > 2000)).toBe(true);
  });

  it('generates substantially different directions — many stances, distinct programs, its own model\'s among them', () => {
    expect(x.directions).toBeGreaterThanOrEqual(40);
    expect(x.stances.length).toBeGreaterThanOrEqual(8);
    for (const s of ['BACKWARD', 'FORWARD', 'MIDDLE_OUT', 'CONSTRAINT', 'RESOURCE', 'RELATIONSHIP', 'INVERSION']) expect(x.stances).toContain(s);
    // Stances nobody wrote down, invented by the model, were tested like any other.
    expect(x.stances).toEqual(expect.arrayContaining(['SUPPLIER_FIRST', 'TEMPO']));
    expect(x.byOrigin.MODEL).toBe(2);
    expect(x.model).toMatchObject({ calls: 2, refused: 2 });
    expect(modelCalls).toBe(2);
    // Every direction evaluated is a distinct program.
    expect(new Set(x.all.map((r) => r.direction.signature)).size).toBe(x.all.length);
    // Leaders were combined and modified.
    expect(x.byOrigin.RECOMBINED + x.byOrigin.MUTATED).toBeGreaterThan(0);
    expect(x.generations).toBeGreaterThanOrEqual(2);
    expect(x.threads).toBe(2);
  });

  it('challenges the original assumptions and adopts a stronger plan: one that still holds when its assumptions are taken away', () => {
    expect(x.winner).not.toBeNull();
    expect(x.winner!.challenged!.reach).toBeGreaterThan(x.greedy.challengedReach + 0.05);
    expect(x.winner!.score).toBeGreaterThan(x.greedy.score);
    // The strategy was rebuilt, not refined, and the plan Brain concludes with is the winner.
    expect(x.replaced).toBe(true);
    expect(after.best.key).not.toBe(before.best.key);
    // It rests on a move that is an estimate, not an assumption, that §99's plan did not have, and still reaches the target in most worlds.
    const beforeLabels = new Set(before.best.changes.map((c) => c.label));
    expect(after.best.changes.some((c) => c.basis === 'ESTIMATE' && !beforeLabels.has(c.label))).toBe(true);
    expect(after.best.reach).toBeGreaterThan(0.9);
    // Honesty: still coverage of assumptions, never relabelled a probability.
    expect(after.confidence.basis).toBe('COVERAGE');
    expect(renderReconstruction(after).join('\n')).toMatch(/explore .*distinct direction/);
  });

  it('a question a direction raises reaches the next discovery round', () => {
    expect(x.asks.some((a) => /referral programme/.test(a))).toBe(true);
    expect(after.searchBrief).toMatch(/referral programme/);
  });
});

describe('§101 mechanics', () => {
  it('meaningless variations are one direction, and the budget is the problem\'s, not a fixed hundred', () => {
    const a = makeDirection({ name: 'a', stance: 'X', origin: 'MODEL', thinking: '', from: 'GREEDY', program: [{ op: 'PRICE', factor: 1.5, scope: 'TOP' }] });
    const b = makeDirection({ name: 'b', stance: 'X', origin: 'MODEL', thinking: '', from: 'GREEDY', program: [{ op: 'PRICE', factor: 1.55, scope: 'TOP' }] });
    expect(a.signature).toBe(b.signature);
    expect(distinct([a, b], 10)).toHaveLength(1);
    expect(signatureOf('GREEDY', [{ op: 'FOCUS', count: 3 }])).not.toBe(signatureOf('BASELINE', [{ op: 'FOCUS', count: 3 }]));
    const small = explorationBudget({ openings: 3, operators: 4, binding: 1, reach: 0.8, required: 0.9, structural: false });
    const large = explorationBudget({ openings: 40, operators: 20, binding: 6, reach: 0.05, required: 0.9, structural: true });
    expect(small).toBeLessThan(30);
    expect(large).toBeGreaterThanOrEqual(100);
    expect(large).toBeLessThanOrEqual(120);
    expect(explorationBudget({ openings: 40, operators: 20, binding: 6, reach: 0.95, required: 0.9, structural: false })).toBe(0);
  });

  it('refuses a model method that names an operator or opening that does not exist, and accepts any stance it names', () => {
    const brief = { operators: [{ key: 'partner:referral-partner', dimension: 'PARTNER' }], openings: [{ id: 'opp_1' }] } as unknown as InventBrief;
    const parsed = parseInvented('{"methods":[{"name":"n","stance":"weird angle","thinking":"t","program":[{"op":"OPERATOR","key":"partner:","target":"opp_1"}]},{"name":"m","stance":"S","thinking":"t","program":[{"op":"OPERATOR","key":"nope"}]}]}', brief);
    expect(parsed.directions).toHaveLength(1);
    expect(parsed.directions[0]!.stance).toBe('WEIRD_ANGLE');
    expect(parsed.refused).toBe(1);
  });

  it('evaluates on threads with the same answer as inline', async () => {
    const pool = openEvaluator(2);
    const input = { ...portfolioInput, openings: GOAL_10K_OPENINGS, worlds: 300 };
    const [threaded, inline] = await Promise.all([pool.evaluate(input), inlineEvaluator().evaluate(input)]);
    await pool.close();
    expect(threaded.best?.reach).toBe(inline.best?.reach);
    expect(threaded.best?.settledP50).toBe(inline.best?.settledP50);
  });

  it('remembers what worked and starts the next exploration from it', async () => {
    await freshProject();
    await recordExploration('wst_test', x);
    await recordExploration('wst_test', x);
    const library = await loadLibrary();
    expect(library.length).toBeGreaterThan(0);
    expect(library.every((d) => d.origin === 'LIBRARY')).toBe(true);
    expect(library.map((d) => d.signature)).toContain(x.winner!.direction.signature);
    const y = await methodYield();
    expect(y.some((r) => r.origin === 'MODEL' && (r.stance === 'SUPPLIER_FIRST' || r.stance === 'TEMPO'))).toBe(true);
    expect(y.reduce((n, r) => n + r.tries, 0)).toBe(2 * x.all.length);
    // A later exploration of the same goal starts from the library.
    const again = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9, explore: { library } });
    expect(again.exploration!.byOrigin.LIBRARY).toBeGreaterThan(0);
  });
});
