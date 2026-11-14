/**
 * Offer readiness (PORT-05, S-0065): under SQUEEZE a qualified opening is
 * offerable with no market-test step; research and sales are live at once; a
 * missing contact/invoice/contract/spend/payment permission stops only that
 * action and names the grant; internal work is never stopped; and the goal's
 * limits and channel rule come from the existing owners.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL } from '../server/services/cash/authority.ts';
import { SQUEEZE_QUALIFICATION } from '../server/domain/goalPolicy.ts';
import {
  EXTERNAL_ACTIONS,
  EXTERNAL_ACTION_LIST,
  INTERNAL_WORK,
  decideOfferReadiness,
  offerReadinessFor,
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
