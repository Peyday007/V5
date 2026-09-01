/**
 * The bin surface: how an interchangeable worker gets work and gives it back.
 *
 * Eight tools, and the shape of the set is the point. A worker's entire
 * vocabulary is:
 *
 *     check in · read the manifest · take the next item · heartbeat ·
 *     checkpoint · submit a unit · ask whether it is finished · give it back
 *
 * Nothing in that list names a project, a packet, a topic or a bin. The one
 * tool that hands out work takes **no arguments at all** describing what is
 * wanted, and every tool after it derives the bin from the lease rather than
 * from a parameter. That is what makes the Step 10 isolation properties true by
 * construction: there is no argument through which a worker could reach
 * somebody else's mission, so there is no check that could be forgotten.
 *
 * These are thin wrappers, as §21 requires. Every rule lives in
 * `services/bins/service.ts` and `services/bins/contracts.ts`, which are
 * reachable by the HTTP surface too. A remote protocol that grew its own rules
 * would be a second security model, and the second one is always the weaker.
 */
import { invalidInput, notFoundError } from './errors.ts';
import {
  MUTATING,
  READ_ONLY,
  describeClaimed,
  optionalInteger,
  optionalString,
  requiredString,
  workerOnly,
  type McpTool,
} from './toolkit.ts';
import type { BinProof } from '../repos/bins.ts';
import { describeBin } from '../services/bins/service.ts';
import {
  checkIn,
  checkpoint,
  heartbeat,
  nextItemInBin,
  release,
  requestCompletion,
  submitUnit,
} from '../services/bins/service.ts';
import { WORKER_INSTRUCTIONS, WORKER_INSTRUCTIONS_VERSION } from '../services/bins/workerInstructions.ts';

/**
 * The lease a worker says it holds, taken apart.
 *
 * The bin id, lease id and generation come from the caller and prove nothing on
 * their own — they are matched against the row in a single guarded `UPDATE`.
 * The worker id is the one field that never comes from the caller: it is the
 * authenticated principal, because a worker saying which worker it is would be
 * the whole security model asking the attacker for its own name.
 */
function binProof(args: Record<string, unknown>, workerId: string): BinProof {
  const leaseGeneration = optionalInteger(args, 'lease_generation');
  if (leaseGeneration === null) {
    throw invalidInput('lease_generation is required and must be the integer you were given.');
  }
  return {
    binId: requiredString(args, 'bin_id'),
    leaseId: requiredString(args, 'lease_id'),
    leaseGeneration,
    workerId,
  };
}

/** The refusal for a lease that is no longer yours. Never an error. */
const LOST_THE_BIN = {
  held: false,
  message:
    'You no longer hold this bin. Your lease expired or was superseded and another worker owns ' +
    'it now. This is not a failure and nothing you did was wrong: stop working it, and call ' +
    'brain_check_in for another.',
};

const checkInTool: McpTool = {
  name: 'brain_check_in',
  title: 'Check in for work',
  description:
    'Report for duty. Takes no arguments describing what you want: Brain decides which bin you ' +
    'get and leases exactly one to you, atomically. If nothing is ready you are told so — end ' +
    'the session immediately rather than waiting, because another activation will be started ' +
    'when there is work.',
  inputSchema: {
    type: 'object',
    properties: {
      // Telemetry only, and it says so. Nothing about the assignment depends on
      // it, so a worker that lies here changes nothing but its own audit trail.
      session_ref: {
        type: 'string',
        description: 'Your provider session id, for telemetry. Never used to decide anything.',
      },
      lease_ms: { type: 'integer', minimum: 0, description: 'Requested lease; the server clamps it.' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Check in for work', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const result = await checkIn({
      principal,
      workerId,
      sessionRef: optionalString(args, 'session_ref'),
      leaseMs: optionalInteger(args, 'lease_ms') ?? undefined,
    });

    if (!result.assigned) {
      return {
        value: {
          assigned: false,
          reason: result.reason,
          message:
            'There is no ready bin for you. End the session now — a new worker is activated when ' +
            'work appears, so waiting costs allowance and gains nothing.',
        },
        projectId: null,
      };
    }
    return { value: { assigned: true, ...result.assignment }, projectId: result.assignment.projectId };
  },
};

const manifestTool: McpTool = {
  name: 'brain_bin_manifest',
  title: 'Read the bin manifest',
  description:
    'Re-read the complete manifest for the bin you hold: objective, why it exists, its units and ' +
    'their order, acceptable and excluded sources, the evidence bar, required outputs, what you ' +
    'are authorized and prohibited from doing, the budget, and the stopping conditions.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
    },
    required: ['bin_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Read the bin manifest', ...READ_ONLY },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    const bin = await describeBin(proof.binId);
    // Refused as absent rather than as forbidden: a caller who may not have
    // this bin learns nothing about whether it exists.
    if (!bin || bin.workerId !== workerId || bin.leaseId !== proof.leaseId) throw notFoundError();
    return {
      value: {
        binId: bin.id,
        kind: bin.kind,
        title: bin.title,
        objective: bin.objective,
        rationale: bin.rationale,
        manifest: bin.manifest,
        completionContract: bin.completionContract,
        contractVersion: bin.contractVersion,
        checkpoint: bin.checkpoint,
        attempt: bin.attemptCount,
        maxAttempts: bin.maxAttempts,
        leaseExpiresAt: bin.leaseExpiresAt,
      },
      projectId: bin.projectId,
    };
  },
};

const nextItemTool: McpTool = {
  name: 'brain_bin_next_item',
  title: 'Take the next item in your bin',
  description:
    'Claim the next unit of work inside the bin you hold. You cannot ask for an item in another ' +
    'bin: which bin this searches comes from your lease, not from anything you send. When it ' +
    'returns no item and says the bin has no open work, the bin is drained — call ' +
    'brain_bin_complete.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      lease_ms: { type: 'integer', minimum: 0 },
    },
    required: ['bin_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Take the next item in your bin', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    const result = await nextItemInBin({
      principal,
      workerId,
      proof,
      leaseMs: optionalInteger(args, 'lease_ms') ?? undefined,
    });
    if (!result.held) return { value: LOST_THE_BIN, projectId: null };
    if (result.item === null) {
      return {
        value: {
          held: true,
          item: null,
          binHasOpenWork: result.binHasOpenWork,
          message: result.binHasOpenWork
            ? 'Nothing is claimable yet, but this bin still has open work — something is waiting ' +
              'on a dependency or a backoff. Wait briefly and ask again.'
            : 'This bin is drained. Call brain_bin_complete and Brain will judge it.',
        },
        projectId: null,
      };
    }
    /*
     * With the work type's own description, exactly as `brain_claim_work`
     * hands it over.
     *
     * It was missing here for as long as a bin's items were only ever the
     * deterministic units a manifest declared, where the work type says
     * nothing a worker needs. A research bin hands out `RESEARCH_PLAN`,
     * `RESEARCH_FRAGMENT`, `RESEARCH_VERIFY`, `RESEARCH_SYNTHESIZE` and
     * `RESEARCH_AUDIT`, and a worker that has to guess which of those means
     * which tool learns by being refused — at the cost of an allowance, to
     * find out something the registry already knew.
     */
    return { value: { held: true, item: describeClaimed(result.item) }, projectId: result.item.projectId };
  },
};

const heartbeatTool: McpTool = {
  name: 'brain_bin_heartbeat',
  title: 'Heartbeat your bin lease',
  description:
    'Extend the lease on the bin you hold. Do this every few minutes: an expired lease is ' +
    'assignable work and another worker will take the bin over from your last checkpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      lease_ms: { type: 'integer', minimum: 0 },
    },
    required: ['bin_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Heartbeat your bin lease', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    // Not wrapped in Step 6. A heartbeat has no effect to duplicate: it is a
    // guarded UPDATE moving an expiry forward, and doing it twice is
    // indistinguishable from doing it once.
    const result = await heartbeat(proof, optionalInteger(args, 'lease_ms') ?? undefined);
    if (result.outcome !== 'OK') return { value: LOST_THE_BIN, projectId: null };
    return { value: { held: true, leaseExpiresAt: result.expiresAt }, projectId: null };
  },
};

const checkpointTool: McpTool = {
  name: 'brain_bin_checkpoint',
  title: 'Checkpoint your progress',
  description:
    'Write down what is done and what is next, durably. If your session dies, the worker that ' +
    'takes this bin over reads exactly this — so write it for a stranger, not for yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      done: { type: 'array', items: { type: 'string' }, description: 'What is finished.' },
      next: { type: 'array', items: { type: 'string' }, description: 'What remains.' },
      note: { type: 'string', description: 'Anything the next worker needs to know.' },
    },
    required: ['bin_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Checkpoint your progress', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    const done = Array.isArray(args['done']) ? (args['done'] as unknown[]).map(String) : [];
    const next = Array.isArray(args['next']) ? (args['next'] as unknown[]).map(String) : [];
    const outcome = await checkpoint(proof, {
      done,
      next,
      note: optionalString(args, 'note'),
    });
    if (outcome !== 'OK') return { value: LOST_THE_BIN, projectId: null };
    return { value: { held: true, recorded: true }, projectId: null };
  },
};

const submitUnitTool: McpTool = {
  name: 'brain_bin_submit_unit',
  title: 'Submit a unit result',
  description:
    'Store the answer for one declared unit of your bin. The unit key must be one the manifest ' +
    'declares. Brain recomputes what it can and compares, so a placeholder, a restatement of the ' +
    'input, or the same content submitted for several units will not satisfy the contract. ' +
    'Submitting a unit you have already answered REPLACES your earlier value while you still hold ' +
    'the bin, so if Brain refuses completion because a unit does not match, fix that unit and send ' +
    'it again — the reply says `corrected: true` when it replaced something. Re-sending the same ' +
    'value changes nothing and is reported as already stored.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      unit_key: { type: 'string' },
      value: { type: 'string' },
      work_item_id: { type: 'string' },
    },
    required: ['bin_id', 'lease_id', 'lease_generation', 'unit_key', 'value'],
    additionalProperties: false,
  },
  annotations: { title: 'Submit a unit result', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    const result = await submitUnit({
      workerId,
      proof,
      unitKey: requiredString(args, 'unit_key'),
      value: requiredString(args, 'value'),
      workItemId: optionalString(args, 'work_item_id'),
    });
    if (!result.held) return { value: LOST_THE_BIN, projectId: null };
    if (result.unknownUnit) {
      throw invalidInput(
        'That unit key is not one this bin declares. A result for a unit nobody asked for cannot ' +
          'satisfy the completion contract; read brain_bin_manifest for the declared units.',
      );
    }
    return {
      value: {
        held: true,
        stored: result.stored,
        alreadyStored: result.alreadyStored,
        // Named so a worker can tell "I replaced a wrong value" from "nothing
        // happened". Without it a correction reads identically to a duplicate,
        // which is how one bin spent three attempts stuck on a typo.
        corrected: result.corrected,
      },
      projectId: null,
    };
  },
};

const completeTool: McpTool = {
  name: 'brain_bin_complete',
  title: 'Ask whether the bin is finished',
  description:
    'Ask Brain to judge the bin. This does not finish it — Brain evaluates the bin\'s completion ' +
    'contract against its own durable records and answers. If it refuses, it names exactly which ' +
    'record was missing or wrong; fix that and keep working. Saying you are done is not evidence ' +
    'that you are.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
    },
    required: ['bin_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Ask whether the bin is finished', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    const outcome = await requestCompletion({ workerId, proof });
    if (!outcome.held) return { value: LOST_THE_BIN, projectId: null };
    return {
      value: {
        held: true,
        terminal: outcome.terminal,
        state: outcome.state,
        satisfied: outcome.verdict?.satisfied ?? false,
        disposition: outcome.verdict?.disposition ?? null,
        reasons: outcome.verdict?.reasons ?? [],
        observed: outcome.verdict?.observed ?? {},
        message: outcome.terminal
          ? outcome.state === 'COMPLETE'
            ? 'Brain evaluated the contract and it is satisfied. Call brain_check_in for another bin.'
            : 'This bin needs a person. Stop working it and call brain_check_in for another.'
          : 'Not yet. The reasons above name what is missing. Fix it and ask again.',
      },
      projectId: null,
    };
  },
};

const releaseTool: McpTool = {
  name: 'brain_bin_release',
  title: 'Give the bin back',
  description:
    'Hand the bin back unfinished, so another worker can resume from your checkpoint. Use this ' +
    'when you are running low on allowance. Checkpoint first: a bin left honestly unfinished ' +
    'costs one more activation, and one reported finished when it is not costs far more.',
  inputSchema: {
    type: 'object',
    properties: {
      bin_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      reason: { type: 'string' },
    },
    required: ['bin_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Give the bin back', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const proof = binProof(args, workerId);
    const outcome = await release(proof, optionalString(args, 'reason'));
    if (outcome !== 'OK') return { value: LOST_THE_BIN, projectId: null };
    return { value: { held: false, released: true }, projectId: null };
  },
};

const instructionsTool: McpTool = {
  name: 'brain_worker_instructions',
  title: 'The worker contract',
  description:
    'The standing instructions every Brain worker follows, and the revision they are at. Served ' +
    'from the same source the Routine prompt is copied from, so the two cannot disagree.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'The worker contract', ...READ_ONLY },
  run: async () => ({
    value: { version: WORKER_INSTRUCTIONS_VERSION, instructions: WORKER_INSTRUCTIONS },
    projectId: null,
  }),
};

export const BIN_TOOLS: readonly McpTool[] = [
  checkInTool,
  manifestTool,
  nextItemTool,
  heartbeatTool,
  checkpointTool,
  submitUnitTool,
  completeTool,
  releaseTool,
  instructionsTool,
];
