/**
 * COM-13-3: the outreach funnel counts buyers from stage inputs, and messages
 * sent are effort only. These tests assert the clauses the code only commented.
 */
import { describe, expect, it } from 'vitest';
import {
  modelOutreachFunnel,
  searchOutreachMix,
  type OutreachMechanism,
  type StageInput,
} from '../server/services/cash/funnel.ts';

const m = (value: number): StageInput => ({ basis: 'MEASURED', value });

function mechanism(overrides: Partial<OutreachMechanism> = {}): OutreachMechanism {
  return {
    mode: 'any',
    label: 'test mechanism',
    inputs: {
      permission: m(1),
      uniqueProspects: m(1000),
      deliverability: m(0.9),
      throughput: m(5000),
      response: m(0.1),
      qualification: m(0.5),
      close: m(0.2),
      settlement: m(1),
      fulfillment: m(1),
      repeat: m(0),
    },
    dealValueCents: m(10_000),
    ...overrides,
  };
}

describe('outreach funnel: messages are not buyers', () => {
  it('computes a known funnel from stage inputs', () => {
    const r = modelOutreachFunnel(mechanism());
    expect(r.permitted).toBe(true);
    expect(r.reachedProspects.low).toBeCloseTo(900);
    expect(r.buyers.low).toBeCloseTo(900 * 0.1 * 0.5 * 0.2);
    expect(r.firstPurchaseRevenueCents.low).toBeCloseTo(r.buyers.low! * 10_000);
  });

  it('leaves buyers and revenue unchanged when messagesSent grows', () => {
    const base = modelOutreachFunnel(mechanism({ messagesSent: 10 }));
    const huge = modelOutreachFunnel(mechanism({ messagesSent: 1_000_000 }));
    const none = modelOutreachFunnel(mechanism());
    expect(huge.messagesSent).toBe(1_000_000);
    expect(base.messagesSent).toBe(10);
    expect(none.messagesSent).toBeNull();
    for (const r of [base, huge]) {
      expect(r.reachedProspects).toEqual(none.reachedProspects);
      expect(r.buyers).toEqual(none.buyers);
      expect(r.firstPurchaseRevenueCents).toEqual(none.firstPurchaseRevenueCents);
      expect(r.revenueCents).toEqual(none.revenueCents);
    }
  });

  it('caps reached prospects at sending throughput', () => {
    const capped = modelOutreachFunnel(
      mechanism({ inputs: { ...mechanism().inputs, throughput: m(100) } }),
    );
    expect(capped.reachedProspects.low).toBe(100);
    expect(capped.reachedProspects.high).toBe(100);
    expect(capped.buyers.low).toBeCloseTo(100 * 0.1 * 0.5 * 0.2);
  });

  it('makes every figure unknown, not zero, when permission is refused', () => {
    const r = modelOutreachFunnel(mechanism({ inputs: { ...mechanism().inputs, permission: m(0) } }));
    expect(r.permitted).toBe(false);
    for (const f of [r.reachedProspects, r.responders, r.qualified, r.buyers, r.firstPurchaseRevenueCents, r.revenueCents]) {
      expect(f.basis).toBe('UNKNOWN');
      expect(f.low).toBeNull();
      expect(f.high).toBeNull();
    }
    expect(r.firstUnknown).toBe('permission');
  });

  it('makes every figure unknown when permission is unknown, missing or only estimated', () => {
    const cases: Partial<OutreachMechanism['inputs']>[] = [
      { ...mechanism().inputs, permission: { basis: 'UNKNOWN' } },
      { ...mechanism().inputs, permission: { basis: 'ESTIMATED', low: 0, high: 1 } },
      { ...mechanism().inputs, permission: m(0.5) },
      (({ permission: _p, ...rest }) => rest)(mechanism().inputs),
    ];
    for (const inputs of cases) {
      const r = modelOutreachFunnel(mechanism({ inputs }));
      expect(r.permitted).toBeNull();
      expect(r.buyers.basis).toBe('UNKNOWN');
      expect(r.buyers.low).toBeNull();
      expect(r.firstPurchaseRevenueCents.basis).toBe('UNKNOWN');
    }
  });

  it('propagates an unknown stage to everything after it', () => {
    const r = modelOutreachFunnel(
      mechanism({ inputs: { ...mechanism().inputs, response: { basis: 'UNKNOWN' } } }),
    );
    expect(r.reachedProspects.basis).not.toBe('UNKNOWN');
    for (const f of [r.responders, r.qualified, r.buyers, r.settledBuyers, r.firstPurchaseRevenueCents, r.revenueCents]) {
      expect(f.basis).toBe('UNKNOWN');
      expect(f.low).toBeNull();
    }
    expect(r.firstUnknown).toBe('response');
  });

  it('treats an out-of-range share as unknown rather than clamping it', () => {
    const r = modelOutreachFunnel(mechanism({ inputs: { ...mechanism().inputs, close: m(1.5) } }));
    expect(r.buyers.basis).toBe('UNKNOWN');
  });

  it('never ranks a mechanism with an unknown or refused stage, however many messages it sends', () => {
    const good = mechanism({ mode: 'good', label: 'good' });
    const refused = mechanism({
      mode: 'refused',
      label: 'refused',
      messagesSent: 1_000_000,
      inputs: { ...mechanism().inputs, permission: m(0) },
    });
    const mix = searchOutreachMix([refused, good]);
    expect(mix.ranked.map((r) => r.mode)).toEqual(['good']);
    expect(mix.unranked.map((u) => u.mode)).toEqual(['refused']);
    expect(mix.unranked[0]?.firstUnknown).toBe('permission');
  });
});
