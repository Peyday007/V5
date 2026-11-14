/**
 * PORT-05, the goal reading: `port05.ts` composes the streams of the goal's
 * latest portfolio, the capability credit judged from rows and the offer
 * readiness decided from rows, and `model.ts` carries it on `GoalView` — the
 * one goal derivation — for a person's read. Nothing is invented where a part
 * is unknown, and the whole-Brain tick does not pay for it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Count, without changing, the reads a goals read pays for (finding F5): the
// real owners answer; the counters only say how often they were asked.
const reads = vi.hoisted(() => ({ authority: 0, capabilities: 0 }));
vi.mock('../server/services/cash/authority.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/cash/authority.ts')>();
  return {
    ...actual,
    checkCommercialAuthority: (...args: Parameters<typeof actual.checkCommercialAuthority>) => {
      reads.authority += 1;
      return actual.checkCommercialAuthority(...args);
    },
  };
});
vi.mock('../server/services/cash/capabilities.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/cash/capabilities.ts')>();
  return {
    ...actual,
    readAllCapabilities: () => {
      reads.capabilities += 1;
      return actual.readAllCapabilities();
    },
  };
});
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { createWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import { composePort05, noteGoalPortfolio, noteGoalStreamsCleared, port05ReadContext, readPort05 } from '../server/services/goals/port05.ts';
import type { StreamsReading, PortfolioStream } from '../server/services/goals/streams.ts';
import type { CapabilityCredit } from '../server/services/goals/capabilityCredit.ts';
import type { OfferReadiness } from '../server/services/goals/offerReadiness.ts';

const stream = (opportunityId: string, role: PortfolioStream['role'], independent: boolean): PortfolioStream =>
  ({ opportunityId, title: `t-${opportunityId}`, role, roles: [role], reason: `${role} because`, independent, independence: independent ? 'shares nothing binding' : 'shares the outreach' }) as unknown as PortfolioStream;

const STREAMS = {
  streams: [stream('cop_a', 'LEADING', true), stream('cop_b', 'ALTERNATE', false), stream('cop_c', 'FUTURE_BET', true)],
  across: { independentStreams: 2 },
} as unknown as StreamsReading;

const credit = (opportunityId: string, credited: boolean): CapabilityCredit => ({
  opportunityId,
  projectId: 'prj',
  mode: credited ? 'SELF_OPERABLE' : 'PROVIDER_ORGANIZED',
  credited,
  providerDelivered: false,
  ownerPhysicallyAbsent: credited ? null : true,
  aiPerformable: [],
  deliveryCapabilities: [],
  evidence: credited ? [{ kind: 'CAPABILITY', ref: 'PRODUCE_DOCUMENT', note: 'PRESENT' }] : [],
  missingEvidence: credited ? [] : ['a delivered fulfilment by the provider'],
  reason: credited ? 'every delivery capability is PRESENT' : 'a provider performs it',
});

const readiness = (sales: OfferReadiness['lanes']['sales'], contactBlocked: boolean): OfferReadiness =>
  ({
    policy: 'SQUEEZE',
    offerable: sales !== 'NOT_YET',
    missing: [],
    marketTestRequired: false,
    offerNow: sales === 'RUNNABLE',
    actions: [
      { action: 'CONTACT', grant: 'customer_contact', may: !contactBlocked, blocker: contactBlocked ? { reason: 'no live commercial authority', allowedBy: 'a live commercial authority that allows customer_contact' } : null },
      { action: 'INVOICE', grant: 'invoicing', may: true, blocker: null },
    ],
    lanes: { research: 'RUNNABLE', sales, salesBecause: `sales ${sales}` },
    internal: [],
  }) as unknown as OfferReadiness;

describe('the composition', () => {
  it('names stream roles and independence, credited capabilities with evidence, and offers going or blocked per permission', () => {
    const reading = composePort05({
      goalId: 'wst_g',
      streams: STREAMS,
      credits: [credit('cop_a', true), credit('cop_b', false)],
      offers: [
        { opportunityId: 'cop_a', readiness: readiness('RUNNABLE', false) },
        { opportunityId: 'cop_b', readiness: readiness('BLOCKED', true) },
      ],
    });
    expect(reading.streams).toMatchObject({ known: true, independentStreams: 2, roles: { LEADING: 1, ALTERNATE: 1, FUTURE_BET: 1 } });
    if (!reading.streams.known) throw new Error('unknown');
    expect(reading.streams.streams.find((s) => s.opportunityId === 'cop_b')).toMatchObject({ role: 'ALTERNATE', independent: false, independence: 'shares the outreach' });
    expect(reading.credits.find((c) => c.opportunityId === 'cop_a')).toMatchObject({ credited: true, mode: 'SELF_OPERABLE', evidence: [{ kind: 'CAPABILITY', ref: 'PRODUCE_DOCUMENT' }] });
    expect(reading.credits.find((c) => c.opportunityId === 'cop_b')).toMatchObject({ credited: false, missingEvidence: ['a delivered fulfilment by the provider'] });
    expect(reading.offers.find((o) => o.opportunityId === 'cop_a')).toMatchObject({ offerNow: true, sales: 'RUNNABLE', research: 'RUNNABLE', blocked: [], going: ['CONTACT', 'INVOICE'] });
    expect(reading.offers.find((o) => o.opportunityId === 'cop_b')).toMatchObject({
      offerNow: false,
      sales: 'BLOCKED',
      research: 'RUNNABLE',
      blocked: [{ action: 'CONTACT', reason: 'no live commercial authority', allowedBy: 'a live commercial authority that allows customer_contact' }],
      going: ['INVOICE'],
    });
    expect(reading.summary).toEqual({ credited: 1, notCredited: 1, offersGoing: 1, offersBlocked: 1, offersNotYet: 0 });
  });

  it('says the streams are unknown when no portfolio is held, rather than inventing them', () => {
    const reading = composePort05({ goalId: 'wst_g', streams: null, credits: [], offers: [] });
    expect(reading.streams).toMatchObject({ known: false });
    if (reading.streams.known) throw new Error('known');
    expect(reading.streams.reason).toMatch(/No portfolio reading/);
  });

  it('takes the streams the goal plan handed over, and forgets them when the plan has none', async () => {
    noteGoalStreamsCleared();
    const deps = { credits: async () => [], offers: async () => [] };
    expect((await readPort05('wst_g', new Date(), deps)).streams.known).toBe(false);
    noteGoalPortfolio('wst_g', { streams: STREAMS });
    expect((await readPort05('wst_g', new Date(), deps)).streams).toMatchObject({ known: true, independentStreams: 2 });
    noteGoalPortfolio('wst_g', null);
    expect((await readPort05('wst_g', new Date(), deps)).streams.known).toBe(false);
  });
});

describe('GoalView carries it, from rows', () => {
  let projectId = '';
  let userId = '';

  beforeEach(async () => {
    noteGoalStreamsCleared();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `p5-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  afterAll(async () => {
    await teardown();
  });

  it('a person’s read derives the reading for each live goal; the whole-Brain tick does not', async () => {
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const opened = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Monthly bookkeeping for dental practices', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'dental', source: 'https://example.com/b' });
    if (!opened.ok) throw new Error(opened.reason);
    await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: opened.value.id, relation: 'PURSUES', recordedBy: 'PERSON', recordedByUserId: userId });
    noteGoalPortfolio(goal.id, { streams: { streams: [stream(opened.value.id, 'LEADING', true)], across: { independentStreams: 1 } } as unknown as StreamsReading });

    const read = await assembleGoals({ projectIds: [projectId] });
    const view = read.goals.find((one) => one.id === goal.id)!;
    expect(view.port05).toBeTruthy();
    const p5 = view.port05!;
    expect(p5.streams).toMatchObject({ known: true, independentStreams: 1, roles: { LEADING: 1 } });
    // Credit and readiness were read from the opening's own rows.
    expect(p5.credits.map((c) => c.opportunityId)).toEqual([opened.value.id]);
    expect(p5.credits[0]!.credited).toBe(false);
    expect(p5.offers.map((o) => o.opportunityId)).toEqual([opened.value.id]);
    expect(p5.offers[0]!.research).toBe('RUNNABLE');
    // Nothing granted a commercial authority, so contacting the buyer is stopped and says by what.
    expect(p5.offers[0]!.blocked.find((b) => b.action === 'CONTACT')?.allowedBy).toMatch(/commercial authority/);

    const tick = await assembleGoals({ projectIds: null, includeArchived: false });
    expect(tick.goals.find((one) => one.id === goal.id)!.port05 ?? null).toBeNull();
  });

  it('a read of many goals reads what they share once, not once per goal and opening (F5)', async () => {
    const opened = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Quarterly payroll filings for clinics', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'clinics', source: 'https://example.com/c' });
    if (!opened.ok) throw new Error(opened.reason);
    const second = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Inventory reconciliation for retailers', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'retail', source: 'https://example.com/d' });
    if (!second.ok) throw new Error(second.reason);
    const goals: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const goal = await createWorkstream({ projectId, title: `Collect cash ${i}`, intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
      for (const ref of [opened.value.id, second.value.id]) {
        await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref, relation: 'PURSUES', recordedBy: 'PERSON', recordedByUserId: userId });
      }
      goals.push(goal.id);
    }

    reads.authority = 0;
    reads.capabilities = 0;
    const read = await assembleGoals({ projectIds: [projectId] });
    // Every goal still carries its full reading of both openings ...
    for (const id of goals) {
      const p5 = read.goals.find((one) => one.id === id)!.port05!;
      expect(p5.credits.map((c) => c.opportunityId).sort()).toEqual([opened.value.id, second.value.id].sort());
      expect(p5.offers).toHaveLength(2);
      expect(p5.offers.every((o) => o.blocked.some((b) => b.action === 'CONTACT'))).toBe(true);
    }
    // ... but the project's five grants were checked once and the capabilities read once,
    // where the per-goal loop asked 4 goals x 2 openings x 5 = 40 times and read capabilities 4 times.
    expect(reads.authority).toBe(5);
    expect(reads.capabilities).toBe(1);

    // A second read asks again: nothing is held past the read it served.
    await assembleGoals({ projectIds: [projectId] });
    expect(reads.authority).toBe(10);
    expect(reads.capabilities).toBe(2);
  });

  it('a read context bounds how many goals are derived at once', async () => {
    const context = port05ReadContext(new Date(), 2);
    let active = 0;
    let peak = 0;
    const deps = {
      streams: () => null,
      credits: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [];
      },
      offers: async () => [],
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => readPort05(`wst_${i}`, new Date(), deps, context)));
    expect(peak).toBe(2);
  });

  it('creates no second derivation of goal state: model.ts calls the composition and port05.ts writes nothing', () => {
    const model = readFileSync('server/services/goals/model.ts', 'utf8');
    expect(model).toMatch(/readPort05\(goal\.id/);
    const source = readFileSync('server/services/goals/port05.ts', 'utf8');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b|recordWorkstreamEvent|recordCashEvent|getDb\(/);
  });
});
