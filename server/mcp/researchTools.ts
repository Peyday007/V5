/**
 * The research half of the tool surface.
 *
 * Step 7 exposed nine reads and five queue operations, and Step 8 connected a
 * real Claude to them. Between them they proved a worker can be told what to
 * do. What no tool could do was let it say what it found: the scopes
 * `research:read`, `research:propose`, `research:write`, `claims:write`,
 * `contradictions:write`, `checkpoints:write` and `blockers:report` had existed
 * since Step 4 and not one of them gated anything. A worker's analysis went
 * into a chat log and nowhere durable.
 *
 * These eight close that, and the constraint they are all built around is one
 * sentence: **a worker submits, and the Brain decides.**
 *
 * Not one of them writes an accepted claim. `brain_submit_claims` stores
 * everything unaccepted; `applyGate` decides, in `submission.ts`, in the same
 * function the in-process orchestrator calls. There is no branch in that code
 * for "this came from a worker", which is the property worth having: the remote
 * path cannot be looser than the local one because it is not a different path.
 *
 * Nor does any of them tell a worker what to say. `brain_get_assignment` hands
 * back the fragment's declaration — the question and the boundaries it will be
 * judged against — and no prompt. That distinction is the same one the work
 * type registry draws, at the other end of the same wire.
 *
 * Everything else is inherited rather than re-earned. Authorization is
 * `policy.ts` at execution time, through the one `authorize` in `toolkit.ts`.
 * A refusal is `NOT_FOUND` and names nothing. Every mutation is fenced by the
 * lease and keyed from the work item. None of them is filtered out of
 * `tools/list` for a caller who may not use it, because a list that varies by
 * principal is a permission oracle.
 */
import crypto from 'node:crypto';
import type {
  Principal,
  ResearchFragment,
  ResearchOrchestration,
  WorkItem,
} from '../domain/types.ts';
import {
  ASSIGNMENT_VERDICTS,
  AUDIT_VERDICTS,
  CONSISTENCY_RELATIONS,
  CONTRADICTION_STATES,
  GAP_CLASSIFICATIONS,
} from '../domain/types.ts';
import {
  TerminalEffectFailure,
  type OperationNamespace,
} from '../services/effects/engine.ts';
import {
  parseAdversarialPass,
  parseJudgePass,
  parsePrimaryPass,
  type JudgePassOutput,
} from '../services/audit/schema.ts';
import { recordAuditPasses } from '../services/audit/pipeline.ts';
import {
  auditBriefFor,
  AuditBriefUnavailable,
  earlierAuditRole,
  ROLE_PASS_ORDINAL,
} from '../services/research/auditBrief.ts';
import { recomputeProject } from '../services/stateEngine.ts';
import { AUDIT_ROLES, type AuditRole } from '../services/queue/workTypes.ts';
import { assignmentFor } from '../services/research/assignment.ts';
import { coverProposal, whyNotResearched } from '../services/research/coverageGate.ts';
import { planDependencies } from '../services/research/splitting.ts';
import {
  gateFragment,
  recordFragmentClaims,
  type ClaimVerification,
} from '../services/research/submission.ts';
import { SCOPE_MATCH_VALUES, type ClaimScopeMatch } from '../services/research/schema.ts';
import { CLAIM_TYPES } from '../domain/types.ts';
import {
  createFragments,
  getFragment,
  getOrchestration,
  listClaimsForFragment,
  markContradiction,
  startPass,
  finishPass,
  updateFragment,
  updateOrchestration,
} from '../repos/research.ts';
import { checkpointWork, listCheckpoints, TooManyCheckpoints } from '../repos/workQueue.ts';
import { classifyContradiction } from '../services/research/contradictions.ts';
import {
  assertCitable,
  fileResearchPacket,
  NothingToFile,
  UncitableClaims,
} from '../services/research/filing.ts';
import { conflictError, invalidInput, notFoundError } from './errors.ts';
import {
  MUTATING,
  READ_ONLY,
  idempotentEffect,
  optionalIdempotencyKey,
  optionalString,
  proofFrom,
  requireOwnedItem,
  requiredString,
  workerOnly,
  type McpTool,
} from './toolkit.ts';

/* ------------------------------------------------------------------------ */
/* Bounds                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Every bound here is a refusal rather than a truncation.
 *
 * Truncating a claim ledger would file half a fragment's evidence and report
 * success, and the gate would then judge a fragment against a ledger nobody
 * meant to submit. A worker that overshot needs to know it overshot.
 */
export const MAX_CLAIMS_PER_SUBMISSION = 60;
export const MAX_FRAGMENTS_PER_PLAN = 40;
export const MAX_CLAIM_CHARS = 2000;
export const MAX_EXCERPT_CHARS = 4000;
export const MAX_REPORT_CHARS = 400 * 1024;
export const MAX_NOTE_CHARS = 2000;
export const MAX_LIST_ITEMS = 30;
export const MAX_LIST_ITEM_CHARS = 400;

/* ------------------------------------------------------------------------ */
/* Namespaces                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Named for the operation, not the door it came through — the same rule the
 * queue namespaces follow. `research.claims` rather than `mcp.research.claims`,
 * because the identity of "record the ledger for work item X" does not change
 * with the transport that asked for it.
 *
 * `principalScope: 'PROJECT'` throughout: submitting one fragment's claims is
 * one intent however many principals arrive at it, which is exactly what that
 * field is for.
 */
function namespace(name: string): OperationNamespace {
  return { name, version: 1, principalScope: 'PROJECT', retention: 'STANDARD' };
}

const PLAN_NAMESPACE = namespace('research.plan');
const CLAIMS_NAMESPACE = namespace('research.claims');
const VERIFY_NAMESPACE = namespace('research.verify');
const CONTRADICTION_NAMESPACE = namespace('research.contradiction');
const BLOCKER_NAMESPACE = namespace('research.blocker');
const SYNTHESIS_NAMESPACE = namespace('research.synthesis');

/* ------------------------------------------------------------------------ */
/* Argument reading                                                          */
/* ------------------------------------------------------------------------ */

function objectArray(args: Record<string, unknown>, field: string, max: number): Record<string, unknown>[] {
  const value = args[field];
  if (!Array.isArray(value)) throw invalidInput(`${field} is required and must be an array.`);
  if (value.length === 0) throw invalidInput(`${field} must contain at least one entry.`);
  if (value.length > max) {
    throw invalidInput(`${field} may contain at most ${max} entries; this one has ${value.length}.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidInput(`${field}[${index}] must be an object.`);
    }
    return entry as Record<string, unknown>;
  });
}

function str(row: Record<string, unknown>, field: string, where: string, max: number): string {
  const value = row[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(`${where}.${field} is required and must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw invalidInput(`${where}.${field} may be at most ${max} characters.`);
  }
  return trimmed;
}

function maybeStr(row: Record<string, unknown>, field: string, where: string, max: number): string | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidInput(`${where}.${field} must be a string when present.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw invalidInput(`${where}.${field} may be at most ${max} characters.`);
  return trimmed;
}

function strList(row: Record<string, unknown>, field: string, where: string): string[] {
  const value = row[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidInput(`${where}.${field} must be an array of strings.`);
  if (value.length > MAX_LIST_ITEMS) {
    throw invalidInput(`${where}.${field} may contain at most ${MAX_LIST_ITEMS} entries.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw invalidInput(`${where}.${field}[${index}] must be a non-empty string.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_LIST_ITEM_CHARS) {
      throw invalidInput(`${where}.${field}[${index}] may be at most ${MAX_LIST_ITEM_CHARS} characters.`);
    }
    return trimmed;
  });
}

function bool(row: Record<string, unknown>, field: string, where: string, fallback: boolean): boolean {
  const value = row[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw invalidInput(`${where}.${field} must be a boolean when present.`);
  return value;
}

function confidence(row: Record<string, unknown>, where: string): number {
  const value = row['confidence'];
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidInput(`${where}.confidence must be a number between 0 and 1.`);
  }
  return value;
}

function oneOf<T extends string>(
  row: Record<string, unknown>,
  field: string,
  where: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = row[field];
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  // Matched exactly. No substring matching, no closest value, no inference —
  // §8's rule about enums, which applies here for the same reason it applies to
  // an audit verdict: a value that was nearly right is a value that was wrong.
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidInput(`${where}.${field} must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

/* ------------------------------------------------------------------------ */
/* Resolving the work item to its assignment                                 */
/* ------------------------------------------------------------------------ */

/**
 * A claimed research item, its orchestration and its fragment — or a refusal.
 *
 * Everything is resolved from the item's own columns. A worker names the work
 * item and its lease; it never names the orchestration or the fragment, so
 * there is no argument through which one item's lease could reach another
 * item's assignment.
 *
 * `expectType` is checked because the work type is what the whole design rests
 * on: submitting claims against a `RESEARCH_AUDIT` item would be recording
 * research nobody asked for, under a lease that was issued for something else.
 */
async function resolveResearch(
  principal: Principal,
  args: Record<string, unknown>,
  scope: Parameters<typeof requireOwnedItem>[2],
  expectType: string,
): Promise<{
  item: WorkItem;
  orchestration: ResearchOrchestration;
  fragment: ResearchFragment | null;
}> {
  const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), scope);
  if (!item) throw notFoundError();
  if (item.workType !== expectType) throw notFoundError();
  if (!item.orchestrationId) throw notFoundError();

  const orchestration = await getOrchestration(item.orchestrationId);
  if (!orchestration || orchestration.projectId !== item.projectId) throw notFoundError();

  const fragment = item.fragmentId ? await getFragment(item.fragmentId) : null;
  if (item.fragmentId && (!fragment || fragment.orchestrationId !== orchestration.id)) {
    throw notFoundError();
  }
  return { item, orchestration, fragment };
}

/**
 * Record the pass this submission was, before it is acted on.
 *
 * §12 requires every pass to be written down with its exact prompt, that
 * prompt's sha-256 and the raw reply. A worker-driven pass has no prompt Brain
 * issued — the whole point is that Brain did not write one — so what is stored
 * is what Brain *did* issue: the assignment it handed over. Storing an empty
 * string would satisfy the column and record nothing.
 */
async function recordPass(input: {
  orchestration: ResearchOrchestration;
  fragmentId: string | null;
  passKey: Parameters<typeof startPass>[0]['passKey'];
  ordinal: number;
  attempt: number;
  workerId: string;
  assignment: string;
  raw: unknown;
}): Promise<string> {
  const pass = await startPass({
    orchestrationId: input.orchestration.id,
    fragmentId: input.fragmentId,
    passKey: input.passKey,
    ordinal: input.ordinal,
    attempt: input.attempt,
    // The worker is the provider here, and saying so is the point: a pass row
    // that claimed a model name Brain never called would be a fabrication.
    provider: 'WORKER',
    model: input.workerId,
    prompt: input.assignment,
    promptSha256: crypto.createHash('sha256').update(input.assignment, 'utf8').digest('hex'),
  });
  await finishPass(pass.id, {
    status: 'COMPLETE',
    rawResponse: JSON.stringify(input.raw).slice(0, MAX_REPORT_CHARS),
    parsed: input.raw,
  });
  return pass.id;
}

/**
 * The gap shape, identical for the primary's candidates and the judge's
 * classifications, because they are the same thing at two stages.
 */
/**
 * One classified gap.
 *
 * Two of these fields are conditionally required and JSON Schema cannot say
 * so, which means the only place a caller can learn it is here: a gap
 * classified OTHER_LAYER must name `owning_layer`, and one classified
 * TARGETED_RESEARCH_GAP must state a `research_question`. Both are refused by
 * the validator otherwise — a handoff to nobody is not a handoff, and a
 * research gap with no question is not something a run could answer.
 */
const GAP_SCHEMA = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: [...GAP_CLASSIFICATIONS] },
    title: { type: 'string' },
    detail: { type: 'string' },
    justification: { type: 'string' },
    owning_layer: {
      type: 'string',
      description: 'Required when classification is OTHER_LAYER.',
    },
    research_question: {
      type: 'string',
      description: 'Required when classification is TARGETED_RESEARCH_GAP.',
    },
    expected_contribution: { type: 'string' },
  },
  required: ['classification', 'title'],
  additionalProperties: false,
} as const;

const AUDIT_NAMESPACE = namespace('research.audit');

/**
 * Which audit role this item is, from its stored payload.
 *
 * The payload was validated at enqueue time against a closed set, so this
 * cannot be a value the registry does not know — but it is checked again
 * rather than cast, because a row that predates a registry change would
 * otherwise be read as whatever the code now expects.
 */
function auditRoleOf(item: WorkItem): AuditRole {
  const role = item.payload['role'];
  if (typeof role !== 'string' || !AUDIT_ROLES.includes(role as AuditRole)) {
    throw notFoundError();
  }
  return role as AuditRole;
}

/* ------------------------------------------------------------------------ */
/* The tools                                                                 */
/* ------------------------------------------------------------------------ */

const getAssignmentTool: McpTool = {
  name: 'brain_get_assignment',
  title: 'Read the assignment for claimed work',
  description:
    'The research assignment behind a research work item: the orchestration, this fragment\'s ' +
    'question and every boundary it will be judged against, what its dependencies established, ' +
    'and any checkpoints an earlier attempt left. On a RESEARCH_VERIFY item it also carries ' +
    'claims_to_verify — every claim awaiting a verdict, with its id, its source and its scope. ' +
    'That is where the claim ids come from; you do not need to have submitted them yourself. ' +
    'Read this before researching — the item itself carries none of it. A read, so it does not ' +
    'require the lease; every tool that writes does.',
  inputSchema: {
    type: 'object',
    properties: { work_item_id: { type: 'string' } },
    required: ['work_item_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Read the assignment', ...READ_ONLY },
  run: async (args, { principal }) => {
    const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), 'research:read');
    if (!item) throw notFoundError();
    const view = await assignmentFor(item);
    // An item that is not research work and one whose orchestration is gone get
    // the same answer, and it is the same answer as an item belonging to
    // somebody else. Invariant 23 at this boundary too.
    if (!view) throw notFoundError();
    return { projectId: item.projectId, value: { assignment: view } };
  },
};

const checkpointTool: McpTool = {
  name: 'brain_checkpoint_work',
  title: 'Record progress on claimed work',
  description:
    'Leave a short durable note about where you have got to. The queue is at-least-once: if ' +
    'your lease expires mid-research the item goes to another attempt, which reads these. ' +
    'Notes are bounded and append-only — do not put a source, a credential or a page of ' +
    'fetched text in one.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      note: { type: 'string', description: 'What you have established or ruled out so far.' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'note'],
    additionalProperties: false,
  },
  annotations: { title: 'Record progress', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(
      principal,
      requiredString(args, 'work_item_id'),
      'checkpoints:write',
    );
    if (!item) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);
    const note = requiredString(args, 'note');

    // Not wrapped in Step 6, for the same reason a heartbeat is not: there is
    // no effect to duplicate. A checkpoint is an append to an append-only
    // table, and a repeated note is a repeated note — visible, harmless, and
    // cheaper to allow than to reserve an operation record for.
    try {
      const result = await checkpointWork(proof, note);
      if (!result.ok) throw notFoundError();
    } catch (error) {
      if (error instanceof TooManyCheckpoints) throw conflictError(error.message);
      throw error;
    }

    return {
      projectId: item.projectId,
      value: { workItemId: item.id, checkpoints: (await listCheckpoints(item.id)).length },
    };
  },
};

const proposeFragmentsTool: McpTool = {
  name: 'brain_propose_fragments',
  title: 'Propose the fragments for an assignment',
  description:
    'Decompose the assignment into bounded fragments. A fragment is one question you could ' +
    'actually answer, with the boundaries that make an answer checkable: geography, timeframe, ' +
    'population, definitions, the evidence lanes it needs, what may and may not be cited, what ' +
    'done means, and how many independent sources it takes. A fragment missing those cannot be ' +
    'judged and is refused here. Proposals only — nothing is researched until a person approves.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      rationale: { type: 'string', description: 'Why this decomposition and not another.' },
      fragments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Stable handle, e.g. market-size-us-2023.' },
            question: { type: 'string' },
            geography: { type: 'string' },
            timeframe: { type: 'string' },
            population: { type: 'string' },
            definitions: { type: 'string' },
            required_evidence: { type: 'array', items: { type: 'string' } },
            acceptable_source_types: { type: 'array', items: { type: 'string' } },
            excluded_source_types: { type: 'array', items: { type: 'string' } },
            completion_criteria: { type: 'array', items: { type: 'string' } },
            depends_on: { type: 'array', items: { type: 'string' } },
            min_independent_sources: { type: 'integer', minimum: 1 },
            why_it_matters: { type: 'string' },
          },
          required: ['key', 'question', 'required_evidence', 'completion_criteria'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'fragments'],
    additionalProperties: false,
  },
  annotations: { title: 'Propose fragments', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const { item, orchestration } = await resolveResearch(
      principal,
      args,
      'research:propose',
      'RESEARCH_PLAN',
    );
    const proof = proofFrom(args, item.id, workerId);
    const rows = objectArray(args, 'fragments', MAX_FRAGMENTS_PER_PLAN);

    const keys = new Set<string>();
    const proposed = rows.map((row, index) => {
      const where = `fragments[${index}]`;
      const key = str(row, 'key', where, 64);
      if (keys.has(key)) throw invalidInput(`${where}.key duplicates an earlier fragment.`);
      keys.add(key);

      const requiredEvidence = strList(row, 'required_evidence', where);
      const completionCriteria = strList(row, 'completion_criteria', where);
      // The two declarations the gate cannot work without. A fragment with no
      // lanes has nothing to cover and a fragment with no completion criteria
      // has no standard to be judged against, so both would be accepted
      // vacuously — which is the one outcome worse than being rejected.
      if (requiredEvidence.length === 0) {
        throw invalidInput(`${where}.required_evidence must name at least one evidence lane.`);
      }
      if (completionCriteria.length === 0) {
        throw invalidInput(`${where}.completion_criteria must say what done means.`);
      }

      const minSources = row['min_independent_sources'];
      if (minSources !== undefined && minSources !== null) {
        if (typeof minSources !== 'number' || !Number.isInteger(minSources) || minSources < 1) {
          throw invalidInput(`${where}.min_independent_sources must be an integer of at least 1.`);
        }
      }

      return {
        key,
        question: str(row, 'question', where, MAX_CLAIM_CHARS),
        geography: maybeStr(row, 'geography', where, MAX_LIST_ITEM_CHARS),
        timeframe: maybeStr(row, 'timeframe', where, MAX_LIST_ITEM_CHARS),
        population: maybeStr(row, 'population', where, MAX_LIST_ITEM_CHARS),
        definitions: maybeStr(row, 'definitions', where, MAX_CLAIM_CHARS),
        requiredEvidence,
        acceptableSourceTypes: strList(row, 'acceptable_source_types', where),
        excludedSourceTypes: strList(row, 'excluded_source_types', where),
        completionCriteria,
        dependsOn: strList(row, 'depends_on', where),
        minIndependentSources: typeof minSources === 'number' ? minSources : 2,
        whyItMatters: maybeStr(row, 'why_it_matters', where, MAX_CLAIM_CHARS),
      };
    });

    // A dependency on a fragment nobody proposed cannot be satisfied and would
    // leave the packet permanently waiting, so it is caught now rather than
    // discovered when the runner cannot order the work.
    for (const fragment of proposed) {
      for (const dependency of fragment.dependsOn) {
        if (!keys.has(dependency)) {
          throw invalidInput(
            `Fragment "${fragment.key}" depends on "${dependency}", which is not in this plan.`,
          );
        }
        if (dependency === fragment.key) {
          throw invalidInput(`Fragment "${fragment.key}" depends on itself.`);
        }
      }
    }

    /**
     * And no cycles.
     *
     * The check above catches a dependency on a fragment nobody proposed and a
     * fragment depending on itself. It does not catch two that each wait on the
     * other, or any longer ring — every key exists, nothing is self-referential,
     * and not one of them can ever start. The runner would order none of them,
     * they would sit QUEUED, and the packet would report fragments in progress
     * that no worker can ever be handed.
     *
     * The push path has always refused this: `planDependencies` reports cycles
     * rather than breaking them arbitrarily, because picking one to go first
     * hides a planning mistake. The worker path never called it. That is the
     * same shape as §13's coverage check — a rule one path had and the other
     * did not — and the fix is to call the existing function rather than write
     * a second opinion about what a cycle is.
     */
    const graph = planDependencies(
      proposed.map((fragment, index) => ({
        fragmentKey: fragment.key,
        dependsOn: fragment.dependsOn,
        priority: 5,
        fragmentIndex: index,
      })),
    );
    if (graph.cycles.length > 0) {
      const rings = graph.cycles.map((cycle) => cycle.join(' -> ')).join('; ');
      throw invalidInput(
        `This plan has a dependency cycle: ${rings}. Each fragment in a ring waits for the ` +
          'next, so none of them can ever start. Decide which question is answerable on its ' +
          'own and make the others depend on it.',
      );
    }

    /**
     * A fragment that names a sibling has to declare it.
     *
     * Prose and declaration are read by different things. The runner orders
     * work from `depends_on`; the researcher is handed the question. So a
     * question reading "the licence identified in ca-licence-trigger" with an
     * empty `depends_on` produces a fragment that *says* it builds on another
     * and is scheduled as though it does not — researched in the same wave,
     * with none of that fragment's accepted claims in its assignment, free to
     * reach a different answer than the sibling it cites.
     *
     * This is not a style rule. It happened on the first real packet: five
     * penalty fragments each named their state's trigger fragment in the
     * question, the plan was approved, and all twelve went ready at once.
     * Nothing was wrong with any single declaration, which is exactly why
     * nothing caught it.
     *
     * Refused rather than inferred. Adding the dependency here would be the
     * Brain deciding what the plan meant, and a fragment's declarations are
     * what its gate is applied against — they have to be the author's.
     */
    for (const fragment of proposed) {
      const declared = new Set(fragment.dependsOn);
      for (const sibling of keys) {
        if (sibling === fragment.key || declared.has(sibling)) continue;
        if (!fragment.question.includes(sibling)) continue;
        throw invalidInput(
          `Fragment "${fragment.key}" names "${sibling}" in its question but does not list it in ` +
            'depends_on. The runner orders work from depends_on and the researcher reads the ' +
            'question, so as written this fragment would be researched alongside the one it says ' +
            'it builds on, without its findings. Declare the dependency, or ask the question ' +
            'without naming the other fragment.',
        );
      }
    }

    const rationale = optionalString(args, 'rationale') ?? '';

    const outcome = await idempotentEffect(
      {
        namespace: PLAN_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        payload: { workItemId: item.id, operation: 'propose-fragments' },
      },
      async () => {
        const passId = await recordPass({
          orchestration,
          fragmentId: null,
          passKey: 'PLAN',
          ordinal: 1,
          attempt: orchestration.attempt,
          workerId,
          assignment: orchestration.assignment,
          raw: { rationale, fragments: proposed },
        });

        // §13, on this path too. Until now a proposal arriving here became
        // research without anybody asking what the project already held, so a
        // worker-run packet could spend the allowance re-establishing a fact
        // sitting in the archive. The decider is the same one the in-process
        // orchestrator uses; nothing here judges coverage itself.
        const coverage = await coverProposal({
          orchestration,
          proposed: proposed.map((fragment) => ({
            key: fragment.key,
            question: fragment.question,
            geography: fragment.geography,
            timeframe: fragment.timeframe,
            population: fragment.population,
            definitions: fragment.definitions,
            requiredEvidence: fragment.requiredEvidence,
            completionCriteria: fragment.completionCriteria,
            whyItMatters: fragment.whyItMatters,
          })),
        });
        const decisionFor = new Map(
          coverage.decisions.map((decision) => [decision.fragmentKey, decision]),
        );
        const toResearch = proposed.filter(
          (fragment) => decisionFor.get(fragment.key)?.needsResearch !== false,
        );

        const created = await createFragments(
          toResearch.map((fragment, index) => {
            const decision = decisionFor.get(fragment.key);
            return {
              orchestrationId: orchestration.id,
              projectId: orchestration.projectId,
              layerId: orchestration.layerId,
              fragmentIndex: index,
              fragmentKey: fragment.key,
              question: fragment.question,
              geography: fragment.geography,
              timeframe: fragment.timeframe,
              population: fragment.population,
              definitions: fragment.definitions,
              requiredEvidence: fragment.requiredEvidence,
              acceptableSourceTypes: fragment.acceptableSourceTypes,
              excludedSourceTypes: fragment.excludedSourceTypes,
              completionCriteria: fragment.completionCriteria,
              dependsOn: fragment.dependsOn,
              minIndependentSources: fragment.minIndependentSources,
              whyItMatters: fragment.whyItMatters,
              // What the archive already has that bears on this fragment, and
              // why it was not enough. A fragment that survives coverage
              // should say what it is adding to rather than start from
              // nothing — that is the difference between new evidence and a
              // second copy of the old evidence.
              ...(decision
                ? {
                    requirementIds: [decision.requirementId],
                    existingClaimIds: decision.claimIds,
                    whyExistingInsufficient: decision.reasons.join(' ') || null,
                  }
                : {}),
              // PLANNED, and it stays PLANNED. Nothing here queues research: a
              // browser-initiated run is planned in full and then stops until a
              // person approves it, which is §16 and is not negotiable by the
              // thing doing the proposing.
              status: 'PLANNED' as const,
            };
          }),
        );

        const answered = coverage.alreadyAnswered.map((decision) => ({
          fragmentKey: decision.fragmentKey,
          status: decision.status,
          why: whyNotResearched(decision),
          claimIds: decision.claimIds,
        }));

        // Every fragment answered by the archive is the best outcome this
        // module has, and it must not be reported through the branch that
        // means "nothing cleared the gate". The packet ends here, terminally,
        // saying why — there is nothing for a person to approve and nothing
        // for a worker to research.
        if (created.length === 0) {
          await updateOrchestration(orchestration.id, {
            status: 'CANCELLED',
            cancelReason:
              answered.length > 0
                ? `The project already answers all ${answered.length} proposed fragment(s).`
                : 'No fragment was proposed.',
            cancelledAt: new Date().toISOString(),
          });
          return {
            resultRef: passId,
            resultSummary: `${answered.length} fragments already answered by the archive`,
            value: {
              proposed: 0,
              fragmentKeys: [] as string[],
              alreadyAnswered: answered,
              archive: {
                documentsRead: coverage.documentsRead,
                documentsUnreadable: coverage.documentsUnreadable,
                existingClaims: coverage.existingClaims,
              },
              status: 'NOTHING_TO_RESEARCH',
            },
          };
        }

        await updateOrchestration(orchestration.id, { status: 'PLANNING', currentPass: 'PLAN' });

        return {
          resultRef: passId,
          resultSummary: `${created.length} fragments proposed`,
          value: {
            proposed: created.length,
            fragmentKeys: created.map((fragment) => fragment.fragmentKey),
            alreadyAnswered: answered,
            archive: {
              documentsRead: coverage.documentsRead,
              documentsUnreadable: coverage.documentsUnreadable,
              existingClaims: coverage.existingClaims,
            },
            status: 'AWAITING_APPROVAL',
          },
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const submitClaimsTool: McpTool = {
  name: 'brain_submit_claims',
  title: 'Submit a fragment\'s claims',
  description:
    'Record what you found for one fragment. Every claim is stored UNACCEPTED — the Brain\'s ' +
    'evidence gate decides what counts, not you, and it decides once. Send the claims you ' +
    'actually have, including ones you could not source: an unsourced claim is stored, marked ' +
    'and excluded from the synthesis, and omitting it makes the ledger look better than the ' +
    'research was. One submission per work item; a redelivery replays it rather than adding to it.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'One material assertion, stated plainly.' },
            claim_type: { type: 'string', enum: [...CLAIM_TYPES] },
            source_url: { type: 'string' },
            source_title: { type: 'string' },
            source_publisher: { type: 'string' },
            source_date: { type: 'string' },
            evidence_excerpt: { type: 'string', description: 'The passage, quoted.' },
            evidence_locator: { type: 'string', description: 'Page, section, table.' },
            evidence_lane: { type: 'string', description: 'Which required lane this fills.' },
            retrieved_at: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            primary_source: { type: 'boolean', description: 'The body that produced the data.' },
            searched_repositories: { type: 'array', items: { type: 'string' } },
            derived: { type: 'boolean' },
            derived_from: { type: 'array', items: { type: 'string' } },
          },
          required: ['claim'],
          additionalProperties: false,
        },
      },
      search_queries: { type: 'array', items: { type: 'string' } },
      unresolved: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'claims'],
    additionalProperties: false,
  },
  annotations: { title: 'Submit claims', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const { item, orchestration, fragment } = await resolveResearch(
      principal,
      args,
      'claims:write',
      'RESEARCH_FRAGMENT',
    );
    if (!fragment) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);

    const rows = objectArray(args, 'claims', MAX_CLAIMS_PER_SUBMISSION);
    const claims = rows.map((row, index) => {
      const where = `claims[${index}]`;
      return {
        claim: str(row, 'claim', where, MAX_CLAIM_CHARS),
        claimType: oneOf(row, 'claim_type', where, CLAIM_TYPES, 'SOURCED_FACT'),
        primarySource: bool(row, 'primary_source', where, false),
        searchedRepositories: strList(row, 'searched_repositories', where),
        sourceUrl: maybeStr(row, 'source_url', where, 2048),
        sourceTitle: maybeStr(row, 'source_title', where, MAX_LIST_ITEM_CHARS),
        sourcePublisher: maybeStr(row, 'source_publisher', where, MAX_LIST_ITEM_CHARS),
        sourceDate: maybeStr(row, 'source_date', where, 64),
        evidenceExcerpt: maybeStr(row, 'evidence_excerpt', where, MAX_EXCERPT_CHARS),
        evidenceLocator: maybeStr(row, 'evidence_locator', where, MAX_LIST_ITEM_CHARS),
        retrievedAt: maybeStr(row, 'retrieved_at', where, 64),
        confidence: confidence(row, where),
        evidenceLane: maybeStr(row, 'evidence_lane', where, MAX_LIST_ITEM_CHARS),
        derived: bool(row, 'derived', where, false),
        derivedFrom: strList(row, 'derived_from', where),
      };
    });

    const outcome = await idempotentEffect(
      {
        namespace: CLAIMS_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        // The item and the operation. Not the claims: putting the submission's
        // contents into its identity would make a second attempt with better
        // research look like a different request rather than a repeat, and both
        // ledgers would land.
        payload: { workItemId: item.id, operation: 'submit-claims' },
      },
      async () => {
        const passId = await recordPass({
          orchestration,
          fragmentId: fragment.id,
          passKey: 'TARGETED',
          ordinal: 2,
          attempt: fragment.attempt,
          workerId,
          assignment: fragment.question,
          raw: {
            claims,
            searchQueries: strList(args, 'search_queries', 'search_queries'),
            unresolved: strList(args, 'unresolved', 'unresolved'),
            notes: optionalString(args, 'notes') ?? '',
          },
        });

        const stored = await recordFragmentClaims({
          orchestration,
          fragment,
          passId,
          passKey: 'TARGETED',
          claims,
        });

        await updateFragment(fragment.id, { status: 'VALIDATING' });

        return {
          resultRef: passId,
          resultSummary: `${stored.length} claims recorded, none accepted yet`,
          value: {
            recorded: stored.length,
            // Ids so the verification pass can answer per claim without an
            // index convention that could silently slip by one.
            claims: stored.map((claim) => ({
              claimId: claim.id,
              claim: claim.claim,
              sourced: claim.sourced,
              validationState: claim.validationState,
            })),
            unsourced: stored.filter((claim) => !claim.sourced).length,
            accepted: 0,
            note: 'Stored unaccepted. Call brain_submit_verification to have the gate judge them.',
          },
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const submitVerificationTool: McpTool = {
  name: 'brain_submit_verification',
  title: 'Verify a fragment\'s claims and have them gated',
  description:
    'Answer, per claim, the two questions only somebody who read the source can: does the ' +
    'source directly support the claim, and does its scope match the fragment\'s geography, ' +
    'timeframe, population and definitions. The Brain then applies all seven gate conditions ' +
    'and records which claims are accepted and why the rest were not. Every claim on the ' +
    'fragment needs a verdict — call brain_get_assignment first and answer the ' +
    'claims_to_verify it hands you, which is the full list whether or not you submitted them. ' +
    'Answer honestly — a claim you wave through is one the packet will rest on.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim_id: { type: 'string' },
            supports_claim: { type: 'boolean' },
            geography: { type: 'string', enum: [...SCOPE_MATCH_VALUES] },
            timeframe: { type: 'string', enum: [...SCOPE_MATCH_VALUES] },
            population: { type: 'string', enum: [...SCOPE_MATCH_VALUES] },
            definitions: { type: 'string', enum: [...SCOPE_MATCH_VALUES] },
            contradiction_state: { type: 'string', enum: [...CONTRADICTION_STATES] },
            note: { type: 'string' },
          },
          required: ['claim_id', 'supports_claim', 'geography', 'timeframe', 'population', 'definitions'],
          additionalProperties: false,
        },
      },
      sufficiency: { type: 'string', enum: ['SUFFICIENT', 'INSUFFICIENT'] },
      missing_lanes: { type: 'array', items: { type: 'string' } },
      unresolved_gaps: { type: 'array', items: { type: 'string' } },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'verdicts', 'sufficiency'],
    additionalProperties: false,
  },
  annotations: { title: 'Verify and gate', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const { item, orchestration, fragment } = await resolveResearch(
      principal,
      args,
      'research:write',
      'RESEARCH_VERIFY',
    );
    if (!fragment) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);

    const stored = await listClaimsForFragment(fragment.id);
    const known = new Map(stored.map((claim) => [claim.id, claim]));

    const rows = objectArray(args, 'verdicts', MAX_CLAIMS_PER_SUBMISSION);
    const verifications: ClaimVerification[] = rows.map((row, index) => {
      const where = `verdicts[${index}]`;
      const claimId = str(row, 'claim_id', where, 64);
      // A verdict about a claim that is not in this fragment's ledger is
      // refused rather than ignored, because ignoring it would let a fragment
      // pass with claims nobody actually verified while the response said
      // otherwise.
      if (!known.has(claimId)) {
        throw invalidInput(`${where}.claim_id is not a claim on this fragment.`);
      }
      const scopeMatch: ClaimScopeMatch = {
        geography: oneOf(row, 'geography', where, SCOPE_MATCH_VALUES),
        timeframe: oneOf(row, 'timeframe', where, SCOPE_MATCH_VALUES),
        population: oneOf(row, 'population', where, SCOPE_MATCH_VALUES),
        definitions: oneOf(row, 'definitions', where, SCOPE_MATCH_VALUES),
      };
      return {
        claimId,
        supportsClaim: bool(row, 'supports_claim', where, false),
        scopeMatch,
        note: maybeStr(row, 'note', where, MAX_NOTE_CHARS) ?? '',
        contradictionState: oneOf(
          row,
          'contradiction_state',
          where,
          CONTRADICTION_STATES,
          'UNCHALLENGED',
        ),
      };
    });

    // Every claim needs an answer. A claim with no verdict has not been
    // verified, and the gate would reject it anyway — but silently accepting a
    // partial verification would let a worker choose which of its claims got
    // examined, which is not a choice it should have.
    const answered = new Set(verifications.map((verification) => verification.claimId));
    const unanswered = stored.filter((claim) => !answered.has(claim.id));
    if (unanswered.length > 0) {
      // Name them. The caller holds this item for this fragment and can read
      // every one of these ids out of brain_get_assignment, so listing them
      // discloses nothing it does not already have — and withholding them was
      // half of what made this step uncompletable: a worker was told its answer
      // was short without being told of what.
      throw invalidInput(
        `${unanswered.length} of this fragment's ${stored.length} claims have no verdict. ` +
          'Every claim must be answered. Missing: ' +
          `${unanswered.map((claim) => claim.id).join(', ')}. ` +
          'brain_get_assignment returns all of them as claims_to_verify.',
      );
    }

    const sufficiency = oneOf(args, 'sufficiency', 'sufficiency', ['SUFFICIENT', 'INSUFFICIENT'] as const);
    const missingLanes = strList(args, 'missing_lanes', 'missing_lanes');
    const unresolvedGaps = strList(args, 'unresolved_gaps', 'unresolved_gaps');

    const outcome = await idempotentEffect(
      {
        namespace: VERIFY_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        payload: { workItemId: item.id, operation: 'submit-verification' },
      },
      async () => {
        const passId = await recordPass({
          orchestration,
          fragmentId: fragment.id,
          passKey: 'VERIFICATION',
          ordinal: 3,
          attempt: fragment.attempt,
          workerId,
          assignment: fragment.question,
          raw: { verdicts: verifications, sufficiency, missingLanes, unresolvedGaps },
        });

        // The same function the in-process orchestrator calls. Not a copy of it.
        const gate = await gateFragment({
          fragment,
          verifications,
          sufficiency,
          missingLanes,
          unresolvedGaps,
        });

        return {
          resultRef: passId,
          resultSummary: `${gate.integrity}/${gate.sufficiency}, ${gate.acceptedClaims} accepted`,
          value: {
            integrity: gate.integrity,
            sufficiency: gate.sufficiency,
            acceptedClaims: gate.acceptedClaims,
            rejectedClaims: gate.rejectedClaims,
            independentSources: gate.independentSources,
            coverage: gate.coverage,
            failedConditions: gate.failedConditions,
            duplicateSourceGroups: gate.duplicateSourceGroups,
            reasons: gate.reasons,
            rejections: gate.claims
              .filter((judgement) => !judgement.accepted)
              .map((judgement) => ({
                claimId: judgement.claimId,
                failedCondition: judgement.failedCondition,
                reason: judgement.reason,
              })),
          },
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const reportContradictionTool: McpTool = {
  name: 'brain_report_contradiction',
  title: 'Report that two sources disagree',
  description:
    'Say that two claims disagree, and describe both sides. The Brain classifies the ' +
    'disagreement before calling it a contradiction: a different definition, timeframe, ' +
    'geography or population explains most of them completely and is settled by choosing the ' +
    'scope the assignment asked for. Incompatible figures are never averaged into an answer.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      claim_id: { type: 'string', description: 'The claim being challenged.' },
      conflicting_claim_id: { type: 'string', description: 'The other claim, when it is one.' },
      state: { type: 'string', enum: [...CONTRADICTION_STATES] },
      note: { type: 'string', description: 'What each side says, and on what basis.' },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'claim_id', 'state', 'note'],
    additionalProperties: false,
  },
  annotations: { title: 'Report a contradiction', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(
      principal,
      requiredString(args, 'work_item_id'),
      'contradictions:write',
    );
    if (!item) throw notFoundError();
    if (!item.orchestrationId || !item.fragmentId) throw notFoundError();
    const fragment = await getFragment(item.fragmentId);
    if (!fragment || fragment.orchestrationId !== item.orchestrationId) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);

    const claimId = requiredString(args, 'claim_id');
    const claims = await listClaimsForFragment(fragment.id);
    const claim = claims.find((candidate) => candidate.id === claimId);
    if (!claim) throw notFoundError();

    const otherId = optionalString(args, 'conflicting_claim_id');
    const other = otherId ? claims.find((candidate) => candidate.id === otherId) ?? null : null;
    if (otherId && !other) throw notFoundError();

    const state = oneOf(args, 'state', 'state', CONTRADICTION_STATES);
    const note = requiredString(args, 'note');

    const outcome = await idempotentEffect(
      {
        namespace: CONTRADICTION_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        // One item may report several contradictions, and they are different
        // operations rather than one repeated — so the claim is the
        // discriminator. Still nothing the caller sent about *itself*: it is an
        // id the Brain issued and just verified belongs to this fragment.
        discriminator: `${claimId}${other ? `:${other.id}` : ''}`,
        payload: { workItemId: item.id, operation: 'report-contradiction', claimId },
      },
      async () => {
        // Classified before it is called a contradiction. A worker saying two
        // things disagree is evidence that they differ; whether that is a
        // contradiction or a scope difference is a judgement the Brain makes
        // from both claims' own recorded scopes.
        const classification = other ? classifyContradiction(claim, other) : null;

        await markContradiction(claim.id, state, note);

        return {
          resultRef: claim.id,
          resultSummary: `${claim.id} marked ${state}`,
          value: {
            claimId: claim.id,
            state,
            classification: classification
              ? {
                  kind: classification.kind,
                  // Whether they really cannot both be right, which is a
                  // different question from whether they differ.
                  material: classification.material,
                  reason: classification.reason,
                  resolutionQuestion: classification.resolutionQuestion,
                }
              : null,
          },
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const reportBlockerTool: McpTool = {
  name: 'brain_report_blocker',
  title: 'Report that a fragment cannot be answered',
  description:
    'Say that this fragment cannot be researched as specified, and exactly why: the sources do ' +
    'not exist, the question is ambiguous, the scope is unanswerable, access is refused. This ' +
    'is not a failure — it is a finding, and the Brain uses it to plan a repair rather than ' +
    'retry the same search. Use brain_fail_work for a fault in the work; use this for a fault ' +
    'in the question.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      reason: { type: 'string', description: 'Why this cannot be answered as specified.' },
      searched: {
        type: 'array',
        items: { type: 'string' },
        description: 'Where you looked. A claimed absence is only established by a documented search.',
      },
      suggested_narrowing: { type: 'string', description: 'A question that could be answered.' },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'reason'],
    additionalProperties: false,
  },
  annotations: { title: 'Report a blocker', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(
      principal,
      requiredString(args, 'work_item_id'),
      'blockers:report',
    );
    if (!item) throw notFoundError();
    if (!item.fragmentId) throw notFoundError();
    const fragment = await getFragment(item.fragmentId);
    if (!fragment) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);

    const reason = requiredString(args, 'reason');
    const searched = strList(args, 'searched', 'searched');
    const narrowing = optionalString(args, 'suggested_narrowing');

    const outcome = await idempotentEffect(
      {
        namespace: BLOCKER_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        payload: { workItemId: item.id, operation: 'report-blocker' },
      },
      async () => {
        await updateFragment(fragment.id, {
          status: 'BLOCKED',
          // The reason is kept whole, including where the worker looked. §14's
          // rule about claimed absences applies to a blocked fragment too: "the
          // sources do not exist" means something only when it says where it
          // searched.
          blockedReason: [
            reason,
            searched.length > 0 ? `Searched: ${searched.join('; ')}.` : null,
            narrowing ? `Suggested narrowing: ${narrowing}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' '),
          completedAt: new Date().toISOString(),
        });

        return {
          resultRef: fragment.id,
          resultSummary: 'fragment blocked',
          value: { fragmentId: fragment.id, fragmentKey: fragment.fragmentKey, status: 'BLOCKED' },
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const submitSynthesisTool: McpTool = {
  name: 'brain_submit_synthesis',
  title: 'Submit the packet',
  description:
    'Write the report from the accepted ledgers only. Every claim you rely on must be cited by ' +
    'its claim id, and a citation the Brain cannot resolve to an accepted claim is refused — ' +
    'the whole report, not just that sentence. Rejected claims and blocked fragments contribute ' +
    'nothing; say what is still missing rather than filling the gap.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      report: { type: 'string', description: 'The packet, citing claim ids inline.' },
      cited_claim_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every claim the report relies on. All must be accepted.',
      },
      still_missing: {
        type: 'array',
        items: { type: 'string' },
        description: 'What the packet does not settle, stated plainly.',
      },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'report', 'cited_claim_ids'],
    additionalProperties: false,
  },
  annotations: { title: 'Submit the packet', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const { item, orchestration } = await resolveResearch(
      principal,
      args,
      'research:write',
      'RESEARCH_SYNTHESIZE',
    );
    const proof = proofFrom(args, item.id, workerId);

    const report = requiredString(args, 'report');
    if (report.length > MAX_REPORT_CHARS) {
      throw invalidInput(`report may be at most ${MAX_REPORT_CHARS} characters.`);
    }
    const cited = strList(args, 'cited_claim_ids', 'cited_claim_ids');
    if (cited.length === 0) {
      throw invalidInput('cited_claim_ids must name at least one accepted claim.');
    }
    const stillMissing = strList(args, 'still_missing', 'still_missing');

    // Checked before the operation is reserved, so a report with a bad citation
    // is an argument error the worker can fix and retry — not a poisoned
    // idempotency record that refuses every later attempt on the same item.
    try {
      await assertCitable(orchestration.id, cited);
    } catch (error) {
      if (error instanceof UncitableClaims) throw invalidInput(error.message);
      if (error instanceof NothingToFile) throw conflictError(error.message);
      throw error;
    }

    const outcome = await idempotentEffect(
      {
        namespace: SYNTHESIS_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        payload: { workItemId: item.id, operation: 'submit-synthesis' },
      },
      async () => {
        const passId = await recordPass({
          orchestration,
          fragmentId: null,
          passKey: 'SYNTHESIS',
          ordinal: 4,
          attempt: orchestration.attempt,
          workerId,
          assignment: orchestration.assignment,
          raw: { citedClaimIds: cited, stillMissing, reportChars: report.length },
        });

        const filed = await fileResearchPacket({
          orchestration,
          reportText: report,
          citedClaimIds: cited,
          stillMissing,
          passId,
        });

        return {
          resultRef: filed.documentId ?? passId,
          resultSummary: filed.summary,
          value: filed.value,
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

/* ------------------------------------------------------------------------ */
/* The audit                                                                 */
/* ------------------------------------------------------------------------ */

const getAuditBriefTool: McpTool = {
  name: 'brain_get_audit_brief',
  title: 'Read the brief for an audit role',
  description:
    'The exact brief for the audit role this work item names — primary auditor, adversarial ' +
    'critic, or judge — composed by the Brain from the project\'s audit profile, the layer\'s ' +
    'criteria and the extracted text of the filed packet. The adversarial role also receives ' +
    'what the primary found; the judge receives both. A role whose predecessor has not run is ' +
    'refused rather than improvised.',
  inputSchema: {
    type: 'object',
    properties: { work_item_id: { type: 'string' } },
    required: ['work_item_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Read the audit brief', ...READ_ONLY },
  run: async (args, { principal }) => {
    const { item, orchestration } = await resolveResearch(
      principal,
      args,
      'research:read',
      'RESEARCH_AUDIT',
    );
    const role = auditRoleOf(item);
    try {
      const { brief } = await auditBriefFor({ orchestration, role });
      return { projectId: item.projectId, value: { brief } };
    } catch (error) {
      // Not a NOT_FOUND: the caller is entitled to this item and the reason it
      // cannot be served is about the packet's state, which is something the
      // worker can report rather than guess at.
      if (error instanceof AuditBriefUnavailable) throw conflictError(error.message);
      throw error;
    }
  },
};

const submitAuditTool: McpTool = {
  name: 'brain_submit_audit',
  title: 'Submit one audit role\'s findings',
  description:
    'Record what this audit role concluded. The primary and adversarial roles submit findings; ' +
    'the judge submits the structured verdict, and only the judge\'s output changes anything. ' +
    'The judge is validated strictly: enums must match exactly, the gap counts are recomputed ' +
    'from the gaps you classified and must agree, and an advancing verdict is refused outright ' +
    'while a foundational gap is open. A judgement that fails validation records nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      primary: {
        type: 'object',
        description: 'Required when this item\'s role is PRIMARY.',
        properties: {
          assignment_satisfied: { type: 'string', enum: [...ASSIGNMENT_VERDICTS] },
          requirement_findings: { type: 'array', items: { type: 'string' } },
          structural_findings: { type: 'array', items: { type: 'string' } },
          boundary_findings: { type: 'array', items: { type: 'string' } },
          consistency_findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                relation: { type: 'string', enum: [...CONSISTENCY_RELATIONS] },
                detail: { type: 'string' },
              },
              required: ['relation', 'detail'],
              additionalProperties: false,
            },
          },
          candidate_gaps: { type: 'array', items: GAP_SCHEMA },
          notes: { type: 'string' },
        },
        required: ['assignment_satisfied'],
        additionalProperties: false,
      },
      adversarial: {
        type: 'object',
        description: 'Required when this item\'s role is ADVERSARIAL.',
        properties: {
          attacks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                attack: { type: 'string', description: 'The objection, stated as an objection.' },
                // The field the validator actually reads, and the reason it is
                // an enum rather than the boolean this schema used to declare:
                // "is this attack material" is a judgement with two named
                // outcomes, and a bare true/false loses which one was meant
                // when the answer is later read back out of the pass row.
                //
                // This schema said `material: boolean` and the validator has
                // always required `assessment`. A worker following the schema
                // exactly was refused every time, and the refusal named a
                // field the schema never mentioned — so no worker-driven
                // packet could get past the adversarial pass, and therefore
                // none could ever reach a judge.
                assessment: {
                  type: 'string',
                  enum: ['VALID', 'NOT_MATERIAL'],
                  description: 'VALID if the objection stands; NOT_MATERIAL if it does not bite.',
                },
                reasoning: { type: 'string' },
              },
              required: ['attack', 'assessment', 'reasoning'],
              additionalProperties: false,
            },
          },
          strongest_reason_not_to_advance: { type: 'string' },
        },
        required: ['attacks', 'strongest_reason_not_to_advance'],
        additionalProperties: false,
      },
      judge: {
        type: 'object',
        description: 'Required when this item\'s role is JUDGE. Nothing else changes state.',
        properties: {
          verdict: { type: 'string', enum: [...AUDIT_VERDICTS] },
          summary: { type: 'string' },
          next_action: { type: 'string' },
          gap_classifications: { type: 'array', items: GAP_SCHEMA },
          required_patches: { type: 'array', items: { type: 'string' } },
          other_layer_handoffs: { type: 'array', items: { type: 'string' } },
          blocking_dependencies: { type: 'array', items: { type: 'string' } },
          synthesis_ready: { type: 'boolean' },
          freeze_ready: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          foundational_gap_count: { type: 'integer', minimum: 0 },
          targeted_research_runs_required: { type: 'integer', minimum: 0 },
        },
        required: [
          'verdict',
          'summary',
          'next_action',
          'gap_classifications',
          'foundational_gap_count',
          'targeted_research_runs_required',
        ],
        additionalProperties: false,
      },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Submit audit findings', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const { item, orchestration } = await resolveResearch(
      principal,
      args,
      'research:write',
      'RESEARCH_AUDIT',
    );
    const proof = proofFrom(args, item.id, workerId);
    const role = auditRoleOf(item);

    // The role decides which argument is required, and the wrong one is
    // refused rather than ignored. A judge's verdict arriving on a primary
    // item would otherwise be silently dropped while the response said the
    // submission succeeded.
    const field = role === 'PRIMARY' ? 'primary' : role === 'ADVERSARIAL' ? 'adversarial' : 'judge';
    const payload = args[field];
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw invalidInput(`This work item's role is ${role}, so "${field}" is required.`);
    }
    for (const other of ['primary', 'adversarial', 'judge']) {
      if (other !== field && args[other] !== undefined) {
        throw invalidInput(`This work item's role is ${role}; do not send "${other}".`);
      }
    }

    // Validated by the parser the in-process pipeline uses, on the JSON it
    // would have received. Structured arguments give the client a real schema;
    // routing them through the same validator means there is no second
    // standard for a model's audit output to be judged by. §8's rule about
    // enums, template placeholders and inferred approval holds here because it
    // is literally the same code.
    const json = JSON.stringify(payload);
    const parsed =
      role === 'PRIMARY'
        ? parsePrimaryPass(json)
        : role === 'ADVERSARIAL'
          ? parseAdversarialPass(json)
          : parseJudgePass(json);
    if (!parsed.ok) {
      // An invalid response is an audit failure: nothing is recorded and no
      // state moves. The reason is returned because the worker can act on it.
      throw invalidInput(`The ${role} output is not valid: ${parsed.error}`);
    }

    const outcome = await idempotentEffect(
      {
        namespace: AUDIT_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        discriminator: role,
        payload: { workItemId: item.id, operation: 'submit-audit', role },
      },
      async () => {
        const passId = await recordPass({
          orchestration,
          fragmentId: null,
          passKey: 'AUDIT',
          ordinal: ROLE_PASS_ORDINAL[role],
          attempt: orchestration.attempt,
          workerId,
          assignment: orchestration.assignment,
          raw: payload,
        });

        // The first two roles record and stop. Only the judge advances state,
        // which is §8 and is the whole reason the roles are separate.
        if (role !== 'JUDGE') {
          return {
            resultRef: passId,
            resultSummary: `${role} pass recorded`,
            value: { role, recorded: true, advancesState: false },
          };
        }

        const primaryRaw = await earlierAuditRole(orchestration.id, 'PRIMARY');
        const adversarialRaw = await earlierAuditRole(orchestration.id, 'ADVERSARIAL');
        if (!primaryRaw || !adversarialRaw) {
          throw new TerminalEffectFailure(
            'NOT_AUTHORIZED',
            'The judge cannot record a verdict before the primary and adversarial passes.',
          );
        }
        const primary = parsePrimaryPass(primaryRaw);
        const adversarial = parseAdversarialPass(adversarialRaw);
        if (!primary.ok || !adversarial.ok) {
          throw new TerminalEffectFailure(
            'NOT_AUTHORIZED',
            'An earlier audit pass is not valid, so the judge has nothing sound to weigh.',
          );
        }

        const { context } = await auditBriefFor({ orchestration, role: 'JUDGE' });

        // The same recording path `runDynamicAudit` uses. The cross-checked
        // counts and the refusal to advance a layer with an open foundational
        // gap already happened in parseJudgePass above.
        const recorded = await recordAuditPasses({
          context,
          pipelineId: `pipe_wk_${item.id.slice(-16)}`,
          runId: orchestration.runId,
          mode: 'SINGLE_DOCUMENT',
          primary: primary.value,
          adversarial: adversarial.value,
          judge: parsed.value as JudgePassOutput,
          providerName: 'WORKER',
          model: workerId,
        });

        await updateOrchestration(orchestration.id, {
          status: 'COMPLETE',
          auditId: recorded.audit.id,
          verdict: recorded.audit.verdict,
          completedAt: new Date().toISOString(),
        });
        await recomputeProject(orchestration.projectId);

        return {
          resultRef: recorded.audit.id,
          resultSummary: `audit ${recorded.audit.verdict}`,
          value: {
            role,
            recorded: true,
            advancesState: true,
            auditId: recorded.audit.id,
            verdict: recorded.audit.verdict,
            orchestrationStatus: 'COMPLETE',
          },
        };
      },
    );

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

/** In the order a packet performs them, which is the order they are served in. */
export const RESEARCH_TOOLS: readonly McpTool[] = [
  getAssignmentTool,
  checkpointTool,
  proposeFragmentsTool,
  submitClaimsTool,
  submitVerificationTool,
  reportContradictionTool,
  reportBlockerTool,
  submitSynthesisTool,
  getAuditBriefTool,
  submitAuditTool,
];
