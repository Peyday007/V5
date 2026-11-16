/**
 * The mootRequests suite's case format: a behavioural scenario, not a fixture.
 *
 * A case is a short script of steps run against the code under test — the real
 * repositories and the real Russell loop (`tick`) — followed by what each
 * person-request must look like once the loop has run. Public cases are
 * `cases.ts`; hidden cases arrive from Brain's database in exactly this JSON
 * shape, so a production failure Hermes saw is added as one more scenario.
 *
 * Names (`m1`, `r1`) are the case's own handles; the harness maps them to the
 * rows it created. Every step goes through an exported operation a person or
 * the loop already performs — park, ask, answer, a mission's own transition,
 * the loop — so a variant is measured on the journey, never on a seam only a
 * test would call.
 */

export const CASE_CLASSES = [
  /** The mission left NEEDS_HUMAN after the person answered and before the loop applied it. */
  'LEFT_BEFORE_RESUME',
  /** The answer waited for a research slot, and the mission left NEEDS_HUMAN meanwhile. */
  'LEFT_WHILE_DEFERRED',
  /** An open, unanswered card whose mission left NEEDS_HUMAN on its own. */
  'LEFT_WHILE_OPEN',
  /** A card an earlier version re-asked after its mission had already left. */
  'REASKED_AFTER_LEAVING',
  /** Several cards on one mission, answered and unanswered, when it leaves. */
  'SEVERAL_CARDS',
  /** Control: the mission still waits, and the card must stay in front of the person. */
  'STILL_WAITING',
  /** Control: the answer applies, and must be carried out rather than withdrawn. */
  'ANSWER_APPLIES',
  /** Control: a card about no mission keeps its own offer. */
  'NOT_ABOUT_A_MISSION',
] as const;
export type CaseClass = (typeof CASE_CLASSES)[number];

/** The mission states a step may move a mission to. */
export const MOVE_TARGETS = ['RUNNING', 'WAITING', 'NEEDS_HUMAN', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type MoveTarget = (typeof MOVE_TARGETS)[number];

/** What a request must read once the scenario has run. */
export const EXPECTATIONS = [
  /** Withdrawn: finished as moot, never put back in front of the person. */
  'WITHDRAWN',
  /** In front of the person: a decision the work still needs. */
  'OPEN',
  /** Carried out (RESUMED). */
  'RESUMED',
  /** Not in front of the person and not waiting to be applied: WITHDRAWN or RESUMED. */
  'SETTLED',
] as const;
export type Expectation = (typeof EXPECTATIONS)[number];

export type Step =
  /** A mission parked at NEEDS_HUMAN on a packet with one planned fragment; `packet` is the packet's status. */
  | { do: 'park'; mission: string; packet?: 'PLANNED' | 'AWAITING_APPROVAL' }
  /** A card (person-request) about `mission`, or about no mission when `mission` is null. */
  | { do: 'ask'; request: string; mission: string | null; resumeKey?: string }
  /** The person answers. A `choice` this Brain does not offer is written as the answer verbatim (an older version's card). */
  | { do: 'answer'; request: string; choice: string }
  /** The mission moves by its own guarded transition, from whatever state it is in. */
  | { do: 'move'; mission: string; to: MoveTarget }
  /** An earlier version's re-ask: the answered card put back OPEN with this recommendation. */
  | { do: 'reopen'; request: string; recommendation?: string }
  /** The mission's research slot is taken and its own hold has lapsed, so a resume defers for a slot. */
  | { do: 'slotFull'; mission: string }
  /** One pass of the Russell loop. */
  | { do: 'tick' };

export interface MootCase {
  id: string;
  class: CaseClass;
  /** One sentence: the production shape this scenario reproduces. */
  note?: string;
  steps: Step[];
  /** Each named request's required end state. */
  expect: Record<string, Expectation>;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Why a value is not a well-formed case, or null. A malformed hidden case scores as a failure, never as a crash. */
export function caseProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const c = value as Partial<MootCase>;
  if (typeof c.id !== 'string' || !c.id) return 'id missing';
  if (!(CASE_CLASSES as readonly string[]).includes(String(c.class))) return `class must be one of ${CASE_CLASSES.join(', ')}`;
  if (!Array.isArray(c.steps) || c.steps.length === 0 || c.steps.length > 40) return 'steps must be 1–40 steps';
  if (!c.expect || typeof c.expect !== 'object' || !Object.keys(c.expect).length) return 'expect must name at least one request';
  const missions = new Set<string>();
  const requests = new Set<string>();
  for (const [i, step] of c.steps.entries()) {
    const s = step as Record<string, unknown>;
    const at = `step ${i + 1}`;
    switch (s['do']) {
      case 'park':
        if (typeof s['mission'] !== 'string' || !NAME.test(s['mission'])) return `${at}: park needs a mission name`;
        if (missions.has(s['mission'])) return `${at}: mission ${s['mission']} parked twice`;
        if (s['packet'] !== undefined && s['packet'] !== 'PLANNED' && s['packet'] !== 'AWAITING_APPROVAL') return `${at}: packet must be PLANNED or AWAITING_APPROVAL`;
        missions.add(s['mission']);
        break;
      case 'ask':
        if (typeof s['request'] !== 'string' || !NAME.test(s['request'])) return `${at}: ask needs a request name`;
        if (requests.has(s['request'])) return `${at}: request ${s['request']} asked twice`;
        if (s['mission'] !== null && (typeof s['mission'] !== 'string' || !missions.has(s['mission']))) return `${at}: ask names a mission no step parked`;
        if (s['resumeKey'] !== undefined && (typeof s['resumeKey'] !== 'string' || s['resumeKey'].length > 120)) return `${at}: resumeKey must be a short string`;
        requests.add(s['request']);
        break;
      case 'answer':
        if (typeof s['request'] !== 'string' || !requests.has(s['request'])) return `${at}: answer names a request no step asked`;
        if (typeof s['choice'] !== 'string' || !/^[A-Z_]{1,40}$/.test(s['choice'])) return `${at}: choice must be a choice key`;
        break;
      case 'move':
        if (typeof s['mission'] !== 'string' || !missions.has(s['mission'])) return `${at}: move names a mission no step parked`;
        if (!(MOVE_TARGETS as readonly string[]).includes(String(s['to']))) return `${at}: to must be one of ${MOVE_TARGETS.join(', ')}`;
        break;
      case 'reopen':
        if (typeof s['request'] !== 'string' || !requests.has(s['request'])) return `${at}: reopen names a request no step asked`;
        if (s['recommendation'] !== undefined && (typeof s['recommendation'] !== 'string' || s['recommendation'].length > 300)) return `${at}: recommendation must be a short string`;
        break;
      case 'slotFull':
        if (typeof s['mission'] !== 'string' || !missions.has(s['mission'])) return `${at}: slotFull names a mission no step parked`;
        break;
      case 'tick':
        break;
      default:
        return `${at}: unknown step "${String(s['do'])}"`;
    }
  }
  for (const [name, want] of Object.entries(c.expect)) {
    if (!requests.has(name)) return `expect names request ${name}, which no step asked`;
    if (!(EXPECTATIONS as readonly string[]).includes(String(want))) return `expect.${name} must be one of ${EXPECTATIONS.join(', ')}`;
  }
  return null;
}
