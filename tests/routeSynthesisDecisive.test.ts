import { describe, expect, it } from 'vitest';
import { repeatsForRunRate } from '../server/services/cash/goalScenario.ts';
import { observationExpiry } from '../server/domain/opportunitySignals.ts';
import { routeBuyer, routeOffer } from '../server/services/cash/routeEvidence.ts';

/** Fixes from the decisive-10 readings (2026-11-25, docs/PLANNING-ROUTE-GENERATION-2026-11-25.md). */
describe('a route that repeats counts toward a monthly run-rate', () => {
  const o = (signal: string | null) => ({ title: 'Records retrieval for personal injury firms', opportunitySignal: signal as never, payer: 'Personal injury law firms', industry: 'legal services' });
  it('reads a per-period price as recurring, as before', () => {
    expect(repeatsForRunRate(o(null), '$300 a month', null)).toBe(true);
  });
  it('reads a recurring-outsourced pattern as recurring, whatever one transaction is called', () => {
    expect(repeatsForRunRate(o('RECURRING_OUTSOURCED_WORK'), '$45 flat fee per request', null)).toBe(true);
  });
  it('reads a stated repeat purchase in the market evidence as recurring', () => {
    expect(repeatsForRunRate(o('ACTIVE_BUYER_DEMAND'), '$45 per request', 'About 1,600 personal injury law firms each order records every month.')).toBe(true);
  });
  it('leaves a one-off with no stated repeat out of a run-rate', () => {
    expect(repeatsForRunRate(o('ACTIVE_BUYER_DEMAND'), '$2,000 one-time', 'About 1,600 personal injury law firms are listed.')).toBe(false);
  });
});

describe('route names', () => {
  it('splits "<kind of buyer> · <what they pay for>"', () => {
    expect(routeBuyer('Michigan dental practices · HIPAA risk assessment')).toBe('Michigan dental practices');
    expect(routeOffer('Michigan dental practices · HIPAA risk assessment')).toBe('HIPAA risk assessment');
    expect(routeOffer('Michigan dental practices')).toBeNull();
  });
});

describe('a point-in-time signal still expires', () => {
  it('ages out a dated single request after the freshness window', () => {
    const now = new Date('2026-11-25T00:00:00Z');
    expect(observationExpiry({ signal: 'ACTIVE_BUYER_DEMAND', closesOn: null, sourceDate: '2026-09-04', freshDays: 30, now }).stale).toBe(true);
    expect(observationExpiry({ signal: 'RECURRING_OUTSOURCED_WORK', closesOn: null, sourceDate: '2026-09-04', freshDays: 30, now }).stale).toBe(false);
  });
});
