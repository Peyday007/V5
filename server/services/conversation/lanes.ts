/**
 * One Russell, three speeds — and the decision about which one answers.
 *
 * A three-minute Cowork activation for "what did we decide about Florida" is
 * not a conversation. But a fast model must never be the thing that decides a
 * consequential question, so the split is not a performance tweak: it is a
 * boundary about *authority*, and the lane a turn lands in is decided by what
 * the turn is asking for rather than by how busy the fleet is.
 *
 *   FAST   direct, streamed. Discussion, recall, navigation, explanation,
 *          brainstorming, provisional connections.
 *   DEEP   direct, stronger. Abstraction, conflict, uncertainty, consequence.
 *   WORK   the existing fixed-subscription Routines. Research, planning,
 *          implementation, synthesis, audit, filing, canonical writeback.
 *
 * The interface presents one continuous Russell. There are no separate
 * personalities, and a person is never asked which model they would like.
 *
 * **This module decides nothing about spending and nothing about models.** It
 * returns a lane and its reasons; `spend.ts` decides whether anything may be
 * called and `routing.ts` decides which model. Keeping them apart is what
 * stops "the fast lane" from quietly becoming "whatever is cheapest".
 */

export const LANES = ['FAST', 'DEEP', 'WORK'] as const;
export type Lane = (typeof LANES)[number];

/**
 * The named reasons a turn escalates.
 *
 * A closed vocabulary rather than free text, because these are compared,
 * counted and shown to a person — and because a reason invented at the call
 * site is a reason nobody can act on.
 */
export const ESCALATIONS = [
  'ASKED_TO_DO_WORK',
  'NEW_MAJOR_IDEA',
  'CONFLICTS_WITH_KNOWLEDGE',
  'LOW_CONFIDENCE',
  'HIGH_STAKES',
  'SPENDING_OR_IRREVERSIBLE',
  'COMPLEXITY',
  'ASKED_FOR_DEEP_CHECK',
] as const;
export type Escalation = (typeof ESCALATIONS)[number];

/** Plain words, for the line a person reads when Russell takes longer. */
export const ESCALATION_WORDS: Record<Escalation, string> = {
  ASKED_TO_DO_WORK: 'you asked for something to actually be done',
  NEW_MAJOR_IDEA: 'this looks like a new major idea',
  CONFLICTS_WITH_KNOWLEDGE: 'this conflicts with something already established',
  LOW_CONFIDENCE: 'Russell is not confident enough to answer quickly',
  HIGH_STAKES: 'this is a legal, financial or safety question',
  SPENDING_OR_IRREVERSIBLE: 'this would spend money or cannot be undone',
  COMPLEXITY: 'the conversation has got past what the quick lane handles well',
  ASKED_FOR_DEEP_CHECK: 'you asked for a deeper check',
};

/**
 * What the caller knows about a turn.
 *
 * Every field is either the person's own text or a fact the server already
 * holds. Nothing here is a model's opinion about itself — a fast model that
 * could declare a turn simple could route its way around the boundary.
 */
export interface TurnSignals {
  text: string;
  /** Turns already in this conversation. Complexity accumulates. */
  turnCount: number;
  /** Whether the project has knowledge this turn appears to contradict. */
  conflictsWithKnowledge?: boolean;
  /** Whether the fast lane is even available — no key, no ceiling, no model. */
  fastLaneAvailable: boolean;
}

export interface LaneDecision {
  lane: Lane;
  escalations: Escalation[];
  /** The sentence a person reads when the answer is going to take longer. */
  explanation: string | null;
}

/**
 * Phrases that mean "do something", not "tell me something".
 *
 * Phrases rather than bare verbs, and that distinction was earned: the first
 * version listed `decide`, which sent "what did we decide about the fee?" —
 * a pure recall question, the exact thing the fast lane exists for — to a
 * three-minute Routine activation. A verb is not an instruction; a verb in a
 * request is.
 *
 * The list still errs upward, because the costs are not symmetric. A false
 * positive makes one turn slower. A false negative lets a fast model decide
 * that research has been done.
 */
const WORK_VERBS = [
  'research ',
  'go and find',
  'find out',
  'look into',
  'investigate',
  'remember this',
  'remember that',
  'save this',
  'capture this',
  'decide whether',
  'decide if',
  'you decide',
  'please decide',
  'make a plan',
  'plan out',
  'draw up a plan',
  'implement',
  'build me',
  'build the',
  'start work',
  'kick off',
  'file a',
  'write it up',
];

/**
 * Openers that mean a question about the past.
 *
 * A turn that begins by asking what is already known is recall, whatever verbs
 * appear later in it. This suppresses the work escalation rather than the
 * high-stakes one: "what did we decide about the licence?" is still a legal
 * question and still deserves the stronger lane.
 */
const RECALL_OPENERS = [
  'what did',
  'what do we',
  'what does',
  'what was',
  'what were',
  'what is our',
  'what are our',
  'remind me',
  'do we know',
  'did we',
  'have we',
  'why did',
  'why is',
  'where did',
  'when did',
  'who decided',
];

const HIGH_STAKES = [
  'legal',
  'licence',
  'license',
  'statute',
  'regulation',
  'compliance',
  'liability',
  'tax',
  'contract',
  'safety',
  'medical',
  'privacy',
];

const SPENDING = ['spend', 'pay', 'buy', 'purchase', 'invoice', 'delete', 'irreversible', 'cancel'];

const NEW_IDEA = ['new idea', 'what if we', 'we should also', 'another angle', 'new direction'];

/** An explicit request for the stronger lane. Exact, so it cannot be stumbled into. */
const DEEP_CHECK = ['deep-check this', 'deep check this'];

function mentions(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

/**
 * Which lane answers this turn.
 *
 * Work outranks deep, deep outranks fast, and the fast lane being unavailable
 * sends everything to the work lane rather than to nothing — the Routines were
 * the only path before this existed and they remain the fallback.
 */
export function decideLane(signals: TurnSignals): LaneDecision {
  const escalations: Escalation[] = [];

  if (mentions(signals.text, DEEP_CHECK)) escalations.push('ASKED_FOR_DEEP_CHECK');
  const isRecall = RECALL_OPENERS.some((opener) =>
    signals.text.trim().toLowerCase().startsWith(opener),
  );
  if (!isRecall && mentions(signals.text, WORK_VERBS)) escalations.push('ASKED_TO_DO_WORK');
  if (mentions(signals.text, NEW_IDEA)) escalations.push('NEW_MAJOR_IDEA');
  if (mentions(signals.text, HIGH_STAKES)) escalations.push('HIGH_STAKES');
  if (mentions(signals.text, SPENDING)) escalations.push('SPENDING_OR_IRREVERSIBLE');
  if (signals.conflictsWithKnowledge) escalations.push('CONFLICTS_WITH_KNOWLEDGE');
  // Long conversations drift past what a small model holds together well. The
  // threshold is a judgement and is stated here rather than hidden in a
  // condition, so it can be argued with.
  if (signals.turnCount >= 40) escalations.push('COMPLEXITY');

  const wantsWork = escalations.includes('ASKED_TO_DO_WORK');
  const wantsDeep = escalations.some(
    (escalation) => escalation !== 'ASKED_TO_DO_WORK' && escalation !== 'COMPLEXITY',
  );

  const lane: Lane = wantsWork
    ? 'WORK'
    : !signals.fastLaneAvailable
      ? 'WORK'
      : wantsDeep || escalations.includes('COMPLEXITY')
        ? 'DEEP'
        : 'FAST';

  const explanation =
    lane === 'FAST'
      ? null
      : escalations.length > 0
        ? `This one is taking longer because ${ESCALATION_WORDS[escalations[0]!]}.`
        : 'This one is going through the slower path because the quick one is not available.';

  return { lane, escalations, explanation };
}

/**
 * What the fast lane may never do, whatever it is asked.
 *
 * Listed as data rather than enforced here, because enforcement belongs at each
 * guarded service — a list in this file that some other module remembered to
 * consult would be a policy engine, and §21 already refused to grow one of
 * those. It is here so the contract is written down in one place and can be
 * asserted against.
 */
export const FAST_LANE_MAY_NOT = [
  'declare evidence settled',
  'overwrite canonical knowledge',
  'create or widen authority',
  'authorize spending',
  'perform an irreversible or identity-bearing action',
  'bypass a mission, audit, completion or privacy gate',
] as const;
