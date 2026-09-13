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
  /*
   * A change to a site's code, asked for in the conversation.
   *
   * It proposes and it cannot execute: the whole effect is an unauthorized row
   * a person answers in Needs You. Deliberately *not* carrying a repository —
   * see `software` below.
   */
  'REQUEST_SOFTWARE_CHANGE',
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
  candidate: {
    title: string;
    statement: string;
    /**
     * A candidate this repeats, named by the worker that read both.
     *
     * Shape-checked here and nothing more. Whether the id exists, is in this
     * scope, and is close enough in subject to be the same idea are all
     * questions about rows, so `capture` answers them against rows — and
     * refuses the merge, rather than the proposal, when it disagrees.
     */
    duplicateOf: string | null;
  } | null;
  probe: { question: string; maxLookups: number } | null;
  priority: CandidatePriority | null;
  /**
   * A change to a site's code somebody asked for.
   *
   * No repository, no branch and no paths, on purpose. Which repository a
   * project may change — and which directories inside it — is an authorization
   * that lives in rows a person wrote, and a model naming one would be a model
   * proposing where its own work may reach. The person chooses from the
   * repositories this project was actually given, and the scope comes with the
   * choice.
   */
  software: { title: string; objective: string; expectedOutcome: string } | null;
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
    | 'BAD_DUPLICATE_REFERENCE'
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
  'software',
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
  softwareTitle: 200,
  /*
   * An objective is the contract's own field and the contract has its own
   * minimum; this is only the ceiling. Generous, because an objective that says
   * what should become true in a repository is longer than an idea's statement
   * and truncating one is the outcome §27 records as the worst kind: refused is
   * recoverable, cut in half is reported as success.
   */
  softwareObjective: 4_000,
  softwareOutcome: 2_000,
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
/**
 * The actions a turn can actually carry out.
 *
 * `PROPOSAL_ACTIONS` is what the validator *accepts* and is deliberately not
 * changed by this: a worker that sends one of the others is still parsed, still
 * judged by the same rules, and still refused for the same reasons. What
 * changes is what Brain *asks for*.
 *
 * The four that are missing here — `RUN_PROBE`, `PROMOTE_MISSION`,
 * `PARK_CANDIDATE`, `REJECT_CANDIDATE` — have no consumer anywhere.
 * `performProposal` accepts them and returns without doing anything, and
 * nothing downstream ever reads the proposed action, so there is no queue, no
 * state and no row for a later pass to pick up. They are silently accepted
 * no-ops rather than asynchronous work, and advertising them is how a worker
 * ends up choosing one.
 *
 * That is not hypothetical. On 2026-09-06 the frozen acceptance turn was
 * answered with `RUN_PROBE`, carrying a well-formed probe question. Validation
 * passed, the bin went terminal, the person got 782 characters of answer — and
 * nothing happened. No probe, no candidate, nothing recorded. The manifest had
 * offered an action the platform cannot perform, which is the same defect as
 * enforcing a rule nobody was told, pointing the other way.
 *
 * A probe and a mission are still reachable, by the route that was always
 * intended: capture the idea, let Russell judge it, and let the cycle open a
 * probe for what it judged `EXPLORE` and launch a mission for what it queued.
 * That is a decision Brain makes from its own state rather than one a model
 * asks for, which is §8 at this seam.
 */
export const EXECUTABLE_ACTIONS = [
  'ATTACH_PROJECT',
  'CAPTURE_CANDIDATE',
  'ANSWER_ONLY',
  'ASK_WHICH_PROJECT',
  /*
   * Executable in the sense this list means: something happens, and the person
   * sees it. What happens is a row they must authorize before anything is
   * submitted, spent or run — which is why it can be advertised to a worker at
   * all. The four missing actions are missing because they are accepted and do
   * nothing; this one is here because it does exactly what its name says and no
   * more.
   */
  'REQUEST_SOFTWARE_CHANGE',
] as const satisfies readonly ProposalAction[];

export const REQUIRED_PART: Partial<Record<ProposalAction, string>> = {
  ATTACH_PROJECT: 'projectId',
  CAPTURE_CANDIDATE: 'candidate',
  RUN_PROBE: 'probe',
  PROMOTE_MISSION: 'projectId',
  PARK_CANDIDATE: 'priority',
  REJECT_CANDIDATE: 'reason',
  REQUEST_SOFTWARE_CHANGE: 'software',
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
    let duplicateOf: string | null = null;
    const named = (value as Record<string, unknown>)['duplicateOf'];
    if (named !== undefined && named !== null) {
      // Shape only. A well-formed id that names nothing, or names something in
      // another scope, is refused later by `capture` as a merge that will not
      // happen — not here as a proposal that cannot be acted on, because the
      // rest of the capture is still worth performing.
      if (typeof named !== 'string' || !/^rcn_[0-9a-f]{20}$/.test(named)) {
        return refuse(
          'BAD_DUPLICATE_REFERENCE',
          'the proposal named a duplicate that is not an idea reference',
        );
      }
      duplicateOf = named;
    }
    candidate = { title, statement, duplicateOf };
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

  let software: ValidatedProposal['software'] = null;
  if (body['software'] !== undefined && body['software'] !== null) {
    const value = body['software'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return refuse('MISSING_REQUIRED_PART', 'the proposed software change was not readable');
    }
    const record = value as Record<string, unknown>;
    const title = text(record['title'], FIELD_LIMITS.softwareTitle);
    const objective = text(record['objective'], FIELD_LIMITS.softwareObjective);
    const expectedOutcome = text(record['expectedOutcome'], FIELD_LIMITS.softwareOutcome);
    if (!title || !objective || !expectedOutcome) {
      return refuse(
        'MISSING_REQUIRED_PART',
        'a proposed software change needs a title, an objective and an expected outcome',
      );
    }
    /*
     * Refused rather than trimmed, and refused here rather than at the
     * contract. `submitObjective` has its own minimums and would refuse a
     * two-word objective — at authorization time, in front of a person who has
     * already decided to say yes, on a card that should never have been shown.
     */
    if (objective.length < 12) {
      return refuse(
        'MISSING_REQUIRED_PART',
        'an objective has to say what should become true in the repository',
      );
    }
    if (expectedOutcome.length < 8) {
      return refuse(
        'MISSING_REQUIRED_PART',
        'an expected outcome has to say what a person would see differently afterwards',
      );
    }
    software = { title, objective, expectedOutcome };
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
    REQUEST_SOFTWARE_CHANGE: () => software !== null,
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
      software,
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
