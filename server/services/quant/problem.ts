/**
 * One quantitative question, end to end, from a single declarative file.
 *
 * A problem names arrangements (each composed into a reconstruction graph),
 * free-standing graphs, and optionally a portfolio over them with a target, a
 * deadline and the resources the activities share. `solveProblem`:
 *
 *   1. reconstructs every quantity each activity needs, climbing the evidence
 *      ladder and stopping where the evidence is enough;
 *   2. turns each activity's reconstructed cash and days into paired samples;
 *   3. searches combinations under the shared constraints;
 *   4. measures which activity's uncertainty could change the choice of
 *      combination, and decides for each — given the calendar — whether to
 *      research it, learn it while executing, act on the reconstruction, or
 *      ignore it.
 *
 * Pure. The same file produces the same answer, and every figure in the answer
 * carries the tier it came from, so nothing reconstructed from broad evidence
 * is ever read as a probability (`basis: COVERAGE`).
 */
import type { Estimate, QuantGraph } from '../../domain/quant.ts';
import { composeArrangement, type Arrangement } from './mechanism.ts';
import { reconstruct, ReconstructionError } from './reconstruct.ts';
import { optimizePortfolio, type Activity, type PortfolioResult } from './portfolio.ts';
import { decideResearch, type ResearchVerdict } from './deadline.ts';
import { justifiesDistribution } from './export.ts';

/** A leaf whose p10-to-p90 swing moves the reach share by less than this is not worth researching. */
export const SWING_THAT_MATTERS = 0.05;

export interface ProblemActivity {
  key: string;
  label?: string;
  /** Either an arrangement's key (its contribution is the cash) … */
  arrangement?: string;
  /** … or a graph and the node holding the cash it settles. */
  graph?: string;
  cashNode?: string;
  /** The node holding days to usable cash, in the same graph. */
  daysNode?: string;
  /** Or a fixed number of days. */
  days?: number;
  uses?: Record<string, number>;
  capital?: number;
  startDay?: number;
  riskGroup?: string;
  excludes?: string[];
  /** Days a research question about it would take, and whether doing it reveals the answer. */
  researchDays?: number;
  learnableInExecution?: boolean;
}

export interface QuantProblem {
  title: string;
  currency: string;
  arrangements?: Arrangement[];
  graphs?: Array<{ key: string; graph: QuantGraph }>;
  /** Quantities to reconstruct and report even with no portfolio. */
  report?: Array<{ graph: string; node: string }>;
  portfolio?: {
    target: number;
    deadlineDays: number;
    capacity?: Record<string, number>;
    startingCapital?: number;
    riskCorrelation?: Record<string, number>;
    activities: ProblemActivity[];
  };
}

export interface EstimateSummary {
  graph: string;
  key: string;
  label: string;
  unit: string;
  tier: Estimate['tier'];
  justified: boolean;
  p10: number;
  p50: number;
  p90: number;
  observations: number;
  collapsed: string[][];
  excluded: Estimate['excluded'];
  children: string[];
  trace: string[];
}

export interface ProblemSolution {
  title: string;
  estimates: EstimateSummary[];
  notNeeded: Array<{ graph: string; keys: string[] }>;
  portfolio: PortfolioResult | null;
  /** Per uncertain leaf: the swing in reach share between its p10 and p90, and what to do about it. */
  questions: Array<ResearchVerdict & { value: number; reachAtP10: number; reachAtP90: number }>;
  elapsedMs: number;
  /** Useful evaluations: estimates made plus combinations scored. */
  evaluations: number;
}

function summary(graph: string, est: Estimate): EstimateSummary {
  return {
    graph,
    key: est.key,
    label: est.label,
    unit: est.unit,
    tier: est.tier,
    justified: justifiesDistribution(est),
    p10: est.p10,
    p50: est.p50,
    p90: est.p90,
    observations: est.used.length,
    collapsed: est.collapsed,
    excluded: est.excluded,
    children: est.children,
    trace: est.trace,
  };
}

export function solveProblem(problem: QuantProblem, now: Date = new Date()): ProblemSolution {
  const started = Date.now();
  const graphs = new Map<string, QuantGraph>();
  const cashNodeOf = new Map<string, string>();
  for (const a of problem.arrangements ?? []) {
    const composed = composeArrangement(a);
    graphs.set(a.key, composed.graph);
    cashNodeOf.set(a.key, composed.contribution);
  }
  for (const g of problem.graphs ?? []) {
    if (graphs.has(g.key)) throw new ReconstructionError(`Two graphs are both called "${g.key}".`);
    graphs.set(g.key, g.graph);
  }
  const resolved = new Map<string, ReturnType<typeof reconstruct>>();
  const estimate = (graph: string, node: string): Estimate => {
    const g = graphs.get(graph);
    if (!g) throw new ReconstructionError(`No graph or arrangement is called "${graph}".`);
    const id = `${graph}::${node}`;
    let r = resolved.get(id);
    if (!r) {
      r = reconstruct(g, node, now);
      resolved.set(id, r);
    }
    const est = r.estimates[node];
    if (!est) throw new ReconstructionError(`"${node}" was not resolved in "${graph}".`);
    return est;
  };

  const reported: EstimateSummary[] = [];
  for (const one of problem.report ?? []) reported.push(summary(one.graph, estimate(one.graph, one.node)));

  let portfolio: PortfolioResult | null = null;
  const questions: ProblemSolution['questions'] = [];
  if (problem.portfolio) {
    const p = problem.portfolio;
    const activities: Activity[] = p.activities.map((a) => {
      const graph = a.arrangement ?? a.graph;
      if (!graph) throw new ReconstructionError(`Activity "${a.key}" names neither an arrangement nor a graph.`);
      const cashNode = a.cashNode ?? cashNodeOf.get(graph);
      if (!cashNode) throw new ReconstructionError(`Activity "${a.key}" names no node holding its cash.`);
      const cash = estimate(graph, cashNode);
      reported.push(summary(graph, cash));
      let days: number[];
      let justified = justifiesDistribution(cash);
      if (a.daysNode) {
        const d = estimate(graph, a.daysNode);
        reported.push(summary(graph, d));
        days = d.samples;
        justified = justified && justifiesDistribution(d);
      } else {
        days = cash.samples.map(() => a.days ?? 0);
      }
      const n = Math.min(cash.samples.length, days.length);
      return {
        key: a.key,
        label: a.label ?? a.key,
        cash: cash.samples.slice(0, n),
        days: days.slice(0, n),
        justified,
        uses: a.uses,
        capital: a.capital,
        startDay: a.startDay,
        riskGroup: a.riskGroup,
        excludes: a.excludes,
      };
    });
    portfolio = optimizePortfolio({ activities, target: p.target, deadlineDays: p.deadlineDays, capacity: p.capacity, startingCapital: p.startingCapital, riskCorrelation: p.riskCorrelation });

    /*
     * Which underlying unknown matters: each uncertain leaf of the best
     * combination's graphs is pinned at its own p10 and then its p90, the
     * graph is reconstructed again and the combination re-scored. The swing
     * in the share of worlds reaching the target is the leaf's weight in the
     * decision; a leaf that cannot swing it is not worth researching.
     */
    const best = portfolio.best;
    if (best) {
      const bestActs = p.activities.filter((one) => best.keys.includes(one.key));
      const slowest = Math.max(0, ...activities.filter((one) => best.keys.includes(one.key)).map((one) => {
        const sorted = [...one.days].sort((x, y) => x - y);
        return (one.startDay ?? 0) + sorted[Math.floor(sorted.length * 0.9)]!;
      }));
      for (const act of bestActs) {
        const graphKey = act.arrangement ?? act.graph!;
        const g = graphs.get(graphKey)!;
        const ests = [...resolved.entries()].filter(([id]) => id.startsWith(`${graphKey}::`)).flatMap(([, r]) => Object.values(r.estimates));
        const leaves = ests.filter((est) => {
          const node = g.nodes.find((one) => one.key === est.key);
          return node && !node.formula && est.p90 - est.p10 > Math.abs(est.p50) * 1e-6;
        });
        for (const leaf of leaves) {
          const pinned = (value: number): number => {
            const changed: QuantGraph = { ...g, nodes: g.nodes.map((one) => (one.key === leaf.key ? { ...one, observations: [], formula: undefined, assumed: undefined, min: value, max: value } : one)) };
            const acts = activities.map((one) => {
              if (one.key !== act.key) return one;
              const cash = reconstruct(changed, act.cashNode ?? cashNodeOf.get(graphKey)!, now).estimates[act.cashNode ?? cashNodeOf.get(graphKey)!]!;
              const days = act.daysNode ? reconstruct(changed, act.daysNode, now).estimates[act.daysNode]!.samples : one.days;
              const n = Math.min(cash.samples.length, days.length);
              return { ...one, cash: cash.samples.slice(0, n), days: days.slice(0, n) };
            });
            const members = acts.filter((one) => best.keys.includes(one.key));
            return optimizePortfolio({ activities: members, target: p.target, deadlineDays: p.deadlineDays, capacity: p.capacity, startingCapital: p.startingCapital, riskCorrelation: p.riskCorrelation }).ranked.find((one) => one.keys.length === members.length)?.reach ?? 0;
          };
          const low = pinned(leaf.p10);
          const high = pinned(leaf.p90);
          const swing = Math.abs(high - low);
          const verdict = decideResearch(
            { key: `${graphKey}.${leaf.key}`, informationValue: swing, changesDecision: swing >= SWING_THAT_MATTERS, researchDays: act.researchDays ?? 2, learnableInExecution: act.learnableInExecution ?? false },
            { daysLeft: p.deadlineDays, executionDaysP90: slowest },
          );
          questions.push({ ...verdict, value: swing, reachAtP10: low, reachAtP90: high });
        }
      }
      questions.sort((a, b) => b.value - a.value);
    }
  }

  // Every quantity resolved in any call, per graph; what no call needed is reported as not needed.
  const touched = new Map<string, Map<string, Estimate>>();
  for (const [id, r] of resolved) {
    const graph = id.split('::')[0]!;
    const into = touched.get(graph) ?? new Map<string, Estimate>();
    for (const [key, est] of Object.entries(r.estimates)) into.set(key, est);
    touched.set(graph, into);
  }
  for (const [graph, ests] of touched) for (const est of ests.values()) reported.push(summary(graph, est));
  const notNeeded = [...touched.entries()].map(([graph, ests]) => ({ graph, keys: graphs.get(graph)!.nodes.map((one) => one.key).filter((key) => !ests.has(key)) }));
  const evaluations = [...resolved.values()].reduce((sum, r) => sum + Object.keys(r.estimates).length, 0) + (portfolio?.searched ?? 0);
  const seen = new Set<string>();
  const estimates = reported.filter((one) => {
    const id = `${one.graph}::${one.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { title: problem.title, estimates, notNeeded, portfolio, questions, elapsedMs: Date.now() - started, evaluations };
}

export function renderSolution(s: ProblemSolution, currency: string): string {
  const r = (x: number) => (Math.abs(x) < 1 ? x.toFixed(3) : Math.abs(x) < 100 ? x.toFixed(1) : String(Math.round(x)));
  const lines: string[] = [`QUANT ${s.title}`];
  for (const e of s.estimates) {
    lines.push(`  ${e.tier.padEnd(10)} ${e.graph}.${e.key}  p10 ${r(e.p10)} · p50 ${r(e.p50)} · p90 ${r(e.p90)} ${e.unit}  ${e.justified ? 'distribution' : 'bounds only'}  (${e.observations} obs${e.collapsed.length ? `, ${e.collapsed.length} shared-data group(s) counted once` : ''})`);
    for (const t of e.trace) lines.push(`      ${t}`);
  }
  for (const n of s.notNeeded) if (n.keys.length) lines.push(`  not needed  ${n.graph}: ${n.keys.join(', ')} (a stronger route answered first)`);
  if (s.portfolio) {
    const basisWord = (b: string) => (b === 'PROBABILITY' ? 'probability' : 'coverage of tested conditions, not a probability');
    for (const one of s.portfolio.ranked.slice(0, 5)) {
      lines.push(one.feasible
        ? `  combination ${one.keys.join(' + ')}: reaches the target in ${Math.round(one.reach * 100)}% (${basisWord(one.basis)}); settled p10 ${r(one.settledP10)} · p50 ${r(one.settledP50)} · p90 ${r(one.settledP90)} ${currency}${one.capitalShort > 0 ? `; short of capital in ${Math.round(one.capitalShort * 100)}%` : ''}`
        : `  combination ${one.keys.join(' + ')}: cannot run — ${one.infeasibleBecause}`);
    }
    for (const one of s.portfolio.refused.slice(0, 5)) lines.push(`  refused     ${one.keys.join(' + ')}: ${one.reason}`);
    for (const q of s.questions) lines.push(`  question    ${q.key}: ${q.decision} — reach ${Math.round(q.reachAtP10 * 100)}% at its p10, ${Math.round(q.reachAtP90 * 100)}% at its p90 (swing ${q.value.toFixed(2)}) — ${q.reason}`);
  }
  lines.push(`  timing      ${s.elapsedMs} ms, ${s.evaluations} useful evaluation(s)`);
  return lines.join('\n');
}
