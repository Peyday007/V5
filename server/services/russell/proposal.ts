/**
 * Zero-trust validation of what a model proposes.
 *
 * A Russell turn produces a *proposal*: an answer to show, a project it thinks
 * the conversation is about, an idea it thinks is worth capturing, a probe it
 * thinks is worth running. None of that is a decision, and none of it may reach
 * the database as written.
 *
 * The rule this module exists to enforce is the same one `services/audit/`
 * enforces for a judge's verdict, applied to a conversational turn: **model
 * prose never mutates project state.** Only a schema-validated, allowlisted
 * operation may be proposed at all, every reference is re-resolved against what
 * the *authenticated principal* may see, every enum is matched exactly, and an
 * unknown field or action fails the whole proposal rather than being dropped.
 *
 * Four properties, and each one closes a specific way this could go wrong.
 *
 * **Unknown fails closed, and fails whole.** A proposal carrying an action this
 * version does not know is refused entirely rather than having the unknown part
 * ignored — because ignoring it means acting on a proposal whose author
 * believed something else would also happen.
 *
 * **References are re-resolved, never trusted.** A project id in a proposal is
 * checked with `decideProjectAccess` against the caller. A model that has read
 * a conversation may legitimately name a project; it has no business deciding
 * whether the asker may see it, and an id it invented or remembered from
 * another context must not become an attachment.
 *
 * **An unauthorized reference is absent, not refused.** Same rule as everywhere
 * else: the refusal says the proposal named something it could not use, and
 * never which part of the guess was right.
 *
 * **Text is data.** The conversational answer is stored and displayed and is
 * never interpreted. A passage inside it that reads like an instruction is
 * ordinary text — nothing found in model output, a document, a web page or an
 * adapter row is ever executed.
 */
import { decideProjectAccess } from '../identity/policy.ts';
import { CANDIDATE_PRIORITIES } from '../../domain/types.ts';
import type { CandidatePriority, Principal } from '../../domain/types.ts';

/** The complete set of things a turn may propose. Anything else is refused. */
export const PROPOSAL_ACTIONS = [
  'ANSWER_ONLY',
  'ATTACH_PROJECT',
  'ASK_WHICH_PROJECT',
  'CAPTURE_CANDIDATE',
  'RUN_PROBE',
  'PROMOTE_MISSION',
  'PARK_CANDIDATE',
  'REJECT_CANDIDATE',
] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

/** What the server will accept, after validation. */
export interface ValidatedProposal {
  action: ProposalAction;
  /** Shown to the person. Stored as text and never interpreted. */
  answer: string;
  /** Only ever a project this principal may read. */
  projectId: string | null;
  confidence: number | null;
  /** Why, in words a person reads. */
  reason: string | null;
  candidate: { title: string; statement: string } | null;
  probe: { question: string; maxLookups: number } | null;
  priority: CandidatePriority | null;
}

export interface ProposalRefusal {
  ok: false;
  /** Safe to show and safe to log. Names the rule, never the offending value. */
  reason: string;
  /** Which rule refused, for Brain's own telemetry. */
  code:
    | 'NOT_AN_OBJECT'
    | 'UNKNOWN_ACTION'
    | 'UNKNOWN_FIELD'
    | 'MISSING_ANSWER'
    | 'ANSWER_TOO_LONG'
    | 'BAD_CONFIDENCE'
    | 'BAD_PRIORITY'
    | 'UNRESOLVABLE_REFERENCE'
    | 'MISSING_REQUIRED_PART'
    | 'PROBE_OUT_OF_BOUNDS';
}
export type ProposalResult = { ok: true; proposal: ValidatedProposal } | ProposalRefusal;

/** Every key this version understands. An extra one refuses the proposal. */
const KNOWN_FIELDS = new Set([
  'action',
  'answer',
  'projectId',
  'confidence',
  'reason',
  'candidate',
  'probe',
  'priority',
]);

/**
 * Every length this validator enforces, in one place and exported.
 *
 * They were five magic numbers scattered through the checks, and none of them
 * was stated anywhere the worker could see. Each one refuses a whole proposal
 * when exceeded, so each one is a rule enforced against somebody who was never
 * told it — the same trap that produced `BAD_PRIORITY` and then
 * `MISSING_REQUIRED_PART`, twice, on real turns.
 *
 * Exported so the turn manifest renders them from here. The point is not that
 * an eight-thousand-character answer is likely; it is that the contract a
 * worker is judged against and the contract it is handed are now the same
 * object, so a fourth surprise of this shape has to get past a test first.
 */
export const FIELD_LIMITS = {
  answer: 8_000,
  candidateTitle: 200,
  candidateStatement: 2_000,
  probeQuestion: 500,
  reason: 1_000,
} as const;

/**
 * Which field each action cannot be carried out without.
 *
 * Exported so the turn manifest can *state* the requirement instead of the
 * worker having to infer it — and stated once, here, so the two cannot drift.
 *
 * This is the priority trap again, one level deeper, and it cost a real turn
 * on 2026-09-05: the manifest listed `projectId`, `reason` and `priority` under
 * "optional", which is true in general and false for six specific actions. A
 * worker that read "optional projectId", chose `ATTACH_PROJECT` and left it out
 * was following the manifest exactly, and `validateProposal` refused the whole
 * proposal with `MISSING_REQUIRED_PART`. Only two of the six requirements were
 * written down anywhere the worker could see.
 *
 * An action absent from this map needs nothing beyond `action` and `answer`.
 */
export const REQUIRED_PART: Partial<Record<ProposalAction, string>> = {
  ATTACH_PROJECT: 'projectId',
  CAPTURE_CANDIDATE: 'candidate',
  RUN_PROBE: 'probe',
  PROMOTE_MISSION: 'projectId',
  PARK_CANDIDATE: 'priority',
  REJECT_CANDIDATE: 'reason',
};

/** The hardest bound a proposed probe may name. The envelope narrows further. */
export const MAX_PROPOSED_LOOKUPS = 3;

function refuse(code: ProposalRefusal['code'], reason: string): ProposalRefusal {
  return { ok: false, code, reason };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Validate one proposal against the caller who will act on it.
 *
 * `principal` is not decoration: it is what turns "the model named a project"
 * into "the model named a project this person may open". Passing a different
 * principal than the one whose request produced the turn would be the whole
 * vulnerability, which is why there is no overload without it.
 */
export function validateProposal(input: {
  raw: unknown;
  principal: Principal;
}): ProposalResult {
  const { raw, principal } = input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse('NOT_AN_OBJECT', 'the response was not a structured proposal');
  }
  const body = raw as Record<string, unknown>;

  // Unknown fields refuse the whole proposal rather than being dropped. A
  // proposal whose author believed an extra instruction would take effect is
  // not one to act on halfway.
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) {
      return refuse('UNKNOWN_FIELD', 'the proposal carried a field this version does not accept');
    }
  }

  const action = body['action'];
  if (typeof action !== 'string' || !PROPOSAL_ACTIONS.includes(action as ProposalAction)) {
    // Exact enum matching. No substring, no closest match, no inferred intent —
    // the same rule the audit schema applies to a verdict.
    return refuse('UNKNOWN_ACTION', 'the proposal named an action this version does not perform');
  }

  const answer = text(body['answer'], FIELD_LIMITS.answer);
  if (!answer) {
    return typeof body['answer'] === 'string' && body['answer'].trim().length > FIELD_LIMITS.answer
      ? refuse('ANSWER_TOO_LONG', 'the answer was longer than a turn may be')
      : refuse('MISSING_ANSWER', 'the proposal had nothing to say to the person');
  }

  let confidence: number | null = null;
  if (body['confidence'] !== undefined && body['confidence'] !== null) {
    const value = body['confidence'];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      return refuse('BAD_CONFIDENCE', 'the confidence was not a number between 0 and 100');
    }
    confidence = Math.round(value);
  }

  let priority: CandidatePriority | null = null;
  if (body['priority'] !== undefined && body['priority'] !== null) {
    const value = body['priority'];
    if (typeof value !== 'string' || !CANDIDATE_PRIORITIES.includes(value as CandidatePriority)) {
      return refuse('BAD_PRIORITY', 'the priority was not one this version recognises');
    }
    priority = value as CandidatePriority;
  }

  /*
   * The reference check.
   *
   * Re-resolved against the principal, and an id they may not read is treated
   * exactly like one that does not exist — so a model cannot learn which
   * projects are real by watching how the refusal differs.
   */
  let projectId: string | null = null;
  if (body['projectId'] !== undefined && body['projectId'] !== null) {
    const value = body['projectId'];
    if (typeof value !== 'string' || !decideProjectAccess(principal, value, 'READ').allowed) {
      return refuse(
        'UNRESOLVABLE_REFERENCE',
        'the proposal named a project that could not be used here',
      );
    }
    projectId = value;
  }

  let candidate: ValidatedProposal['candidate'] = null;
  if (body['candidate'] !== undefined && body['candidate'] !== null) {
    const value = body['candidate'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return refuse('MISSING_REQUIRED_PART', 'the proposed idea was not readable');
    }
    const title = text((value as Record<string, unknown>)['title'], FIELD_LIMITS.candidateTitle);
    const statement = text(
      (value as Record<string, unknown>)['statement'],
      FIELD_LIMITS.candidateStatement,
    );
    if (!title || !statement) {
      return refuse('MISSING_REQUIRED_PART', 'a proposed idea needs a title and a statement');
    }
    candidate = { title, statement };
  }

  let probe: ValidatedProposal['probe'] = null;
  if (body['probe'] !== undefined && body['probe'] !== null) {
    const value = body['probe'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return refuse('MISSING_REQUIRED_PART', 'the proposed probe was not readable');
    }
    const question = text((value as Record<string, unknown>)['question'], FIELD_LIMITS.probeQuestion);
    const lookups = (value as Record<string, unknown>)['maxLookups'];
    if (!question) {
      return refuse('MISSING_REQUIRED_PART', 'a proposed probe needs one narrow question');
    }
    if (
      typeof lookups !== 'number' ||
      !Number.isInteger(lookups) ||
      lookups < 1 ||
      lookups > MAX_PROPOSED_LOOKUPS
    ) {
      /*
       * A model may ask for fewer lookups than the ceiling and never for more.
       * This is a *second* bound, not the only one: `permitLookup` counts the
       * observations and refuses past the probe's own limit whatever was
       * proposed, so a value that got past here still cannot spend more.
       */
      return refuse('PROBE_OUT_OF_BOUNDS', `a probe may ask for at most ${MAX_PROPOSED_LOOKUPS} lookups`);
    }
    probe = { question, maxLookups: lookups };
  }

  // Actions that cannot be carried out without the part they act on. Checked
  // after the parts are validated, so the refusal names the missing piece
  // rather than the first thing that happened to be wrong.
  //
  // The *names* live in `REQUIRED_PART` so the bin manifest can state them
  // rather than restate them; the predicates stay here because only this
  // function has the validated values to test. See `REQUIRED_PART`.
  const needs: Partial<Record<ProposalAction, () => boolean>> = {
    ATTACH_PROJECT: () => projectId !== null,
    CAPTURE_CANDIDATE: () => candidate !== null,
    RUN_PROBE: () => probe !== null,
    PROMOTE_MISSION: () => projectId !== null,
    PARK_CANDIDATE: () => priority !== null,
    REJECT_CANDIDATE: () => text(body['reason'], FIELD_LIMITS.reason) !== null,
  };
  const required = needs[action as ProposalAction];
  if (required && !required()) {
    return refuse('MISSING_REQUIRED_PART', 'the proposed action was missing the part it acts on');
  }

  return {
    ok: true,
    proposal: {
      action: action as ProposalAction,
      answer,
      projectId,
      confidence,
      reason: text(body['reason'], FIELD_LIMITS.reason),
      candidate,
      probe,
      priority,
    },
  };
}

/**
 * Does this text look like it is trying to give instructions?
 *
 * Used to **flag**, never to filter. Imported and generated text is untrusted
 * data and is stored as written; the value of noticing an instruction-shaped
 * passage is that the ingestion report and the UI can say so, not that the
 * words get removed. Removing them would destroy the evidence that somebody
 * tried.
 *
 * It is deliberately not a security control. The control is that nothing found
 * inside text is ever executed, which is a property of the code paths above —
 * they act only on `action`, and `action` comes from a closed set.
 */
export function looksLikeInjection(value: string): boolean {
  return [
    /ignore (?:all |any )?(?:previous|prior|above) instructions/i,
    /disregard (?:the )?(?:system|previous) (?:prompt|instructions)/i,
    /you are now\b/i,
    /\bnew instructions?:/i,
    /reveal (?:the )?(?:system prompt|your instructions|secrets?|credentials?)/i,
    /\bgrant (?:me|yourself)\b.*\b(access|permission|admin)/i,
  ].some((pattern) => pattern.test(value));
}
