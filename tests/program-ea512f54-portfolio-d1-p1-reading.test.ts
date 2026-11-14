/**
 * PORT-05, the goal reading: `port05.ts` composes the streams of the goal's
 * latest portfolio, the capability credit judged from rows and the offer
 * readiness decided from rows, and `model.ts` carries it on `GoalView` — the
 * one goal derivation — for a person's read. Nothing is invented where a part
 * is unknown, and the whole-Brain tick does not pay for it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { createWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import { composePort05, heldPlanStreams, noteGoalStreamsCleared, notePlanStreams, PLAN_STREAMS_STALE_MS, readPort05 } from '../server/services/goals/port05.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { getWorkstream } from '../server/repos/register.ts';
import { setGoalTerms } from '../server/repos/goals.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { StreamsReading, PortfolioStream } from '../server/services/goals/streams.ts';
import type { CapabilityCredit } from '../server/services/goals/capabilityCredit.ts';
import type { OfferReadiness } from '../server/services/goals/offerReadiness.ts';

const stream = (opportunityId: string, role: PortfolioStream['role'], independent: boolean): PortfolioStream =>
  ({ opportunityId, title: `t-${opportunityId}`, role, roles: [role], reason: `${role} because`, independent, independence: independent ? 'shares nothing binding' : 'shares the outreach' }) as unknown as PortfolioStream;

const STREAMS = {
  streams: [stream('cop_a', 'LEADING', true), stream('cop_b', 'ALTERNATE', false), stream('cop_c', 'FUTURE_BET', true)],
  across: { independentStreams: 2 },
} as unknown as StreamsReading;

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
/** A real opening as the goal model enters it. */
const planned = (opportunity: ModelledOpportunity['opportunity']): ModelledOpportunity =>
  ({
    opportunity,
    index: 1,
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
  }) as ModelledOpportunity;

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

  it('holds the plan’s streams by the target they were read for, and only for one project and currency', () => {
    noteGoalStreamsCleared();
    const at = Date.parse('2026-11-14T00:00:00Z');
    const openings = [{ opportunity: { projectId: 'prj_a', currency: 'USD' } }, { opportunity: { projectId: 'prj_a', currency: 'USD' } }];
    const target = { projectId: 'prj_a', currency: 'USD', remainingCents: 1_000_000, daysLeft: 20 };
    expect(heldPlanStreams(target, at)).toBeNull();
    notePlanStreams({ openings, remaining: 10_000, daysLeft: 20, streams: STREAMS, now: at });
    expect(heldPlanStreams(target, at)).toBe(STREAMS);
    // A day has turned since the plan was read: it is still that plan.
    expect(heldPlanStreams({ ...target, daysLeft: 19 }, at)).toBe(STREAMS);
    // Another target, another project or a stale reading is not this goal's plan.
    expect(heldPlanStreams({ ...target, remainingCents: 900_000 }, at)).toBeNull();
    expect(heldPlanStreams({ ...target, projectId: 'prj_b' }, at)).toBeNull();
    expect(heldPlanStreams({ ...target, daysLeft: null }, at)).toBeNull();
    expect(heldPlanStreams(target, at + PLAN_STREAMS_STALE_MS + 1)).toBeNull();
    // A mixed or empty set of openings is not a goal plan, and is not held.
    noteGoalStreamsCleared();
    notePlanStreams({ openings: [...openings, { opportunity: { projectId: 'prj_b', currency: 'USD' } }], remaining: 10_000, daysLeft: 20, streams: STREAMS, now: at });
    notePlanStreams({ openings: [], remaining: 10_000, daysLeft: 20, streams: STREAMS, now: at });
    expect(heldPlanStreams(target, at)).toBeNull();
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
    // The goal has a target and a due date, so the plan can read it.
    expect((await setTarget({ goal: (await getWorkstream(goal.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, now: new Date(Date.now() - 60_000) })).ok).toBe(true);
    await setGoalTerms(goal.id, { dueAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
    const target = (await readTarget((await getWorkstream(goal.id))!))!;
    // Before any plan is read, the streams are unknown — never invented.
    const before = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === goal.id)!;
    expect(before.port05!.streams.known).toBe(false);
    // The plan's own evaluation, exactly as the goal model calls it (no worlds, no committed, not the floor):
    // nothing else hands the streams over.
    evaluateGoalPortfolio({
      openings: [planned(opened.value)],
      remaining: target.remainingCents / 100,
      daysLeft: target.daysLeft!,
      capitalCeiling: 3000,
      beforeProof: 375,
      perWeek: 750,
      resources: '40 emails a day',
    });

    const read = await assembleGoals({ projectIds: [projectId] });
    const view = read.goals.find((one) => one.id === goal.id)!;
    expect(view.port05).toBeTruthy();
    const p5 = view.port05!;
    expect(p5.streams).toMatchObject({ known: true });
    if (!p5.streams.known) throw new Error('unknown');
    expect(p5.streams.streams.map((one) => one.opportunityId)).toEqual([opened.value.id]);
    expect(p5.streams.independentStreams).toBeGreaterThanOrEqual(0);
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

  it('creates no second derivation of goal state: model.ts calls the composition and port05.ts writes nothing', () => {
    const model = readFileSync('server/services/goals/model.ts', 'utf8');
    expect(model).toMatch(/readPort05\(goal\.id/);
    // The hand-off is made where the streams are built, so no caller can forget it.
    expect(readFileSync('server/services/goals/portfolio.ts', 'utf8')).toMatch(/notePlanStreams\(\{ openings: input\.openings/);
    const source = readFileSync('server/services/goals/port05.ts', 'utf8');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b|recordWorkstreamEvent|recordCashEvent|getDb\(/);
  });
});
