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
  /**
   * What the end-to-end level reads (docs/COMPLETION-SPEC.md §3a): the plan's steps,
   * the alternatives it compared and what it names to resolve an unknown. Absent on an
   * observation built by hand, which the end-to-end level then cannot judge.
   */
  execution?: ObservedExecution;
}

export interface Grade {
  pass: boolean;
  outcome: (typeof OUTCOMES)[number] | null;
  failures: FailureClass[];
  detail: string;
  /**
   * The end-to-end level, graded beside the verdict and never into it: `pass`,
   * `outcome` and `failures` above are the verdict level exactly as before, so the
   * history stays comparable.
   */
  e2e: E2EGrade;
}

/* ------------------------------------------------------------------ */
/* The end-to-end level: a complete, AI-executable plan                 */
/* ------------------------------------------------------------------ */

/**
 * Why a result fails the end-to-end level (docs/COMPLETION-SPEC.md §3a). Each is read
 * from the planner's structured output — its steps and their executor records, the
 * strategies, considered and excluded openings, next tests, research priorities and
 * infeasibility — never from its prose.
 */
export const E2E_FAILURE_CLASSES = [
  /** The verdict level failed: an end-to-end pass needs a correct verdict first. */
  'VERDICT_INCORRECT',
  /** The observation carried no execution reading (a hand-built observation). */
  'NOT_OBSERVED',
  /** An executable plan's steps omit a required link: reaching buyers, fulfilment, collecting payment, paying the supplier. */
  'CHAIN_STEP_MISSING',
  /** A field the rubric needs is not in the planner's output at all — a measured gap for the planner, never guessed. */
  'STEP_FIELD_ABSENT',
  /** A step nobody performs: no executor, CAPABILITY_MISSING, or NOT_ESTABLISHED. */
  'STEP_PERFORMER_UNESTABLISHED',
  /** Brain is said to perform a step through a capability no registry declares, or to fulfil work the evidence gives to someone else. */
  'BRAIN_CAPABILITY_NOT_HELD',
  /** The fulfilment step's performer is not the fulfiller the evidence names (a subcontractor, the owner). */
  'PERFORMER_MISMATCH',
  /** A step whose cost is unestablished (null): the plan cannot say what executing it commits. */
  'STEP_COST_UNESTABLISHED',
  /** An execution step with no day. */
  'STEP_UNSCHEDULED',
  /** A later step of the transaction (order, deliver, collect, repeat) that names no step it follows. */
  'STEP_DEPENDENCY_ABSENT',
  /** Collecting payment or paying the supplier is scheduled after the deadline, or cannot be scheduled. */
  'MONEY_STEP_OUTSIDE_DEADLINE',
  /** The plan gives the owner routine, recurring work the objective allows no hours for. */
  'OWNER_ROUTINE_WORK',
  /** A step's figure differs from the economics its strategy was judged on. */
  'ECONOMICS_DRIFT',
  /** A no-plan conclusion names no measurement, research or relaxation that would resolve its blocker. */
  'RESOLUTION_ABSENT',
  /** A no-plan conclusion where openings existed, with no strategy compared and no opening considered or excluded. */
  'ALTERNATIVES_NOT_COMPARED',
  /** An opening research filed that the reading neither considered nor excluded. */
  'OPENING_UNACCOUNTED',
] as const;
export type E2EFailureClass = (typeof E2E_FAILURE_CLASSES)[number];

export interface E2EGrade {
  pass: boolean;
  failures: E2EFailureClass[];
  /** The measured gaps: each field the rubric needed and the reading did not carry. Never case wording. */
  gaps: string[];
  detail: string;
}

/** One step of the plan as the end-to-end level reads it: only structured fields. */
export interface ObservedStep {
  order: number;
  label: string;
  /** RESEARCH, VALIDATE or EXECUTE; a step its builder left unmarked is EXECUTE (`PlanStep.kind`). */
  kind: 'RESEARCH' | 'VALIDATE' | 'EXECUTE';
  /** The transaction stage, from the arrangement's or the step's own `stage` record; null when neither says. */
  stage: string | null;
  costSource: string | null;
  unscheduled: string | null;
  cost: number | null;
  startDay: { low: number; high: number } | null;
  dependsOn: number | null;
  requires: number[];
  basis: string;
  /** The executor record; null when the step carries none. */
  performer: string | null;
  operation: string | null;
  does: string | null;
  routine: boolean | null;
  capabilities: { id: string; state: string }[];
  /** The executor names a payment it makes (an approval of kind PAYMENT). */
  pays: boolean;
  /** The members (fixture keys, or the planner's ids) the step acts on: its own `openings`, else the plan's only member. */
  members: string[];
  /** Fields the rubric needs that the step does not carry (`evidence`, `price` on an offer, `hours` on owner work). */
  absent: string[];
  /** A price the step itself states, when the planner carries one. */
  price: number | null;
}

export interface ObservedExecution {
  steps: ObservedStep[];
  daysLeft: number | null;
  /** The owner hours the goal allows over its window (`TargetReading.hoursCeiling`). */
  hoursCeiling: number | null;
  strategies: number;
  /** Fixture keys of the openings considered and excluded. */
  considered: string[];
  excluded: string[];
  /** The chain links some next test, research priority or sale names a measurement for. */
  resolves: Link[];
  /** NOT_SUPPORTED's relaxations, each with a suggestion. */
  relax: Constraint[];
  /** Research priorities the reading decides to research first or learn while executing. */
  researchFirst: number;
  /** The economics each member's strategy was judged on (`portfolio.demand`): price and direct cost a deal. */
  economics: Record<string, { price: { low: number; high: number } | null; cost: { low: number; high: number } | null }>;
}

/** The operations that reach buyers (`STEP_OPERATIONS`). */
const REACH_OPERATIONS = new Set(['REACH_BUYERS', 'SEND_OFFER', 'RECRUIT_PARTNER', 'BUY_PAID_LEADS']);
const FULFIL_OPERATIONS = new Set(['BRAIN_PRODUCES', 'SUPPLIER_DELIVERS']);
/** Performers that are somebody. */
const PERFORMED = new Set(['BRAIN', 'PROVIDER', 'OWNER']);
/** Capability states that are a capability Brain declares (connected, unread, or awaiting a one-time connection the step names). */
const DECLARED = new Set(['PRESENT', 'UNREAD', 'NOT_CONNECTED']);
/** What each fixture performer is as a step performer. */
const PERFORMER_OF: Record<string, string> = { BRAIN: 'BRAIN', SUBCONTRACTOR: 'PROVIDER', OWNER: 'OWNER' };
/** The stages that follow an earlier step of the transaction. */
const FOLLOWING_STAGES = new Set(['ORDER', 'DELIVER', 'COLLECT', 'REPEAT']);

/**
 * The chain link a research priority measures, from the closed vocabulary of the model's
 * variables (`VARIABLE_FIELD`, goals/plan.ts) and the card fields research settles.
 */
const FIELD_LINK: Record<string, Link> = {
  timeToFirstCash: 'SETTLES_IN_TIME',
  directCosts: 'ECONOMICS',
  requiredCapital: 'ECONOMICS',
  revenueRange: 'OFFER_AND_PRICE',
  buyerVolume: 'MARKET_VOLUME',
};
const VARIABLE_LINK: [RegExp, Link][] = [
  [/(?:^|[:_ ])days$/, 'SETTLES_IN_TIME'],
  [/(?:^|[:_ ])(?:direct cost|cost|capital)$/, 'ECONOMICS'],
  [/(?:^|[:_ ])price$/, 'OFFER_AND_PRICE'],
  [/(?:^|[:_ ])(?:close|reply)$/, 'CONVERSION'],
  [/(?:^|[:_ ])(?:volume|market)$/, 'MARKET_VOLUME'],
  [/(?:^|[:_ ])hours$/, 'FULFILMENT'],
];
export function priorityLink(p: { variable: string; field: string | null }): Link | null {
  if (p.field && FIELD_LINK[p.field]) return FIELD_LINK[p.field]!;
  for (const [re, link] of VARIABLE_LINK) if (re.test(p.variable)) return link;
  return null;
}

/** Read the end-to-end level's inputs from a real reading (a partial one reads as carrying nothing). Pure. */
export function observeExecution(p: PlanReading, keyOf: (opportunityId: string) => string): ObservedExecution {
  const ids = p.acceptance.candidate?.opportunityIds ?? [];
  const only = ids.length === 1 ? [keyOf(ids[0]!)] : [];
  const steps: ObservedStep[] = (p.steps ?? []).map((s) => {
    const raw = s as unknown as Record<string, unknown>;
    const e = s.executor ?? null;
    const stage = s.arrangement?.stage ?? s.stage?.stage ?? null;
    const operation = e?.operation ?? null;
    const offers = stage === 'OFFER' || operation === 'SEND_OFFER';
    const absent: string[] = [];
    // The planner's step type carries a basis label, never the rows or claims a step rests on.
    if (!Array.isArray(raw['evidence']) || (raw['evidence'] as unknown[]).length === 0) absent.push('evidence');
    if (offers && typeof raw['price'] !== 'number') absent.push('price');
    if (e?.performedBy === 'OWNER' && typeof raw['hours'] !== 'number') absent.push('hours');
    return {
      order: s.order,
      label: s.label,
      kind: s.kind ?? 'EXECUTE',
      stage,
      costSource: s.arrangement?.costSource ?? s.stage?.costSource ?? null,
      unscheduled: s.arrangement?.unscheduled ?? s.stage?.unscheduled ?? null,
      cost: s.cost,
      startDay: s.startDay,
      dependsOn: s.dependsOn,
      requires: s.requires ?? [],
      basis: s.basis,
      performer: e?.performedBy ?? null,
      operation,
      does: e?.does ?? null,
      routine: e ? e.routine : null,
      capabilities: e ? e.capabilities.map((c) => ({ id: c.id, state: c.state })) : [],
      pays: !!e?.approval.reasons.some((r) => r.kind === 'PAYMENT'),
      members: s.openings?.length ? s.openings.map(keyOf) : only,
      absent,
      price: typeof raw['price'] === 'number' ? (raw['price'] as number) : null,
    };
  });
  const resolves = new Set<Link>();
  const named = (t: { link: string; test: string } | null | undefined) => {
    if (t && t.test.trim()) resolves.add(t.link as Link);
  };
  named(p.nextTest);
  for (const s of p.strategies ?? []) named(s.nextTest);
  for (const t of [...(p.marketTests ?? []), ...(p.sales ?? [])]) named(t.test);
  let researchFirst = 0;
  for (const r of p.researchPriority ?? []) {
    if (r.decision !== 'RESEARCH_FIRST' && r.decision !== 'LEARN_WHILE_EXECUTING') continue;
    researchFirst += 1;
    const link = priorityLink(r);
    if (link) resolves.add(link);
  }
  const economics: ObservedExecution['economics'] = {};
  for (const d of p.portfolio?.demand ?? []) {
    economics[keyOf(d.opportunityId)] = {
      price: d.price ? { low: d.price.p10, high: d.price.p90 } : null,
      cost: d.costHeld ? { low: d.costHeld.low, high: d.costHeld.high } : null,
    };
  }
  return {
    steps,
    daysLeft: p.target?.daysLeft ?? null,
    hoursCeiling: p.target?.hoursCeiling ?? null,
    strategies: (p.strategies ?? []).length,
    considered: (p.considered ?? []).map((c) => keyOf(c.opportunityId)),
    excluded: (p.excluded ?? []).map((x) => keyOf(x.opportunityId)),
    resolves: [...resolves],
    relax: (p.infeasible?.relax ?? []).filter((r) => r.suggestion.trim()).map((r) => r.constraint),
    researchFirst,
    economics,
  };
}

const within = (x: number, r: { low: number; high: number }) => x >= r.low * 0.99 - 0.5 && x <= r.high * 1.01 + 0.5;

/**
 * The end-to-end level of one result: the verdict level must pass, and then an
 * executable plan must be complete and executable step by step, and a no-plan
 * conclusion must say what would resolve it and show it compared the openings held.
 * Every failure is collected, not only the first, so the table counts each gap. Pure.
 */
export function gradeE2E(c: PlanningCase, o: ObservedPlan, verdict: Pick<Grade, 'pass'>): E2EGrade {
  const x = o.execution;
  if (!x) return { pass: false, failures: verdict.pass ? ['NOT_OBSERVED'] : ['VERDICT_INCORRECT', 'NOT_OBSERVED'], gaps: [], detail: 'no execution reading observed' };
  const failures = new Set<E2EFailureClass>();
  const gaps = new Set<string>();
  const why: string[] = [];
  const fail = (k: E2EFailureClass, line: string) => {
    failures.add(k);
    why.push(line);
  };
  if (!verdict.pass) failures.add('VERDICT_INCORRECT');

  const accounted = new Set([...x.considered, ...x.excluded]);
  const unaccounted = c.openings.filter((f) => !accounted.has(f.key)).map((f) => f.key);
  if (unaccounted.length) fail('OPENING_UNACCOUNTED', `${unaccounted.length} opening(s) neither considered nor excluded`);

  if (o.stance === 'EXECUTABLE') executableChecks(c, o, x, fail, gaps);
  else noPlanChecks(c, o, x, fail);

  const list = E2E_FAILURE_CLASSES.filter((k) => failures.has(k));
  return { pass: list.length === 0, failures: list, gaps: [...gaps].sort(), detail: why.join('; ') || (list.length ? 'verdict incorrect' : 'complete') };
}

function executableChecks(c: PlanningCase, o: ObservedPlan, x: ObservedExecution, fail: (k: E2EFailureClass, line: string) => void, gaps: Set<string>): void {
  const steps = x.steps;
  const e = c.expect;
  if (!steps.length) {
    fail('CHAIN_STEP_MISSING', 'an executable plan with no steps');
    return;
  }
  const fixtures = o.members.map((m) => fixtureOf(c, m.key)).filter((f): f is OpeningFixture => !!f);

  // 3. The chain's links, each as a step.
  const agreed = fixtures.reduce((sum, f) => sum + (f.agreements ?? []).reduce((a, b) => a + b, 0), 0);
  const reachNeeded = agreed < o.targetCents / 100 - 0.5;
  const missing: string[] = [];
  if (reachNeeded && !steps.some((s) => (s.stage === 'REACH' || s.stage === 'OFFER') && s.operation !== null && REACH_OPERATIONS.has(s.operation))) missing.push('buyer reach');
  if (!steps.some((s) => s.stage === 'DELIVER' || (s.operation !== null && FULFIL_OPERATIONS.has(s.operation)))) missing.push('fulfilment');
  if (!steps.some((s) => s.stage === 'COLLECT' || s.operation === 'COLLECT_PAYMENT')) missing.push('payment collection');
  const paysSupplier = fixtures.some((f) => f.performer === 'SUBCONTRACTOR' && (f.cost ?? 0) > 0);
  if (paysSupplier && !steps.some((s) => s.stage === 'ORDER' || s.operation === 'PAY_SUPPLIER' || (s.stage === 'DELIVER' && s.pays))) missing.push('supplier payment');
  if (missing.length) fail('CHAIN_STEP_MISSING', `no step for ${missing.join(', ')}`);

  // 1. Every step: what, who, the capability, cost, timing, dependencies, evidence.
  const unperformed = steps.filter((s) => s.performer === null || !PERFORMED.has(s.performer));
  if (unperformed.length) fail('STEP_PERFORMER_UNESTABLISHED', `${unperformed.length} step(s) nobody performs (${[...new Set(unperformed.map((s) => s.performer ?? 'no executor'))].join(', ')})`);
  const undeclared = steps.filter((s) => s.performer === 'BRAIN' && s.capabilities.some((k) => !DECLARED.has(k.state)));
  if (undeclared.length) fail('BRAIN_CAPABILITY_NOT_HELD', `${undeclared.length} Brain step(s) through an undeclared capability`);
  for (const s of steps.filter((one) => one.stage === 'DELIVER' || (one.operation !== null && FULFIL_OPERATIONS.has(one.operation)))) {
    for (const key of s.members) {
      const f = fixtureOf(c, key);
      if (!f || !s.performer || !PERFORMED.has(s.performer)) continue;
      const want = PERFORMER_OF[f.performer] ?? null;
      if (want === s.performer) continue;
      if (s.performer === 'BRAIN') fail('BRAIN_CAPABILITY_NOT_HELD', `Brain fulfils ${key}, which the evidence gives to ${f.performer.toLowerCase()}`);
      else fail('PERFORMER_MISMATCH', `${key} is fulfilled by ${s.performer.toLowerCase()}, the evidence names ${f.performer.toLowerCase()}`);
    }
  }
  const unpriced = steps.filter((s) => s.cost === null);
  if (unpriced.length) fail('STEP_COST_UNESTABLISHED', `${unpriced.length} step(s) with no established cost`);
  const undated = steps.filter((s) => s.kind === 'EXECUTE' && s.startDay === null && s.unscheduled !== 'AFTER_DEADLINE');
  if (undated.length) fail('STEP_UNSCHEDULED', `${undated.length} execution step(s) with no day`);
  const loose = steps.filter((s) => s.stage !== null && FOLLOWING_STAGES.has(s.stage) && s.dependsOn === null && s.requires.length === 0);
  if (loose.length) fail('STEP_DEPENDENCY_ABSENT', `${loose.length} later step(s) name nothing they follow`);
  for (const s of steps) for (const field of s.absent) gaps.add(`step.${field}`);
  if (gaps.size) fail('STEP_FIELD_ABSENT', `steps do not carry ${[...gaps].join(', ')}`);

  // Money steps inside the deadline.
  const money = steps.filter((s) => s.stage === 'COLLECT' || s.stage === 'ORDER' || s.operation === 'COLLECT_PAYMENT' || s.operation === 'PAY_SUPPLIER');
  const outside = money.filter((s) => s.startDay === null || (x.daysLeft !== null && s.startDay.high > x.daysLeft + 1e-9));
  if (outside.length) fail('MONEY_STEP_OUTSIDE_DEADLINE', `${outside.length} money step(s) ${outside.some((s) => s.startDay === null) ? 'unscheduled or ' : ''}after day ${x.daysLeft ?? '—'}`);

  // The owner does no routine work beyond what the objective allows.
  const allowed = (e.ownerHoursMax ?? 0) > 0 || (x.hoursCeiling ?? 0) > 0 || (o.scope.hoursPerWeek ?? 0) > 0;
  const routine = steps.filter((s) => s.performer === 'OWNER' && s.routine);
  if (routine.length && !allowed) fail('OWNER_ROUTINE_WORK', `${routine.length} routine owner step(s) where the objective allows no owner hours`);

  // The economics the steps use are the ones the strategy was judged on.
  for (const s of steps) {
    for (const key of s.members) {
      const judged = x.economics[key];
      if (!judged) continue;
      if (s.stage === 'DELIVER' && s.costSource === 'MODEL' && s.cost !== null && s.cost > 0) {
        if (!judged.cost) fail('ECONOMICS_DRIFT', `${key}'s delivery step commits a cost its strategy held none for`);
        else if (!within(s.cost, judged.cost)) fail('ECONOMICS_DRIFT', `${key}'s delivery step costs ${Math.round(s.cost)}, judged at ${Math.round(judged.cost.low)}–${Math.round(judged.cost.high)}`);
      }
      if (s.price !== null && judged.price && !within(s.price, judged.price)) fail('ECONOMICS_DRIFT', `${key}'s step sells at ${Math.round(s.price)}, judged at ${Math.round(judged.price.low)}–${Math.round(judged.price.high)}`);
    }
  }
}

function noPlanChecks(c: PlanningCase, o: ObservedPlan, x: ObservedExecution, fail: (k: E2EFailureClass, line: string) => void): void {
  const b = c.expect.verdict === 'NO_PLAN' ? c.expect.blocker : undefined;
  const resolvesAny = x.resolves.length > 0 || x.relax.length > 0;
  if (b?.kind === 'INFEASIBLE') {
    const ok = x.relax.some((k) => b.constraints.includes(k)) || x.resolves.some((l) => (b.links ?? []).includes(l));
    if (!ok) fail('RESOLUTION_ABSENT', `no relaxation of ${b.constraints.join('/')}${b.links?.length ? ` and no measurement of ${b.links.join('/')}` : ''} is named`);
  } else if (b?.kind === 'MISSING_EVIDENCE') {
    if (!x.resolves.some((l) => b.links.includes(l))) fail('RESOLUTION_ABSENT', `no measurement or research of ${b.links.join('/')} is named${x.resolves.length ? ` (names ${x.resolves.join(', ')})` : ''}`);
  } else if (!resolvesAny) {
    fail('RESOLUTION_ABSENT', 'no measurement, research or relaxation is named');
  }
  if (c.openings.length > 0 && (x.strategies === 0 || x.considered.length + x.excluded.length === 0)) {
    fail('ALTERNATIVES_NOT_COMPARED', `${x.strategies} strateg(ies), ${x.considered.length} considered, ${x.excluded.length} excluded`);
  }
  void o;
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
    execution: observeExecution(p, keyOf),
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
  const v = gradeVerdict(c, o);
  return { ...v, e2e: gradeE2E(c, o, v) };
}

/** The verdict level, unchanged by the end-to-end level beside it. */
function gradeVerdict(c: PlanningCase, o: ObservedPlan): Omit<Grade, 'e2e'> {
  const g = gradeStance(c, o);
  const want = c.changedObjective && c.expect.targetAfterChange !== undefined ? Math.round(c.expect.targetAfterChange * 100) : null;
  if (want === null || o.targetCents === want) return g;
  const why = `the plan is read against ${o.targetCents / 100}, not the ${want / 100} the changed objective states`;
  return { pass: false, outcome: null, failures: [...new Set<FailureClass>(['OBJECTIVE_CHANGE_IGNORED', ...g.failures])], detail: g.pass ? why : `${g.detail}; ${why}` };
}

function gradeStance(c: PlanningCase, o: ObservedPlan): Omit<Grade, 'e2e'> {
  const e = c.expect;
  const changed = !!c.changedObjective;
  const fail = (failures: FailureClass[], detail: string): Omit<Grade, 'e2e'> => ({ pass: false, outcome: null, failures: [...new Set(failures)], detail });

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
