import type { CoachModel } from './llm.ts';

/**
 * The tutor, independent of any one game. A game supplies a TutorKit — how to make its state
 * viewer-safe, describe it, and explain it without a model — and the tutor adds the optional
 * model on top, always under the same constraints:
 *   - it sees only the viewer-safe state the kit produced;
 *   - a recommendation must name an action id from the current legal set, at the current
 *     revision, or it is discarded;
 *   - strategy is labelled as a recommendation, never as a proven best move;
 *   - when the model is slow, failing or not configured, the engine-grounded answer still stands.
 */
export interface Explanation {
  headline: string;
  points: string[];
  rules: Array<{ number: string; text: string }>;
  source: string;
}

export interface TutorKit {
  viewerSafe(state: Record<string, unknown>): Record<string, unknown>;
  describe(safe: Record<string, unknown>): string;
  legalActionIds(safe: Record<string, unknown>): Map<string, string>;
  options(safe: Record<string, unknown>): Explanation;
  unavailable(safe: Record<string, unknown>, cardId: number): Explanation;
  recent(safe: Record<string, unknown>, sinceSeq: number): Explanation;
  ruleOfThumb(safe: Record<string, unknown>): { actionId: string | null; reason: string; consequence: string };
  explainCard(cardRef: string): Promise<unknown>;
  gameName: string;
}

export type Question = 'options' | 'recommend' | 'why' | 'what-happened' | 'explain-card';

export interface Recommendation {
  actionId: string | null;
  label: string | null;
  reason: string;
  consequence: string;
  alternatives: Array<{ actionId: string; label: string; why: string }>;
  source: 'model' | 'rule-of-thumb';
  revision: number;
}

export interface TutorAnswer {
  question: Question;
  revision: number;
  explanation: Explanation | null;
  card?: unknown;
  recommendation?: Recommendation;
  modelText?: string;
  model: { configured: boolean; label: string; used: boolean; error?: string };
}

const SYSTEM = (game: string) => `You are a patient ${game} tutor helping a player learn their own deck while they play a practice game against a computer opponent.
Rules you must follow:
- Use only the position, cards and legal actions you are given. They are what the player can see; never guess at hidden cards, an opponent's hand, or the order of any library, and never reason from future draws.
- Any action you recommend must be one of the listed legal action ids, exactly as written. If none is sensible, set recommendedActionId to null.
- Strategy is judgment: present a recommendation with its tradeoff, not as a proven best move.
- Keep it short: one recommended action, the reason, and the consequence. Mention a rule number only if it is one you are sure of.`;

const RECOMMEND_SCHEMA = {
  type: 'object',
  properties: {
    recommendedActionId: { type: ['string', 'null'] },
    reason: { type: 'string' },
    consequence: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'object', properties: { actionId: { type: 'string' }, why: { type: 'string' } }, required: ['actionId', 'why'], additionalProperties: false } },
  },
  required: ['recommendedActionId', 'reason', 'consequence', 'alternatives'],
  additionalProperties: false,
};

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' } },
  required: ['explanation'],
  additionalProperties: false,
};

export async function ask(kit: TutorKit, model: CoachModel, state: Record<string, unknown>, q: Question, args: { cardId?: number; sinceSeq?: number; cardRef?: string; coachMode?: string } = {}): Promise<TutorAnswer> {
  const safe = kit.viewerSafe(state);
  const revision = Number(safe.revision ?? 0);
  const legal = kit.legalActionIds(safe);
  const base: TutorAnswer = { question: q, revision, explanation: null, model: { configured: model.configured, label: model.label, used: false } };

  if (q === 'explain-card') {
    base.card = await kit.explainCard(args.cardRef ?? '');
    return base;
  }
  if (q === 'options') base.explanation = kit.options(safe);
  if (q === 'why') base.explanation = kit.unavailable(safe, args.cardId ?? -1);
  if (q === 'what-happened') base.explanation = kit.recent(safe, args.sinceSeq ?? -1);

  if (q === 'recommend') {
    const r = kit.ruleOfThumb(safe);
    base.explanation = kit.options(safe);
    base.recommendation = {
      actionId: r.actionId && legal.has(r.actionId) ? r.actionId : null,
      label: r.actionId ? legal.get(r.actionId) ?? null : null,
      reason: r.reason, consequence: r.consequence, alternatives: [], source: 'rule-of-thumb', revision,
    };
    if (!model.configured) return base;
    try {
      const out = (await model.json(SYSTEM(kit.gameName), `${kit.describe(safe)}\n\nWhat would you recommend I do now, and why?`, RECOMMEND_SCHEMA)) as {
        recommendedActionId: string | null; reason: string; consequence: string; alternatives: Array<{ actionId: string; why: string }>;
      };
      base.model.used = true;
      if (out.recommendedActionId !== null && !legal.has(out.recommendedActionId)) {
        base.model.error = `The model suggested "${out.recommendedActionId}", which is not a legal action in this position, so it was discarded.`;
        return base;
      }
      base.recommendation = {
        actionId: out.recommendedActionId,
        label: out.recommendedActionId ? legal.get(out.recommendedActionId) ?? null : null,
        reason: out.reason, consequence: out.consequence,
        alternatives: out.alternatives.filter((a) => legal.has(a.actionId)).map((a) => ({ actionId: a.actionId, label: legal.get(a.actionId)!, why: a.why })),
        source: 'model', revision,
      };
    } catch (e) {
      base.model.error = String((e as Error).message ?? e);
    }
    return base;
  }

  // Engine-grounded explanation first; the model may add plain-language context on top.
  if (model.configured && base.explanation) {
    try {
      const prompt = `${kit.describe(safe)}\n\nThe player asked: ${q === 'why' ? "Why can't I play this card?" : q === 'options' ? 'What can I do?' : 'What just happened?'}\nThe engine's facts:\n${base.explanation.headline}\n${base.explanation.points.join('\n')}\n\nExplain this to a learning player in 2-4 sentences, without adding facts the engine did not state.`;
      const out = (await model.json(SYSTEM(kit.gameName), prompt, EXPLAIN_SCHEMA)) as { explanation: string };
      base.modelText = out.explanation;
      base.model.used = true;
    } catch (e) {
      base.model.error = String((e as Error).message ?? e);
    }
  }
  return base;
}
