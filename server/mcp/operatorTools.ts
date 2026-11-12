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
import { operatorSnapshot, urgencyOrder } from '../services/operator/snapshot.ts';
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
    return { projectId: null, value: { readAt: snapshot.takenAt, goals: urgencyOrder(snapshot.summaries) } };
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
    const goalId = optionalString(args, 'goal_id') ?? urgencyOrder(snapshot.summaries)[0]?.id ?? null;
    const goal = snapshot.goals.find((one) => one.id === goalId);
    if (!goal || !goal.projectId) {
      // A light reading (Brain was too busy to derive goals this run): the register and the requests.
      const summary = snapshot.summaries.find((one) => one.id === goalId);
      if (!summary || !summary.projectId) throw notFoundError();
      await authorize(principal, summary.projectId, 'READ', 'project:read');
      const lightRequests = snapshot.requests.get(summary.projectId) ?? [];
      return {
        projectId: summary.projectId,
        value: { depth: 'LIGHT', goal: summary, requests: lightRequests, mootRequests: lightRequests.filter((one) => one.moot).length },
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
        requests,
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
];
