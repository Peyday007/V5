/**
 * A refunded hand-back is bounded by the item's own row (production 2026-11-25:
 * wki_18acf737c7fe460a8c9f at lease generation 26, attempt count 0 — 1,255
 * leases RELEASED beside 746 SUCCEEDED in 6 h, fragments that found no readable
 * source while web search refused, refunded for ever).
 */
import { describe, expect, it } from 'vitest';
import { MAX_REFUNDED_RELEASES, refundedReleasesSoFar, refundsFailure } from '../server/services/freeLane/worker.ts';

const none = { transient: false, brainUnavailable: false, searchOutage: false, providerFailure: false, strikes: 0, releasesSoFar: 0 };

describe('free-lane refund bound', () => {
  it('reads the refunded hand-backs from the claim: generation less attempt', () => {
    // A claim raises both; a release refunds only the attempt.
    expect(refundedReleasesSoFar({ leaseGeneration: 27, attemptNumber: 1 })).toBe(26);
    expect(refundedReleasesSoFar({ leaseGeneration: 1, attemptNumber: 1 })).toBe(0);
    expect(refundedReleasesSoFar({ leaseGeneration: 2, attemptNumber: 2 })).toBe(0);
  });

  it('refunds a search outage while under the bound, and charges it past the bound', () => {
    expect(refundsFailure({ ...none, searchOutage: true, strikes: 9, releasesSoFar: MAX_REFUNDED_RELEASES - 1 })).toBe(true);
    expect(refundsFailure({ ...none, searchOutage: true, strikes: 1, releasesSoFar: MAX_REFUNDED_RELEASES })).toBe(false);
    expect(refundsFailure({ ...none, searchOutage: true, strikes: 1, releasesSoFar: 26 })).toBe(false);
  });

  it('keeps the three-strike limit on a reply with no JSON, and the durable bound under it', () => {
    expect(refundsFailure({ ...none, transient: true, strikes: 2 })).toBe(true);
    expect(refundsFailure({ ...none, transient: true, strikes: 3 })).toBe(false);
    expect(refundsFailure({ ...none, transient: true, strikes: 1, releasesSoFar: MAX_REFUNDED_RELEASES })).toBe(false);
  });

  it('always refunds a route outage, which says nothing about the item', () => {
    expect(refundsFailure({ ...none, transient: true, providerFailure: true, strikes: 9, releasesSoFar: 40 })).toBe(true);
    expect(refundsFailure({ ...none, brainUnavailable: true, providerFailure: true, strikes: 9, releasesSoFar: 40 })).toBe(true);
  });

  it('never refunds an answer Brain refused', () => {
    expect(refundsFailure(none)).toBe(false);
  });
});
