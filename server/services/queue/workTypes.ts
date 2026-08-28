/**
 * What kinds of work this queue is allowed to carry.
 *
 * A queue item describes Brain-authorized work. It is never a command to
 * execute, and there is deliberately no work type meaning "run this". A worker
 * that receives an item looks up what that type means in its own code; the
 * payload only parameterises it. Without that rule, an authenticated worker
 * credential plus an enqueue permission would add up to remote shell access,
 * which is not a queue, it is a backdoor.
 *
 * ---------------------------------------------------------------------------
 * Why there is exactly one type in Step 5
 * ---------------------------------------------------------------------------
 *
 * Because of the at-least-once boundary, and not because the list is
 * unfinished.
 *
 * A lease can expire after a worker performed an effect and before it recorded
 * the completion, so the item is redelivered and the effect happens again.
 * Until Step 6 provides idempotency keys and an effect ledger, the only work
 * this queue may carry is work that is safe to perform more than once.
 * `SYNTHETIC_ECHO` is exactly that: it proves claiming, leasing, heartbeating,
 * expiry, fencing and completion end to end against the real deployment, and
 * doing it twice costs nothing and changes nothing.
 *
 * Registering a research or extraction type here before Step 6 exists would
 * mean a redelivered item spending the user's quota a second time. That is the
 * bug this boundary exists to prevent, so the registry stays honest about it.
 *
 * ---------------------------------------------------------------------------
 * Why there is a second one now
 * ---------------------------------------------------------------------------
 *
 * `SYNTHETIC_ECHO` proves the queue and nothing else. It hands a note back, so
 * a worker that never read it would look identical to one that did — which is
 * exactly what you want when the queue is the thing under test, and useless for
 * finding out whether real work flows through.
 *
 * `SUMMARIZE_PASSAGE` is the smallest thing that cannot be faked. The worker
 * has to read the passage and produce something that depends on it. It costs a
 * little of the account's allowance, which is the point: an end-to-end test
 * that spends nothing has not tested the part where spending happens.
 *
 * It stays inside the same boundary. The passage is bounded and travels in the
 * payload, so nothing is fetched, no document is touched and no quota-metered
 * research pipeline runs. Repeating it re-reads the same text for the same
 * answer — the summary may differ in wording, and that changes nothing, because
 * completion is idempotent by work item and a second attempt cannot record a
 * second result. Still safe to perform twice, which is the bar for being in
 * this registry at all.
 *
 * ---------------------------------------------------------------------------
 * Why there are five more now, and why they carry no prompt
 * ---------------------------------------------------------------------------
 *
 * Step 9 is the first real research packet. Its work types are the ones a
 * researcher actually performs: plan the fragments, research one, verify its
 * claims, synthesize the accepted ledgers, audit the packet.
 *
 * Every one of them names **what to research** and never **what to say.** The
 * subject is a row — an orchestration, a fragment — reached through the
 * `orchestration_id` and `fragment_id` columns, and the payload holds almost
 * nothing. That is the same rule this file opens with, applied to the case
 * where it is most tempting to break it.
 *
 * The tempting design was a work type whose payload is a prompt, with the
 * Brain's existing `orchestrator.ts` on the other end and the worker standing
 * in for an `AIProvider`. It would have reused far more code. It is exactly
 * "run this": an enqueue permission plus a prompt-carrying type adds up to
 * *make this borrowed Claude account say anything I want*, which is the abuse
 * the worker design exists to prevent. That the enqueuer is currently a human
 * does not save it — Step 12 moves enqueueing to the Brain, and the rule is
 * about the type.
 *
 * ---------------------------------------------------------------------------
 * Two different reasons redelivery is safe, and they are not the same reason
 * ---------------------------------------------------------------------------
 *
 * Until now every type in here declared that performing it twice was harmless.
 * That is true of an echo and of a summary, and it is emphatically not true of
 * recording a claim ledger.
 *
 * So the field says which guarantee it is, because collapsing them would let a
 * type that only Step 6 makes safe sit in this registry looking like one that
 * is harmless on its own:
 *
 *   HARMLESS   — performing it twice is indistinguishable from once. Nothing
 *                protects it because nothing needs to.
 *   IDEMPOTENT — performing it twice is **prevented**, by a Step 6 operation
 *                keyed from the work item and the operation name. A redelivery
 *                replays the first outcome rather than producing a second.
 *
 * The second one carries an obligation with it: a repair is a *new* fragment
 * row and a *new* work item, never a resubmission against the old one. That is
 * §15 — a retry is not a repair — and it is what makes "one work item, one
 * ledger" the right constraint rather than a limitation.
 */
import type { WorkerScope } from '../../domain/types.ts';

export type RepeatSafety = 'HARMLESS' | 'IDEMPOTENT';

export interface WorkTypeDefinition {
  /** The stable identifier stored in `work_items.work_type`. */
  type: string;
  description: string;
  /** What a worker must hold in the project to be handed one of these. */
  requiredScopes: WorkerScope[];
  defaultMaxAttempts: number;
  /**
   * Validate and normalise the payload. Throwing rejects the enqueue; the
   * returned value is what gets stored, so a type can drop anything it did not
   * ask for rather than storing whatever arrived.
   */
  validate(payload: unknown): Record<string, unknown>;
  /**
   * Why a redelivery of this type is safe. See the header: `HARMLESS` means
   * doing it twice changes nothing, `IDEMPOTENT` means doing it twice is
   * prevented by a Step 6 operation keyed from the work item.
   *
   * There is no third value. A type that is neither does not belong in this
   * registry, because the queue is at-least-once and will hand it out again.
   */
  repeatSafety: RepeatSafety;
  /**
   * The Step 6 operation namespace that makes it idempotent. Required for
   * `IDEMPOTENT` and absent for `HARMLESS`, so a type cannot claim the
   * protection without naming what provides it. `register` enforces the pair.
   */
  operationNamespace?: string;
}

export class InvalidWorkPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkPayload';
  }
}

export class UnknownWorkType extends Error {
  constructor(type: string) {
    super(`"${type}" is not a registered work type.`);
    this.name = 'UnknownWorkType';
  }
}

const MAX_NOTE_CHARS = 500;

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InvalidWorkPayload('A work payload must be an object.');
  }
  return payload as Record<string, unknown>;
}

const REGISTRY = new Map<string, WorkTypeDefinition>();

/**
 * Add a type, and refuse one that claims a guarantee it has not named.
 *
 * The check is here rather than in a test because it is the kind of mistake
 * that would be made while adding a type and noticed months later: declaring
 * `IDEMPOTENT` gets the item redelivered on the assumption that something is
 * suppressing the second effect, and if nothing is, the ledger doubles quietly.
 */
function register(definition: WorkTypeDefinition): void {
  if (definition.repeatSafety === 'IDEMPOTENT' && !definition.operationNamespace) {
    throw new Error(
      `Work type "${definition.type}" declares IDEMPOTENT without naming the ` +
        'Step 6 operation namespace that makes it so.',
    );
  }
  if (definition.repeatSafety === 'HARMLESS' && definition.operationNamespace) {
    throw new Error(
      `Work type "${definition.type}" is HARMLESS and does not need an operation ` +
        'namespace; naming one suggests a guarantee it is not relying on.',
    );
  }
  REGISTRY.set(definition.type, definition);
}

register({
  type: 'SYNTHETIC_ECHO',
  description:
    'Carries a short note and asks a worker to hand it back. Exists to prove the ' +
    'queue contract against the real deployment without spending anything or ' +
    'touching a document. Performing it twice is indistinguishable from once.',
  requiredScopes: ['queue:claim'],
  defaultMaxAttempts: 3,
  repeatSafety: 'HARMLESS',
  validate(payload: unknown): Record<string, unknown> {
    const record = asRecord(payload);
    const note = record['note'];
    if (note !== undefined && typeof note !== 'string') {
      throw new InvalidWorkPayload('"note" must be a string when present.');
    }
    if (typeof note === 'string' && note.length > MAX_NOTE_CHARS) {
      throw new InvalidWorkPayload(`"note" may be at most ${MAX_NOTE_CHARS} characters.`);
    }
    // Only the field this type declares is kept. Anything else a caller sent is
    // dropped rather than stored, so the payload cannot become a place to smuggle
    // data past the size bound or the schema.
    return note === undefined ? {} : { note };
  },
});

const MAX_PASSAGE_CHARS = 4000;

register({
  type: 'SUMMARIZE_PASSAGE',
  description:
    'Carries a short passage and asks a worker to read it and hand back a summary. ' +
    'The first work that makes the worker actually think rather than echo, and the ' +
    'smallest thing that does.',
  requiredScopes: ['queue:claim'],
  defaultMaxAttempts: 3,
  repeatSafety: 'HARMLESS',
  validate(payload: unknown): Record<string, unknown> {
    const record = asRecord(payload);
    const passage = record['passage'];
    if (typeof passage !== 'string' || passage.trim().length === 0) {
      throw new InvalidWorkPayload('"passage" must be a non-empty string.');
    }
    if (passage.length > MAX_PASSAGE_CHARS) {
      throw new InvalidWorkPayload(`"passage" may be at most ${MAX_PASSAGE_CHARS} characters.`);
    }
    const question = record['question'];
    if (question !== undefined && typeof question !== 'string') {
      throw new InvalidWorkPayload('"question" must be a string when present.');
    }
    if (typeof question === 'string' && question.length > MAX_NOTE_CHARS) {
      throw new InvalidWorkPayload(`"question" may be at most ${MAX_NOTE_CHARS} characters.`);
    }
    return question === undefined ? { passage } : { passage, question };
  },
});

/* ------------------------------------------------------------------------- */
/* Research                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The five kinds of research work, in the order one packet performs them.
 *
 * What they have in common is more important than what separates them: none of
 * them carries its subject. The orchestration and the fragment are columns on
 * the work item, and everything about what to research — the question, the
 * geography, the timeframe, the population, the definitions, the evidence lanes,
 * the acceptable and excluded source types, the completion criteria, the
 * independent-source minimum — is read from the fragment row through a scoped
 * tool.
 *
 * That is not indirection for its own sake. The fragment row is the same row
 * `applyGate` reads its bar from, so the declaration a worker is judged against
 * cannot drift from the declaration it was given. A copy in a payload would be
 * a second version of the truth, and the copy is always the one that goes stale.
 *
 * Every one of them is IDEMPOTENT rather than HARMLESS. Recording a claim
 * ledger twice is not harmless; it is prevented, by a Step 6 operation keyed
 * from the work item and the operation name. One work item records one ledger,
 * for good. A second attempt at the same item replays the first outcome, and
 * work that genuinely needs redoing gets a new fragment row and a new item —
 * which is §15, a retry is not a repair.
 */

/** Every research type needs the claim scope; the rest is what it writes. */
function researchScopes(writes: WorkerScope): WorkerScope[] {
  return ['queue:claim', writes];
}

/**
 * Research work has an empty payload, and refuses a non-empty one.
 *
 * Dropping unknown fields silently would be the kinder behaviour and the wrong
 * one. A caller who put the question in the payload has misunderstood where the
 * subject lives, and would find out when the worker researched something the
 * gate was not judging. Refusing says so at enqueue time.
 */
function noPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const keys = Object.keys(record);
  if (keys.length > 0) {
    throw new InvalidWorkPayload(
      'Research work carries no payload — the orchestration and fragment are ' +
        `columns on the item. Remove: ${keys.join(', ')}.`,
    );
  }
  return {};
}

register({
  type: 'RESEARCH_PLAN',
  description:
    'Read the assignment and propose the bounded fragments that would answer it. ' +
    'Proposals only: nothing is researched and nothing is spent until a person ' +
    'approves the plan.',
  requiredScopes: researchScopes('research:propose'),
  defaultMaxAttempts: 3,
  repeatSafety: 'IDEMPOTENT',
  operationNamespace: 'research.plan',
  validate: noPayload,
});

register({
  type: 'RESEARCH_FRAGMENT',
  description:
    'Research one bounded fragment and submit its claims. The claims are stored ' +
    'unaccepted; the gate decides what counts, and the worker never does.',
  requiredScopes: researchScopes('claims:write'),
  defaultMaxAttempts: 2,
  repeatSafety: 'IDEMPOTENT',
  operationNamespace: 'research.claims',
  validate: noPayload,
});

register({
  type: 'RESEARCH_VERIFY',
  description:
    'Read each of one fragment\'s sources and answer the two questions only a ' +
    'reader can: does the source support the claim, and does its scope match. ' +
    'The Brain then applies all seven gate conditions.',
  requiredScopes: researchScopes('research:write'),
  defaultMaxAttempts: 2,
  repeatSafety: 'IDEMPOTENT',
  operationNamespace: 'research.verify',
  validate: noPayload,
});

register({
  type: 'RESEARCH_SYNTHESIZE',
  description:
    'Write the packet from the accepted ledgers only. Every sentence must cite a ' +
    'claim id, and a citation the Brain cannot resolve to an accepted claim is ' +
    'refused rather than footnoted.',
  requiredScopes: researchScopes('research:write'),
  defaultMaxAttempts: 2,
  repeatSafety: 'IDEMPOTENT',
  operationNamespace: 'research.synthesis',
  validate: noPayload,
});

/**
 * The audit's three roles, which are three passes and not three opinions.
 *
 * The role is the one thing a research work item does carry, because it is a
 * parameter of *which pass* rather than a description of what to say — the same
 * distinction the header draws about prompts. It is a closed set, so it cannot
 * become a place to put instructions.
 *
 * Worth stating plainly while there is one connected worker: all three roles are
 * played by the same account. Three separate passes on one account is weaker
 * than three independent readers, and making them independent is Step 11's. The
 * evidence file says so rather than letting the row count imply otherwise.
 */
export const AUDIT_ROLES = ['PRIMARY', 'ADVERSARIAL', 'JUDGE'] as const;
export type AuditRole = (typeof AUDIT_ROLES)[number];

register({
  type: 'RESEARCH_AUDIT',
  description:
    'Perform one role of the primary / adversarial / judge audit over the ' +
    'assembled packet. Only the judge\'s validated structured output may reach ' +
    'recordAudit, and prose never moves state.',
  requiredScopes: researchScopes('research:write'),
  defaultMaxAttempts: 2,
  repeatSafety: 'IDEMPOTENT',
  operationNamespace: 'research.audit',
  validate(payload: unknown): Record<string, unknown> {
    const record = asRecord(payload);
    const role = record['role'];
    if (typeof role !== 'string' || !AUDIT_ROLES.includes(role as AuditRole)) {
      throw new InvalidWorkPayload(
        `"role" must be one of ${AUDIT_ROLES.join(', ')}.`,
      );
    }
    // Refused rather than dropped, unlike the echo and the summary above.
    //
    // Those two keep only the field they declare because the alternative is
    // storing whatever arrived; here the alternative is worse than that. An
    // audit item is the one place a prompt gets near a model, and a caller who
    // put `instructions` in the payload would believe they had steered the
    // auditor. Dropping it silently leaves that belief in place — and leaves a
    // later refactor one line away from making it true.
    const extra = Object.keys(record).filter((key) => key !== 'role');
    if (extra.length > 0) {
      throw new InvalidWorkPayload(
        `An audit item carries a role and nothing else. Remove: ${extra.join(', ')}.`,
      );
    }
    return { role };
  },
});

export function workType(type: string): WorkTypeDefinition {
  const found = REGISTRY.get(type);
  if (!found) throw new UnknownWorkType(type);
  return found;
}

export function listWorkTypes(): WorkTypeDefinition[] {
  return [...REGISTRY.values()];
}

export function isRegisteredWorkType(type: string): boolean {
  return REGISTRY.has(type);
}
