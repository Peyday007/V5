/**
 * The planningReliability grader (docs/COMPLETION-SPEC.md §2–3). Pure: it reads the
 * planner's structured output (`observe`, from a real `PlanReading`) and the case's
 * rubric, and decides in code whether the planning result is correct.
 *
 * It never reads reach against the 90% financial-outcome bar. It reads:
 *   * the planner's stance — an executable plan, or a conclusion that none is
 *     established — from the planner's own verdicts (chain complete, constructed or
 *     accepted; NOT_SUPPORTED; the links it names missing);
 *   * whether a no-plan conclusion names the decisive blocker the rubric states;
 *   * whether an executable plan respects the objective's constraints, its economics
 *     bound, its owner hours, and rests on no assumption counted as evidence;
 *   * after a changed objective, whether the plan follows the new one.
 */
import type { PlanReading } from '../../server/services/goals/plan.ts';
import type { Constraint, Link, OpeningFixture, PlanningCase } from './case.ts';

export const OUTCOMES = ['EXECUTABLE_PLAN_CORRECT', 'NO_PLAN_JUSTIFIED_CORRECT'] as const;
export const FAILURE_CLASSES = [
  'FALSE_EXECUTABLE',
  'UNJUSTIFIED_REFUSAL',
  'CONSTRAINT_VIOLATED',
  'UNSOUND_ECONOMICS',
  'UNCERTAINTY_AS_FAVOURABLE',
  'OWNER_LABOR_EXCEEDED',
  'OBJECTIVE_CHANGE_IGNORED',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
/** A failure that would send Brain executing a wrong plan; a refusal loses value but commits nothing. */
export const CRITICAL: ReadonlySet<FailureClass> = new Set(['FALSE_EXECUTABLE', 'CONSTRAINT_VIOLATED', 'UNSOUND_ECONOMICS', 'UNCERTAINTY_AS_FAVOURABLE', 'OWNER_LABOR_EXCEEDED', 'OBJECTIVE_CHANGE_IGNORED']);

/** The economic inputs a plan may not leave unestablished and still call itself executable. */
const ECONOMIC_INPUTS = ['price', 'directCost', 'capital', 'daysToCash'];

export interface ObservedMember {
  /** The fixture key, or the planner's own id for a constructed arrangement. */
  key: string;
  unestablished: string[];
  capitalLow: number | null;
  cashStructure: boolean;
  deals: number | null;
  /**
   * The deals the planner's own strategy counts on this member, agreed ones included
   * (`StrategyReading.dealsTaken`), when that strategy is the candidate or its complete chain makes the plan executable; null otherwise.
   */
  dealsCounted?: number | null;
}

/** What the grader reads of one plan reading: only structured fields, never prose. */
export interface ObservedPlan {
  stance: 'EXECUTABLE' | 'NO_PLAN';
  status: string;
  verdict: string | null;
  /** NOT_SUPPORTED's constraints to relax, or null when the planner drew no infeasibility conclusion. */
  infeasible: Constraint[] | null;
  /**
   * The objective's constraints the planner's strategies report broken (`constraintsFailed`,
   * classified by the limit each names), and those its infeasibility reasons name.
   */
  broken: Constraint[];
  members: ObservedMember[];
  /** Per opening (fixture key): the chain links the planner judged missing. */
  missing: Record<string, Link[]>;
  /** The links the conclusion names: the candidate members' missing links, or every considered opening's when there is no candidate, or the next test's when nothing was considered. */
  named: Link[];
  /** The plan's own schedule collects after the deadline. */
  collectAfterDeadline: boolean;
  /** The goal's scope as the planner read it. */
  scope: { industry: string | null; recurring: string | null; hoursPerWeek: number | null };
  targetCents: number;
  /** The evidence gate's reading of the chosen strategy, for the detail line only (never graded on). */
  gate: { verdict: string; chainComplete: boolean; conservativeSettled: number | null } | null;
}

export interface Grade {
  pass: boolean;
  outcome: (typeof OUTCOMES)[number] | null;
  failures: FailureClass[];
  detail: string;
}

/** Read the planner's stance and evidence from a real reading. `keyOf` maps an opportunity id to its fixture key. */
export function observe(p: PlanReading, keyOf: (opportunityId: string) => string): ObservedPlan {
  const candidate = p.acceptance.candidate;
  const chosen = p.strategies.find((s) => s.key === p.chosen) ?? null;
  const executable =
    p.acceptance.status !== 'NOT_SUPPORTED' &&
    !!candidate &&
    (p.acceptance.status === 'ACCEPTED' || p.acceptance.verdict === 'QUANTITATIVELY_CONSTRUCTED' || !!chosen?.chainComplete);
  const missing: Record<string, Link[]> = {};
  for (const c of p.considered) missing[keyOf(c.opportunityId)] = [...c.missing] as Link[];
  const ids = candidate?.opportunityIds ?? [];
  const named = new Set<Link>();
  for (const id of ids.length ? ids : p.considered.map((c) => c.opportunityId)) for (const l of missing[keyOf(id)] ?? []) named.add(l);
  // A strategy's own failed links name what is missing too (its links, evaluated at the deals it needs).
  if (chosen) for (const l of chosen.links) if (!l.ok) named.add(l.link as Link);
  // With no candidate and nothing considered — every opening held was left out (by the goal's own terms, its
  // tier, its age) — the conclusion's only statement of what is missing is the next test it sets.
  if (!ids.length && !p.considered.length && !chosen && p.nextTest?.link) named.add(p.nextTest.link as Link);
  const demand = new Map((p.portfolio?.demand ?? []).map((d) => [d.opportunityId, d]));
  // The deals the plan counts are the gate's own when its chosen strategy is what makes it executable
  // (a complete chain) or is the candidate; otherwise the portfolio's median new deals stand for them.
  const counted = new Map(candidate?.source === 'STRATEGY' || chosen?.chainComplete ? (chosen?.dealsTaken ?? []).map((t) => [t.opportunityId, t.deals]) : []);
  const members: ObservedMember[] = ids.map((id) => {
    const d = demand.get(id);
    return {
      dealsCounted: counted.get(id) ?? null,
      key: keyOf(id),
      unestablished: d?.unestablished ?? [],
      capitalLow: d?.capitalHeld ? d.capitalHeld.low : null,
      cashStructure: !!d?.cashStructure,
      deals: d ? d.deals.p50 : null,
    };
  });
  const scope = p.target.scope ?? null;
  const broken = new Set<Constraint>();
  for (const s of p.strategies) for (const why of s.constraintsFailed) for (const k of constraintsNamed(why)) broken.add(k);
  if (p.infeasible) for (const k of constraintsNamed(p.infeasible.reason)) broken.add(k);
  return {
    stance: executable ? 'EXECUTABLE' : 'NO_PLAN',
    status: p.acceptance.status,
    verdict: p.acceptance.verdict ?? null,
    infeasible: p.acceptance.status === 'NOT_SUPPORTED' ? (p.infeasible?.relax ?? []).map((r) => r.constraint) : null,
    broken: [...broken],
    members,
    missing,
    named: [...named],
    collectAfterDeadline: p.steps.some((s) => s.label === 'Collect payment' && (s.stage?.unscheduled ?? s.arrangement?.unscheduled) === 'AFTER_DEADLINE'),
    scope: { industry: scope?.industry ?? null, recurring: scope?.recurring ?? null, hoursPerWeek: scope?.hoursPerWeek ?? null },
    targetCents: p.target.targetCents,
    gate: chosen ? { verdict: chosen.verdict, chainComplete: chosen.chainComplete, conservativeSettled: chosen.conservativeSettled } : null,
  };
}

/**
 * Which of the objective's limits one of the planner's constraint failures names. The
 * planner states each failed limit as one sentence per limit (`constraintsFailed`,
 * `everyCaseInfeasible`), so the limit is read from the words that sentence is built on.
 */
export function constraintsNamed(sentence: string): Constraint[] {
  const out: Constraint[] = [];
  if (/owner hours|hours (?:than|this goal)|more hours/i.test(sentence)) out.push('OWNER_HOURS');
  if (/ties up|may commit|tied up|capital/i.test(sentence)) out.push('CAPITAL');
  if (/settles in|after the deadline|deadline/i.test(sentence)) out.push('DEADLINE');
  // "cannot reach the N still needed … even if every buyer it offers to agreed": the target is out of reach.
  if (/cannot reach the .* still needed/i.test(sentence)) out.push('TARGET');
  return out;
}

/** Whether the objective's words count money kept — net, profit, contribution — rather than revenue. */
export function netObjective(words: string): boolean {
  return /\b(?:net|netting|nets|profit|profits|contribution)\b/i.test(words);
}

function fixtureOf(c: PlanningCase, key: string): OpeningFixture | null {
  return c.openings.find((o) => o.key === key) ?? null;
}

/** Owner hours the plan's members take: hours a deal × the deals the plan counts, for each member the owner performs. */
export function ownerHours(c: PlanningCase, members: ObservedMember[]): number {
  let total = 0;
  for (const m of members) {
    const f = fixtureOf(c, m.key);
    if (!f || f.performer !== 'OWNER') continue;
    const deals = m.deals ?? Math.max(1, f.agreements?.length ?? 1);
    total += (f.hours ?? 0) * Math.max(1, deals);
  }
  return total;
}

/** Grade one observed planning result against the case's rubric. */
export function grade(c: PlanningCase, o: ObservedPlan): Grade {
  const g = gradeStance(c, o);
  const want = c.changedObjective && c.expect.targetAfterChange !== undefined ? Math.round(c.expect.targetAfterChange * 100) : null;
  if (want === null || o.targetCents === want) return g;
  const why = `the plan is read against ${o.targetCents / 100}, not the ${want / 100} the changed objective states`;
  return { pass: false, outcome: null, failures: [...new Set<FailureClass>(['OBJECTIVE_CHANGE_IGNORED', ...g.failures])], detail: g.pass ? why : `${g.detail}; ${why}` };
}

function gradeStance(c: PlanningCase, o: ObservedPlan): Grade {
  const e = c.expect;
  const changed = !!c.changedObjective;
  const fail = (failures: FailureClass[], detail: string): Grade => ({ pass: false, outcome: null, failures: [...new Set(failures)], detail });

  if (e.verdict === 'NO_PLAN') {
    if (o.stance === 'EXECUTABLE') {
      const used = o.members.map((m) => m.key);
      const also = memberFailures(c, o);
      return fail(
        [...(changed && (e.mustNotUse ?? []).some((k) => used.includes(k)) ? (['OBJECTIVE_CHANGE_IGNORED'] as FailureClass[]) : []), 'FALSE_EXECUTABLE', ...also.failures],
        `executable plan on [${used.join(', ')}] (${o.status}/${o.verdict}) where none is established${also.why.length ? `; ${also.why.join('; ')}` : ''}`,
      );
    }
    const b = e.blocker!;
    if (b.kind === 'INFEASIBLE') {
      const viaRelax = (o.infeasible ?? []).filter((x) => b.constraints.includes(x));
      const viaBroken = o.broken.filter((x) => b.constraints.includes(x));
      const viaLink = o.named.filter((l) => (b.links ?? []).includes(l));
      if (viaRelax.length || viaBroken.length || viaLink.length) {
        return {
          pass: true,
          outcome: 'NO_PLAN_JUSTIFIED_CORRECT',
          failures: [],
          detail: `no plan (${o.status}); names ${[...viaRelax.map((x) => `relax ${x}`), ...viaBroken.map((x) => `${x} broken`), ...viaLink].join(', ')}`,
        };
      }
      return fail(
        ['UNJUSTIFIED_REFUSAL'],
        `no plan (${o.status}${o.infeasible ? `, relax ${o.infeasible.join('/') || 'nothing'}` : ''}), but it names neither ${b.constraints.join('/')}${b.links?.length ? ` nor ${b.links.join('/')}` : ''}; broken: ${o.broken.join(', ') || 'none'}; links named: ${o.named.join(', ') || 'none'}`,
      );
    }
    if (o.infeasible) return fail(['UNJUSTIFIED_REFUSAL'], `declared arithmetically infeasible (${o.infeasible.join('/')}) where the blocker is missing evidence on ${b.links.join('/')}`);
    const named = b.opening ? (o.missing[b.opening] ?? []) : o.named;
    if (named.some((l) => b.links.includes(l))) {
      return { pass: true, outcome: 'NO_PLAN_JUSTIFIED_CORRECT', failures: [], detail: `no plan; names ${named.filter((l) => b.links.includes(l)).join(', ')}` };
    }
    return fail(['UNJUSTIFIED_REFUSAL'], `no plan (${o.status}), but it names ${named.join(', ') || 'nothing'}${b.opening ? ` on ${b.opening}` : ''}, not ${b.links.join('/')}`);
  }

  // EXECUTABLE_PLAN expected.
  if (o.stance === 'NO_PLAN') {
    return fail(
      changed && o.infeasible === null && o.members.some((m) => (e.mustNotUse ?? []).includes(m.key)) ? ['OBJECTIVE_CHANGE_IGNORED', 'UNJUSTIFIED_REFUSAL'] : ['UNJUSTIFIED_REFUSAL'],
      o.infeasible
        ? `declared infeasible (${o.infeasible.join('/')}) where an executable plan exists`
        : `no executable plan (${o.status}/${o.verdict}${o.gate ? `; gate ${o.gate.verdict}, cautious settled ${o.gate.conservativeSettled === null ? 'n/a' : Math.round(o.gate.conservativeSettled)} of ${o.targetCents / 100}` : ''}); names ${o.named.join(', ') || 'no missing link'}`,
    );
  }
  const { failures, why } = memberFailures(c, o);
  if (failures.length) return fail(failures, why.join('; '));
  return { pass: true, outcome: 'EXECUTABLE_PLAN_CORRECT', failures: [], detail: `executable on [${o.members.map((m) => m.key).join(', ')}] (${o.status}/${o.verdict})` };
}

/** What is wrong with the members of a plan the planner calls executable, read against the rubric. */
function memberFailures(c: PlanningCase, o: ObservedPlan): { failures: FailureClass[]; why: string[] } {
  const e = c.expect;
  const changed = !!c.changedObjective;
  const failures: FailureClass[] = [];
  const why: string[] = [];
  for (const m of o.members) {
    const f = fixtureOf(c, m.key);
    if ((e.mustNotUse ?? []).includes(m.key)) {
      failures.push(changed ? 'OBJECTIVE_CHANGE_IGNORED' : 'CONSTRAINT_VIOLATED');
      why.push(`uses ${m.key}, which the objective rules out`);
    }
    if (e.capitalMax !== undefined && e.capitalMax !== null && m.capitalLow !== null && m.capitalLow > e.capitalMax + 1e-9 && !m.cashStructure) {
      failures.push('CONSTRAINT_VIOLATED');
      why.push(`${m.key} ties up ${m.capitalLow} > ${e.capitalMax}`);
    }
    const unest = m.unestablished.filter((u) => ECONOMIC_INPUTS.includes(u));
    if (unest.length) {
      failures.push('UNCERTAINTY_AS_FAVOURABLE');
      why.push(`${m.key} executable on unestablished ${unest.join(', ')}`);
    }
    if (f && (f.priceBasis === 'PERSON' || f.priceContradiction !== undefined)) {
      failures.push('UNCERTAINTY_AS_FAVOURABLE');
      why.push(`${m.key}'s price is ${f.priceBasis === 'PERSON' ? 'only a person’s word' : 'contradicted by other evidence'}`);
    }
    if (f && f.cost !== undefined && f.cost !== null && f.cost > (e.maxCostShare ?? 1) * f.price - 1e-9) {
      failures.push('UNSOUND_ECONOMICS');
      why.push(`${m.key} costs ${f.cost} against a price of ${f.price}`);
    }
  }
  /*
   * A net target is met by money kept (docs/COMPLETION-SPEC.md §2 "sound economics";
   * planningReliability round 3). The deals the plan counts — its own strategy's count
   * when it is the candidate, else the portfolio's median new deals beside the
   * agreements — are priced from the case's own fixtures: each new deal at its price
   * less its direct cost, and the agreements less the cost of the larger of the lots
   * their value fills (agreements smaller than one lot share it, the lot is bought
   * whole) and their value in deals. A plan whose deals keep less than the target
   * passed on gross revenue. A member whose deal count the reading does not carry
   * cannot be judged, and the check is not made on guesses.
   */
  const net = netObjective(changed ? c.changedObjective! : c.objective);
  const counts: ({ all: number } | { fresh: number } | null)[] = o.members.map((m) => (m.dealsCounted !== undefined && m.dealsCounted !== null ? { all: m.dealsCounted } : m.deals !== null ? { fresh: m.deals } : null));
  if (net && o.members.length && counts.every((x) => x !== null)) {
    const target = o.targetCents / 100;
    let kept = 0;
    let gross = 0;
    for (const [i, m] of o.members.entries()) {
      const f = fixtureOf(c, m.key);
      if (!f) continue;
      const cost = f.cost ?? 0;
      const agreed = f.agreements ?? [];
      const n = counts[i]!;
      const fresh = Math.max(0, 'all' in n ? n.all - agreed.length : n.fresh);
      const agreedValue = agreed.reduce((a, b) => a + b, 0);
      const share = agreedValue / f.price;
      const agreedUnits = agreed.length ? Math.max(Math.min(agreed.length, Math.ceil(share - 1e-9)), share) : 0;
      const value = agreedValue + fresh * f.price;
      gross += value;
      kept += value - (agreedUnits + fresh) * cost;
    }
    if (kept < target - 0.5) {
      failures.push('UNSOUND_ECONOMICS');
      why.push(`the deals it counts keep ${Math.round(kept)} net of direct cost (${Math.round(gross)} gross) against a net target of ${Math.round(target)}`);
    }
  }
  if (o.collectAfterDeadline) {
    failures.push('CONSTRAINT_VIOLATED');
    why.push('its own schedule collects after the deadline');
  }
  if (e.ownerHoursMax !== undefined && e.ownerHoursMax !== null) {
    const hours = ownerHours(c, o.members);
    if (hours > e.ownerHoursMax + 1e-9) {
      failures.push('OWNER_LABOR_EXCEEDED');
      why.push(`owner hours ${Math.round(hours)} > ${e.ownerHoursMax}`);
    }
  }
  return { failures, why };
}
