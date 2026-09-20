/**
 * What owner capital an opening actually requires, after the requirements have
 * been decomposed and the published restructurings applied.
 *
 * ---------------------------------------------------------------------------
 * The headline number is never the answer
 * ---------------------------------------------------------------------------
 *
 * "This business needs $250,000 to start" is a published figure about a
 * *shape* of the business — usually the shape where you own the equipment,
 * lease the property, hire the staff and carry the receivables. The question
 * worth asking is which specific requirement inside that is real for the
 * transaction Brain wants to control, and which of those an industry practice
 * already removes, defers or shifts onto somebody else.
 *
 * So the number here is composed from rows: one per requirement, and a
 * restructuring is a second row naming the requirement it answers. Nothing is
 * summed from prose, no mechanism is assumed to apply, and every entry carries
 * the claim it came from.
 *
 * ---------------------------------------------------------------------------
 * The one rule that decides everything: an unknown withholds the answer
 * ---------------------------------------------------------------------------
 *
 * A requirement whose amount nothing established is `null`, and a set holding
 * one **withholds the minimum entirely** rather than summing the rest. §30
 * records this exact correction at the margin — a figure computed against an
 * unknown cost fails in the direction that makes a piece look worth doing, and
 * that is the shape of error nobody notices because it looks like ambition.
 * Here it would be worse: an understated minimum makes something look
 * executable today, and "executable today" is what starts spending.
 *
 * The same rule catches the tempting half-answer. A restructuring that names
 * no residual is a mechanism that *might* reduce the requirement by an amount
 * nobody published; it is reported as available and it does not lower the
 * number. Only a published residual moves it.
 */
import type { CapitalMechanism, CapitalRequirement, CapitalStructure } from '../../domain/types.ts';

/** Why a minimum could not be stated, when it could not. */
export type CapitalUnknownReason =
  /** Nothing has decomposed this opening's capital at all. */
  | 'NOT_DECOMPOSED'
  /** At least one requirement's amount is not established. */
  | 'AMOUNT_UNKNOWN';

export interface RequirementReading {
  entry: CapitalStructure;
  requirement: CapitalRequirement;
  /** What the source said this costs, before anything is restructured. */
  grossCents: number | null;
  /**
   * What the owner still funds, after the *best published* residual.
   *
   * Null where the gross is unknown, and equal to the gross where no
   * restructuring published a residual — a mechanism with no number does not
   * reduce anything, however plausible it sounds.
   */
  netCents: number | null;
  /** Every published way of answering it, with its source. */
  restructurings: { entry: CapitalStructure; mechanism: CapitalMechanism }[];
}

export interface CapitalReading {
  opportunityId: string;
  requirements: RequirementReading[];
  /**
   * The minimum owner capital, or null with the reason it is withheld.
   *
   * This is the number the brief actually asks for: what a person has to have
   * to control and execute the transaction, rather than what it costs to own
   * the business that usually does it.
   */
  minimumOwnerCents: number | null;
  unknown: CapitalUnknownReason | null;
  /** How much of the gross the published restructurings actually remove. */
  removedCents: number | null;
  /** Mechanisms found here, so "how is this made capital-light" is readable. */
  mechanisms: CapitalMechanism[];
}

export function readCapital(
  opportunityId: string,
  entries: readonly CapitalStructure[],
): CapitalReading {
  const requirements = entries.filter(
    (one): one is CapitalStructure & { requirement: CapitalRequirement } =>
      one.entryKind === 'REQUIREMENT' && one.requirement !== null,
  );
  const restructurings = entries.filter(
    (one): one is CapitalStructure & { mechanism: CapitalMechanism } =>
      one.entryKind === 'RESTRUCTURING' && one.mechanism !== null,
  );

  const byAnswered = new Map<string, (CapitalStructure & { mechanism: CapitalMechanism })[]>();
  for (const one of restructurings) {
    if (!one.answersId) continue;
    byAnswered.set(one.answersId, [...(byAnswered.get(one.answersId) ?? []), one]);
  }

  const readings: RequirementReading[] = requirements.map((entry) => {
    const answers = byAnswered.get(entry.id) ?? [];
    /*
     * The best *published* residual, and nothing else.
     *
     * A mechanism whose residual is null is available and moves no number.
     * Choosing the lowest published residual is the one place this function
     * chooses at all, and it is chosen rather than averaged because the
     * residuals are alternatives: you use one structure, not the mean of
     * three. It can never exceed the gross, because a restructuring that made
     * a requirement more expensive is not a restructuring of it.
     */
    const residuals = answers
      .map((one) => one.residualCents)
      .filter((one): one is number => one !== null);
    const gross = entry.amountCents;
    const best = residuals.length > 0 ? Math.min(...residuals) : null;
    const net =
      gross === null ? null : best === null ? gross : Math.min(gross, Math.max(0, best));
    return {
      entry,
      requirement: entry.requirement,
      grossCents: gross,
      netCents: net,
      restructurings: answers.map((one) => ({ entry: one, mechanism: one.mechanism })),
    };
  });

  const mechanisms = [...new Set(restructurings.map((one) => one.mechanism))].sort();

  if (readings.length === 0) {
    return {
      opportunityId,
      requirements: readings,
      minimumOwnerCents: null,
      unknown: 'NOT_DECOMPOSED',
      removedCents: null,
      mechanisms,
    };
  }
  if (readings.some((one) => one.netCents === null)) {
    return {
      opportunityId,
      requirements: readings,
      minimumOwnerCents: null,
      unknown: 'AMOUNT_UNKNOWN',
      removedCents: null,
      mechanisms,
    };
  }

  const gross = readings.reduce((total, one) => total + (one.grossCents ?? 0), 0);
  const net = readings.reduce((total, one) => total + (one.netCents ?? 0), 0);
  return {
    opportunityId,
    requirements: readings,
    minimumOwnerCents: net,
    unknown: null,
    removedCents: Math.max(0, gross - net),
    mechanisms,
  };
}

/**
 * The bands a preserved opening is filed under, so "what becomes possible at
 * the next level" is a question with an answer.
 *
 * These are **presentation**, and the distinction matters. Nothing is ever
 * refused or admitted because of a band: `executableNow` compares the derived
 * minimum against the deployable cash in `cash_money_entries`, which is a
 * measured figure rather than a bucket. The bands exist so a person can ask
 * "what is waiting one tier up" and get a grouped answer instead of a list of
 * numbers — and so that an opening rejected today is filed rather than lost.
 */
export const CAPITAL_TIERS = [
  { id: 'T0', label: 'under $5k', ceilingCents: 500_000 },
  { id: 'T1', label: '$5k–$25k', ceilingCents: 2_500_000 },
  { id: 'T2', label: '$25k–$100k', ceilingCents: 10_000_000 },
  { id: 'T3', label: '$100k–$500k', ceilingCents: 50_000_000 },
  { id: 'T4', label: '$500k–$2M', ceilingCents: 200_000_000 },
  { id: 'T5', label: 'over $2M', ceilingCents: null },
] as const;
export type CapitalTierId = (typeof CAPITAL_TIERS)[number]['id'];

export function tierFor(minimumOwnerCents: number | null): CapitalTierId | null {
  if (minimumOwnerCents === null) return null;
  for (const tier of CAPITAL_TIERS) {
    if (tier.ceilingCents === null || minimumOwnerCents < tier.ceilingCents) return tier.id;
  }
  return 'T5';
}

/**
 * Is this executable with the money that is actually available?
 *
 * Three answers rather than two, and the third is the point. `UNKNOWN` is what
 * an undecomposed opening gets, and it must never read the same as `NO` — one
 * says the capital has been established and is out of reach, the other says
 * nobody has looked. Their remedies are opposite: the first waits for money,
 * the second waits for a question. §30's rule that we-could-not-tell must
 * never read the same as we-checked, at the number that starts spending.
 */
export function executableNow(
  reading: CapitalReading,
  deployableCents: number,
): 'YES' | 'NO' | 'UNKNOWN' {
  if (reading.minimumOwnerCents === null) return 'UNKNOWN';
  return reading.minimumOwnerCents <= deployableCents ? 'YES' : 'NO';
}

/**
 * The openings a change in available cash has just brought within reach.
 *
 * Derived rather than hooked to the moment money arrives, which is the fourth
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. An
 * opening whose minimum was established months ago becomes executable the
 * instant the balance crosses it, with nothing having to notice.
 */
export function reactivated(
  readings: readonly CapitalReading[],
  wasDeployableCents: number,
  nowDeployableCents: number,
): CapitalReading[] {
  if (nowDeployableCents <= wasDeployableCents) return [];
  return readings.filter(
    (one) =>
      one.minimumOwnerCents !== null &&
      one.minimumOwnerCents > wasDeployableCents &&
      one.minimumOwnerCents <= nowDeployableCents,
  );
}
