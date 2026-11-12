/**
 * The owner's own sends answer ahead of a published reply-rate range (§92):
 * `instantlyMeasuredRates()` reads the workspace's analytics, and the quant
 * engine samples every cold-outreach opening's reply rate inside what those
 * sends allow. The fetch is injected; api.instantly.ai is never called.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetInstantlyCapacity, instantlyMeasuredRates } from '../server/services/cash/providers/instantly.ts';
import { evaluateGoalPortfolio, measuredReplyInterval } from '../server/services/goals/portfolio.ts';
import type { FetchLike } from '../server/services/cash/providers/http.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const ENV = { BRAIN_MESSAGING_PROVIDER: 'instantly', INSTANTLY_API_KEY: 'instantly_test_SECRETVALUE_never_stored_0007' } as NodeJS.ProcessEnv;

/** The owner's workspace as read on 2026-11-09: four campaigns, 4 096 sends. */
const CAMPAIGNS = [
  { campaign_id: 'c1', emails_sent_count: 2000, reply_count_unique: 8, total_opportunities: 1, bounced_count: 190 },
  { campaign_id: 'c2', emails_sent_count: 1096, reply_count_unique: 4, total_opportunities: 1, bounced_count: 106 },
  { campaign_id: 'c3', emails_sent_count: 600, reply_count_unique: 2, total_opportunities: 0, bounced_count: 60 },
  { campaign_id: 'c4', emails_sent_count: 400, reply_count_unique: 1, total_opportunities: 0, bounced_count: 40 },
];

function fake(rows: unknown) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${String(init.method)} ${new URL(url).pathname}`);
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  return { calls, fetchImpl };
}

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });

function opening(id: string, respond: ModelInput, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close: fixed(0.2),
    respond,
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

const limits = { remaining: 10_000, daysLeft: 24, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day', worlds: 1500, seed: 7 };

beforeEach(() => forgetInstantlyCapacity());

describe('instantlyMeasuredRates', () => {
  it('sums the four counts over every campaign, read only', async () => {
    const f = fake(CAMPAIGNS);
    expect(await instantlyMeasuredRates({ fetch: f.fetchImpl, env: ENV })).toMatchObject({ sent: 4096, replies: 15, opportunities: 2, bounced: 396 });
    expect(f.calls).toEqual(['GET /api/v2/campaigns/analytics']);
  });

  it('is fresh for ten minutes, then asked again', async () => {
    const f = fake(CAMPAIGNS);
    await instantlyMeasuredRates({ fetch: f.fetchImpl, env: ENV, now: 1_000 });
    await instantlyMeasuredRates({ fetch: f.fetchImpl, env: ENV, now: 1_000 + 9 * 60_000 });
    expect(f.calls).toHaveLength(1);
    await instantlyMeasuredRates({ fetch: f.fetchImpl, env: ENV, now: 1_000 + 11 * 60_000 });
    expect(f.calls).toHaveLength(2);
  });

  it('is null under 500 sends', async () => {
    const f = fake([{ emails_sent_count: 300, reply_count_unique: 3, total_opportunities: 1, bounced_count: 5 }]);
    expect(await instantlyMeasuredRates({ fetch: f.fetchImpl, env: ENV })).toBeNull();
  });

  it('is null, and asks nothing, when Instantly is not the provider', async () => {
    const f = fake(CAMPAIGNS);
    expect(await instantlyMeasuredRates({ fetch: f.fetchImpl, env: {} as NodeJS.ProcessEnv })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

describe('cold-outreach reply rates from the owner\'s own sends', () => {
  const rates = { sent: 4096, replies: 15, opportunities: 2, bounced: 396 };
  const interval = measuredReplyInterval(rates)!;

  it('puts the interval between the Wilson 90% lower of opportunities and upper of replies', () => {
    expect(interval.low).toBeGreaterThan(0);
    expect(interval.low).toBeLessThan(2 / 4096);
    expect(interval.high).toBeGreaterThan(15 / 4096);
    expect(interval.high).toBeLessThan(0.01);
  });

  it('does not let a defective record from other campaigns bind a redesigned plan: it is read as the as-is floor (§99)', () => {
    const openings = [opening('swept', swept(0.0045, 0.0343)), opening('card', fixed(0.03))].map((one, i) => ({ ...one, index: i + 1 }));
    const result = evaluateGoalPortfolio({ ...limits, openings, measuredRates: rates });
    expect(result.measuredRates).toMatchObject({ sent: 4096, replies: 15, opportunities: 2, bounced: 396, applied: 'AS_IS_FLOOR_ONLY' });
    expect(result.measuredRates!.assessment.authority).toBe('CONTEXT_ONLY');
    expect(result.measuredRates!.assessment.defects.map((d) => d.kind)).toEqual(expect.arrayContaining(['LIST_QUALITY', 'DIFFERENT_OFFER']));
    // The redesigned plan keeps its own evidence…
    expect(result.demand.find((d) => d.opportunityId === 'card')!.respond.p50).toBeCloseTo(0.03, 9);
    // …and the record still answers what it can: the same plan if nothing improves.
    expect(result.measuredRates!.asIs).not.toBeNull();
    expect(result.measuredRates!.asIs!.settledP50).toBeLessThan(result.best!.settledP50);
  });

  it('binds only when told to (the as-is floor itself), sampling inside the measured interval', () => {
    const openings = [opening('swept', swept(0.0045, 0.0343)), opening('card', fixed(0.03))].map((one, i) => ({ ...one, index: i + 1 }));
    const result = evaluateGoalPortfolio({ ...limits, openings, measuredRates: rates, forceMeasured: true });
    for (const d of result.demand) {
      expect(d.respond.p10).toBeGreaterThanOrEqual(interval.low - 1e-9);
      expect(d.respond.p90).toBeLessThanOrEqual(interval.high + 1e-9);
    }
    expect(result.measuredRates!.applied).toBe('BINDS');
  });

  it('a sound record from Brain\'s own campaigns is comparable: it moves an unknown\'s floor and leaves a card\'s rate', () => {
    const sound = { sent: 4000, replies: 60, opportunities: 12, bounced: 40, campaigns: [{ name: 'Brain · buyer outreach', sent: 4000, replies: 60, opportunities: 12, bounced: 40, brainOwned: true }] };
    const openings = [opening('swept', swept(0.0005, 0.0343)), opening('card', fixed(0.03))].map((one, i) => ({ ...one, index: i + 1 }));
    const result = evaluateGoalPortfolio({ ...limits, openings, measuredRates: sound });
    expect(result.measuredRates!.assessment.authority).toBe('COMPARABLE');
    expect(result.measuredRates!.applied).toBe('FLOOR_OF_RANGE');
    const floor = measuredReplyInterval(sound)!.low;
    expect(result.demand.find((d) => d.opportunityId === 'swept')!.respond.p10).toBeGreaterThanOrEqual(floor - 1e-9);
    expect(result.demand.find((d) => d.opportunityId === 'card')!.respond.p50).toBeCloseTo(0.03, 9);
  });

  it('keeps a card rate that already lies inside the interval, and leaves a plan without measured rates alone', () => {
    const inside = (interval.low + interval.high) / 2;
    const kept = evaluateGoalPortfolio({ ...limits, openings: [opening('card', fixed(inside))], measuredRates: rates });
    expect(kept.demand[0]!.respond.p50).toBeCloseTo(inside, 9);
    const plain = evaluateGoalPortfolio({ ...limits, openings: [opening('card', fixed(0.03))] });
    expect(plain.demand[0]!.respond.p50).toBeCloseTo(0.03, 9);
    expect(plain.measuredRates ?? null).toBeNull();
  });

  it('does not touch a one-off, an agreed sale, or a per-contact measurement', () => {
    const result = evaluateGoalPortfolio({
      ...limits,
      openings: [
        opening('once', fixed(0.03), { repeatable: false, index: 1 }),
        opening('agreed', fixed(0.03), { agreedValue: 500, agreed: true, index: 2 }),
        opening('lesson', { ...fixed(1), provenance: 'HISTORICAL' }, { index: 3 }),
      ],
      measuredRates: rates,
    });
    expect(result.demand.map((d) => d.respond.p50)).toEqual([0.03, 0.03, 1]);
  });

  it('is ignored below the sends the provider reports as null', () => {
    const result = evaluateGoalPortfolio({ ...limits, openings: [opening('card', fixed(0.03))], measuredRates: null });
    expect(result.demand[0]!.respond.p50).toBeCloseTo(0.03, 9);
  });
});
