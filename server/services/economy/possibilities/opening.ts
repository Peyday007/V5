/**
 * The capital and cash-deadline screen, applied to a goal's openings before
 * path research spends a research job on one.
 *
 * `screenPossibility` is the code screen. This module is the adapter that lets
 * the real research producer (`goals/pathResearch.ts`) run that screen. It reads
 * an opening's established facts into the screen's `name:value` requirement
 * entries, and reads the goal's own limits into `GoalLimits`. It is pure and
 * reads no rows: the caller hands it what the card already states.
 *
 * Only an established fact counts. A recommendation, an empty value or a text
 * no figure can be read from is absent, and an absent fact HOLDs: it is never
 * read as zero.
 */
import { readMoneyFigures } from '../../cash/figures.ts';
import { readDays } from '../../cash/monetization/commissionPass.ts';
import type { PossibilityRequirements } from '../../../domain/economy.ts';
import { CAPITAL_FACT, PAID_AFTER_FACT, screenPossibility, type GoalLimits, type ScreenResult } from './screen.ts';

/** A card fact as the caller read it: its value and whether it was established. */
export interface OpeningFact {
  value: string | null;
  kind: string;
}

export interface OpeningFacts {
  currency: string;
  /** The card's own peak-funding column, when set. It is what the plan models as capital. */
  peakFundingCents: number | null;
  /** The `requiredCapital` card fact: the most that goes out before any comes back. */
  requiredCapital: OpeningFact | null;
  /** The `timeToFirstCash` card fact: days from start to usable cash. */
  timeToFirstCash: OpeningFact | null;
}

const established = (fact: OpeningFact | null): string | null =>
  fact && fact.value !== null && fact.value.trim() !== '' && fact.kind !== 'RECOMMENDATION' ? fact.value : null;

/** The opening's facts as screen requirements: only what is stated, never a default. */
export function openingRequirements(facts: OpeningFacts): PossibilityRequirements {
  const capital: string[] = [];
  if (facts.peakFundingCents !== null && facts.peakFundingCents >= 0) {
    capital.push(`${CAPITAL_FACT}:${facts.peakFundingCents}`);
  } else {
    const text = established(facts.requiredCapital);
    const figures = text ? readMoneyFigures(text, facts.currency).filter((one) => !one.perUnit) : [];
    if (figures.length > 0) capital.push(`${CAPITAL_FACT}:${Math.max(...figures.map((one) => one.cents))}`);
  }
  const time: string[] = [];
  const timeText = established(facts.timeToFirstCash);
  const days = timeText ? readDays(timeText) : null;
  if (days !== null) time.push(`${PAID_AFTER_FACT}:${days}`);
  return { capital, time };
}

/**
 * The goal's limits as the screen reads them. Before a customer payment has
 * proved the goal, the before-proof ceiling binds when the owner stated one.
 * A limit nobody stated is null, and the screen does not check it.
 */
export function goalLimitsOf(target: {
  capitalCeilingCents: number | null;
  capitalBeforeProofCents: number | null;
  proven: boolean;
  daysLeft: number | null;
}): GoalLimits {
  const capital = !target.proven && target.capitalBeforeProofCents !== null ? target.capitalBeforeProofCents : target.capitalCeilingCents;
  return { capitalLimitCents: capital, cashDeadlineDays: target.daysLeft };
}

/** Screen one opening against its goal: REJECT means no research job is raised for it. */
export function screenOpening(facts: OpeningFacts, limits: GoalLimits): ScreenResult {
  return screenPossibility(openingRequirements(facts), limits);
}
