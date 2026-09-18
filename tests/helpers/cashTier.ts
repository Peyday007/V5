/**
 * Building a tier the way `cashView` builds one, for tests that do not have a
 * database in front of them.
 *
 * `placements` takes the tier rather than deriving it, because deriving it
 * needs the recorded card facts and a pure function cannot read rows. So a
 * test that calls `placements` directly has to compose one too — and composing
 * it *here*, through the real `cashEngineCard` and the real `cashTier`, is the
 * point: a helper that returned a hand-written tier would let a suite assert
 * against a classification the production path would never produce.
 */
import { cashEngineCard } from '../../server/services/cash/engineCard.ts';
import { evidenceCard } from '../../server/services/cash/card.ts';
import { cashTier, qualificationKeys, type TierReading } from '../../server/services/cash/tier.ts';
import { CAPTURE_KEY } from '../../server/services/cash/tier.ts';
import type { CashCardFact, CashOpportunity } from '../../server/domain/types.ts';

export function fact(
  opportunity: CashOpportunity,
  field: string,
  overrides: Partial<CashCardFact> = {},
): CashCardFact {
  return {
    id: `ccf_${field}_${opportunity.id}`,
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    field,
    kind: 'EVIDENCE',
    value: `An answer to ${field}, from a published source.`,
    claimId: `clm_${field}`,
    needId: null,
    basis: null,
    assumptions: null,
    uncertainty: null,
    decidedBy: 'BRAIN',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

/** Every question this piece's kind asks, answered. A qualified fixture. */
export function qualifyingFacts(opportunity: CashOpportunity): CashCardFact[] {
  const keys = [CAPTURE_KEY, ...qualificationKeys(opportunity.opportunitySignal)];
  return [...new Set(keys)].map((key) => fact(opportunity, key));
}

export function tierFor(
  opportunity: CashOpportunity,
  facts: CashCardFact[] = qualifyingFacts(opportunity),
): TierReading {
  return cashTier({
    opportunity,
    card: cashEngineCard({ opportunity, facts }),
    readiness: evidenceCard(opportunity).readiness,
  });
}

export function tiersFor(
  opportunities: CashOpportunity[],
  facts: (one: CashOpportunity) => CashCardFact[] = qualifyingFacts,
): Record<string, TierReading> {
  const out: Record<string, TierReading> = {};
  for (const one of opportunities) out[one.id] = tierFor(one, facts(one));
  return out;
}

/**
 * The execution thesis, answered by a person.
 *
 * Spread into a `fillCard` patch or a `PATCH /api/cash/opportunities/:id`
 * body beside the twelve short-card fields. It exists because those twelve
 * stopped being the whole of what "ready to test" means: a piece can answer
 * every readiness field and still have nothing saying whether we are
 * eligible, how the work gets done, whether calling is required, what it
 * costs or when the money arrives.
 *
 * These are `ENGINE_FIELDS`, which have no column — so a person answering one
 * is a `PERSON` row in `cash_card_facts`, and `mayReplace` keeps it above
 * anything automatic. Using it lowers no bar: the tier still requires every
 * question to be answered, and this is somebody answering them.
 */
export const EXECUTION_THESIS: Readonly<Record<string, string>> = Object.freeze({
  captureMechanism: 'Supply the repair to the buyer who asked, and be paid for it.',
  revenueRange: 'Comparable work is published at USD 500 to 800.',
  directCosts: 'Nothing to buy. One afternoon of our own time.',
  requiredCapital: 'Nothing out before the invoice.',
  timeToFirstCash: 'Their published terms are net 14 from acceptance.',
  hours: 'Comparable work is published as taking four to six hours.',
  laborNeeds: 'One person, for an afternoon. No selling and no subcontractor.',
  fulfilmentModel: 'Manual, by us. Nothing here automates and nothing is subcontracted.',
  phoneDependency: 'No call. They published an address and replied to it.',
  eligibility: 'No licence, registration or platform rule applies to work this size.',
  acquisitionAccess: 'Nothing has to be acquired. The work is the deliverable.',
  exitEvidence: 'Not a resale. There is nothing to sell on.',
  firstSteps: 'Re-read the request, write the one-page reply, send it.',
  bottleneck: 'Reaching the buyer at all.',
  scalingLever: 'The same deliverable for the next buyer in the same market.',
  disqualifiers: 'Nothing published rules it out. The request is open.',
  confidence: 'The payer and the price are from them; the costs are ours.',
  recommendation: 'Worth testing. The margin is the afternoon, and nothing is at risk.',
});
