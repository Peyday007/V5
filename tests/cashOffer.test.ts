/**
 * The sendable offer: composed from the card verbatim, refused on any blank,
 * and never a figure the card did not hold.
 */
import { describe, expect, it } from 'vitest';
import { composeOffer } from '../server/services/cash/offer.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

function opportunity(over: Partial<CashOpportunity> = {}): CashOpportunity {
  return {
    id: 'cop_1',
    title: 'A paid intake repair',
    state: 'READY',
    payer: 'Marguerite Vance, who signs',
    reachableChannel: 'Replied by email on Tuesday',
    offerScope: 'One intake repair. Not included: anything the request does not name.',
    acceptanceCondition: 'A test enquiry arrives in the inbox',
    priceCents: 75_000,
    currency: 'USD',
    paymentTerms: null,
    deliveryMethod: 'One afternoon of configuration',
    fulfillmentOwner: 'Us',
    deadline: null,
    economicsNote: null,
    ...over,
  } as CashOpportunity;
}

function fact(over: Partial<CashCardFact>): CashCardFact {
  return {
    id: 'ccf_1',
    projectId: 'prj_1',
    opportunityId: 'cop_1',
    field: 'offer',
    kind: 'RECOMMENDATION',
    value: '',
    claimId: null,
    needId: null,
    basis: null,
    assumptions: null,
    uncertainty: null,
    decidedBy: 'BRAIN',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

describe('composeOffer', () => {
  it('composes every line verbatim from the card, and nothing else', () => {
    const draft = composeOffer({ opportunity: opportunity(), facts: [] });
    expect(draft.sendable).toBe(true);
    expect(draft.missing).toEqual([]);
    expect(draft.text).toBe(
      [
        'To: Marguerite Vance, who signs',
        'Via: Replied by email on Tuesday',
        'Re: A paid intake repair',
        '',
        'Offer: One intake repair. Not included: anything the request does not name.',
        'Accepted when: A test enquiry arrives in the inbox',
        'Price: USD 750.00',
        'Delivery: One afternoon of configuration',
        'Fulfilled by: Us',
      ].join('\n'),
    );
    // Optional fields are named rather than filled.
    expect(draft.unstated.map((g) => g.key)).toEqual(['paymentTerms', 'cashDates']);
    expect(draft.lines.every((line) => line.source === 'RECORDED')).toBe(true);
  });

  it('refuses with a named list and no text when anything required is blank', () => {
    const draft = composeOffer({
      opportunity: opportunity({
        reachableChannel: '  ',
        priceCents: null,
        acceptanceCondition: null,
      }),
      facts: [],
    });
    expect(draft.sendable).toBe(false);
    expect(draft.text).toBeNull();
    expect(draft.lines).toEqual([]);
    expect(draft.recipient).toBeNull();
    expect(draft.missing.map((g) => g.key).sort()).toEqual(['acceptance', 'access', 'price']);
  });

  it('computes no figure: a missing price is never derived from anything else', () => {
    const draft = composeOffer({
      opportunity: opportunity({ priceCents: null, economicsNote: 'Comparable work is USD 900' }),
      facts: [
        fact({ field: 'economics', kind: 'EVIDENCE', value: 'USD 900 per repair', claimId: 'rcl_9' }),
      ],
    });
    expect(draft.text).toBeNull();
    expect(draft.missing.map((g) => g.key)).toContain('price');
  });

  it('credits a fact only while it still states what the column says', () => {
    const o = opportunity();
    const draft = composeOffer({
      opportunity: o,
      facts: [
        fact({ field: 'offer', kind: 'RECOMMENDATION', value: o.offerScope! }),
        fact({ field: 'payer', kind: 'EVIDENCE', value: 'Somebody else', claimId: 'rcl_1' }),
        fact({
          field: 'price',
          kind: 'EVIDENCE',
          value: 'Published at USD 750 per repair',
          claimId: 'rcl_2',
        }),
        // Another opportunity's fact never reaches this draft.
        fact({
          opportunityId: 'cop_2',
          field: 'delivery',
          kind: 'PERSON',
          value: 'One afternoon of configuration',
        }),
      ],
    });
    const by = Object.fromEntries(draft.lines.map((l) => [l.key, l]));
    expect(by['offer']!.source).toBe('RECOMMENDATION');
    expect(by['price']!.source).toBe('EVIDENCE');
    expect(by['price']!.claimId).toBe('rcl_2');
    expect(by['delivery']!.source).toBe('RECORDED');
    // A person later typed a different payer, so the old source is not cited.
    expect(draft.recipient!.payer.source).toBe('RECORDED');
    expect(draft.recipient!.payer.claimId).toBeNull();
  });

  it('includes payment terms and timing only where the card states them', () => {
    const draft = composeOffer({
      opportunity: opportunity({
        paymentTerms: 'Half on acceptance',
        deadline: 'Before 30 September',
      }),
      facts: [],
    });
    expect(draft.text).toContain('Payment terms: Half on acceptance');
    expect(draft.text).toContain('Timing: Before 30 September');
    expect(draft.unstated).toEqual([]);
  });
});
