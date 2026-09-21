/**
 * Saying, once, on the project's own history, that the work model changed.
 *
 * ---------------------------------------------------------------------------
 * Why there is no migration here
 * ---------------------------------------------------------------------------
 *
 * The tier that separates evidence from work is **derived** (`tier.ts`), so
 * deploying the correction reclassifies every piece already written with
 * nothing deleted, nothing duplicated, nothing rewritten, and every claim,
 * source, packet, round and event exactly where it was. That is the right
 * mechanism and it is strictly better than a backfill: it reaches rows a later
 * tick promotes, and deleting it returns the Brain to exactly what it did
 * before.
 *
 * What a derivation cannot do is say that it happened. Forty pieces stopped
 * being *current work* and started being *evidence* between one deploy and the
 * next, and a person who had been reading `1 to act on now, 40 waiting`
 * deserves to find out why from the record rather than from noticing. So this
 * is one row, on the append-only history the sprint already keeps, naming the
 * counts and the reason.
 *
 * ---------------------------------------------------------------------------
 * One row, not forty
 * ---------------------------------------------------------------------------
 *
 * Per project, once, ever. An event per piece would be forty lines of noise
 * about a change that happened to all of them for one reason, and the reason is
 * the thing worth keeping. Idempotent by reading the history for its own kind
 * rather than by a flag: a flag can be set by a tick that then dies, and rows
 * cannot.
 *
 * It **archives nothing and reclassifies nothing**. Every opportunity keeps its
 * state, its row and its evidence; what moved is which list a screen puts it
 * in, and that is a reading rather than a write. Nothing here can be the reason
 * a piece is not worked on.
 */
import { listCashEvents, recordCashEvent } from '../../repos/cashMode.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { cashTier } from './tier.ts';
import { isWorkable } from './portfolio.ts';
import type { CashCardFact } from '../../domain/types.ts';

export const WORK_MODEL_RECLASSIFIED = 'CASH_WORK_MODEL_RECLASSIFIED';

export interface Reclassification {
  projectId: string;
  evidence: number;
  beingQualified: number;
  work: number;
}

/**
 * Record it if it has not been recorded, and say nothing otherwise.
 *
 * Returns null when there was nothing to record — no sprint, nothing in the
 * portfolio, or the row is already there — so a caller can report an actual
 * change without having to ask a second question about it.
 */
export async function recordWorkModelReclassification(
  projectId: string,
): Promise<Reclassification | null> {
  const opportunities = await listOpportunities({ projectId });
  if (opportunities.length === 0) return null;

  /*
   * Read the whole history rather than the recent window the page shows: this
   * is asked on every tick for ever, and a row that scrolled off a fifty-event
   * window would be recorded again every day.
   */
  const already = (await listCashEvents(projectId, 1000)).some(
    (event) => event.kind === WORK_MODEL_RECLASSIFIED,
  );
  if (already) return null;

  const facts = new Map<string, CashCardFact[]>();
  for (const one of await cardFactsForProject(projectId)) {
    facts.set(one.opportunityId, [...(facts.get(one.opportunityId) ?? []), one]);
  }

  const counts: Reclassification = {
    projectId,
    evidence: 0,
    beingQualified: 0,
    work: 0,
  };
  for (const opportunity of opportunities) {
    const card = cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] });
    const tier = cashTier({
      opportunity,
      card,
      readiness: evidenceCard(opportunity).readiness,
    });
    if (isWorkable({ tier: tier.tier, state: opportunity.state })) counts.work += 1;
    else if (tier.tier === 'SIGNAL') counts.evidence += 1;
    else counts.beingQualified += 1;
  }

  await recordCashEvent({
    projectId,
    opportunityId: null,
    kind: WORK_MODEL_RECLASSIFIED,
    actorRef: 'BRAIN',
    summary:
      `${counts.evidence} record${counts.evidence === 1 ? '' : 's'} in this portfolio ` +
      `${counts.evidence === 1 ? 'is' : 'are'} evidence rather than work, ` +
      `${counts.beingQualified} ${counts.beingQualified === 1 ? 'is' : 'are'} being qualified, ` +
      `and ${counts.work} ${counts.work === 1 ? 'is' : 'are'} work you can act on.`,
    detail: {
      reason:
        'A published price, an asking price and an appraisal are facts about a market and are ' +
        'not evidence that anybody would pay us. Until Brain can say who pays and how they are ' +
        'reached, such a record is evidence: it is kept with its claim and its source, it is ' +
        'not in your current work, it is not waiting on you, and it is not counted in what the ' +
        'portfolio would contribute. Nothing was archived, deleted or rewritten to make that ' +
        'true — the reading is derived from each record, so a record that becomes qualified ' +
        'becomes work on the next read.',
      evidence: counts.evidence,
      beingQualified: counts.beingQualified,
      work: counts.work,
    },
  });
  return counts;
}
