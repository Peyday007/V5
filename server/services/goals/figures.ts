/**
 * One plan read, one set of figures (§77: a number a person reads is one of a
 * checked model's numbers, or it is not shown).
 *
 * An independent audit of one production read of goal
 * wst_7b4fcbb5f2384f31b6c3 (2026-11-24) found about a dozen figures in the
 * same `goals plan` output that contradicted each other. Each had been printed
 * from its own source with nothing saying which plan it was about:
 *
 *   * "outcome none … no outcome is read" and "candidate … settled p50 — ·
 *     reach not computed" beside "best reaches the target in 5.3% of worlds ·
 *     settled p10 334 p50 2341 p90 8361" — the second is the quant engine's
 *     best combination, a different set of legs from the plan the acceptance
 *     holds, printed as if it were the plan's;
 *   * the pathways' leading line, "net bounds low/mid/high 3.67/606/10000",
 *     said "the plan's p10/p50/p90 are the simulation's" when the simulation
 *     never ran those legs;
 *   * a leg its pathway priced at $75 was sold at $111 in the simulation;
 *   * the plan header named a hypothetical reconstruction's leg while every
 *     step was written for another.
 *
 * This module decides, from the reading alone, which figures belong to the
 * plan held and which to something else, and says so on every line that
 * prints them: a figure is reconciled with the plan's (the same simulated
 * run) or labelled as a different quantity. It hides no number. Pure.
 */
import { heldDistribution, simulatedCombination, stepsLegOf, type PlanReading, type SimulatedDistribution } from './plan.ts';

type Reading = Pick<PlanReading, 'acceptance' | 'portfolio' | 'pathways' | 'objective' | 'adoption' | 'steps' | 'lead' | 'reconstruction'>;

export interface FigureReconciliation {
  /** The plan the acceptance holds: the accepted plan, else the candidate; empty when there is none. */
  held: { ids: string[]; source: string | null; simulated: SimulatedDistribution | null };
  /** The quant engine's best combination, and whether it is the plan held (same members) or why not. */
  best: { ids: string[]; isPlan: boolean; why: string | null } | null;
  /** The pathways' leading combination: its own simulated run (null when the engine never ran exactly these legs), and whether it is the plan held. */
  leading: { ids: string[]; isPlan: boolean; simulated: SimulatedDistribution | null } | null;
  /** The leg the steps are written for, in words; null when no step names one. */
  stepsLeg: string | null;
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** Each opening's title as the reading holds it: the pathways', else the portfolio's. */
export function titlesOfReading(reading: Pick<PlanReading, 'portfolio' | 'pathways'>): Map<string, string> {
  return new Map<string, string>([
    ...(reading.portfolio?.demand ?? []).map((d) => [d.opportunityId, d.title] as const),
    ...(reading.pathways?.pathways ?? []).filter((p) => !!p.title).map((p) => [p.opportunityId, p.title] as const),
  ]);
}

/** Which figures of a reading are the held plan's, and which are something else's. Pure. */
export function reconcileFigures(reading: Reading): FigureReconciliation {
  const a = reading.acceptance;
  const ids = a.accepted?.opportunityIds?.length ? [...a.accepted.opportunityIds] : [...(a.candidate?.opportunityIds ?? [])];
  const source = a.accepted?.opportunityIds?.length ? 'ACCEPTED' : (a.candidate?.source ?? null);
  const held = { ids, source, simulated: heldDistribution(a, reading.portfolio ?? null, reading.reconstruction ?? null)?.distribution ?? null };
  const titles = titlesOfReading(reading);
  const named = (list: readonly string[]) => list.slice(0, 3).map((id) => `"${(titles.get(id) ?? id).slice(0, 50)}"`).join(', ');
  const b = reading.portfolio?.best ?? null;
  let best: FigureReconciliation['best'] = null;
  if (b) {
    const bestIds = [...new Set(b.members.map((m) => m.opportunityId))];
    const isPlan = ids.length > 0 && sameSet(bestIds, ids) && source !== 'RECONSTRUCTED';
    let why: string | null = null;
    if (!isPlan) {
      const unpriced = bestIds.filter((id) => (reading.portfolio?.demand ?? []).find((d) => d.opportunityId === id)?.unestablished.includes('price'));
      why =
        ids.length === 0
          ? 'no plan is held'
          : source === 'RECONSTRUCTED'
            ? 'the plan held is the reconstruction, read from its own run'
            : unpriced.length > 0
              ? `it counts money from ${named(unpriced)}, whose price nobody has established, so the plan cannot hold it`
              : `the plan held is ${source === 'STRATEGY' ? 'a strategy' : source === 'PATHWAYS' ? "the pathways' leading combination" : 'another combination'} with other legs`;
    }
    best = { ids: bestIds, isPlan, why };
  }
  const lead = reading.pathways?.portfolio?.leading ?? null;
  const leading = lead ? { ids: [...lead.members], isPlan: ids.length > 0 && sameSet(lead.members, ids), simulated: simulatedCombination(lead.members, reading.portfolio ?? null) } : null;
  const stepLead = reading.lead ? { key: reading.lead.arrangementKey, demand: { name: reading.lead.buyers } } : null;
  return { held, best, leading, stepsLeg: stepsLegOf(reading.steps ?? [], stepLead, titles) };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const whole = (x: number) => String(Math.round(x));

/**
 * The candidate's line: its settled median and reach are the held plan's own
 * simulated run, or both are said to be absent and why — never one without
 * the other. Null when there is no candidate. Pure.
 */
export function candidateLine(reading: Reading, f: FigureReconciliation = reconcileFigures(reading)): string | null {
  const c = reading.acceptance.candidate;
  if (!c) return null;
  const figures =
    c.settledP50 === null && c.reach === null
      ? `settled p50 — · reach — (the simulation did not run exactly these legs together${f.best && !f.best.isPlan ? '; the quant line\'s "best" is another set of legs' : ''})`
      : `settled p50 ${c.settledP50 === null ? '—' : whole(c.settledP50)} · ${c.reach === null ? 'reach —' : `reach ${pct(c.reach)} (${c.reachBasis === 'PROBABILITY' ? 'probability' : 'coverage, not a probability'})`}`;
  return `    candidate ${c.source} ${c.opportunityIds.join(' + ')} · ${figures}`;
}

/** The outcome lines, saying which plan they are about. Pure. */
export function outcomeLines(reading: Reading, f: FigureReconciliation = reconcileFigures(reading)): string[] {
  const o = reading.objective;
  if (!o) return [];
  const out: string[] = [];
  const support = o.support;
  if (o.outcome) out.push(`  outcome     ${support?.basis === 'ASSUMPTION_ONLY' ? 'ASSUMPTION-ONLY ' : ''}expected ${whole(o.outcome.expected)} · upper ${whole(o.outcome.upper)} · adverse (q${o.outcome.adverseQuantile}) ${whole(o.outcome.adverse)} · ${o.basis}`);
  else out.push(`  outcome     none · ${o.basis}`);
  if (f.best && !f.best.isPlan) out.push(`    not plan  the quant line's "best" (${f.best.ids.length} leg(s)) is not the plan held: ${f.best.why}; its reach and p10/p50/p90 are that combination's, not this plan's`);
  if (support) out.push(`    support   ${support.basis} · ${support.sentence}`);
  return out;
}

/** The plan header: which plan this is, which leg its steps are for, and a hypothetical reconstruction kept apart from both. Pure. */
export function planHeaderLines(reading: Reading, f: FigureReconciliation = reconcileFigures(reading)): string[] {
  const p = reading.adoption;
  if (!p) return [];
  const steps = f.stepsLeg ? ` · the steps below are for ${f.stepsLeg}` : '';
  if (!p.hypothetical) return [`  plan        ${p.source}${steps} · ${p.reason}`];
  return [`  plan        ${p.source}${steps}`, `    hypothetical the reconstruction is not the plan, and its legs are not the steps': ${p.reason}`];
}

/** The quant engine's best line: whether its figures are the plan held. Pure. */
export function bestLabel(f: FigureReconciliation): string {
  if (!f.best) return '';
  return f.best.isPlan ? '(the plan held) ' : `(NOT the plan held: ${f.best.why}) `;
}

/**
 * Every pair of printed figures about one thing that disagree, as sentences:
 * empty when the reading's figures reconcile. What the regression suite holds
 * a constructed reading to. Pure.
 */
export function figureContradictions(reading: Reading): string[] {
  const out: string[] = [];
  const f = reconcileFigures(reading);
  const c = reading.acceptance.candidate;
  // 1. The candidate's median and reach come from one run: the held plan's.
  if (c && !reading.acceptance.accepted) {
    const run = f.held.simulated;
    if (run) {
      if (c.settledP50 !== null && Math.abs(c.settledP50 - run.settledP50) > 0.5) out.push(`the candidate's settled p50 ${whole(c.settledP50)} is not its run's ${whole(run.settledP50)}`);
      if (c.reach !== null && Math.abs(c.reach - run.reach) > 1e-9) out.push(`the candidate's reach ${pct(c.reach)} is not its run's ${pct(run.reach)}`);
      if ((c.settledP50 === null) !== (c.reach === null)) out.push('the candidate states a median or a reach from its run, but not both');
    } else if (c.source !== 'STRATEGY' && (c.settledP50 !== null || c.reach !== null)) {
      out.push('the candidate states a simulated figure for legs the simulation never ran together');
    }
  }
  // 2. The outcome is the held plan's run, or none.
  const o = reading.objective?.outcome ?? null;
  if (o && !f.held.simulated) out.push('an outcome is stated for a plan the simulation never ran');
  // 3. A simulated price never above the price every other line prints for the same leg, unless it is said to be assumed.
  for (const d of reading.portfolio?.demand ?? []) {
    const p = reading.pathways?.pathways.find((x) => x.opportunityId === d.opportunityId);
    const top = p ? (typeof p.revenuePerDeal.high === 'number' ? p.revenuePerDeal.high : typeof p.revenuePerDeal.value === 'number' ? p.revenuePerDeal.value : null) : null;
    if (top === null || !d.unestablished.includes('price')) continue;
    if (d.price.p50 > top * (1 + 1e-6) + 1e-6) out.push(`${d.opportunityId}: the simulation sells at ${whole(d.price.p50)} a deal, above the ${top} at the top of the range its pathway prints, on a price nobody established`);
  }
  // 4. The steps' leg is named whenever steps are written for one.
  if ((reading.steps ?? []).some((s) => s.arrangement) && !f.stepsLeg) out.push('the steps are written for an arrangement the header does not name');
  return out;
}
