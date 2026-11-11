/**
 * AUTH-20-3, AUTH-21-6 and AUTH-34 of the Brain-architecture program, driven
 * through the real action path (`decideAction`, `checkCommercialAuthority`)
 * against real rows, and read back by the evidence functions the probes
 * `r01.auth-20-3`, `r01.auth-21-6` and `r01.auth-34` call.
 *
 * The acceptance demonstration of AUTH-34 is here in full: a portfolio runs
 * approved research, software improvement and a permitted commercial act
 * concurrently while a prohibited spend, an unsolicited send and a contract
 * submission are refused; a mid-flight revocation stops further external
 * mutations and records the obligations still owed, the safe work that
 * continues and the precise action needing renewed authorization.
 *
 * The evidence functions are also shown to *fail* on rows that contradict the
 * requirement — a check that cannot fail proves nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { commit, createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { recordCashEvent, cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { needForKey } from '../server/repos/cashPortfolio.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  approvalScopeKey,
  answerApprovalRequest,
  checkCommercialAuthority,
  decideAction,
  setEmergencyStop,
} from '../server/services/cash/authority.ts';
import {
  AUTHORITY_SUSPENDED_KIND,
  graduatedAuthorityEvidence,
  graduatedAuthorityRule,
  policyToActionEvidence,
  policyToActionRule,
  readOnlyLearningEvidence,
  readOnlyLearningRule,
} from '../server/services/cash/authorityEvidence.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `p0-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function grant(allowedActions: string[]) {
  return createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Commercial authority',
    allowedActions,
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

const decisionRows = () => cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND);

describe('the rules hold in memory', () => {
  it('graduated authority, read-only learning and policy-to-action all hold', () => {
    expect(graduatedAuthorityRule()).toBeNull();
    expect(readOnlyLearningRule()).toBeNull();
    expect(policyToActionRule()).toBeNull();
  });
});

describe('no rows is not a demonstration', () => {
  it('every evidence check refuses an empty ledger', async () => {
    for (const evidence of [graduatedAuthorityEvidence, readOnlyLearningEvidence, policyToActionEvidence]) {
      const result = await evidence();
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/no authority decision/);
    }
  });
});

describe('AUTH-20-3: graduated authority with a durable ledger', () => {
  it('internal work leaves no row and needs no grant; consequential work is ledgered with principal and scope', async () => {
    const research = await decideAction({ projectId, action: 'READ_PUBLIC_SOURCE', principal: userId });
    expect(research.ok).toBe(true);
    expect(await decisionRows()).toHaveLength(0);

    const refused = await decideAction({ projectId, action: 'CONTACT_BUYER', path: 'API', principal: userId });
    expect(refused.ok).toBe(false);
    expect(refused.ledger.cause).toBe('NO_AUTHORITY');
    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      action: 'CONTACT_BUYER',
      consequenceClass: 'EXTERNALLY_CONSEQUENTIAL',
      disposition: 'REFUSED',
      principal: userId,
      scope: { projectId, accountRef: null },
    });
  });

  it('asks once for the smallest missing approval, and remembers the answer for that scope', async () => {
    await grant(['QUOTE_AND_INVOICE']);
    const first = await decideAction({ projectId, action: 'CONTACT_BUYER', principal: userId });
    expect(first.ok).toBe(false);
    expect(first.ledger.cause).toBe('NOT_COVERED');
    expect(first.neededApproval?.description).toContain('CONTACT_BUYER');
    expect(first.approvalNeedId).toBeTruthy();

    // Asked again: the same open request, not a second one.
    const again = await decideAction({ projectId, action: 'CONTACT_BUYER', principal: userId });
    expect(again.approvalNeedId).toBe(first.approvalNeedId);

    const answered = await answerApprovalRequest({ needId: first.approvalNeedId!, approve: true, actorUserId: userId, note: 'Approved for this project.' });
    expect(answered.ok).toBe(true);
    const need = await needForKey(projectId, approvalScopeKey(projectId, 'CONTACT_BUYER', 'NOT_COVERED'));
    expect(need?.state).toBe('RESOLVED');

    const remembered = await decideAction({ projectId, action: 'CONTACT_BUYER', principal: userId });
    expect(remembered.ok).toBe(true);
    expect(remembered.ledger.cause).toBe('OWNER_APPROVED');

    const evidence = await graduatedAuthorityEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
  });
});

describe('AUTH-21-6: read-only learning never authorizes consequential agency', () => {
  it('refuses every consequential act to a read-only holder on the browser path, while learning continues', async () => {
    await grant(['CONTACT_BUYER', 'SPEND_FROM_ALLOWANCE', 'QUOTE_AND_INVOICE']);
    for (const action of ['CONTACT_BUYER', 'SPEND_FROM_ALLOWANCE']) {
      const decision = await checkCommercialAuthority({ projectId, action, path: 'BROWSER', access: 'READ_ONLY', amountCents: 500, principal: userId });
      expect(decision.ok, action).toBe(false);
      expect(decision.reason).toMatch(/read-only/);
    }
    for (const action of ['SIGN_AGREEMENT', 'SEND_OUTREACH', 'SUBMIT_BID', 'INITIATE_PAYMENT', 'SCRAPE_PROTECTED', 'CREATE_ACCOUNT']) {
      const decision = await decideAction({ projectId, action, path: 'BROWSER', access: 'READ_ONLY', amountCents: 500, principal: userId });
      expect(decision.ok, action).toBe(false);
    }
    // A payment need open does not stop routine research.
    const learning = await decideAction({ projectId, action: 'LEARN_FROM_SITE', path: 'BROWSER', access: 'READ_ONLY', principal: userId });
    expect(learning.ok).toBe(true);

    const evidence = await readOnlyLearningEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
    expect(evidence.detail).toMatch(/read-only refusal/);
  });
});

describe('AUTH-34: policy-to-action authority — the acceptance demonstration', () => {
  it('runs a concurrent portfolio while a prohibited spend, an unsolicited send and a contract submission are blocked', async () => {
    await grant(['QUOTE_AND_INVOICE']);
    const [research, improvement, invoice, spend, send, contract] = await Promise.all([
      decideAction({ projectId, action: 'READ_PUBLIC_SOURCE', principal: userId }),
      decideAction({ projectId, action: 'FACTORY_CODE', releaseEnvelopeAllows: true, principal: userId }),
      decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'API', principal: userId }),
      decideAction({ projectId, action: 'PURCHASE_TOOL_OR_DATA', amountCents: 1_000, principal: userId }),
      decideAction({ projectId, action: 'SEND_OUTREACH', path: 'BROWSER', principal: userId }),
      decideAction({ projectId, action: 'SIGN_AGREEMENT', path: 'BROWSER', principal: userId }),
    ]);
    expect([research.ok, improvement.ok, invoice.ok]).toEqual([true, true, true]);
    expect([spend.ok, send.ok, contract.ok]).toEqual([false, false, false]);
    for (const blocked of [spend, send, contract]) expect(blocked.ledger.disposition).toBe('REFUSED');

    const evidence = await policyToActionEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
    expect(evidence.detail).toMatch(/on a browser path/);
  });

  it('a mid-flight revocation stops further mutations, keeps the obligations and names the renewal', async () => {
    const authority = await grant(['QUOTE_AND_INVOICE', 'SPEND_FROM_ALLOWANCE']);
    const held = await commit({
      authorityId: authority.id,
      projectId,
      amountCents: 2_500,
      currency: 'USD',
      purpose: 'Buy a supplier quote',
      expectedResult: 'A quotable cost',
      stopCondition: 'Stop at one quote',
      idempotencyKey: 'p0-held',
      createdBy: userId,
    });
    expect(held.ok).toBe(true);
    expect((await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: userId })).ok).toBe(true);

    expect(await revokeAuthority({ authorityId: authority.id, actorUserId: userId, reason: 'pausing commercial work' })).toBe(true);

    const after = await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: userId });
    expect(after.ok).toBe(false);
    expect(after.ledger.cause).toBe('REVOKED');
    expect(after.obligations?.heldCents).toBe(2_500);
    expect(after.obligations?.heldCommitmentIds).toEqual([held.commitment!.id]);
    expect(after.remainingSafeWork).toContain('INTERNAL');
    expect(after.neededApproval?.description).toContain('QUOTE_AND_INVOICE');

    const suspended = await cashEventsOfKindInProject(projectId, AUTHORITY_SUSPENDED_KIND);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.detail).toMatchObject({ action: 'QUOTE_AND_INVOICE', cause: 'REVOKED', heldCents: 2_500, heldCommitmentIds: [held.commitment!.id] });

    // Safe work continues.
    expect((await decideAction({ projectId, action: 'READ_ONLY_ANALYSIS', principal: userId })).ok).toBe(true);

    const evidence = await policyToActionEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
    expect(evidence.detail).toMatch(/1 suspension/);
  });

  it('the emergency stop pauses risky mutations only, and lifting it resumes them', async () => {
    await grant(['QUOTE_AND_INVOICE']);
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'checking a dispute' });
    const stopped = await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: userId });
    expect(stopped.ok).toBe(false);
    expect(stopped.ledger.cause).toBe('EMERGENCY_STOP');
    expect((await decideAction({ projectId, action: 'CALCULATE', principal: userId })).ok).toBe(true);
    // A later row is strictly newer than the stop, so the resume reads as the newest control.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setEmergencyStop({ projectId, on: false, actorUserId: userId, reason: 'resolved' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', principal: userId })).ok).toBe(true);

    const evidence = await policyToActionEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
  });
});

describe('the evidence fails on rows that contradict the requirement', () => {
  const performedRow = (action: string, cause: string) => ({
    action,
    consequenceClass: 'EXTERNALLY_CONSEQUENTIAL',
    path: 'BROWSER',
    principal: null,
    scope: { projectId, accountRef: null },
    disposition: 'PERFORMED',
    cause,
    policyVersion: null,
    amountCents: null,
    decidedAt: new Date().toISOString(),
    ok: true,
    approvalNeedId: null,
    neededApproval: null,
  });

  it('a consequential effect recorded while the emergency stop was on', async () => {
    await grant(['QUOTE_AND_INVOICE']);
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordCashEvent({ projectId, kind: AUTHORITY_DECISION_KIND, actorRef: 'BRAIN', summary: 'forged', detail: { ...performedRow('QUOTE_AND_INVOICE', 'ALLOWED'), scope: { projectId, accountRef: null } } });
    const evidence = await policyToActionEvidence();
    expect(evidence.ok).toBe(false);
    expect(evidence.detail).toMatch(/emergency stop was on/);
  });

  it('a read-only holder recorded as having signed', async () => {
    await recordCashEvent({ projectId, kind: AUTHORITY_DECISION_KIND, actorRef: 'BRAIN', summary: 'forged', detail: performedRow('SIGN_AGREEMENT', 'READ_ONLY_GRANT') });
    const evidence = await readOnlyLearningEvidence();
    expect(evidence.ok).toBe(false);
    expect(evidence.detail).toMatch(/READ_ONLY_GRANT/);
  });

  it('a consequential effect performed with no grant in force', async () => {
    await recordCashEvent({ projectId, kind: AUTHORITY_DECISION_KIND, actorRef: 'BRAIN', summary: 'forged', detail: performedRow('SEND_OUTREACH', 'ALLOWED') });
    expect((await policyToActionEvidence()).detail).toMatch(/no grant in force/);
    expect((await readOnlyLearningEvidence()).detail).toMatch(/no grant in force/);
  });

  it('a ledger row missing its principal', async () => {
    const { principal: _dropped, ...noPrincipal } = performedRow('SEND_OUTREACH', 'ALLOWED');
    await recordCashEvent({ projectId, kind: AUTHORITY_DECISION_KIND, actorRef: 'BRAIN', summary: 'forged', detail: noPrincipal });
    expect((await graduatedAuthorityEvidence()).detail).toMatch(/no principal/);
  });

  it('a ledger row carrying something shaped like a credential', async () => {
    await recordCashEvent({ projectId, kind: AUTHORITY_DECISION_KIND, actorRef: 'BRAIN', summary: 'forged', detail: { ...performedRow('SEND_OUTREACH', 'PROHIBITED'), disposition: 'REFUSED', ok: false, note: 'Bearer abcdefghijklmnopqrstuvwxyz0123' } });
    expect((await graduatedAuthorityEvidence()).detail).toMatch(/credential/);
  });

  it('an approval named but never stored', async () => {
    await recordCashEvent({ projectId, kind: AUTHORITY_DECISION_KIND, actorRef: 'BRAIN', summary: 'forged', detail: { ...performedRow('CONTACT_BUYER', 'NOT_COVERED'), disposition: 'REFUSED', ok: false, neededApproval: 'add CONTACT_BUYER to the standing grant' } });
    expect((await graduatedAuthorityEvidence()).detail).toMatch(/without storing the request/);
  });
});
