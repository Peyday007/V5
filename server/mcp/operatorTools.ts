/**
 * The operator's tools (§106): Brain's general operator — Hermes Agent, on its
 * own private app — reads and directs Brain's goals through these, on the one
 * MCP surface every worker uses.
 *
 * Same rules as the rest of `tools.ts`: in the one registry, identical for
 * every caller, authorized at execution time by `services/identity/policy.ts`.
 * Reading needs `project:read` on each project, and only goals in projects the
 * credential is a member of are listed. Acting needs `operator:act`, which only
 * the per-run operator credential Brain mints holds (`OPERATOR_SCOPES`). Every
 * action then re-checks its own rule — a request is withdrawn only when it is
 * moot by the rows, a fix starts only under the owner's standing improvement
 * order — so the agent choosing wrongly is refused, not obeyed.
 */
import { decideProjectAccess, visibleProjectIds } from '../services/identity/policy.ts';
import { listProjects } from '../repos/projects.ts';
import { runningOperatorRun } from '../repos/operator.ts';
import {
  continueIdleCapacity,
  operatorHistory,
  operatorRecordLearning,
  readGoalPlanSummary,
  readIntegrations,
  readRequests,
  summarizeGoal,
  withdrawMootRequest,
} from '../services/operator/actions.ts';
import { submitOperatorFix } from '../services/operator/factory.ts';
import { briefOrder, operatorSnapshot } from '../services/operator/snapshot.ts';
import { invalidInput, notFoundError } from './errors.ts';
import { MUTATING, READ_ONLY, authorize, optionalString, requiredString, type McpTool } from './toolkit.ts';
import type { Principal } from '../domain/types.ts';

async function readableProjects(principal: Principal): Promise<string[]> {
  const all = (await listProjects()).map((project) => project.id);
  return visibleProjectIds(principal, all).filter((id) => decideProjectAccess(principal, id, 'READ').allowed);
}

/** Projects where this credential may act as the operator. Empty for every other caller. */
function operatorProjects(principal: Principal): string[] {
  return principal.memberships
    .filter((m) => m.active && decideProjectAccess(principal, m.projectId, 'WRITE', 'operator:act').allowed)
    .map((m) => m.projectId);
}

function requireOperator(principal: Principal): string[] {
  const projects = operatorProjects(principal);
  if (projects.length === 0) throw notFoundError();
  return projects;
}

async function currentRunId(): Promise<string | null> {
  return (await runningOperatorRun())?.id ?? null;
}

function stringArray(args: Record<string, unknown>, field: string): string[] {
  const value = args[field];
  if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) {
    throw invalidInput(`${field} must be an array of strings.`);
  }
  return value as string[];
}

const goalsTool: McpTool = {
  name: 'brain_operator_goals',
  title: 'Operator: goals',
  description:
    'Every live goal in the projects you direct: its desired result, derived state and the reading that decided it, ' +
    'target progress from the ledger, what it is waiting on, the next action Brain recommends, and counts of open ' +
    'decisions and blockers. Start here every run.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: goals', ...READ_ONLY },
  run: async (_args, { principal }) => {
    const projects = await readableProjects(principal);
    if (projects.length === 0) return { projectId: null, value: { goals: [] } };
    const snapshot = await operatorSnapshot(projects);
    // Bounded: a small model's window is the limit (opr_1184fee7), and the most relevant come first.
    const ordered = briefOrder(snapshot);
    return { projectId: null, value: { readAt: snapshot.takenAt, total: ordered.length, goals: ordered.slice(0, 15) } };
  },
};

const goalTool: McpTool = {
  name: 'brain_operator_goal',
  title: 'Operator: one goal',
  description:
    'Inspect one goal: its blockers with remedies, its open person-requests (each with its mission and packet state ' +
    'and whether it is moot — nobody can act on it any more), its linked work and evidence, and its next action. ' +
    'Without goal_id, the most urgent goal.',
  inputSchema: {
    type: 'object',
    properties: { goal_id: { type: 'string', description: 'The goal id (wst_…) from the brief or brain_operator_goals; omit for the most urgent.' } },
    additionalProperties: false,
  },
  annotations: { title: 'Operator: one goal', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projects = await readableProjects(principal);
    if (projects.length === 0) throw notFoundError();
    const snapshot = await operatorSnapshot(projects);
    const goalId = optionalString(args, 'goal_id') ?? briefOrder(snapshot)[0]?.id ?? null;
    const goal = snapshot.goals.find((one) => one.id === goalId);
    if (!goal || !goal.projectId) {
      // A light reading (Brain was too busy to derive goals this run): the register and the requests.
      const summary = snapshot.summaries.find((one) => one.id === goalId);
      if (!summary || !summary.projectId) throw notFoundError();
      await authorize(principal, summary.projectId, 'READ', 'project:read');
      const lightRequests = snapshot.requests.get(summary.projectId) ?? [];
      return {
        projectId: summary.projectId,
        value: { depth: 'LIGHT', goal: summary, requests: lightRequests.slice(0, 15), openRequests: lightRequests.length, mootRequests: lightRequests.filter((one) => one.moot).length },
      };
    }
    await authorize(principal, goal.projectId, 'READ', 'project:read');
    const requests = snapshot.requests.get(goal.projectId) ?? (await readRequests(goal.projectId));
    return {
      projectId: goal.projectId,
      value: {
        goal: summarizeGoal(goal),
        intent: goal.intent.slice(0, 600),
        outcome: goal.outcome,
        authority: goal.authority,
        requests: requests.slice(0, 15),
        openRequests: requests.length,
        mootRequests: requests.filter((one) => one.moot).length,
        blockers: goal.blockers.slice(0, 15).map((b) => ({ text: b.text.slice(0, 400), remedy: b.remedy.slice(0, 200), by: b.by, ref: b.ref, ageHours: b.ageHours })),
        blockersNotShown: Math.max(0, goal.blockers.length - 15),
        work: goal.work.slice(0, 15),
        evidence: goal.evidence.slice(0, 10),
        obligations: goal.obligations,
      },
    };
  },
};

const planTool: McpTool = {
  name: 'brain_operator_goal_plan',
  title: 'Operator: the goal plan',
  description:
    "A goal's quantitative plan as Brain's planner last read it: verdict, the chosen strategy, each strategy's " +
    'simulated reach, conservative settled cash and failed constraints, and the next test that would change it. ' +
    'Use it to decide which strategy to push and what research or work would move the number.',
  inputSchema: {
    type: 'object',
    properties: { goal_id: { type: 'string' } },
    required: ['goal_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: the goal plan', ...READ_ONLY },
  run: async (args, { principal }) => {
    const goalId = requiredString(args, 'goal_id');
    const goal = (await operatorSnapshot(await readableProjects(principal))).summaries.find((one) => one.id === goalId);
    if (!goal || !goal.projectId) throw notFoundError();
    await authorize(principal, goal.projectId, 'READ', 'project:read');
    return { projectId: goal.projectId, value: await readGoalPlanSummary(goalId) };
  },
};

const integrationsTool: McpTool = {
  name: 'brain_operator_integrations',
  title: 'Operator: integrations',
  description:
    'Every external service Brain is connected to (outreach, discovery, models, agents, Factory, payments), what each ' +
    'lets Brain do, and its latest health reading. Credentials are never shown; Brain supplies them itself.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: integrations', ...READ_ONLY },
  run: async (_args, { principal }) => {
    requireOperator(principal);
    return { projectId: null, value: { integrations: await readIntegrations() } };
  },
};

const capacityTool: McpTool = {
  name: 'brain_operator_capacity',
  title: 'Operator: capacity',
  description:
    "Brain's four pools of capacity (Claude routines, the free model lane and GPU, research slots, the Factory line): " +
    'what waits, what runs, the capacity, and whether a pool is idle beside waiting work.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: capacity', ...READ_ONLY },
  run: async (_args, { principal }) => {
    requireOperator(principal);
    const { brainUtilization } = await import('../services/engineering/watchdog.ts');
    const pools = await brainUtilization();
    return { projectId: null, value: { pools } };
  },
};

const historyTool: McpTool = {
  name: 'brain_operator_history',
  title: 'Operator: history',
  description:
    'Your own record: your recent runs and their reports, the actions you took, and the lessons you recorded ' +
    '(optionally for one goal). Read it before acting so a failed strategy is not repeated.',
  inputSchema: {
    type: 'object',
    properties: { goal_id: { type: 'string', description: 'Only lessons about this goal.' } },
    additionalProperties: false,
  },
  annotations: { title: 'Operator: history', ...READ_ONLY },
  run: async (args, { principal }) => {
    requireOperator(principal);
    return { projectId: null, value: await operatorHistory(optionalString(args, 'goal_id')) };
  },
};

const withdrawTool: McpTool = {
  name: 'brain_operator_withdraw_moot_request',
  title: 'Operator: withdraw a moot request',
  description:
    'Withdraw an open person-request whose mission no longer waits on it (moot=true in brain_operator_goal). Such a ' +
    'card holds its goal blocked on a decision nobody can make. Refused unless the rows show it is moot; the row is ' +
    'kept as WITHDRAWN with the reason.',
  inputSchema: {
    type: 'object',
    properties: { request_id: { type: 'string', description: 'The request id (rhr_…).' } },
    required: ['request_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: withdraw a moot request', ...MUTATING },
  run: async (args, { principal }) => {
    const projects = requireOperator(principal);
    const result = await withdrawMootRequest({ requestId: requiredString(args, 'request_id'), runId: await currentRunId(), projectIds: projects });
    return { projectId: null, value: result };
  },
};

const continueTool: McpTool = {
  name: 'brain_operator_continue_idle',
  title: 'Operator: continue idle capacity',
  description:
    'Continue every pool that is idle beside waiting work, each through its own scheduler (dispatch, the free lane ' +
    'controller), and report what moved.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: continue idle capacity', ...MUTATING },
  run: async (_args, { principal }) => {
    requireOperator(principal);
    return { projectId: null, value: await continueIdleCapacity(await currentRunId()) };
  },
};

function optionalStringArray(args: Record<string, unknown>, field: string): string[] {
  return args[field] === undefined ? [] : stringArray(args, field);
}

function optionalNumber(args: Record<string, unknown>, field: string): number | null {
  const value = args[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidInput(`${field} must be a number.`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, field: string): boolean {
  const value = args[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw invalidInput(`${field} must be true or false.`);
  return value;
}

const deficienciesTool: McpTool = {
  name: 'brain_operator_deficiencies',
  title: 'Operator: deficiencies',
  description:
    "What Brain's rows already show is weak in Brain itself — reasoning, planning, strategy, resource allocation, " +
    'capabilities, integrations, algorithms, recurring failures — each as a ready-made diagnosis with an id (dfx_…), ' +
    'the intervention Brain\'s rules give it (ENGINEERING, MODEL, STRATEGY, EVIDENCE, CAPACITY, PERSON, WATCH) and why. ' +
    'Pass an id to brain_operator_commission to act on it as it stands.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: deficiencies', ...READ_ONLY },
  run: async (_args, { principal }) => {
    requireOperator(principal);
    const { readDeficiencies, readingId } = await import('../services/operator/director.ts');
    const found = await readDeficiencies();
    return { projectId: null, value: { deficiencies: found.map((one) => ({ id: readingId(one), intervention: one.intervention, why: one.why, ...one.diagnosis })) } };
  },
};

const commissionTool: McpTool = {
  name: 'brain_operator_commission',
  title: 'Operator: commission an intervention',
  description:
    'Act on a deficiency in Brain. Either pass deficiency_id (dfx_… from brain_operator_deficiencies) alone, or describe ' +
    "your own diagnosis. Brain decides the intervention from what you state — engineering only when the cause is " +
    'established, owner files are named and it recurred; otherwise a model, strategy, evidence, capacity, person or ' +
    'watch — and acknowledges at once. Engineering goes to Factory now: an objective with the goal, evidence, expected ' +
    'benefit, acceptance, priority and evaluation, a campaign, a priority set from what the defect holds back, and a ' +
    'worker class set from its complexity. The same defect again reaches the same campaign.',
  inputSchema: {
    type: 'object',
    properties: {
      deficiency_id: { type: 'string', description: 'A dfx_… id from brain_operator_deficiencies; the rest may then be omitted.' },
      goal_id: { type: 'string', description: 'The goal it holds back (wst_…).' },
      deficiency: { type: 'string', enum: ['ECONOMIC_REASONING', 'PLANNING_ASSUMPTION', 'REPEATED_STRATEGIC_MISTAKE', 'RESOURCE_ALLOCATION', 'MISSING_CAPABILITY', 'BROKEN_INTEGRATION', 'INEFFICIENT_ALGORITHM', 'RECURRING_OPERATIONAL_FAILURE'] },
      title: { type: 'string' },
      observed: { type: 'string', description: 'What is wrong and what it costs the goal, in production terms.' },
      evidence: { type: 'string', description: 'Row ids and verbatim reasons from Brain.' },
      cause: { type: 'string', description: 'The cause, when the rows or the code state it. Omit when it is not established.' },
      owner_paths: { type: 'array', items: { type: 'string' }, description: 'Repository paths that own the behaviour.' },
      recurrence: { type: 'number', description: 'How many times it was observed.' },
      expected_benefit: { type: 'string' },
      acceptance: { type: 'string', description: 'What a test proves once it is fixed.' },
      metric: { type: 'string', description: "The scoreboard metric its real effect is measured on (Brain chooses one when omitted)." },
      blocks_goal: { type: 'boolean' },
      share: { type: 'number', description: "Share 0..1 of the goal's remaining value it holds back." },
      intervention: { type: 'string', enum: ['ENGINEERING', 'MODEL', 'STRATEGY', 'EVIDENCE', 'CAPACITY', 'PERSON', 'WATCH'], description: 'What you propose; Brain\'s rules decide.' },
      model_limited: { type: 'boolean' },
      person_only: { type: 'boolean' },
      capacity_idle: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Operator: commission an intervention', ...MUTATING },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const director = await import('../services/operator/director.ts');
    const runId = await currentRunId();
    const id = optionalString(args, 'deficiency_id');
    if (id) {
      const found = (await director.readDeficiencies()).find((one) => director.readingId(one) === id);
      if (!found) return { projectId: null, value: { ok: false, reason: `no current deficiency ${id}: read brain_operator_deficiencies again (it may already be fixed)` } };
      return { projectId: null, value: { ...(await director.commission({ ...found.diagnosis, runId })) } };
    }
    const result = await director.commission({
      goalId: optionalString(args, 'goal_id'),
      deficiency: requiredString(args, 'deficiency'),
      title: requiredString(args, 'title'),
      observed: requiredString(args, 'observed'),
      evidence: requiredString(args, 'evidence'),
      cause: optionalString(args, 'cause'),
      ownerPaths: optionalStringArray(args, 'owner_paths'),
      recurrence: optionalNumber(args, 'recurrence') ?? 1,
      expectedBenefit: requiredString(args, 'expected_benefit'),
      acceptance: requiredString(args, 'acceptance'),
      metric: optionalString(args, 'metric'),
      blocksGoal: optionalBoolean(args, 'blocks_goal'),
      share: optionalNumber(args, 'share'),
      proposed: optionalString(args, 'intervention'),
      modelLimited: optionalBoolean(args, 'model_limited'),
      personOnly: optionalBoolean(args, 'person_only'),
      capacityIdle: optionalBoolean(args, 'capacity_idle'),
      runId,
    });
    return { projectId: null, value: { ...result } };
  },
};

const engineeringTool: McpTool = {
  name: 'brain_operator_engineering',
  title: 'Operator: engineering results',
  description:
    'Every intervention you commissioned and what became of it: Factory status, the pull request, the code it changed, ' +
    "whether tests and review passed, merge, deploy and live verification, the improvement loop's measurement and " +
    'decision, and the goal read again against the reading taken when you commissioned it. A merged pull request is ' +
    'never counted as the improvement. next says what to do: WAIT, UNBLOCK, NEW_ATTEMPT, CHANGE_STRATEGY or DONE.',
  inputSchema: {
    type: 'object',
    properties: { include_closed: { type: 'boolean', description: 'Also the decided ones (default true).' } },
    additionalProperties: false,
  },
  annotations: { title: 'Operator: engineering results', ...READ_ONLY },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const { engineeringOutcomes } = await import('../services/operator/director.ts');
    const includeClosed = args['include_closed'] === undefined ? true : optionalBoolean(args, 'include_closed');
    return { projectId: null, value: { engineering: (await engineeringOutcomes({ includeClosed, limit: 10 })).map((one) => ({ ...one })) } };
  },
};

const prioritizeTool: McpTool = {
  name: 'brain_operator_prioritize_engineering',
  title: 'Operator: re-prioritize engineering',
  description:
    'Change the priority (1..9) of engineering you commissioned, with the reason. Its waiting Factory work is reordered ' +
    'at once; work already in progress keeps its place, because interrupting it would waste more than it saves.',
  inputSchema: {
    type: 'object',
    properties: {
      candidate_id: { type: 'string', description: 'The candidateId from brain_operator_engineering (imp_…).' },
      priority: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['candidate_id', 'priority', 'reason'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: re-prioritize engineering', ...MUTATING },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const { reprioritize } = await import('../services/operator/director.ts');
    const priority = optionalNumber(args, 'priority');
    if (priority === null) throw invalidInput('priority is required.');
    return {
      projectId: null,
      value: await reprioritize({ candidateId: requiredString(args, 'candidate_id'), priority, reason: requiredString(args, 'reason'), runId: await currentRunId() }),
    };
  },
};

const fixTool: McpTool = {
  name: 'brain_operator_submit_fix',
  title: 'Operator: send a defect to Factory',
  description:
    "Send a recurring software defect to Factory, under the owner's standing improvement order: Factory plans, builds, " +
    'tests and reviews it, and releases LOW-risk changes itself. Give the evidence (row ids, verbatim reasons), the ' +
    'files that own the behaviour, and what a test proves once fixed. Naming the same defect again reaches the same ' +
    'campaign. Refused when the order is off or the description is too thin to build from.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      problem: { type: 'string', description: 'What is wrong and what it costs, in production terms.' },
      evidence: { type: 'string', description: 'Row ids and verbatim reasons from Brain that show it.' },
      owner_paths: { type: 'array', items: { type: 'string' }, description: 'Repository paths that own the behaviour, e.g. server/services/russell/needsHuman.ts' },
      acceptance: { type: 'string', description: 'What a test proves once it is fixed.' },
      goal_id: { type: 'string', description: 'The goal the defect holds back, so its effect on the goal is measured.' },
    },
    required: ['title', 'problem', 'evidence', 'owner_paths', 'acceptance'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: send a defect to Factory', ...MUTATING },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const result = await submitOperatorFix({
      title: requiredString(args, 'title'),
      problem: requiredString(args, 'problem'),
      evidence: requiredString(args, 'evidence'),
      ownerPaths: stringArray(args, 'owner_paths'),
      acceptance: requiredString(args, 'acceptance'),
      runId: await currentRunId(),
      goalId: optionalString(args, 'goal_id'),
    });
    return { projectId: null, value: result };
  },
};

const learnTool: McpTool = {
  name: 'brain_operator_record_learning',
  title: 'Operator: record a lesson',
  description:
    'Record a lesson about a goal or about Brain, with the evidence it rests on, so it is not rediscovered. ' +
    'Append-only: it is shown on every later run in brain_operator_history.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' },
      lesson: { type: 'string' },
      evidence: { type: 'string' },
    },
    required: ['lesson', 'evidence'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: record a lesson', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const lesson = requiredString(args, 'lesson');
    const evidence = requiredString(args, 'evidence');
    const result = await operatorRecordLearning({ goalId: optionalString(args, 'goal_id'), runId: await currentRunId(), lesson, evidence });
    return { projectId: null, value: result };
  },
};

// ---------------------------------------------------------------------------
// Deciding, verifying and moving capacity (§108)
// ---------------------------------------------------------------------------

function numberArg(args: Record<string, unknown>, field: string, fallback: number | null = null): number | null {
  const v = args[field];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw invalidInput(`${field} must be a number.`);
  return n;
}

const allocationTool: McpTool = {
  name: 'brain_operator_allocation',
  title: 'Operator: where capacity is worth most',
  description:
    'Every goal as an activity competing for capacity, ranked by the marginal value of the next unit of capacity: ' +
    'stake, reach of its plan, evidence level, days left, what its recent research consumed and bought, and the value ' +
    'of the information an answer would give. Each comes with a stance (EXPAND, HOLD, REDUCE, PAUSE, RESTART) and why. ' +
    'Use it before moving capacity; act through brain_operator_decide and brain_operator_set_goal_focus.',
  inputSchema: { type: 'object', properties: { window_hours: { type: 'number', description: 'The window recent use is read over (default 24).' } }, additionalProperties: false },
  annotations: { title: 'Operator: where capacity is worth most', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projects = await readableProjects(principal);
    const { readAllocation } = await import('../services/operator/allocation.ts');
    const reading = await readAllocation(projects, Math.min(168, Math.max(1, numberArg(args, 'window_hours', 24) ?? 24)));
    return { projectId: null, value: { readAt: reading.readAt, windowHours: reading.windowHours, allocations: reading.allocations.slice(0, 15) } };
  },
};

const decideTool: McpTool = {
  name: 'brain_operator_decide',
  title: 'Operator: commit a decision',
  description:
    'Before an action that matters, commit the decision: the question, at least two meaningfully different options ' +
    '(any variable may change — price, segment, channel, structure, financing, timing, allocation — or doing nothing), ' +
    "each with probability, value and cost in dollars (null when unknown) and its evidence; the chosen option; the " +
    'assumptions it rests on; and a prediction (observable outcome, probability, horizon in days). Brain checks it, ' +
    'has a second model challenge a high-impact one, and records the prediction on the ledger so it is judged later. ' +
    'Returns REVISE with the challenge when a flaw could change the choice; call again with answered_challenge to stand by it.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['PAUSE_GOAL', 'RESUME_GOAL', 'SUBMIT_FIX', 'WITHDRAW_REQUEST', 'CONTINUE_IDLE', 'REALLOCATE', 'CHANGE_STRATEGY', 'RESEARCH', 'SWITCH_MODEL', 'STOP_APPROACH', 'OTHER'] },
      goal_id: { type: 'string' },
      question: { type: 'string' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            probability: { type: 'number' },
            value_usd: { type: ['number', 'null'] },
            cost_usd: { type: ['number', 'null'] },
            evidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['action', 'probability'],
        },
      },
      chosen: { type: 'integer', description: 'Index of the chosen option.' },
      assumptions: { type: 'array', items: { type: 'string' } },
      why_not_highest_ev: { type: 'string' },
      prediction_outcome: { type: 'string', description: 'What will be observably true if the choice works.' },
      prediction_probability: { type: 'number' },
      horizon_days: { type: 'number' },
      irreversible: { type: 'boolean' },
      answered_challenge: { type: 'string' },
    },
    required: ['kind', 'question', 'options', 'chosen', 'assumptions', 'prediction_outcome', 'prediction_probability', 'horizon_days'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: commit a decision', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const projects = requireOperator(principal);
    const rawOptions = Array.isArray(args['options']) ? (args['options'] as Record<string, unknown>[]) : [];
    const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const nullableNumber = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const { decide } = await import('../services/operator/decisions.ts');
    const { modelsFor } = await import('../services/operator/run.ts');
    const models = await modelsFor();
    const result = await decide(
      {
        kind: requiredString(args, 'kind') as never,
        goalId: optionalString(args, 'goal_id'),
        question: requiredString(args, 'question'),
        options: rawOptions.map((o) => ({
          action: String(o['action'] ?? ''),
          probability: Number(o['probability']),
          valueUsd: nullableNumber(o['value_usd']),
          costUsd: nullableNumber(o['cost_usd']),
          evidence: strings(o['evidence']),
        })),
        chosen: Math.trunc(numberArg(args, 'chosen', -1) ?? -1),
        assumptions: strings(args['assumptions']),
        whyNotHighestEv: optionalString(args, 'why_not_highest_ev'),
        prediction: {
          outcome: requiredString(args, 'prediction_outcome'),
          probability: numberArg(args, 'prediction_probability', -1) ?? -1,
          horizonDays: numberArg(args, 'horizon_days', 0) ?? 0,
        },
        irreversible: args['irreversible'] === true,
        answeredChallenge: optionalString(args, 'answered_challenge'),
      },
      // The challenger is a different model from the one deciding when Brain has two.
      { runId: await currentRunId(), projectIds: projects, models: models.length > 1 ? [...models.slice(1), models[0]!] : models },
    );
    return { projectId: null, value: { ...result } };
  },
};

const verifyTool: McpTool = {
  name: 'brain_operator_verify',
  title: 'Operator: judge a past decision',
  description:
    'Record what a committed decision actually came to, once, with the evidence it was observed in, and the signals ' +
    'that explain a miss (an assumption broke, execution deviated, a mechanism was missing, capacity fell short, it ' +
    'arrived late). Returns your record on decisions of this kind: forecasts against outcomes, and the miss causes. ' +
    'Without decision_id, lists the decisions still owed a verification.',
  inputSchema: {
    type: 'object',
    properties: {
      decision_id: { type: 'string' },
      occurred: { type: 'boolean' },
      evidence: { type: 'string' },
      assumption_broke: { type: 'boolean' },
      execution_deviated: { type: 'boolean' },
      mechanism_missing: { type: 'boolean' },
      capacity_shortfall: { type: 'boolean' },
      arrived_late: { type: 'boolean' },
      broken_assumption: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Operator: judge a past decision', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const projects = requireOperator(principal);
    const { openDecisions, verify } = await import('../services/operator/decisions.ts');
    const id = optionalString(args, 'decision_id');
    if (!id) return { projectId: null, value: { open: await openDecisions(20) } };
    if (typeof args['occurred'] !== 'boolean') throw invalidInput('occurred must be true or false.');
    const flag = (k: string) => (args[k] === true ? true : undefined);
    const signals = Object.fromEntries(
      Object.entries({ assumptionBroke: flag('assumption_broke'), executionDeviated: flag('execution_deviated'), mechanismMissing: flag('mechanism_missing'), capacityShortfall: flag('capacity_shortfall'), arrivedLate: flag('arrived_late') }).filter(([, v]) => v !== undefined),
    );
    const result = await verify(
      { decisionId: id, occurred: args['occurred'] as boolean, evidence: requiredString(args, 'evidence'), signals, brokenAssumption: optionalString(args, 'broken_assumption') },
      { runId: await currentRunId(), projectIds: projects },
    );
    return { projectId: null, value: result };
  },
};

const focusTool: McpTool = {
  name: 'brain_operator_set_goal_focus',
  title: 'Operator: pause or resume a goal',
  description:
    "Move capacity between goals: PAUSE holds every bin a low-value goal pursues (nothing is cancelled; resuming " +
    'continues it), RESUME releases a paused one whose reading improved. Needs a committed PAUSE_GOAL or RESUME_GOAL ' +
    'decision for the same goal. A goal owed to a customer or committed to somebody is never paused by the operator.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' },
      action: { type: 'string', enum: ['PAUSE', 'RESUME'] },
      decision_id: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['goal_id', 'action', 'decision_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: pause or resume a goal', ...MUTATING },
  run: async (args, { principal }) => {
    const projects = requireOperator(principal);
    const action = requiredString(args, 'action').toUpperCase();
    if (action !== 'PAUSE' && action !== 'RESUME') throw invalidInput('action must be PAUSE or RESUME.');
    const { setGoalFocus } = await import('../services/operator/decisions.ts');
    const result = await setGoalFocus(
      { goalId: requiredString(args, 'goal_id'), action, decisionId: requiredString(args, 'decision_id'), reason: requiredString(args, 'reason') },
      { runId: await currentRunId(), projectIds: projects },
    );
    return { projectId: null, value: result };
  },
};

export const OPERATOR_TOOLS: readonly McpTool[] = [
  goalsTool,
  goalTool,
  planTool,
  capacityTool,
  integrationsTool,
  historyTool,
  withdrawTool,
  continueTool,
  fixTool,
  learnTool,
  allocationTool,
  decideTool,
  verifyTool,
  focusTool,
  deficienciesTool,
  commissionTool,
  engineeringTool,
  prioritizeTool,
];
