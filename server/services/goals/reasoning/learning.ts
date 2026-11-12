/**
 * What Brain learns about its own reasoning (§101).
 *
 * Every direction an exploration evaluated is a row in `reasoning_methods`,
 * keyed by its program's signature: how often it was tried, how often it
 * improved the plan as held, how often it won, and by how much. The next
 * exploration — of this goal or any other — starts from the methods that
 * worked, ranked by an upper confidence bound, so a method tried once and
 * lucky does not crowd out one that works every time, and a method nobody has
 * tried much still gets its turn. Discoveries outlive the plan read that found
 * them. Each exploration is also one append-only `reasoning_explorations` row:
 * what ran, what won, and whether the strategy was replaced.
 */
import { getDb } from '../../../db/database.ts';
import { newId, nowIso } from '../../../repos/util.ts';
import { makeDirection, type Direction, type Exploration, type Origin, type Transform } from './directions.ts';
import type { Strategy } from './variables.ts';

/** What a plan read's variable sweep concluded, small enough for one row (§102). */
export function sweepSummary(x: Exploration) {
  const w = x.sweep!;
  const engine = new Map(x.all.map((r) => [r.direction.signature, r]));
  const strat = (s: Strategy | null) => (s ? { label: s.label.slice(0, 200), mean: Math.round(s.reading.mean), p10: Math.round(s.reading.p10), reach: s.reading.reach, challenged: s.challenged.reach, committed: Math.round(s.reading.committed), assumptions: s.assumptions.slice(0, 6) } : null);
  return {
    variations: w.variations,
    equivalent: w.equivalent,
    space: w.space,
    counts: { screened: w.screened, factorial: w.factorial, local: w.local, conditions: w.conditionReads },
    elapsedMs: w.elapsedMs,
    variables: w.variables.map((v) => `${v.family}:${v.levels}${v.fixed ? ':fixed' : ''}`),
    conditions: w.conditions.length,
    approaches: w.approaches.map((a) => `${a.approach}:${a.evaluated}/${a.improved}`),
    baseline: { mean: Math.round(w.baseline.mean), reach: w.baseline.reach },
    supported: strat(w.bestSupported),
    mathematical: strat(w.bestMathematical),
    requirements: w.requirements.map((r) => ({ condition: r.condition, needed: r.needed, evidencedTop: r.evidencedTop, inEvidence: r.inEvidence })),
    sensitive: w.sensitive.slice(0, 5),
    engine: w.directions.map((d) => {
      const r = engine.get(d.signature);
      return { stance: d.stance, name: d.name.slice(0, 160), reach: r?.reading.reach ?? null, p50: r ? Math.round(r.reading.settledP50) : null, challenged: r?.challenged?.reach ?? null };
    }),
  };
}
import type { ReasoningMethodRow } from '../../../domain/types.ts';

const MATERIAL = 0.02;
export const LIBRARY_SIZE = 24;

export function ucb(row: Pick<ReasoningMethodRow, 'tries' | 'total_lift' | 'improvements' | 'wins'>, totalTries: number): number {
  const tries = Math.max(1, Number(row.tries));
  const mean = Number(row.total_lift) / tries;
  const hit = Number(row.improvements) / tries;
  // A method that won — the strongest plan once challenged, which may trade reach for robustness — is the strongest signal.
  const won = Number(row.wins ?? 0) / tries;
  return mean + 0.25 * hit + 0.5 * won + 0.15 * Math.sqrt(Math.log(Math.max(2, totalTries)) / tries);
}

/** The methods to start the next exploration from: those that worked best, as directions. */
export async function loadLibrary(limit = LIBRARY_SIZE): Promise<Direction[]> {
  const rows = await getDb().all<ReasoningMethodRow>('SELECT * FROM reasoning_methods WHERE improvements > 0 OR wins > 0 ORDER BY wins DESC, best_lift DESC, signature LIMIT 400', []);
  if (rows.length === 0) return [];
  const total = rows.reduce((n, r) => n + Number(r.tries), 0);
  return rows
    .map((r) => ({ r, score: ucb(r, total) }))
    // Ties broken by signature: Postgres returns tied rows in any order, and the library's order steers the exploration.
    .sort((a, b) => b.score - a.score || (a.r.signature < b.r.signature ? -1 : a.r.signature > b.r.signature ? 1 : 0))
    .slice(0, limit)
    .flatMap(({ r }) => {
      try {
        const parsed = JSON.parse(r.program) as { from: Direction['from']; program: Transform[] };
        return [makeDirection({ name: r.name, stance: r.stance, origin: 'LIBRARY', thinking: r.thinking, from: parsed.from, program: parsed.program })];
      } catch {
        return [];
      }
    });
}

/** Record what an exploration learned: every direction tried, and one row for the exploration itself. */
export async function recordExploration(goalId: string, x: Exploration): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const base = x.baseline.reach;
  for (const r of x.all) {
    const d = r.direction;
    const lift = r.reading.feasible ? r.reading.reach - base : 0;
    const improved = lift >= MATERIAL ? 1 : 0;
    const won = x.winner && x.winner.direction.signature === d.signature ? 1 : 0;
    // A library method keeps the origin it was discovered with; only its record grows.
    const origin: Origin = d.origin === 'LIBRARY' ? 'ALGORITHM' : d.origin;
    await db.run(
      `INSERT INTO reasoning_methods (id, signature, name, stance, origin, thinking, program, tries, improvements, wins, total_lift, best_lift, first_goal_id, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (signature) DO UPDATE SET
         tries = reasoning_methods.tries + 1,
         improvements = reasoning_methods.improvements + excluded.improvements,
         wins = reasoning_methods.wins + excluded.wins,
         total_lift = reasoning_methods.total_lift + excluded.total_lift,
         best_lift = CASE WHEN excluded.best_lift > reasoning_methods.best_lift THEN excluded.best_lift ELSE reasoning_methods.best_lift END,
         last_used_at = excluded.last_used_at`,
      [newId('rsm'), d.signature, d.name.slice(0, 200), d.stance, origin, d.thinking.slice(0, 500), JSON.stringify({ from: d.from, program: d.program }), improved, won, lift, lift, goalId, now, now],
    );
  }
  await db.run(
    `INSERT INTO reasoning_explorations (id, goal_id, directions, model_directions, stances, baseline_reach, greedy_reach, best_reach, best_method, replaced, summary, variations, variables, sweep, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('rsx'), goalId, x.directions, x.byOrigin.MODEL, x.stances.length, base, x.greedy.reach, x.winner?.reading.reach ?? x.greedy.reach, x.winner?.direction.name.slice(0, 200) ?? null, x.replaced ? 1 : 0, x.sentence.slice(0, 1000), x.sweep?.variations ?? 0, x.sweep ? x.sweep.variables.length + x.sweep.conditions.length : 0, x.sweep ? JSON.stringify(sweepSummary(x)) : null, now],
  );
}

/** Which ways of reasoning have worked, by stance and origin: the answer to "which methods work best". */
export async function methodYield(): Promise<Array<{ stance: string; origin: string; methods: number; tries: number; improvements: number; wins: number; meanLift: number }>> {
  const rows = await getDb().all<{ stance: string; origin: string; methods: number | string; tries: number | string; improvements: number | string; wins: number | string; lift: number | string }>(
    `SELECT stance, origin, COUNT(*) AS methods, SUM(tries) AS tries, SUM(improvements) AS improvements, SUM(wins) AS wins, SUM(total_lift) AS lift
       FROM reasoning_methods GROUP BY stance, origin ORDER BY SUM(wins) DESC, SUM(improvements) DESC`,
    [],
  );
  return rows.map((r) => ({ stance: r.stance, origin: r.origin, methods: Number(r.methods), tries: Number(r.tries), improvements: Number(r.improvements), wins: Number(r.wins), meanLift: Number(r.tries) > 0 ? Number(r.lift) / Number(r.tries) : 0 }));
}

export async function recentExplorations(goalId: string, limit = 5): Promise<Array<{ created_at: string; directions: number; model_directions: number; best_reach: number; greedy_reach: number; best_method: string | null; replaced: number; variations: number; variables: number }>> {
  return getDb().all('SELECT created_at, directions, model_directions, best_reach, greedy_reach, best_method, replaced, variations, variables FROM reasoning_explorations WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?', [goalId, limit]);
}
