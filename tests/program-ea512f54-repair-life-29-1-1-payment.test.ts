/**
 * LIFE-29-1 repair: a provider-confirmed payment records the agreement it
 * stands for.
 *
 * The probe failed with "no opportunity has an agreement". The only writer of
 * `cash_agreements` was a person's "agree" action, so a transaction that
 * skipped straight to payment was invisible to the commitment model, which
 * reads a transaction by its agreement. `recordConfirmedEffect` now writes the
 * agreement through `recordAgreement` (PROVIDER_RECORD, the receipt as
 * evidence) before the payment, and a term the piece does not state becomes a
 * need instead of being invented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { getOpportunity, listNeeds, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { agreementsFor } from '../server/services/cash/journey/deal.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { EFFECT_INTENT_KIND, effectCorrelation } from '../server/services/cash/effects.ts';
import { paymentTermsKey, recordConfirmedEffect } from '../server/services/cash/perform.ts';
import type { CashOpportunity, IdempotencyOperation } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let authorityId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `life291-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect(
    (
      await activate({
        projectId,
        ownerUserId: userId,
        actorUserId: userId,
        objective: 'Maximize additional usable cash over the next few weeks.',
      })
    ).ok,
  ).toBe(true);
  const granted = await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
  authorityId = granted.id;
});

/** An EXECUTING piece with no agreement, stating its deliverable and acceptance unless told not to. */
async function executing(terms: { offerScope: string | null; acceptanceCondition: string | null }): Promise<CashOpportunity> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'A buyer who paid on the provider page',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: 'BRAIN',
    patch: {
      payer: 'The operations manager',
      reachableChannel: 'ops@buyer.example',
      buyingSignal: 'Wanted: intake repair. Budget $300.',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  const piece = (await getOpportunity(captured.value.id))!;
  await applyProposal({ opportunity: piece, proposal: await proposeTerms(piece) });
  await updateOpportunity(piece.id, {
    state: 'EXECUTING',
    offer_scope: terms.offerScope,
    acceptance_condition: terms.acceptanceCondition,
  } as never);
  const now = (await getOpportunity(piece.id))!;
  expect(now.state).toBe('EXECUTING');
  expect(await agreementsFor(now.id)).toEqual([]);
  return now;
}

/** The intent Brain writes before a send, carrying the amount, and the SUCCEEDED operation that confirmed it. */
async function confirmedPayment(piece: CashOpportunity, receiptRef: string, amountCents: number): Promise<IdempotencyOperation> {
  const correlationId = effectCorrelation(piece.id, 'ACCEPT_PAYMENT', '1', 0);
  await recordCashEvent({
    projectId,
    opportunityId: piece.id,
    kind: EFFECT_INTENT_KIND,
    actorRef: 'BRAIN',
    summary: 'Brain is about to attempt taking a payment.',
    detail: {
      correlationId,
      action: 'ACCEPT_PAYMENT',
      occurrence: '1',
      retry: 0,
      authorityId,
      amountCents,
      stateAtSend: 'EXECUTING',
      subjectRef: null,
    },
  });
  return {
    id: `op_${receiptRef}`,
    projectId,
    correlationId,
    state: 'SUCCEEDED',
    resultRef: receiptRef,
  } as unknown as IdempotencyOperation;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await getDb().all<{ n: number }>(sql, params as never[]))[0]?.n ?? 0);
}

describe('a provider-confirmed payment records the agreement it stands for (LIFE-29-1)', () => {
  it('writes one PROVIDER_RECORD agreement and one PIPELINE_AGREED entry, and a replay writes none', async () => {
    const piece = await executing({
      offerScope: 'Repair of the intake form, as the card describes.',
      acceptanceCondition: 'The buyer confirms the form works in writing.',
    });
    const operation = await confirmedPayment(piece, 'pi_life291', 30_000);
    const pass = () =>
      recordConfirmedEffect({
        opportunityId: piece.id,
        action: 'ACCEPT_PAYMENT',
        occurrence: '1',
        operation,
        receiptRef: 'pi_life291',
        actorRef: 'BRAIN',
      });

    await pass();
    const agreements = await agreementsFor(piece.id);
    expect(agreements).toEqual([
      expect.objectContaining({
        amountCents: 30_000,
        evidenceKind: 'PROVIDER_RECORD',
        evidenceRef: 'pi_life291',
        deliverable: 'Repair of the intake form, as the card describes.',
        acceptanceCondition: 'The buyer confirms the form works in writing.',
        state: 'AGREED',
      }),
    ]);
    const pipeline = () =>
      count("SELECT COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? AND kind = 'PIPELINE_AGREED'", [piece.id]);
    expect(await pipeline()).toBe(1);

    // The same receipt again (the tick and a person racing, or a replay) writes nothing.
    await pass();
    await pass();
    expect(await agreementsFor(piece.id)).toHaveLength(1);
    expect(await pipeline()).toBe(1);

    // Read as commitments: signed and paid, not settled, and consistent with the ledger.
    const entries = await listMoneyEntries({ projectId, opportunityId: piece.id, limit: 100 });
    const payments = entries.filter((one) => one.kind === 'CUSTOMER_PAYMENT').length;
    const settlements = entries.filter((one) => one.kind === 'SETTLEMENT').length;
    expect(payments).toBe(1);
    expect(settlements).toBe(0);
    const reading = await readCommitments({ projectId, opportunityId: piece.id, currency: 'USD' });
    expect(reading.stages.CONTRACT_SIGNED.state).toBe('REACHED');
    expect(reading.stages.PAYMENT_AUTHORIZED.state).toBe('REACHED');
    expect(reading.stages.FUNDS_SETTLED.state).toBe('NOT_REACHED');
    expect(commitmentProblem(reading, { payments, settlements })).toBeNull();
  });

  it('records no agreement when a term is unstated, and raises a need naming the missing term', async () => {
    const piece = await executing({
      offerScope: 'Repair of the intake form.',
      acceptanceCondition: null,
    });
    const operation = await confirmedPayment(piece, 'pi_unstated', 30_000);
    await recordConfirmedEffect({
      opportunityId: piece.id,
      action: 'ACCEPT_PAYMENT',
      occurrence: '1',
      operation,
      receiptRef: 'pi_unstated',
      actorRef: 'BRAIN',
    });
    expect(await agreementsFor(piece.id)).toEqual([]);
    expect(
      await count("SELECT COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? AND kind = 'PIPELINE_AGREED'", [piece.id]),
    ).toBe(0);
    const needs = (await listNeeds({ projectId })).filter((one) => one.requestKey === paymentTermsKey(piece.id, 'pi_unstated'));
    expect(needs).toHaveLength(1);
    expect(needs[0]!.whyItMatters).toContain('what counts as acceptance');
    expect(needs[0]!.whyItMatters).not.toContain('what is being delivered');
  });
});
