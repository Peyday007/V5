/**
 * Compiling an opportunity into something somebody can actually do.
 *
 * The three properties worth pinning are the three this file could most easily
 * have got wrong, and two of them are refusals.
 */
import { describe, expect, it } from 'vitest';
import { CASH_ACTORS, executionPath } from '../server/services/cash/execution.ts';
import type { CashNeed, CashOpportunity } from '../server/domain/types.ts';

function opportunity(over: Partial<CashOpportunity> = {}): CashOpportunity {
  return {
    id: 'cop_test',
    projectId: 'prj_test',
    candidateId: null,
    discoveredByCandidateId: null,
    title: 'A piece of work',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    payer: 'A named county clerk',
    reachableChannel: 'the published procurement address',
    buyingSignal: 'a published RFQ',
    signalObservedAt: '2026-09-01T00:00:00.000Z',
    offerScope: 'one indexed extract, delivered as CSV',
    acceptanceCondition: 'the extract matches the published schema',
    priceCents: 120_000,
    currency: 'USD',
    paymentTerms: 'net 15 on delivery',
    fulfillmentOwner: 'Brain',
    deliveryMethod: 'a download link',
    requiredInputs: 'access to the register',
    deadline: null,
    economicsNote: null,
    peakFundingCents: 20_000,
    humanHours: 4,
    expiresAt: null,
    expiryReason: null,
    dependsOnId: null,
    duplicateOfId: null,
    requiredCapabilities: [],
    executionAsset: null,
    assetRevision: null,
    state: 'READY',
    exhaustedAt: null,
    exhaustedReason: null,
    nextAction: null,
    nextActionDue: null,
    outcome: null,
    stopRule: 'stop after three approaches with no reply',
    declinedByUserId: null,
    declinedReason: null,
    reofferedFromId: null,
    archivedReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  } as CashOpportunity;
}

describe('an opportunity compiled backwards from settled cash', () => {
  it('assigns every step a real actor, and never invents one for the user', () => {
    const path = executionPath(opportunity());
    expect(path.steps.length).toBeGreaterThan(4);
    for (const step of path.steps) {
      expect(CASH_ACTORS).toContain(step.actor);
      // The half that makes a step checkable rather than reportable.
      expect(step.artifact.length).toBeGreaterThan(10);
      expect(step.action.length).toBeGreaterThan(10);
    }
    // There is no actor meaning "somebody" — the closed set is the guarantee.
    expect(CASH_ACTORS).not.toContain('USER' as never);
  });

  it('orders the steps so nothing depends on something later in the list', () => {
    const path = executionPath(opportunity());
    const seen = new Set<string>();
    for (const step of path.steps) {
      for (const dependency of step.dependsOn) {
        expect(seen.has(dependency)).toBe(true);
      }
      seen.add(step.key);
    }
  });

  it('puts every world-touching step behind the reversible ones', () => {
    const path = executionPath(opportunity());
    const firstExternal = path.steps.findIndex((s) => s.external);
    expect(firstExternal).toBeGreaterThan(2);
    // And names each one as needing a person, with a reason.
    for (const step of path.steps.filter((s) => s.external)) {
      expect(path.needsAPerson.some((n) => n.key === step.key)).toBe(true);
    }
    for (const entry of path.needsAPerson) expect(entry.because.length).toBeGreaterThan(10);
  });

  it('gives three cash ranges from stated figures, with the assumptions named', () => {
    const path = executionPath(opportunity());
    // 120_000 per sale, 20_000 exposure spent once.
    expect(path.range.conservativeCents).toBe(100_000);
    expect(path.range.baseCents).toBe(340_000);
    expect(path.range.upsideCents).toBe(580_000);
    expect(path.range.withheld).toEqual([]);
    expect(path.range.assumptions.length).toBeGreaterThan(2);
    // Unpriced effort is reported beside the money and never inside it.
    expect(path.range.assumptions.some((a) => a.includes('excluded from these figures'))).toBe(true);
  });

  it('withholds the range rather than estimating, and says which input is missing', () => {
    const noPrice = executionPath(opportunity({ priceCents: null }));
    expect(noPrice.range.conservativeCents).toBeNull();
    expect(noPrice.range.baseCents).toBeNull();
    expect(noPrice.range.upsideCents).toBeNull();
    expect(noPrice.range.withheld.join(' ')).toContain('price');

    // A margin against an unknown cost fails in the direction that makes a
    // piece look worth doing, so the exposure is load-bearing too.
    const noExposure = executionPath(opportunity({ peakFundingCents: null }));
    expect(noExposure.range.conservativeCents).toBeNull();
    expect(noExposure.range.withheld.join(' ')).toContain('capital exposure');
  });

  it('names the cheapest decisive test only while something load-bearing is open', () => {
    expect(executionPath(opportunity({ payer: null })).fastestDecisiveTest).toContain('who exactly pays');
    expect(executionPath(opportunity({ priceCents: null })).fastestDecisiveTest).toContain('sells for');
    expect(executionPath(opportunity({ buyingSignal: null })).fastestDecisiveTest).toContain('asking to buy');
    // Everything established: null rather than a manufactured suggestion.
    expect(executionPath(opportunity()).fastestDecisiveTest).toBeNull();
  });

  it('carries an open need through as a blocker rather than planning around it', () => {
    const need = {
      id: 'cnd_1',
      projectId: 'prj_test',
      opportunityId: 'cop_test',
      blockedAction: 'SEND_A_MESSAGE',
      nextStep: 'connect a sending route',
      state: 'OPEN',
    } as CashNeed;
    const path = executionPath(opportunity(), [need]);
    expect(path.blockedBy.join(' ')).toContain('SEND_A_MESSAGE');
    expect(path.blockedBy.join(' ')).toContain('connect a sending route');
    // A need for another piece is not this piece's blocker.
    const elsewhere = executionPath(opportunity(), [{ ...need, opportunityId: 'cop_other' }]);
    expect(elsewhere.blockedBy).toEqual([]);
  });

  it('offers no scale threshold where nobody set a stop rule', () => {
    expect(executionPath(opportunity()).scaleThreshold).not.toBeNull();
    expect(executionPath(opportunity()).killThreshold).toContain('three approaches');
    const noRule = executionPath(opportunity({ stopRule: null }));
    expect(noRule.scaleThreshold).toBeNull();
    expect(noRule.killThreshold).toBeNull();
  });
});
