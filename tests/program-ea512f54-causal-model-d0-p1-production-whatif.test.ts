/**
 * Finding F6 (CAUSAL-14-4, 14-7): what-if propagation across connected
 * openings, branch generation and the decomposition of an AI business were
 * exercised only on graphs a caller posted to /causal. They now run on every
 * goal-portfolio evaluation, over the graphs built from Brain's own rows, so
 * production records carry them.
 */
import { describe, expect, it } from 'vitest';
import { causalOf, evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const sourced = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: { kind: 'CLAIM', ref: 'clm_1' }, note: '' } as ModelInput);

function opening(id: string, row: Partial<ModelledOpportunity['opportunity']>, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: {
      id, title: `Opening ${id}`, payer: 'Acme Property', reachableChannel: 'email', offerScope: 'weekly cleaning', acceptanceCondition: null,
      paymentTerms: 'net 30', deadline: null, currency: 'USD', createdAt: '2026-11-01T00:00:00.000Z', requiredCapabilities: [],
      fulfillmentOwner: 'Spotless Subcontracting', mechanism: 'BROKER', peakFundingCents: null, projectId: 'prj_test', ...row,
    } as ModelledOpportunity['opportunity'],
    index: 1, tier: 'QUALIFIED', repeatable: false,
    price: sourced(1_000), capital: sourced(300), hours: sourced(1), daysToCash: sourced(30), close: sourced(0.5), respond: sourced(1),
    directCost: sourced(600), volume: sourced(1), agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false,
    ...over,
  };
}

describe('the graph answers decision questions on the production path', () => {
  const a = opening('opp_a', {});
  const b = opening('opp_b', { payer: 'Beta Offices' });
  const reading = causalOf([a, b], [], 45)!;

  it('a prepayment opens a viable branch beside the original route and frees capital for the other opening', () => {
    const answer = reading.members[0]!.whatIf.find((one) => one.id === 'opp_a:prepaid')!;
    expect(answer.branch).toMatchObject({ routeId: 'sale:prepaid', viable: true });
    const here = answer.effects[0]!;
    expect(here.before).toMatchObject({ daysToCash: 30, capitalCents: 30_000 });
    expect(here.after).toMatchObject({ daysToCash: 0, capitalCents: 0, freeCentsOnDelivery: 40_000 });
    const there = answer.effects.find((one) => one.opportunityId === 'opp_b')!;
    expect(there.after.ceilingRoomFreedCents).toBe(30_000);
    // The branch is in the complete account, not only in the answer.
    expect(reading.account!.routes.some((route) => route.route.endsWith('sale:prepaid'))).toBe(true);
    expect(answer.unknowns).toContainEqual({ opportunityId: 'opp_a', unknown: 'whether Acme Property will pay in full before delivery', sendTo: 'authorized action' });
  });

  it('a late supplier propagates to every opening that shares it, with the delay each tolerates before the deadline', () => {
    const answer = reading.members[0]!.whatIf.find((one) => one.id === 'opp_a:supplier-late')!;
    expect(answer.effects.map((one) => one.opportunityId).sort()).toEqual(['opp_a', 'opp_b']);
    expect(answer.effects.find((one) => one.opportunityId === 'opp_b')!.via).toContain('Spotless Subcontracting');
    expect(answer.effects[0]!.after.toleratesDelayDays).toBe(15);
    expect(answer.breaks.some((one) => one.includes('deliver'))).toBe(true);
    expect(reading.decisionUnknowns).toContainEqual({ opportunityId: 'opp_a', unknown: 'how reliably Spotless Subcontracting delivers on time', sendTo: 'research' });
  });

  it('an unprofitable prepayment is reported as a branch that is not viable and is not added', () => {
    const loss = causalOf([opening('opp_c', {}, { directCost: sourced(1_500) })], [], 45)!;
    const answer = loss.members[0]!.whatIf.find((one) => one.id === 'opp_c:prepaid')!;
    expect(answer.branch).toMatchObject({ viable: false });
    expect(loss.account!.routes.some((route) => route.route.endsWith('sale:prepaid'))).toBe(false);
  });

  it('added advertising on an outreach opening is unknown, not the old rate scaled, and is sent to research', () => {
    const out = causalOf([opening('opp_d', {}, { repeatable: true, volume: sourced(50) })], [], 45)!;
    const answer = out.members[0]!.whatIf.find((one) => one.id === 'opp_d:advertising')!;
    expect(answer.effects[0]!.after.outputUnits).toBeNull();
    expect(answer.unknowns[0]!.sendTo).toBe('research');
  });

  it('an opening Brain fulfils is decomposed into observable subproblems, each UNKNOWN, with what its row says attached', () => {
    const ai = causalOf([opening('opp_e', { fulfillmentOwner: 'Brain', acceptanceCondition: 'buyer approves the draft' })], [], 45)!;
    const parts = ai.members[0]!.decomposition!;
    expect(parts.map((one) => one.id)).toEqual(expect.arrayContaining(['demand', 'capability', 'unit-cost', 'payment', 'failure']));
    expect(parts.every((one) => one.status === 'UNKNOWN')).toBe(true);
    expect(parts.find((one) => one.id === 'acceptance')!.stated).toBe('buyer approves the draft');
    expect(reading.members[0]!.decomposition).toBeNull();
  });

  it('evaluateGoalPortfolio carries the answers and sends their unknowns by name', () => {
    const result = evaluateGoalPortfolio({ remaining: 500, daysLeft: 45, capitalCeiling: 3_000, beforeProof: 1_000, perWeek: 1_000, resources: null, worlds: 200, seed: 3, openings: [a, b] });
    const members = result.causal?.members ?? [];
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((one) => one.whatIf.length > 0)).toBe(true);
    expect(result.missing.some((one) => one.startsWith('research: how reliably Spotless Subcontracting'))).toBe(true);
  });
});
