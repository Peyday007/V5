/**
 * INT-38-AUTHORITY (S-0517): "all actions obey authority (§34)" as one reading
 * across the lifecycle (LIFE-29) and the authority ledger (AUTH-34).
 *
 * Every scenario drives real lifecycle paths through the real repositories — a
 * buyer contact that begins execution, an invoice recorded on the piece, a
 * refund remedy a person approved — and reads them back with
 * `actionsObeyAuthorityOnRows`. A violation is made the way it would arise in
 * production: an effect row written without the authority path, under a stop,
 * outside a grant, or a remedy whose recorded authority disagrees with the
 * ledger.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { recordAction } from '../server/repos/cashActions.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind, cashEventsOfKindInProject, recordCashEvent } from '../server/repos/cashMode.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, AUTHORITY_DECISION_KIND, COMMERCIAL_ACTIONS, setEmergencyStop } from '../server/services/cash/authority.ts';
import { recordFurtherAction } from '../server/services/cash/actions.ts';
import { actionKey, beginExecution, capture, fillCard, markReady, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, releaseAgreement } from '../server/services/cash/journey/deal.ts';
import { declare } from '../server/services/cash/journey/fulfillment.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { closeNeed } from '../server/services/cash/needs.ts';
import { runNeedContinuations } from '../server/services/cash/operate.ts';
import { REMEDY_APPROVAL_PREFIX, REMEDY_CARRIED_OUT, remedyAuthorityAtEffect } from '../server/services/cash/deliverables/exceptions.ts';
import { actionsObeyAuthorityOnRows } from '../server/services/cash/authorityIntegration.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';

let projectId = '';
let userId = '';
let grantId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `int38r-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  grantId = (
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
  ).id;
});

afterEach(() => clearAdapters());

/** A real piece taken to EXECUTING by a contact the authority path judged first. */
async function executing(): Promise<string> {
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
    source: 'Inbound email from the buyer, 2026-09-14, asking for a quote',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs', reachableChannel: 'Replied on Tuesday', buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z', offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives', priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration', fulfillmentOwner: 'Us', peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `The owner's answer to ${field}.`, decidedBy: userId });
  }
  expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
  const began = await beginExecution({
    opportunityId: id,
    actorRef: userId,
    firstAction: {
      action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'Sent the scope and price.',
      reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

/** An invoice recorded on the piece, through the one authority path. */
async function invoiced(id: string): Promise<void> {
  const done = await recordFurtherAction({
    opportunityId: id, actorRef: userId, action: 'QUOTE_AND_INVOICE', performedBy: 'PERSON',
    detail: 'Issued invoice INV-1 for the agreed scope.', reference: `inv-${id}`,
    requestKey: actionKey(id, 'QUOTE_AND_INVOICE', 'inv-1'),
  });
  if (!done.ok) throw new Error(done.reason);
}

/** A paid deal the buyer cancelled, whose refund a person approves and Brain carries out. */
async function refunded(id: string): Promise<string> {
  const agreed = await recordAgreement({
    opportunityId: id, amountCents: 75_000, currency: 'USD', deliverable: 'Repair the intake form',
    acceptanceCondition: 'Form submits and a test enquiry arrives', evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `email-${id}`, actorRef: userId,
  });
  if (!agreed.ok) throw new Error(agreed.reason);
  expect((await declare({ projectId, agreementId: agreed.value.id, kind: 'PERSON', performer: 'The owner', actorRef: userId })).ok).toBe(true);
  for (const kind of ['CUSTOMER_PAYMENT', 'SETTLEMENT'] as const) {
    const written = await recordMoneyEvent({ projectId, opportunityId: id, kind, amountCents: 75_000, currency: 'USD', verifiedReference: `${kind}-${id}`, idempotencyKey: `${kind}:${id}`, actorRef: userId, appliesTo: null });
    expect(written.ok).toBe(true);
  }
  expect((await releaseAgreement({ agreementId: agreed.value.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
  await advanceJourney(projectId);
  const need = (await listNeeds({ projectId })).find((n) => n.opportunityId === id && n.requestKey?.startsWith(REMEDY_APPROVAL_PREFIX));
  if (!need) throw new Error('the journey tick raised no refund approval');
  expect((await closeNeed({ needId: need.id, to: 'RESOLVED', resolution: 'Approved: refund the buyer in full.', actorUserId: userId })).ok).toBe(true);
  await runNeedContinuations(projectId);
  const carried = await cashEventsOfKind(id, REMEDY_CARRIED_OUT);
  expect(carried).toHaveLength(1);
  return carried[0]!.id;
}

/** An effect row written beside the authority path rather than through it. */
async function rogueAction(id: string, action: string, key: string): Promise<string> {
  return (
    await recordAction({
      projectId, opportunityId: id, authorityId: grantId, action, performedBy: 'BRAIN',
      reference: null, detail: 'written without asking', confirmedBy: 'BRAIN', requestKey: key,
    })
  ).action.id;
}

describe('the joint reading holds when every lifecycle effect rests on authority', () => {
  it('a contact, an invoice and an approved refund read ok, counted, with AUTH-34 holding', async () => {
    const id = await executing();
    await invoiced(id);
    await refunded(id);
    const reading = await actionsObeyAuthorityOnRows();
    // LIFE-29-3 may legitimately not be demonstrated yet on this one case; the cross-check itself must not object.
    expect(reading.violation).toBeNull();
    if (reading.ok === false) expect(reading.detail).toMatch(/^LIFE-29-3 does not hold/);
    expect(reading.counts.cashActions).toBeGreaterThanOrEqual(2);
    expect(reading.counts.remedies).toBe(1);
    expect(reading.counts.decisions).toBeGreaterThan(0);
  });

  it('a contact and an invoice with no agreement read ok, and say the lifecycle readings had nothing to read', async () => {
    const id = await executing();
    await invoiced(id);
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading).toMatchObject({ ok: true, violation: null });
    expect(reading.counts.cashActions).toBe(2);
    expect(reading.detail).toMatch(/2 recorded action\(s\)/);
    expect(reading.detail).toMatch(/AUTH-34 holds/);
    expect(reading.detail).toMatch(/nothing to read/);
  });

  it('with no lifecycle effect the reading says nothing was performed, and claims no proof', async () => {
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(true);
    expect(reading.counts.effects).toBe(0);
    expect(reading.detail).toMatch(/^nothing performed yet/);
    expect(reading.detail).toMatch(/proves nothing/);
  });
});

describe('the joint reading fails, naming the row, when an effect escaped authority', () => {
  it('an effect with no prior authority decision for its action', async () => {
    const id = await executing();
    const rogue = await rogueAction(id, 'ACCEPT_PAYMENT', 'rogue:payment');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: rogue, reason: expect.stringMatching(/ACCEPT_PAYMENT was performed with no authorization decision/) });
  });

  it('an effect performed while the emergency stop was on', async () => {
    const id = await executing();
    // The stop and the effects must not share a millisecond: a stop in the same instant as an effect is not before it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'pause everything' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rogue = await rogueAction(id, 'CONTACT_BUYER', 'rogue:contact-under-stop');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: rogue, reason: expect.stringMatching(/emergency stop was on/) });
  });

  it('an effect performed after the grant was revoked, with no owner approval', async () => {
    const id = await executing();
    await revokeAuthority({ authorityId: grantId, actorUserId: userId, reason: 'no more outreach' });
    // Revocation and the effect must not share a millisecond: the reading treats a tie as "before the revocation".
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rogue = await rogueAction(id, 'CONTACT_BUYER', 'rogue:contact-after-revoke');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: rogue, reason: expect.stringMatching(/not in force/) });
  });

  it('a remedy whose recorded authority disagrees with the ledger decision it cites', async () => {
    const id = await executing();
    const authority = await remedyAuthorityAtEffect({
      projectId, opportunityId: id, remedy: 'RESCHEDULE', agreementId: 'agr_x', exceptionId: 'missed_date:x',
      amountCents: null, approvalRequestId: null, approvedBy: null,
    });
    expect(authority).toMatchObject({ basis: 'GRANT', allowed: true });
    expect((await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).map((r) => r.id)).toContain(authority.decisionId);
    const honest = await recordCashEvent({
      projectId, opportunityId: id, kind: REMEDY_CARRIED_OUT, actorRef: 'BRAIN', summary: 'reschedule: done',
      detail: { exceptionId: 'missed_date:x', remedy: 'RESCHEDULE', agreementId: 'agr_x', ok: true, authority },
    });
    expect((await actionsObeyAuthorityOnRows()).violation).toBeNull();

    const forged = await recordCashEvent({
      projectId, opportunityId: id, kind: REMEDY_CARRIED_OUT, actorRef: 'BRAIN', summary: 'reschedule: done',
      detail: { exceptionId: 'missed_date:y', remedy: 'RESCHEDULE', agreementId: 'agr_x', ok: true, authority: { ...authority, cause: 'OWNER_APPROVED' } },
    });
    const reading = await actionsObeyAuthorityOnRows();
    expect(honest.id).not.toBe(forged.id);
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: forged.id, reason: expect.stringMatching(/records cause OWNER_APPROVED, but the ledger decision/) });
  });

  it('a remedy claiming a person approved it, citing a request nobody resolved', async () => {
    const id = await executing();
    const forged = await recordCashEvent({
      projectId, opportunityId: id, kind: REMEDY_CARRIED_OUT, actorRef: userId, summary: 'refund: done',
      detail: {
        remedy: 'APPROVED_REFUND', ok: true,
        authority: { basis: 'OWNER_APPROVAL', approvalRequestId: 'need_nobody', approvedBy: userId, cause: 'OWNER_APPROVED', disposition: 'AUTHORIZED', emergencyStop: false, allowed: true },
      },
    });
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation?.rowId).toBe(forged.id);
  });
});

describe('the reading is a reading', () => {
  it('writes nothing: the database is unchanged by reading it', async () => {
    const id = await executing();
    await invoiced(id);
    const count = async () => (await getDb().get<{ n: number }>('SELECT (SELECT COUNT(*) FROM cash_events) + (SELECT COUNT(*) FROM cash_actions) + (SELECT COUNT(*) FROM cash_needs) AS n'))!.n;
    const before = await count();
    await actionsObeyAuthorityOnRows();
    expect(await count()).toBe(before);
  });

  it('the module performs no write and starts no timer', () => {
    const source = readFileSync(new URL('../server/services/cash/authorityIntegration.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|CREATE TABLE|setInterval|setTimeout|\.run\(|recordCashEvent|recordAction|decideAction|checkCommercialAuthority/);
  });
});

/*
 * Reviewer finding (repair-pre-ledger-history-fails-forever): cash_actions
 * rows were written from 2026-09-15, gated by checkCommercialAuthority but
 * leaving no ledger row, and decisions reached the ledger only from
 * 2026-11-09. Holding those rows to a decision nobody could have written made
 * the reading fail forever on any Brain with that history. A row from before
 * the ledger's first decision is now unledgered history: still held to its
 * grant and stop, counted and named, never presented as proof. Every row
 * from the ledger's start on still needs its decision.
 */
describe('recorded actions from before the authority ledger began are history, not violations and not proof', () => {
  const HISTORY_AT = '2026-10-01T12:00:00.000Z';

  /** A grant in force since before the history, so the history was performed inside it. */
  async function grantSince(at: string): Promise<void> {
    await getDb().run('UPDATE cash_authorities SET starts_at = ? WHERE id = ?', [at, grantId]);
  }

  /** A recorded action written as the pre-ledger code wrote it: through the gate, with no ledger row, on an earlier day. */
  async function preLedgerAction(id: string, action: string, key: string, at = HISTORY_AT, authorityId = grantId): Promise<string> {
    const row = (
      await recordAction({
        projectId, opportunityId: id, authorityId, action, performedBy: 'PERSON',
        reference: null, detail: 'recorded before the ledger existed', confirmedBy: 'PERSON', requestKey: key,
      })
    ).action.id;
    await getDb().run('UPDATE cash_actions SET created_at = ? WHERE id = ?', [at, row]);
    return row;
  }

  it('the reviewer\'s case: a grant since September, one ledgered contact today, one contact back-dated to October — reads ok, and names the history', async () => {
    await grantSince('2026-09-01T00:00:00.000Z');
    const id = await executing();
    const history = await preLedgerAction(id, 'CONTACT_BUYER', 'history:contact');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(true);
    expect(reading.violation).toBeNull();
    expect(reading.counts.unledgeredHistory).toBe(1);
    expect(reading.detail).toContain(`1 recorded action(s) predate the authority ledger`);
    expect(reading.detail).toContain(`${history} CONTACT_BUYER`);
    expect(reading.detail).toMatch(/not as proof/);
    // The history is not counted among the effects resting on a decision.
    expect(reading.detail).toMatch(new RegExp(`^${reading.counts.effects - 1} lifecycle effect\\(s\\)`));
  });

  it('only history and no ledgered effect claims nothing was performed under the ledger', async () => {
    await grantSince('2026-09-01T00:00:00.000Z');
    const id = await executing();
    // Remove the ledgered contact's effect so only the history and the decision remain.
    await getDb().run('DELETE FROM cash_actions WHERE project_id = ?', [projectId]);
    await preLedgerAction(id, 'CONTACT_BUYER', 'history:only');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(true);
    expect(reading.counts.unledgeredHistory).toBe(1);
    expect(reading.detail).toMatch(/^nothing performed yet under the ledger/);
  });

  it('a row after the ledger began still needs its decision: the bar is unchanged from the ledger\'s start on', async () => {
    await grantSince('2026-09-01T00:00:00.000Z');
    const id = await executing();
    await preLedgerAction(id, 'CONTACT_BUYER', 'history:contact-2');
    const rogue = await rogueAction(id, 'ACCEPT_PAYMENT', 'rogue:payment-after-ledger');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: rogue, reason: expect.stringMatching(/ACCEPT_PAYMENT was performed with no authorization decision/) });
  });

  it('history is still held to its grant: one performed before its grant was in force fails, naming the row', async () => {
    // The grant starts now (beforeEach), so an October action was outside it.
    const id = await executing();
    const history = await preLedgerAction(id, 'CONTACT_BUYER', 'history:outside-grant');
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: history, reason: expect.stringMatching(/before the authority ledger began\) was performed under grant .* not in force/) });
  });

  it('history naming a grant of another project fails, naming the row', async () => {
    await grantSince('2026-09-01T00:00:00.000Z');
    const id = await executing();
    // Another project in the same Brain (freshProject would start a new database).
    const { createProject } = await import('../server/repos/projects.ts');
    const other = (await createProject({ name: 'Another project', slug: `other-${Math.random().toString(36).slice(2, 8)}` })).id;
    const foreign = (
      await createAuthority({
        projectId: other, ownerUserId: userId, createdByUserId: userId, name: 'Another project\'s authority',
        allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
        maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
        startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      })
    ).id;
    const history = await preLedgerAction(id, 'CONTACT_BUYER', 'history:foreign-grant', HISTORY_AT, foreign);
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: history, reason: expect.stringMatching(new RegExp(`names grant ${foreign}, which is not a grant of its project`)) });
  });
});

/*
 * Reviewer finding (repair-no-test-for-pre-ledger-rows): every scenario above
 * built its grant and effects after the ledger existed, so no fixture had the
 * production shape — months of recorded actions, across projects, before the
 * first AUTHORITY_DECISION row anywhere — and the permanent failure passed 161
 * tests. This fixture is that shape: history in two projects, then the ledger's
 * first decision, then ledgered work.
 */
describe('the production shape: months of recorded actions across projects before the ledger\'s first decision', () => {
  async function backdate(table: 'cash_actions' | 'cash_authorities', column: string, id: string, at: string): Promise<void> {
    await getDb().run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [at, id]);
  }

  async function historical(project: string, authority: string, action: string, key: string, at: string): Promise<string> {
    const row = (
      await recordAction({
        projectId: project, opportunityId: `opp-${key}`, authorityId: authority, action, performedBy: 'PERSON',
        reference: null, detail: 'recorded through the gate before the ledger existed', confirmedBy: 'PERSON', requestKey: key,
      })
    ).action.id;
    await backdate('cash_actions', 'created_at', row, at);
    return row;
  }

  async function secondProject(): Promise<{ id: string; grant: string }> {
    const { createProject } = await import('../server/repos/projects.ts');
    const id = (await createProject({ name: 'A second operation', slug: `second-${Math.random().toString(36).slice(2, 8)}` })).id;
    const grant = (
      await createAuthority({
        projectId: id, ownerUserId: userId, createdByUserId: userId, name: 'Second operation authority',
        allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
        maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
        startsAt: '2026-09-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      })
    ).id;
    return { id, grant };
  }

  it('September-to-November history in two projects, then ledgered work, reads ok with every historical row counted and none taken as proof', async () => {
    await backdate('cash_authorities', 'starts_at', grantId, '2026-09-01T00:00:00.000Z');
    const second = await secondProject();
    const rows = [
      await historical(projectId, grantId, 'CONTACT_BUYER', 'h1', '2026-09-15T10:00:00.000Z'),
      await historical(projectId, grantId, 'QUOTE_AND_INVOICE', 'h2', '2026-10-02T10:00:00.000Z'),
      await historical(second.id, second.grant, 'CONTACT_BUYER', 'h3', '2026-10-20T10:00:00.000Z'),
      await historical(second.id, second.grant, 'ACCEPT_PAYMENT', 'h4', '2026-11-08T23:59:00.000Z'),
    ];
    const id = await executing();
    await invoiced(id);
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(true);
    expect(reading.counts.unledgeredHistory).toBe(rows.length);
    for (const row of rows) expect(reading.detail).toContain(row);
    expect(reading.detail).toMatch(/^2 lifecycle effect\(s\) \(2 recorded action\(s\)/);
  });

  it('the ledger starts once for the whole Brain: a project that acts after it began, before its own first decision, is a violation', async () => {
    const second = await secondProject();
    await executing(); // the ledger's first decision, in the first project
    await new Promise((resolve) => setTimeout(resolve, 5));
    const late = (
      await recordAction({
        projectId: second.id, opportunityId: 'opp-late', authorityId: second.grant, action: 'CONTACT_BUYER', performedBy: 'BRAIN',
        reference: null, detail: 'written without asking', confirmedBy: 'BRAIN', requestKey: 'late:contact',
      })
    ).action.id;
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: late, reason: expect.stringMatching(/CONTACT_BUYER was performed with no authorization decision/) });
  });

  it('history under an emergency stop is still a violation, whatever its date', async () => {
    await backdate('cash_authorities', 'starts_at', grantId, '2026-09-01T00:00:00.000Z');
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'pause' });
    const stop = (await cashEventsOfKindInProject(projectId, 'AUTHORITY_EMERGENCY_STOP'))[0];
    expect(stop).toBeDefined();
    await getDb().run('UPDATE cash_events SET created_at = ? WHERE id = ?', ['2026-09-20T00:00:00.000Z', stop!.id]);
    const row = await historical(projectId, grantId, 'CONTACT_BUYER', 'h-under-stop', '2026-10-01T00:00:00.000Z');
    await setEmergencyStop({ projectId, on: false, actorUserId: userId, reason: 'resume' });
    await executing();
    const reading = await actionsObeyAuthorityOnRows();
    expect(reading.ok).toBe(false);
    expect(reading.violation).toEqual({ rowId: row, reason: expect.stringMatching(/emergency stop was on/) });
  });
});
