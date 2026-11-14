/**
 * PORT-05 (S-0063): the goal portfolio read as independent streams — a leading
 * combination, alternates, contingencies, working operations and future bets,
 * with correlation, cash timing, obligations, workforce, QA, outreach limits,
 * crowding and shared constraints modelled per stream and across them.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio, SHARED_OUTREACH_CORRELATION } from '../server/services/goals/portfolio.ts';
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
