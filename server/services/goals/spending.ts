/**
 * Whether starting work now keeps to how the goal's owner said its money may be
 * spent: in total, before anything has come in, and per week.
 *
 * The owner's words (2026-10-28): a budget of a few thousand, not spent in
 * three days but over the month, and nothing significant spent before money
 * arrives — proof that it is working comes first, and the rest is the green
 * light. So three limits, each the owner's own and each optional:
 *
 *   * the total the goal may tie up;
 *   * what it may tie up before any verified customer payment has arrived
 *     since the target was set — the test stage;
 *   * what it may newly tie up in any seven days, so the total is spread out.
 *
 * Checked where money would leave — the moment execution begins — against
 * the openings the goal pursues. These only ever refuse: they narrow what the
 * commercial authority already allowed and never grant anything.
 */
import { listLinks, getWorkstream, workstreamsForRef } from '../../repos/register.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { actionsFor } from '../../repos/cashActions.ts';
import { readTarget } from './target.ts';
import type { CashOpportunity } from '../../domain/types.ts';

const WEEK = 7 * 86_400_000;
const IN_FLIGHT = new Set(['EXECUTING', 'DELIVERING']);

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(0)}`;
}

export async function goalSpendingRefusal(input: {
  opportunity: CashOpportunity;
  neededCents: number;
  now?: Date;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  for (const goalId of await workstreamsForRef('OPPORTUNITY', input.opportunity.id)) {
    const goal = await getWorkstream(goalId);
    if (!goal || goal.archivedAt || goal.cancelledAt || !goal.target) continue;
    const target = await readTarget(goal, now);
    if (!target || target.achieved) continue;
    const { capitalCeilingCents: total, capitalBeforeProofCents: beforeProof, capitalPerWeekCents: perWeek, currency } = target;
    if (total === null && beforeProof === null && perWeek === null) continue;

    let tiedUp = 0;
    let thisWeek = 0;
    for (const link of await listLinks(goal.id)) {
      if (link.kind !== 'OPPORTUNITY' || link.ref === input.opportunity.id) continue;
      const other = await getOpportunity(link.ref);
      if (!other || !IN_FLIGHT.has(other.state)) continue;
      const cents = other.peakFundingCents ?? 0;
      tiedUp += cents;
      const started = (await actionsFor(other.id))[0]?.createdAt;
      if (started && now.getTime() - Date.parse(started) < WEEK) thisWeek += cents;
    }
    const after = tiedUp + input.neededCents;
    const title = goal.title.slice(0, 80);
    if (total !== null && after > total) {
      return `The goal "${title}" may tie up at most ${money(total, currency)}; ${money(tiedUp, currency)} is tied up and this needs ${money(input.neededCents, currency)}.`;
    }
    if (beforeProof !== null && !target.proven && after > beforeProof) {
      return (
        `Until a customer payment arrives, the goal "${title}" may tie up at most ${money(beforeProof, currency)} — ` +
        `the owner wants proof it works before more is spent. ${money(tiedUp, currency)} is tied up and this needs ` +
        `${money(input.neededCents, currency)}. Start with something smaller, or let the first one pay.`
      );
    }
    if (perWeek !== null && thisWeek + input.neededCents > perWeek) {
      return (
        `The goal "${title}" may newly tie up at most ${money(perWeek, currency)} in any seven days, so its money is ` +
        `spread over its life; ${money(thisWeek, currency)} was started this week and this needs ` +
        `${money(input.neededCents, currency)}. It can start once the week's room returns.`
      );
    }
  }
  return null;
}

/** The owner's spending rule for a goal, in one sentence, or null when none is set. */
export function spendingRuleSentence(target: {
  currency: string;
  capitalCeilingCents: number | null;
  capitalBeforeProofCents: number | null;
  capitalPerWeekCents: number | null;
  proven: boolean;
}): string | null {
  const parts: string[] = [];
  if (target.capitalBeforeProofCents !== null) {
    parts.push(
      target.proven
        ? `money has come in, so the test stage (${money(target.capitalBeforeProofCents, target.currency)}) is passed`
        : `at most ${money(target.capitalBeforeProofCents, target.currency)} before any money comes in`,
    );
  }
  if (target.capitalPerWeekCents !== null) parts.push(`at most ${money(target.capitalPerWeekCents, target.currency)} newly tied up a week`);
  if (target.capitalCeilingCents !== null) parts.push(`at most ${money(target.capitalCeilingCents, target.currency)} in all`);
  return parts.length ? parts.join('; ') : null;
}
