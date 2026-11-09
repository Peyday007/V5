/**
 * COM-13-3: the outreach funnel counts buyers from stage inputs, and messages
 * sent are effort only. These tests assert the clauses the code only commented.
 */
import { describe, expect, it } from 'vitest';
import {
  mechanismsFromRows,
  modelOutreachFunnel,
  type OutreachOutcomeRow,
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

describe('outreach funnel from production rows', () => {
  const row = (opp: string, kind: string, text: string | null = null, cents: number | null = null, mech = 'mail'): OutreachOutcomeRow => ({
    mechanism: mech,
    channel: null,
    opportunity_id: opp,
    kind,
    value_cents: cents,
    value_text: text,
  });
  // p1 bounced; p2 silent; p3 declined; p4 countered only; p5 and p6 accepted (p5 settled, p6 refunded). p5 was contacted twice.
  const rows: OutreachOutcomeRow[] = [
    row('p1', 'CONTACT_RESULT', 'CONTACT_UNDELIVERABLE'),
    row('p2', 'CONTACT_RESULT', 'BUYER_SILENT'),
    row('p3', 'CONTACT_RESULT', 'BUYER_DECLINED'),
    row('p4', 'CONTACT_RESULT', 'BUYER_COUNTERED'),
    row('p5', 'CONTACT_RESULT', 'BUYER_SILENT'),
    row('p5', 'CONTACT_RESULT', 'BUYER_ACCEPTED'),
    row('p6', 'CONTACT_RESULT', 'BUYER_ACCEPTED'),
    row('p5', 'ACCEPTED_PRICE', null, 20_000),
    row('p6', 'ACCEPTED_PRICE', null, 20_000),
    row('p6', 'REFUNDED'),
  ];

  it('states every stage but repeat from rows, per prospect, and ranks the mechanism on production data alone', () => {
    const [mech] = mechanismsFromRows(rows, { settledOpportunities: new Set(['p5']), contactPermitted: true });
    const r = modelOutreachFunnel(mech!);
    expect(r.stages.uniqueProspects.low).toBe(6); // six prospects, seven results
    expect(r.messagesSent).toBe(7);
    expect(r.stages.deliverability.low).toBeCloseTo(5 / 6);
    expect(r.stages.qualification.low).toBeCloseTo(3 / 4); // answered {p3,p4,p5,p6}; qualified {p4,p5,p6}
    expect(r.stages.close.low).toBeCloseTo(2 / 3);
    expect(r.stages.settlement.low).toBeCloseTo(1 / 2);
    expect(r.stages.fulfillment.low).toBeCloseTo(1 / 2);
    expect(r.stages.repeat.basis).toBe('UNKNOWN');
    expect(r.firstPurchaseRevenueCents.basis).not.toBe('UNKNOWN');
    expect(r.revenueCents.basis).toBe('UNKNOWN'); // repeat is stated by no row
    expect(searchOutreachMix(mechanismsFromRows(rows, { settledOpportunities: new Set(['p5']), contactPermitted: true })).ranked).toHaveLength(1);
  });

  it('never ranks when nothing states permission or settlement, and never reads a missing grant as a refusal', () => {
    const noGrant = modelOutreachFunnel(mechanismsFromRows(rows, { settledOpportunities: new Set(['p5']) })[0]!);
    expect(noGrant.permitted).toBeNull();
    expect(noGrant.firstPurchaseRevenueCents.basis).toBe('UNKNOWN');
    const noSettlement = modelOutreachFunnel(mechanismsFromRows(rows, { contactPermitted: true })[0]!);
    expect(noSettlement.stages.settlement.basis).toBe('UNKNOWN');
    expect(noSettlement.firstPurchaseRevenueCents.basis).toBe('UNKNOWN');
  });

  it('more recorded contacts for the same prospects add no buyers', () => {
    const more = [...rows, row('p2', 'CONTACT_RESULT', 'BUYER_SILENT'), row('p2', 'CONTACT_RESULT', 'BUYER_SILENT')];
    const ctx = { settledOpportunities: new Set(['p5']), contactPermitted: true };
    const a = modelOutreachFunnel(mechanismsFromRows(rows, ctx)[0]!);
    const b = modelOutreachFunnel(mechanismsFromRows(more, ctx)[0]!);
    expect(b.buyers).toEqual(a.buyers);
    expect(b.messagesSent).toBe(9);
  });
});
