/**
 * The goal-scoped planning adapter for an app-hosted planning session (Opus in the owner's
 * Claude app). The session is the reasoning executor; this service connects it to the machinery
 * Brain already has, and never re-implements it:
 *
 *   contract   — the owner's words and the session's interpretation, checked against the goal
 *                record Brain read (`readTarget`); a changed contract invalidates old revisions;
 *   context    — the goal-linked openings with their card facts, the goal's exclusions, the
 *                contract's evidence exclusions, the open problems and the revision history;
 *   admission  — routes the session proposes go through the route proposer's own parser
 *                (`parseRoutes`) and writer (`fileRoute`): RECOMMENDATION facts, hypotheses only,
 *                no model run to regenerate them;
 *   calculate  — Brain's real planner (`readGoalPlan`) on the goal, with its integrity rules;
 *   revise     — a plan revision checked by `checkRevision`, its concrete problems returned;
 *   review     — an explicitly identified reviewer's verdict bound to the revision digest;
 *   finalize   — one published plan, only when the current revision passes every check and an
 *                independent review of that exact digest passed.
 *
 * State lives in the goal's append-only workstream events (`PLANNING_*`), so an interrupted
 * session resumes by replaying them. Planning authority is all this grants: it never spends,
 * contacts a buyer, resumes a goal or writes a verified fact.
 */
import { randomBytes } from 'node:crypto';
import { getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent, workstreamEventsOfKind } from '../../repos/register.ts';
import { readTarget } from '../goals/target.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { getOpportunity, opportunitiesWithRecordPrefix } from '../../repos/cashPortfolio.ts';
import { routeRecordId } from '../../domain/routeOrigin.ts';
import {
  checkRevision,
  contractDigest,
  contractMismatches,
  cashTrace,
  revisionDigest,
  type BrainFacts,
  type CheckProblem,
  type ContractTerms,
  type GoalContract,
  type PlanRevision,
  type PlanRevisionInput,
  type StoredGoalTerms,
} from '../../domain/sessionPlanning.ts';
import { sameExecutor, type PlanExecutor, type PlanReview } from '../../domain/planReady.ts';

export const PLANNING_EVENTS = {
  contract: 'PLANNING_CONTRACT',
  invalidated: 'PLANNING_INVALIDATED',
  contribution: 'PLANNING_CONTRIBUTION',
  brain: 'PLANNING_BRAIN_RUN',
  revision: 'PLANNING_REVISION',
  check: 'PLANNING_CHECK',
  review: 'PLANNING_REVIEW',
  final: 'PLANNING_FINAL',
  research: 'PLANNING_RESEARCH',
} as const;

const SINCE_EVER = '1970-01-01T00:00:00.000Z';
/** A planner call that has not answered by now is a failed calculation, never a slow success. */
export const BRAIN_RUN_TIMEOUT_MS = 300_000;

export class PlanningRefusal extends Error {
  constructor(message: string, readonly scope: string) {
    super(message);
  }
}

const actorOf = (e: PlanExecutor) => `${e.kind.toLowerCase()}:${e.id}`;

async function events(goalId: string, kind: string) {
  // Oldest first: state is the replay of these, in the order they happened.
  return (await workstreamEventsOfKind(goalId, kind, SINCE_EVER, 500)).reverse();
}

async function liveGoal(goalId: string) {
  const goal = await getWorkstream(goalId);
  if (!goal || goal.archivedAt || goal.cancelledAt) throw new PlanningRefusal(`no live goal ${goalId}`, 'goal:read');
  return goal;
}

/** The stored record's terms, read through Brain's own target reader. */
export async function storedTerms(goalId: string, now: Date = new Date()): Promise<StoredGoalTerms & { proven: boolean; projectId: string | null }> {
  const goal = await liveGoal(goalId);
  const t = await readTarget(goal, now);
  return {
    targetCents: t?.targetCents ?? null,
    currency: t?.currency ?? null,
    windowDays: goal.executionWindowDays ?? null,
    capitalCeilingCents: t?.capitalCeilingCents ?? null,
    capitalBeforeProofCents: goal.target?.capitalBeforeProofCents ?? null,
    hoursCeiling: t?.hoursCeiling ?? null,
    proven: t?.proven ?? false,
    projectId: t?.projectId ?? goal.projectId ?? null,
  };
}

// ------------------------------------------------------------------------------------ contract

export async function currentContract(goalId: string): Promise<GoalContract | null> {
  const all = await events(goalId, PLANNING_EVENTS.contract);
  const last = all[all.length - 1];
  return last ? (last.detail['contract'] as GoalContract) : null;
}

/**
 * Establish (or restate) the goal contract. Refused when the interpretation differs from the
 * stored goal without an explanation. A different digest from the current contract starts a new
 * version and invalidates every revision built on the old one.
 */
export async function establishContract(input: {
  goalId: string;
  words: string;
  source: GoalContract['source'];
  terms: ContractTerms;
  explanations?: GoalContract['explanations'];
  actor: PlanExecutor;
}): Promise<{ contract: GoalContract; changed: boolean; invalidated: string[] }> {
  await liveGoal(input.goalId);
  if (!input.words.trim()) throw new PlanningRefusal('the owner’s words are required verbatim', 'planning:contract');
  const stored = await storedTerms(input.goalId);
  const explanations = input.explanations ?? {};
  const problems = contractMismatches(input.terms, stored, explanations);
  if (problems.length) throw new PlanningRefusal(`the contract does not match the goal: ${problems.join('; ')}`, 'planning:contract');
  const digest = contractDigest({ goalId: input.goalId, words: input.words, terms: input.terms });
  const prior = await currentContract(input.goalId);
  if (prior && prior.digest === digest) return { contract: prior, changed: false, invalidated: [] };
  const contract: GoalContract = { goalId: input.goalId, words: input.words, source: input.source, terms: input.terms, explanations, version: (prior?.version ?? 0) + 1, digest };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.contract, summary: `Planning contract v${contract.version} (${digest})`, detail: { contract, previous: prior?.digest ?? null }, actorRef: actorOf(input.actor) });
  const invalidated: string[] = [];
  if (prior) {
    for (const rev of await revisions(input.goalId)) {
      if (rev.contractDigest === prior.digest) invalidated.push(rev.revisionId);
    }
    if (invalidated.length) {
      await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.invalidated, summary: `${invalidated.length} revision(s) built on contract v${prior.version} invalidated by v${contract.version}`, detail: { revisions: invalidated, from: prior.digest, to: digest }, actorRef: actorOf(input.actor) });
    }
  }
  return { contract, changed: true, invalidated };
}

// ------------------------------------------------------------------------------------- context

export async function planningContext(goalId: string) {
  const goal = await liveGoal(goalId);
  const contract = await currentContract(goalId);
  const stored = await storedTerms(goalId);
  const links = (await listLinks(goalId)).filter((l) => l.kind === 'OPPORTUNITY');
  const openings = [];
  for (const link of links) {
    const o = await getOpportunity(link.ref);
    if (!o) continue;
    const facts = await cardFactsFor(o.id).catch(() => []);
    openings.push({
      id: o.id,
      title: o.title,
      state: o.state,
      origin: (link.detail?.['origin'] as string | undefined) ?? link.label ?? null,
      facts: facts.map((f) => ({ field: f.field, value: f.value, kind: f.kind })),
    });
  }
  const state = await planningState(goalId);
  const lastRun = ((await events(goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined) ?? null;
  return {
    goal: { id: goal.id, title: goal.title, intent: goal.intent },
    contract,
    stored,
    openings,
    exclusions: contract?.terms.exclusions ?? [],
    evidenceExclusions: contract?.terms.evidenceExclusions ?? [],
    openProblems: state.currentCheck?.problems ?? [],
    revisions: state.revisions.map((r) => ({ revisionId: r.revisionId, digest: r.digest, stance: r.stance, contractDigest: r.contractDigest, stale: r.contractDigest !== contract?.digest })),
    lastReview: state.reviews[state.reviews.length - 1] ?? null,
    final: state.final,
    // What Brain's latest planner run read: each opening it weighed, what it set aside, the scope.
    brain: (() => {
      const run = lastRun;
      return run ? { at: run.at, completed: run.completed, verdict: run.verdict, summary: run.summary, openings: run.openings ?? [], excluded: run.excluded ?? [], scope: run.scope ?? null, nextTest: run.nextTest } : null;
    })(),
    questions: await openQuestions(goalId),
  };
}

// ----------------------------------------------------------------------------------- admission

/**
 * The session's routes, through the route proposer's own parser and writer. Each accepted route
 * becomes one goal-scoped opening of hypotheses; a rejected route comes back with the parser's
 * reason. Idempotent per route key: a resumed session never files a route twice.
 */
export async function admitRoutes(input: { goalId: string; routes: unknown[]; actor: PlanExecutor }) {
  const goal = await liveGoal(input.goalId);
  const contract = await currentContract(input.goalId);
  if (!contract) throw new PlanningRefusal('establish the goal contract before submitting routes', 'planning:contract');
  const target = await readTarget(goal);
  if (!target) throw new PlanningRefusal('the goal has no target to plan against', 'goal:read');
  const { discoveryAllowed } = await import('../cash/lifecycle.ts');
  const gate = await discoveryAllowed(target.projectId);
  if (!gate.allowed || !gate.mode) throw new PlanningRefusal(`the project does not admit new openings: ${gate.reason ?? 'Cash Mode is off'}`, 'cash:discovery');
  const { routeContext, parseRoutes, fileRoute } = await import('../goals/routeProposal.ts');
  const read = await routeContext(goal, target, []);
  if (!read) throw new PlanningRefusal('no time or money left to plan for', 'goal:read');
  const { routes, rejected } = parseRoutes({ routes: input.routes }, read.ctx);
  const filed: { key: string; id: string; title: string; directCostKnown: boolean; existing: boolean }[] = [];
  const refused = [...rejected.map((r) => ({ title: r.title, why: r.why, rule: r.rule }))];
  const t = contract.terms;
  for (const route of routes) {
    // The contract's own limits, each separately (the route proposer states one capital figure).
    if (t.preProofSpendCapCents !== null && route.capital * 100 > t.preProofSpendCapCents) {
      refused.push({ title: route.title, why: `ties up ${route.capital} before money returns, over the ${t.preProofSpendCapCents / 100} pre-proof cap`, rule: 'CAPITAL' });
      continue;
    }
    if (t.totalSpendCapCents !== null && route.capital * 100 > t.totalSpendCapCents) {
      refused.push({ title: route.title, why: `ties up ${route.capital}, over the ${t.totalSpendCapCents / 100} total-spend cap`, rule: 'CAPITAL' });
      continue;
    }
    const existing = (await opportunitiesWithRecordPrefix(target.projectId, routeRecordId(goal.id, route.key)))[0];
    if (existing) {
      filed.push({ key: route.key, id: existing.id, title: existing.title, directCostKnown: route.directCostKnown !== false, existing: true });
      continue;
    }
    const id = await fileRoute(goal, target, gate.mode.id, gate.mode.ownerUserId, route, `${input.actor.kind}:${input.actor.id}${input.actor.model ? ` (${input.actor.model})` : ''}`, null);
    filed.push({ key: route.key, id, title: route.title, directCostKnown: route.directCostKnown !== false, existing: false });
  }
  await recordWorkstreamEvent({ workstreamId: goal.id, kind: PLANNING_EVENTS.contribution, summary: `Session submitted ${input.routes.length} route(s): ${filed.length} admitted, ${refused.length} refused`, detail: { contractDigest: contract.digest, filed, refused }, actorRef: actorOf(input.actor) });
  return { filed, refused };
}

// ---------------------------------------------------------------------------------- calculation

export interface BrainRunSummary {
  completed: boolean;
  error: string | null;
  verdict: string | null;
  summary: string | null;
  acceptance: string | null;
  considered: string[];
  integrity: { rule: string; detail: string }[];
  steps: { label: string; owner: string; cost: number | null }[];
  nextTest: string | null;
  /** Every opening the planner weighed: the chain links it judged missing, and the card the session reasons from. */
  openings: SessionOpening[];
  excluded: { opportunityId: string; title: string; reason: string }[];
  /** The research questions this run raised through Brain's path-research owner (need ids). */
  questions: string[];
  /** The target and scope as the planner read them. */
  scope: { targetCents: number; daysLeft: number | null; hoursCeiling: number | null; industry: string | null; recurring: string | null; hoursPerWeek: number | null } | null;
  at: string;
}

export interface SessionOpening {
  opportunityId: string;
  title: string;
  missing: string[];
  stage: string;
  supportedReach: number;
  potentialReach: number | null;
  card: Record<string, unknown>;
  agreements: { amountCents: number; currency: string; deliverable: string; evidenceKind: string; state: string; recordedBy: string }[];
  facts: { field: string; value: string | null; kind: string }[];
}

const OPENING_FIELDS = ['payer', 'reachableChannel', 'buyingSignal', 'signalObservedAt', 'offerScope', 'acceptanceCondition', 'priceCents', 'currency', 'paymentTerms', 'fulfillmentOwner', 'deliveryMethod', 'requiredInputs', 'deadline', 'economicsNote', 'peakFundingCents', 'humanHours', 'requiredCapabilities', 'industry', 'mechanism', 'state'] as const;

async function consideredOpenings(reading: { considered: { opportunityId: string; title: string; missing: string[]; stage: string; supportedReach: number; potentialReach: number | null }[] }): Promise<SessionOpening[]> {
  const out: SessionOpening[] = [];
  for (const c of reading.considered ?? []) {
    const o = await getOpportunity(c.opportunityId);
    const facts = await cardFactsFor(c.opportunityId).catch(() => []);
    const row = (o ?? {}) as unknown as Record<string, unknown>;
    const card: Record<string, unknown> = {};
    // The opening's own record as Brain's planner reads it (`CashOpportunity`), every field a chain link rests on.
    for (const k of OPENING_FIELDS) if (row[k] !== undefined && row[k] !== null && row[k] !== '') card[k] = row[k];
    // Written agreements and commitments recorded against it (the journey's agreement rows): evidence the card's facts do not carry.
    const { agreementsFor } = await import('../../repos/cashJourney.ts');
    const agreements = (await agreementsFor(c.opportunityId).catch(() => [])).map((a) => ({ amountCents: a.amountCents, currency: a.currency, deliverable: a.deliverable, evidenceKind: a.evidenceKind, state: a.state, recordedBy: a.recordedBy }));
    out.push({ opportunityId: c.opportunityId, title: c.title, missing: [...c.missing], stage: c.stage, supportedReach: c.supportedReach, potentialReach: c.potentialReach, card, agreements, facts: facts.map((f) => ({ field: f.field, value: f.value, kind: f.kind })) });
  }
  return out;
}

/**
 * The research questions the reading leaves, raised through Brain's own path-research owner
 * (`researchGoalPaths`: one narrow need per missing fact published sources can settle). Where no
 * research is running for a question, it is parked: this session is then its executor
 * (`answerResearch`), and its returned result is recorded against the need.
 */
async function raiseQuestions(reading: Parameters<typeof import('../goals/pathResearch.ts')['researchGoalPaths']>[0]['reading']): Promise<string[]> {
  try {
    const { researchGoalPaths } = await import('../goals/pathResearch.ts');
    const projectId = (reading as unknown as { target: { projectId: string } }).target.projectId;
    return await researchGoalPaths({ reading, projectId });
  } catch {
    return [];
  }
}

/** Brain's real planner on this goal, bounded in time; a failure is recorded as a failure, never as a reading. */
/** Planner runs a timed-out call left going, per goal, so the next call can wait for them. */
const abandonedRuns = new Map<string, Promise<void>>();

export async function runBrain(input: { goalId: string; actor: PlanExecutor; evaluations?: number; timeoutMs?: number }): Promise<BrainRunSummary> {
  await liveGoal(input.goalId);
  const { readGoalPlan } = await import('../goals/plan.ts');
  const at = new Date().toISOString();
  let summary: BrainRunSummary;
  try {
    // A call that timed out leaves its planner run going and holding the process's one scenario
    // slot; a later call waits for it to end rather than being refused as busy (a resume).
    const abandoned = abandonedRuns.get(input.goalId);
    if (abandoned) await Promise.race([abandoned, new Promise((r) => setTimeout(r, input.timeoutMs ?? BRAIN_RUN_TIMEOUT_MS).unref?.())]);
    const run = readGoalPlan({ goalId: input.goalId, persist: true, evaluations: input.evaluations ?? 400 });
    const settled = run.then(() => undefined, () => undefined);
    abandonedRuns.set(input.goalId, settled);
    void settled.then(() => { if (abandonedRuns.get(input.goalId) === settled) abandonedRuns.delete(input.goalId); });
    const reading = await Promise.race([
      run,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${Math.round((input.timeoutMs ?? BRAIN_RUN_TIMEOUT_MS) / 1000)} s`)), input.timeoutMs ?? BRAIN_RUN_TIMEOUT_MS).unref?.()),
    ]);
    if (!reading) throw new Error('the planner returned no reading');
    summary = {
      completed: true,
      error: null,
      verdict: reading.verdict,
      summary: reading.summary,
      acceptance: reading.acceptance?.status ?? null,
      considered: (reading.strategies ?? []).flatMap((s) => s.opportunityIds ?? []).filter((v, i, a) => a.indexOf(v) === i),
      integrity: (reading.integrity ?? []).map((v) => ({ rule: String(v.rule), detail: String(v.detail) })),
      steps: (reading.steps ?? []).map((s) => ({ label: s.label, owner: s.owner, cost: s.cost })),
      nextTest: reading.nextTest?.test ?? null,
      openings: await consideredOpenings(reading),
      excluded: (reading.excluded ?? []).map((x) => ({ opportunityId: x.opportunityId, title: x.title, reason: x.reason })),
      questions: await raiseQuestions(reading),
      scope: { targetCents: reading.target.targetCents, daysLeft: reading.target.daysLeft ?? null, hoursCeiling: reading.target.hoursCeiling ?? null, industry: reading.target.scope?.industry ?? null, recurring: reading.target.scope?.recurring ?? null, hoursPerWeek: reading.target.scope?.hoursPerWeek ?? null },
      at,
    };
  } catch (err) {
    summary = { completed: false, error: err instanceof Error ? err.message : String(err), verdict: null, summary: null, acceptance: null, considered: [], integrity: [], steps: [], nextTest: null, openings: [], excluded: [], questions: [], scope: null, at };
  }
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.brain, summary: summary.completed ? `Brain planner read: ${summary.verdict}` : `Brain planner FAILED: ${summary.error}`, detail: { summary }, actorRef: actorOf(input.actor) });
  return summary;
}

/** Openings the session may plan on: those linked to the goal, and those Brain's own planner weighed for it. */
async function admittedIds(goalId: string): Promise<string[]> {
  const linked = (await listLinks(goalId)).filter((l) => l.kind === 'OPPORTUNITY').map((l) => l.ref);
  const run = (await events(goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined;
  return [...new Set([...linked, ...(run?.openings ?? []).map((o) => o.opportunityId)])];
}

// ------------------------------------------------------------------------------------- research

/** The research questions open on the openings this goal plans with, and what the session returned for each. */
export async function openQuestions(goalId: string) {
  const { listNeeds } = await import('../../repos/cashPortfolio.ts');
  const ids = new Set(await admittedIds(goalId));
  const goal = await liveGoal(goalId);
  const projectId = goal.target?.projectId ?? goal.projectId;
  if (!projectId) return [];
  const returned = new Map((await events(goalId, PLANNING_EVENTS.research)).map((e) => [String(e.detail['needId']), e.detail]));
  return (await listNeeds({ projectId, states: ['OPEN'] }))
    .filter((n) => n.opportunityId && ids.has(n.opportunityId) && n.requestKey?.startsWith('question:'))
    .map((n) => ({
      needId: n.id,
      opportunityId: n.opportunityId,
      field: n.requestKey!.slice(n.requestKey!.lastIndexOf(':') + 1),
      ask: n.nextStep,
      settledWhen: n.completionCondition,
      // Parked: Brain started no research for it. The session is then its executor.
      parked: !n.candidateId,
      returned: returned.get(n.id) ?? null,
    }));
}

/**
 * The session as the research executor of one open question: its returned result — the answer,
 * the method, and dated sources with the population each describes — is recorded against the need
 * and placed on the opening's card as a RECOMMENDATION with those sources as its basis. It is a
 * sourced hypothesis by an identified executor, never EVIDENCE: Brain's evidence gate is still
 * what verifies a claim, so the question stays open on the card's terms (`readNeedCondition`
 * refuses a recommendation as an answer) while the plan may reason from the returned result.
 */
export async function answerResearch(input: {
  goalId: string;
  needId: string;
  actor: PlanExecutor;
  answer: string;
  method: string;
  sources: { url: string; dated: string | null; claim: string; population: string }[];
  /** Searched and found nothing that settles it: recorded as a result, nothing written on the card. */
  unanswered?: boolean;
}) {
  await liveGoal(input.goalId);
  const q = (await openQuestions(input.goalId)).find((one) => one.needId === input.needId);
  if (!q) throw new PlanningRefusal(`no open research question ${input.needId} on this goal's openings`, 'planning:research');
  if (!input.method.trim()) throw new PlanningRefusal('a research result states how it was found', 'planning:research');
  if (!input.unanswered) {
    if (!input.answer.trim()) throw new PlanningRefusal('an answer is required, or mark the question unanswered', 'planning:research');
    const bad = input.sources.filter((one) => !/^https?:\/\//.test(one.url) || !one.claim.trim() || !one.population.trim());
    if (input.sources.length === 0 || bad.length) throw new PlanningRefusal('every source needs its URL, the claim it supports and the population it describes', 'planning:research');
  }
  const goal = await liveGoal(input.goalId);
  const projectId = (goal.target?.projectId ?? goal.projectId)!;
  let placed = false;
  if (!input.unanswered) {
    const { recordRecommendationFact } = await import('../../repos/cashCardFacts.ts');
    placed = await recordRecommendationFact({
      projectId,
      opportunityId: q.opportunityId!,
      field: q.field,
      value: input.answer.slice(0, 600),
      basis: input.sources.map((one) => `${one.claim} — ${one.url}${one.dated ? ` (${one.dated})` : ''} [${one.population}]`).join('; ').slice(0, 2000),
      assumptions: `Returned by ${input.actor.kind} ${input.actor.id}${input.actor.model ? ` (${input.actor.model})` : ''}: ${input.method}`.slice(0, 1000),
      uncertainty: 'Not yet through the evidence gate: a sourced research result, not a verified claim.',
    });
  }
  const detail = { needId: q.needId, opportunityId: q.opportunityId, field: q.field, executor: input.actor, answer: input.answer, method: input.method, sources: input.sources, unanswered: !!input.unanswered, placedOnCard: placed, wasParked: q.parked };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.research, summary: `Research ${input.unanswered ? 'without an answer' : 'returned'} for ${q.field} on ${q.opportunityId} by ${input.actor.kind} ${input.actor.id}`, detail, actorRef: actorOf(input.actor) });
  return detail;
}

// ------------------------------------------------------------------------------------ revisions

export async function revisions(goalId: string): Promise<PlanRevision[]> {
  return (await events(goalId, PLANNING_EVENTS.revision)).map((e) => e.detail['revision'] as PlanRevision);
}

/** Whether a payload carries every section a revision needs; a missing one marks the submission truncated. */
export function incompleteSections(r: Partial<PlanRevisionInput>): string[] {
  const need: (keyof PlanRevisionInput)[] = ['goalId', 'contractDigest', 'stance', 'strategy', 'alternatives', 'steps', 'cash', 'quantities', 'sources', 'answers'];
  return need.filter((k) => r[k] === undefined || r[k] === null);
}

/**
 * Submit a revision: it is digested, checked against the current contract and Brain's latest
 * planner run (run now when none followed the last contribution), recorded, and its concrete
 * problems returned for the next revision.
 */
export async function submitRevision(input: { revision: Partial<PlanRevisionInput>; actor: PlanExecutor; today?: string }) {
  const goalId = String(input.revision.goalId ?? '');
  await liveGoal(goalId);
  const contract = await currentContract(goalId);
  if (!contract) throw new PlanningRefusal('establish the goal contract first', 'planning:contract');
  const missing = incompleteSections(input.revision);
  const r: PlanRevisionInput = {
    goalId,
    contractDigest: String(input.revision.contractDigest ?? ''),
    parentRevisionId: input.revision.parentRevisionId ?? null,
    stance: (input.revision.stance ?? 'NO_PLAN') as PlanRevisionInput['stance'],
    strategy: input.revision.strategy ?? { title: '', opportunityIds: [], why: '' },
    alternatives: input.revision.alternatives ?? [],
    steps: input.revision.steps ?? [],
    cash: input.revision.cash ?? [],
    proofDay: input.revision.proofDay ?? null,
    quantities: input.revision.quantities ?? [],
    sources: input.revision.sources ?? [],
    validation: input.revision.validation ?? null,
    noPlan: input.revision.noPlan ?? null,
    reach: input.revision.reach ?? null,
    answers: input.revision.answers ?? [],
    // The structured judgement a grader reads: carried exactly as sent, absent when not sent.
    ...(input.revision.chain ? { chain: input.revision.chain } : {}),
    ...(input.revision.excluded ? { excluded: input.revision.excluded } : {}),
    ...(input.revision.members ? { members: input.revision.members } : {}),
    ...(input.revision.resolves ? { resolves: input.revision.resolves } : {}),
    ...(input.revision.constraints ? { constraints: input.revision.constraints } : {}),
    ...(missing.length || input.revision.truncated ? { truncated: true } : {}),
  };
  const lastContribution = (await events(goalId, PLANNING_EVENTS.contribution)).pop();
  let brainRun = ((await events(goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined) ?? null;
  if (!brainRun || (lastContribution && brainRun.at < lastContribution.createdAt)) brainRun = await runBrain({ goalId, actor: input.actor });
  const brain: BrainFacts = { admittedOpportunityIds: await admittedIds(goalId), integrity: brainRun.integrity, completed: brainRun.completed, error: brainRun.error };
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const problems: CheckProblem[] = [
    ...missing.map((k) => ({ code: 'INCOMPLETE_OUTPUT' as const, detail: `the submission has no "${k}"`, at: k })),
    ...checkRevision(contract, r, brain, today),
  ];
  const digest = revisionDigest(r);
  const revision: PlanRevision = { ...r, revisionId: `rev_${digest.slice(0, 12)}_${randomBytes(3).toString('hex')}`, digest, author: input.actor, createdAt: new Date().toISOString() };
  await recordWorkstreamEvent({ workstreamId: goalId, kind: PLANNING_EVENTS.revision, summary: `Revision ${revision.revisionId} (${r.stance})`, detail: { revision }, actorRef: actorOf(input.actor) });
  const trace = cashTrace(r, contract.terms);
  await recordWorkstreamEvent({ workstreamId: goalId, kind: PLANNING_EVENTS.check, summary: `Checks on ${revision.revisionId}: ${problems.length} problem(s)`, detail: { revisionId: revision.revisionId, digest, contractDigest: contract.digest, problems, trace, brain: brainRun }, actorRef: 'brain:session-planning' });
  return { revision, problems, trace, brain: brainRun };
}

// ------------------------------------------------------------------------------------- review

/**
 * Record a reviewer's verdict on one revision. The reviewer must be explicitly identified; the
 * author reviewing itself is recorded but never certifies; UNAVAILABLE records that no reviewer
 * answered (nothing is certified).
 */
export async function recordReview(input: { goalId: string; revisionId: string; reviewer: PlanExecutor; verdict: PlanReview['verdict']; reasons: string; findings: string[]; resolution?: string | null }) {
  const rev = (await revisions(input.goalId)).find((r) => r.revisionId === input.revisionId);
  if (!rev) throw new PlanningRefusal(`no revision ${input.revisionId} on this goal`, 'planning:review');
  if (!input.reviewer.id.trim()) throw new PlanningRefusal('the reviewer must be explicitly identified', 'planning:review');
  if (input.verdict !== 'UNAVAILABLE' && !input.reasons.trim()) throw new PlanningRefusal('a verdict must carry its reasons', 'planning:review');
  const review: PlanReview = { revisionId: rev.revisionId, revisionDigest: rev.digest, author: rev.author, reviewer: input.reviewer, verdict: input.verdict, reasons: input.reasons, findings: input.findings, resolution: input.resolution ?? null, at: new Date().toISOString() };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.review, summary: `Review of ${rev.revisionId} by ${input.reviewer.kind} ${input.reviewer.id}: ${input.verdict}`, detail: { review, independent: !sameExecutor(rev.author, input.reviewer) }, actorRef: actorOf(input.reviewer) });
  return { review, independent: !sameExecutor(rev.author, input.reviewer) };
}

// ------------------------------------------------------------------------------------- state

export async function planningState(goalId: string) {
  const contract = await currentContract(goalId);
  const revs = await revisions(goalId);
  const checks = (await events(goalId, PLANNING_EVENTS.check)).map((e) => e.detail as { revisionId: string; digest: string; contractDigest: string; problems: CheckProblem[]; trace: unknown; brain: BrainRunSummary });
  const reviews = (await events(goalId, PLANNING_EVENTS.review)).map((e) => e.detail['review'] as PlanReview);
  const finals = (await events(goalId, PLANNING_EVENTS.final)).map((e) => e.detail as { revisionId: string; digest: string; contractDigest: string; plan: PlanRevision; review: PlanReview; at: string });
  const current = revs[revs.length - 1] ?? null;
  const currentCheck = current ? (checks.filter((c) => c.revisionId === current.revisionId).pop() ?? null) : null;
  const final = finals[finals.length - 1] ?? null;
  return {
    contract,
    revisions: revs,
    current,
    currentCheck,
    reviews,
    // A final built on a superseded revision or an old contract is history, not the plan.
    final: final && current && final.revisionId === current.revisionId && contract && final.contractDigest === contract.digest ? final : null,
    staleFinal: final && !(current && final.revisionId === current.revisionId && contract && final.contractDigest === contract.digest) ? final : null,
  };
}

/** Publish the current revision as the goal's one plan, or say exactly what still stops it. */
export async function finalizePlan(input: { goalId: string; revisionId: string; actor: PlanExecutor }) {
  const state = await planningState(input.goalId);
  const blockers: string[] = [];
  if (!state.contract) blockers.push('no goal contract');
  if (!state.current || state.current.revisionId !== input.revisionId) blockers.push(`revision ${input.revisionId} is not the current revision (${state.current?.revisionId ?? 'none'})`);
  const rev = state.current;
  if (rev && state.contract && rev.contractDigest !== state.contract.digest) blockers.push('the revision was built on a superseded contract');
  if (!state.currentCheck) blockers.push('the revision has no recorded check');
  else if (state.currentCheck.problems.length) blockers.push(`the revision still has ${state.currentCheck.problems.length} check problem(s): ${state.currentCheck.problems.map((p) => p.code).join(', ')}`);
  const review = rev ? state.reviews.filter((r) => r.revisionDigest === rev.digest).pop() ?? null : null;
  if (!review) blockers.push('no review of this exact revision');
  else {
    const { reviewProblem } = await import('../../domain/planReady.ts');
    const why = reviewProblem(review, rev!.digest, null);
    if (why) blockers.push(why);
    if (review.verdict !== 'PASS') blockers.push(`the review verdict is ${review.verdict}`);
  }
  if (blockers.length || !rev || !review || !state.contract) return { published: false as const, blockers };
  const detail = { revisionId: rev.revisionId, digest: rev.digest, contractDigest: state.contract.digest, plan: rev, review, at: new Date().toISOString() };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.final, summary: `Published plan ${rev.revisionId} (${rev.stance})`, detail, actorRef: actorOf(input.actor) });
  return { published: true as const, final: detail };
}

/** The independent review of the goal's published (or current) revision, for the readiness owner. */
export async function sessionReviewFor(goalId: string): Promise<{ review: PlanReview | null; planDigest: string | null }> {
  const state = await planningState(goalId).catch(() => null);
  if (!state?.current) return { review: null, planDigest: null };
  const rev = state.final?.plan ?? state.current;
  return { review: state.reviews.filter((r) => r.revisionDigest === rev.digest).pop() ?? null, planDigest: rev.digest };
}

/** Link an opening the session relies on (e.g. one filed by discovery) to the goal, so context and checks see it. */
export async function linkOpening(input: { goalId: string; opportunityId: string; actor: PlanExecutor; why: string }) {
  await liveGoal(input.goalId);
  if (!(await getOpportunity(input.opportunityId))) throw new PlanningRefusal(`no opening ${input.opportunityId}`, 'goal:read');
  await linkWorkstream({ workstreamId: input.goalId, kind: 'OPPORTUNITY', ref: input.opportunityId, relation: 'SOURCE', label: 'session-linked opening', detail: { origin: 'SESSION_PLANNING', why: input.why }, recordedBy: 'BRAIN', recordedByUserId: null });
}
