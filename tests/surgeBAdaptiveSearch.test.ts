/**
 * Lens S repairs to goal-strategy search (docs/intelligence-recovery/lens-S.md):
 *
 * S-10  the seed budget is allocated per stance by what each stance has
 *       yielded, with a floor so no stance goes to zero;
 * S-9   one goal re-read on the same inputs is one credit, not one per read;
 * S-16  a level that pays only beside another family's survives narrowing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { allocateSeeds, makeDirection, STANCE_FLOOR, stanceQuotas, type Direction, type Exploration } from '../server/services/goals/reasoning/directions.ts';
import { loadLibrary, loadStancePrior, methodYield, recordExploration } from '../server/services/goals/reasoning/learning.ts';
import { narrowLevels, type ScreenRow, type Variable } from '../server/services/goals/reasoning/variables.ts';
import { freshProject, teardown } from './helpers.ts';

afterAll(async () => {
  await teardown();
});

const STANCES = ['BACKWARD', 'FORWARD', 'CONSTRAINT', 'RESOURCE', 'INVERSION'];
const seedsOf = (perStance: number): Direction[] =>
  STANCES.flatMap((stance) => Array.from({ length: perStance }, (_, i) => makeDirection({ name: `${stance} ${i}`, stance, origin: 'ALGORITHM', thinking: '', from: 'BASELINE', program: [{ op: 'FOCUS', count: i + 1 + STANCES.indexOf(stance) * 20 }] })));

describe('S-10: the seed budget follows each stance\'s recorded yield', () => {
  const available = new Map(STANCES.map((s) => [s, 12]));
  const slots = 30;
  const floor = Math.max(1, Math.floor((STANCE_FLOOR * slots) / STANCES.length));

  it('with no record every stance is even', () => {
    const q = stanceQuotas(available, slots);
    expect([...q.values()].every((n) => n === slots / STANCES.length)).toBe(true);
  });

  it('shifts budget toward the stance that keeps improving plans, and every stance keeps its floor', () => {
    const prior = {
      CONSTRAINT: { tries: 40, improvements: 30, wins: 8 },
      BACKWARD: { tries: 40, improvements: 1, wins: 0 },
      FORWARD: { tries: 40, improvements: 2, wins: 0 },
      RESOURCE: { tries: 40, improvements: 0, wins: 0 },
    };
    const even = stanceQuotas(available, slots);
    const q = stanceQuotas(available, slots, prior);
    expect([...q.values()].reduce((a, b) => a + b, 0)).toBe(slots);
    expect(q.get('CONSTRAINT')!).toBeGreaterThan(even.get('CONSTRAINT')!);
    expect(q.get('CONSTRAINT')!).toBe(Math.max(...q.values()));
    expect(q.get('RESOURCE')!).toBeLessThan(even.get('RESOURCE')!);
    for (const s of STANCES) expect(q.get(s)!).toBeGreaterThanOrEqual(floor);
    // A stance nobody has tried is not punished as a failure: its uninformed posterior beats a proven loser's.
    expect(q.get('INVERSION')!).toBeGreaterThan(q.get('RESOURCE')!);
  });

  it('the pool takes the seeds in that allocation, not in generation order', () => {
    const prior = { INVERSION: { tries: 30, improvements: 25, wins: 5 }, BACKWARD: { tries: 30, improvements: 0, wins: 0 } };
    const seeds = seedsOf(12);
    const ordered = allocateSeeds(seeds, 20, prior);
    expect(ordered).toHaveLength(seeds.length);
    const head = ordered.slice(0, 20);
    const count = (s: string) => head.filter((d) => d.stance === s).length;
    // Generation order would have given BACKWARD 12 of the first 20 and INVERSION none.
    expect(count('INVERSION')).toBeGreaterThan(count('BACKWARD'));
    for (const s of STANCES) expect(count(s)).toBeGreaterThanOrEqual(Math.max(1, Math.floor((STANCE_FLOOR * 20) / STANCES.length)));
  });
});

/** A minimal exploration: two directions read, one of them improving and winning. */
function exploration(): Exploration {
  const mk = (stance: string, count: number) => makeDirection({ name: `${stance} focus ${count}`, stance, origin: 'ALGORITHM', thinking: '', from: 'BASELINE', program: [{ op: 'FOCUS', count }] });
  const reading = (reach: number) => ({ feasible: true, reach, settledP50: 0, changes: [] }) as unknown as Exploration['all'][number]['reading'];
  const win = { direction: mk('CONSTRAINT', 2), reading: reading(0.8), challenged: reading(0.7), score: 0.75, generation: 1, applied: true };
  const flat = { direction: mk('RESOURCE', 3), reading: reading(0.4), challenged: reading(0.3), score: 0.35, generation: 1, applied: true };
  return {
    all: [win, flat],
    winner: win,
    greedy: { reach: 0.4, settledP50: 0, score: 0.35, challengedReach: 0.3 },
    baseline: { reach: 0.3, settledP50: 0 },
    roles: {},
    directions: 2,
    byOrigin: { ALGORITHM: 2, MODEL: 0, LIBRARY: 0, RECOMBINED: 0, MUTATED: 0 },
    stances: ['CONSTRAINT', 'RESOURCE'],
    replaced: false,
    sentence: 'test',
    sweep: null,
  } as unknown as Exploration;
}

describe('S-9: one credit per (goal, inputs)', () => {
  it('repeated reads of one goal on the same inputs count once; new inputs or another goal count again', async () => {
    await freshProject();
    const x = exploration();
    await recordExploration('wst_a', x, 'inputs-1');
    await recordExploration('wst_a', x, 'inputs-1');
    await recordExploration('wst_a', x, 'inputs-1');
    let tries = (await methodYield()).reduce((n, r) => n + r.tries, 0);
    expect(tries).toBe(2);
    // Without a key the same exploration derives the same one.
    await recordExploration('wst_b', x);
    await recordExploration('wst_b', x);
    tries = (await methodYield()).reduce((n, r) => n + r.tries, 0);
    expect(tries).toBe(4);
    await recordExploration('wst_a', x, 'inputs-2');
    tries = (await methodYield()).reduce((n, r) => n + r.tries, 0);
    expect(tries).toBe(6);
    // The record feeds the stance allocation and the library.
    const prior = await loadStancePrior();
    expect(prior.CONSTRAINT).toMatchObject({ tries: 3, improvements: 3, wins: 3 });
    expect(prior.RESOURCE).toMatchObject({ tries: 3, improvements: 0 });
    const library = await loadLibrary();
    expect(library.map((d) => d.stance)).toEqual(['CONSTRAINT']);
  });
});

describe('S-16: an interaction-only level survives factorial narrowing', () => {
  // capacity (1 = buy more mailboxes), financing (1 = prepaid), price: capacity alone costs money, prepaid alone
  // costs close rate, together they pay; every other level is a modest gain on its own.
  const variables: Array<Pick<Variable, 'family' | 'levels'>> = [
    { family: 'MONEY_CAPACITY', levels: [{}, {}, {}] as Variable['levels'] },
    { family: 'FINANCING', levels: [{}, {}, {}] as Variable['levels'] },
    { family: 'PRICE', levels: [{}, {}, {}] as Variable['levels'] },
  ];
  const score = ([a, b, c]: number[]) => (a === 1 ? -0.1 : a === 2 ? 0.05 : 0) + (b === 1 ? -0.05 : b === 2 ? 0.05 : 0) + (c === 1 ? 0.04 : c === 2 ? 0.06 : 0) + (a === 1 && b === 1 ? 0.35 : 0);
  const rows: ScreenRow[] = [];
  for (let rep = 0; rep < 4; rep++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) rows.push({ levels: [a, b, c], score: score([a, b, c]) });
  const sums = variables.map((v) => v.levels.map(() => ({ n: 0, s: 0 })));
  for (const r of rows) r.levels.forEach((l, j) => ((sums[j]![l]!.n += 1), (sums[j]![l]!.s += r.score)));
  const meanOf = (j: number, l: number) => sums[j]![l]!.s / sums[j]![l]!.n;
  const budget = 8;

  it('main effect alone drops it first', () => {
    const live = narrowLevels(variables, [], meanOf, budget);
    expect(live[0]).not.toContain(1);
  });

  it('the screen\'s top interaction protects capacity × prepaid, and the factorial still fits its budget', () => {
    const live = narrowLevels(variables, rows, meanOf, budget);
    expect(live[0]).toContain(1);
    expect(live[1]).toContain(1);
    expect(live.reduce((n, l) => n * l.length, 1)).toBeLessThanOrEqual(budget);
    // The best combination is still in the factorial.
    const best = [1, 1, 2];
    expect(best.every((l, j) => live[j]!.includes(l))).toBe(true);
  });

  it('protection yields when nothing else is left to drop', () => {
    const live = narrowLevels(variables, rows, meanOf, 1);
    expect(live.reduce((n, l) => n * l.length, 1)).toBe(1);
  });
});
