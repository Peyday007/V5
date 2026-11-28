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
import { createHash, randomBytes } from 'node:crypto';
import { getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent, workstreamEventsOfKind } from '../../repos/register.ts';
import { readTarget } from '../goals/target.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { getOpportunity, opportunitiesWithRecordPrefix } from '../../repos/cashPortfolio.ts';
import { routeRecordId } from '../../domain/routeOrigin.ts';
import {
  checkRevision,
  conditionProblems,
  contractDigest,
  contractMismatches,
  cashTrace,
  revisionDigest,
  type BrainFacts,
  type CardFacts,
  type ReviewCondition,
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

/** The largest context a call returns: under the transport's 256 KB result limit (`mcp/limits.ts`), with room for its envelope. */
export const CONTEXT_BUDGET_BYTES = 200 * 1024;

/**
 * The context, made to fit one call. On a large project the planner weighs many openings whose cards carry long research
 * text, and the whole context passed the transport's limit, so the session could read nothing at all (production,
 * 2026-11-28, Cash Mode 1: "That result is too large to return" five times). Ids, links, questions and figures are
 * never dropped; long text is shortened first, then the record detail of openings outside the goal's own, each step
 * saying what it left out.
 */
export function fitContext<T extends Record<string, unknown>>(ctx: T, budget: number = CONTEXT_BUDGET_BYTES): T & { compacted?: string[] } {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  if (size(ctx) <= budget) return ctx;
  const notes: string[] = [];
  const shorten = (v: unknown, max: number): unknown => {
    if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}… [${v.length - max} more characters]` : v;
    if (Array.isArray(v)) return v.map((x) => shorten(x, max));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, max)]));
    return v;
  };
  let out = ctx as Record<string, unknown>;
  for (const max of [600, 240, 120]) {
    out = shorten(out, max) as Record<string, unknown>;
    notes.push(`text fields longer than ${max} characters shortened`);
    if (size(out) <= budget) return { ...(out as T), compacted: notes };
  }
  // Brain's weighed openings beyond the goal's own keep their id, title, missing links and link verdicts only.
  const own = new Set(((out['openings'] as { id: string }[] | undefined) ?? []).map((o) => o.id));
  const brain = out['brain'] as { openings?: Record<string, unknown>[]; excluded?: Record<string, unknown>[] } | null;
  if (brain) {
    const slim = (o: Record<string, unknown>) => (own.has(String(o['opportunityId'])) ? o : { opportunityId: o['opportunityId'], title: o['title'], missing: o['missing'], links: o['links'], reason: o['reason'], stage: o['stage'] });
    out = { ...out, brain: { ...brain, openings: (brain.openings ?? []).map(slim), excluded: (brain.excluded ?? []).map(slim) } };
    notes.push("openings outside the goal's own are summarized (id, title, missing links, verdicts); the goal's own keep their full cards");
  }
  const b2 = out['brain'] as { openings?: unknown[]; excluded?: unknown[] } | null;
  if (b2 && size(out) > budget) {
    const keep = 30;
    const omitted = Math.max(0, (b2.openings?.length ?? 0) - keep) + Math.max(0, (b2.excluded?.length ?? 0) - keep);
    out = { ...out, brain: { ...b2, openings: (b2.openings ?? []).slice(0, keep), excluded: (b2.excluded ?? []).slice(0, keep) } };
    notes.push(`only the first ${keep} weighed and ${keep} excluded openings listed (${omitted} more not shown)`);
  }
  // Still over (production, 2026-11-28, Cash Mode 1 at 30835d5: the goal's own openings and open questions alone passed
  // the limit): the longest list anywhere is halved, and each cut is named with its path and count, until it fits.
  // Halving always terminates, so a context is always returned rather than refused.
  if (size(out) > budget) out = shorten(out, 60) as Record<string, unknown>;
  const cuts = new Map<string, { total: number; shown: number }>();
  while (size(out) > budget) {
    let longest: { path: string; arr: unknown[]; set: (v: unknown[]) => void } | null = null;
    const walk = (v: unknown, path: string, set: (x: unknown[]) => void) => {
      if (Array.isArray(v)) {
        if (v.length > 1 && (!longest || size(v) > size(longest.arr))) longest = { path, arr: v, set };
        v.forEach((x, i) => walk(x, `${path}[${i}]`, (n) => { v[i] = n; }));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, (n) => { (v as Record<string, unknown>)[k] = n; });
      }
    };
    out = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    walk(out, '', () => {});
    const l = longest as { path: string; arr: unknown[]; set: (v: unknown[]) => void } | null;
    if (!l) break;
    const key = l.path || '(root)';
    const prior = cuts.get(key);
    const shown = Math.ceil(l.arr.length / 2);
    cuts.set(key, { total: prior?.total ?? l.arr.length, shown });
    l.set(l.arr.slice(0, shown));
  }
  for (const [path, c] of cuts) notes.push(`${path}: only the first ${c.shown} of ${c.total} shown`);
  return { ...(out as T), compacted: notes };
}

export async function planningContext(goalId: string) {
  return fitContext(await planningContextFull(goalId));
}

async function planningContextFull(goalId: string) {
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
  /**
   * Openings the planner set aside, each with why and the same record a considered opening carries (card, facts,
   * agreements), so a session can judge an exclusion on the evidence rather than on the reason alone (2026-11-27
   * frozen run, fx-15: the only opening was excluded and the author could not see its card to dispute it).
   */
  excluded: ({ opportunityId: string; title: string; reason: string } & OpeningRecord)[];
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
  /** Brain's planner's judgement of each chain link for this opening, with the basis that decides it. */
  links: { link: string; ok: boolean; basis: string }[];
  facts: { field: string; value: string | null; kind: string }[];
}

const OPENING_FIELDS = ['payer', 'reachableChannel', 'buyingSignal', 'signalObservedAt', 'offerScope', 'acceptanceCondition', 'priceCents', 'currency', 'paymentTerms', 'fulfillmentOwner', 'deliveryMethod', 'requiredInputs', 'deadline', 'economicsNote', 'peakFundingCents', 'humanHours', 'requiredCapabilities', 'industry', 'mechanism', 'state'] as const;

/** One opening's own record as the session sees it: the card fields a chain link rests on, its facts, its agreements. */
export interface OpeningRecord {
  card: Record<string, unknown>;
  agreements: { amountCents: number; currency: string; deliverable: string; evidenceKind: string; state: string; recordedBy: string }[];
  facts: { field: string; value: string | null; kind: string }[];
}

async function openingRecord(opportunityId: string): Promise<OpeningRecord> {
  const o = await getOpportunity(opportunityId);
  const row = (o ?? {}) as unknown as Record<string, unknown>;
  const card: Record<string, unknown> = {};
  // The opening's own record as Brain's planner reads it (`CashOpportunity`), every field a chain link rests on.
  for (const k of OPENING_FIELDS) if (row[k] !== undefined && row[k] !== null && row[k] !== '') card[k] = row[k];
  // Written agreements and commitments recorded against it (the journey's agreement rows): evidence the card's facts do not carry.
  const { agreementsFor } = await import('../../repos/cashJourney.ts');
  const agreements = (await agreementsFor(opportunityId).catch(() => [])).map((a) => ({ amountCents: a.amountCents, currency: a.currency, deliverable: a.deliverable, evidenceKind: a.evidenceKind, state: a.state, recordedBy: a.recordedBy }));
  const facts = (await cardFactsFor(opportunityId).catch(() => [])).map((f) => ({ field: f.field, value: f.value, kind: f.kind }));
  return { card, agreements, facts };
}

async function consideredOpenings(reading: { considered: { opportunityId: string; title: string; missing: string[]; stage: string; supportedReach: number; potentialReach: number | null }[]; strategies?: { opportunityIds: string[]; links: { link: string; ok: boolean; basis: string }[] }[] }): Promise<SessionOpening[]> {
  const out: SessionOpening[] = [];
  for (const c of reading.considered ?? []) {
    const { card, agreements, facts } = await openingRecord(c.opportunityId);
    // Brain's own judgement of each chain link for this opening, with the row or rule that decides it: the strategy
    // that holds this opening alone, else the first that holds it. What a session must answer before it disagrees.
    const strategy = (reading.strategies ?? []).find((one) => one.opportunityIds.length === 1 && one.opportunityIds[0] === c.opportunityId)
      ?? (reading.strategies ?? []).find((one) => one.opportunityIds.includes(c.opportunityId));
    const links = (strategy?.links ?? []).map((l) => ({ link: l.link, ok: l.ok, basis: l.basis }));
    out.push({ opportunityId: c.opportunityId, title: c.title, missing: [...c.missing], stage: c.stage, supportedReach: c.supportedReach, potentialReach: c.potentialReach, card, agreements, links, facts });
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

/**
 * How long one call waits for Brain's planner before answering. The Claude app's connector gives a tool call about 60 s
 * (§64: Brain answers within the time its caller waits); on a large project the planner can take minutes (production,
 * 2026-11-28, Cash Mode 1: "timed out after 60s" twice, then the run was lost). A call that outlasts its budget answers
 * "still reading", and the reading is recorded when it finishes, for the next call and for submitRevision to use.
 */
export const BRAIN_CALL_BUDGET_MS = 45_000;

/** Planner runs in progress, per goal: a later call waits on the one already running instead of starting another. */
const runningReads = new Map<string, Promise<BrainRunSummary>>();
/**
 * The planner call itself, per goal, which outlives a read that timed out: it holds the process's one scenario slot
 * until it ends, so the next read waits for it (bounded) rather than being refused as busy.
 */
const plannerCalls = new Map<string, Promise<void>>();

async function summarize(reading: NonNullable<Awaited<ReturnType<typeof import('../goals/plan.ts')['readGoalPlan']>>>, at: string): Promise<BrainRunSummary> {
  return {
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
    excluded: await Promise.all((reading.excluded ?? []).map(async (x) => ({ opportunityId: x.opportunityId, title: x.title, reason: x.reason, ...(await openingRecord(x.opportunityId)) }))),
    questions: await raiseQuestions(reading),
    scope: { targetCents: reading.target.targetCents, daysLeft: reading.target.daysLeft ?? null, hoursCeiling: reading.target.hoursCeiling ?? null, industry: reading.target.scope?.industry ?? null, recurring: reading.target.scope?.recurring ?? null, hoursPerWeek: reading.target.scope?.hoursPerWeek ?? null },
    at,
  };
}

/**
 * Brain's real planner on this goal, bounded in time: a failure is recorded as a failure, never as a reading, and a run
 * that outlasts the call's budget keeps going and records its reading when it finishes. Its answer then is
 * `running: true`, which is neither a reading nor a failure.
 */
export async function runBrain(input: { goalId: string; actor: PlanExecutor; evaluations?: number; timeoutMs?: number; budgetMs?: number }): Promise<BrainRunSummary & { running?: boolean }> {
  await liveGoal(input.goalId);
  let pending = runningReads.get(input.goalId);
  if (!pending) {
    const at = new Date().toISOString();
    const limit = input.timeoutMs ?? BRAIN_RUN_TIMEOUT_MS;
    pending = (async (): Promise<BrainRunSummary> => {
      let summary: BrainRunSummary;
      try {
        const { readGoalPlan } = await import('../goals/plan.ts');
        const previous = plannerCalls.get(input.goalId);
        if (previous) await Promise.race([previous, new Promise((r) => setTimeout(r, limit).unref?.())]);
        const call = readGoalPlan({ goalId: input.goalId, persist: true, evaluations: input.evaluations ?? 400 });
        const settled = call.then(() => undefined, () => undefined);
        plannerCalls.set(input.goalId, settled);
        void settled.then(() => { if (plannerCalls.get(input.goalId) === settled) plannerCalls.delete(input.goalId); });
        const reading = await Promise.race([
          call,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${Math.round(limit / 1000)} s`)), limit).unref?.()),
        ]);
        if (!reading) throw new Error('the planner returned no reading');
        summary = await summarize(reading, at);
      } catch (err) {
        summary = { completed: false, error: err instanceof Error ? err.message : String(err), verdict: null, summary: null, acceptance: null, considered: [], integrity: [], steps: [], nextTest: null, openings: [], excluded: [], questions: [], scope: null, at };
      }
      await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.brain, summary: summary.completed ? `Brain planner read: ${summary.verdict}` : `Brain planner FAILED: ${summary.error}`, detail: { summary }, actorRef: actorOf(input.actor) });
      return summary;
    })();
    runningReads.set(input.goalId, pending);
    const mine = pending;
    void mine.finally(() => { if (runningReads.get(input.goalId) === mine) runningReads.delete(input.goalId); });
  }
  const budget = input.budgetMs ?? BRAIN_CALL_BUDGET_MS;
  const done = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), budget).unref?.())]);
  if (done) return done;
  return {
    completed: false, running: true,
    error: `Brain's planner is still reading this goal (it takes longer than one call may wait); its reading is recorded when it finishes — call brain_planning_run_brain again in a minute, or read it in brain_planning_context`,
    verdict: null, summary: null, acceptance: null, considered: [], integrity: [], steps: [], nextTest: null, openings: [], excluded: [], questions: [], scope: null, at: new Date().toISOString(),
  };
}

/** Openings the session may plan on: those linked to the goal, and those Brain's own planner weighed for it. */
export async function admittedIds(goalId: string): Promise<string[]> {
  const linked = (await listLinks(goalId)).filter((l) => l.kind === 'OPPORTUNITY').map((l) => l.ref);
  const run = (await events(goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined;
  // An opening Brain's planner excluded is still this goal's opening: a session may build on it once it states why the
  // exclusion is wrong (EXCLUSION_DISPUTE_UNSTATED), so it is admitted (run 8, ah-06: all three openings excluded).
  return [...new Set([...linked, ...(run?.openings ?? []).map((o) => o.opportunityId), ...(run?.excluded ?? []).map((x) => x.opportunityId)])];
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
  // Verification is dealt through the work queue to a worker other than the researcher, like a plan review.
  const verifyItem = await requestVerification(input.goalId, projectId, q.needId, attempt, principalOf(input.actor.id), claims.map((c) => c.claimId));
  return { ...detail, verifyItem };
}

/** The queue's work type for independent verification of session research; one item per submission. */
export const PLAN_VERIFY_WORK = 'PLAN_VERIFY';
const verifyCorrelation = (needId: string, attempt: number) => `plan-verify:${needId}:${attempt}`;

const VERIFY_INSTRUCTIONS =
        'Independent verification of research submitted for one planning question. Read brain_planning_context for goalId (the question ' +
        'and each submitted claim: text, source URL, excerpt, locator). Open each source yourself; answer brain_planning_verify_research ' +
        'with need_id, one verdict per claim (supportsClaim, and scopeMatch geography/timeframe/population/definitions: MATCH, MISMATCH, ' +
        'UNKNOWN, NOT_APPLICABLE or UNSTATED, each with its basis) and sufficiency; then brain_complete_work. The researcher may not ' +
        'verify its own research: release the item if that is you.';

async function requestVerification(goalId: string, projectId: string, needId: string, attempt: number, researcherPrincipal: string, claimIds: string[]): Promise<{ id: string; created: boolean }> {
  const { getDb } = await import('../../db/database.ts');
  const correlation = verifyCorrelation(needId, attempt);
  const existing = await getDb().get<{ id: string }>(`SELECT id FROM work_items WHERE project_id = ? AND work_type = ? AND correlation_id = ?`, [projectId, PLAN_VERIFY_WORK, correlation]);
  if (existing) return { id: existing.id, created: false };
  const { enqueueWork } = await import('../../repos/workQueue.ts');
  const binId = await reviewBin({ goalId, projectId, title: `Verify research ${needId} (attempt ${attempt})`, instructions: VERIFY_INSTRUCTIONS, independentOf: researcherPrincipal });
  const item = await enqueueWork({
    projectId,
    binId,
    workType: PLAN_VERIFY_WORK,
    payload: {
      goalId, needId, attempt, researcherPrincipal, claimIds,
      instructions: VERIFY_INSTRUCTIONS,
    },
    requiredScopes: ['project:read', 'queue:complete'],
    correlationId: correlation,
    createdByType: 'SYSTEM',
    createdById: 'session-planning',
  });
  return { id: item.id, created: true };
}

/** Whether `principalId` holds a live lease on a verification item for `needId` and is not its researcher. */
export async function leasedVerificationFor(principalId: string, needId: string, now: string = new Date().toISOString()): Promise<boolean> {
  const { getDb } = await import('../../db/database.ts');
  const rows = await getDb().all<{ payload: string }>(
    `SELECT payload FROM work_items WHERE work_type = ? AND correlation_id LIKE ? AND state = 'LEASED' AND worker_id = ? AND lease_expires_at > ?`,
    [PLAN_VERIFY_WORK, `plan-verify:${needId}:%`, principalId, now],
  );
  return rows.some((row) => ((typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as { researcherPrincipal?: string }).researcherPrincipal !== principalId);
}

/** Whether a verification of `needId` by `principalId` is recorded: what completing its verification item requires. */
export async function verificationRecordedBy(goalId: string, needId: string, principalId: string): Promise<boolean> {
  return (await events(goalId, PLANNING_EVENTS.research)).some((e) => e.detail['phase'] === 'VERIFIED' && e.detail['needId'] === needId && principalOf(String((e.detail['verifier'] as PlanExecutor | undefined)?.id ?? '')) === principalId);
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
 * Where a payload's sections have the wrong shape, each with its path. A malformed section is refused here, by name,
 * rather than crashing a check downstream (production, 2026-11-28, the owner's app journey: a NO_PLAN revision sent a
 * strategy with no `opportunityIds`, and every submit failed with "ids is not iterable").
 */
export function shapeProblems(r: Partial<PlanRevisionInput>): string[] {
  const out: string[] = [];
  const arr = (v: unknown) => Array.isArray(v);
  const strings = (v: unknown) => arr(v) && (v as unknown[]).every((x) => typeof x === 'string');
  if (r.strategy !== undefined && r.strategy !== null) {
    if (typeof r.strategy !== 'object') out.push('strategy must be an object {title, opportunityIds, why}');
    else if (!strings((r.strategy as { opportunityIds?: unknown }).opportunityIds)) out.push('strategy.opportunityIds must be an array of opening ids (empty for a no-plan result)');
  }
  for (const k of ['alternatives', 'steps', 'cash', 'quantities', 'sources', 'answers', 'chain', 'excluded', 'members', 'resolves', 'constraints', 'disagreements'] as const) {
    const v = (r as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && !arr(v)) out.push(`${k} must be an array`);
  }
  (r.chain ?? []).forEach((c, i) => { if (!c || typeof c.opportunityId !== 'string' || !strings(c.missing)) out.push(`chain[${i}] must be {opportunityId, missing: [links]}`); });
  (r.excluded ?? []).forEach((x, i) => { if (!x || typeof x.opportunityId !== 'string') out.push(`excluded[${i}] must be {opportunityId, why}`); });
  if (r.resolves !== undefined && r.resolves !== null && !strings(r.resolves)) out.push('resolves must be an array of chain links');
  if (r.validation && typeof r.validation === 'object' && r.validation.decides !== undefined && !strings(r.validation.decides)) out.push('validation.decides must be an array of chain links');
  return out;
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
  const malformed = shapeProblems(input.revision);
  if (malformed.length) throw new PlanningRefusal(`the revision is malformed: ${malformed.join('; ')}`, 'planning:revision');
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
    ...(input.revision.disagreements ? { disagreements: input.revision.disagreements } : {}),
    ...(missing.length || input.revision.truncated ? { truncated: true } : {}),
  };
  const lastContribution = (await events(goalId, PLANNING_EVENTS.contribution)).pop();
  let brainRun = ((await events(goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined) ?? null;
  if (!brainRun || (lastContribution && brainRun.at < lastContribution.createdAt)) {
    const fresh = await runBrain({ goalId, actor: input.actor });
    if (fresh.running) throw new PlanningRefusal(`${fresh.error}; then submit this revision again (nothing was recorded)`, 'planning:revision');
    brainRun = fresh;
  }
  const admitted = await admittedIds(goalId);
  const fulfilment = await fulfilmentOf(r.strategy.opportunityIds);
  r.steps = await withExecutors(r.steps, r.strategy.opportunityIds, fulfilment);
  const links = Object.fromEntries((brainRun.openings ?? []).filter((o) => o.links?.length).map((o) => [o.opportunityId, o.links]));
  const weighed = [...new Set([...r.strategy.opportunityIds, ...(r.chain ?? []).map((c) => c.opportunityId)])];
  const facts = await cardFactsOf(weighed);
  const reviewConditions = r.parentRevisionId ? await conditionsOn(goalId, r.parentRevisionId) : [];
  const brain: BrainFacts = { admittedOpportunityIds: admitted, integrity: integrityFor(brainRun, r.strategy.opportunityIds), completed: brainRun.completed, error: brainRun.error, fulfilment, hoursCeiling: (await storedTerms(goalId)).hoursCeiling, links, facts, reviewConditions, excluded: Object.fromEntries((brainRun.excluded ?? []).map((x) => [x.opportunityId, x.reason])), discovered: await discoveredIds(goalId, weighed) };
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
  // A clean revision is dealt for independent review through Brain's own work queue, so no person shuttles it
  // between sessions: any connected worker other than the author claims it, and its lease is its authority to review.
  const reviewItem = problems.length === 0 ? await requestReview(goalId, revision) : null;
  return { revision, problems, trace, brain: brainRun, reviewItem };
}

/**
 * The one-item bin a review or verification item belongs to. Claude routines are handed bins through
 * `brain_check_in` and nothing else, so an item no bin carries never reached the fleet on production (2026-11-27,
 * the app journey: twelve routines idle while the review waited). The bin names its goal, which admits it under
 * the owner's §118 exception exactly when the goal is owner-directed, and the principal whose work it judges, who is
 * never handed it. A worker that claims the item directly (`brain_claim_work`) still may: the bin only adds a door.
 */
async function reviewBin(input: { goalId: string; projectId: string; title: string; instructions: string; independentOf: string }): Promise<string> {
  const { createBin } = await import('../../repos/bins.ts');
  const bin = await createBin({
    projectId: input.projectId,
    goalId: input.goalId,
    kind: 'PLAN_REVIEW',
    title: input.title,
    objective: input.instructions,
    rationale: 'Independent review on the app-session planning path: the author may not certify its own plan.',
    manifest: {
      objective: input.instructions,
      why: 'A plan is published only after a reviewer other than its author passes the exact revision Brain checked.',
      independentOf: [input.independentOf],
      lineage: { projectId: input.projectId, layerId: null, goal: null, orchestrationId: null },
      units: [],
      acceptableSources: ['brain_planning_state and brain_planning_context for the goal', 'the public sources the revision and its research cite'],
      excludedSources: ['anything the author says about its own plan outside the recorded revision'],
      evidence: ['the review (or verification) recorded by this worker against the exact revision (or research answer) named'],
      outputs: ['one brain_planning_review or brain_planning_verify_research record'],
      authorizedActions: ['claim the bin\'s one item with brain_bin_next_item', 'read the goal\'s planning state and context', 'open the cited sources', 'record the review or verification', 'complete the item and the bin'],
      prohibitedActions: ['changing the plan, the goal or its terms', 'spending, contacting anyone, or any external effect', 'reviewing work this worker wrote'],
      budgetUnits: 1,
      retry: { maxAttempts: 6, backoffSeconds: 60 },
      stoppingConditions: ['the item is complete'],
    },
    completionContract: 'PLAN_REVIEW_V1',
    workloadClass: 'RESEARCH_PLAN_REVIEW_V1',
    maxAttempts: 6,
    priority: 8,
    ready: true,
    createdByType: 'SYSTEM',
    createdById: 'session-planning',
  });
  return bin.id;
}

const REVIEW_INSTRUCTIONS =
        'Independent review of one plan revision. Read brain_planning_state and brain_planning_context for goalId; judge the revision ' +
        'this item names (revisionId — not whichever is current) skeptically from the evidence, recomputing the arithmetic for every opening it weighs (deals at the evidenced price ' +
        'against the target, capital per cycle against the limits, when the cash settles against the window) and checking that any ' +
        'test does not take buyers’ orders before the opening’s fulfilment is shown possible, and that passing it at its threshold carries ' +
  'the target; record brain_planning_review with verdict PASS or REVISE, ' +
        'reasons and findings — any condition (a link you judge unestablished) goes in `conditions` with the card fact or missing ' +
  'prerequisite it rests on; against a price Brain’s planner establishes, name its `defect` (PERSON_WORD, CONTRADICTED or NOT_A_PURCHASE) or let it stand — ' +
        'then brain_complete_work. The author of the revision may not review it: release the item if that is you.';

/** The queue's work type for an independent plan review; one item per revision. */
export const PLAN_REVIEW_WORK = 'PLAN_REVIEW';
const reviewCorrelation = (revisionId: string) => `plan-review:${revisionId}`;
/** The principal behind an executor id (`<principal>/<session>`), or the whole id. */
const principalOf = (id: string) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : id);

/**
 * Enqueue the review of one revision (idempotent: one item per revision). The payload names the revision and its
 * author's principal and tells the claimant what to do; nothing in it is authority — the lease is.
 */
export async function requestReview(goalId: string, revision: Pick<PlanRevision, 'revisionId' | 'digest' | 'author'>): Promise<{ id: string; created: boolean }> {
  const goal = await liveGoal(goalId);
  if (!goal.projectId) throw new PlanningRefusal(`goal ${goalId} belongs to no project`, 'planning:review');
  const { getDb } = await import('../../db/database.ts');
  const existing = await getDb().get<{ id: string }>(`SELECT id FROM work_items WHERE project_id = ? AND work_type = ? AND correlation_id = ?`, [goal.projectId, PLAN_REVIEW_WORK, reviewCorrelation(revision.revisionId)]);
  if (existing) return { id: existing.id, created: false };
  const { enqueueWork } = await import('../../repos/workQueue.ts');
  const instructions = REVIEW_INSTRUCTIONS;
  const binId = await reviewBin({ goalId, projectId: goal.projectId, title: `Review plan revision ${revision.revisionId}`, instructions, independentOf: principalOf(revision.author.id) });
  const item = await enqueueWork({
    projectId: goal.projectId,
    binId,
    workType: PLAN_REVIEW_WORK,
    payload: {
      goalId,
      revisionId: revision.revisionId,
      revisionDigest: revision.digest,
      authorPrincipal: principalOf(revision.author.id),
      instructions,
    },
    requiredScopes: ['project:read', 'queue:complete'],
    correlationId: reviewCorrelation(revision.revisionId),
    createdByType: 'SYSTEM',
    createdById: 'session-planning',
  });
  return { id: item.id, created: true };
}

/**
 * Whether `principalId` holds a live lease on the review item of `revisionId` and is not its author: the queue's
 * grant of authority to review exactly that revision, and nothing else.
 */
export async function leasedReviewFor(principalId: string, revisionId: string, now: string = new Date().toISOString()): Promise<boolean> {
  const { getDb } = await import('../../db/database.ts');
  const row = await getDb().get<{ payload: string }>(
    `SELECT payload FROM work_items WHERE work_type = ? AND correlation_id = ? AND state = 'LEASED' AND worker_id = ? AND lease_expires_at > ?`,
    [PLAN_REVIEW_WORK, reviewCorrelation(revisionId), principalId, now],
  );
  if (!row) return false;
  const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as { authorPrincipal?: string };
  return payload.authorPrincipal !== principalId;
}

/** Whether a review of `revisionId` by `principalId` is recorded: what completing its review item requires. */
export async function reviewRecordedBy(goalId: string, revisionId: string, principalId: string): Promise<boolean> {
  return (await events(goalId, PLANNING_EVENTS.review)).some((e) => {
    const r = e.detail['review'] as PlanReview;
    return r.revisionId === revisionId && principalOf(r.reviewer.id) === principalId;
  });
}

// ------------------------------------------------------------------------------------- review

/**
 * Record a reviewer's verdict on one revision. The reviewer must be explicitly identified; the
 * author reviewing itself is recorded but never certifies; UNAVAILABLE records that no reviewer
 * answered (nothing is certified).
 */
export async function recordReview(input: { goalId: string; revisionId: string; reviewer: PlanExecutor; verdict: PlanReview['verdict']; reasons: string; findings: string[]; conditions?: ReviewCondition[]; resolution?: string | null }) {
  const rev = (await revisions(input.goalId)).find((r) => r.revisionId === input.revisionId);
  if (!rev) throw new PlanningRefusal(`no revision ${input.revisionId} on this goal`, 'planning:review');
  if (!input.reviewer.id.trim()) throw new PlanningRefusal('the reviewer must be explicitly identified', 'planning:review');
  if (input.verdict !== 'UNAVAILABLE' && !input.reasons.trim()) throw new PlanningRefusal('a verdict must carry its reasons', 'planning:review');
  const conditions = input.conditions ?? [];
  if (conditions.length && input.verdict !== 'REVISE') throw new PlanningRefusal('only a REVISE review proposes conditions', 'planning:review');
  // A proposed condition names its supporting record or a genuinely absent prerequisite, or it is not recorded.
  const lastRun = (await events(input.goalId, PLANNING_EVENTS.brain)).pop()?.detail['summary'] as BrainRunSummary | undefined;
  const established = Object.fromEntries((lastRun?.openings ?? []).map((o) => [o.opportunityId, (o.links ?? []).filter((l) => l.ok).map((l) => l.link)]));
  const wrong = conditionProblems(conditions, rev, await cardFactsOf([...new Set([...rev.strategy.opportunityIds, ...(rev.chain ?? []).map((c) => c.opportunityId)])]), established);
  if (wrong.length) throw new PlanningRefusal(`each proposed condition must identify its evidence or a missing prerequisite: ${wrong.join('; ')}`, 'planning:review');
  const review: PlanReview = { revisionId: rev.revisionId, revisionDigest: rev.digest, author: rev.author, reviewer: input.reviewer, verdict: input.verdict, reasons: input.reasons, findings: input.findings, resolution: input.resolution ?? null, at: new Date().toISOString() };
  await recordWorkstreamEvent({ workstreamId: input.goalId, kind: PLANNING_EVENTS.review, summary: `Review of ${rev.revisionId} by ${input.reviewer.kind} ${input.reviewer.id}: ${input.verdict}`, detail: { review, conditions, independent: !sameExecutor(rev.author, input.reviewer) }, actorRef: actorOf(input.reviewer) });
  return { review, conditions, independent: !sameExecutor(rev.author, input.reviewer) };
}

/** The card facts (field and kind) of each opening, read from its card. */
async function cardFactsOf(ids: string[]): Promise<CardFacts> {
  const out: CardFacts = {};
  for (const id of ids) out[id] = (await cardFactsFor(id).catch(() => [])).map((f) => ({ field: f.field, kind: f.kind }));
  return out;
}

/** The conditions the last REVISE review of a revision proposed. */
async function conditionsOn(goalId: string, revisionId: string): Promise<ReviewCondition[]> {
  const last = (await events(goalId, PLANNING_EVENTS.review)).filter((e) => (e.detail['review'] as PlanReview).revisionId === revisionId).pop();
  if (!last || (last.detail['review'] as PlanReview).verdict !== 'REVISE') return [];
  return (last.detail['conditions'] as ReviewCondition[] | undefined) ?? [];
}

// ------------------------------------------------------------------------------------- state

export async function planningState(goalId: string) {
  const contract = await currentContract(goalId);
  const revs = await revisions(goalId);
  const checks = (await events(goalId, PLANNING_EVENTS.check)).map((e) => e.detail as { revisionId: string; digest: string; contractDigest: string; problems: CheckProblem[]; trace: unknown; brain: BrainRunSummary });
  const reviews = (await events(goalId, PLANNING_EVENTS.review)).map((e) => ({ ...(e.detail['review'] as PlanReview), conditions: (e.detail['conditions'] as ReviewCondition[] | undefined) ?? [] }));
  const finals = (await events(goalId, PLANNING_EVENTS.final)).map((e) => e.detail as { revisionId: string; digest: string; contractDigest: string; plan: PlanRevision; review: PlanReview; at: string; basis?: PlanBasis });
  const current = revs[revs.length - 1] ?? null;
  const currentCheck = current ? (checks.filter((c) => c.revisionId === current.revisionId).pop() ?? null) : null;
  const final = finals[finals.length - 1] ?? null;
  // A published plan rests on the goal's words and terms and on the records of the openings it weighed; once any of
  // them changes, the plan is history until a session plans the world as it now stands (acceptance run 2026-11-27:
  // an objective narrowed to one industry, a cut capital limit and new contradicting evidence each left the old plan
  // reported as current, so no session knew to re-plan).
  const changed = final?.basis ? await basisChanges(goalId, final.basis) : [];
  const current_ = final && current && final.revisionId === current.revisionId && contract && final.contractDigest === contract.digest && changed.length === 0;
  return {
    contract,
    revisions: revs,
    current,
    currentCheck,
    reviews,
    // A final built on a superseded revision, an old contract or a basis that has since changed is history, not the plan.
    final: current_ ? final : null,
    staleFinal: final && !current_ ? final : null,
    staleBecause: final && !current_ ? (changed.length ? changed : ['the published revision is no longer the current revision or its contract was superseded']) : [],
  };
}

/**
 * The integrity findings of Brain's planner run that bear on this plan. A finding that quotes an opening the plan does not
 * build on is about Brain's own reading of that opening, not about this plan (run 8, ai-02: a label-design route the
 * session had set aside was "NO_FAVOURABLE_UNKNOWN" over the cap, and refused every revision, whatever it used). A finding
 * that names no opening, or one the plan uses, still binds.
 */
export function integrityFor(run: BrainRunSummary, used: readonly string[]): BrainRunSummary['integrity'] {
  const titled = [...(run.openings ?? []).map((o) => ({ id: o.opportunityId, title: o.title })), ...(run.excluded ?? []).map((x) => ({ id: x.opportunityId, title: x.title }))];
  return (run.integrity ?? []).filter((v) => {
    const quoted = [...v.detail.matchAll(/"([^"]{8,})"/g)].map((m) => m[1]!.replace(/…$/, '').trim());
    const named = titled.filter((o) => quoted.some((q) => o.title.startsWith(q) || q.startsWith(o.title)));
    return named.length === 0 || named.some((o) => used.includes(o.id));
  });
}

/** The openings among `ids` that this goal's sessions proposed as routes (record id under the goal's route prefix). */
async function discoveredIds(goalId: string, ids: readonly string[]): Promise<string[]> {
  const { goalRoutePrefix } = await import('../../domain/routeOrigin.ts');
  const prefix = goalRoutePrefix(goalId);
  const out: string[] = [];
  for (const id of ids) {
    const o = (await getOpportunity(id)) as unknown as { externalRecordId?: string | null } | null;
    if (o?.externalRecordId?.startsWith(prefix)) out.push(id);
  }
  return out;
}

/** What a published plan rests on, fingerprinted: the goal's words, its stored terms, and each weighed opening's record. */
interface PlanBasis { intent: string; terms: string; openings: Record<string, string> }

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

async function planBasis(goalId: string, opportunityIds: readonly string[]): Promise<PlanBasis> {
  const goal = await liveGoal(goalId);
  const { proven: _proven, projectId: _project, ...terms } = await storedTerms(goalId);
  const openings: Record<string, string> = {};
  for (const id of [...new Set(opportunityIds)].sort()) openings[id] = fingerprint(await openingRecord(id));
  return { intent: (goal.intent ?? '').replace(/\s+/g, ' ').trim(), terms: fingerprint(terms), openings };
}

/** What changed since `basis` was recorded, in words; empty when nothing did. */
async function basisChanges(goalId: string, basis: PlanBasis): Promise<string[]> {
  const now = await planBasis(goalId, Object.keys(basis.openings)).catch(() => null);
  if (!now) return ['the goal could not be read'];
  const out: string[] = [];
  if (now.intent !== basis.intent) out.push("the owner's objective changed since publication");
  if (now.terms !== basis.terms) out.push("the goal's stored terms (target, window, capital or hours) changed since publication");
  for (const [id, fp] of Object.entries(basis.openings)) if (now.openings[id] !== fp) out.push(`the record of opening ${id} (its card, facts or agreements) changed since publication`);
  return out;
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
  const brainRun = state.currentCheck!.brain;
  const weighed = [...rev.strategy.opportunityIds, ...(brainRun?.openings ?? []).map((o) => o.opportunityId), ...(brainRun?.excluded ?? []).map((x) => x.opportunityId)];
  const basis = await planBasis(input.goalId, weighed);
  const detail = { revisionId: rev.revisionId, digest: rev.digest, contractDigest: state.contract.digest, plan: rev, review, basis, at: new Date().toISOString() };
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
