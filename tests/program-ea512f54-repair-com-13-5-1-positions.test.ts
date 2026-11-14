/**
 * COM-13-5 repair: a NEEDS_POSITION or UNKNOWN assessment is acted on. Every held-back opening is sent to
 * find a compliant position (an authorized licensed partner included) through one cash need and one research
 * idea, from the cash tick; the search closes itself when the record shows the position. Nothing is excluded
 * and nothing is counted by this pass.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { operate } from '../server/services/cash/operate.ts';
import { cashFunnel } from '../server/services/cash/funnel.ts';
import { assessOpportunityRole } from '../server/services/cash/exclusions.ts';
import { positionNeedKey, positionQuestion, seekCompliantPositions } from '../server/services/cash/regulatedPositions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let currency = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `com135p-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  expect(outcome.ok).toBe(true);
  const mode = (await getCashMode(projectId))!;
  cashModeId = mode.id;
  currency = mode.currency;
});

async function opening(title: string): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency });
  return o.id;
}

async function settle(id: string, cents: number): Promise<void> {
  const r = await recordMoney({ projectId, opportunityId: id, kind: 'SETTLEMENT', amountCents: cents, currency, verifiedReference: `ref-${id}`, recordedBy: userId, idempotencyKey: `settle-${id}` });
  expect(r.ok).toBe(true);
}

async function positionNeeds() {
  return (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith('regulated-position:'));
}

describe('COM-13-5 repair: a held-back regulated role is sent to find a compliant position', () => {
  it('raises one need and one research idea for a held-back regulated opening, and none for a plain one', async () => {
    const regulated = await opening('Earn a referral fee for sending borrowers to a mortgage lender');
    const plain = await opening('Photo prints for a cafe wall');
    const role = await assessOpportunityRole({ projectId, opportunityId: regulated });
    expect(role).toMatchObject({ regulated: true, countEconomics: false, excluded: false });

    const pass = await seekCompliantPositions(projectId);
    const sought = pass.sought.find((s) => s.opportunityId === regulated);
    expect(sought).toBeDefined();
    expect(sought!.needId).not.toBeNull();
    expect(sought!.candidateId).not.toBeNull();
    expect(pass.sought.find((s) => s.opportunityId === plain)).toBeUndefined();

    const needs = await positionNeeds();
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ opportunityId: regulated, requestKey: positionNeedKey(regulated), state: 'OPEN', candidateId: sought!.candidateId });
    expect(needs[0]!.recommendedPath).toContain('authorized licensed partner');
    const idea = await getCandidate(sought!.candidateId!);
    expect(idea!.statement).toContain('authorized licensed partners');
    expect(idea!.statement).toContain('mortgage lender');
  });

  it('is idempotent: a second pass raises and starts nothing new', async () => {
    await opening('Broker mortgages for borrowers for a commission');
    await seekCompliantPositions(projectId);
    const again = await seekCompliantPositions(projectId);
    expect(again.sought).toHaveLength(1);
    expect(again.sought[0]!.candidateId).toBeNull();
    expect(await positionNeeds()).toHaveLength(1);
  });

  it('every opening the funnel holds back has a position search', async () => {
    const regulated = await opening('Earn insurance commissions on policies sold to homeowners we refer');
    const plain = await opening('Photo prints for a cafe wall');
    await settle(regulated, 50_000);
    await settle(plain, 10_000);
    await seekCompliantPositions(projectId);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.heldBack.map((h) => h.opportunityId)).toEqual([regulated]);
    const searched = new Set((await positionNeeds()).map((n) => n.opportunityId));
    for (const held of reading.outcomes.heldBack) expect(searched.has(held.opportunityId)).toBe(true);
    expect(searched.has(plain)).toBe(false);
  });

  it('runs from the cash tick', async () => {
    const id = await opening('Earn insurance commissions on policies sold to homeowners we refer');
    const tick = await operate(projectId);
    expect(tick.failures.filter((f) => f.step === 'seekCompliantPositions')).toEqual([]);
    expect(tick.positions?.sought.map((s) => s.opportunityId)).toContain(id);
    expect((await positionNeeds()).map((n) => n.opportunityId)).toContain(id);
  });

  it('closes the search, by reading the row, once the record shows a compliant position', async () => {
    const id = await opening('Sell insurance policies to homeowners in Texas for a commission');
    await seekCompliantPositions(projectId);
    expect(await positionNeeds()).toHaveLength(1);

    const g = await createWorkstream({ projectId, title: 'Cash goal', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency, projectId, resources: 'I hold a Texas resident insurance producer licence and am appointed with two carriers.' });
    expect(set.ok).toBe(true);
    expect((await assessOpportunityRole({ projectId, opportunityId: id })).countEconomics).toBe(true);

    const pass = await seekCompliantPositions(projectId);
    expect(pass.settled).toHaveLength(1);
    const [need] = await positionNeeds();
    expect(need).toMatchObject({ state: 'RESOLVED', verifiedBy: 'BRAIN_READ_THE_ROW' });
  });

  it('asks about what the role performs, never its label', () => {
    const q = positionQuestion(
      { title: 'Friendly introductions', buyingSignal: null },
      { activities: ['BROKER'], regulated: true, position: 'NEEDS_POSITION', missing: ['licensing'], unknown: [], countEconomics: false, excluded: false, reason: '' } as never,
    );
    expect(q).toContain('broker');
    expect(q).toContain('lacks licensing');
    expect(q).toContain('not by its label');
  });
});
