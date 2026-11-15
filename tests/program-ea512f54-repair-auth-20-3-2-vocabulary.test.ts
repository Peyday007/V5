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
import { decideAction, type AuthorityLedgerRecord } from '../server/services/cash/authority.ts';
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

  it('accepts a row in the shape of the production decision the probe once refused', async () => {
    // The production row itself was not readable here; this is the shape the writer gives an allowed
    // consequential decision (AUTHORIZED, ok, ALLOWED), which is what the old probe refused.
    await recordCashEvent({
      projectId: t.project.id,
      kind: 'AUTHORITY_DECISION',
      actorRef: 'BRAIN',
      summary: 'FACTORY_DEPLOY: AUTHORIZED (ALLOWED)',
      detail: {
        action: 'FACTORY_DEPLOY',
        consequenceClass: 'STANDING_GRANT_ENGINEERING',
        path: 'API',
        principal: 'usr_owner',
        scope: { projectId: t.project.id, accountRef: null },
        disposition: 'AUTHORIZED',
        cause: 'ALLOWED',
        policyVersion: null,
        amountCents: null,
        subjectRef: null,
        decidedAt: new Date().toISOString(),
        ok: true,
        approvalNeedId: null,
        neededApproval: null,
      },
    });
    const result = await graduatedAuthorityHoldsOnRows();
    expect(result.ok, result.detail).toBe(true);
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
