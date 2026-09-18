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
