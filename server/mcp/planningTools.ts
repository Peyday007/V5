/**
 * The app-session planning adapter as MCP tools (sessionPlanning.ts). The owner's Claude app
 * session reaches them through the same connector and the same authorization as the operator
 * tools: reading a goal needs project READ; every write needs operator WRITE on the goal's
 * project. Planning authority is all these grant — no tool here spends, contacts a buyer,
 * resumes a goal or writes a verified fact; a refusal names the exact scope it lacks.
 */
import { authorize, MUTATING, READ_ONLY, optionalString, requiredString, type McpTool } from './toolkit.ts';
import { decideProjectAccess } from '../services/identity/policy.ts';
import { invalidInput, notFoundError } from './errors.ts';
import { getWorkstream } from '../repos/register.ts';
import type { Principal } from '../domain/types.ts';
import type { PlanExecutor } from '../domain/planReady.ts';
import { REVISION_SCHEMA } from '../domain/sessionPlanning.ts';

export { REVISION_SCHEMA };

async function goalProject(goalId: string): Promise<string> {
  const goal = await getWorkstream(goalId);
  if (!goal?.projectId) throw notFoundError();
  return goal.projectId;
}

/** The session executor: the connected principal plus the app session it speaks for. */
function sessionExecutor(principal: Principal, args: Record<string, unknown>): PlanExecutor {
  const session = requiredString(args, 'session_id');
  return { kind: 'APP_SESSION', id: `${principal.id}/${session}`, model: optionalString(args, 'model') };
}

function objectArg(args: Record<string, unknown>, field: string): Record<string, unknown> {
  const v = args[field];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalidInput(`${field} must be an object.`);
  return v as Record<string, unknown>;
}

const SESSION = {
  session_id: { type: 'string', description: 'The app session this call speaks for (stable across a resumed session).' },
  model: { type: 'string', description: 'The model executing in that session, e.g. claude-opus-5-5.' },
} as const;

async function guarded(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return (await fn()) as Record<string, unknown>;
  } catch (err) {
    const { PlanningRefusal } = await import('../services/planning/sessionPlanning.ts');
    if (err instanceof PlanningRefusal) return { ok: false, refused: true, reason: err.message, scope: err.scope };
    throw err;
  }
}

const contractTool: McpTool = {
  name: 'brain_planning_contract',
  title: 'Planning: establish the goal contract',
  description:
    "State the goal contract the session plans against: the owner's words verbatim, their source, and the interpreted " +
    'terms (target, window, total-spend cap, pre-proof cap, exposure cap, proof condition, owner hours and physical work, ' +
    'exclusions, evidence exclusions), all money in cents, null where the owner set none. Refused when a term differs ' +
    'from the goal Brain stored without an explanation. A changed contract invalidates revisions built on the old one.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' },
      words: { type: 'string' },
      source: { type: 'object' },
      terms: { type: 'object' },
      explanations: { type: 'object' },
      ...SESSION,
    },
    required: ['goal_id', 'words', 'source', 'terms', 'session_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Planning: contract', ...MUTATING, idempotentHint: true },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'WRITE', 'operator:act');
    const { establishContract } = await import('../services/planning/sessionPlanning.ts');
    return {
      projectId,
      value: await guarded(() => establishContract({ goalId, words: requiredString(args, 'words'), source: objectArg(args, 'source') as never, terms: objectArg(args, 'terms') as never, explanations: (args['explanations'] ?? {}) as never, actor: sessionExecutor(principal, args) })),
    };
  },
};

const contextTool: McpTool = {
  name: 'brain_planning_context',
  title: 'Planning: the goal-scoped context',
  description:
    "The goal contract, the stored goal's terms, the goal-linked openings with their card facts, the exclusions, the " +
    'open check problems, the revision history (stale ones marked) and the last review — what the next decision needs.',
  inputSchema: { type: 'object', properties: { goal_id: { type: 'string' } }, required: ['goal_id'], additionalProperties: false },
  annotations: { title: 'Planning: context', ...READ_ONLY },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'READ', 'project:read');
    const { planningContext } = await import('../services/planning/sessionPlanning.ts');
    return { projectId, value: await guarded(() => planningContext(goalId)) };
  },
};

const routesTool: McpTool = {
  name: 'brain_planning_admit_routes',
  title: 'Planning: submit candidate routes',
  description:
    'Submit candidate routes (the route proposer’s JSON shape: title, payer, offer, channel, mechanism, price, performer, ' +
    'fulfiller, directCost (null when unknown), capital, daysToFirstCash, buyerCount, assumptions, grounds…). Each goes ' +
    'through Brain’s own route parser and writer as a hypothesis; rejected routes return the parser’s reason.',
  inputSchema: {
    type: 'object',
    properties: { goal_id: { type: 'string' }, routes: { type: 'array', items: { type: 'object' } }, ...SESSION },
    required: ['goal_id', 'routes', 'session_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Planning: admit routes', ...MUTATING, idempotentHint: true },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'WRITE', 'operator:act');
    if (!Array.isArray(args['routes'])) throw invalidInput('routes must be an array.');
    const { admitRoutes } = await import('../services/planning/sessionPlanning.ts');
    return { projectId, value: await guarded(() => admitRoutes({ goalId, routes: args['routes'] as unknown[], actor: sessionExecutor(principal, args) })) };
  },
};

const brainTool: McpTool = {
  name: 'brain_planning_run_brain',
  title: 'Planning: run Brain’s planner on the goal',
  description: "Run Brain's real planner (readGoalPlan) on the goal and return its complete summary; a failure is returned as a failure. On a large project the planner can take longer than one call may wait: the answer is then `running: true` — the run keeps going and records its reading when it finishes; call again in a minute to get it.",
  inputSchema: { type: 'object', properties: { goal_id: { type: 'string' }, ...SESSION }, required: ['goal_id', 'session_id'], additionalProperties: false },
  annotations: { title: 'Planning: run Brain', ...MUTATING, idempotentHint: true },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'WRITE', 'operator:act');
    const { runBrain, fitContext } = await import('../services/planning/sessionPlanning.ts');
    // Its reading is fitted like the context (production, 2026-11-28, Cash Mode 1: a finished run's reading of ~25
    // openings with their records came back "too large to return"); the full reading stays recorded for the checks.
    return { projectId, value: fitContext((await guarded(() => runBrain({ goalId, actor: sessionExecutor(principal, args) }))) as unknown as Record<string, unknown>) };
  },
};

const researchTool: McpTool = {
  name: 'brain_planning_research',
  title: 'Planning: submit research for an open question',
  description:
    'Submit sourced claims answering one open research question (the context lists them, parked ones marked): each with its claim, ' +
    'source URL, title, publisher, the date the source prints, the verbatim passage and where it is. They enter Brain\'s research ' +
    'packet for that question unaccepted; each claim\'s source validation comes back now, and only the evidence gate, on an ' +
    'independent verifier\'s reading (brain_planning_verify_research), can accept it. Or unanswered=true after a search that found nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' }, need_id: { type: 'string' }, method: { type: 'string' },
      claims: { type: 'array', items: { type: 'object' } }, unanswered: { type: 'boolean' }, ...SESSION,
    },
    required: ['goal_id', 'need_id', 'method', 'session_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Planning: research', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'WRITE', 'operator:act');
    const { answerResearch } = await import('../services/planning/sessionPlanning.ts');
    const claims = Array.isArray(args['claims']) ? (args['claims'] as Record<string, unknown>[]).map((o) => ({
      claim: String(o['claim'] ?? ''), sourceUrl: String(o['sourceUrl'] ?? o['url'] ?? ''), sourceTitle: o['sourceTitle'] == null ? null : String(o['sourceTitle']),
      sourcePublisher: o['sourcePublisher'] == null ? null : String(o['sourcePublisher']), sourceDate: o['sourceDate'] == null ? null : String(o['sourceDate']),
      evidenceExcerpt: String(o['evidenceExcerpt'] ?? ''), evidenceLocator: String(o['evidenceLocator'] ?? ''), primarySource: o['primarySource'] === true,
    })) : [];
    return { projectId, value: await guarded(() => answerResearch({ goalId, needId: requiredString(args, 'need_id'), actor: sessionExecutor(principal, args), method: requiredString(args, 'method'), claims, unanswered: args['unanswered'] === true })) };
  },
};

const verifyResearchTool: McpTool = {
  name: 'brain_planning_verify_research',
  title: 'Planning: verify submitted research through the evidence gate',
  description:
    'An independent verifier (never the researcher) reads each submitted claim\'s source and answers whether it supports the claim and ' +
    'whether its geography, timeframe, population and definitions match the question (MATCH, MISMATCH, UNKNOWN, NOT_APPLICABLE, UNSTATED), ' +
    'plus whether the research is SUFFICIENT. Brain\'s evidence gate decides each claim; an accepted one becomes the card\'s evidence and ' +
    'the planner reruns. Returns acceptance or each rejection reason and what changed in the planning input.',
  inputSchema: {
    type: 'object',
    properties: { goal_id: { type: 'string' }, need_id: { type: 'string' }, verdicts: { type: 'array', items: { type: 'object' } }, sufficiency: { type: 'string', enum: ['SUFFICIENT', 'INSUFFICIENT'] }, ...SESSION },
    required: ['goal_id', 'need_id', 'verdicts', 'sufficiency', 'session_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Planning: verify research', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    const { verifyResearch, leasedVerificationFor } = await import('../services/planning/sessionPlanning.ts');
    // Operator authority, or the queue's grant: a live lease on this question's PLAN_VERIFY item, not the researcher's.
    if (!decideProjectAccess(principal, projectId, 'WRITE', 'operator:act').allowed) {
      await authorize(principal, projectId, 'WRITE', 'queue:complete');
      if (!(await leasedVerificationFor(principal.id, requiredString(args, 'need_id')))) throw notFoundError();
    }
    return { projectId, value: await guarded(() => verifyResearch({ goalId, needId: requiredString(args, 'need_id'), verifier: sessionExecutor(principal, args), verdicts: verdictsArg(args) as never, sufficiency: sufficiencyArg(args) })) };
  },
};

/*
 * A verification is a judgement of every claim; a call without one is not a verdict of INSUFFICIENT (run 11, d01: a call
 * with no verdicts and no sufficiency was taken as one, blocked the fragment, and the verifier's real reading was then
 * refused as already judged). The schema already marks both required; the transport now refuses rather than defaults.
 */
export function verdictsArg(args: Record<string, unknown>): unknown[] {
  const v = args['verdicts'];
  if (!Array.isArray(v) || v.length === 0) throw invalidInput('`verdicts` is required: one verdict per submitted claim (see brain_planning_context)');
  return v;
}
export function sufficiencyArg(args: Record<string, unknown>): 'SUFFICIENT' | 'INSUFFICIENT' {
  const s = args['sufficiency'];
  if (s !== 'SUFFICIENT' && s !== 'INSUFFICIENT') throw invalidInput('`sufficiency` is required: SUFFICIENT or INSUFFICIENT');
  return s;
}

/*
 * The revision's shape, stated to the caller. Production, 2026-11-28 (Cash Mode 1, the owner's Claude app): with the
 * revision declared only as `{type: 'object'}`, the app's model sent `strategy` as a sentence and `chain` as bare
 * opening ids on all three of its submits (req_nCcmZgPf0SDt, req_zqzWnNHfVlwa, req_I-7_5uk8sDO9) and again at 03:41Z,
 * because nothing it could read said otherwise. Guidance only: `shapeProblems` remains the refusal, by path.
 */

const revisionTool: McpTool = {
  name: 'brain_planning_submit_revision',
  title: 'Planning: submit a plan revision',
  description:
    'Submit a plan revision (stance, strategy, alternatives, steps, cash sequence, proof day, quantities with UNKNOWN as null, ' +
    'sources with population and buyer match (and `opportunityId` for a public source about an opening the session discovered), ' +
    'validation (for a conditional plan, `decides`: the chain link(s) whose measurement decides whether it goes on) or no-plan ' +
    'reasoning, reach with its calibration, answers to the last review). Every opening on the goal goes in `chain` (weighed) or ' +
    '`excluded` (with why, e.g. outside a changed objective). A no-plan or conditional result states `members` for every opening ' +
    'it weighs: deals needed at its price, direct cost, capital per cycle and `settlesDay`, null exactly where that link is ' +
    'unestablished; a test that measures CONVERSION by selling also measures FULFILMENT where it is unestablished, and states ' +
    '`validation.threshold` {paid, of, reach} so passing it carries the target. Under an owner-hours limit each member states ' +
    '`ownerHours`. A quantity is EVIDENCED only on a source Brain\'s evidence gate did not reject. Brain checks ' +
    'it against the contract and its planner and returns every concrete problem to revise.',
  inputSchema: { type: 'object', properties: { revision: REVISION_SCHEMA, ...SESSION }, required: ['revision', 'session_id'], additionalProperties: false },
  annotations: { title: 'Planning: submit revision', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const revision = objectArg(args, 'revision');
    const goalId = String(revision['goalId'] ?? '');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'WRITE', 'operator:act');
    const { submitRevision } = await import('../services/planning/sessionPlanning.ts');
    return { projectId, value: await guarded(() => submitRevision({ revision: revision as never, actor: sessionExecutor(principal, args) })) };
  },
};

const reviewTool: McpTool = {
  name: 'brain_planning_review',
  title: 'Planning: record an independent review',
  description:
    'Record a reviewer’s verdict (PASS, REVISE or UNAVAILABLE) on one revision, with reasons and findings. The reviewer is ' +
    'explicitly identified (reviewer_kind, reviewer_id, reviewer_model); the author reviewing itself is recorded and never certifies.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' }, revision_id: { type: 'string' },
      reviewer_kind: { type: 'string', enum: ['APP_SESSION', 'OPERATOR', 'MODEL', 'PERSON'] }, reviewer_id: { type: 'string' }, reviewer_model: { type: 'string' },
      verdict: { type: 'string', enum: ['PASS', 'REVISE', 'UNAVAILABLE'] }, reasons: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } }, resolution: { type: 'string' },
      conditions: {
        type: 'array',
        description:
          'REVISE only: each condition you propose, that a chain link of an opening is not established. basis EVIDENCE cites the card fact ' +
          '(field) that shows it; MISSING_PREREQUISITE names a field no EVIDENCE fact on the card carries. A condition without either is refused.',
        items: {
          type: 'object',
          properties: { opportunityId: { type: 'string' }, link: { type: 'string' }, basis: { type: 'string', enum: ['EVIDENCE', 'MISSING_PREREQUISITE'] }, field: { type: 'string' }, why: { type: 'string' }, defect: { type: 'string', enum: ['PERSON_WORD', 'CONTRADICTED', 'NOT_A_PURCHASE'], description: 'Against a price Brain\u2019s planner establishes: the defect the record shows. Required there.' }, nonPurchase: { type: 'string', enum: ['REWARD', 'BOUNTY', 'GRANT', 'PRIZE', 'REBATE', 'SETTLEMENT', 'WAGE', 'ANOTHER_BUYERS_CLAIM'], description: 'With NOT_A_PURCHASE: what payment the figure is instead. A directly comparable offer\u2019s current price is an evidenced price, not one of these.' } },
          required: ['opportunityId', 'link', 'basis', 'field', 'why'],
          additionalProperties: false,
        },
      },
    },
    required: ['goal_id', 'revision_id', 'reviewer_kind', 'reviewer_id', 'verdict'],
    additionalProperties: false,
  },
  annotations: { title: 'Planning: review', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    const { recordReview, leasedReviewFor } = await import('../services/planning/sessionPlanning.ts');
    // Operator authority on the project, or the queue's grant: a live lease on this exact revision's PLAN_REVIEW item,
    // held by a worker that is not its author. The lease authorizes this one review and nothing else.
    if (!decideProjectAccess(principal, projectId, 'WRITE', 'operator:act').allowed) {
      await authorize(principal, projectId, 'WRITE', 'queue:complete');
      if (!(await leasedReviewFor(principal.id, requiredString(args, 'revision_id')))) throw notFoundError();
    }
    return {
      projectId,
      value: await guarded(() => recordReview({
        goalId,
        revisionId: requiredString(args, 'revision_id'),
        // The reviewer is the authenticated caller: its id is bound to the principal that presented the credential,
        // so a review cannot be recorded in another executor's name, and the author's own credential and session is
        // recorded as self-review.
        reviewer: { kind: requiredString(args, 'reviewer_kind') as PlanExecutor['kind'], id: `${principal.id}/${requiredString(args, 'reviewer_id')}`, model: optionalString(args, 'reviewer_model') },
        verdict: requiredString(args, 'verdict') as 'PASS' | 'REVISE' | 'UNAVAILABLE',
        reasons: optionalString(args, 'reasons') ?? '',
        findings: Array.isArray(args['findings']) ? (args['findings'] as unknown[]).map(String) : [],
        conditions: Array.isArray(args['conditions']) ? (args['conditions'] as never[]) : [],
        resolution: optionalString(args, 'resolution'),
      })),
    };
  },
};

const finalizeTool: McpTool = {
  name: 'brain_planning_finalize',
  title: 'Planning: publish the plan',
  description: 'Publish the current revision as the goal’s one plan. Refused, with every blocker, unless it passes every check and an independent review of that exact digest passed.',
  inputSchema: { type: 'object', properties: { goal_id: { type: 'string' }, revision_id: { type: 'string' }, ...SESSION }, required: ['goal_id', 'revision_id', 'session_id'], additionalProperties: false },
  annotations: { title: 'Planning: finalize', ...MUTATING, idempotentHint: true },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'WRITE', 'operator:act');
    const { finalizePlan } = await import('../services/planning/sessionPlanning.ts');
    return { projectId, value: await guarded(() => finalizePlan({ goalId, revisionId: requiredString(args, 'revision_id'), actor: sessionExecutor(principal, args) })) };
  },
};

const stateTool: McpTool = {
  name: 'brain_planning_state',
  title: 'Planning: the saved planning state',
  description: 'Replay the goal’s saved planning record: contract, revisions, the current revision and its check, reviews, and the published plan — or, when the owner’s objective, the goal’s terms or a weighed opening’s record changed after publication, the stale one with `staleBecause` saying what changed, so the session plans the world as it now stands.',
  inputSchema: { type: 'object', properties: { goal_id: { type: 'string' } }, required: ['goal_id'], additionalProperties: false },
  annotations: { title: 'Planning: state', ...READ_ONLY },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const projectId = await goalProject(goalId);
    await authorize(principal, projectId, 'READ', 'project:read');
    const { planningState } = await import('../services/planning/sessionPlanning.ts');
    return { projectId, value: (await planningState(goalId)) as unknown as Record<string, unknown> };
  },
};

/*
 * What one call returns must fit what the Claude app reads in one tool result (about 25k tokens), not only Brain's own
 * 256 KB transport cap (production, 2026-11-28, Cash Mode 1: brain_planning_context returned 158,464 characters, which
 * the app saved to a file instead of reading, and brain_planning_state and brain_planning_submit_revision hit the
 * 256 KB cap). Every planning tool's value is fitted to that budget, each cut named in `compacted`; the records stay
 * whole in Brain, which the checks read.
 */
export const APP_RESULT_BUDGET_BYTES = 80 * 1024;
export const fitted = (tool: McpTool): McpTool => ({
  ...tool,
  run: async (args, ctx) => {
    const out = await tool.run(args, ctx);
    if (!out || typeof out !== 'object' || !('value' in out)) return out;
    const { fitContext } = await import('../services/planning/sessionPlanning.ts');
    const value = (out as { value: unknown }).value;
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...out, value: fitContext(value as Record<string, unknown>, APP_RESULT_BUDGET_BYTES) } : out;
  },
});
export const PLANNING_TOOLS: readonly McpTool[] = [contractTool, contextTool, routesTool, brainTool, researchTool, verifyResearchTool, revisionTool, reviewTool, finalizeTool, stateTool].map(fitted);
