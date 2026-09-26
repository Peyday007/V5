/**
 * The engineering connector: seven tools every coding worker shares.
 *
 * Peyton's Claude Code, Airyn, Caleb, a Factory worker and a Russell software
 * worker all ask the same questions — how risky is this, what is already
 * known, which tests must run, does an owner for this mechanism already exist,
 * what do I do next, is this blocker a person's — and before this each one
 * answered them by itself, differently every session. The answers now come
 * from `domain/engineering.ts`, which is pure, and the evidence from
 * `repos/engineering.ts` plus the rows Brain already writes.
 *
 * Same rules as the rest of `tools.ts`: in the one registry, identical for
 * every caller, authorized at execution time by `services/identity/policy.ts`.
 * The advisory tools disclose nothing about any project unless a `project_id`
 * is named, and then only after `project:read` is decided. A worker may record
 * evidence only as TEST or SYNTHETIC — the stronger sources are Brain's own
 * readings or a shell — so no worker can fabricate a PROVEN production fact.
 */
import {
  BLOCKER_KINDS,
  OUTCOME_LEVELS,
  WORKER_RECORDABLE_SOURCES,
  EVIDENCE_STATUSES,
  classifyBlocker,
  duplicateMechanismCheck,
  fullGateKey,
  nextEngineeringAction,
  preflight,
  testPolicy,
  type BlockerKind,
  type EvidenceSource,
  type EvidenceStatus,
  type OutcomeLevel,
} from '../domain/engineering.ts';
import type { FactoryCampaignState } from '../domain/factory.ts';
import { getCampaign } from '../repos/factory.ts';
import {
  canonicalRepository,
  observationsFor,
  recordBlocker,
  recordEvidence,
  recordIntervention,
} from '../repos/engineering.ts';
import { lookupEvidence } from '../services/engineering/evidence.ts';
import { invalidInput } from './errors.ts';
import {
  MUTATING,
  READ_ONLY,
  authorize,
  optionalInteger,
  optionalString,
  requiredString,
  type McpTool,
} from './toolkit.ts';
import type { Principal } from '../domain/types.ts';

/* ------------------------------------------------------------------------- */
/* Argument helpers                                                           */
/* ------------------------------------------------------------------------- */

function stringList(args: Record<string, unknown>, field: string): string[] {
  const value = args[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidInput(`"${field}" must be an array of strings.`);
  }
  return value as string[];
}

function optionalBoolean(args: Record<string, unknown>, field: string): boolean | null {
  const value = args[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalidInput(`"${field}" must be a boolean.`);
  return value;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], field: string): T | null {
  if (value === null) return null;
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalidInput(`"${field}" must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Authorize a named project, or disclose nothing project-scoped at all. */
async function optionalProject(principal: Principal, args: Record<string, unknown>): Promise<string | null> {
  const projectId = optionalString(args, 'project_id');
  if (projectId) await authorize(principal, projectId, 'READ', 'project:read');
  return projectId;
}

function actor(principal: Principal): { actorType: string; actorId: string } {
  return { actorType: principal.type, actorId: principal.id };
}

const PROJECT_ID = { type: 'string', description: 'The project this work belongs to (optional).' };
const TASK_REF = {
  type: 'string',
  description: 'The task: a Factory campaign id (fcp_…), a bin id, a workstream id or a branch name.',
};

/* ------------------------------------------------------------------------- */
/* 1. Preflight                                                               */
/* ------------------------------------------------------------------------- */

const preflightTool: McpTool = {
  name: 'brain_engineering_preflight',
  title: 'Engineering preflight',
  description:
    'Before starting a coding task: returns the execution envelope Brain decides for it — risk tier, ' +
    'whether the root cause is known, the recommended mode (RESTORE_FIRST, FIX_FIRST, INVESTIGATE, ' +
    'DESIGN), an investigation budget, the test policy, whether architecture expansion is allowed, ' +
    'existing evidence, duplicate-mechanism warnings, and what DONE means. Follow it rather than ' +
    'choosing your own rigor. If it refuses your proposed action, do the replacement it names.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID,
      task_ref: TASK_REF,
      repository: { type: 'string', description: 'owner/name.' },
      objective: { type: 'string', description: 'What the task is for, in one sentence.' },
      intended_outcome: { type: 'string', enum: [...OUTCOME_LEVELS], description: 'How far the task goes. Default PRODUCTION_WORKING.' },
      current_sha: { type: 'string' },
      changed_paths: { type: 'array', items: { type: 'string' }, description: 'Paths the change touches or will touch.' },
      known_root_cause: { type: 'string', description: 'The root cause, if it is known.' },
      reversible: { type: 'boolean' },
      blast_radius: { type: 'string', enum: ['SMALL', 'MEDIUM', 'LARGE'] },
      production_broken: { type: 'boolean' },
      schema_change: { type: 'boolean' },
      proposed_action: { type: 'string', description: 'What you are about to do.' },
      properties_to_prove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence property keys the task needs established; Brain looks each one up first.',
      },
    },
    required: ['objective'],
    additionalProperties: false,
  },
  annotations: { title: 'Engineering preflight', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = await optionalProject(principal, args);
    const repository = optionalString(args, 'repository');
    const wanted = stringList(args, 'properties_to_prove');
    const proven: string[] = [];
    const evidence: Record<string, unknown>[] = [];
    if (repository) {
      for (const key of wanted) {
        const reading = await lookupEvidence({ repository, propertyKey: key });
        evidence.push({ propertyKey: key, status: reading.status, sourceKind: reading.sourceKind, evidenceRef: reading.evidenceRef });
        if (reading.status === 'PROVEN') proven.push(key);
      }
    }
    const blast = oneOf(optionalString(args, 'blast_radius'), ['SMALL', 'MEDIUM', 'LARGE'] as const, 'blast_radius');
    const envelope = preflight({
      objective: requiredString(args, 'objective'),
      intendedOutcome: oneOf(optionalString(args, 'intended_outcome'), OUTCOME_LEVELS, 'intended_outcome'),
      changedPaths: stringList(args, 'changed_paths'),
      knownRootCause: optionalString(args, 'known_root_cause'),
      reversible: optionalBoolean(args, 'reversible') ?? undefined,
      blastRadius: blast ?? undefined,
      productionBroken: optionalBoolean(args, 'production_broken') ?? false,
      schemaChange: optionalBoolean(args, 'schema_change') ?? false,
      proposedAction: optionalString(args, 'proposed_action'),
      provenProperties: proven,
    });
    const taskRef = optionalString(args, 'task_ref');
    const proposal = optionalString(args, 'proposed_action');
    if (envelope.proposalRefused && proposal) {
      await recordIntervention({
        projectId,
        taskRef,
        kind: 'OVERENGINEERING_BLOCKED',
        rule: 'RULE_1_MINIMUM_SUFFICIENT_FIX',
        attemptedAction: proposal,
        replacementAction: envelope.proposalRefused,
        ...actor(principal),
      });
    }
    if (proven.length > 0) {
      await recordIntervention({
        projectId,
        taskRef,
        kind: 'REAL_EVIDENCE_REUSED',
        rule: 'RULE_2_REAL_EVIDENCE_FIRST',
        attemptedAction: `establish ${proven.join(', ')}`,
        replacementAction: 'reuse the existing evidence',
        ...actor(principal),
      });
    }
    if (envelope.duplicateCheck?.extensionPreferred && proposal) {
      await recordIntervention({
        projectId,
        taskRef,
        kind: 'DUPLICATE_MECHANISM_BLOCKED',
        rule: 'RULE_6_NO_DUPLICATE_MECHANISM',
        attemptedAction: proposal,
        replacementAction: envelope.duplicateCheck.reason,
        ...actor(principal),
      });
    }
    return {
      projectId,
      value: { ...envelope, currentSha: optionalString(args, 'current_sha'), evidence } as unknown as Record<string, unknown>,
    };
  },
};

/* ------------------------------------------------------------------------- */
/* 2. Evidence lookup                                                         */
/* ------------------------------------------------------------------------- */

const lookupTool: McpTool = {
  name: 'brain_evidence_lookup',
  title: 'Is this already known?',
  description:
    'Ask Brain whether a property is already established before proving it again. Keys include ' +
    'FULL_GATE:<sha>:postgres, FULL_GATE:<sha>:sqlite, FACTORY_SURFACE:<routine>:repo:<owner/name>:push, ' +
    'FACTORY_SURFACE:<routine>:repo:<owner/name>:delivery, DEPLOY:<sha>:hosted_verify and ' +
    'REPOSITORY_ACCESS:<worker>:<owner/name>. Returns PROVEN, FAILED, STALE or UNKNOWN with the source ' +
    '(REAL_PRODUCTION outranks CI, OPERATOR, TEST and SYNTHETIC), the evidence reference, why it is still ' +
    'valid and what would invalidate it. Do not re-prove a PROVEN property unless something in its ' +
    'invalidation scope changed.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID,
      task_ref: TASK_REF,
      repository: { type: 'string', description: 'owner/name.' },
      property_key: { type: 'string' },
      current_fingerprint: { type: 'string', description: 'The configuration now; a mismatch reads STALE.' },
      about_to_reprove: { type: 'boolean', description: 'You were about to prove this again.' },
    },
    required: ['repository', 'property_key'],
    additionalProperties: false,
  },
  annotations: { title: 'Evidence lookup', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = await optionalProject(principal, args);
    const reading = await lookupEvidence({
      repository: requiredString(args, 'repository'),
      propertyKey: requiredString(args, 'property_key'),
      currentFingerprint: optionalString(args, 'current_fingerprint'),
    });
    if (reading.status === 'PROVEN' && optionalBoolean(args, 'about_to_reprove')) {
      await recordIntervention({
        projectId,
        taskRef: optionalString(args, 'task_ref'),
        kind: reading.propertyKey.startsWith('FULL_GATE:') ? 'REDUNDANT_TEST_BLOCKED' : 'REAL_EVIDENCE_REUSED',
        rule: 'RULE_2_REAL_EVIDENCE_FIRST',
        attemptedAction: `prove ${reading.propertyKey} again`,
        replacementAction: `reuse ${reading.evidenceRef ?? 'the existing evidence'}`,
        ...actor(principal),
      });
    }
    return { projectId, value: reading as unknown as Record<string, unknown> };
  },
};

/* ------------------------------------------------------------------------- */
/* 3. Evidence record                                                         */
/* ------------------------------------------------------------------------- */

const recordTool: McpTool = {
  name: 'brain_evidence_record',
  title: 'Record evidence',
  description:
    'Record what your own run established, with provenance: a command you ran, its exit code and the SHA. ' +
    'A worker may record TEST or SYNTHETIC evidence only. CI, OPERATOR and REAL_PRODUCTION evidence is ' +
    'Brain\'s own reading (confirmed pushes, CI check runs, deliveries) or an operator\'s, and cannot be ' +
    'written here. Idempotent by content: recording the same observation twice stores it once.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'The project the evidence is recorded under.' },
      repository: { type: 'string' },
      property_key: { type: 'string' },
      status: { type: 'string', enum: [...EVIDENCE_STATUSES] },
      source_kind: { type: 'string', enum: [...WORKER_RECORDABLE_SOURCES] },
      evidence_ref: { type: 'string', description: 'What produced it: the command and exit code, a log, a bin id.' },
      code_sha: { type: 'string' },
      config_fingerprint: { type: 'string' },
      invalidation_scope: { type: 'array', items: { type: 'string' } },
    },
    required: ['project_id', 'repository', 'property_key', 'status', 'source_kind', 'evidence_ref'],
    additionalProperties: false,
  },
  annotations: { title: 'Record evidence', ...MUTATING },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'WRITE', 'checkpoints:write');
    const source = requiredString(args, 'source_kind');
    if (!(WORKER_RECORDABLE_SOURCES as readonly string[]).includes(source)) {
      throw invalidInput(
        `A worker may record ${WORKER_RECORDABLE_SOURCES.join(' or ')} evidence only. ` +
          'REAL_PRODUCTION and CI evidence is read by Brain from rows it already writes.',
      );
    }
    const status = oneOf(requiredString(args, 'status'), EVIDENCE_STATUSES, 'status') as EvidenceStatus;
    const repository = canonicalRepository(requiredString(args, 'repository'));
    const propertyKey = requiredString(args, 'property_key');
    const evidenceRef = requiredString(args, 'evidence_ref');
    const codeSha = optionalString(args, 'code_sha');
    const existing = (await observationsFor(repository, propertyKey)).find(
      (o) => o.source === source && o.status === status && o.evidenceRef === evidenceRef && o.codeSha === codeSha,
    );
    if (existing) {
      return { projectId, value: { recorded: false, state: 'ALREADY_RECORDED', recordedAt: existing.createdAt } };
    }
    const id = await recordEvidence({
      projectId,
      repository,
      propertyKey,
      status,
      source: source as EvidenceSource,
      evidenceRef,
      codeSha,
      configFingerprint: optionalString(args, 'config_fingerprint'),
      invalidationScope: stringList(args, 'invalidation_scope'),
      recordedByType: 'WORKER',
      recordedById: principal.id,
    });
    return { projectId, value: { recorded: true, evidenceId: id } };
  },
};

/* ------------------------------------------------------------------------- */
/* 4. Test policy                                                             */
/* ------------------------------------------------------------------------- */

const testPolicyTool: McpTool = {
  name: 'brain_test_policy',
  title: 'Which tests to run',
  description:
    'Before running tests: returns exactly what should run for these changed paths and why — typecheck, ' +
    'test:impacted, focused Postgres, or the full gate. A full suite on an intermediate commit is refused; ' +
    'a full suite on a SHA that already has a valid full-gate PASS is refused and the evidence reused. ' +
    'The canonical release gate runs once, on the SHA that is integrated and released.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID,
      task_ref: TASK_REF,
      repository: { type: 'string' },
      sha: { type: 'string' },
      changed_paths: { type: 'array', items: { type: 'string' } },
      release_sha: { type: 'boolean', description: 'This SHA is the one being integrated and released.' },
      proposes_full_suite: { type: 'boolean', description: 'You were about to run the whole suite.' },
    },
    required: ['changed_paths'],
    additionalProperties: false,
  },
  annotations: { title: 'Test policy', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = await optionalProject(principal, args);
    const repository = optionalString(args, 'repository');
    const sha = optionalString(args, 'sha');
    let fullGate: { sqlite?: EvidenceStatus; postgres?: EvidenceStatus } = {};
    if (repository && sha) {
      const sqlite = await lookupEvidence({ repository, propertyKey: fullGateKey(sha, 'sqlite') });
      const postgres = await lookupEvidence({ repository, propertyKey: fullGateKey(sha, 'postgres') });
      fullGate = { sqlite: sqlite.status, postgres: postgres.status };
    }
    const policy = testPolicy({
      changedPaths: stringList(args, 'changed_paths'),
      sha,
      releaseSha: optionalBoolean(args, 'release_sha') ?? false,
      fullGate,
      proposesFullSuite: optionalBoolean(args, 'proposes_full_suite') ?? false,
    });
    if (policy.fullSuiteRefused) {
      await recordIntervention({
        projectId,
        taskRef: optionalString(args, 'task_ref'),
        kind: 'REDUNDANT_TEST_BLOCKED',
        rule: 'RULE_3_NO_REDUNDANT_FULL_SUITES',
        attemptedAction: `full suite${sha ? ` on ${sha}` : ''}`,
        replacementAction: policy.commands.join(' && ') || 'no test run',
        // The full suite is measured at roughly twenty minutes on this repository (§27's table).
        minutesAvoided: 20,
        ...actor(principal),
      });
    }
    return { projectId, value: { ...policy, fullGate } as unknown as Record<string, unknown> };
  },
};

/* ------------------------------------------------------------------------- */
/* 5. Duplicate mechanism check                                               */
/* ------------------------------------------------------------------------- */

const duplicateTool: McpTool = {
  name: 'brain_duplicate_mechanism_check',
  title: 'Does an owner already exist?',
  description:
    'Before creating a scheduler, queue, verification subsystem, auth layer, evidence layer, worker ' +
    'manager, repository abstraction, retry system, monitoring or orchestration mechanism: ask whether ' +
    'Brain already has an owner for that responsibility. Returns the owner files and how to extend them. ' +
    'Extension is preferred unless you state why it cannot work.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID,
      task_ref: TASK_REF,
      proposal: { type: 'string', description: 'The mechanism you are about to build.' },
      why_extension_fails: { type: 'string', description: 'Why extending the existing owner cannot work.' },
    },
    required: ['proposal'],
    additionalProperties: false,
  },
  annotations: { title: 'Duplicate mechanism check', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = await optionalProject(principal, args);
    const proposal = requiredString(args, 'proposal');
    const check = duplicateMechanismCheck({ proposal, whyExtensionFails: optionalString(args, 'why_extension_fails') });
    if (check.extensionPreferred) {
      await recordIntervention({
        projectId,
        taskRef: optionalString(args, 'task_ref'),
        kind: 'DUPLICATE_MECHANISM_BLOCKED',
        rule: 'RULE_6_NO_DUPLICATE_MECHANISM',
        attemptedAction: proposal,
        replacementAction: check.matches.map((m) => m.extend).join(' '),
        ...actor(principal),
      });
    }
    return { projectId, value: check as unknown as Record<string, unknown> };
  },
};

/* ------------------------------------------------------------------------- */
/* 6. Next action                                                             */
/* ------------------------------------------------------------------------- */

/** How far a Factory campaign's own state has taken its outcome. */
export function reachedForCampaign(state: FactoryCampaignState, prOpen: boolean): OutcomeLevel | null {
  switch (state) {
    case 'PLANNING':
      return null;
    case 'EXECUTING':
    case 'INTEGRATING':
    case 'REPAIRING':
      return 'BRANCH';
    case 'REVIEWING':
    case 'VERIFYING':
    case 'ASSEMBLING':
      return 'TESTS_PASS';
    case 'AWAITING_RELEASE':
    case 'COMPLETE':
      return prOpen ? 'PR_OPEN' : 'TESTS_PASS';
    case 'BLOCKED':
    case 'CANCELLED':
      return null;
  }
}

const nextActionTool: McpTool = {
  name: 'brain_next_engineering_action',
  title: 'What to do next',
  description:
    'Before stopping, waiting or asking a person: returns CONTINUE, WATCH_PROCESS, START_NEXT_WORK, ' +
    'WAIT_EXTERNAL, NEEDS_HUMAN or DONE with the reason. DONE is the requested outcome reached — a PR is ' +
    'not done when the outcome is production working. An observable process is watched to termination ' +
    '(with a poll interval), never "checked in fifteen minutes". Pass a Factory campaign id as task_ref and ' +
    'Brain reads how far it has got from the campaign\'s own rows.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: PROJECT_ID,
      task_ref: TASK_REF,
      intended_outcome: { type: 'string', enum: [...OUTCOME_LEVELS] },
      reached: { type: 'string', enum: [...OUTCOME_LEVELS] },
      running_process_observable: { type: 'boolean' },
      running_process_expected_minutes: { type: 'integer' },
      proposed_wait_minutes: { type: 'integer' },
      independent_work_available: { type: 'boolean' },
      human_blocker_open: { type: 'boolean' },
      proposing_to_stop: { type: 'boolean' },
    },
    required: ['intended_outcome'],
    additionalProperties: false,
  },
  annotations: { title: 'Next engineering action', ...READ_ONLY },
  run: async (args, { principal }) => {
    let projectId = await optionalProject(principal, args);
    const taskRef = optionalString(args, 'task_ref');
    let reached = oneOf(optionalString(args, 'reached'), OUTCOME_LEVELS, 'reached');
    let derivedFrom = 'caller';
    if (taskRef?.startsWith('fcp_')) {
      const campaign = await getCampaign(taskRef);
      if (campaign) {
        await authorize(principal, campaign.projectId, 'READ', 'project:read');
        projectId = campaign.projectId;
        reached = reachedForCampaign(campaign.state, Boolean(campaign.prRef || campaign.prUrl));
        derivedFrom = `campaign ${campaign.id} is ${campaign.state}`;
      }
    }
    const observable = optionalBoolean(args, 'running_process_observable');
    const decision = nextEngineeringAction({
      intendedOutcome: oneOf(requiredString(args, 'intended_outcome'), OUTCOME_LEVELS, 'intended_outcome')!,
      reached,
      runningProcess:
        observable === null
          ? null
          : { observable, expectedMinutes: optionalInteger(args, 'running_process_expected_minutes') },
      proposedWaitMinutes: optionalInteger(args, 'proposed_wait_minutes'),
      independentWorkAvailable: optionalBoolean(args, 'independent_work_available') ?? false,
      humanBlockerOpen: optionalBoolean(args, 'human_blocker_open') ?? false,
      proposingToStop: optionalBoolean(args, 'proposing_to_stop') ?? false,
    });
    for (const intervention of decision.interventions) {
      await recordIntervention({
        projectId,
        taskRef,
        kind: intervention.kind,
        rule: intervention.kind === 'BAD_WAIT_BLOCKED' ? 'RULE_4_NO_DUMB_WAITING' : 'RULE_5_USER_OUTCOME_DEFINES_DONE',
        attemptedAction: intervention.attempted,
        replacementAction: intervention.replacement,
        minutesAvoided: intervention.minutesAvoided,
        ...actor(principal),
      });
    }
    return { projectId, value: { ...decision, reached, derivedFrom } as unknown as Record<string, unknown> };
  },
};

/* ------------------------------------------------------------------------- */
/* 7. Blocker                                                                 */
/* ------------------------------------------------------------------------- */

const blockerTool: McpTool = {
  name: 'brain_engineering_blocker',
  title: 'Record a blocker',
  description:
    'Record a genuine blocker, classified: AUTO_WAIT, RETRYABLE, MISSING_AUTHORITY, HUMAN_DECISION, ' +
    'EXTERNAL_SERVICE, DEFECT or AMBIGUOUS_REQUIREMENT. Only MISSING_AUTHORITY, HUMAN_DECISION and ' +
    'AMBIGUOUS_REQUIREMENT reach a person, and the last two are refused unless you name what you checked ' +
    'first (repo, git_history, database, brain_records, github, workflow_logs, configuration) — a question ' +
    'Brain can answer from its own records is not a person\'s.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      task_ref: TASK_REF,
      kind: { type: 'string', enum: [...BLOCKER_KINDS] },
      statement: { type: 'string' },
      remedy: { type: 'string', description: 'What would clear it, and who performs that.' },
      checked: { type: 'array', items: { type: 'string' } },
    },
    required: ['project_id', 'kind', 'statement', 'remedy'],
    additionalProperties: false,
  },
  annotations: { title: 'Engineering blocker', ...MUTATING },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'WRITE', 'blockers:report');
    const kind = oneOf(requiredString(args, 'kind'), BLOCKER_KINDS, 'kind') as BlockerKind;
    const statement = requiredString(args, 'statement');
    const checked = stringList(args, 'checked');
    const taskRef = optionalString(args, 'task_ref');
    const verdict = classifyBlocker({ kind, statement, checked });
    if (!verdict.accepted) {
      await recordIntervention({
        projectId,
        taskRef,
        kind: 'UNNECESSARY_HUMAN_QUESTION',
        rule: 'RULE_7_DONT_ASK_WHAT_BRAIN_CAN_KNOW',
        attemptedAction: statement,
        replacementAction: verdict.reason,
        ...actor(principal),
      });
      return { projectId, value: { recorded: false, ...verdict } };
    }
    const id = await recordBlocker({
      projectId,
      taskRef,
      kind,
      statement,
      remedy: requiredString(args, 'remedy'),
      needsHuman: verdict.needsHuman,
      checked,
      ...actor(principal),
    });
    return { projectId, value: { recorded: true, blockerId: id, ...verdict } };
  },
};

export const ENGINEERING_TOOLS: readonly McpTool[] = [
  preflightTool,
  lookupTool,
  recordTool,
  testPolicyTool,
  duplicateTool,
  nextActionTool,
  blockerTool,
];
