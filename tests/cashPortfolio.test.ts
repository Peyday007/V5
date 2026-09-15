/**
 * The evidence card, the assembled plan, and the review that compresses them.
 *
 * Three rules from the plan are the whole of this file.
 *
 * **An unknown is never a favourable assumption.** A blank payer is an access
 * task and a blank price is a quoting task; neither is a yes, and neither may
 * float an opportunity up a ranking.
 *
 * **Do not stop at ranking ideas and asking the user to choose one.** The
 * output is an assembled plan in which every piece carries a disposition, and
 * every "waiting" names the thing it waits on — another opportunity, the money,
 * or the capacity.
 *
 * **Compression is grouping by shared remedy, not a top-ten list.** Answering
 * one group releases every underlying item in it, and the count of what it
 * stands for is on the screen rather than implied.
 */
import { describe, expect, it } from 'vitest';
import { evidenceCard, readyToTest } from '../server/services/cash/card.ts';
import { assemble, placements, rank } from '../server/services/cash/portfolio.ts';
import { DISCOVERABLE_FIELDS, compressedReview } from '../server/services/cash/review.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const NOW = '2026-09-15T12:00:00.000Z';

function opportunity(overrides: Partial<CashOpportunity> = {}): CashOpportunity {
  return {
    id: `cop_${Math.random().toString(36).slice(2, 10)}`,
    projectId: 'prj_1',
    cashModeId: 'csm_1',
    ownerUserId: 'usr_1',
    title: 'An opening',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    industry: null,
    source: null,
    candidateId: null,
    externalRecordId: null,
    sourceClaimId: null,
    discoveredByCandidateId: null,
    payer: null,
    reachableChannel: null,
    buyingSignal: null,
    signalObservedAt: null,
    offerScope: null,
    acceptanceCondition: null,
    priceCents: null,
    currency: 'USD',
    paymentTerms: null,
    fulfillmentOwner: null,
    deliveryMethod: null,
    requiredInputs: null,
    deadline: null,
    economicsNote: null,
    peakFundingCents: null,
    humanHours: null,
    expiresAt: null,
    expiryReason: null,
    dependsOnId: null,
    duplicateOfId: null,
    requiredCapabilities: [],
    executionAsset: null,
    assetRevision: null,
    state: 'DISCOVERED',
    exhaustedAt: null,
    exhaustedReason: null,
    nextAction: null,
    nextActionDue: null,
    outcome: null,
    stopRule: null,
    declinedByUserId: null,
    declinedReason: null,
    reofferedFromId: null,
    archivedReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Every load-bearing field answered. */
function complete(overrides: Partial<CashOpportunity> = {}): CashOpportunity {
  return opportunity({
    payer: 'The owner',
    reachableChannel: 'Replied on Tuesday',
    buyingSignal: 'Asked for a quote',
    signalObservedAt: '2026-09-14T00:00:00.000Z',
    offerScope: 'One fixed-scope repair',
    acceptanceCondition: 'A test enquiry arrives',
    priceCents: 75_000,
    deliveryMethod: 'One afternoon of configuration',
    fulfillmentOwner: 'Us',
    peakFundingCents: 0,
    state: 'READY',
    ...overrides,
  });
}

describe('the card says what is unknown, and what would answer it', () => {
  it('refuses an empty card and names every load-bearing blank', () => {
    const card = evidenceCard(opportunity());
    expect(card.readiness.ready).toBe(false);
    expect(card.readiness.missing).toEqual([
      'payer',
      'access',
      'buyingEvidence',
      'offer',
      'acceptance',
      'price',
      'delivery',
      'fulfillment',
      'exposure',
    ]);
  });

  it('gives every field the task that would answer it, answered or not', () => {
    for (const field of evidenceCard(complete()).fields) {
      expect(field.task.length).toBeGreaterThan(10);
    }
  });

  it('calls a missing phone number an access task and a missing price a quoting task', () => {
    const card = evidenceCard(opportunity());
    const access = card.fields.find((f) => f.key === 'access')!;
    const price = card.fields.find((f) => f.key === 'price')!;
    expect(access.task).toContain('access task');
    expect(price.task).toContain('quoting task');
  });

  it('treats a whitespace answer as no answer', () => {
    expect(readyToTest(complete({ payer: '   ' }))).toBe(false);
  });

  it('does not require the cash dates, the economics or the next action to be testable', () => {
    // Worth knowing, and not what the decision turns on. §3: ready when the
    // payer, offer, delivery path and bounded exposure are credible.
    expect(readyToTest(complete({ deadline: null, economicsNote: null, nextAction: null }))).toBe(
      true,
    );
  });

  it('counts a buying signal with no observation date as no evidence', () => {
    // "Include source and observation date." A signal with no date cannot be
    // told apart from one somebody remembers from last year.
    expect(readyToTest(complete({ signalObservedAt: null }))).toBe(false);
  });
});

describe('every piece carries a disposition, and every wait names what it waits on', () => {
  const base = { deployableCents: 1_000_000, maxConcurrent: 3, discoveryOpen: true };

  it('says execute now when nothing is in its way', () => {
    const [placed] = placements({ ...base, opportunities: [complete()] });
    expect(placed!.disposition).toBe('EXECUTE_NOW');
  });

  it('says run in parallel when something else is already under way', () => {
    const running = complete({ state: 'EXECUTING' });
    const next = complete();
    const found = placements({ ...base, opportunities: [running, next] }).find(
      (p) => p.opportunity.id === next.id,
    )!;
    expect(found.disposition).toBe('RUN_IN_PARALLEL');
  });

  it('names the other opportunity when one is waiting on it', () => {
    const parent = complete({ state: 'EXECUTING', title: 'The one that funds the other' });
    const child = complete({ dependsOnId: parent.id });
    const found = placements({ ...base, opportunities: [parent, child] }).find(
      (p) => p.opportunity.id === child.id,
    )!;
    expect(found.disposition).toBe('WAIT_FOR_DEPENDENCY');
    expect(found.because).toContain('The one that funds the other');
  });

  it('says the money rather than the evidence when the cash is what is short', () => {
    const piece = complete({ peakFundingCents: 500_000 });
    const [found] = placements({ ...base, deployableCents: 1_000, opportunities: [piece] });
    expect(found!.disposition).toBe('WAIT_FOR_DEPENDENCY');
    expect(found!.because).toContain('waits on cash rather than on evidence');
  });

  it('says the capacity rather than the opportunity when the slots are full', () => {
    const running = [complete({ state: 'EXECUTING' }), complete({ state: 'DELIVERING' })];
    const waiting = complete();
    const found = placements({
      ...base,
      maxConcurrent: 2,
      opportunities: [...running, waiting],
    }).find((p) => p.opportunity.id === waiting.id)!;
    expect(found.disposition).toBe('WAIT_FOR_DEPENDENCY');
    expect(found.because).toContain('fulfilment capacity');
    expect(found.because).toContain('Nothing about the opportunity itself is unresolved');
  });

  it('says test a decisive unknown when the card is incomplete', () => {
    const [found] = placements({ ...base, opportunities: [opportunity()] });
    expect(found!.disposition).toBe('TEST_A_DECISIVE_UNKNOWN');
    expect(found!.missing.length).toBeGreaterThan(0);
  });

  it('keeps a declined piece visible rather than deleting it, and says it can be reoffered', () => {
    const [found] = placements({
      ...base,
      opportunities: [complete({ state: 'DECLINED', declinedReason: 'Not for me.' })],
    });
    expect(found!.disposition).toBe('ARCHIVED');
    expect(found!.because).toBe('Not for me.');
  });

  it('says a wound-down sprint keeps running what it already has', () => {
    const [found] = placements({ ...base, discoveryOpen: false, opportunities: [complete()] });
    expect(found!.disposition).toBe('EXECUTE_NOW');
    expect(found!.because).toContain('keeps running');
  });
});

describe('the ranking is lexicographic over facts, and an unknown never helps', () => {
  it('puts a piece with evidence and reach ahead of one with neither', () => {
    const strong = complete({ id: 'cop_strong' });
    const weak = complete({ id: 'cop_weak', buyingSignal: null, reachableChannel: null });
    expect(rank([weak, strong])[0]!.id).toBe('cop_strong');
  });

  it('sorts a missing deadline last rather than first', () => {
    const soon = complete({ id: 'cop_soon', deadline: '2026-09-20T00:00:00.000Z' });
    const never = complete({ id: 'cop_never', deadline: null });
    expect(rank([never, soon])[0]!.id).toBe('cop_soon');
  });

  it('treats an unknown exposure as the worst exposure, not the best', () => {
    const known = complete({
      id: 'cop_known',
      deadline: '2026-09-20T00:00:00.000Z',
      peakFundingCents: 10_000,
      priceCents: 50_000,
    });
    const unknown = complete({
      id: 'cop_unknown',
      deadline: '2026-09-20T00:00:00.000Z',
      peakFundingCents: null,
      priceCents: 50_000,
    });
    // The contribution comparison runs first and the unknown exposure makes
    // that piece look *worse* there too, which is the point: a blank cannot be
    // the reason something rises.
    expect(rank([unknown, known])[0]!.id).toBe('cop_known');
  });

  it('is deterministic for two equivalent pieces', () => {
    const a = complete({ id: 'cop_a', createdAt: '2026-09-01T00:00:00.000Z' });
    const b = complete({ id: 'cop_b', createdAt: '2026-09-02T00:00:00.000Z' });
    expect(rank([b, a]).map((o) => o.id)).toEqual(['cop_a', 'cop_b']);
    expect(rank([a, b]).map((o) => o.id)).toEqual(['cop_a', 'cop_b']);
  });
});

describe('the plan is assembled, not handed back as a ranking', () => {
  it('reports what to act on, what waits, and the combined illustration', () => {
    const plan = assemble({
      opportunities: [
        complete({ priceCents: 100_000, peakFundingCents: 0 }),
        complete({ priceCents: 500_000, peakFundingCents: 0 }),
        complete({ priceCents: 300_000, peakFundingCents: 0 }),
      ],
      deployableCents: 1_000_000,
      maxConcurrent: 3,
      discoveryOpen: true,
    });
    // The plan's own $1k + $5k + $3k example, in cents.
    expect(plan.combinedContributionCents).toBe(900_000);
    expect(plan.executeNow.length).toBe(3);
    expect(plan.waiting.length).toBe(0);
  });

  it('does not count an archived piece toward the combined contribution', () => {
    const plan = assemble({
      opportunities: [
        complete({ priceCents: 100_000, peakFundingCents: 0 }),
        complete({ priceCents: 900_000, peakFundingCents: 0, state: 'ARCHIVED' }),
      ],
      deployableCents: 1_000_000,
      maxConcurrent: 3,
      discoveryOpen: true,
    });
    expect(plan.combinedContributionCents).toBe(100_000);
  });
});

describe('the review groups by shared remedy and counts what it stands for', () => {
  const position = {
    currency: 'USD',
    pipelineCents: 0,
    customerPaymentsCents: 0,
    availableFundsCents: 100_000,
    unpaidCommitmentsCents: 0,
    heldCommitmentsCents: 0,
    reservesCents: 0,
    deployableCents: 100_000,
    completedContributionCents: 0,
    shortfall: false,
    otherCurrencies: [],
  };
  const mode = {
    id: 'csm_1',
    projectId: 'prj_1',
    ownerUserId: 'usr_1',
    objective: 'Cash',
    horizonDays: 7,
    envelopeId: 'RUSSELL_CASH_DISCOVERY_V1',
    currency: 'USD',
    state: 'ACTIVE' as const,
    activatedAt: NOW,
    woundDownAt: null,
    archivedAt: null,
    stateReason: null,
    createdByUserId: 'usr_1',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('names the one decision nothing can proceed without, first and unfolded', () => {
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: [],
      needs: [],
      now: NOW,
    });
    expect(review.items[0]!.key).toBe('AUTHORITY');
    expect(review.items[0]!.urgency).toBe('BLOCKING');
  });

  it('never asks a person for a fact Brain could look up', () => {
    // A missing payer is a fact about the world. Brain raises a need and
    // researches it (`reconcileDiscoverableGaps`); putting it on a person's
    // review would be Brain asking for homework it could have done, which is
    // the opposite of compression.
    const missingPayer = [1, 2, 3, 4, 5].map(() => opportunity({ payer: null }));
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: placements({
        opportunities: missingPayer,
        deployableCents: 100_000,
        maxConcurrent: 3,
        discoveryOpen: true,
      }),
      needs: [],
      now: NOW,
    });
    expect(review.items.find((item) => item.key === 'MISSING_PAYER')).toBeUndefined();
  });

  it('groups the owner’s own decisions, and does not call them one decision', () => {
    /*
     * Five cards with no price are five prices. They are the same *kind* of
     * work and not one answer, and the review used to claim otherwise for
     * every group it made — a screen that says "answering this releases five"
     * and then releases one teaches a person to stop believing the counts.
     */
    const missingPrice = [1, 2, 3, 4, 5].map(() => opportunity({ priceCents: null }));
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: placements({
        opportunities: missingPrice,
        deployableCents: 100_000,
        maxConcurrent: 3,
        discoveryOpen: true,
      }),
      needs: [],
      now: NOW,
    });
    const priceItem = review.items.find((item) => item.key === 'MISSING_PRICE')!;
    expect(priceItem.underlying.length).toBe(5);
    expect(priceItem.sharedRemedy).toBe(false);
    expect(priceItem.consequence).toContain('separate answers of the same kind');
    expect(priceItem.answer.kind).toBe('FILL_CARD_FIELD');
    expect(priceItem.answer.targets).toHaveLength(5);
    expect(review.underlyingCount).toBeGreaterThanOrEqual(5);
    // The compression itself is measured rather than claimed.
    expect(review.summary).toContain('underlying');
  });

  it('turns two needs with one remedy into one decision', () => {
    const need = (id: string) => ({
      id,
      projectId: 'prj_1',
      opportunityId: null,
      blockedAction: `Do ${id}`,
      whyItMatters: 'It blocks a sale.',
      recommendedPath: 'Buy the same small tool once.',
      expectedCostCents: 5_000,
      setupEffort: 'Minutes.',
      nextStep: 'Buy it.',
      completionCondition: 'The tool is bought and reachable from here.',
      blocksState: null,
      candidateId: null,
      requestKey: null,
      continuedAt: null,
      continuationNote: null,
      state: 'OPEN' as const,
      resolution: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: [],
      needs: [need('cnd_1'), need('cnd_2')],
      now: NOW,
    });
    const grouped = review.items.find((item) => item.title.includes('one remedy'))!;
    expect(grouped.underlying).toEqual(['cnd_1', 'cnd_2']);
    // One tool bought once. Adding the two expected costs reported twice the
    // price of buying it — the direction that makes a cheap unblock look
    // expensive enough to defer.
    expect(grouped.costCents).toBe(5_000);
    expect(grouped.recommendation).toContain('5000 cents');
    expect(grouped.costNote).toContain('paid once');
    expect(grouped.sharedRemedy).toBe(true);
    expect(grouped.answer.kind).toBe('RESOLVE_NEED');
    expect(grouped.answer.targets).toEqual(['cnd_1', 'cnd_2']);
    expect(grouped.answer.completionCondition).toContain('tool');
  });

  it('says the largest rather than a total when a shared remedy names two costs', () => {
    const need = (id: string, cost: number) => ({
      id,
      projectId: 'prj_1',
      opportunityId: null,
      blockedAction: `Do ${id}`,
      whyItMatters: 'It blocks a sale.',
      recommendedPath: 'Open the same account once.',
      expectedCostCents: cost,
      setupEffort: 'Minutes.',
      nextStep: 'Open it.',
      completionCondition: 'The account is open.',
      blocksState: null,
      candidateId: null,
      requestKey: null,
      continuedAt: null,
      continuationNote: null,
      state: 'OPEN' as const,
      resolution: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: [],
      needs: [need('cnd_1', 5_000), need('cnd_2', 9_000)],
      now: NOW,
    });
    const grouped = review.items.find((item) => item.title.includes('one remedy'))!;
    expect(grouped.costCents).toBe(9_000);
    expect(grouped.costNote).toContain('rather than a total');
  });

  it('leaves a question Brain is already researching off the decision list', () => {
    // It is work in progress, not something to answer. A review that asked
    // about it would be asking somebody to do what Brain had already started.
    const researching = {
      id: 'cnd_9',
      projectId: 'prj_1',
      opportunityId: 'cop_1',
      blockedAction: 'Payer for "A paid intake repair"',
      whyItMatters: 'It is a fact about the world.',
      recommendedPath: 'Read the organisation’s own pages.',
      expectedCostCents: null,
      setupEffort: 'One bounded look.',
      nextStep: 'Name the role that signs.',
      completionCondition: 'A payer is recorded.',
      blocksState: 'EXECUTING' as const,
      candidateId: 'rcn_1',
      requestKey: 'question:cop_1:payer',
      continuedAt: null,
      continuationNote: null,
      state: 'OPEN' as const,
      resolution: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: [],
      needs: [researching],
      now: NOW,
    });
    expect(review.items.some((item) => item.key.startsWith('NEED_'))).toBe(false);
  });

  it('agrees with the card about which blanks Brain looks up', () => {
    // Two readers of one fact. Drift here would put a question Brain already
    // researches back on a person's review, or take one off it that Brain
    // never looks up — and the second is the silent half.
    const card = evidenceCard(opportunity());
    const marked = card.fields.filter((field) => field.discoverable).map((field) => field.key);
    expect([...DISCOVERABLE_FIELDS].sort()).toEqual(marked.sort());
    // And every one of them is load-bearing, or excluding it from the review
    // would hide something the readiness check still refuses on.
    for (const field of card.fields) {
      if (field.discoverable) expect(field.loadBearing).toBe(true);
    }
  });

  it('gives every item an answer naming an operation that already exists', () => {
    // A review that grew its own apply endpoint would be a second way to do
    // each of these, and the second one is always the one that forgets a guard.
    const review = compressedReview({
      mode,
      authority: null,
      position,
      placements: placements({
        opportunities: [opportunity({ priceCents: null }), complete()],
        deployableCents: 100_000,
        maxConcurrent: 3,
        discoveryOpen: true,
      }),
      needs: [],
      now: NOW,
    });
    expect(review.items.length).toBeGreaterThan(0);
    for (const item of review.items) {
      expect(item.answer.label.length).toBeGreaterThan(5);
      expect(item.answer.completionCondition.length).toBeGreaterThan(5);
      // Every group that claims one answer releases everything under it must
      // actually be one act. `sharedRemedy: false` is the honest alternative.
      if (item.sharedRemedy && item.underlying.length > 1) {
        expect(item.answer.kind).not.toBe('FILL_CARD_FIELD');
      }
    }
  });

  it('puts an expiring opening above everything else', () => {
    const expiring = complete({
      expiresAt: '2026-09-16T00:00:00.000Z',
      expiryReason: 'the supplier reprices',
    });
    const review = compressedReview({
      mode,
      authority: {
        id: 'cau_1',
        projectId: 'prj_1',
        ownerUserId: 'usr_1',
        name: 'grant',
        policyVersion: 1,
        allowedActions: ['CONTACT_BUYER'],
        prohibitions: [],
        maxCommittedCents: 100_000,
        maxPerActionCents: 50_000,
        maxConcurrent: 3,
        currency: 'USD',
        startsAt: NOW,
        expiresAt: null,
        state: 'ACTIVE',
        revokedAt: null,
        revokedByUserId: null,
        revokedReason: null,
        createdByUserId: 'usr_1',
        createdAt: NOW,
        updatedAt: NOW,
      },
      position,
      placements: placements({
        opportunities: [expiring, opportunity()],
        deployableCents: 100_000,
        maxConcurrent: 3,
        discoveryOpen: true,
      }),
      needs: [],
      now: NOW,
    });
    expect(review.items[0]!.key).toBe('EXPIRING');
    expect(review.items[0]!.urgency).toBe('URGENT');
  });

  it('says plainly when nothing needs a person', () => {
    const review = compressedReview({
      mode: null,
      authority: null,
      position,
      placements: [],
      needs: [],
      now: NOW,
    });
    expect(review.items).toEqual([]);
    expect(review.summary).toContain('Nothing needs a decision');
  });

  it('tells a person about a shortfall rather than only refusing later', () => {
    const review = compressedReview({
      mode,
      authority: null,
      position: { ...position, deployableCents: -5_000, shortfall: true },
      placements: [],
      needs: [],
      now: NOW,
    });
    expect(review.items.some((item) => item.key === 'SHORTFALL')).toBe(true);
  });
});
