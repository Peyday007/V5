/**
 * The planner for a goal with no cash target (G-1).
 *
 * `plan.ts` plans a cash target and nothing else: a goal such as "build or
 * expand a cleaning business in Harrisburg", "cut our research rounds'
 * no-report rate below 20%" or "launch a product with three dependent
 * workstreams" got no strategy, no critique and no revision. This is that
 * goal's planner, built from what Brain already has:
 *
 *   1. Interpret (code): the goal's own words → objective, constraints, the
 *      success measure (or the question that it is unknown — invariant 39),
 *      the resources stated.
 *   2. Generate (free lane, §101): four or more strategies that differ in
 *      mechanism, each with dependent steps, resources, time, cost, risks,
 *      labelled assumptions, what evidence would change it and kill criteria.
 *      When an industry is named, §92's `goalConstruction` is read and its
 *      decision and research questions go in as evidence.
 *   3. Critique: a second, adversarial call — the lane's other model when it
 *      has one — attacks each strategy; code adds the checks it can make
 *      itself (budget, deadline, dependency order).
 *   4. Revise once what had a critical finding, critique it again, and reject
 *      what is still critical, with the reasons.
 *   5. Decide (code, never the model): PLAN_READY, NEEDS_EVIDENCE with the
 *      questions that would decide it, or NOT_SUPPORTED naming the constraint
 *      every strategy fails. A malformed answer is refused and the reading is
 *      DEGRADED; nothing here fabricates success.
 *
 * The model's words are a reading's content (§8): they are stored in
 * `goal_objective_readings` and change no other row. Every answer is
 * validated before it is read, as `invent.ts` validates its methods, and an
 * assumption that cites a source Brain did not give it is relabelled an
 * assumption.
 */
import { createHash } from 'node:crypto';
import { httpCompleter, laneConfig, type Completer, type LaneConfig } from '../cheap/lane.ts';
import { getDb } from '../../db/database.ts';
import { getWorkstream, listLinks, recordWorkstreamEvent } from '../../repos/register.ts';
import { recordEvent } from '../../repos/events.ts';
import { getObjectiveReadingByKey, insertObjectiveReading, type ObjectiveReadingRecord, type ObjectiveVerdict } from '../../repos/objectiveReadings.ts';
import { interpretIntent, readCapital, readGeography } from '../industry/construction/intent.ts';
import { goalConstruction } from '../industry/construction/service.ts';
import type { Workstream } from '../../domain/register.ts';

export const OBJECTIVE_REFRESH_MS = 6 * 3_600_000;
export const OBJECTIVE_MIN_STRATEGIES = 4;
export const OBJECTIVE_CALL_TIMEOUT_MS = 60_000;
const MAX_STRATEGIES = 8;
const MAX_STEPS = 12;

// ---------------------------------------------------------------------------
// 1. Interpretation (code)
// ---------------------------------------------------------------------------

export type ConstraintKind = 'BUDGET' | 'DEADLINE' | 'QUANTITY' | 'RATE' | 'STATED_RULE';

export interface ObjectiveConstraint {
  id: string;
  kind: ConstraintKind;
  statement: string;
  /** BUDGET in dollars, DEADLINE in days, QUANTITY a count, RATE a percentage. */
  value: number | null;
  unit: string | null;
}

export interface ObjectiveInterpretation {
  objective: string;
  constraints: ObjectiveConstraint[];
  /** Null when the goal states none: then `questions` asks for it. */
  successMeasure: { statement: string; from: 'OUTCOME' | 'STATED' } | null;
  resources: string[];
  industry: string | null;
  geography: string | null;
  questions: string[];
}

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

function count(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ''));
  if (Number.isFinite(n)) return n;
  return WORD_NUMBERS[raw.toLowerCase()] ?? null;
}

/** The industry a business objective names, as §92 reads it, or "a cleaning business" → "cleaning". */
export function objectiveIndustry(text: string): string | null {
  const read = interpretIntent(text).industry;
  if (read) return read;
  const m = /\b(?:a|an|the|our|my)\s+([a-z][a-z-]+(?:\s[a-z][a-z-]+)?)\s+(?:business|company|firm|agency|service|shop|practice)\b/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** Pure: the goal's own words, read into an objective. Nothing is inferred that the words do not say. */
export function interpretObjective(goal: Pick<Workstream, 'title' | 'intent' | 'outcome' | 'dueAt'>, now: Date = new Date()): ObjectiveInterpretation {
  const text = [goal.title, goal.intent, goal.outcome].filter((one): one is string => !!one && !!one.trim()).join('. ').replace(/\s+/g, ' ').trim();
  const constraints: ObjectiveConstraint[] = [];
  const capital = readCapital(text);
  if (capital) constraints.push({ id: 'budget', kind: 'BUDGET', statement: `spend at most $${Math.round(capital.high).toLocaleString('en-US')}`, value: capital.high, unit: 'USD' });
  const deadline = /\b(?:in|within|over|by|inside)\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month|year)s?\b/i.exec(text);
  if (deadline) {
    const n = count(deadline[1]!);
    if (n !== null) constraints.push({ id: 'deadline', kind: 'DEADLINE', statement: `done within ${deadline[0].replace(/^\w+\s+/, '')}`, value: n * UNIT_DAYS[deadline[2]!.toLowerCase()]!, unit: 'days' });
  } else if (goal.dueAt) {
    const days = Math.max(0, Math.ceil((Date.parse(goal.dueAt) - now.getTime()) / 86_400_000));
    if (Number.isFinite(days)) constraints.push({ id: 'deadline', kind: 'DEADLINE', statement: `done by ${goal.dueAt.slice(0, 10)} (${days} days)`, value: days, unit: 'days' });
  }
  const quantity = /\b(?:open|opening|launch|build|hire|sign|win|reach|ship|close|serve|add|recruit|onboard)\s+(\d[\d,]*|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\s+(?:new\s+)?([a-z][a-z-]+)/i.exec(text);
  if (quantity) {
    const n = count(quantity[1]!);
    if (n !== null) constraints.push({ id: 'quantity', kind: 'QUANTITY', statement: quantity[0], value: n, unit: quantity[2]!.toLowerCase() });
  }
  const rate = /\b(below|under|above|over|at least|at most|less than|more than)\s+(\d+(?:\.\d+)?)\s?%/i.exec(text);
  if (rate) constraints.push({ id: 'rate', kind: 'RATE', statement: rate[0], value: Number(rate[2]), unit: '%' });
  const intent = interpretIntent(text);
  // §92's HARD requirements beyond the budget, which is read above.
  for (const r of intent.requirements.filter((one) => one.from === 'OPERATOR' && one.kind === 'HARD' && one.id !== 'capital').slice(0, 4)) {
    constraints.push({ id: `rule_${r.id}`.slice(0, 40), kind: 'STATED_RULE', statement: r.statement, value: null, unit: null });
  }
  const outcome = goal.outcome?.trim();
  const successMeasure = outcome
    ? { statement: outcome, from: 'OUTCOME' as const }
    : rate
      ? { statement: `the measured rate is ${rate[0]}`, from: 'STATED' as const }
      : quantity
        ? { statement: `${quantity[0]} done`, from: 'STATED' as const }
        : null;
  const questions = successMeasure ? [] : ['What observable result would show this objective is achieved, and by when? (No success measure is stated; an unknown never makes a plan ready.)'];
  const resources = [...intent.assets, ...(capital ? [`capital $${Math.round(capital.high).toLocaleString('en-US')}`] : [])];
  return {
    objective: text,
    constraints,
    successMeasure,
    resources,
    industry: objectiveIndustry(text),
    geography: intent.geography ?? readGeography(text),
    questions,
  };
}

// ---------------------------------------------------------------------------
// 2–4. The model's answers, validated
// ---------------------------------------------------------------------------

export interface StrategyStep {
  id: string;
  action: string;
  dependsOn: string[];
  days: number | null;
}

export interface StrategyAssumption {
  statement: string;
  basis: 'EVIDENCE' | 'ASSUMPTION';
  /** A ref Brain gave the model; an EVIDENCE claim without one is relabelled ASSUMPTION. */
  source: string | null;
}

export interface ObjectiveStrategy {
  key: string;
  name: string;
  mechanism: string;
  summary: string;
  steps: StrategyStep[];
  resources: string[];
  timeDays: { low: number; high: number };
  costUsd: { low: number; high: number };
  risks: string[];
  assumptions: StrategyAssumption[];
  wouldChange: string[];
  killCriteria: string[];
}

export const FINDING_KINDS = ['UNSUPPORTED_ASSUMPTION', 'MISSING_DEPENDENCY', 'INFEASIBLE_TIMING', 'CONSTRAINT_CONFLICT', 'OTHER'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface CritiqueFinding {
  strategy: string;
  kind: FindingKind;
  severity: Severity;
  detail: string;
  /** The stated constraint the finding is about, when it is about one. */
  constraint: string | null;
  by: 'MODEL' | 'CODE';
}

function jsonBody(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[0]);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, max = 8): string[] => (Array.isArray(v) ? v.map((one) => str(one, 300)).filter(Boolean).slice(0, max) : []);
function range(v: unknown): { low: number; high: number } | null {
  const r = v as Record<string, unknown> | null;
  const low = Number(r?.['low']);
  const high = Number(r?.['high']);
  if (!r || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) return null;
  return { low, high };
}

/** One strategy, or null when it is off-shape. `sources` are the refs an EVIDENCE label may cite. */
export function parseStrategy(raw: unknown, sources: ReadonlySet<string>, key: string): ObjectiveStrategy | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const name = str(r['name'], 120);
  const mechanism = str(r['mechanism'], 300);
  const timeDays = range(r['timeDays']);
  const costUsd = range(r['costUsd']);
  const killCriteria = strList(r['killCriteria']);
  if (!name || !mechanism || !timeDays || !costUsd || killCriteria.length === 0 || !Array.isArray(r['steps']) || !Array.isArray(r['assumptions'])) return null;
  const steps: StrategyStep[] = [];
  for (const s of (r['steps'] as unknown[]).slice(0, MAX_STEPS)) {
    const x = s as Record<string, unknown> | null;
    const id = str(x?.['id'], 20);
    const action = str(x?.['action'], 300);
    if (!id || !action || steps.some((one) => one.id === id)) return null;
    const days = Number(x?.['days']);
    steps.push({ id, action, dependsOn: strList(x?.['dependsOn'], 12), days: Number.isFinite(days) && days >= 0 ? days : null });
  }
  const assumptions: StrategyAssumption[] = [];
  for (const a of (r['assumptions'] as unknown[]).slice(0, 12)) {
    const x = a as Record<string, unknown> | null;
    const statement = str(x?.['statement'], 300);
    if (!statement) continue;
    const source = str(x?.['source'], 200);
    const cited = x?.['basis'] === 'EVIDENCE' && sources.has(source);
    assumptions.push({ statement, basis: cited ? 'EVIDENCE' : 'ASSUMPTION', source: cited ? source : null });
  }
  if (steps.length === 0 || assumptions.length === 0) return null;
  return {
    key,
    name,
    mechanism,
    summary: str(r['summary'], 600),
    steps,
    resources: strList(r['resources']),
    timeDays,
    costUsd,
    risks: strList(r['risks']),
    assumptions,
    wouldChange: strList(r['wouldChange']),
    killCriteria,
  };
}

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 3));

/** Whether two mechanisms are the same idea worded twice (a percentage variant is not a strategy). */
export function sameMechanism(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both) >= 0.7;
}

/** The strategies in an answer, numbered after `held`, distinct in mechanism from them and each other. */
export function parseStrategies(text: string, sources: ReadonlySet<string>, held: ObjectiveStrategy[]): { strategies: ObjectiveStrategy[]; proposed: number; refused: number; duplicate: number } {
  const body = jsonBody(text);
  const list = body?.['strategies'];
  if (!Array.isArray(list)) return { strategies: [], proposed: 0, refused: 1, duplicate: 0 };
  const out: ObjectiveStrategy[] = [];
  let refused = 0;
  let duplicate = 0;
  for (const raw of list.slice(0, MAX_STRATEGIES * 2)) {
    const parsed = parseStrategy(raw, sources, `S${held.length + out.length + 1}`);
    if (!parsed) {
      refused += 1;
      continue;
    }
    if ([...held, ...out].some((one) => sameMechanism(one.mechanism, parsed.mechanism))) {
      duplicate += 1;
      continue;
    }
    out.push(parsed);
  }
  return { strategies: out, proposed: list.length, refused, duplicate };
}

/** The critic's findings, or null when the answer is off-shape. A finding about an unknown strategy is refused. */
export function parseCritique(text: string, keys: ReadonlySet<string>, constraints: ReadonlySet<string>): { findings: CritiqueFinding[]; refused: number } | null {
  const body = jsonBody(text);
  const list = body?.['findings'];
  if (!Array.isArray(list)) return null;
  const findings: CritiqueFinding[] = [];
  let refused = 0;
  for (const raw of list.slice(0, 80)) {
    const r = raw as Record<string, unknown> | null;
    const strategy = str(r?.['strategy'], 20);
    const kind = str(r?.['kind'], 40).toUpperCase() as FindingKind;
    const severity = str(r?.['severity'], 20).toUpperCase() as Severity;
    const detail = str(r?.['detail'], 400);
    if (!keys.has(strategy) || !FINDING_KINDS.includes(kind) || !SEVERITIES.includes(severity) || !detail) {
      refused += 1;
      continue;
    }
    const constraint = str(r?.['constraint'], 40);
    findings.push({ strategy, kind, severity, detail, constraint: constraints.has(constraint) ? constraint : null, by: 'MODEL' });
  }
  return { findings, refused };
}

/** What code can check itself: the stated budget and deadline, and the order of the steps. */
export function codeFindings(s: ObjectiveStrategy, interp: ObjectiveInterpretation): CritiqueFinding[] {
  const out: CritiqueFinding[] = [];
  for (const c of interp.constraints) {
    if (c.kind === 'BUDGET' && c.value !== null && s.costUsd.low > c.value)
      out.push({ strategy: s.key, kind: 'CONSTRAINT_CONFLICT', severity: 'CRITICAL', detail: `its lowest cost, $${Math.round(s.costUsd.low).toLocaleString('en-US')}, exceeds the stated budget (${c.statement})`, constraint: c.id, by: 'CODE' });
    if (c.kind === 'DEADLINE' && c.value !== null && s.timeDays.low > c.value)
      out.push({ strategy: s.key, kind: 'INFEASIBLE_TIMING', severity: 'CRITICAL', detail: `its fastest time, ${s.timeDays.low} days, exceeds the stated deadline (${c.statement})`, constraint: c.id, by: 'CODE' });
  }
  const ids = new Set(s.steps.map((one) => one.id));
  for (const step of s.steps)
    for (const dep of step.dependsOn)
      if (!ids.has(dep)) out.push({ strategy: s.key, kind: 'MISSING_DEPENDENCY', severity: 'CRITICAL', detail: `step ${step.id} depends on "${dep}", which no step provides`, constraint: null, by: 'CODE' });
  // A cycle: no order exists in which the steps can be done.
  const done = new Set<string>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const step of s.steps)
      if (!done.has(step.id) && step.dependsOn.every((d) => done.has(d) || !ids.has(d))) {
        done.add(step.id);
        moved = true;
      }
  }
  if (done.size < s.steps.length) out.push({ strategy: s.key, kind: 'MISSING_DEPENDENCY', severity: 'CRITICAL', detail: 'its steps depend on each other in a cycle, so no order can do them', constraint: null, by: 'CODE' });
  return out;
}

// ---------------------------------------------------------------------------
// 5. The decision (code)
// ---------------------------------------------------------------------------

export interface JudgedStrategy {
  strategy: ObjectiveStrategy;
  /** The first version, when a revision replaced it. */
  original: ObjectiveStrategy | null;
  status: 'SURVIVED' | 'REJECTED';
  /** The findings of the last critique this strategy received. */
  findings: CritiqueFinding[];
  rejectedBecause: string[];
}

export interface ObjectiveDecision {
  verdict: Exclude<ObjectiveVerdict, 'DEGRADED'>;
  chosen: string | null;
  ranking: { key: string; name: string; majors: number; assumptionShare: number; constraintsChecked: number }[];
  reasons: string[];
  questions: string[];
  failedConstraint: { id: string; statement: string; strategiesFailing: number } | null;
}

export function assumptionShare(s: ObjectiveStrategy): number {
  return s.assumptions.length ? s.assumptions.filter((a) => a.basis === 'ASSUMPTION').length / s.assumptions.length : 1;
}

const constraintFindings = (j: JudgedStrategy): CritiqueFinding[] => j.findings.filter((f) => f.severity === 'CRITICAL' && f.constraint !== null);

/** Pure. The verdict is code's, on the validated strategies and findings; the model never decides it. */
export function decideObjective(interp: ObjectiveInterpretation, judged: JudgedStrategy[], extraQuestions: string[] = []): ObjectiveDecision {
  const survivors = judged.filter((j) => j.status === 'SURVIVED');
  const checkable = interp.constraints.filter((c) => (c.kind === 'BUDGET' || c.kind === 'DEADLINE') && c.value !== null).length;
  const ranked = survivors
    .map((j) => ({
      j,
      majors: j.findings.filter((f) => f.severity === 'MAJOR').length,
      share: assumptionShare(j.strategy),
    }))
    .sort((a, b) => a.majors - b.majors || a.share - b.share || a.j.strategy.costUsd.low - b.j.strategy.costUsd.low || a.j.strategy.key.localeCompare(b.j.strategy.key));
  const ranking = ranked.map((r) => ({ key: r.j.strategy.key, name: r.j.strategy.name, majors: r.majors, assumptionShare: Math.round(r.share * 100) / 100, constraintsChecked: checkable }));
  const dedupe = (list: string[]) => [...new Set(list.map((q) => q.trim()).filter(Boolean))].slice(0, 12);
  if (ranked.length === 0) {
    const failing = new Map<string, number>();
    for (const j of judged) for (const id of new Set(constraintFindings(j).map((f) => f.constraint!))) failing.set(id, (failing.get(id) ?? 0) + 1);
    const everyFails = judged.length > 0 && judged.every((j) => constraintFindings(j).length > 0);
    if (everyFails) {
      const [id, n] = [...failing.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
      const c = interp.constraints.find((one) => one.id === id)!;
      return {
        verdict: 'NOT_SUPPORTED',
        chosen: null,
        ranking,
        reasons: [`Every one of ${judged.length} strategies fails a stated constraint; ${n} fail "${c.statement}".`, ...judged.map((j) => `${j.strategy.key} ${j.strategy.name}: ${j.rejectedBecause.join('; ')}`)].slice(0, 12),
        questions: dedupe([`Can the constraint "${c.statement}" be relaxed? No strategy found meets it.`, ...interp.questions]),
        failedConstraint: { id, statement: c.statement, strategiesFailing: n },
      };
    }
    return {
      verdict: 'NEEDS_EVIDENCE',
      chosen: null,
      ranking,
      reasons: [`All ${judged.length} strategies were rejected after revision, not all on a stated constraint.`, ...judged.map((j) => `${j.strategy.key} ${j.strategy.name}: ${j.rejectedBecause.join('; ')}`)].slice(0, 12),
      questions: dedupe([...interp.questions, ...judged.flatMap((j) => j.findings.filter((f) => f.severity === 'CRITICAL' && f.constraint === null).map((f) => `${j.strategy.name}: what evidence settles "${f.detail}"?`)), ...extraQuestions]),
      failedConstraint: null,
    };
  }
  const best = ranked[0]!;
  const reasons = [
    `${survivors.length} of ${judged.length} strategies survived critique with no critical finding; ${best.j.strategy.key} "${best.j.strategy.name}" ranks first (${best.majors} major finding(s), ${Math.round(best.share * 100)}% of its assumptions unsupported by Brain's rows).`,
  ];
  if (best.share > 0.5) {
    reasons.push('The leading strategy rests mainly on assumptions, so the plan is not ready until they are decided.');
    return {
      verdict: 'NEEDS_EVIDENCE',
      chosen: best.j.strategy.key,
      ranking,
      reasons,
      questions: dedupe([
        ...interp.questions,
        ...best.j.strategy.assumptions.filter((a) => a.basis === 'ASSUMPTION').map((a) => `Is it true that ${a.statement.replace(/[.?]+$/, '')}?`),
        ...best.j.strategy.wouldChange,
        ...extraQuestions,
      ]),
      failedConstraint: null,
    };
  }
  if (!interp.successMeasure) {
    reasons.push('No success measure is stated, so the plan cannot be judged ready (invariant 39).');
    return { verdict: 'NEEDS_EVIDENCE', chosen: best.j.strategy.key, ranking, reasons, questions: dedupe([...interp.questions, ...extraQuestions]), failedConstraint: null };
  }
  return { verdict: 'PLAN_READY', chosen: best.j.strategy.key, ranking, reasons, questions: dedupe(extraQuestions), failedConstraint: null };
}

// ---------------------------------------------------------------------------
// The model lane
// ---------------------------------------------------------------------------

export type ObjectiveRole = 'STRATEGIST' | 'CRITIC' | 'REVISER';
/** One call to Brain's free-lane models. Injected in tests. */
export type ObjectiveModel = (role: ObjectiveRole, system: string, prompt: string) => Promise<string>;

/** The free lane (`cheap/lane.ts`), never a paid API: the critic is the lane's other model when it has two. */
export function laneObjectiveModel(options: { env?: NodeJS.ProcessEnv; config?: LaneConfig | null; completer?: Completer } = {}): ObjectiveModel | null {
  const env = options.env ?? process.env;
  if ((env['BRAIN_REASONING_MODEL'] ?? '').trim().toLowerCase() === 'off') return null;
  const config = options.config === undefined ? laneConfig(env) : options.config;
  if (!config || config.models.length === 0) return null;
  const complete = options.completer ?? httpCompleter;
  return (role, system, prompt) => {
    const model = role === 'CRITIC' ? config.models[1 % config.models.length]! : config.models[0]!;
    return Promise.race([
      complete({ ...config, timeoutMs: OBJECTIVE_CALL_TIMEOUT_MS }, model, system, prompt, { maxTokens: 4000 }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timed out')), OBJECTIVE_CALL_TIMEOUT_MS + 2_000).unref()),
    ]);
  };
}

const STRATEGIST =
  'You are a strategist inside a planning engine. Given an objective, its stated constraints and the evidence Brain holds, ' +
  'you propose SUBSTANTIALLY DIFFERENT strategies — different mechanisms (who does the work, how it is acquired, what is bought or built, what order), ' +
  'never the same plan with different numbers. Be concrete and honest: label each assumption EVIDENCE only when it rests on one of the given source refs, ' +
  'otherwise ASSUMPTION. Answer ONLY with a JSON object.';

const CRITIC =
  'You are an adversarial reviewer. Your job is to break plans, not to improve them. For each strategy find: assumptions with no support, ' +
  'missing dependencies between steps, timing that cannot fit the stated constraints, conflicts between the stated constraints, and anything else that would make it fail. ' +
  'Mark a finding CRITICAL only when it makes the strategy fail as written. Answer ONLY with a JSON object.';

const STRATEGY_SHAPE =
  '{"name":"short name","mechanism":"one sentence: HOW this achieves the objective","summary":"two sentences",' +
  '"steps":[{"id":"1","action":"...","dependsOn":["<earlier step id>"],"days":<number>}],"resources":["..."],' +
  '"timeDays":{"low":<n>,"high":<n>},"costUsd":{"low":<n>,"high":<n>},"risks":["..."],' +
  '"assumptions":[{"statement":"...","basis":"EVIDENCE|ASSUMPTION","source":"<one of the source refs, only for EVIDENCE>"}],' +
  '"wouldChange":["the evidence that would change this strategy"],"killCriteria":["the observation on which to stop it"]}';

export interface ObjectiveEvidence {
  ref: string;
  text: string;
}

function briefLines(interp: ObjectiveInterpretation, evidence: ObjectiveEvidence[]): string[] {
  return [
    `Objective: ${interp.objective}`,
    `Stated constraints: ${interp.constraints.length ? interp.constraints.map((c) => `[${c.id}] ${c.statement}`).join('; ') : 'none stated'}.`,
    `Success measure: ${interp.successMeasure ? interp.successMeasure.statement : 'NOT STATED (treat as an open question, never assume one)'}.`,
    `Resources stated: ${interp.resources.length ? interp.resources.join(', ') : 'none stated'}.`,
    interp.industry ? `Industry: ${interp.industry}${interp.geography ? `, in ${interp.geography}` : ''}.` : '',
    'Evidence Brain holds (source ref | what it says):',
    ...(evidence.length ? evidence.map((e) => `- ${e.ref} | ${e.text.slice(0, 400)}`) : ['- none']),
  ].filter(Boolean);
}

export function generatePrompt(interp: ObjectiveInterpretation, evidence: ObjectiveEvidence[], held: ObjectiveStrategy[], want: number): string {
  return [
    ...briefLines(interp, evidence),
    '',
    held.length ? `Mechanisms already held — propose OTHER ones: ${held.map((s) => s.mechanism).join(' | ')}` : '',
    `Give ${want} to ${want + 2} strategies, each a different mechanism. Each step's dependsOn names only earlier step ids of the same strategy.`,
    `Reply exactly: {"strategies":[${STRATEGY_SHAPE}]}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function critiquePrompt(interp: ObjectiveInterpretation, evidence: ObjectiveEvidence[], strategies: ObjectiveStrategy[]): string {
  return [
    ...briefLines(interp, evidence),
    '',
    'Strategies to attack (key | JSON):',
    ...strategies.map((s) => `- ${s.key} | ${JSON.stringify({ name: s.name, mechanism: s.mechanism, steps: s.steps, timeDays: s.timeDays, costUsd: s.costUsd, assumptions: s.assumptions, resources: s.resources })}`),
    '',
    `kind: ${FINDING_KINDS.join(', ')}. severity: CRITICAL, MAJOR, MINOR. constraint: the [id] of the stated constraint the finding is about, or "".`,
    'Reply exactly: {"findings":[{"strategy":"<key>","kind":"...","severity":"...","detail":"one sentence","constraint":""}]}',
  ].join('\n');
}

export function revisePrompt(interp: ObjectiveInterpretation, evidence: ObjectiveEvidence[], items: { strategy: ObjectiveStrategy; findings: CritiqueFinding[] }[]): string {
  return [
    ...briefLines(interp, evidence),
    '',
    'Each strategy below received critical findings. Revise each ONCE so it answers them, keeping its mechanism. If a finding cannot be answered, keep it visible in risks.',
    ...items.map((i) => `- ${i.strategy.key} | ${JSON.stringify(i.strategy)}\n  findings: ${i.findings.map((f) => `[${f.severity} ${f.kind}${f.constraint ? ` ${f.constraint}` : ''}] ${f.detail}`).join(' / ')}`),
    `Reply exactly: {"strategies":[{"key":"<the same key>", ...${STRATEGY_SHAPE.slice(1)}]}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// One reading
// ---------------------------------------------------------------------------

export interface ObjectivePlanOptions {
  now?: Date;
  /** The model lane; defaults to `laneObjectiveModel()`. Null when no lane is configured. */
  model?: ObjectiveModel | null;
  /** Off by default in tests that do not want §92's construction read. */
  construction?: boolean;
}

interface Inputs {
  goal: Workstream;
  interp: ObjectiveInterpretation;
  evidence: ObjectiveEvidence[];
  digest: string;
  readingKey: string;
}

async function readInputs(goal: Workstream, now: Date): Promise<Inputs> {
  const interp = interpretObjective(goal, now);
  const links = await listLinks(goal.id);
  const evidence: ObjectiveEvidence[] = [{ ref: `goal:${goal.id}:intent`, text: `the owner's stated intent: ${goal.intent}` }];
  if (goal.outcome) evidence.push({ ref: `goal:${goal.id}:outcome`, text: `the owner's stated outcome: ${goal.outcome}` });
  for (const l of links.slice(0, 20)) evidence.push({ ref: `link:${l.kind}:${l.ref}`, text: `${l.relation.toLowerCase()} ${l.kind.toLowerCase()}: ${l.label}` });
  const digest = createHash('sha256')
    .update(JSON.stringify({ t: goal.title, i: goal.intent, o: goal.outcome, d: goal.dueAt, p: goal.projectId, l: links.map((l) => `${l.kind}:${l.ref}:${l.relation}`).sort() }))
    .digest('hex');
  const window = Math.floor(now.getTime() / OBJECTIVE_REFRESH_MS);
  return { goal, interp, evidence, digest, readingKey: `${digest.slice(0, 32)}:${window}` };
}

/** §92's construction for a named industry: its decision and decisive research questions, as evidence and questions. */
async function constructionFor(goalId: string, interp: ObjectiveInterpretation, now: Date): Promise<{ evidence: ObjectiveEvidence[]; questions: string[]; note: string | null }> {
  if (!interp.industry) return { evidence: [], questions: [], note: null };
  try {
    const read = await goalConstruction(goalId, { now, overrides: { industry: interp.industry, ...(interp.geography ? { geography: interp.geography } : {}) } });
    if (!read) return { evidence: [], questions: [], note: 'construction: goal not found' };
    const c = read.construction;
    const evidence: ObjectiveEvidence[] = [
      { ref: `construction:${goalId}`, text: `§92 industry construction for "${interp.industry}": ${c.decision.verdict} — ${c.decision.headline}${c.decision.decisiveObstacle ? `; obstacle: ${c.decision.decisiveObstacle}` : ''}` },
    ];
    const questions = c.research.filter((q) => q.decisive).slice(0, 5).map((q) => q.question);
    return { evidence, questions, note: `construction ${c.decision.verdict}` };
  } catch (error) {
    return { evidence: [], questions: [], note: `construction failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` };
  }
}

interface CallLog {
  strategist: number;
  critic: number;
  reviser: number;
  refused: number;
  duplicate: number;
  errors: string[];
}

async function call(model: ObjectiveModel, log: CallLog, role: ObjectiveRole, system: string, prompt: string): Promise<string | null> {
  if (role === 'STRATEGIST') log.strategist += 1;
  else if (role === 'CRITIC') log.critic += 1;
  else log.reviser += 1;
  try {
    return await model(role, system, prompt);
  } catch (error) {
    log.errors.push(`${role}: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return null;
  }
}

/** Critique strategies: the model's findings plus code's. Null when the critic's answer is refused. */
async function critique(model: ObjectiveModel, log: CallLog, interp: ObjectiveInterpretation, evidence: ObjectiveEvidence[], strategies: ObjectiveStrategy[]): Promise<Map<string, CritiqueFinding[]> | null> {
  const answer = await call(model, log, 'CRITIC', CRITIC, critiquePrompt(interp, evidence, strategies));
  const parsed = answer === null ? null : parseCritique(answer, new Set(strategies.map((s) => s.key)), new Set(interp.constraints.map((c) => c.id)));
  if (!parsed) {
    if (answer !== null) log.errors.push('CRITIC: answer refused (off-shape)');
    return null;
  }
  log.refused += parsed.refused;
  const out = new Map<string, CritiqueFinding[]>();
  for (const s of strategies) out.set(s.key, [...codeFindings(s, interp), ...parsed.findings.filter((f) => f.strategy === s.key)]);
  return out;
}

const critical = (findings: CritiqueFinding[]) => findings.filter((f) => f.severity === 'CRITICAL');

export interface ObjectivePlanResult {
  reading: ObjectiveReadingRecord;
  created: boolean;
}

/**
 * Plan one goal with no cash target. Returns null for a goal that has a target
 * (that is `plan.ts`'s), no intent, or does not exist. Keyed: a second call on
 * the same inputs in the same refresh window returns the stored reading and
 * makes no model call.
 */
export async function planObjective(goalId: string, options: ObjectivePlanOptions = {}): Promise<ObjectivePlanResult | null> {
  const now = options.now ?? new Date();
  const goal = await getWorkstream(goalId);
  if (!goal || goal.target || !goal.intent.trim()) return null;
  const inputs = await readInputs(goal, now);
  const held = await getObjectiveReadingByKey(goal.id, inputs.readingKey);
  if (held) return { reading: held, created: false };
  const { interp, evidence: base } = inputs;
  const construction = options.construction === false ? { evidence: [], questions: [], note: null } : await constructionFor(goal.id, interp, now);
  const evidence = [...base, ...construction.evidence];
  const sources = new Set(evidence.map((e) => e.ref));
  const log: CallLog = { strategist: 0, critic: 0, reviser: 0, refused: 0, duplicate: 0, errors: [] };
  const model = options.model === undefined ? laneObjectiveModel() : options.model;

  const degraded = (error: string, strategies: unknown[] = [], critiqueRounds: unknown[] = []) =>
    persist(inputs, now, { verdict: 'DEGRADED', chosen: null, strategies, critique: critiqueRounds, decision: { constructionNote: construction.note }, log, error });

  if (!model) return degraded('no model lane configured');

  // 2. Generate: up to two calls, the second asked for mechanisms the first did not give.
  let strategies: ObjectiveStrategy[] = [];
  for (let round = 0; round < 2 && strategies.length < OBJECTIVE_MIN_STRATEGIES; round++) {
    const answer = await call(model, log, 'STRATEGIST', STRATEGIST, generatePrompt(interp, evidence, strategies, OBJECTIVE_MIN_STRATEGIES - strategies.length));
    if (answer === null) continue;
    const parsed = parseStrategies(answer, sources, strategies);
    log.refused += parsed.refused;
    log.duplicate += parsed.duplicate;
    if (parsed.proposed === 0 && parsed.refused > 0) log.errors.push('STRATEGIST: answer refused (off-shape)');
    strategies = [...strategies, ...parsed.strategies].slice(0, MAX_STRATEGIES);
  }
  if (strategies.length < OBJECTIVE_MIN_STRATEGIES)
    return degraded(`${strategies.length} valid, distinct strateg${strategies.length === 1 ? 'y' : 'ies'} from the model; ${OBJECTIVE_MIN_STRATEGIES} are required before anything is judged`, strategies);

  // 3. Independent critique.
  const first = await critique(model, log, interp, evidence, strategies);
  if (!first) return degraded('the critique was refused; no plan is judged without an independent critique', strategies);
  const rounds: { round: number; findings: CritiqueFinding[] }[] = [{ round: 1, findings: [...first.values()].flat() }];

  // 4. Revise once what was critical, critique the revisions, reject what is still critical.
  const judged: JudgedStrategy[] = strategies.map((s) => ({ strategy: s, original: null, status: 'SURVIVED', findings: first.get(s.key) ?? [], rejectedBecause: [] }));
  const toRevise = judged.filter((j) => critical(j.findings).length > 0);
  if (toRevise.length) {
    const answer = await call(model, log, 'REVISER', STRATEGIST, revisePrompt(interp, evidence, toRevise.map((j) => ({ strategy: j.strategy, findings: critical(j.findings) }))));
    const body = answer === null ? null : jsonBody(answer);
    const list = Array.isArray(body?.['strategies']) ? (body!['strategies'] as unknown[]) : [];
    if (answer !== null && !Array.isArray(body?.['strategies'])) log.errors.push('REVISER: answer refused (off-shape)');
    const revised: ObjectiveStrategy[] = [];
    for (const j of toRevise) {
      const raw = list.find((one) => str((one as Record<string, unknown> | null)?.['key'], 20) === j.strategy.key);
      const parsed = raw ? parseStrategy(raw, sources, j.strategy.key) : null;
      if (!parsed) {
        if (raw) log.refused += 1;
        j.status = 'REJECTED';
        j.rejectedBecause = [...critical(j.findings).map((f) => f.detail), 'no valid revision was given'];
        continue;
      }
      j.original = j.strategy;
      j.strategy = parsed;
      revised.push(parsed);
    }
    if (revised.length) {
      const second = await critique(model, log, interp, evidence, revised);
      rounds.push({ round: 2, findings: second ? [...second.values()].flat() : [] });
      for (const j of toRevise.filter((one) => one.original)) {
        if (!second) {
          j.status = 'REJECTED';
          j.rejectedBecause = ['the re-critique was refused; a revision nobody critiqued is not accepted'];
          continue;
        }
        j.findings = second.get(j.strategy.key) ?? [];
        const still = critical(j.findings);
        if (still.length) {
          j.status = 'REJECTED';
          j.rejectedBecause = still.map((f) => `[${f.kind}${f.constraint ? ` ${f.constraint}` : ''}] ${f.detail}`);
        }
      }
    }
  }

  // 5. Decide.
  const decision = decideObjective(interp, judged, construction.questions);
  return persist(inputs, now, {
    verdict: decision.verdict,
    chosen: decision.chosen,
    strategies: judged,
    critique: rounds,
    decision: { ...decision, constructionNote: construction.note },
    log,
    error: log.errors.length ? log.errors.join(' | ').slice(0, 600) : null,
  });
}

async function persist(
  inputs: Inputs,
  now: Date,
  out: { verdict: ObjectiveVerdict; chosen: string | null; strategies: unknown[]; critique: unknown[]; decision: Record<string, unknown>; log: CallLog; error: string | null },
): Promise<ObjectivePlanResult> {
  const { goal, interp } = inputs;
  const result = await insertObjectiveReading({
    goalId: goal.id,
    readingKey: inputs.readingKey,
    inputsDigest: inputs.digest,
    verdict: out.verdict,
    chosenStrategy: out.chosen,
    interpretation: interp as unknown as Record<string, unknown>,
    strategies: out.strategies,
    critique: out.critique,
    decision: out.decision,
    calls: out.log as unknown as Record<string, unknown>,
    error: out.error,
    createdAt: now.toISOString(),
  });
  if (!result.created) return result;
  const reading = result.reading;
  const failed = (out.decision as Partial<ObjectiveDecision>).failedConstraint ?? null;
  const summary = (
    out.verdict === 'DEGRADED'
      ? `Objective plan degraded: ${out.error ?? 'unknown'}`
      : `Objective plan: ${out.verdict}${out.chosen ? `, leading ${out.chosen}` : ''}${failed ? `; every strategy fails "${failed.statement}"` : ''}.`
  ).slice(0, 400);
  const detail = { readingId: reading.id, verdict: out.verdict, chosen: out.chosen, strategies: out.strategies.length, failedConstraint: failed, error: out.error };
  await recordWorkstreamEvent({ workstreamId: goal.id, kind: 'OBJECTIVE_PLAN_READ', summary, detail, actorRef: 'BRAIN' });
  // project_events needs a project; a Brain-wide goal's history is its workstream_events row above.
  if (goal.projectId) await recordEvent({ projectId: goal.projectId, entityType: 'workstream', entityId: goal.id, eventType: 'GOAL_OBJECTIVE_PLAN_READ', payload: detail });
  return result;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

let inFlight = false;

/**
 * Plan at most one live, unpaused, untargeted goal per call: the one whose
 * last reading is oldest (never read first) and whose inputs or refresh window
 * have moved since. Safe on restart: the reading is keyed, and a goal whose
 * key is already stored is skipped without a model call.
 */
export async function advanceObjectivePlans(now: Date = new Date(), options: Omit<ObjectivePlanOptions, 'now'> = {}): Promise<{ read: number; goalId: string | null; verdict: ObjectiveVerdict | null; skipped: string | null }> {
  const model = options.model === undefined ? laneObjectiveModel() : options.model;
  if (!model) return { read: 0, goalId: null, verdict: null, skipped: 'no model lane configured' };
  if (inFlight) return { read: 0, goalId: null, verdict: null, skipped: 'a reading is in flight' };
  inFlight = true;
  try {
    const rows = await getDb().all<{ id: string; last: string | null }>(
      `SELECT w.id AS id, (SELECT MAX(r.created_at) FROM goal_objective_readings r WHERE r.workstream_id = w.id) AS last
         FROM workstreams w
        WHERE w.target_metric IS NULL AND w.archived_at IS NULL AND w.cancelled_at IS NULL AND w.paused_at IS NULL
          AND TRIM(w.intent) <> ''`,
    );
    rows.sort((a, b) => (a.last ?? '').localeCompare(b.last ?? '') || a.id.localeCompare(b.id));
    for (const row of rows) {
      const goal = await getWorkstream(row.id);
      if (!goal || goal.target) continue;
      const inputs = await readInputs(goal, now);
      if (await getObjectiveReadingByKey(goal.id, inputs.readingKey)) continue;
      const planned = await planObjective(goal.id, { ...options, model, now });
      if (!planned) continue;
      return { read: planned.created ? 1 : 0, goalId: goal.id, verdict: planned.reading.verdict, skipped: null };
    }
    return { read: 0, goalId: null, verdict: null, skipped: 'no goal due' };
  } finally {
    inFlight = false;
  }
}
