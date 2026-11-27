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
  type PlanStepInput,
  type StepExecutorRecord,
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

// ---------------------------------------------------------------------------- executors and fulfilment

/** Who each opening's own record says fulfils it (`recordFulfiller`), with the deliverable capability's live state. */
async function fulfilmentOf(ids: readonly string[]): Promise<NonNullable<BrainFacts['fulfilment']>> {
  const { recordFulfiller } = await import('../goals/arrangementSteps.ts');
  const { readCapabilityInventory } = await import('../goals/stepExecutor.ts');
  const inventory = await readCapabilityInventory();
  const out: NonNullable<BrainFacts['fulfilment']> = {};
  for (const id of ids) {
    const o = await getOpportunity(id);
    if (!o) continue;
    const f = recordFulfiller(o);
    const capability = f.by === 'BRAIN' ? f.capability : null;
    out[id] = { by: f.by, name: f.by === 'PROVIDER' ? f.name : null, capability, capabilityState: capability ? (inventory.entries[capability]?.state ?? 'NOT_DECLARED') : null };
  }
  return out;
}

const OPERATION_OF: Record<string, string> = { REACH: 'REACH_BUYERS', OFFER: 'SEND_OFFER', SELL: 'SEND_OFFER', TEST: 'SEND_OFFER', COLLECT: 'COLLECT_PAYMENT', ORDER: 'PAY_SUPPLIER', RESEARCH: 'RESEARCH', OTHER: 'PLAN_DECISION' };

/**
 * Each step's executor as Brain reads it: the operation its kind and performer name, through
 * `stepExecutor` over the live capability inventory — the planner's own owner. A Brain delivery
 * also carries the deliverable capability the opening requires. The session's own `executor`, if
 * it sent one, is replaced: a capability is read, never asserted.
 */
async function withExecutors(steps: PlanStepInput[], members: readonly string[], fulfilment: NonNullable<BrainFacts['fulfilment']>): Promise<PlanStepInput[]> {
  const { readCapabilityInventory, stepExecutor } = await import('../goals/stepExecutor.ts');
  const inventory = await readCapabilityInventory();
  return steps.map((s) => {
    const performer = s.performer === null ? null : s.performer === 'BRAIN' ? 'BRAIN' : s.performer === 'OWNER' ? 'OWNER' : 'PROVIDER';
    const operation = performer === 'OWNER' ? 'OWNER_TASK' : s.kind === 'DELIVER' ? (performer === 'BRAIN' ? 'BRAIN_PRODUCES' : 'SUPPLIER_DELIVERS') : (OPERATION_OF[s.kind] ?? 'PLAN_DECISION');
    const e = stepExecutor({
      operation: operation as never,
      provider: performer === 'PROVIDER' ? s.performer : null,
      cost: s.costCents === null ? null : s.costCents / 100,
      ...(performer === 'OWNER' ? { ownerTask: { why: s.label, routine: true } } : {}),
    }, inventory);
    const capabilities: { id: string; state: string }[] = e.capabilities.map((c) => ({ id: c.id, state: c.state }));
    if (s.kind === 'DELIVER' && performer === 'BRAIN') {
      for (const id of members) {
        const f = fulfilment[id];
        if (f?.capability && !capabilities.some((c) => c.id === f.capability)) capabilities.push({ id: f.capability, state: f.capabilityState ?? 'NOT_DECLARED' });
      }
    }
    const executor: StepExecutorRecord = {
      operation: e.operation,
      performedBy: performer === null ? 'NOT_ESTABLISHED' : e.performedBy === 'CAPABILITY_MISSING' ? 'BRAIN' : (e.performedBy as StepExecutorRecord['performedBy']),
      provider: e.provider,
      capabilities,
      routine: e.routine,
    };
    return { ...s, executor };
  });
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
  // What a verifier judges: the submitted claims as Brain stored them (text, source, passage, acceptance), read from the rows.
  const { listClaimsForFragment } = await import('../../repos/research.ts');
  const submittedClaims = async (needId: string) => {
    const sub = (await events(goalId, PLANNING_EVENTS.research)).filter((e) => e.detail['needId'] === needId && e.detail['phase'] === 'SUBMITTED').pop();
    if (!sub?.detail['fragmentId']) return [];
    return (await listClaimsForFragment(String(sub.detail['fragmentId']))).map((c) => ({ claimId: c.id, claim: c.claim, sourceUrl: c.sourceUrl, sourceTitle: c.sourceTitle, sourcePublisher: c.sourcePublisher, sourceDate: c.sourceDate, evidenceExcerpt: c.evidenceExcerpt, evidenceLocator: c.evidenceLocator, sourced: c.sourced, accepted: c.accepted, rejectionReason: c.rejectionReason ?? null }));
  };
  const rows = (await listNeeds({ projectId, states: ['OPEN'] }))
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
  return Promise.all(rows.map(async (one) => ({ ...one, submitted: await submittedClaims(one.needId) })));
}

/** One claim the session submits for a research question, in the research gate's own terms. */
export interface SessionClaimInput {
  claim: string;
  sourceUrl: string;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  /** The date the source itself prints. */
  sourceDate: string | null;
  /** The passage that states it, verbatim, and where on the page it is. */
  evidenceExcerpt: string;
  evidenceLocator: string;
  primarySource: boolean;
}

const RESEARCH_LANE = 'answer';

/**
 * The session as the research executor of one open question, through Brain's own research path:
 * the question gets its idea (as `startDependentWork` gives one), a research packet with one
 * fragment scoped to the opening's buyers, and a running mission; the session's claims are
 * recorded by `recordFragmentClaims` — sourced or not, never accepted, the gate alone decides that.
 * Each claim's source validation comes back at once; acceptance waits for an independent
 * verifier (`verifyResearch`).
 */
export async function answerResearch(input: {
  goalId: string;
  needId: string;
  actor: PlanExecutor;
  method: string;
  claims: SessionClaimInput[];
  /** Searched and found nothing that settles it: recorded as a result; no packet is opened. */
  unanswered?: boolean;
}) {
  const goal = await liveGoal(input.goalId);
  const q = (await openQuestions(input.goalId)).find((one) => one.needId === input.needId);
  if (!q) throw new PlanningRefusal(`no open research question ${input.needId} on this goal's openings`, 'planning:research');
  if (!input.method.trim()) throw new PlanningRefusal('a research result states how it was found', 'planning:research');
  const projectId = (goal.target?.projectId ?? goal.projectId)!;
  if (input.unanswered) {
    const detail = { phase: 'UNANSWERED', needId: q.needId, opportunityId: q.opportunityId, field: q.field, executor: input.actor, method: input.method, orchestrationId: null, fragmentId: null, missionId: null, claims: [] as { claimId: string; sourced: boolean; validationState: string; validationDetail: string | null; accepted: boolean }[], wasParked: q.parked };
    await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.research, summary: `Research without an answer for ${q.field} on ${q.opportunityId}`, detail, actorRef: actorOf(input.actor) });
    return detail;
  }
  if (input.claims.length === 0) throw new PlanningRefusal('submit at least one claim, or mark the question unanswered', 'planning:research');
  const { getNeed, setNeedCandidate } = await import('../../repos/cashPortfolio.ts');
  const { createCandidate } = await import('../../repos/russellCandidates.ts');
  const { launchMission, linkMission, transitionMission } = await import('../../repos/russellMissions.ts');
  const { createRun } = await import('../../repos/runs.ts');
  const { createFragments, createOrchestration, currentFragments } = await import('../../repos/research.ts');
  const { listLayers } = await import('../../repos/layers.ts');
  const { recordFragmentClaims } = await import('../research/submission.ts');
  // The question names no market of its own: the gate's own marker for that, never a literal it cannot recognise.
  const { ANY_NAMED_MARKET } = await import('../research/approvalEnvelope.ts');
  const need = await getNeed(q.needId);
  const opportunity = await getOpportunity(q.opportunityId!);
  if (!need || !opportunity) throw new PlanningRefusal('the question or its opening is gone', 'planning:research');
  const layer = (await listLayers(projectId))[0];
  if (!layer) throw new PlanningRefusal('the project has no layer to hold research', 'planning:research');
  // The question's idea, exactly as `startDependentWork` gives one (reused when it already has one).
  let candidateId = need.candidateId;
  if (!candidateId) {
    const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: need.blockedAction, statement: need.nextStep });
    await setNeedCandidate(need.id, candidate.id);
    candidateId = candidate.id;
  }
  const attempt = (await events(input.goalId, PLANNING_EVENTS.research)).filter((e) => e.detail['needId'] === q.needId && e.detail['phase'] === 'SUBMITTED').length + 1;
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: need.nextStep } as never);
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: (run as { id: string }).id, title: need.blockedAction.slice(0, 200), assignment: need.nextStep, provider: 'WORKER', autoApprove: false } as never);
  await createFragments([{
    orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: `session-${q.field}`, question: need.nextStep,
    geography: ANY_NAMED_MARKET, population: opportunity.payer ?? `${opportunity.industry ?? 'the opening'} buyers`, timeframe: 'current', definitions: q.field,
    requiredEvidence: [{ id: RESEARCH_LANE, description: need.completionCondition ?? `the ${q.field}`, necessity: 'REQUIRED' }] as never,
    acceptableSourceTypes: ['a published, dated source'], excludedSourceTypes: [], completionCriteria: ['a dated source stating it'], dependsOn: [], minIndependentSources: 1, attempt: 1,
  }]);
  const [fragment] = await currentFragments(orchestration.id);
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: need.nextStep.slice(0, 500), whyNow: `goal ${input.goalId} planning session`, idempotencyKey: `session-research:${q.needId}:${attempt}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  const stored = await recordFragmentClaims({
    orchestration, fragment: fragment!, passId: null as never, passKey: 'BROAD_SCAN',
    claims: input.claims.map((c) => ({
      claim: c.claim, claimType: 'SOURCED_FACT', primarySource: c.primarySource, searchedRepositories: [], sourceUrl: c.sourceUrl, sourceTitle: c.sourceTitle,
      sourcePublisher: c.sourcePublisher, sourceDate: c.sourceDate, evidenceExcerpt: c.evidenceExcerpt, evidenceLocator: c.evidenceLocator, retrievedAt: new Date().toISOString(),
      confidence: 0.8, evidenceLane: RESEARCH_LANE, opportunitySignal: null, monetizationMethod: null, structuralFinding: null, structuralSubject: null,
    })) as never,
  });
  const claims = stored.map((c) => ({ claimId: c.id, sourced: c.sourced, validationState: c.validationState, validationDetail: c.validationDetail, accepted: c.accepted }));
  const detail = { phase: 'SUBMITTED', needId: q.needId, opportunityId: q.opportunityId, field: q.field, executor: input.actor, method: input.method, orchestrationId: orchestration.id, fragmentId: fragment!.id, missionId: mission.id, claims, wasParked: q.parked };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.research, summary: `Research submitted for ${q.field} on ${q.opportunityId} by ${input.actor.kind} ${input.actor.id}: ${claims.length} claim(s), awaiting the evidence gate`, detail, actorRef: actorOf(input.actor) });
  return detail;
}

/**
 * An independent verifier's reading of submitted research, through Brain's evidence gate
 * (`gateFragment`: the support and scope answers only a reader of the source can give, then the
 * gate's own conditions). The verifier must be a different executor from the researcher. The
 * mission finishes; `applyResearchAnswers` carries any accepted claim onto the card as EVIDENCE
 * and settles the question; Brain's planner reruns, so the verdict, each claim's acceptance or
 * rejection reason, and what changed in the planning input all go back to the session.
 */
export async function verifyResearch(input: {
  goalId: string;
  needId: string;
  verifier: PlanExecutor;
  verdicts: { claimId: string; supportsClaim: boolean; scopeMatch: { geography: string; timeframe: string; population: string; definitions: string }; scopeBasis?: Record<string, string>; note: string }[];
  sufficiency: 'SUFFICIENT' | 'INSUFFICIENT';
}) {
  await liveGoal(input.goalId);
  const submitted = (await events(input.goalId, PLANNING_EVENTS.research)).filter((e) => e.detail['needId'] === input.needId && e.detail['phase'] === 'SUBMITTED').pop();
  if (!submitted) throw new PlanningRefusal(`no submitted research for ${input.needId}`, 'planning:research');
  const researcher = submitted.detail['executor'] as PlanExecutor;
  if (sameExecutor(researcher, input.verifier)) throw new PlanningRefusal('the researcher cannot verify its own research; an independent verifier must', 'planning:research');
  const { getFragment, listClaimsForFragment } = await import('../../repos/research.ts');
  const { gateFragment } = await import('../research/submission.ts');
  const { transitionMission } = await import('../../repos/russellMissions.ts');
  const { applyResearchAnswers } = await import('../cash/answers.ts');
  const fragment = await getFragment(String(submitted.detail['fragmentId']));
  if (!fragment) throw new PlanningRefusal('the research fragment is gone', 'planning:research');
  if (fragment.status === 'ACCEPTED' || fragment.status === 'BLOCKED') throw new PlanningRefusal('this research was already judged; submit new research to try again', 'planning:research');
  const opportunityId = String(submitted.detail['opportunityId']);
  const field = String(submitted.detail['field']);
  const before = await brainOpening(input.goalId, opportunityId);
  const factBefore = (await cardFactsFor(opportunityId)).find((f) => f.field === field) ?? null;
  const gate = await gateFragment({
    fragment,
    verifications: input.verdicts.map((v) => ({ claimId: v.claimId, supportsClaim: v.supportsClaim, scopeMatch: v.scopeMatch as never, scopeBasis: (v.scopeBasis ?? {}) as never, note: v.note })),
    sufficiency: input.sufficiency,
    missingLanes: [],
    unresolvedGaps: [],
  });
  await transitionMission({ missionId: String(submitted.detail['missionId']), from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
  const goal = await liveGoal(input.goalId);
  const applied = await applyResearchAnswers((goal.target?.projectId ?? goal.projectId)!);
  const answered = applied.applied.find((a) => a.needId === input.needId) ?? null;
  const unanswered = applied.unanswered.find((a) => a.needId === input.needId) ?? null;
  const claims = (await listClaimsForFragment(fragment.id)).map((c) => ({ claimId: c.id, accepted: c.accepted, rejectionReason: c.rejectionReason ?? null }));
  const factAfter = (await cardFactsFor(opportunityId)).find((f) => f.field === field) ?? null;
  // The affected planning reruns on what the gate decided.
  const rerun = await runBrain({ goalId: input.goalId, actor: input.verifier });
  const after = rerun.openings.find((o) => o.opportunityId === opportunityId) ?? null;
  const detail = {
    phase: 'VERIFIED', needId: input.needId, opportunityId, field, verifier: input.verifier, researcher,
    fragmentStatus: gate.integrity === 'PASS' && gate.sufficiency === 'SUFFICIENT' ? 'ACCEPTED' : 'BLOCKED', gateReasons: gate.reasons, claims,
    answered: answered ? { claimId: answered.claimId } : null, unanswered: unanswered ? { state: unanswered.state, detail: unanswered.detail } : null,
    input: { field, before: factBefore ? { value: factBefore.value, kind: factBefore.kind } : null, after: factAfter ? { value: factAfter.value, kind: factAfter.kind } : null },
    missing: { before: before?.missing ?? null, after: after?.missing ?? null },
    rerun: { completed: rerun.completed, verdict: rerun.verdict, at: rerun.at },
  };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.research, summary: `Research for ${field} on ${opportunityId} ${answered ? 'ACCEPTED by the evidence gate' : 'not accepted'}; planner rerun`, detail, actorRef: actorOf(input.verifier) });
  return detail;
}

async function brainOpening(goalId: string, opportunityId: string) {
  const run = (await events(goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined;
  return run?.openings?.find((o) => o.opportunityId === opportunityId) ?? null;
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
  const admitted = await admittedIds(goalId);
  const fulfilment = await fulfilmentOf(r.strategy.opportunityIds);
  r.steps = await withExecutors(r.steps, r.strategy.opportunityIds, fulfilment);
  const brain: BrainFacts = { admittedOpportunityIds: admitted, integrity: brainRun.integrity, completed: brainRun.completed, error: brainRun.error, fulfilment, hoursCeiling: (await storedTerms(goalId)).hoursCeiling };
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
