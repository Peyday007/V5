/**
 * Puts a case through the REAL plan machinery and reads its verdict. Nothing
 * here re-implements a judgement: each kind calls the exported production path
 * and only reads its answer.
 *
 *   pathway.*, portfolio.*, information.*, rank.*  → `readPathways` (the pure
 *       reading `plan.ts` makes: `pathwayOf` per opening, `livingPortfolio`,
 *       `informationValue`), and `byCollectibility`
 *   prepayment       → `prepaymentEligible` (reconstruction.ts)
 *   scenario.*       → `bestCaseReach` (goalScenario.ts)
 *   engine.*         → `evaluateGoalPortfolio` (the quant engine every plan uses),
 *                      seeded, with no project knowledge (offline)
 *   reconstruction.* → `reconstructPlan` on the inline evaluator with exploration
 *                      off: the diagnosis, operators, greedy rounds and the
 *                      plausibility critic (C-4). The critic's flags live inside
 *                      the reconstruction's closure, so they are read from its
 *                      readings rather than called alone.
 */
import { bestCaseReach, volumeEstablished, type ModelledOpportunity } from '../../server/services/cash/goalScenario.ts';
import { byCollectibility, readPathways, type PathwayReading } from '../../server/services/goals/pathways.ts';
import { evaluateGoalPortfolio, type GoalPortfolio } from '../../server/services/goals/portfolio.ts';
import { prepaymentEligible, reconstructPlan, type Reconstruction } from '../../server/services/goals/reconstruction.ts';
import { inlineEvaluator } from '../../server/services/goals/reasoning/evaluatorPool.ts';
import { modelledOf } from '../spec.ts';
import { DEFAULT_CONTEXT, type CaseContext, type FeasibilityCase, type Verdict } from './case.ts';

/** Fixed, so an expiry and a signal date read the same on every run. */
export const BENCH_NOW = new Date('2026-11-15T00:00:00Z');
export const ENGINE_SEED = 20261115;
export const ENGINE_WORLDS = 400;
export const RECONSTRUCTION_WORLDS = 300;

export interface Judged {
  observed: Verdict;
  /** One line of what the machinery said, for the summary (public cases only). */
  detail: string;
}

function contextOf(c: FeasibilityCase): CaseContext {
  return { ...DEFAULT_CONTEXT, ...(c.context ?? {}) };
}

function pathwaysOf(openings: ModelledOpportunity[], ctx: CaseContext): PathwayReading {
  return readPathways({
    modelled: openings,
    considered: openings.map((one) => ({
      opportunityId: one.opportunity.id,
      missing: [],
      paysOnce: one.competitiveAward,
      competitiveAward: one.competitiveAward,
      volumeEstablished: volumeEstablished(one),
      potentialReach: 0,
      supportedReach: 0,
    })),
    target: {
      remainingCents: Math.round(ctx.remaining * 100),
      daysLeft: ctx.daysLeft,
      currency: 'USD',
      capitalCeilingCents: ctx.capitalCeiling === null ? null : Math.round(ctx.capitalCeiling * 100),
      capitalBeforeProofCents: ctx.beforeProof === null ? null : Math.round(ctx.beforeProof * 100),
    },
    portfolio: null,
    permissionsMissing: ctx.permissionsMissing,
    rounds: [],
    now: BENCH_NOW,
    capabilities: ctx.capabilities,
  });
}

function limitsOf(ctx: CaseContext, worlds: number) {
  return { remaining: ctx.remaining, daysLeft: ctx.daysLeft, capitalCeiling: ctx.capitalCeiling, beforeProof: ctx.beforeProof, perWeek: ctx.perWeek, resources: ctx.resources, worlds, seed: ENGINE_SEED };
}

function engineOf(openings: ModelledOpportunity[], ctx: CaseContext, worlds: number): GoalPortfolio {
  return evaluateGoalPortfolio({ ...limitsOf(ctx, worlds), openings, knowledge: null, causal: false });
}

async function reconstructionOf(openings: ModelledOpportunity[], ctx: CaseContext, worlds: number): Promise<Reconstruction> {
  const portfolio = limitsOf(ctx, worlds);
  const baseline = evaluateGoalPortfolio({ ...portfolio, openings, knowledge: null, causal: false });
  return reconstructPlan({ openings, portfolio, baseline, required: ctx.required, evaluator: inlineEvaluator(), explore: null });
}

const yes = (accept: boolean, detail: string): Judged => ({ observed: accept ? 'ACCEPT' : 'REFUSE', detail });

export async function judge(c: FeasibilityCase, options: { worlds?: number } = {}): Promise<Judged> {
  const ctx = contextOf(c);
  const subject = modelledOf(c.subject, 1);
  const openings = [subject, ...(c.others ?? []).map((o, i) => modelledOf(o, i + 2))];
  const id = subject.opportunity.id;
  const j = c.judgement;
  switch (j.kind) {
    case 'pathway.executable':
    case 'pathway.gap':
    case 'pathway.established':
    case 'pathway.repeats':
    case 'portfolio.leading':
    case 'portfolio.executable':
    case 'information.changesPlan':
    case 'rank.collectibility': {
      const reading = pathwaysOf(openings, ctx);
      const p = reading.pathways.find((one) => one.opportunityId === id);
      if (!p) return yes(false, 'no pathway was built for the subject');
      if (j.kind === 'pathway.executable') return yes(p.executable, p.executable ? 'executable' : `not executable: ${p.notExecutable.join('; ')}`);
      if (j.kind === 'pathway.gap') return yes(!p.gaps.includes(j.gap), `gaps: ${p.gaps.join(', ') || 'none'}`);
      if (j.kind === 'pathway.established') {
        const fact = p[j.fact];
        return yes(fact.status !== 'UNKNOWN' && fact.value !== null, `${j.fact} ${fact.status.toLowerCase()} ${fact.value === null ? '(no value)' : String(fact.value).slice(0, 40)}`);
      }
      if (j.kind === 'pathway.repeats') return yes(p.frequency.value === 'repeats', `frequency ${String(p.frequency.value)}`);
      if (j.kind === 'portfolio.leading') {
        const members = reading.portfolio.leading?.members ?? [];
        return yes(members.includes(id), `leading [${members.join(', ')}]${reading.portfolio.unfunded.includes(id) ? ' · subject unfunded' : ''}`);
      }
      if (j.kind === 'portfolio.executable') return yes(reading.portfolio.executable.includes(id), `executable [${reading.portfolio.executable.join(', ')}]`);
      if (j.kind === 'information.changesPlan') {
        const entries = reading.informationValue.filter((v) => v.opportunityId === id && v.variable === j.variable);
        return yes(entries.some((v) => v.changesPlan), entries.length ? entries.map((v) => `${v.variable} changesPlan=${v.changesPlan}`).join('; ') : `no ${j.variable} entry`);
      }
      const other = reading.pathways.find((one) => one.opportunityId === j.comparator);
      if (!other) return yes(false, `comparator ${j.comparator} has no pathway`);
      const order = byCollectibility(p, other, ctx.daysLeft);
      return yes(order <= 0, order <= 0 ? 'ranks at or above the comparator' : 'ranks below the comparator');
    }
    case 'prepayment': {
      const r = prepaymentEligible(subject);
      return yes(r.eligible, `${r.reading.timing}: ${r.reading.basis.slice(0, 120)}`);
    }
    case 'scenario.bestCaseReach': {
      const reach = bestCaseReach(subject, ctx.remaining, ctx.daysLeft);
      return yes(reach > 0, `best-case reach ${Math.round(reach)}`);
    }
    case 'engine.admitted':
    case 'engine.inBest':
    case 'engine.cash':
    case 'engine.repeats':
    case 'engine.established':
    case 'engine.probability': {
      const p = engineOf(openings, ctx, options.worlds ?? ENGINE_WORLDS);
      const d = p.demand.find((one) => one.opportunityId === id);
      if (!d) return yes(false, 'the engine read no demand for the subject');
      if (j.kind === 'engine.admitted') return yes(!d.refused, d.refused ? `refused: ${d.refused}` : 'admitted');
      if (j.kind === 'engine.inBest') {
        const members = p.best?.members.map((m) => m.opportunityId) ?? [];
        return yes(members.includes(id), `best [${members.join(', ')}]`);
      }
      if (j.kind === 'engine.cash') {
        // Demand revenue is booked, not settled: the combination is where cash is held to the deadline.
        const inBest = p.best?.members.some((m) => m.opportunityId === id) ?? false;
        const settled = inBest ? (p.best?.settledP90 ?? 0) : 0;
        return yes(settled > 0, inBest ? `settled p90 ${Math.round(settled)} inside the window` : 'not in the best combination');
      }
      if (j.kind === 'engine.repeats') return yes(d.deals.p90 > 1, `deals p50/p90 ${d.deals.p50.toFixed(2)}/${d.deals.p90.toFixed(2)}`);
      if (j.kind === 'engine.established') return yes(!d.unestablished.includes(j.input), `unestablished: ${d.unestablished.join(', ') || 'none'}`);
      return yes(p.basis === 'PROBABILITY', `basis ${p.basis}`);
    }
    case 'reconstruction.best':
    case 'reconstruction.prepaidLever': {
      const r = await reconstructionOf(openings, ctx, options.worlds ?? RECONSTRUCTION_WORLDS);
      if (j.kind === 'reconstruction.best') {
        const title = subject.opportunity.title.slice(0, 50);
        return yes(r.best.members.includes(title), `best ${r.best.key} [${r.best.members.join(' | ').slice(0, 120)}]${r.best.implausible?.length ? ' · flagged' : ''}`);
      }
      const tried = r.rounds.flatMap((x) => x.tried).filter((t) => t.changes.some((ch) => ch.op === 'capital:prepaid-fulfilment'));
      return yes(tried.length > 0, tried.length ? `prepaid lever tried ${tried.length}×` : 'prepaid lever not tried');
    }
  }
}
