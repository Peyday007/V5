import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashFunnel } from '../server/services/cash/funnel.ts';
import { assessOpportunityRole, attestationFrom, licenceStatementsIn } from '../server/services/cash/exclusions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { regulatedRolesAssessedFromRows } from '../server/services/cash/regulatedRoleProbe.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
let currency = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `com135f-${Math.random().toString(36).slice(2, 10)}@example.test`,
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

async function settledOpening(title: string, cents: number): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency });
  const r = await recordMoney({ projectId, opportunityId: o.id, kind: 'SETTLEMENT', amountCents: cents, currency, verifiedReference: `ref-${o.id}`, recordedBy: userId, idempotencyKey: `settle-${o.id}` });
  expect(r.ok).toBe(true);
  return o.id;
}

describe('COM-13-5 repair: the funnel counts settled cash through the opening-aware role reader', () => {
  it('reads a regulated activity stated only on the opening row and holds its settlement back, not excluded', async () => {
    const id = await settledOpening('Earn insurance commissions on policies sold to homeowners we refer', 50_000);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.settledByCurrency).toEqual({ [currency]: 50_000 });
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 0 });
    const held = reading.outcomes.heldBack.find((h) => h.opportunityId === id);
    expect(held).toBeDefined();
    // Assessed as a regulated role whose rights are not stated — not "names no activity".
    expect(held!.position).toBe('UNKNOWN');
    expect(held!.reason).toContain('Not stated in the record');
    expect(held!.reason).not.toContain('names no activity');
  });

  it('funnel and probe reader assess the same opening identically', async () => {
    const regulated = await settledOpening('Broker mortgages for borrowers for a commission', 20_000);
    const plain = await settledOpening('Photo prints for a cafe wall', 10_000);
    const reading = await cashFunnel({ projectId });
    for (const id of [regulated, plain]) {
      const probe = await assessOpportunityRole({ projectId, opportunityId: id });
      const held = reading.outcomes.heldBack.find((h) => h.opportunityId === id);
      expect(held).toEqual({ opportunityId: id, position: probe.position, reason: probe.reason });
    }
  });
});

/*
 * Repair: COMPLIANT and COMPLIANT_VIA_PARTNER were unreachable from production rows, because every
 * production caller passed `{}` as the attestation. A goal owner's recorded statement of what they hold
 * (workstreams.target_resources) is now the attestation, read through the same reader by funnel, probe
 * and assessOpportunityRole.
 */
async function ownerSays(resources: string): Promise<void> {
  const g = await createWorkstream({ projectId, title: 'Cash goal', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency, projectId, resources });
  expect(set.ok).toBe(true);
}

describe('COM-13-5 repair: compliant positions are reachable from production rows', () => {
  it('an owner licence recorded on the goal makes a regulated role COMPLIANT and its settlement counted', async () => {
    await ownerSays('I hold a Texas resident insurance producer licence and am appointed with two carriers.');
    const id = await settledOpening('Sell insurance policies to homeowners in Texas for a commission', 30_000);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 30_000 });
    expect(reading.outcomes.heldBack.find((h) => h.opportunityId === id)).toBeUndefined();
    const role = await assessOpportunityRole({ projectId, opportunityId: id });
    expect(role).toMatchObject({ regulated: true, position: 'COMPLIANT', countEconomics: true, excluded: false });
  });

  it('an authorized licensed partner under a signed agreement makes it COMPLIANT_VIA_PARTNER', async () => {
    await ownerSays('Partnered with Lone Star Lending, a licensed mortgage broker in Texas, under a signed referral agreement.');
    const id = await settledOpening('Refer borrowers in Texas to a mortgage broker for a referral fee', 12_000);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 12_000 });
    const role = await assessOpportunityRole({ projectId, opportunityId: id });
    expect(role.position).toBe('COMPLIANT_VIA_PARTNER');
    const probe = await regulatedRolesAssessedFromRows();
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain('1 via partner');
  });

  it('a partner without a signed agreement, a licence for another product or another place counts nothing', async () => {
    await ownerSays('We work with a licensed mortgage broker partner. I hold an insurance licence in Ohio.');
    const mortgage = await settledOpening('Refer borrowers in Texas to a mortgage broker for a referral fee', 5_000);
    const texasInsurance = await settledOpening('Sell insurance policies to homeowners in Texas for a commission', 7_000);
    const reading = await cashFunnel({ projectId });
    expect(reading.outcomes.countedByCurrency).toEqual({ [currency]: 0 });
    expect((await assessOpportunityRole({ projectId, opportunityId: mortgage })).countEconomics).toBe(false);
    const ins = await assessOpportunityRole({ projectId, opportunityId: texasInsurance });
    expect(ins).toMatchObject({ position: 'UNKNOWN', countEconomics: false, excluded: false });
    expect(ins.unknown).toContain('location');
  });

  it('a negated, wanted or pending licence attests nothing', () => {
    for (const text of [
      'I do not have an insurance licence in Texas.',
      'We need a licensed mortgage partner in Texas under a signed agreement.',
      'My Texas insurance licence is pending.',
      'Unlicensed: I sell insurance in Texas.',
    ]) expect(licenceStatementsIn(text)).toEqual([]);
    expect(attestationFrom(licenceStatementsIn('I hold a Texas insurance licence.'), 'Photo prints for a cafe')).toEqual({});
  });

  it('a relabelled role is judged by what it performs, not by an owner licence for something else', async () => {
    await ownerSays('I hold an insurance licence nationwide and am appointed with carriers.');
    const id = await settledOpening('Marketing partner that brokers mortgage loans for borrowers in Texas for a fee', 9_000);
    const role = await assessOpportunityRole({ projectId, opportunityId: id });
    expect(role.countEconomics).toBe(false);
    expect(role.excluded).toBe(false);
  });
});
