/**
 * Graduated authority on the action path (AUTH-20-3, AUTH-21-6, AUTH-34).
 *
 * Proves, against real rows, the scenario the specification's acceptance
 * demonstration names: a portfolio runs approved research, software
 * improvement and permissible commercial work concurrently while a prohibited
 * spend, an unsolicited send and a contract submission are refused; a
 * mid-flight revocation then stops further external mutations, keeps the
 * obligation that already exists, lets safe work continue and names the
 * precise action needing renewed authorization. The read side
 * (`authorityEvidence.ts`) must say "not demonstrated" on an empty Brain and
 * "demonstrated" only once those rows exist.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { commit, createAuthority, getCommitment, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  answerApprovalRequest,
  checkCommercialAuthority,
  classifyAction,
  decideAction,
  judgeAction,
  setEmergencyStop,
} from '../server/services/cash/authority.ts';
import {
  AUTHORITY_SUSPENDED_KIND,
  READ_ONLY_FORBIDDEN,
  authorityRulesHold,
  demonstrateGraduatedAuthority,
  demonstratePolicyToAction,
  demonstrateReadOnlyBoundary,
  readAuthorityRecords,
} from '../server/services/cash/authorityEvidence.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `grad-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function grant() {
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Portfolio commercial authority',
    allowedActions: ['QUOTE_AND_INVOICE', 'SPEND_FROM_ALLOWANCE', 'ACCEPT_PAYMENT'],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

describe('the rules hold in this process', () => {
  it('breaks no rule across the closed vocabulary and every path', () => {
    expect(authorityRulesHold()).toEqual([]);
  });

  it('classes the four kinds of action the specification distinguishes', () => {
    expect(classifyAction('READ_PUBLIC_SOURCE')).toBe('INTERNAL');
    expect(classifyAction('GENERATE_BENCHMARK')).toBe('INTERNAL');
    expect(classifyAction('FACTORY_MERGE')).toBe('STANDING_GRANT_ENGINEERING');
    expect(classifyAction('AUTHENTICATED_OPERATION')).toBe('THIRD_PARTY_AUTHENTICATED');
    for (const a of ['SEND_OUTREACH', 'PURCHASE_TOOL_OR_DATA', 'SIGN_AGREEMENT', 'CREATE_ACCOUNT', 'PUBLISH_EXTERNALLY', 'MOVE_FUNDS', 'GRANT_ACCESS']) {
      expect(classifyAction(a)).toBe('EXTERNALLY_CONSEQUENTIAL');
    }
    expect(classifyAction('ANYTHING_ELSE')).toBeNull();
  });

  it('never lets read-only learning reach a consequential act, through a browser or an API', () => {
    const wide = {
      authority: null,
      revoked: false,
      heldCents: 0,
    };
    for (const action of READ_ONLY_FORBIDDEN) {
      for (const path of ['BROWSER', 'API'] as const) {
        const d = judgeAction({ projectId: 'p', action, path, access: 'READ_ONLY', amountCents: 1 }, wide);
        expect(d.ok, `${action} via ${path}`).toBe(false);
        expect(d.ledger.cause).toBe('READ_ONLY_GRANT');
        expect(d.neededApproval?.action).toBe(action);
      }
    }
    expect(judgeAction({ projectId: 'p', action: 'VIEW_PORTAL', path: 'BROWSER', access: 'READ_ONLY' }, wide).ok).toBe(true);
    expect(judgeAction({ projectId: 'p', action: 'LEARN_FROM_SITE', path: 'BROWSER', access: 'READ_ONLY' }, wide).ok).toBe(true);
  });
});

describe('the evidence reader refuses to call an empty Brain demonstrated', () => {
  it('reports each requirement as not yet demonstrated when no rows exist', async () => {
    for (const result of [
      await demonstrateGraduatedAuthority([projectId]),
      await demonstrateReadOnlyBoundary([projectId]),
      await demonstratePolicyToAction([projectId]),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/not yet demonstrated/);
    }
  });
});

describe('the acceptance demonstration, on real rows', () => {
  it('runs a concurrent portfolio, blocks prohibited acts, survives a mid-flight revocation, and is read back as demonstrated', async () => {
    const authority = await grant();
    const principal = 'usr:owner';

    // Concurrent approved research, software improvement and permissible commerce, beside prohibited acts.
    const [research, improvement, invoice, spendTooBig, unsolicitedSend, contract, browserSubmit, credential] = await Promise.all([
      decideAction({ projectId, action: 'READ_PUBLIC_SOURCE', path: 'BROWSER', principal }),
      decideAction({ projectId, action: 'FACTORY_CODE', path: 'INTERNAL', principal, releaseEnvelopeAllows: true }),
      decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'API', principal }),
      decideAction({ projectId, action: 'SPEND_FROM_ALLOWANCE', path: 'API', principal, amountCents: 90_000 }),
      decideAction({ projectId, action: 'SEND_OUTREACH', path: 'API', principal }),
      decideAction({ projectId, action: 'SIGN_AGREEMENT', path: 'BROWSER', principal }),
      decideAction({ projectId, action: 'SUBMIT_FORM', path: 'BROWSER', principal, access: 'READ_ONLY' }),
      decideAction({ projectId, action: 'NEW_CREDENTIAL', path: 'API', principal }),
    ]);
    expect(research.ok).toBe(true);
    expect(improvement.ok).toBe(true);
    expect(invoice.ok).toBe(true);
    expect(invoice.ledger.disposition).toBe('PERFORMED');
    expect(spendTooBig.ok).toBe(false);
    expect(spendTooBig.ledger.cause).toBe('OVER_PER_ACTION_CEILING');
    expect(unsolicitedSend.ok).toBe(false);
    expect(unsolicitedSend.ledger.cause).toBe('NOT_COVERED');
    expect(contract.ok).toBe(false);
    expect(contract.ledger.path).toBe('BROWSER');
    expect(browserSubmit.ledger.cause).toBe('READ_ONLY_GRANT');
    expect(credential.ledger.cause).toBe('PROHIBITED');

    // A draft is recorded as what Brain proposed, not what it did.
    const draft = await decideAction({ projectId, action: 'SEND_OUTREACH', path: 'API', principal, mode: 'PROPOSE' });
    expect(draft.ledger.disposition).toBe('PROPOSED');

    // Every consequential decision left one durable row with principal and scope; internal work left none.
    const ledger = await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND);
    expect(ledger.map((r) => r.detail.action).sort()).toEqual(
      ['FACTORY_CODE', 'NEW_CREDENTIAL', 'QUOTE_AND_INVOICE', 'SEND_OUTREACH', 'SEND_OUTREACH', 'SIGN_AGREEMENT', 'SPEND_FROM_ALLOWANCE', 'SUBMIT_FORM'],
    );
    for (const row of ledger) {
      expect(row.detail.principal).toBe(principal);
      expect(row.detail.scope).toEqual({ projectId, accountRef: null });
    }

    // The smallest missing approval is asked once per scope, and the answer is remembered.
    const again = await decideAction({ projectId, action: 'SEND_OUTREACH', path: 'API', principal });
    expect(again.approvalNeedId).toBe(unsolicitedSend.approvalNeedId);
    const asked = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith('authority-approval:'));
    expect(asked.filter((n) => n.blockedAction === 'SEND_OUTREACH')).toHaveLength(1);
    const answered = await answerApprovalRequest({ needId: unsolicitedSend.approvalNeedId!, approve: true, actorUserId: userId, note: 'Approved for this buyer list' });
    expect(answered.ok).toBe(true);
    const remembered = await decideAction({ projectId, action: 'SEND_OUTREACH', path: 'API', principal });
    expect(remembered.ok).toBe(true);
    expect(remembered.ledger.cause).toBe('OWNER_APPROVED');
    const declined = await answerApprovalRequest({ needId: contract.approvalNeedId!, approve: false, actorUserId: userId, note: 'No contracts yet' });
    expect(declined.ok).toBe(true);
    const notReasked = await decideAction({ projectId, action: 'SIGN_AGREEMENT', path: 'BROWSER', principal });
    expect(notReasked.ok).toBe(false);
    expect(notReasked.neededApproval).toBeNull();

    // An obligation already exists when the owner revokes mid-flight.
    const held = await commit({
      authorityId: authority.id,
      projectId,
      amountCents: 12_000,
      currency: 'USD',
      purpose: 'Supplier deposit',
      expectedResult: 'Delivery',
      stopCondition: 'Delivered or refunded',
      idempotencyKey: 'deposit-1',
      createdBy: userId,
    });
    expect(held.ok).toBe(true);
    expect(await revokeAuthority({ authorityId: authority.id, actorUserId: userId, reason: 'Pausing commerce' })).toBe(true);

    const blocked = await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'BROWSER', principal });
    expect(blocked.ok).toBe(false);
    expect(blocked.ledger.cause).toBe('REVOKED');
    expect(blocked.obligations?.heldCents).toBe(12_000);
    expect(blocked.obligations?.heldCommitmentIds).toEqual([held.commitment!.id]);
    expect(blocked.remainingSafeWork).toContain('INTERNAL');
    expect(blocked.neededApproval?.description).toMatch(/QUOTE_AND_INVOICE/);
    expect((await checkCommercialAuthority({ projectId, action: 'QUOTE_AND_INVOICE' })).ok).toBe(false);
    // The obligation is still owed and tracked, and safe work still proceeds.
    expect((await getCommitment(held.commitment!.id))?.state).toBe('HELD');
    expect((await decideAction({ projectId, action: 'READ_ONLY_ANALYSIS', principal })).ok).toBe(true);
    const suspended = await cashEventsOfKindInProject(projectId, AUTHORITY_SUSPENDED_KIND);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.detail).toMatchObject({ action: 'QUOTE_AND_INVOICE', cause: 'REVOKED', heldCents: 12_000, heldCommitmentIds: [held.commitment!.id] });

    // The read side now finds every requirement demonstrated on these rows.
    const records = await readAuthorityRecords([projectId]);
    expect(records.defects).toEqual([]);
    expect((await demonstrateGraduatedAuthority([projectId])).ok).toBe(true);
    expect((await demonstrateReadOnlyBoundary([projectId])).ok).toBe(true);
    expect((await demonstratePolicyToAction([projectId])).ok).toBe(true);
  });

  it('pauses risky mutations under an emergency stop without touching obligations or internal work', async () => {
    await grant();
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'Investigating' });
    const stopped = await decideAction({ projectId, action: 'ACCEPT_PAYMENT', path: 'API', principal: 'usr:owner' });
    expect(stopped.ok).toBe(false);
    expect(stopped.ledger.cause).toBe('EMERGENCY_STOP');
    expect(stopped.remainingSafeWork).toContain('INTERNAL');
    expect((await decideAction({ projectId, action: 'CALCULATE' })).ok).toBe(true);
    // A stop and a resume in the same millisecond tie, and a tie reads as stopped; a real resume comes later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setEmergencyStop({ projectId, on: false, actorUserId: userId, reason: 'Resolved' });
    expect((await decideAction({ projectId, action: 'ACCEPT_PAYMENT', path: 'API', principal: 'usr:owner' })).ok).toBe(true);
  });

  it('flags a ledger row that carries anything outside its shape', async () => {
    await grant();
    await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'API' });
    const { recordCashEvent } = await import('../server/repos/cashMode.ts');
    await recordCashEvent({
      projectId,
      kind: AUTHORITY_DECISION_KIND,
      actorRef: 'BRAIN',
      summary: 'forged',
      detail: { action: 'MOVE_FUNDS', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', path: 'API', principal: null, scope: { projectId }, disposition: 'PERFORMED', cause: 'NOT_COVERED', ok: true, token: 'x' },
    });
    const records = await readAuthorityRecords([projectId]);
    expect(records.defects.length).toBeGreaterThanOrEqual(2);
    expect((await demonstrateGraduatedAuthority([projectId])).detail).toMatch(/malformed/);
  });
});
