/**
 * A cheap, deterministic screen of one possibility against one goal's limits.
 *
 * The opportunity-screening campaign owns the full REJECT / HOLD / PRIORITIZE
 * screen. Until its export lands, this is the part the store needs to decide
 * *why a possibility is parked*, and it is injectable: `keepScreened` takes any
 * function of this shape, so the sibling's screen replaces it without a change
 * here. It reads requirement strings and nothing else, and never launches work.
 */
import type { Possibility } from '../../../domain/economy.ts';

export interface GoalLimits {
  /** Most owner capital the goal may put at risk, in cents. Null = not stated. */
  capitalLimitCents: number | null;
  /** Days until the goal's cash deadline. Null = not stated. */
  deadlineDays: number | null;
}

export type ScreenVerdict = 'REJECT' | 'HOLD' | 'PASS';

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** Names the limit or the missing fact. */
  reason: string;
  /** The facts whose change would reopen this; each is a watch key. */
  reopenOn: string[];
}

export type Screen = (p: Pick<Possibility, 'requirements'>, limits: GoalLimits) => ScreenResult;

export const CHANGE_KEYS = Object.freeze({
  capital: 'CAPITAL_CHANGED',
  goalAchieved: 'GOAL_ACHIEVED',
  capability: 'CAPABILITY_ACQUIRED',
  price: 'PRICE_CHANGED',
  relationship: 'RELATIONSHIP_DISCOVERED',
});

/** "$1,200", "1200 usd", "$2.5k" → cents. Null when no figure can be read. */
export function parseCents(text: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k)?/i.exec(text);
  if (!m) return null;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? 1000 : 1) * 100);
}

/** "paid in 45 days", "net 30", "payment after 2 weeks" → days. */
export function parsePaymentDays(text: string): number | null {
  const m = /(?:paid|payment|net)\D{0,12}?(\d+)\s*(day|week|month)?s?/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'day').toLowerCase();
  return n * (unit === 'week' ? 7 : unit === 'month' ? 30 : 1);
}

export const codeScreen: Screen = (p, limits) => {
  const capital = p.requirements.capital ?? [];
  const time = p.requirements.time ?? [];
  const figures = capital.map(parseCents).filter((c): c is number => c !== null);
  const need = figures.length > 0 ? Math.max(...figures) : null;

  if (limits.capitalLimitCents !== null && need !== null && need > limits.capitalLimitCents) {
    return {
      verdict: 'REJECT',
      reason: `Owner capital ${need} cents exceeds the goal's limit of ${limits.capitalLimitCents} cents.`,
      reopenOn: [CHANGE_KEYS.capital],
    };
  }
  const payDays = time.map(parsePaymentDays).filter((d): d is number => d !== null);
  if (limits.deadlineDays !== null && payDays.length > 0 && Math.min(...payDays) > limits.deadlineDays) {
    return {
      verdict: 'REJECT',
      reason: `Paid after ${Math.min(...payDays)} days, past the goal's cash deadline of ${limits.deadlineDays} days.`,
      reopenOn: [CHANGE_KEYS.goalAchieved, CHANGE_KEYS.price],
    };
  }
  const missing: string[] = [];
  if (limits.capitalLimitCents !== null && need === null) missing.push('capital needed');
  if (limits.deadlineDays !== null && payDays.length === 0) missing.push('payment timing');
  if (missing.length > 0) {
    return {
      verdict: 'HOLD',
      reason: `Missing facts: ${missing.join(', ')}.`,
      reopenOn: [CHANGE_KEYS.price, CHANGE_KEYS.relationship],
    };
  }
  return { verdict: 'PASS', reason: 'Within the stated limits.', reopenOn: [] };
};
