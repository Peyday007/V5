/**
 * PORT-05 (S-0063): the goal portfolio read as independent streams — a leading
 * combination, alternates, contingencies, working operations and future bets,
 * with correlation, cash timing, obligations, workforce, QA, outreach limits,
 * crowding and shared constraints modelled per stream and across them.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio, SHARED_OUTREACH_CORRELATION } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { correlatedTogether, measureCoMovement, measuredGroupCorrelations, measuredTogether, MIN_CO_MOVEMENT_PERIODS, withMeasuredCoMovement, type ObservedOutcome } from '../server/services/goals/streams.ts';
import { readPort05 } from '../server/services/goals/port05.ts';

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
      const correlated = s.correlations.some((c) => c.kind === 'SHARED_RISK_GROUP' && c.coefficient > 0);
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

/*
 * Finding F6: correlations were entirely assumed — a shared risk group took a
 * declared 0.5, everything else 0, always ASSUMED, and no measured co-movement
 * was read. Where the ledger shows two streams' buyer money over enough shared
 * weeks, the pair is now measured, the optimizer's group coefficient comes
 * from it, and the PORT-05 reader re-measures the held reading from rows.
 */
describe('PORT-05 correlation is measured where the ledger can measure it', () => {
  const WEEK = 7 * 24 * 3600 * 1000;
  const start = Date.parse('2026-08-03T12:00:00Z');
  const series = (id: string, amounts: number[]): ObservedOutcome[] =>
    amounts.map((amount, w) => ({ opportunityId: id, occurredAt: new Date(start + w * WEEK).toISOString(), amount })).filter((o) => o.amount !== 0);
  const up = [100, 900, 200, 1200, 150, 1000, 300, 1100, 250, 950];
  const same = up.map((x) => x * 1.4 + 30);
  const unrelated = [500, 520, 480, 510, 490, 505, 495, 515, 485, 500].map((x, i) => (i % 3 === 0 ? x + 400 : x));

  it('measures co-movement from weekly buyer money, with its interval and weeks, and refuses a window too short to locate anything', () => {
    const m = measureCoMovement(series('a', up), series('b', same))!;
    expect(m.periods).toBe(10);
    expect(m.coefficient).toBeGreaterThan(0.99);
    expect(m.interval.low).toBeGreaterThan(0);
    expect(measuredTogether(m)).toBe(true);
    const anti = measureCoMovement(series('a', up), series('b', up.map((x) => 2000 - x)))!;
    expect(anti.coefficient).toBeLessThan(-0.99);
    expect(measuredTogether(anti)).toBe(false);
    expect(measureCoMovement(series('a', up.slice(0, MIN_CO_MOVEMENT_PERIODS - 1)), series('b', same.slice(0, MIN_CO_MOVEMENT_PERIODS - 1)))).toBeNull();
    // A flat series has no variance to correlate.
    expect(measureCoMovement(series('a', up), series('b', up.map(() => 10)))).toBeNull();
  });

  const openings = [
    opening('lead', {}, 1, { payer: 'Dental practices' }),
    opening('peer', { price: fixed(1200) }, 2, { payer: 'dental  practices' }),
    opening('market', { channel: channel('marketplace') }, 3),
  ];

  it('without ledger money the structural reading stands and says where each coefficient came from', () => {
    const r = evaluateGoalPortfolio({ ...limits, openings });
    expect(r.limits).toMatchObject({ correlation: SHARED_OUTREACH_CORRELATION, correlationBasis: 'DECLARED' });
    for (const p of r.streams!.across.correlations) {
      expect(p.kind).not.toBe('MEASURED_CO_MOVEMENT');
      expect(p.source).toBe(p.kind === 'SHARED_RISK_GROUP' ? 'DECLARED' : 'NONE');
    }
    expect(r.streams!.across.measuredPairs).toBe(0);
  });

  it('a shared-outreach pair with measured money is ESTABLISHED, and its measurement sets the optimizer coefficient', () => {
    const observed = [...series('lead', up), ...series('peer', unrelated)];
    const expected = measureCoMovement(series('lead', up), series('peer', unrelated))!;
    const r = evaluateGoalPortfolio({ ...limits, openings, observedOutcomes: observed });
    expect(r.limits.correlationBasis).toBe('MEASURED');
    expect(r.limits.correlation).toBeCloseTo(Math.min(0.95, Math.max(0, expected.coefficient)), 10);
    expect(r.limits.riskGroups).toEqual(expect.arrayContaining([expect.objectContaining({ riskGroup: 'shared-outreach', source: 'MEASURED', measuredPairs: 1 })]));
    expect(r.limits.riskGroups).toEqual(expect.arrayContaining([expect.objectContaining({ riskGroup: 'marketplace', source: 'DECLARED', measuredPairs: 0 })]));
    const s = r.streams!;
    const lead = s.streams.find((x) => x.opportunityId === 'lead')!;
    const vsPeer = lead.correlations.find((c) => c.with === 'peer');
    const pair = s.across.correlations.find((p) => (p.a === 'lead' && p.b === 'peer') || (p.a === 'peer' && p.b === 'lead'));
    for (const c of [vsPeer, pair].filter(Boolean)) {
      expect(c).toMatchObject({ kind: 'MEASURED_CO_MOVEMENT', basis: 'ESTABLISHED', source: 'MEASURED' });
      expect(c!.coefficient).toBeCloseTo(expected.coefficient, 10);
      expect(c!.measured!.periods).toBe(10);
      expect(c!.structural).toMatchObject({ kind: 'SHARED_RISK_GROUP', coefficient: SHARED_OUTREACH_CORRELATION, source: 'DECLARED' });
    }
    expect(vsPeer ?? pair).toBeDefined();
    // Not shown to move together: the correlation no longer makes them dependent (the shared mailbox still binds).
    if (vsPeer) {
      expect(correlatedTogether(vsPeer)).toBe(expected.interval.low > 0);
      expect(lead.independence).not.toMatch(/moves with peer through shared-outreach/);
    }
  });

  it('the held reading is re-measured: a pair assumed independent that the ledger shows moving together is not independent', () => {
    const held = evaluateGoalPortfolio({ ...limits, openings }).streams!;
    const target = held.streams.find((s) => s.correlations.some((c) => c.kind === 'NONE_KNOWN'))!;
    expect(target).toBeDefined();
    const other = target.correlations.find((c) => c.kind === 'NONE_KNOWN')!.with;
    const measured = withMeasuredCoMovement(held, [...series(target.opportunityId, up), ...series(other, same)]);
    const after = measured.streams.find((s) => s.opportunityId === target.opportunityId)!;
    const c = after.correlations.find((x) => x.with === other)!;
    expect(c).toMatchObject({ kind: 'MEASURED_CO_MOVEMENT', basis: 'ESTABLISHED', source: 'MEASURED', structural: { kind: 'NONE_KNOWN', coefficient: 0 } });
    expect(after.independent).toBe(false);
    expect(after.independence).toMatch(new RegExp(`moves with ${other}: measured`));
    expect(measured.across.independentStreams).toBe(measured.streams.filter((s) => s.independent).length);
    // Nothing measured: the same reading back.
    expect(withMeasuredCoMovement(held, [])).toBe(held);
  });

  it('an unmeasured pair in a measured risk group carries the group measurement, still ASSUMED for itself', () => {
    const three = [...openings, opening('third', { price: fixed(1300) }, 4)];
    const held = evaluateGoalPortfolio({ ...limits, openings: three }).streams!;
    const groups = measuredGroupCorrelations(new Map(held.streams.map((s) => [s.opportunityId, s.riskGroup] as const)), [...series('lead', up), ...series('peer', same)]);
    expect(groups.get('shared-outreach')!.pairs).toBe(1);
    const measured = withMeasuredCoMovement(held, [...series('lead', up), ...series('peer', same)]);
    const carried = measured.streams.flatMap((s) => s.correlations).filter((c) => c.source === 'GROUP_MEASUREMENT');
    for (const c of carried) expect(c).toMatchObject({ kind: 'SHARED_RISK_GROUP', basis: 'ASSUMED', coefficient: Math.min(0.95, groups.get('shared-outreach')!.coefficient) });
  });

  it('the PORT-05 reader measures the held streams from the money it reads and shows each pair', async () => {
    const held = evaluateGoalPortfolio({ ...limits, openings }).streams!;
    const ids = held.across.correlations.map((p) => [p.a, p.b] as const)[0]!;
    const asked: string[][] = [];
    const reading = await readPort05('wst_f6', new Date(), {
      streams: () => held,
      observed: async (opportunityIds) => {
        asked.push([...opportunityIds]);
        return [...series(ids[0], up), ...series(ids[1], same)];
      },
      credits: async () => [],
      offers: async () => [],
    });
    expect(asked[0]!.sort()).toEqual(held.streams.map((s) => s.opportunityId).sort());
    if (!reading.streams.known) throw new Error('streams unknown');
    expect(reading.streams.measuredPairs).toBe(1);
    expect(reading.streams.correlations.find((c) => c.a === ids[0] && c.b === ids[1])).toMatchObject({ kind: 'MEASURED_CO_MOVEMENT', basis: 'ESTABLISHED', source: 'MEASURED', measured: { periods: 10 } });
  });
});
