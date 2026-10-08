/**
 * The screen itself, as a pure decision over rows.
 *
 * `cashScreening.test.ts` drives the entrances and pins what Brain spends; this
 * file pins *why*, case by case, without a database: the reason each verdict
 * gives, that revenue alone decides nothing, that an unknown is never a
 * rejection, that the economics owner's verdict is read rather than re-derived,
 * and that every narrow question Brain composes passes Brain's own envelope.
 */
import { describe, expect, it } from 'vitest';
import {
  DECISIVE_LADDER,
  economicsOf,
  rejectionKey,
  screenOpportunity,
  screenRank,
  targetedQuestion,
  type ScreenInput,
} from '../server/services/cash/screening.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashTier, type TierReading } from '../server/services/cash/tier.ts';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';
import type { CashCardFact, CashOpportunity, OpportunitySignal } from '../server/domain/types.ts';

const NOW = '2026-10-08T16:00:00.000Z';

function opportunity(overrides: Partial<CashOpportunity> = {}): CashOpportunity {
  return {
    id: 'cop_a',
    projectId: 'prj_1',
    cashModeId: 'csm_1',
    ownerUserId: 'usr_1',
    title: 'An opening',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    industryNodeId: null,
    industry: null,
    source: null,
    candidateId: null,
    externalRecordId: null,
    sourceClaimId: null,
    discoveredByCandidateId: null,
    orchestrationId: null,
    fragmentId: null,
    discoveryRoundId: null,
    validationOrchestrationId: null,
    validationState: null,
    validationStartedAt: null,
    validationSettledAt: null,
    validationRounds: 0,
    opportunitySignal: null,
    state: 'DISCOVERED',
    currency: 'USD',
    payer: null,
    offerScope: null,
    acceptanceCondition: null,
    priceCents: null,
    deliveryMethod: null,
    fulfillmentOwner: null,
    economicsNote: null,
    peakFundingCents: null,
    humanHours: null,
    buyingSignal: 'A published signal.',
    signalObservedAt: '2026-09-20',
    reachableChannel: null,
    requiredCapabilities: [],
    dependsOnId: null,
    deadline: null,
    expiresAt: null,
    expiryReason: null,
    exhaustedAt: null,
    exhaustedReason: null,
    nextAction: null,
    outcome: null,
    archivedReason: null,
    declinedReason: null,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  } as CashOpportunity;
}

function fact(field: string, value: string, overrides: Partial<CashCardFact> = {}): CashCardFact {
  return {
    id: `ccf_${field}`,
    projectId: 'prj_1',
    opportunityId: 'cop_a',
    field,
    kind: 'PERSON',
    value,
    claimId: null,
    needId: null,
    basis: null,
    assumptions: null,
    uncertainty: null,
    decidedBy: 'usr_1',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function input(
  op: CashOpportunity,
  facts: CashCardFact[] = [],
  extra: Partial<ScreenInput> & { economics?: { verdict: string } | null; route?: string } = {},
): ScreenInput {
  const card = cashEngineCard({ opportunity: op, facts });
  const tier = cashTier({ opportunity: op, card, readiness: evidenceCard(op).readiness });
  // The economics owner's fields, as `tier.ts` will carry them, put on the
  // reading the way the owner's own code would.
  const withEconomics = (extra.economics !== undefined
    ? { ...tier, economics: extra.economics, route: extra.route ?? null }
    : tier) as TierReading;
  return {
    opportunity: op,
    card,
    tier: withEconomics,
    facts,
    key: rejectionKey(op, op.source),
    establishedAbsent: [],
    negativeClaimIds: [],
    rejections: [],
    targetedRounds: [],
    researchedDives: 0,
    askedNarrowly: [],
    diveRoundsLeft: true,
    needAskable: evidenceCard(op).fields.map((one) => one.key),
    now: NOW,
    ...extra,
  };
}

/*
 * The economics owner (`tier.ts`) does not yet carry `economics` on its reading
 * on this tree, so these cases put that field on the reading the way the owner
 * will. On today's production readings `economicsOf` is null and neither rule
 * fires — which is the point of the next describe, not a gap in this one.
 */
describe('1 and 5. once the economics owner reports NEGATIVE, the spending ends, whatever the price', () => {
  it('screens out GoTranscript-style manual work the owner reads as costing more than it pays', () => {
    const op = opportunity({
      opportunitySignal: 'PAID_TASK_OR_CONTRACT',
      source: 'https://gotranscript.com/transcription-jobs',
      payer: 'GoTranscript',
    });
    const screen = screenOpportunity(input(op, [], { economics: { verdict: 'NEGATIVE' } }));
    expect(screen.verdict).toBe('SCREEN_OUT');
    expect(screen.reason).toBe('ECONOMICS_NEGATIVE');
  });

  it('screens out a high-priced project the owner reads as unprofitable', () => {
    const op = opportunity({
      opportunitySignal: 'ACTIVE_BUYER_DEMAND',
      payer: 'A county',
      priceCents: 5_000_000,
    });
    expect(screenOpportunity(input(op, [], { economics: { verdict: 'NEGATIVE' } })).reason).toBe(
      'ECONOMICS_NEGATIVE',
    );
  });

  it('5. reads a large price with no payer as a question about the payer, not as a priority', () => {
    const op = opportunity({ opportunitySignal: 'ACTIVE_BUYER_DEMAND', priceCents: 5_000_000 });
    const screen = screenOpportunity(input(op));
    expect(screen.verdict).toBe('TARGET');
    expect(screen.decisive).toBe('payer');
  });
});

describe('8. missing costs, volumes and effort are unknown, never profitable', () => {
  it('prioritises a dated buyer request with a payer without calling it profitable', () => {
    const op = opportunity({ opportunitySignal: 'ACTIVE_BUYER_DEMAND', payer: 'NJDOH' });
    const screen = screenOpportunity(input(op));
    expect(screen.verdict).toBe('PRIORITIZE');
    expect(screen.reason).toBe('DIRECT_DEMAND_PAYER_KNOWN');
    expect(screen.economics).toBeNull();
    expect(screen.because).toContain('not treated as profitable');
  });

  it('ranks established positive economics ahead of an unpriced buyer request', () => {
    const op = opportunity({ opportunitySignal: 'ACTIVE_BUYER_DEMAND', payer: 'NJDOH' });
    const unpriced = screenOpportunity(input(op));
    const positive = screenOpportunity(input(op, [], { economics: { verdict: 'POSITIVE' } }));
    expect(positive.reason).toBe('ECONOMICS_POSITIVE');
    expect(screenRank(positive)).toBeLessThan(screenRank(unpriced));
  });

  it('never screens anything out on an absent or UNKNOWN economics reading', () => {
    for (const economics of [null, { verdict: 'UNKNOWN' }]) {
      const op = opportunity({ opportunitySignal: 'PAID_TASK_OR_CONTRACT' });
      expect(screenOpportunity(input(op, [], { economics })).verdict).toBe('TARGET');
    }
  });
});

describe('the seam to the economics owner reads its fields and nothing else', () => {
  it('is null on a reading that carries no economics, which is the tree today', () => {
    const op = opportunity();
    expect(economicsOf(input(op).tier)).toBeNull();
  });

  it('carries the owner’s route when there is one', () => {
    const op = opportunity();
    const reading = input(op, [], { economics: { verdict: 'POSITIVE' }, route: 'FAST_CASH' }).tier;
    expect(economicsOf(reading)).toEqual({ verdict: 'POSITIVE', route: 'FAST_CASH' });
  });
});

describe('2 and 6. the decisive question is the first gate the kind fails on', () => {
  const cases: [OpportunitySignal, string][] = [
    ['PRICING_OR_INFORMATION_ASYMMETRY', 'exitEvidence'],
    ['RESALABLE_ASSET_OPENING', 'exitEvidence'],
    ['ACTIVE_BUYER_DEMAND', 'payer'],
    ['EXPIRING_OPENING', 'payer'],
    ['RECURRING_OUTSOURCED_WORK', 'payer'],
  ];
  for (const [signal, decisive] of cases) {
    it(`${signal} is asked ${decisive} first`, () => {
      // A dated signal already answers "is it still open", so an expiring
      // opening's first unanswered gate is the payer.
      const screen = screenOpportunity(input(opportunity({ opportunitySignal: signal })));
      expect(screen.verdict).toBe('TARGET');
      expect(screen.decisive).toBe(decisive);
    });
  }

  it('asks an exit question by a one-question dive and a payer question by a need', () => {
    expect(
      screenOpportunity(input(opportunity({ opportunitySignal: 'RESALABLE_ASSET_OPENING' }))).askBy,
    ).toBe('DIVE');
    expect(screenOpportunity(input(opportunity({ opportunitySignal: 'ACTIVE_BUYER_DEMAND' }))).askBy).toBe(
      'NEED',
    );
  });

  it('6. stops on an established absence of sales, and only while nothing has answered it', () => {
    const op = opportunity({ opportunitySignal: 'RESALABLE_ASSET_OPENING' });
    expect(screenOpportunity(input(op, [], { establishedAbsent: ['exitEvidence'] })).reason).toBe(
      'ESTABLISHED_ABSENT',
    );
    const answered = [fact('exitEvidence', 'Sixty completed sales at $92 to $129.')];
    expect(screenOpportunity(input(op, answered, { establishedAbsent: ['exitEvidence'] })).verdict).not.toBe(
      'SCREEN_OUT',
    );
  });

  it('6. reads an absence written into the answer’s place as no answer', () => {
    const op = opportunity({ opportunitySignal: 'RESALABLE_ASSET_OPENING' });
    const written = [fact('exitEvidence', 'No sale was found.', { kind: 'EVIDENCE', claimId: 'clm_none' })];
    const screen = screenOpportunity(
      input(op, written, { establishedAbsent: ['exitEvidence'], negativeClaimIds: ['clm_none'] }),
    );
    expect(screen.reason).toBe('ESTABLISHED_ABSENT');
  });
});

describe('7. a resale with every gate answered earns the full qualification', () => {
  it('is PRIORITIZE once exit, acquisition, cost and payer are on the card', () => {
    const op = opportunity({ opportunitySignal: 'RESALABLE_ASSET_OPENING', payer: 'Collectors on TCGPlayer' });
    const facts = [
      fact('exitEvidence', 'Sixty completed sales at $92.79 to $129.99.'),
      fact('acquisitionAccess', 'In stock at a retailer for $59.99.'),
      fact('directCosts', '$59.99 plus $18 of fees.'),
    ];
    const screen = screenOpportunity(input(op, facts));
    expect(screen.verdict).toBe('PRIORITIZE');
    expect(screen.reason).toBe('GATES_ANSWERED');
    expect(screen.askBy).toBe('FULL_DIVE');
  });
});

describe('unknown is never rejection', () => {
  it('parks only a question already asked and unanswered — and keeps its name', () => {
    const op = opportunity({ opportunitySignal: 'RESALABLE_ASSET_OPENING' });
    const screen = screenOpportunity(input(op, [], { askedNarrowly: ['exitEvidence'] }));
    expect(screen.verdict).toBe('PARK');
    expect(screen.decisive).toBe('exitEvidence');
  });

  it('does not park a question a full dive asked while a narrow way to ask it remains', () => {
    const op = opportunity({ opportunitySignal: 'ACTIVE_BUYER_DEMAND', validationRounds: 2 });
    // Full dives asked the payer; a need is a different, narrower question.
    const screen = screenOpportunity(input(op, [], { researchedDives: 2, diveRoundsLeft: false }));
    expect(screen.verdict).toBe('TARGET');
    expect(screen.askBy).toBe('NEED');
  });

  it('screens out an expired opening on its own recorded expiry, and nothing else', () => {
    const op = opportunity({ expiresAt: '2026-10-01T00:00:00.000Z' });
    expect(screenOpportunity(input(op)).reason).toBe('OPENING_EXPIRED');
    expect(screenOpportunity(input(opportunity({ expiresAt: '2026-11-01T00:00:00.000Z' }))).verdict).not.toBe(
      'SCREEN_OUT',
    );
  });
});

describe('9 and 10. the rejection key is narrow, and new evidence reopens it', () => {
  const rejected = {
    opportunityId: 'cop_old',
    key: 'PRICING_OR_INFORMATION_ASYMMETRY|gotranscript.com',
    at: '2026-09-01T00:00:00.000Z',
    why: 'DECLINED' as const,
  };
  const op = opportunity({
    opportunitySignal: 'PRICING_OR_INFORMATION_ASYMMETRY',
    source: 'https://www.gotranscript.com/pricing',
  });

  it('keys on the kind of evidence and the host, so www and a query string do not matter', () => {
    expect(rejectionKey(op, 'https://www.gotranscript.com/pricing?x=1')).toBe(rejected.key);
    expect(rejectionKey(op, 'https://www.rev.com/pricing')).not.toBe(rejected.key);
  });

  it('screens out the same mechanism from the same host', () => {
    expect(screenOpportunity(input(op, [], { rejections: [rejected] })).reason).toBe('MECHANISM_REJECTED');
  });

  it('is reopened by a decisive fact recorded after the rejection, and not by one before it', () => {
    const before = [fact('exitEvidence', 'x', { createdAt: '2026-08-01T00:00:00.000Z' })];
    expect(screenOpportunity(input(op, before, { rejections: [rejected] })).reason).toBe('MECHANISM_REJECTED');
    const after = [fact('exitEvidence', 'Completed resales at $2.40 a minute.', { createdAt: '2026-10-01T00:00:00.000Z' })];
    const screen = screenOpportunity(input(op, after, { rejections: [rejected] }));
    expect(screen.reason).not.toBe('MECHANISM_REJECTED');
    expect(screen.reconsidered).toEqual({ rejectedOpportunityId: 'cop_old', evidenceField: 'exitEvidence' });
  });
});

describe('every narrow question passes Brain’s own envelope', () => {
  const pattern = APPROVAL_ENVELOPES['RUSSELL_CASH_VALIDATION_V1']!.forbiddenActions;
  const keys = [...new Set(Object.values(DECISIVE_LADDER).flatMap((one) => [...one]))];
  for (const key of keys) {
    it(`admits the ${key} question`, () => {
      const question = targetedQuestion(
        opportunity({
          buyingSignal: 'The RFP states a closing date of September 25, 2026, and a budget of $40,000.',
          source: 'https://example.gov/rfp',
        }),
        key,
      );
      expect(ownActionMatches(question, pattern)).toEqual([]);
    });
  }
});

describe('what the independent review found, pinned', () => {
  it('asks nothing it cannot ask: a dive question with no rounds left parks, naming the gap', () => {
    const op = opportunity({ opportunitySignal: 'RESALABLE_ASSET_OPENING', validationRounds: 2 });
    const screen = screenOpportunity(input(op, [], { diveRoundsLeft: false }));
    expect(screen.verdict).toBe('PARK');
    expect(screen.decisive).toBe('exitEvidence');
    expect(screen.because).toContain('both dives are spent');
  });

  it('parks an established absence of a field that is not what the kind depends on, rather than asking for ever', () => {
    const op = opportunity({ opportunitySignal: 'ACTIVE_BUYER_DEMAND', payer: 'A county' });
    const written = [fact('access', 'No published route to the buyer was found.', { kind: 'EVIDENCE', claimId: 'clm_noroute' })];
    const screen = screenOpportunity(
      input(op, written, { establishedAbsent: ['access'], negativeClaimIds: ['clm_noroute'] }),
    );
    // The payer is known and the request dated, but the decisive question —
    // the route — was searched for and is not there.
    expect(screen.verdict).toBe('PARK');
    expect(screen.decisive).toBe('access');
  });
});
