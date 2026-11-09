/**
 * COM-13-3: the outreach funnel counts buyers from stage inputs, and messages
 * sent are effort only. These tests assert the clauses the code only commented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  cashFunnel,
  considerOutreachWays,
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
      reputation: m(1),
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

describe('outreach mix: cost, combination and unmeasured ways', () => {
  it('ranks on net of cost, and an unknown cost never outranks a known one', () => {
    const cheap = mechanism({ mode: 'cheap', costCents: m(1_000) });
    const costly = mechanism({ mode: 'costly', costCents: m(100_000) });
    const uncosted = mechanism({ mode: 'uncosted' });
    const mix = searchOutreachMix([uncosted, costly, cheap]);
    expect(mix.ranked.map((r) => r.mode)).toEqual(['cheap', 'costly', 'uncosted']);
    expect(mix.ranked[0]!.netFirstPurchaseCents.low).toBe(mix.ranked[0]!.firstPurchaseRevenueCents.low! - 1_000);
    expect(mix.ranked[2]!.netFirstPurchaseCents.basis).toBe('UNKNOWN');
  });

  it('a cost larger than revenue ranks below a smaller, cheaper mechanism', () => {
    const big = mechanism({ mode: 'big', dealValueCents: m(1_000_000), costCents: m(10_000_000) });
    const small = mechanism({ mode: 'small', costCents: m(10) });
    expect(searchOutreachMix([big, small]).ranked.map((r) => r.mode)).toEqual(['small', 'big']);
  });

  it('combines the ranked mechanisms, net only when every cost is known', () => {
    const a = mechanism({ mode: 'a', costCents: m(100) });
    const b = mechanism({ mode: 'b', costCents: m(200) });
    const one = modelOutreachFunnel(a).firstPurchaseRevenueCents.low!;
    const both = searchOutreachMix([a, b]).combined!;
    expect(both.modes.sort()).toEqual(['a', 'b']);
    expect(both.firstPurchaseRevenueCents.low).toBeCloseTo(2 * one);
    expect(both.netCents!.low).toBeCloseTo(2 * one - 300);
    expect(searchOutreachMix([a, mechanism({ mode: 'c' })]).combined!.netCents).toBeNull();
    expect(searchOutreachMix([]).combined).toBeNull();
  });

  it('lists each named way as an open task until a mechanism of that mode exists, without excluding other modes', () => {
    const ways = considerOutreachWays([mechanism({ mode: 'Partner-Access' }), mechanism({ mode: 'something-else' })]);
    expect(ways.find((w) => w.key === 'partner-access')!.status).toBe('MODELLED');
    expect(ways.filter((w) => w.status === 'NO_MECHANISM_RECORDED').map((w) => w.key)).toEqual([
      'high-value-deals',
      'many-small-deals',
      'customer-request-marketplace',
    ]);
    expect(searchOutreachMix([mechanism({ mode: 'something-else' })]).ranked).toHaveLength(1);
  });
});

describe('outreach funnel read from cash_outcomes rows (outreachFromRows via cashFunnel)', () => {
  let projectId = '';
  let seq = 0;
  // What a caller who has read the authority row and the workspace states: permitted, 100 a day, all 2 accounts healthy.
  const stated = {
    permission: m(1),
    sending: { perDay: 100, healthyAccounts: 2, totalAccounts: 2 },
  };

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
    const reading = await cashFunnel({ projectId, outreachEvidence: stated });
    expect(reading.outreach.mechanisms).toEqual([]);
    expect(reading.outreach.mix).toEqual({ ranked: [], unranked: [], combined: null });
    // Ways nobody has measured are still listed, as open tasks, not silently absent.
    expect(reading.outreach.consideredWays.map((w) => w.key)).toEqual([
      'high-value-deals',
      'many-small-deals',
      'partner-access',
      'customer-request-marketplace',
    ]);
    expect(reading.outreach.consideredWays.every((w) => w.status === 'NO_MECHANISM_RECORDED' && w.firstUnknown === 'permission')).toBe(true);
    expect(formatFunnel(reading).join('\n')).toMatch(/ways to reach demand with no recorded mechanism/);
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

    const { outreach } = await cashFunnel({ projectId, outreachEvidence: stated });
    expect(outreach.mechanisms).toHaveLength(1);
    const m = outreach.mechanisms[0]!;
    expect(m.mode).toBe('M');
    expect(m.messagesSent).toBe(10);
    expect(m.stages.deliverability).toMatchObject({ basis: 'MEASURED', low: 0.8, high: 0.8 });
    expect(m.stages.response.low).toBeCloseTo(5 / 8);
    // The 2 prospects that agreed are the only ones that engaged with terms: 2 of 5 answered qualified, and both closed.
    expect(m.stages.qualification.low).toBeCloseTo(2 / 5);
    expect(m.stages.close.low).toBeCloseTo(1);
    expect(m.stages.fulfillment.low).toBeCloseTo(1 / 2);
    // Permission and capacity are stated by the evidence handed in, not inferred from the contacts: 10 distinct
    // prospects are read from the rows, throughput is 100 a day over the one day they span.
    expect(m.stages.permission).toMatchObject({ basis: 'MEASURED', low: 1, high: 1 });
    expect(m.stages.uniqueProspects).toMatchObject({ basis: 'MEASURED', low: 10 });
    expect(m.stages.throughput).toMatchObject({ basis: 'MEASURED', low: 100 });
    expect(m.stages.reputation).toMatchObject({ basis: 'MEASURED', low: 1 });
    expect(m.permitted).toBe(true);
    // 10 sent, 8 delivered, 5 answered, 2 qualified, 2 bought: messages are not buyers.
    expect(m.buyers.low).toBeCloseTo(2);
    // No settlement and no repeat purchase exists yet. Unknown is not zero, so revenue stays unknown.
    for (const stage of ['settlement', 'repeat'] as const) {
      expect(m.stages[stage].basis, stage).toBe('UNKNOWN');
    }
    expect(m.revenueCents.basis).toBe('UNKNOWN');
  });

  it('groups by mechanism, falling back to channel, then "unspecified"', async () => {
    await outcome({ opp: 'x', kind: 'CONTACT_RESULT', mechanism: 'Alpha', channel: 'email', text: 'BUYER_SILENT' });
    await outcome({ opp: 'y', kind: 'CONTACT_RESULT', channel: 'phone', text: 'BUYER_SILENT' });
    await outcome({ opp: 'z', kind: 'CONTACT_RESULT', text: 'BUYER_SILENT' });
    await outcome({ opp: 'w', kind: 'CONTACT_RESULT', mechanism: 'Alpha', text: 'BUYER_SILENT' });
    const { outreach } = await cashFunnel({ projectId, outreachEvidence: stated });
    expect(outreach.mechanisms.map((one) => one.mode)).toEqual(['Alpha', 'phone', 'unspecified']);
    expect(outreach.mechanisms.find((one) => one.mode === 'Alpha')!.messagesSent).toBe(2);
  });

  it('keeps unknown, not zero, for shares with no denominator', async () => {
    await outcome({ opp: 'only', kind: 'CONTACT_RESULT', mechanism: 'M', text: 'CONTACT_UNDELIVERABLE' });
    const m = (await cashFunnel({ projectId, outreachEvidence: stated })).outreach.mechanisms[0]!;
    expect(m.stages.deliverability).toMatchObject({ basis: 'MEASURED', low: 0 });
    expect(m.stages.response.basis).toBe('UNKNOWN');
    expect(m.stages.close.basis).toBe('UNKNOWN');
    expect(m.stages.fulfillment.basis).toBe('UNKNOWN');
  });

  async function settlement(opp: string, cents: number): Promise<void> {
    seq += 1;
    await getDb().run(
      `INSERT INTO cash_money_entries
         (id, project_id, opportunity_id, kind, amount_cents, currency, verified_reference, occurred_at, recorded_by, created_at)
       VALUES (?, ?, ?, 'SETTLEMENT', ?, 'USD', 'ref', ?, 'test', ?)`,
      [`cme_test_${seq}`, projectId, opp, cents, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
    );
  }

  it('leaves a row-derived mechanism unranked at the stage no row states yet: settlement', async () => {
    for (let i = 0; i < 50; i += 1) await outcome({ opp: `c${i}`, kind: 'CONTACT_RESULT', mechanism: 'Big', text: 'BUYER_REPLIED' });
    await outcome({ opp: 'c0', kind: 'ACCEPTED_PRICE', mechanism: 'Big', cents: 1_000_000 });
    const { outreach } = await cashFunnel({ projectId, outreachEvidence: stated });
    expect(outreach.mix.ranked).toEqual([]);
    expect(outreach.mix.unranked).toHaveLength(1);
    expect(outreach.mix.unranked[0]).toMatchObject({ mode: 'Big', firstUnknown: 'settlement' });
    expect(formatFunnel(await cashFunnel({ projectId, outreachEvidence: stated })).join('\n')).toMatch(/outreach mix ranked=\(none\) unranked=Big\[settlement\]/);
  });

  it('ranks mechanisms on production rows once settlement is recorded, strongest lower bound first', async () => {
    for (let i = 0; i < 20; i += 1) await outcome({ opp: `big${i}`, kind: 'CONTACT_RESULT', mechanism: 'Big', text: 'BUYER_REPLIED' });
    await outcome({ opp: 'big0', kind: 'ACCEPTED_PRICE', mechanism: 'Big', cents: 1_000_000 });
    await settlement('big0', 1_000_000);
    for (let i = 0; i < 20; i += 1) await outcome({ opp: `sm${i}`, kind: 'CONTACT_RESULT', mechanism: 'Small', text: 'BUYER_REPLIED' });
    for (let i = 0; i < 5; i += 1) {
      await outcome({ opp: `sm${i}`, kind: 'ACCEPTED_PRICE', mechanism: 'Small', cents: 10_000 });
      await settlement(`sm${i}`, 10_000);
    }
    await outcome({ opp: 'quiet', kind: 'CONTACT_RESULT', mechanism: 'Quiet', text: 'BUYER_SILENT' });
    const { outreach } = await cashFunnel({ projectId, outreachEvidence: stated });
    expect(outreach.mix.ranked.map((one) => one.mode)).toEqual(['Big', 'Small']);
    expect(outreach.mix.ranked[0]!.firstPurchaseRevenueCents.low).toBeGreaterThan(outreach.mix.ranked[1]!.firstPurchaseRevenueCents.low!);
    expect(outreach.mix.unranked.map((one) => one.mode)).toEqual(['Quiet']);
  });

  it('does not read contacts having been sent as permission, capacity or reputation (§39)', async () => {
    for (let i = 0; i < 10; i += 1) await outcome({ opp: `u${i}`, kind: 'CONTACT_RESULT', mechanism: 'M', text: 'BUYER_REPLIED' });
    const m = (await cashFunnel({ projectId, outreachEvidence: {} })).outreach.mechanisms[0]!;
    for (const stage of ['permission', 'throughput', 'reputation'] as const) expect(m.stages[stage].basis, stage).toBe('UNKNOWN');
    expect(m.permitted).toBeNull();
    expect(m.buyers.basis).toBe('UNKNOWN');
    expect(m.reachedProspects.basis).toBe('UNKNOWN');
  });

  it('reads a refusing standing authority as a no, and an absent one as unknown', async () => {
    await outcome({ opp: 'p', kind: 'CONTACT_RESULT', mechanism: 'M', text: 'BUYER_REPLIED' });
    const refused = (await cashFunnel({ projectId, outreachEvidence: { ...stated, permission: m(0) } })).outreach.mechanisms[0]!;
    expect(refused.permitted).toBe(false);
    // With no grant row in this project, reading the evidence from the rows says nobody has said.
    const fromRows = (await cashFunnel({ projectId })).outreach.mechanisms[0]!;
    expect(fromRows.stages.permission.basis).toBe('UNKNOWN');
    expect(fromRows.permitted).toBeNull();
  });

  it('lets the sending cap bind: throughput is the accounts\' capacity, not the contacts already sent', async () => {
    for (let i = 0; i < 50; i += 1) await outcome({ opp: `c${i}`, kind: 'CONTACT_RESULT', mechanism: 'M', text: 'BUYER_REPLIED' });
    const cap = { permission: m(1), sending: { perDay: 10, healthyAccounts: 1, totalAccounts: 1 } };
    const reading = (await cashFunnel({ projectId, outreachEvidence: cap })).outreach.mechanisms[0]!;
    expect(reading.stages.throughput.low).toBe(10);
    expect(reading.reachedProspects.low).toBe(10); // 50 deliverable prospects, only 10 can be sent to
    const ample = (await cashFunnel({ projectId, outreachEvidence: { permission: m(1), sending: { perDay: 1000, healthyAccounts: 1, totalAccounts: 1 } } })).outreach.mechanisms[0]!;
    expect(ample.reachedProspects.low).toBe(50);
  });

  it('scales capacity by the share of sending accounts in good standing', async () => {
    for (let i = 0; i < 50; i += 1) await outcome({ opp: `r${i}`, kind: 'CONTACT_RESULT', mechanism: 'M', text: 'BUYER_REPLIED' });
    const half = { permission: m(1), sending: { perDay: 40, healthyAccounts: 1, totalAccounts: 2 } };
    const reading = (await cashFunnel({ projectId, outreachEvidence: half })).outreach.mechanisms[0]!;
    expect(reading.stages.reputation.low).toBe(0.5);
    expect(reading.reachedProspects.low).toBe(20);
  });

  it('makes reached prospects unknown while the sending accounts\' reputation is unknown', () => {
    const { reputation: _r, ...rest } = mechanism().inputs;
    const r = modelOutreachFunnel(mechanism({ inputs: rest }));
    expect(r.reachedProspects.basis).toBe('UNKNOWN');
    expect(r.buyers.basis).toBe('UNKNOWN');
  });
});
