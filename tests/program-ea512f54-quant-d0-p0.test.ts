/**
 * COM-13-3: the outreach funnel counts buyers from stage inputs, and messages
 * sent are effort only. These tests assert the clauses the code only commented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  cashFunnel,
  formatFunnel,
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

describe('outreach funnel read from cash_outcomes rows (outreachFromRows via cashFunnel)', () => {
  let projectId = '';
  let seq = 0;

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  async function outcome(o: {
    opp: string;
    kind: 'CONTACT_RESULT' | 'ACCEPTED_PRICE' | 'REFUNDED';
    mechanism?: string | null;
    channel?: string | null;
    cents?: number | null;
    text?: string | null;
  }): Promise<void> {
    seq += 1;
    await getDb().run(
      `INSERT INTO cash_outcomes
         (id, project_id, opportunity_id, kind, mechanism, channel, value_cents, value_text, basis, request_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `cou_test_${seq}`,
        projectId,
        o.opp,
        o.kind,
        o.mechanism ?? null,
        o.channel ?? null,
        o.cents ?? null,
        o.text ?? null,
        'test rows',
        `req-${seq}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
      ],
    );
  }

  it('reports no mechanism, and says so, when no outcome row exists', async () => {
    const reading = await cashFunnel({ projectId });
    expect(reading.outreach.mechanisms).toEqual([]);
    expect(reading.outreach.mix).toEqual({ ranked: [], unranked: [] });
    expect(formatFunnel(reading).join('\n')).toMatch(/no mechanism has recorded an outcome yet/);
  });

  it('maps bounce, answered, accepted and refund rows to measured stage shares', async () => {
    // 10 contacts: 2 bounced, 3 silent, 5 answered. 2 agreed (prices 100 and 300), 1 of those refunded.
    for (let i = 0; i < 2; i += 1) await outcome({ opp: `b${i}`, kind: 'CONTACT_RESULT', mechanism: 'M', text: 'CONTACT_UNDELIVERABLE' });
    for (let i = 0; i < 3; i += 1) await outcome({ opp: `s${i}`, kind: 'CONTACT_RESULT', mechanism: 'M', text: 'BUYER_SILENT' });
    for (let i = 0; i < 5; i += 1) await outcome({ opp: `a${i}`, kind: 'CONTACT_RESULT', mechanism: 'M', text: 'BUYER_REPLIED' });
    await outcome({ opp: 'a0', kind: 'ACCEPTED_PRICE', mechanism: 'M', cents: 100 });
    await outcome({ opp: 'a1', kind: 'ACCEPTED_PRICE', mechanism: 'M', cents: 300 });
    await outcome({ opp: 'a1', kind: 'REFUNDED', mechanism: 'M' });

    const { outreach } = await cashFunnel({ projectId });
    expect(outreach.mechanisms).toHaveLength(1);
    const m = outreach.mechanisms[0]!;
    expect(m.mode).toBe('M');
    expect(m.messagesSent).toBe(10);
    expect(m.stages.deliverability).toMatchObject({ basis: 'MEASURED', low: 0.8, high: 0.8 });
    expect(m.stages.response.low).toBeCloseTo(5 / 8);
    expect(m.stages.close.low).toBeCloseTo(2 / 5);
    expect(m.stages.fulfillment.low).toBeCloseTo(1 / 2);
    // Rows never state these, so they stay unknown rather than defaulting.
    for (const stage of ['permission', 'uniqueProspects', 'throughput', 'qualification', 'settlement', 'repeat'] as const) {
      expect(m.stages[stage].basis, stage).toBe('UNKNOWN');
    }
    expect(m.permitted).toBeNull();
    expect(m.buyers.basis).toBe('UNKNOWN');
    expect(m.revenueCents.basis).toBe('UNKNOWN');
  });

  it('groups by mechanism, falling back to channel, then "unspecified"', async () => {
    await outcome({ opp: 'x', kind: 'CONTACT_RESULT', mechanism: 'Alpha', channel: 'email', text: 'BUYER_SILENT' });
    await outcome({ opp: 'y', kind: 'CONTACT_RESULT', channel: 'phone', text: 'BUYER_SILENT' });
    await outcome({ opp: 'z', kind: 'CONTACT_RESULT', text: 'BUYER_SILENT' });
    await outcome({ opp: 'w', kind: 'CONTACT_RESULT', mechanism: 'Alpha', text: 'BUYER_SILENT' });
    const { outreach } = await cashFunnel({ projectId });
    expect(outreach.mechanisms.map((one) => one.mode)).toEqual(['Alpha', 'phone', 'unspecified']);
    expect(outreach.mechanisms.find((one) => one.mode === 'Alpha')!.messagesSent).toBe(2);
  });

  it('keeps unknown, not zero, for shares with no denominator', async () => {
    await outcome({ opp: 'only', kind: 'CONTACT_RESULT', mechanism: 'M', text: 'CONTACT_UNDELIVERABLE' });
    const m = (await cashFunnel({ projectId })).outreach.mechanisms[0]!;
    expect(m.stages.deliverability).toMatchObject({ basis: 'MEASURED', low: 0 });
    expect(m.stages.response.basis).toBe('UNKNOWN');
    expect(m.stages.close.basis).toBe('UNKNOWN');
    expect(m.stages.fulfillment.basis).toBe('UNKNOWN');
  });

  it('never ranks a row-derived mechanism: no row states permission, so every one is unranked with its first unknown stage', async () => {
    for (let i = 0; i < 50; i += 1) await outcome({ opp: `c${i}`, kind: 'CONTACT_RESULT', mechanism: 'Big', text: 'BUYER_REPLIED' });
    await outcome({ opp: 'c0', kind: 'ACCEPTED_PRICE', mechanism: 'Big', cents: 1_000_000 });
    const { outreach } = await cashFunnel({ projectId });
    expect(outreach.mix.ranked).toEqual([]);
    expect(outreach.mix.unranked).toHaveLength(1);
    expect(outreach.mix.unranked[0]).toMatchObject({ mode: 'Big', firstUnknown: 'permission' });
    expect(formatFunnel(await cashFunnel({ projectId })).join('\n')).toMatch(/outreach mix ranked=\(none\) unranked=Big\[permission\]/);
  });
});
