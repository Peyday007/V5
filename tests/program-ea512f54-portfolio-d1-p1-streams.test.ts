/**
 * PORT-05 (S-0063): the goal portfolio read as independent streams — a leading
 * combination, alternates, contingencies, working operations and future bets,
 * with correlation, cash timing, obligations, workforce, QA, outreach limits,
 * crowding and shared constraints modelled per stream and across them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateGoalPortfolio, SHARED_OUTREACH_CORRELATION, UNNAMED_RISK_GROUP_CORRELATION } from '../server/services/goals/portfolio.ts';
import { CORRELATED_AT, MIN_COMOVEMENT_PERIODS, isCorrelated, measureCoMovement, weekOf, weeklyPayments, withMeasuredCoMovement } from '../server/services/goals/streams.ts';
import { readPort05 } from '../server/services/goals/port05.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const fixed = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });

function opening(id: string, over: Partial<ModelledOpportunity> = {}, index = 1, card: Record<string, unknown> = {}): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}`, payer: null, reachableChannel: null, fulfillmentOwner: null, ...card } as unknown as ModelledOpportunity['opportunity'],
    index,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close: fixed(0.2),
    respond: fixed(0.02),
    directCost: fixed(100),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

const limits = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day from two warmed mailboxes', worlds: 600, seed: 7 };

const channel = (resource: string): ModelledOpportunity['channel'] => ({ label: `${resource} leads`, perDay: fixed(20), resource, riskGroup: resource });

describe('PORT-05 streams', () => {
  const openings = [
    opening('lead', {}, 1, { payer: 'Dental practices' }),
    opening('peer', { price: fixed(1200) }, 2, { payer: 'dental  practices' }),
    opening('market', { channel: channel('marketplace') }, 3),
    opening('agreed', { capital: fixed(500), agreed: true, agreedValue: 900, agreedDeals: 1, repeatable: false }, 4),
    opening('bet', { respond: swept(0.001, 0.2) }, 5),
    opening('heavy', { capital: fixed(450) }, 6),
  ];
  const result = evaluateGoalPortfolio({ ...limits, openings });
  const streams = result.streams!;
  const of = (id: string) => streams.streams.find((s) => s.opportunityId === id)!;

  it('assigns every held opening a role derived from best, alternatives and demand, and drops none', () => {
    expect(streams.streams.map((s) => s.opportunityId).sort()).toEqual(openings.map((o) => o.opportunity.id).sort());
    for (const m of result.best!.members) expect(of(m.opportunityId).roles).toContain('LEADING');
    for (const alt of result.alternatives) for (const m of alt.members) if (!result.best!.members.some((b) => b.opportunityId === m.opportunityId)) expect(of(m.opportunityId).role).toBe('ALTERNATE');
    // Money already agreed, refused for its outlay: still a working operation, never discarded.
    expect(of('agreed').roles).toContain('WORKING_OPERATION');
    expect(result.demand.find((d) => d.opportunityId === 'agreed')!.refused).toMatch(/ties up 500/);
    // Refused for its outlay: a future bet, kept with the reason (§47).
    expect(of('heavy')).toMatchObject({ role: 'FUTURE_BET', roles: ['FUTURE_BET'] });
    expect(of('heavy').reason).toMatch(/kept for later: ties up 450/);
    const roles = new Set(streams.streams.flatMap((s) => s.roles));
    for (const r of ['LEADING', 'ALTERNATE', 'WORKING_OPERATION', 'FUTURE_BET'] as const) expect(roles.has(r)).toBe(true);
  });

  it('names a contingency that covers a leading member through a different risk group', () => {
    const os = [1, 2, 3, 4, 5, 6].map((i) => opening(`o${i}`, { price: fixed(1000 + i * 100) }, i));
    os.push(opening('m', { channel: channel('marketplace'), price: fixed(150), close: fixed(0.05) }, 9));
    const r = evaluateGoalPortfolio({ ...limits, openings: os });
    const m = r.streams!.streams.find((s) => s.opportunityId === 'm')!;
    expect(m.roles.includes('LEADING')).toBe(false);
    expect(m.roles).toContain('CONTINGENCY');
    const leadingIds = r.best!.members.map((x) => x.opportunityId);
    expect(m.covers).toEqual(leadingIds);
    // A justified line on the same mailbox as the leader covers nothing.
    for (const s of r.streams!.streams) if (!s.roles.includes('LEADING') && s.riskGroup === 'shared-outreach') expect(s.roles).not.toContain('CONTINGENCY');
  });

  it('models correlation: a shared mailbox is correlated and not independent; a separate channel is assumed independent', () => {
    const lead = of('lead');
    const peer = of('peer');
    const withPeer = lead.correlations.find((c) => c.with === 'peer');
    if (peer.roles.includes('LEADING')) {
      expect(withPeer).toMatchObject({ kind: 'SHARED_RISK_GROUP', coefficient: SHARED_OUTREACH_CORRELATION, basis: 'ASSUMED' });
      expect(lead.independent).toBe(false);
    }
    // Pairwise across leading + alternates.
    for (const p of streams.across.correlations) expect(['SHARED_RISK_GROUP', 'NONE_KNOWN']).toContain(p.kind);
    const market = of('market');
    const vsLead = market.correlations.find((c) => c.with === 'lead');
    if (vsLead) expect(vsLead).toMatchObject({ kind: 'NONE_KNOWN', coefficient: 0, basis: 'ASSUMED' });
  });

  it('reports independence false whenever a binding constraint or a correlated risk group is shared', () => {
    for (const s of streams.streams) {
      const correlated = s.correlations.some(isCorrelated);
      const binding = s.sharedConstraints.some((c) => c.binding);
      expect(s.independent).toBe(!correlated && !binding);
    }
    const r = evaluateGoalPortfolio({ ...limits, remaining: 2000, openings: [opening('solo', { channel: channel('partner') })] });
    expect(r.streams!.streams[0]!.independent).toBe(true);
  });

  it('models cash timing as a per-stream spread and a weekly settled-cash curve against the deadline', () => {
    expect(streams.across.cashCurve.length).toBe(Math.ceil(limits.daysLeft / 7));
    expect(streams.across.cashCurve.at(-1)!.dayEnd).toBe(limits.daysLeft);
    for (let i = 1; i < streams.across.cashCurve.length; i++) expect(streams.across.cashCurve[i]!.p50).toBeGreaterThan(streams.across.cashCurve[i - 1]!.p50);
    // Paced deals are an assumption.
    expect(streams.across.cashCurveBasis).toBe('ASSUMED');
    expect(of('lead').cashTiming).toMatchObject({ settlementDays: { p50: 3 }, settlesBeforeDeadline: true, basis: 'ESTABLISHED' });
  });

  it('models obligations, workforce, QA, outreach limits, crowding and shared constraints with provenance', () => {
    const lead = of('lead');
    expect(lead.deliveryObligations.basis).toBe('ESTABLISHED');
    expect(lead.workforce.hoursPerDeal).toBe(2);
    expect(lead.workforce.hours.p50).toBe(lead.deliveryObligations.expectedDeals.p50 * 2);
    expect(lead.qualityAssurance.checkedBy).toBe('UNSTATED');
    expect(lead.qualityAssurance.basis).toBe('ASSUMED');
    expect(lead.outreach).toMatchObject({ resource: 'outreach', basis: 'ESTABLISHED' });
    expect(lead.outreach!.perDay.high).toBeLessThanOrEqual(40);
    expect(of('agreed').deliveryObligations.agreedDeals).toBe(1);
    expect(of('bet').deliveryObligations.basis).toBe('ASSUMED');
    // Same buyer population, written differently: crowded.
    expect(lead.crowding.sharedWith).toContain('peer');
    expect(streams.across.crowding).toEqual([{ segment: 'dental practices', members: ['lead', 'peer'] }]);
    expect(of('market').crowding).toMatchObject({ segment: null, basis: 'ASSUMED' });
    expect(lead.sharedConstraints.map((c) => c.constraint)).toEqual(expect.arrayContaining(['capital', 'spend ceiling', 'outreach']));
    expect(streams.across.sharedConstraints.map((c) => c.constraint)).toEqual(expect.arrayContaining(['capital', 'spend ceiling', 'outreach']));
  });

  it('a provider-fulfilled stream is checked by acceptance of the provider', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings: [opening('p', { fulfilledBy: { value: 'a subcontractor', provenance: 'EVIDENCE', source: null } })] });
    expect(r.streams!.streams[0]!.qualityAssurance.checkedBy).toBe('ACCEPTANCE_OF_PROVIDER');
  });

  it('leaves every existing field unchanged for existing callers', () => {
    const { streams: _s, ...rest } = evaluateGoalPortfolio({ ...limits, openings });
    const { streams: _t, ...again } = result;
    expect(rest).toEqual(again);
    expect(Object.keys(rest).sort()).toEqual(['alternatives', 'basis', 'best', 'demand', 'limits', 'measuredRates', 'missing', 'searched', 'worlds']);
  });

  it('excludes nothing by category or industry', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings: [opening('x', {}, 1, { industry: 'scrap metal' }), opening('y', {}, 2, { industry: 'software' })] });
    expect(r.streams!.streams.map((s) => s.opportunityId).sort()).toEqual(['x', 'y']);
  });
});

/** A weekly series starting at week `from`: values[i] is the amount received in week from + i. */
const series = (values: number[], from = 2900) => new Map(values.map((v, i) => [from + i, v] as const));

describe('PORT-05 correlation is measured from the streams\' own payments where the rows allow it (F6)', () => {
  const up = [100, 300, 200, 500, 400, 700, 600, 900, 800, 1100];
  const along = up.map((v) => v * 2 + 50);
  const against = up.map((v) => 1200 - v);
  const unrelated = [400, 100, 500, 300, 200, 200, 300, 500, 100, 400];

  it('measures the Pearson co-movement of two weekly series over the weeks both were live', () => {
    expect(measureCoMovement(series(up), series(along))).toEqual({ coefficient: 1, periods: up.length });
    expect(measureCoMovement(series(up), series(against))).toEqual({ coefficient: -1, periods: up.length });
    const r = measureCoMovement(series(up), series(unrelated))!;
    expect(Math.abs(r.coefficient)).toBeLessThan(CORRELATED_AT);
    // Only the shared window counts: b starts two weeks later.
    expect(measureCoMovement(series(up), series(along.slice(2), 2902))!.periods).toBe(up.length - 2);
    // A week with no payment inside the window is a zero, not a gap.
    const holed = new Map(series(along));
    holed.delete(2904);
    expect(measureCoMovement(series(up), holed)!.coefficient).toBeLessThan(1);
  });

  it('refuses to locate a co-movement on too few shared weeks or on a series that never varied', () => {
    expect(measureCoMovement(series(up.slice(0, MIN_COMOVEMENT_PERIODS - 1)), series(along.slice(0, MIN_COMOVEMENT_PERIODS - 1)))).toBeNull();
    expect(measureCoMovement(series(up), series(up.map(() => 250)))).toBeNull();
    expect(measureCoMovement(series(up), undefined)).toBeNull();
    expect(measureCoMovement(series(up, 2900), series(along, 3100))).toBeNull();
  });

  const openings = [
    opening('lead', {}, 1, { payer: 'Dental practices' }),
    opening('peer', { price: fixed(1200) }, 2),
    opening('market', { channel: channel('marketplace') }, 3),
    opening('partner', { channel: channel('partner') }, 4),
  ];

  it('replaces the declared coefficient with the measured one, ESTABLISHED, and keeps what was assumed', () => {
    const measuredSeries = new Map([['lead', series(up)], ['peer', series(unrelated)], ['market', series(along)], ['partner', series(against)]]);
    const declared = evaluateGoalPortfolio({ ...limits, openings }).streams!;
    const r = evaluateGoalPortfolio({ ...limits, openings, measuredSeries }).streams!;
    const leadingIds = new Set(r.streams.filter((s) => s.roles.includes('LEADING')).map((s) => s.opportunityId));
    expect(leadingIds.size).toBeGreaterThan(0);
    for (const s of r.streams) {
      for (const c of s.correlations) {
        const expected = measureCoMovement(measuredSeries.get(s.opportunityId), measuredSeries.get(c.with))!;
        expect(c).toMatchObject({ kind: 'MEASURED', basis: 'ESTABLISHED', coefficient: expected.coefficient, periods: up.length });
        const before = declared.streams.find((d) => d.opportunityId === s.opportunityId)!.correlations.find((d) => d.with === c.with)!;
        expect(c.assumed).toBe(before.coefficient);
      }
    }
    expect(r.across.correlations.length).toBeGreaterThan(0);
    for (const p of r.across.correlations) expect(p).toMatchObject({ kind: 'MEASURED', basis: 'ESTABLISHED', periods: up.length });
    // No pair is left at a declared coefficient once both of its streams have history.
    expect(r.streams.flatMap((s) => s.correlations).some((c) => c.basis === 'ASSUMED')).toBe(false);
  });

  it('reads independence from the measurement: a separate channel whose payments move with a leader is dependent', () => {
    const lead = [...evaluateGoalPortfolio({ ...limits, openings }).best!.members][0]!.opportunityId;
    const measuredSeries = new Map(openings.map((o) => [o.opportunity.id, series(o.opportunity.id === lead || o.opportunity.id === 'market' ? up : unrelated)] as const));
    const r = evaluateGoalPortfolio({ ...limits, openings, measuredSeries }).streams!;
    const market = r.streams.find((s) => s.opportunityId === 'market')!;
    if (market.opportunityId !== lead) {
      const vsLead = market.correlations.find((c) => c.with === lead)!;
      expect(vsLead).toMatchObject({ kind: 'MEASURED', coefficient: 1, basis: 'ESTABLISHED' });
      expect(market.independent).toBe(false);
      expect(market.independence).toMatch(/measured over 10 weeks/);
    }
    for (const s of r.streams) expect(s.independent).toBe(!s.correlations.some(isCorrelated) && !s.sharedConstraints.some((c) => c.binding));
    expect(r.across.independentStreams).toBe(r.streams.filter((s) => s.independent).length);
  });

  it('keeps the declared coefficient, ASSUMED, for a pair the rows cannot measure', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings, measuredSeries: new Map([['lead', series(up)], ['peer', series(along.slice(0, 3))]]) }).streams!;
    const declared = evaluateGoalPortfolio({ ...limits, openings }).streams!;
    expect(r).toEqual(declared);
  });

  it('the plan\'s held reading is re-read against the ledger on the goal read (port05), without changing what was held', async () => {
    const held = evaluateGoalPortfolio({ ...limits, openings }).streams!;
    const snapshot = JSON.parse(JSON.stringify(held));
    const measuredSeries = new Map(openings.map((o, i) => [o.opportunity.id, series(i % 2 === 0 ? up : against)] as const));
    let asked: string[] = [];
    const reading = await readPort05('wst_f6', new Date(), {
      streams: () => held,
      credits: async () => [],
      offers: async () => [],
      measured: async (ids) => {
        asked = ids;
        return measuredSeries;
      },
    });
    expect(asked.sort()).toEqual(openings.map((o) => o.opportunity.id).sort());
    const expected = withMeasuredCoMovement(held, measuredSeries);
    if (!reading.streams.known) throw new Error('streams unknown');
    expect(reading.streams.independentStreams).toBe(expected.across.independentStreams);
    expect(reading.streams.streams.map((s) => s.independence)).toEqual(expected.streams.map((s) => s.independence));
    expect(JSON.parse(JSON.stringify(held))).toEqual(snapshot);
  });

  it('builds the weekly series from ledger payments only: net of refunds, one currency per stream', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 9, 5 + day)).toISOString();
    const out = weeklyPayments([
      { opportunityId: 'a', kind: 'CUSTOMER_PAYMENT', amountCents: 10_000, currency: 'USD', occurredAt: at(0) },
      { opportunityId: 'a', kind: 'CUSTOMER_PAYMENT', amountCents: 5_000, currency: 'USD', occurredAt: at(1) },
      { opportunityId: 'a', kind: 'REFUND', amountCents: 2_000, currency: 'USD', occurredAt: at(2) },
      { opportunityId: 'a', kind: 'CUSTOMER_PAYMENT', amountCents: 7_000, currency: 'USD', occurredAt: at(8) },
      { opportunityId: 'a', kind: 'CUSTOMER_PAYMENT', amountCents: 99_000, currency: 'EUR', occurredAt: at(8) },
      { opportunityId: 'a', kind: 'PIPELINE_AGREED', amountCents: 50_000, currency: 'USD', occurredAt: at(8) },
      { opportunityId: 'a', kind: 'COST', amountCents: 3_000, currency: 'USD', occurredAt: at(8) },
      { opportunityId: null, kind: 'CUSTOMER_PAYMENT', amountCents: 1_000, currency: 'USD', occurredAt: at(0) },
    ]);
    expect([...out.keys()]).toEqual(['a']);
    const weekA = weekOf(at(0))!;
    const weekB = weekOf(at(8))!;
    expect(out.get('a')!.get(weekA)).toBe(130);
    expect(out.get('a')!.get(weekB)).toBe(70);
  });

  it('names the declared coefficient for an unnamed risk group instead of a literal', () => {
    const source = readFileSync(new URL('../server/services/goals/portfolio.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/defaultCorrelation:\s*[0-9.]+/);
    expect(source).toMatch(/defaultCorrelation:\s*UNNAMED_RISK_GROUP_CORRELATION/);
    expect(UNNAMED_RISK_GROUP_CORRELATION).toBeGreaterThan(0);
    // Without rows the declared figure still stands, and says so.
    const r = evaluateGoalPortfolio({ ...limits, openings }).streams!;
    for (const c of r.streams.flatMap((s) => s.correlations)) expect(c.basis).toBe('ASSUMED');
    expect(SHARED_OUTREACH_CORRELATION).toBeGreaterThan(0);
  });
});
