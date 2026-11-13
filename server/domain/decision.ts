/**
 * A decision is reviewed before it is committed, and judged after (§108).
 *
 * The operator states the alternatives it considered, the expected value of
 * each with the evidence and the assumptions behind it, the one it chose, and
 * a prediction — what will be observably true, by when, with what probability.
 * Nothing here limits *which* alternatives it may invent: pricing, structure,
 * segment, channel, financing, geography, fulfilment, allocation or any
 * combination are all free text. What is enforced is the shape of a decision
 * worth recording:
 *
 *   - more than one meaningfully different alternative (a choice of one is not a decision);
 *   - each alternative's probability is a probability, and its value is stated or explicitly unknown;
 *   - the assumptions are named, so a miss can be traced to the one that broke;
 *   - the chosen alternative is the best by expected value, OR the operator says why
 *     not — typically that the information it buys is worth more (an experiment);
 *   - a high-impact or irreversible decision is challenged by a second model before commitment.
 *
 * Pure: no database, no model call.
 */

export const DECISION_KINDS = [
  'PAUSE_GOAL',
  'RESUME_GOAL',
  'SUBMIT_FIX',
  'WITHDRAW_REQUEST',
  'CONTINUE_IDLE',
  'REALLOCATE',
  'CHANGE_STRATEGY',
  'RESEARCH',
  'SWITCH_MODEL',
  'STOP_APPROACH',
  // Hermes evaluates and challenges an accepted cash plan before Brain tells the owner (owner, 2026-11-13).
  'ADOPT_PLAN',
  'OTHER',
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** Kinds whose effect is hard to undo or moves capacity between goals: challenged before commitment. */
export const HIGH_IMPACT_KINDS: readonly DecisionKind[] = ['PAUSE_GOAL', 'SUBMIT_FIX', 'REALLOCATE', 'CHANGE_STRATEGY', 'STOP_APPROACH', 'SWITCH_MODEL', 'ADOPT_PLAN'];
/** A stake at or above this is high impact whatever the kind. */
export const HIGH_IMPACT_USD = 1000;

export interface DecisionOption {
  action: string;
  /** Probability the option achieves its stated value, 0..1. */
  probability: number;
  /** Value in dollars if it works; null when nobody can state it (never read as zero). */
  valueUsd: number | null;
  /** What it costs to try, in dollars (money and priced capacity); null when unknown. */
  costUsd: number | null;
  evidence: string[];
}

export interface DecisionInput {
  kind: DecisionKind;
  goalId: string | null;
  question: string;
  options: DecisionOption[];
  /** Index into `options`. */
  chosen: number;
  assumptions: string[];
  /** Why the chosen option is not the best by expected value, when it is not. */
  whyNotHighestEv: string | null;
  prediction: { outcome: string; probability: number; horizonDays: number };
  irreversible: boolean;
}

export interface ReviewedOption extends DecisionOption {
  expectedValueUsd: number | null;
}

export interface DecisionReview {
  ok: boolean;
  problems: string[];
  options: ReviewedOption[];
  /** Index of the best option by expected value among those with one. */
  bestByEv: number | null;
  highImpact: boolean;
  /** Dollars at stake: the largest stated value. */
  stakeUsd: number | null;
}

const isProbability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

/** Two actions that say the same thing in different case or spacing are one alternative. */
function normal(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function reviewDecision(input: DecisionInput): DecisionReview {
  const problems: string[] = [];
  if (!DECISION_KINDS.includes(input.kind)) problems.push(`kind must be one of ${DECISION_KINDS.join(', ')}`);
  if (!input.question.trim()) problems.push('state the question the decision answers');
  const distinct = new Set(input.options.map((o) => normal(o.action)).filter(Boolean));
  if (input.options.length < 2 || distinct.size < 2) {
    problems.push('consider at least two meaningfully different alternatives (doing nothing counts as one)');
  }
  const options: ReviewedOption[] = input.options.map((o, i) => {
    if (!isProbability(o.probability)) problems.push(`option ${i}: probability must be between 0 and 1`);
    if (o.valueUsd !== null && !Number.isFinite(o.valueUsd)) problems.push(`option ${i}: valueUsd must be a number or null`);
    const ev = o.valueUsd === null || !isProbability(o.probability) ? null : o.probability * o.valueUsd - (o.costUsd ?? 0);
    return { ...o, expectedValueUsd: ev === null ? null : Math.round(ev * 100) / 100 };
  });
  if (!Number.isInteger(input.chosen) || input.chosen < 0 || input.chosen >= input.options.length) problems.push('chosen must index one of the options');
  if (input.assumptions.filter((a) => a.trim()).length === 0) problems.push('name the assumptions the choice rests on, so a miss can be traced to the one that broke');
  if (!isProbability(input.prediction.probability)) problems.push('the prediction needs a probability between 0 and 1');
  if (!input.prediction.outcome.trim()) problems.push('the prediction needs an observable outcome');
  if (!(input.prediction.horizonDays > 0 && input.prediction.horizonDays <= 365)) problems.push('the prediction needs a horizon of 1 to 365 days');
  let bestByEv: number | null = null;
  options.forEach((o, i) => {
    if (o.expectedValueUsd === null) return;
    if (bestByEv === null || o.expectedValueUsd > (options[bestByEv]!.expectedValueUsd ?? -Infinity)) bestByEv = i;
  });
  if (bestByEv !== null && bestByEv !== input.chosen && !(input.whyNotHighestEv ?? '').trim()) {
    problems.push(`option ${bestByEv} has the higher expected value; choose it or say why not (for example the information the chosen one buys)`);
  }
  const values = options.map((o) => o.valueUsd).filter((v): v is number => v !== null);
  const stakeUsd = values.length ? Math.max(...values) : null;
  const highImpact = input.irreversible || HIGH_IMPACT_KINDS.includes(input.kind) || (stakeUsd ?? 0) >= HIGH_IMPACT_USD;
  return { ok: problems.length === 0, problems, options, bestByEv, highImpact, stakeUsd };
}

/** What the challenger must answer; parsed from its JSON. */
export interface Challenge {
  verdict: 'PROCEED' | 'REVISE';
  hiddenAssumptions: string[];
  missingVariables: string[];
  strongerAlternative: string | null;
  reasons: string;
  model: string;
}

export function challengePrompt(input: DecisionInput, review: DecisionReview): string {
  return [
    'You are the challenger inside Brain, an autonomous business operator. Another model is about to commit the decision below.',
    'Attack it: name assumptions it did not state, variables it ignored (price, segment, channel, structure, timing, financing, capacity, dependencies…),',
    'and a stronger alternative if one exists. Say REVISE only for a flaw that would change the choice; otherwise PROCEED.',
    '',
    JSON.stringify({ kind: input.kind, question: input.question, options: review.options, chosen: input.chosen, assumptions: input.assumptions, prediction: input.prediction, whyNotHighestEv: input.whyNotHighestEv }),
    '',
    'Answer with one JSON object: {"verdict":"PROCEED|REVISE","hidden_assumptions":["…"],"missing_variables":["…"],"stronger_alternative":"…|null","reasons":"…"}',
  ].join('\n');
}

export function parseChallenge(json: Record<string, unknown> | null, model: string): Challenge | null {
  if (!json) return null;
  const verdict = String(json['verdict'] ?? '').toUpperCase();
  if (verdict !== 'PROCEED' && verdict !== 'REVISE') return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 8) : []);
  const alt = json['stronger_alternative'];
  return {
    verdict,
    hiddenAssumptions: list(json['hidden_assumptions']),
    missingVariables: list(json['missing_variables']),
    strongerAlternative: typeof alt === 'string' && alt.trim() && alt.trim().toLowerCase() !== 'null' ? alt.slice(0, 400) : null,
    reasons: String(json['reasons'] ?? '').slice(0, 800),
    model,
  };
}
