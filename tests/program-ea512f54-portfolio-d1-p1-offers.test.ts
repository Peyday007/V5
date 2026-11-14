/**
 * Offer readiness (PORT-05, S-0065): under SQUEEZE a qualified opening is
 * offerable with no market-test step; research and sales are live at once; a
 * missing contact/invoice/contract/spend/payment permission stops only that
 * action and names the grant; internal work is never stopped; and the goal's
 * limits and channel rule come from the existing owners.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createWorkstream, listWorkstreamEvents, linkWorkstream } from '../server/repos/register.ts';
import { salesOrderForProject } from '../server/services/goals/plan.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL } from '../server/services/cash/authority.ts';
import { SQUEEZE_QUALIFICATION } from '../server/domain/goalPolicy.ts';
import {
  EXTERNAL_ACTIONS,
  EXTERNAL_ACTION_LIST,
  INTERNAL_WORK,
  decideOfferReadiness,
  offerReadinessFor,
  actOnOfferReadiness,
  forgetOffersReadyFirst,
  offersReadyFirst,
  productionOfferActPorts,
  GOAL_OFFER_DECIDED,
  type OfferActPorts,
  type OfferReadiness,
  type ExternalAction,
  type OfferReadinessInput,
  type PermissionReading,
} from '../server/services/goals/offerReadiness.ts';

const OK: PermissionReading = { ok: true, reason: 'within the standing commercial authority' };
const allAuthorized = (): Record<ExternalAction, PermissionReading> => Object.fromEntries(EXTERNAL_ACTION_LIST.map((a) => [a, OK])) as Record<ExternalAction, PermissionReading>;

function input(over: Partial<OfferReadinessInput> = {}): OfferReadinessInput {
  return {
    policy: 'SQUEEZE',
    required: [...SQUEEZE_QUALIFICATION],
    answered: new Set(SQUEEZE_QUALIFICATION),
    testFirstPlay: true,
    authority: allAuthorized(),
    spendingRefusal: null,
    channel: { ok: true, reason: 'one published address' },
    ...over,
  };
}

describe('SQUEEZE: offer as soon as authorized and offerable', () => {
  it('a qualified opening is offerable with no market-test precondition, even for a test-first play', () => {
    const r = decideOfferReadiness(input());
    expect(r.offerable).toBe(true);
    expect(r.marketTestRequired).toBe(false);
    expect(r.offerNow).toBe(true);
  });

  it('evidence-first keeps the bounded test for a test-first play; SQUEEZE does not', () => {
    expect(decideOfferReadiness(input({ policy: 'EVIDENCE_FIRST' })).marketTestRequired).toBe(true);
    expect(decideOfferReadiness(input({ policy: 'EVIDENCE_FIRST' })).offerNow).toBe(false);
    expect(decideOfferReadiness(input({ policy: 'EVIDENCE_FIRST', testFirstPlay: false })).offerNow).toBe(true);
  });

  it('research and sales are both runnable at once for the same opening', () => {
    const r = decideOfferReadiness(input());
    expect(r.lanes).toMatchObject({ research: 'RUNNABLE', sales: 'RUNNABLE' });
  });

  it('an unanswered qualification key holds the sale, names the key, and research still runs', () => {
    const answered = new Set<string>(SQUEEZE_QUALIFICATION.filter((k) => k !== 'payer'));
    const r = decideOfferReadiness(input({ answered }));
    expect(r.offerable).toBe(false);
    expect(r.missing).toEqual(['payer']);
    expect(r.lanes.research).toBe('RUNNABLE');
    expect(r.lanes.sales).toBe('NOT_YET');
  });
});

describe('a missing permission stops exactly that external action', () => {
  for (const action of EXTERNAL_ACTION_LIST) {
    it(`missing ${EXTERNAL_ACTIONS[action]} blocks only ${action} and names the grant`, () => {
      const authority = allAuthorized();
      authority[action] = { ok: false, reason: `the commercial authority does not cover ${EXTERNAL_ACTIONS[action]}` };
      const r = decideOfferReadiness(input({ authority }));
      const blocked = r.actions.filter((a) => !a.may);
      expect(blocked.map((a) => a.action)).toEqual([action]);
      expect(blocked[0]!.blocker!.allowedBy).toContain(EXTERNAL_ACTIONS[action]);
      expect(r.lanes.research).toBe('RUNNABLE');
      expect(r.internal.map((w) => w.work)).toEqual([...INTERNAL_WORK]);
      expect(r.internal.every((w) => w.runnable)).toBe(true);
      // Only a missing contact stops the offer itself.
      expect(r.lanes.sales).toBe(action === 'CONTACT' ? 'BLOCKED' : 'RUNNABLE');
    });
  }

  it('with no commercial authority at all, every external action is blocked and all internal work still runs', () => {
    const none = Object.fromEntries(EXTERNAL_ACTION_LIST.map((a) => [a, { ok: false, reason: 'no standing commercial authority exists for this project' }])) as Record<ExternalAction, PermissionReading>;
    const r = decideOfferReadiness(input({ authority: none }));
    expect(r.actions.every((a) => !a.may)).toBe(true);
    expect(r.internal).toHaveLength(INTERNAL_WORK.length);
    expect(r.lanes.research).toBe('RUNNABLE');
  });

  it("the goal's spending limit blocks only SPEND, and the channel rule only CONTACT", () => {
    const spend = decideOfferReadiness(input({ spendingRefusal: 'The goal may tie up at most USD 500' }));
    expect(spend.actions.filter((a) => !a.may).map((a) => a.action)).toEqual(['SPEND']);
    expect(spend.actions.find((a) => a.action === 'SPEND')!.blocker!.reason).toContain('USD 500');
    const channel = decideOfferReadiness(input({ channel: { ok: false, reason: 'the channel the buyer published names no email address' } }));
    expect(channel.actions.filter((a) => !a.may).map((a) => a.action)).toEqual(['CONTACT']);
    expect(channel.lanes.sales).toBe('BLOCKED');
    expect(channel.lanes.research).toBe('RUNNABLE');
  });
});

describe('no second authority path', () => {
  it('reads the existing owners and re-implements none of them', () => {
    const source = readFileSync('server/services/goals/offerReadiness.ts', 'utf8');
    for (const owner of ['checkCommercialAuthority', 'goalSpendingRefusal', 'recipientFromChannel', 'executionPolicyForProject', 'qualificationKeys']) {
      expect(source).toContain(owner);
    }
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s/);
    expect(source).not.toMatch(/liveAuthority|allowedActions\.includes/);
  });
});

describe('offerReadinessFor on rows', () => {
  afterAll(teardown);

  it('reads the real grant: none blocks every external action, a grant without contact blocks only contact', async () => {
    const { project } = await freshProject();
    const user = await createUser({ email: `offers-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    const activated = await activate({ projectId: project.id, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash over the next few weeks.' });
    expect(activated.ok).toBe(true);
    const mode = (await getCashMode(project.id))!;
    const opportunity = await createOpportunity({ projectId: project.id, cashModeId: mode.id, ownerUserId: user.id, title: 'A studio published an overflow request', mechanism: 'EXPLICIT_PAID_REQUEST', currency: mode.currency });

    const bare = await offerReadinessFor(opportunity);
    expect(bare.actions.every((a) => !a.may)).toBe(true);
    expect(bare.lanes.research).toBe('RUNNABLE');
    expect(bare.internal.every((w) => w.runnable)).toBe(true);

    await createAuthority({
      projectId: project.id,
      ownerUserId: user.id,
      createdByUserId: user.id,
      name: 'Commercial authority without contact',
      allowedActions: ['QUOTE_AND_INVOICE', 'ENGAGE_CONTRACTOR', 'SPEND_FROM_ALLOWANCE', 'ACCEPT_PAYMENT'],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 10_000,
      maxPerActionCents: 10_000,
      maxConcurrent: 5,
      currency: 'USD',
    });
    const granted = await offerReadinessFor(opportunity);
    const blocked = granted.actions.filter((a) => !a.may);
    expect(blocked.map((a) => a.action)).toEqual(['CONTACT']);
    expect(blocked[0]!.blocker!.allowedBy).toContain('CONTACT_BUYER');
    expect(granted.lanes.research).toBe('RUNNABLE');
  });
});

/* -------------------------------------------- F3: readiness is acted on */

function fakePorts(over: {
  readings: { opportunityId: string; readiness: OfferReadiness }[];
  states: Record<string, string>;
  sprint?: boolean;
  readyOk?: boolean;
}) {
  const calls = { markReady: [] as string[], recorded: [] as { opportunityId: string; key: string; act: string; stopped: unknown }[] };
  const last = new Map<string, string>();
  const ports: OfferActPorts = {
    readinessForGoal: async () => over.readings,
    stateOf: async (id) => (over.states[id] ? { state: over.states[id]!, projectId: 'prj_x' } : null),
    sprintActive: async () => over.sprint ?? true,
    markReady: async (id) => {
      calls.markReady.push(id);
      return over.readyOk === false ? { ok: false, reason: 'the card is short' } : { ok: true, reason: 'ready' };
    },
    lastDecision: async () => new Map(last),
    record: async ({ opportunityId, key, reading }) => {
      last.set(opportunityId, key);
      calls.recorded.push({ opportunityId, key, act: reading.act, stopped: reading.stopped });
    },
  };
  return { ports, calls };
}

describe('F3: offer readiness is the trigger and the stop for an offer', () => {
  beforeEach(() => forgetOffersReadyFirst());
  const goal = [{ id: 'ws_goal', lifecycle: 'ACTIVE' }];
  const offerable = decideOfferReadiness(input());
  const noContact = (() => {
    const authority = allAuthorized();
    authority.CONTACT = { ok: false, reason: 'the commercial authority does not cover CONTACT_BUYER' };
    return decideOfferReadiness(input({ authority }));
  })();
  const missingPayer = decideOfferReadiness(input({ answered: new Set<string>(SQUEEZE_QUALIFICATION.filter((k) => k !== 'payer')) }));

  it('an authorized, offerable opening is readied through markReady and reached first by the sender', async () => {
    const { ports, calls } = fakePorts({ readings: [{ opportunityId: 'opp_a', readiness: offerable }], states: { opp_a: 'EVIDENCE_CARD' } });
    const out = await actOnOfferReadiness(goal, ports);
    expect(calls.markReady).toEqual(['opp_a']);
    expect(out.acted[0]!.act).toBe('READIED');
    expect(offersReadyFirst('prj_x')).toEqual(['opp_a']);
    // The order the sender reads (advanceWithinAuthority → salesOrderForProject) starts with it.
    expect(salesOrderForProject('prj_x')[0]).toBe('opp_a');
  });

  it('an opening already READY is not readied again, and is still reached first', async () => {
    const { ports, calls } = fakePorts({ readings: [{ opportunityId: 'opp_r', readiness: offerable }], states: { opp_r: 'READY' } });
    const out = await actOnOfferReadiness(goal, ports);
    expect(calls.markReady).toEqual([]);
    expect(out.acted[0]!.act).toBe('OFFER_FIRST');
    expect(salesOrderForProject('prj_x')[0]).toBe('opp_r');
  });

  it('a missing contact permission stops that offer: not readied, not promoted, the stopped action recorded', async () => {
    const { ports, calls } = fakePorts({ readings: [{ opportunityId: 'opp_b', readiness: noContact }], states: { opp_b: 'EVIDENCE_CARD' } });
    const out = await actOnOfferReadiness(goal, ports);
    expect(calls.markReady).toEqual([]);
    expect(offersReadyFirst('prj_x')).toEqual([]);
    expect(out.acted[0]!.act).toBe('STOPPED');
    expect(out.acted[0]!.stopped).toMatchObject({ action: 'CONTACT' });
    expect(calls.recorded[0]!.stopped).toMatchObject({ action: 'CONTACT', allowedBy: expect.stringContaining('CONTACT_BUYER') });
    // Research is never what a missing permission stops.
    expect(noContact.lanes.research).toBe('RUNNABLE');
  });

  it('an unanswered qualification key holds the offer and names it', async () => {
    const { ports, calls } = fakePorts({ readings: [{ opportunityId: 'opp_c', readiness: missingPayer }], states: { opp_c: 'DISCOVERED' } });
    const out = await actOnOfferReadiness(goal, ports);
    expect(calls.markReady).toEqual([]);
    expect(out.acted[0]!.stopped).toMatchObject({ action: 'OFFER', reason: expect.stringContaining('payer') });
  });

  it('a project whose sprint is not running gets no new offer from Brain', async () => {
    const { ports, calls } = fakePorts({ readings: [{ opportunityId: 'opp_d', readiness: offerable }], states: { opp_d: 'EVIDENCE_CARD' }, sprint: false });
    const out = await actOnOfferReadiness(goal, ports);
    expect(calls.markReady).toEqual([]);
    expect(offersReadyFirst('prj_x')).toEqual([]);
    expect(out.acted[0]!.act).toBe('SPRINT_NOT_ACTIVE');
  });

  it('a refused markReady is recorded with the refusal and not promoted', async () => {
    const { ports } = fakePorts({ readings: [{ opportunityId: 'opp_e', readiness: offerable }], states: { opp_e: 'EVIDENCE_CARD' }, readyOk: false });
    const out = await actOnOfferReadiness(goal, ports);
    expect(out.acted[0]!.act).toBe('READY_REFUSED');
    expect(out.acted[0]!.because).toContain('the card is short');
    expect(offersReadyFirst('prj_x')).toEqual([]);
  });

  it('records a decision only when it changed, and acts only for active goals', async () => {
    const { ports, calls } = fakePorts({ readings: [{ opportunityId: 'opp_b', readiness: noContact }], states: { opp_b: 'READY' } });
    await actOnOfferReadiness(goal, ports);
    await actOnOfferReadiness(goal, ports);
    expect(calls.recorded).toHaveLength(1);
    const paused = await actOnOfferReadiness([{ id: 'ws_goal', lifecycle: 'PAUSED' }], ports);
    expect(paused.acted).toEqual([]);
  });

  it('a stopped opening loses its place at the front once it stops being offerable', async () => {
    const a = fakePorts({ readings: [{ opportunityId: 'opp_f', readiness: offerable }], states: { opp_f: 'READY' } });
    await actOnOfferReadiness(goal, a.ports);
    expect(offersReadyFirst('prj_x')).toEqual(['opp_f']);
    const b = fakePorts({ readings: [{ opportunityId: 'opp_f', readiness: noContact }], states: { opp_f: 'READY' } });
    await actOnOfferReadiness(goal, b.ports);
    expect(offersReadyFirst('prj_x')).toEqual([]);
  });

  it('the goals tick runs it, and the sender reads the order it sets', () => {
    expect(readFileSync('server/services/goals/tick.ts', 'utf8')).toMatch(/actOnOfferReadiness\(snapshot\.goals, await productionOfferActPorts\(\)/);
    expect(readFileSync('server/services/goals/plan.ts', 'utf8')).toMatch(/const out: string\[\] = offersReadyFirst\(projectId\)/);
    expect(readFileSync('server/services/cash/operate.ts', 'utf8')).toMatch(/salesOrderForProject\(projectId\)/);
  });

  it('on rows: a goal whose opening may not be offered records the stop on its own history and readies nothing', async () => {
    const { project } = await freshProject();
    const user = await createUser({ email: `offers-act-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    const activated = await activate({ projectId: project.id, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash over the next few weeks.' });
    expect(activated.ok).toBe(true);
    const mode = (await getCashMode(project.id))!;
    const opportunity = await createOpportunity({ projectId: project.id, cashModeId: mode.id, ownerUserId: user.id, title: 'A buyer published a paid request', mechanism: 'EXPLICIT_PAID_REQUEST', currency: mode.currency });
    const ws = await createWorkstream({ projectId: project.id, title: 'Sell it', intent: 'Cash from a sale.', purpose: 'CAPABILITY', createdByUserId: user.id });
    await linkWorkstream({ workstreamId: ws.id, kind: 'OPPORTUNITY', ref: opportunity.id, relation: 'PURSUES', recordedBy: 'PERSON' });

    const out = await actOnOfferReadiness([{ id: ws.id, lifecycle: 'ACTIVE' }], await productionOfferActPorts());
    expect(out.failed).toEqual([]);
    expect(out.acted).toHaveLength(1);
    expect(out.acted[0]!.act).toBe('STOPPED');
    expect(offersReadyFirst(project.id)).toEqual([]);
    const events = (await listWorkstreamEvents(ws.id)).filter((e) => e.kind === GOAL_OFFER_DECIDED);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ opportunityId: opportunity.id, act: 'STOPPED' });
    // A second pass on unchanged rows records nothing new.
    await actOnOfferReadiness([{ id: ws.id, lifecycle: 'ACTIVE' }], await productionOfferActPorts());
    expect((await listWorkstreamEvents(ws.id)).filter((e) => e.kind === GOAL_OFFER_DECIDED)).toHaveLength(1);
  });
});
