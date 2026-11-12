/**
 * repair-R6-F2-PROPOSED-NEVER-RECORDED: AUTH-34 requires "audit trails showing
 * exactly what Brain did versus what it proposed". The PROPOSED disposition
 * used to exist only in the pure judgment: the live entry
 * (`checkCommercialAuthority`) took no mode, and `recordDecision` skipped every
 * INTERNAL action, drafts included — so a drafted but unsent buyer message left
 * no row, and the production evidence still passed on "0 proposed only".
 *
 * This proves the ledger now records what Brain proposed, on the live entry and
 * on the tick that drafts a buyer message, that a proposal never authorizes an
 * effect, that the same draft is one row, and that the evidence refuses a sent
 * contact whose proposal is missing from the ledger.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  COMMERCIAL_ACTIONS,
  checkCommercialAuthority,
  decideAction,
  isLedgered,
  judgeAction,
  recordEffectReceipt,
} from '../server/services/cash/authority.ts';
import { policyToActionEvidence, policyToActionRule } from '../server/services/cash/authorityEvidence.ts';

let projectId = '';
let userId = '';
const suffix = (): string => Math.random().toString(36).slice(2, 10);

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `proposed-${suffix()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
});

async function granted(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

const decisions = async () =>
  (await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND)).map(
    (e): Record<string, unknown> => ({ id: e.id, opportunityId: e.opportunityId, ...(e.detail as Record<string, unknown>) }),
  );

describe('what Brain proposed is on the ledger', () => {
  it('the live entry records a proposal as PROPOSED, and a proposal never authorizes the effect', async () => {
    await granted();
    const proposed = await checkCommercialAuthority({
      projectId,
      action: 'CONTACT_BUYER',
      mode: 'PROPOSE',
      principal: 'BRAIN',
      subjectRef: 'offer-v1',
    });
    expect(proposed.ok).toBe(false);
    expect(proposed.proposed).toBe(true);
    expect(proposed.decisionId).toEqual(expect.any(String));
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'CONTACT_BUYER', disposition: 'PROPOSED', consequenceClass: 'EXTERNALLY_CONSEQUENTIAL', subjectRef: 'offer-v1', principal: 'BRAIN' });
  });

  it('a proposal needs no grant and raises no approval request, and is still recorded', async () => {
    const proposed = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', mode: 'PROPOSE', principal: 'BRAIN', subjectRef: 'offer-v1' });
    expect(proposed.ok).toBe(false);
    const rows = await decisions();
    expect(rows.map((r) => r.disposition)).toEqual(['PROPOSED']);
  });

  it('the same draft proposed again is one row; a changed draft is a new one', async () => {
    await granted();
    const first = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', mode: 'PROPOSE', principal: 'BRAIN', subjectRef: 'offer-v1' });
    const again = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', mode: 'PROPOSE', principal: 'BRAIN', subjectRef: 'offer-v1' });
    expect(again.decisionId).toBe(first.decisionId);
    await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', mode: 'PROPOSE', principal: 'BRAIN', subjectRef: 'offer-v2' });
    expect((await decisions()).map((r) => String(r.subjectRef)).sort()).toEqual(['offer-v1', 'offer-v2']);
  });

  it('a reading records nothing, proposal or not', async () => {
    await granted();
    await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', mode: 'PROPOSE', subjectRef: 'offer-v1' }, { record: false });
    expect(await decisions()).toEqual([]);
  });

  it('a drafted message is a proposal and is ledgered, though it is internal work', async () => {
    const draft = await decideAction({ projectId, action: 'DRAFT_MESSAGE', principal: 'BRAIN', subjectRef: 'draft-1' });
    expect(draft.ok).toBe(true);
    expect(draft.ledger.disposition).toBe('PROPOSED');
    expect(draft.decisionId).toEqual(expect.any(String));
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'DRAFT_MESSAGE', consequenceClass: 'INTERNAL', disposition: 'PROPOSED' });
    // Routine internal work stays off the ledger.
    expect((await decideAction({ projectId, action: 'CALCULATE' })).decisionId).toBeNull();
    expect(await decisions()).toHaveLength(1);
    const evidence = await policyToActionEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
    expect(evidence.detail).toMatch(/[1-9]\d* proposed only/);
  });

  it('the pure rule knows which decisions are ledgered', () => {
    const at = '2026-11-12T00:00:00.000Z';
    const state = { authority: null, revoked: false, heldCents: 0 };
    expect(isLedgered(judgeAction({ projectId: 'p', action: 'DRAFT_MESSAGE', at }, state))).toBe(true);
    expect(isLedgered(judgeAction({ projectId: 'p', action: 'CALCULATE', at }, state))).toBe(false);
    expect(isLedgered(judgeAction({ projectId: 'p', action: 'CALCULATE', mode: 'PROPOSE', at }, state))).toBe(true);
    expect(isLedgered(judgeAction({ projectId: 'p', action: 'SEND_OUTREACH', mode: 'PROPOSE', at }, state))).toBe(true);
    expect(policyToActionRule()).toBeNull();
  });
});

describe('the evidence refuses a contact performed with no proposal of it', () => {
  it('a performed CONTACT_BUYER whose proposal is missing fails; with its proposal it passes', async () => {
    await granted();
    const allowed = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', principal: 'BRAIN' });
    expect(allowed.ok).toBe(true);
    await recordEffectReceipt({ projectId, action: 'CONTACT_BUYER', decisionId: allowed.decisionId, disposition: 'PERFORMED', receiptRef: 'rcpt_1', actorRef: 'BRAIN' });
    const without = await policyToActionEvidence();
    expect(without.ok).toBe(false);
    expect(without.detail).toMatch(/no proposal of it on the ledger/);

    await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', mode: 'PROPOSE', principal: 'BRAIN', subjectRef: 'offer-v1' });
    const withProposal = await policyToActionEvidence();
    expect(withProposal.ok, withProposal.detail).toBe(true);
  });
});
