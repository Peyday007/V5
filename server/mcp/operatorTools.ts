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
import { APPROACH_TYPES, type Approach, type ApproachType } from '../domain/evolution.ts';

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

/**
 * Reading Brain-wide state that carries no project's content (capacity pools,
 * integration health) needs `project:read` on at least one project, exactly as
 * reading goals does — not `operator:act`, which is for changing things. The
 * operator's own record, deficiencies and engineering results carry goals,
 * lessons and event payloads from every project, so they stay behind
 * `operator:act` (invariants 17, 28, 41; planning recovery review F1). A caller with no readable project is refused with the
 * same not-found every other refusal on this door gives (invariants 23, 30).
 */
async function requireReader(principal: Principal): Promise<string[]> {
  const projects = await readableProjects(principal);
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
    await requireReader(principal);
    return { projectId: null, value: { integrations: await readIntegrations() } };
  },
};

const capacityTool: McpTool = {
  name: 'brain_operator_capacity',
  title: 'Operator: capacity',
  description:
    "Brain's four pools of capacity (Claude routines, the free model lane and GPU, research slots, the Factory line): " +
    'what waits, what runs, the capacity, and whether a pool is idle beside waiting work; and the GPU (gpu): pod status, ' +
    'card, $/h, spend, balance, jobs and every active restriction. Answers within seconds: when a ' +
    'live read takes longer, the last complete reading is served with its age (source CACHED, ageSeconds) while the live ' +
    'read finishes for the next call.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: capacity', ...READ_ONLY },
  run: async (_args, { principal }) => {
    await requireReader(principal);
    const { utilizationWithin } = await import('../services/engineering/watchdog.ts');
    const reading = await utilizationWithin();
    // The GPU's operating status (§121): what the Command Center's GPU panel shows. Rows only, cached.
    const { readGpuStatus } = await import('../services/cheap/gpuStatus.ts');
    const gpu = await readGpuStatus().catch(() => null);
    return { projectId: null, value: { ...reading, gpu } };
  },
};

const knowledgeTool: McpTool = {
  name: 'brain_operator_knowledge',
  title: 'Operator: commercial knowledge',
  description:
    'What Brain learned from public commercial datasets (Census business counts, payroll and receipts by industry, nonemployer ' +
    'statistics): the sources it reads and their freshness, which industries it measured and interpreted, the monetization ' +
    'mechanisms mapped, recent derived figures, what is still missing, where the knowledge reached your goals\' plans ' +
    '(buyer counts filed, assumptions replaced, questions answered) and whether the GPU and the pass are kept busy (§122).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Operator: commercial knowledge', ...READ_ONLY },
  run: async (_args, { principal }) => {
    const projects = await requireReader(principal);
    const { knowledgeView } = await import('../services/knowledge/view.ts');
    return { projectId: null, value: await knowledgeView(projects) };
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
    const projects = requireOperator(principal);
    const goalId = optionalString(args, 'goal_id');
    if (goalId) {
      // Lessons about one goal are that goal's project's to read; absent and forbidden refuse alike.
      const { getWorkstream } = await import('../repos/register.ts');
      const goal = await getWorkstream(goalId);
      if (!goal || !goal.projectId || !projects.includes(goal.projectId)) throw notFoundError();
    }
    return { projectId: null, value: await operatorHistory(goalId) };
  },
};


/**
 * Acting is gated on a committed decision (§108): the operator states the alternatives and a
 * checkable prediction before it changes anything, so every effect can be judged later. A
 * refusal names the way past it rather than failing the run.
 */
async function decisionGate(args: Record<string, unknown>): Promise<{ ok: true; decisionId: string } | { ok: false; refused: true; reason: string }> {
  const id = optionalString(args, 'decision_id');
  if (!id) return { ok: false, refused: true, reason: 'Decide first: call brain_operator_decide (two or more options, assumptions, a prediction), then pass its decision_id here. One decision may cover a batch of the same action.' };
  const { readDecision } = await import('../services/operator/decisions.ts');
  if (!(await readDecision(id))) return { ok: false, refused: true, reason: `no committed decision ${id}: brain_operator_decide returns decisionId only when it commits (answer a REVISE challenge first).` };
  return { ok: true, decisionId: id };
}

/** What every action result tells the operator to do next: observe, then keep the lesson. */
const AFTER_ACTING = 'Observe: read brain_operator_goal {goal_id} (or brain_operator_capacity) again to see what actually changed, then brain_operator_record_learning with the result — and brain_operator_verify the decision when its horizon passes.';

const DECISION_ID_PROPERTY = { type: 'string', description: 'The decisionId brain_operator_decide returned for this action (required: decide before acting).' } as const;

const withdrawTool: McpTool = {
  name: 'brain_operator_withdraw_moot_request',
  title: 'Operator: withdraw a moot request',
  description:
    'Withdraw an open person-request whose mission no longer waits on it (moot=true in brain_operator_goal). Such a ' +
    'card holds its goal blocked on a decision nobody can make. Refused unless the rows show it is moot; the row is ' +
    'kept as WITHDRAWN with the reason.',
  inputSchema: {
    type: 'object',
    properties: { request_id: { type: 'string', description: 'The request id (rhr_…).' }, decision_id: DECISION_ID_PROPERTY },
    required: ['request_id', 'decision_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: withdraw a moot request', ...MUTATING },
  run: async (args, { principal }) => {
    const projects = requireOperator(principal);
    const gate = await decisionGate(args);
    if (!gate.ok) return { projectId: null, value: gate };
    const result = await withdrawMootRequest({ requestId: requiredString(args, 'request_id'), runId: await currentRunId(), projectIds: projects });
    return { projectId: null, value: { ...result, decisionId: gate.decisionId, next: AFTER_ACTING } };
  },
};

const continueTool: McpTool = {
  name: 'brain_operator_continue_idle',
  title: 'Operator: continue idle capacity',
  description:
    'Continue every pool that is idle beside waiting work, each through its own scheduler (dispatch, the free lane ' +
    'controller). The pass is started in the background and this returns within seconds: finished=true with what was ' +
    'continued, or finished=false and running=true with the last pool reading — nothing is claimed as moved until the ' +
    'pass reports it (call again later for how it ended).',
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
    'worker class set from its complexity. The same defect again reaches the same campaign. ' +
    'Standalone research: pass research_question (intervention EVIDENCE, or omitted) with goal_id to ask that goal\'s ' +
    'own search the question — allowed on a paused goal, research only, never outreach or spend — or without goal_id ' +
    'for a method question about Brain, which opens method research. A paused goal refuses CAPACITY.',
  inputSchema: {
    type: 'object',
    properties: {
      deficiency_id: { type: 'string', description: 'A dfx_… id from brain_operator_deficiencies (dfx_inv_<id> for an inventory finding); the rest may then be omitted.' },
      research_question: { type: 'string', description: 'Standalone research (intervention EVIDENCE): what to learn. With goal_id the goal\'s search is asked it (a paused goal too: research only); without, a method question about Brain. The diagnosis fields may then be omitted.' },
      decision_id: DECISION_ID_PROPERTY,
      goal_id: { type: 'string', description: 'The goal it holds back (wst_…).' },
      deficiency: { type: 'string', enum: ['ECONOMIC_REASONING', 'PLANNING_ASSUMPTION', 'REPEATED_STRATEGIC_MISTAKE', 'RESOURCE_ALLOCATION', 'MISSING_CAPABILITY', 'BROKEN_INTEGRATION', 'INEFFICIENT_ALGORITHM', 'RECURRING_OPERATIONAL_FAILURE', 'CAPABILITY_BELOW_TARGET'] },
      approaches: {
        type: 'array',
        description:
          'Two or more materially different ways to fix it (different approach types or mechanisms, not one idea twice). With a ' +
          'registered suite, ENGINEERING opens an experiment: each approach is built to its own pull request, an evaluator scores ' +
          'them against production, and only the winner is released.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A short name, unique in this experiment.' },
            approach_type: { type: 'string', enum: [...APPROACH_TYPES] },
            approach: { type: 'string', description: 'The mechanism: what this variant changes and why it should work (40+ characters).' },
            owner_paths: { type: 'array', items: { type: 'string' }, description: 'Files this approach changes (its mutation scope).' },
          },
          required: ['label', 'approach_type', 'approach'],
          additionalProperties: false,
        },
      },
      suite: { type: 'string', description: "The registered benchmark suite that judges the approaches; it must measure this deficiency's class on its owner paths (brain_operator_experiments lists each suite's `measures`; a misfit is refused naming the suites that fit). A capability deficiency names its own. Commissioning a running experiment's deficiency again with another fitting suite moves that experiment onto it." },
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
    const projects = requireOperator(principal);
    const gate = await decisionGate(args);
    if (!gate.ok) return { projectId: null, value: gate };
    const director = await import('../services/operator/director.ts');
    const runId = await currentRunId();
    const approaches = approachesArg(args);
    const suite = optionalString(args, 'suite');
    const id = optionalString(args, 'deficiency_id');
    if (id) {
      const found = (await director.readDeficiencies()).find((one) => director.readingId(one) === id);
      if (!found) return { projectId: null, value: { ok: false, reason: `no current deficiency ${id}: read brain_operator_deficiencies again (it may already be fixed)` } };
      return { projectId: null, value: { ...(await director.commissionReading(found, runId, { approaches, suite })), decisionId: gate.decisionId, next: AFTER_ACTING } };
    }
    const question = optionalString(args, 'research_question');
    if (question !== null) {
      const proposed = optionalString(args, 'intervention');
      if (proposed !== null && proposed !== 'EVIDENCE') {
        return { projectId: null, value: { ok: false, reason: `research_question is research (intervention EVIDENCE) only, not ${proposed}` } };
      }
      const goalId = optionalString(args, 'goal_id');
      if (goalId) {
        // The goal must be in a project this credential directs; absent and forbidden refuse alike.
        const { getWorkstream } = await import('../repos/register.ts');
        const goal = await getWorkstream(goalId);
        if (!goal || !goal.projectId || !projects.includes(goal.projectId)) throw notFoundError();
      }
      const result = await director.commissionResearch({ goalId, question, evidence: optionalString(args, 'evidence'), runId });
      return { projectId: null, value: { ...result, decisionId: gate.decisionId, next: AFTER_ACTING } };
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
      approaches,
      suite,
    });
    return { projectId: null, value: { ...result, decisionId: gate.decisionId, next: AFTER_ACTING } };
  },
};

/** The `approaches` argument in Brain's shape; refused whole when one entry is malformed. */
function approachesArg(args: Record<string, unknown>): Approach[] | null {
  const value = args['approaches'];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw invalidInput('approaches must be an array.');
  return value.map((raw, i) => {
    const one = (raw ?? {}) as Record<string, unknown>;
    const label = one['label'];
    const type = one['approach_type'];
    const text = one['approach'];
    const paths = one['owner_paths'] ?? [];
    if (typeof label !== 'string' || typeof type !== 'string' || typeof text !== 'string') throw invalidInput(`approaches[${i}] needs label, approach_type and approach as strings.`);
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw invalidInput(`approaches[${i}].owner_paths must be an array of strings.`);
    if (!(APPROACH_TYPES as readonly string[]).includes(type)) throw invalidInput(`approaches[${i}].approach_type must be one of ${APPROACH_TYPES.join(', ')}.`);
    if (paths.some((p) => !/^[A-Za-z0-9_./*-]{1,200}$/.test(p) || p.includes('..') || p.startsWith('/'))) throw invalidInput(`approaches[${i}].owner_paths must be repository-relative paths.`);
    return { label, approachType: type as ApproachType, approach: text, ownerPaths: paths as string[] };
  });
}

const experimentsTool: McpTool = {
  name: 'brain_operator_experiments',
  title: 'Operator: experiments',
  description:
    'Every experiment Brain ran to compare alternative fixes (§111): its deficiency, suite and baseline, each variant ' +
    '(approach type, pull request, state, score), the evaluator\'s results (metrics only — hidden cases are never shown), ' +
    'the verdict and its rationale; which approach types have won per capability class (ranked, retired ones last); ' +
    'the loop\'s yield (adoptions per experiment, hours from identification to adoption); and the registered suites.',
  inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many experiments, newest first (default 20).' } }, additionalProperties: false },
  annotations: { title: 'Operator: experiments', ...READ_ONLY },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const { readExperiments } = await import('../services/evolution/experiments.ts');
    const limit = optionalNumber(args, 'limit');
    return { projectId: null, value: await readExperiments({ limit: limit === null ? 20 : Math.min(100, Math.max(1, Math.trunc(limit))) }) };
  },
};

const hiddenCaseTool: McpTool = {
  name: 'brain_operator_add_hidden_case',
  title: 'Operator: add a hidden benchmark case',
  description:
    'Add a case to a registered suite that only the evaluator reads: stored in Brain\'s database, never in the repository, ' +
    'and never shown to an implementing agent, so a variant cannot be fitted to it. Use it when the public cases miss a kind ' +
    'of failure you have seen in production. The case is the suite\'s own case shape, as JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      suite: { type: 'string', description: 'A registered suite name (brain_operator_experiments lists them).' },
      case: { type: 'object', description: "The case, in the suite's case shape (an id and its inputs and expected judgment)." },
      reason: { type: 'string', description: 'What production failure this case represents.' },
    },
    required: ['suite', 'case'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: add a hidden benchmark case', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const { addHiddenCase } = await import('../services/evolution/experiments.ts');
    const value = args['case'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidInput('case must be an object.');
    const runId = await currentRunId();
    return { projectId: null, value: await addHiddenCase({ suite: requiredString(args, 'suite'), testCase: value as Record<string, unknown>, reason: optionalString(args, 'reason'), createdBy: `operator:${runId ?? 'run'}` }) };
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

const reattemptTool: McpTool = {
  name: 'brain_operator_reattempt',
  title: 'Operator: re-attempt failed or stalled engineering',
  description:
    'Start the next attempt (at most three in all) of engineering you commissioned that failed (Factory FAILED or ' +
    'CANCELLED; decided KEPT_NO_EFFECT, REVERTED, REJECTED or HELD; Factory BLOCKED) or stalled (no movement for 24 h). ' +
    'The open attempt is closed HELD with your reason, and the next goes to Factory now with a different method and the ' +
    'strongest workers. Refused, with why, while it is building and moving, while a delivered change is being measured, ' +
    'once it is resolved, and after the third attempt.',
  inputSchema: {
    type: 'object',
    properties: {
      candidate_id: { type: 'string', description: 'The candidateId from brain_operator_engineering (imp_…).' },
      reason: { type: 'string', description: 'Why it failed or stalled, from what you read (15+ characters).' },
    },
    required: ['candidate_id', 'reason'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: re-attempt engineering', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const { reattempt } = await import('../services/operator/director.ts');
    return {
      projectId: null,
      value: { ...(await reattempt({ candidateId: requiredString(args, 'candidate_id'), reason: requiredString(args, 'reason'), runId: await currentRunId() })), next: AFTER_ACTING },
    };
  },
};

const INVENTORY_FIELDS = {
  capability: { type: 'string', description: 'The capability affected (e.g. "operator mission input").' },
  symptom: { type: 'string', description: 'What is observed to go wrong, in production terms.' },
  evidence: { type: 'string', description: 'Row ids, run ids, file:line and verbatim reasons.' },
  root_cause: { type: 'string' },
  severity: { type: 'string', enum: ['BLOCKING', 'MAJOR', 'MINOR'] },
  owner: { type: 'string', description: 'The owner component or files.' },
  verification_criteria: { type: 'string', description: 'What a verification must show for it to count as fixed.' },
  result: { type: 'string', description: 'What was done and what came of it.' },
  linked_candidate_id: { type: 'string', description: 'A register row (imp_…) commissioned for this finding.' },
} as const;

/**
 * The findings inventory (Surge B H2-2/H2-7) over §87's register. Listing needs project:read, as
 * reading goals does; recording or changing a finding needs operator:act. The refusal is the same
 * not-found shape either way (invariants 23, 30).
 */
const inventoryTool: McpTool = {
  name: 'brain_operator_inventory',
  title: 'Operator: findings inventory',
  description:
    'The mission\'s findings register, keyed SURGE-B:<issue id>. action "list" (optionally status, or id for one ' +
    'finding with its history); "upsert" records a finding or updates the fields given (a new one needs capability, ' +
    'symptom, evidence, severity); "set_status" moves one: DISCOVERED, UNDER_INVESTIGATION, ROOT_CAUSE_CONFIRMED, ' +
    'READY_FOR_REPAIR, REPAIRING, AWAITING_VERIFICATION, VERIFIED_FIXED, KNOWN_LIMITATION, EXTERNAL_CONSTRAINT, ' +
    'NOT_A_DEFECT. VERIFIED_FIXED is refused without verification {kind: WORKFLOW_RUN | DEPLOY | MEASUREMENT, ref, ' +
    'detail} — a workflow run id, a deploy run id or merge sha, or a measured outcome with its number — and works for ' +
    'a fix made outside your own commissions too.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'upsert', 'set_status'] },
      id: { type: 'string', description: 'The issue id, e.g. H2-1 (the key is SURGE-B:H2-1).' },
      status: { type: 'string', enum: ['DISCOVERED', 'UNDER_INVESTIGATION', 'ROOT_CAUSE_CONFIRMED', 'READY_FOR_REPAIR', 'REPAIRING', 'AWAITING_VERIFICATION', 'VERIFIED_FIXED', 'KNOWN_LIMITATION', 'EXTERNAL_CONSTRAINT', 'NOT_A_DEFECT'] },
      note: { type: 'string', description: 'Why the status changed (required to close a finding without a fix).' },
      verification: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['WORKFLOW_RUN', 'DEPLOY', 'MEASUREMENT'] },
          ref: { type: 'string' },
          detail: { type: 'string' },
        },
        additionalProperties: false,
      },
      ...INVENTORY_FIELDS,
    },
    required: ['action'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: findings inventory', ...MUTATING },
  run: async (args, { principal }) => {
    const action = requiredString(args, 'action');
    const inventory = await import('../services/operator/inventory.ts');
    if (action === 'list') {
      await requireReader(principal);
      const id = optionalString(args, 'id');
      if (id) {
        const item = await inventory.getInventoryItem(id);
        if (!item) return { projectId: null, value: { ok: false, reason: `no inventory finding ${id}` } };
        return { projectId: null, value: { ok: true, item, history: await inventory.inventoryHistory(id) } };
      }
      const items = await inventory.listInventory({ status: optionalString(args, 'status') ?? undefined });
      return { projectId: null, value: { ok: true, total: items.length, items: items.slice(0, 80) } };
    }
    requireOperator(principal);
    const runId = await currentRunId();
    const ctx = { runId, actor: `operator:${runId ?? 'run'}` };
    const raw = args['verification'];
    if (raw !== undefined && (raw === null || typeof raw !== 'object')) throw invalidInput('verification must be an object {kind, ref, detail}.');
    const verification = raw as { kind?: string; ref?: string; detail?: string } | undefined;
    const typed = verification ? { kind: verification.kind as 'WORKFLOW_RUN' | 'DEPLOY' | 'MEASUREMENT' | undefined, ref: verification.ref, detail: verification.detail } : null;
    if (action === 'upsert') {
      const result = await inventory.upsertInventory(
        {
          id: requiredString(args, 'id'),
          capability: optionalString(args, 'capability'),
          symptom: optionalString(args, 'symptom'),
          evidence: optionalString(args, 'evidence'),
          rootCause: optionalString(args, 'root_cause'),
          severity: optionalString(args, 'severity'),
          owner: optionalString(args, 'owner'),
          verificationCriteria: optionalString(args, 'verification_criteria'),
          result: optionalString(args, 'result'),
          status: optionalString(args, 'status'),
          note: optionalString(args, 'note'),
          verification: typed,
          linkedCandidateId: optionalString(args, 'linked_candidate_id'),
        },
        ctx,
      );
      return { projectId: null, value: result };
    }
    if (action === 'set_status') {
      const result = await inventory.setInventoryStatus(
        { id: requiredString(args, 'id'), status: requiredString(args, 'status'), note: optionalString(args, 'note'), result: optionalString(args, 'result'), verification: typed },
        ctx,
      );
      return { projectId: null, value: result };
    }
    throw invalidInput('action must be list, upsert or set_status.');
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
      decision_id: DECISION_ID_PROPERTY,
    },
    required: ['title', 'problem', 'evidence', 'owner_paths', 'acceptance', 'decision_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: send a defect to Factory', ...MUTATING },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const gate = await decisionGate(args);
    if (!gate.ok) return { projectId: null, value: gate };
    const result = await submitOperatorFix({
      title: requiredString(args, 'title'),
      problem: requiredString(args, 'problem'),
      evidence: requiredString(args, 'evidence'),
      ownerPaths: stringArray(args, 'owner_paths'),
      acceptance: requiredString(args, 'acceptance'),
      runId: await currentRunId(),
      goalId: optionalString(args, 'goal_id'),
    });
    return { projectId: null, value: { ...result, decisionId: gate.decisionId, next: AFTER_ACTING } };
  },
};

const learnTool: McpTool = {
  name: 'brain_operator_record_learning',
  title: 'Operator: record a lesson',
  description:
    'Record a lesson about a goal or about Brain, with the evidence it rests on, so it is not rediscovered. ' +
    'Append-only: it is shown on every later run in brain_operator_history. When the lesson is your evaluation of ' +
    'engineering you commissioned (brain_operator_engineering shows it RESOLVED), give its candidate_id and say in the ' +
    'lesson what the measured change did to the goal — that evaluation closes the improvement cycle.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' },
      lesson: { type: 'string' },
      evidence: { type: 'string' },
      candidate_id: { type: 'string', description: 'The candidateId (imp_…) of commissioned engineering this lesson evaluates.' },
    },
    required: ['lesson', 'evidence'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: record a lesson', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    requireOperator(principal);
    const lesson = requiredString(args, 'lesson');
    const evidence = requiredString(args, 'evidence');
    const candidateId = optionalString(args, 'candidate_id');
    if (candidateId) {
      const { getCandidate } = await import('../repos/improvement.ts');
      const candidate = await getCandidate(candidateId);
      if (!candidate || !candidate.evidence['directive']) throw invalidInput('candidate_id names no engineering you commissioned (brain_operator_engineering lists them).');
    }
    const { evaluatesMarker, notifyVerifiedImprovements } = await import('../services/operator/director.ts');
    const result = await operatorRecordLearning({
      goalId: optionalString(args, 'goal_id'),
      runId: await currentRunId(),
      lesson,
      evidence: candidateId ? `${evaluatesMarker(candidateId)} ${evidence}` : evidence,
    });
    if (!candidateId) return { projectId: null, value: result };
    // The evaluation is the cycle's last step: a verified improvement is told to the owner now, not at the next pass.
    const notice = await notifyVerifiedImprovements({ candidateId }).catch((error: unknown) => [{ candidateId, status: 'FAILED', detail: String((error as Error)?.message ?? error) }]);
    return { projectId: null, value: { ...result, ownerNotice: notice[0] ?? { candidateId, status: 'NOT_VERIFIED', detail: 'not RESOLVED yet' } } };
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
    'Returns REVISE with the challenge when a flaw could change the choice; call again with answered_challenge to stand by it. ' +
    'Returns REVISE with problems when this kind of decision is miscalibrated: `next` names the assumptions to add, each with its ' +
    'prefix (mechanism:, capacity:, condition:, execution:, timing:, estimate:) — add them and call again in the same run; ' +
    'a REVISE is a correction to make, not a reason to stop.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['PAUSE_GOAL', 'RESUME_GOAL', 'SUBMIT_FIX', 'WITHDRAW_REQUEST', 'CONTINUE_IDLE', 'REALLOCATE', 'CHANGE_STRATEGY', 'RESEARCH', 'SWITCH_MODEL', 'STOP_APPROACH', 'ADOPT_PLAN', 'OTHER'] },
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
      // Ranked by run record and benchmark; `challengerModels` drops the weak GPU model and the challenge is time-bounded.
      { runId: await currentRunId(), projectIds: projects, models },
    );
    const goalId = optionalString(args, 'goal_id');
    if (result.committed && args['kind'] === 'ADOPT_PLAN' && goalId) {
      // Hermes' challenge is the plan's last condition: a plan that now qualifies is told to the owner at once.
      const { notifyPlanReady } = await import('../services/goals/planReady.ts');
      const ownerNotice = await notifyPlanReady(goalId).catch((error: unknown) => ({ goalId, status: 'FAILED', detail: String((error as Error)?.message ?? error) }));
      return { projectId: null, value: { ...result, ownerNotice } };
    }
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

const createGoalTool: McpTool = {
  name: 'brain_operator_create_goal',
  title: 'Operator: create a goal from an objective in words',
  description:
    'Create a goal from the owner\'s objective exactly as stated, e.g. "Generate $10,000 within 30 days using at most ' +
    '$3,000 in starting capital." Brain reads the amount, currency, deadline and limits itself (the reading is ' +
    'returned, with anything it could not read under unread). A cash objective gets its due date and its target on ' +
    "the project's ledger; any other objective becomes a goal with its words as the intent. Refused when a cash " +
    'objective names no currency or deadline, or when another live goal already counts that project\'s ledger.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'The project (prj_…) the goal belongs to; its ledger is what a cash target counts.' },
      text: { type: 'string', description: 'The objective, verbatim in the owner\'s words.' },
    },
    required: ['project_id', 'text'],
    additionalProperties: false,
  },
  annotations: { title: 'Operator: create a goal', ...MUTATING, idempotentHint: false },
  run: async (args, { principal }) => {
    const projects = requireOperator(principal);
    const projectId = requiredString(args, 'project_id');
    if (!projects.includes(projectId)) throw notFoundError();
    const { createGoal } = await import('../services/goals/decide.ts');
    const runId = await currentRunId();
    const result = await createGoal({ projectId, objective: requiredString(args, 'text'), actorRef: `operator:${runId ?? 'run'}`, userId: null });
    if (!result.ok) return { projectId, value: { ok: false, refused: true, reason: result.reason, reading: result.reading } };
    return { projectId, value: { ok: true, goalId: result.goal.id, title: result.goal.title, dueAt: result.goal.dueAt, target: result.target, reading: result.reading, consequence: result.consequence } };
  },
};

export const OPERATOR_TOOLS: readonly McpTool[] = [
  goalsTool,
  goalTool,
  planTool,
  capacityTool,
  knowledgeTool,
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
  createGoalTool,
  deficienciesTool,
  commissionTool,
  engineeringTool,
  prioritizeTool,
  inventoryTool,
  reattemptTool,
  experimentsTool,
  hiddenCaseTool,
];
