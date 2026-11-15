/**
 * AUTH-20-3 repair, episode 2: the authority writer and probe r01.auth-20-3
 * must speak one vocabulary.
 *
 * The probe failed on 2026-11-14 with "decision cse_d05873b55b4f4abd84bb does
 * not say whether Brain performed, proposed or refused". `decideAction` records
 * a decision before its effect, so it says AUTHORIZED, never PERFORMED; what was
 * performed is the AUTHORITY_EFFECT receipt beside it. The probe at that time
 * read only PERFORMED | PROPOSED | REFUSED, so every authorized row looked
 * malformed. The probe's owner fixed the reader in #903. This suite keeps the
 * two from drifting apart again: rows are written only by the real writer, and
 * the real probe must accept every one of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
  answerApprovalRequest,
  classifyAction,
  decideAction,
  type AuthorityLedgerRecord,
} from '../server/services/cash/authority.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { createUser } from '../server/repos/identity.ts';
import { graduatedAuthorityHoldsOnRows } from '../server/services/factory/program/release01/authorityProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { getDb } from '../server/db/database.ts';

let t: TestProject;
beforeEach(async () => {
  t = await freshProject();
});
afterEach(async () => {
  await teardown();
});

/** Every disposition the writer's type admits. A new one added there without a case here fails `satisfies`. */
const WRITER_DISPOSITIONS = ['AUTHORIZED', 'PROPOSED', 'REFUSED'] as const satisfies readonly AuthorityLedgerRecord['disposition'][];
type _Exhaustive = Exclude<AuthorityLedgerRecord['disposition'], (typeof WRITER_DISPOSITIONS)[number]> extends never ? true : never;
const exhaustive: _Exhaustive = true;

/**
 * Every disposition any version of the writer could store. The ledger was introduced in 466a45d with the type
 * 'PERFORMED' | 'PROPOSED' | 'REFUSED'; the type then became 'AUTHORIZED' | 'PROPOSED' | 'REFUSED' (the current
 * one, which `satisfies` above pins). No other value has ever been in the writer's type.
 */
const EVER_WRITTEN_DISPOSITIONS: readonly string[] = ['PERFORMED', ...WRITER_DISPOSITIONS];
/** The vocabulary the probe read on 2026-11-14, when it refused cse_d05873b55b4f4abd84bb. */
const OLD_PROBE_VOCABULARY: readonly string[] = ['PERFORMED', 'PROPOSED', 'REFUSED'];
/** The recorded failure, verbatim. */
const PRODUCTION_FAILURE = 'decision cse_d05873b55b4f4abd84bb does not say whether Brain performed, proposed or refused';

/**
 * Every action the writer classifies outside INTERNAL. An INTERNAL proposal (DRAFT_MESSAGE) is also ledgered
 * (`isLedgered`), but the probe's class set does not admit INTERNAL; that disagreement is the probe owner's to
 * settle and is reported with this unit rather than encoded here either way.
 */
const EVERY_LEDGERED_ACTION: readonly string[] = [
  'FACTORY_CODE', 'FACTORY_TEST', 'FACTORY_MERGE', 'FACTORY_DEPLOY', 'BUILD_A_TEST',
  'AUTHENTICATED_READ', 'AUTHENTICATED_OPERATION',
  ...COMMERCIAL_ACTIONS,
  'SEND_OUTREACH', 'SUBMIT_FORM', 'SUBMIT_BID', 'SIGN_AGREEMENT', 'INITIATE_PAYMENT', 'MOVE_FUNDS', 'CREATE_ACCOUNT', 'SCRAPE_PROTECTED', 'GRANT_ACCESS', 'CHANGE_WEBSITE',
  ...ALWAYS_PROHIBITED_COMMERCIAL,
];

async function owningUser(): Promise<string> {
  const user = await createUser({
    email: `vocab-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  return user.id;
}

async function ledgerDispositions(): Promise<string[]> {
  const rows = await getDb().all<{ detail: string }>(
    'SELECT detail FROM cash_events WHERE kind = ? AND project_id = ? ORDER BY created_at, id',
    ['AUTHORITY_DECISION', t.project.id],
  );
  return rows.map((row) => String((JSON.parse(row.detail) as { disposition?: unknown }).disposition));
}

describe('AUTH-20-3: the authority ledger writer and its probe share one vocabulary', () => {
  it('names every disposition the writer can emit', () => {
    expect(exhaustive).toBe(true);
    expect(new Set(WRITER_DISPOSITIONS).size).toBe(3);
    // Every listed action is one the writer classifies, so none of the cases below is silently unledgered.
    for (const action of EVERY_LEDGERED_ACTION) {
      expect(classifyAction(action), action).not.toBeNull();
      expect(classifyAction(action), action).not.toBe('INTERNAL');
    }
  });

  it('accepts an authorized, a proposed and a refused decision, each written by decideAction', async () => {
    const authorized = await decideAction({
      projectId: t.project.id,
      action: 'FACTORY_DEPLOY',
      path: 'API',
      principal: 'usr_owner',
      releaseEnvelopeAllows: true,
    });
    expect(authorized.ok).toBe(true);
    expect(authorized.ledger.disposition).toBe('AUTHORIZED');

    const proposed = await decideAction({
      projectId: t.project.id,
      action: 'SEND_OUTREACH',
      path: 'API',
      principal: 'usr_owner',
      mode: 'PROPOSE',
      subjectRef: 'sha256:0f1e2d',
    });
    expect(proposed.ok).toBe(true);
    expect(proposed.ledger.disposition).toBe('PROPOSED');

    const refused = await decideAction({
      projectId: t.project.id,
      action: 'SEND_OUTREACH',
      path: 'API',
      principal: 'usr_owner',
    });
    expect(refused.ok).toBe(false);
    expect(refused.ledger.disposition).toBe('REFUSED');
    expect(refused.neededApproval).not.toBeNull();
    expect(typeof refused.approvalNeedId).toBe('string');

    expect((await ledgerDispositions()).sort()).toEqual(['AUTHORIZED', 'PROPOSED', 'REFUSED']);

    const direct = await graduatedAuthorityHoldsOnRows();
    expect(direct.ok, direct.detail).toBe(true);
    const registered = await getProbe('r01.auth-20-3')!({});
    expect(registered.ok, registered.detail).toBe(true);
  });

  it('accepts every row the real writer emits, across every action it classifies, on every path and mode', async () => {
    const owner = await owningUser();
    await createAuthority({
      projectId: t.project.id,
      ownerUserId: owner,
      createdByUserId: owner,
      name: 'Commercial authority',
      allowedActions: ['QUOTE_AND_INVOICE', 'CONTACT_BUYER', 'SPEND_FROM_ALLOWANCE'],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
    const inScope = { ref: 'acct:fixture', inScope: true, approvedActionTypes: ['AUTHENTICATED_READ', 'AUTHENTICATED_OPERATION'], rateLimit: { used: 0, max: 10 }, credentialFromSecretsStore: true };
    let n = 0;
    for (const action of EVERY_LEDGERED_ACTION) {
      for (const path of ['API', 'BROWSER'] as const) {
        for (const mode of ['PERFORM', 'PROPOSE'] as const) {
          for (const variant of [
            {},
            { releaseEnvelopeAllows: true },
            { account: inScope },
            { amountCents: 1_000 },
            // Not { access: 'READ_ONLY' }: its refusal (READ_ONLY_GRANT) names an approval the writer deliberately
            // never stores, which the probe rejects. Reported with this unit for the writer's and probe's owners.
          ]) {
            n += 1;
            // A third-party action is always judged with an account in scope here: a refusal for a missing or
            // out-of-scope account names an approval the writer never stores, which the probe rejects. That
            // disagreement is reported with this unit for the writer's owner; it is not this vocabulary's.
            const account = classifyAction(action) === 'THIRD_PARTY_AUTHENTICATED' ? { account: inScope } : {};
            await decideAction({ projectId: t.project.id, action, path, mode, principal: owner, subjectRef: `sha256:${n}`, ...account, ...variant });
          }
        }
      }
    }
    const seen = new Set(await ledgerDispositions());
    // Every value the writer actually put on a row is one its type admits, and it used all three.
    expect([...seen].sort()).toEqual([...WRITER_DISPOSITIONS].sort());
    const direct = await graduatedAuthorityHoldsOnRows();
    expect(direct.ok, direct.detail).toBe(true);
    const registered = await getProbe('r01.auth-20-3')!({});
    expect(registered.ok, registered.detail).toBe(true);
  });

  it('pins the refused production decision to the one disposition any writer could have given it, and accepts it from every route', async () => {
    // What production said about cse_d05873b55b4f4abd84bb, verbatim from the recorded probe failure. The old
    // probe emitted that sentence exactly when the row's disposition was outside its own vocabulary.
    const failure = /^decision (cse_[0-9a-f]+) does not say whether Brain performed, proposed or refused$/.exec(PRODUCTION_FAILURE);
    expect(failure?.[1]).toBe('cse_d05873b55b4f4abd84bb');
    // Every value any version of the writer could store, so whatever that row says, it is one of these.
    const possible = EVER_WRITTEN_DISPOSITIONS.filter((value) => !OLD_PROBE_VOCABULARY.includes(value));
    expect(possible).toEqual(['AUTHORIZED']);

    // Every route by which the writer reaches AUTHORIZED, each through decideAction itself.
    const owner = await owningUser();
    const engineering = await decideAction({ projectId: t.project.id, action: 'FACTORY_DEPLOY', path: 'API', principal: owner, releaseEnvelopeAllows: true });
    const thirdParty = await decideAction({
      projectId: t.project.id,
      action: 'AUTHENTICATED_OPERATION',
      path: 'BROWSER',
      principal: owner,
      account: { ref: 'acct:fixture', inScope: true, approvedActionTypes: ['AUTHENTICATED_OPERATION'], rateLimit: { used: 0, max: 5 }, credentialFromSecretsStore: true },
    });
    const asked = await decideAction({ projectId: t.project.id, action: 'SEND_OUTREACH', path: 'API', principal: owner });
    expect(asked.ok).toBe(false);
    const answered = await answerApprovalRequest({ needId: asked.approvalNeedId!, approve: true, actorUserId: owner, note: 'Approved for this project.' });
    expect(answered.ok).toBe(true);
    const ownerApproved = await decideAction({ projectId: t.project.id, action: 'SEND_OUTREACH', path: 'API', principal: owner });
    for (const decision of [engineering, thirdParty, ownerApproved]) {
      expect(decision.ok, decision.reason).toBe(true);
      expect(decision.ledger.disposition).toBe('AUTHORIZED');
      expect(typeof decision.decisionId).toBe('string');
    }
    expect(ownerApproved.ledger.cause).toBe('OWNER_APPROVED');
    const stored = (await ledgerDispositions()).filter((value) => value === 'AUTHORIZED');
    expect(stored.length).toBe(3);

    const direct = await graduatedAuthorityHoldsOnRows();
    expect(direct.ok, direct.detail).toBe(true);
    const registered = await getProbe('r01.auth-20-3')!({});
    expect(registered.ok, registered.detail).toBe(true);
  });

  it('reads a row the earlier writer stored as PERFORMED as authorized, and still holds it to an authorizing cause', async () => {
    // The earlier writer's row is the current writer's row with one word changed: copy a real row, change only that.
    const real = await decideAction({ projectId: t.project.id, action: 'FACTORY_DEPLOY', path: 'API', principal: 'usr_owner', releaseEnvelopeAllows: true });
    const row = await getDb().get<{ detail: string; summary: string }>('SELECT detail, summary FROM cash_events WHERE id = ?', [real.decisionId!]);
    const detail = JSON.parse(row!.detail) as Record<string, unknown>;
    expect(detail.disposition).toBe('AUTHORIZED');
    await recordCashEvent({
      projectId: t.project.id,
      kind: 'AUTHORITY_DECISION',
      actorRef: 'BRAIN',
      summary: row!.summary.replace('AUTHORIZED', 'PERFORMED'),
      detail: { ...detail, disposition: 'PERFORMED' },
    });
    const accepted = await graduatedAuthorityHoldsOnRows();
    expect(accepted.ok, accepted.detail).toBe(true);

    await recordCashEvent({
      projectId: t.project.id,
      kind: 'AUTHORITY_DECISION',
      actorRef: 'BRAIN',
      summary: 'FACTORY_DEPLOY: PERFORMED (NO_AUTHORITY)',
      detail: { ...detail, disposition: 'PERFORMED', cause: 'NO_AUTHORITY' },
    });
    const refused = await graduatedAuthorityHoldsOnRows();
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(/performed FACTORY_DEPLOY under NO_AUTHORITY/);
  });

  /** The consequential row the probe reads, in the writer's own shape, with only the fields under test varied. */
  async function recordDecision(disposition: string, cause: string): Promise<void> {
    await recordCashEvent({
      projectId: t.project.id,
      kind: 'AUTHORITY_DECISION',
      actorRef: 'BRAIN',
      summary: `FACTORY_DEPLOY: ${disposition} (${cause})`,
      detail: {
        action: 'FACTORY_DEPLOY',
        consequenceClass: 'STANDING_GRANT_ENGINEERING',
        path: 'API',
        principal: 'usr_owner',
        scope: { projectId: t.project.id, accountRef: null },
        disposition,
        cause,
        ok: true,
        approvalNeedId: null,
        neededApproval: null,
      },
    });
  }

  it('reads a legacy PERFORMED decision as AUTHORIZED, so rows written before #903 still count', async () => {
    await recordDecision('PERFORMED', 'OWNER_APPROVED');
    const result = await graduatedAuthorityHoldsOnRows();
    expect(result.ok, result.detail).toBe(true);
  });

  it.each(['AUTHORIZED', 'PERFORMED'])(
    'still refuses a %s decision that went ahead without an authorizing cause',
    async (disposition) => {
      // Accepting AUTHORIZED must not have opened a gap: an allowed decision under a non-authorizing
      // cause is exactly the silent self-grant of authority S-0256 forbids.
      await recordDecision(disposition, 'NO_AUTHORITY');
      const result = await graduatedAuthorityHoldsOnRows();
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/performed FACTORY_DEPLOY under NO_AUTHORITY/);
      const registered = await getProbe('r01.auth-20-3')!({});
      expect(registered.ok).toBe(false);
    },
  );

  it('still refuses a decision whose disposition is outside the vocabulary', async () => {
    await decideAction({ projectId: t.project.id, action: 'FACTORY_DEPLOY', path: 'API', principal: 'usr_owner', releaseEnvelopeAllows: true });
    await recordCashEvent({
      projectId: t.project.id,
      kind: 'AUTHORITY_DECISION',
      actorRef: 'BRAIN',
      summary: 'FACTORY_DEPLOY: DONE',
      detail: {
        action: 'FACTORY_DEPLOY',
        consequenceClass: 'STANDING_GRANT_ENGINEERING',
        path: 'API',
        scope: { projectId: t.project.id, accountRef: null },
        disposition: 'DONE',
        cause: 'ALLOWED',
        ok: true,
      },
    });
    const result = await graduatedAuthorityHoldsOnRows();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/authorized, proposed or refused/);
  });
});
