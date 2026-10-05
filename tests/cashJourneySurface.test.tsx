// @vitest-environment jsdom
/**
 * One deal's journey panel, in a browser.
 *
 * What it holds to: every figure and every next step is the server's, the
 * owner of each next step is named, the controls are only facts a person holds
 * (what the buyer said, the agreement, the work outside Brain, the acceptance),
 * and there is no control that writes "delivered" or "collected" — those follow
 * from rows. The fixture is typed against the server's own `DealView`, so a
 * contract the server changes fails here rather than passing against a payload
 * production can no longer produce (§35).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DealJourney } from '../client/src/russell/CashJourney.tsx';
import type { DealView } from '../server/services/cash/journey/view.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEAL: DealView = {
  opportunityId: 'cop_1',
  title: 'A published intake repair request',
  stage: 'RESPONDED',
  paymentState: 'NOTHING_OWED',
  pnl: {
    currency: 'USD',
    agreedRevenueCents: 0,
    unbackedAgreedCents: 0,
    invoicedCents: 0,
    customerPaymentsCents: 0,
    refundsCents: 0,
    settledCashCents: 0,
    unsettledCents: 0,
    incrementalCostsCents: 0,
    unpaidCommitmentsCents: 0,
    heldCommitmentsCents: 0,
    contributionCents: 0,
    creditedPaymentsCents: 0,
    owedBackCents: 0,
    owedByBuyerCents: 0,
    invoiceableCents: 0,
    uncoveredPendingCents: 0,
  },
  agreements: [],
  invoices: [],
  unattributedPayments: [],
  obligations: [],
  observations: [
    {
      id: 'cob_1',
      projectId: 'prj_1',
      opportunityId: 'cop_1',
      kind: 'BUYER_ACCEPTED',
      source: 'PERSON',
      channel: 'email',
      evidenceRef: 'buyer email',
      amountCents: null,
      currency: null,
      note: null,
      observedAt: '2026-10-04T10:00:00.000Z',
      recordedBy: 'usr_1',
      requestKey: 'k',
      createdAt: '2026-10-04T10:00:00.000Z',
    },
  ],
  contacted: true,
  delivered: false,
  paymentInFlight: false,
  next: [
    {
      step: 'Record the agreement: the amount, what is delivered, what counts as acceptance, and the evidence.',
      owner: 'PERSON',
      why: 'An agreement binds the buyer.',
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AGREEMENT = {
  id: 'cag_1',
  projectId: 'prj_1',
  opportunityId: 'cop_1',
  amountCents: 120_000,
  currency: 'USD',
  deliverable: 'Repair the form',
  acceptanceCondition: 'Three submissions arrive',
  evidenceKind: 'WRITTEN_ACCEPTANCE' as const,
  evidenceRef: 'buyer email',
  observationId: null,
  state: 'AGREED' as const,
  releasedReason: null,
  releasedBy: null,
  releasedAt: null,
  requestKey: 'k',
  recordedBy: 'usr_1',
  createdAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
};

const DELIVERED_UNACCEPTED: DealView = {
  ...DEAL,
  stage: 'FULFILLING',
  agreements: [AGREEMENT],
  obligations: [
    {
      opportunityId: 'cop_1',
      agreement: AGREEMENT,
      fulfillment: {
        id: 'cff_1',
        projectId: 'prj_1',
        opportunityId: 'cop_1',
        agreementId: 'cag_1',
        kind: 'PERSON',
        performer: 'The operator',
        repositoryRemote: null,
        repositoryRoot: null,
        baseBranch: null,
        mutationScope: [],
        supplierName: null,
        workRef: null,
        workCreatedAt: '2026-10-04T10:00:00.000Z',
        workAttempt: 0,
        declaredBy: 'usr_1',
        createdAt: '2026-10-04T10:00:00.000Z',
        updatedAt: '2026-10-04T10:00:00.000Z',
      },
      work: { state: 'COMPLETE', ref: null, artifact: 'form-fixed', detail: 'Fixed.' },
      delivery: { state: 'DELIVERED', portions: [], evidence: 'live form', deliveredAt: '2026-10-04T11:00:00.000Z' },
      acceptance: { state: 'AWAITING_ACCEPTANCE', condition: 'Three submissions arrive', evidence: null, reason: null },
      refunds: [],
      failure: null,
      stage: 'DELIVERED',
      complete: false,
      outstanding: ['the buyer has not accepted it against the agreed condition'],
      brainNext: [],
      personNext: ['Record the buyer’s acceptance, or rejection, with their evidence.'],
    },
  ],
};

describe('the deal journey panel', () => {
  it('shows delivered and accepted as two facts, and records acceptance against the agreement', async () => {
    const posted: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ obligation: {}, message: 'Recorded.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const changed = vi.fn();
    render(<DealJourney deal={DELIVERED_UNACCEPTED} currency="USD" mayAct onChanged={changed} />);
    expect(screen.getByText(/Delivered, not yet accepted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record what happened' }));
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'ACCEPTED' } });
    fireEvent.change(screen.getByLabelText('What happened, in words somebody can check'), { target: { value: 'Buyer confirmed' } });
    fireEvent.change(screen.getByLabelText('Evidence (a delivery, the buyer’s message, a document)'), { target: { value: 'reply 7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(posted[0]).toEqual({
      url: '/api/cash/opportunities/cop_1/obligation-event',
      body: { agreementId: 'cag_1', kind: 'ACCEPTED', detail: 'Buyer confirmed', evidenceRef: 'reply 7' },
    });
  });

  it('offers a refund only to whoever may authorize one', () => {
    render(<DealJourney deal={DELIVERED_UNACCEPTED} currency="USD" mayAct onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Authorize a refund' })).toBeNull();
    cleanup();
    render(<DealJourney deal={DELIVERED_UNACCEPTED} currency="USD" mayAct mayRefund onChanged={() => {}} />);
    expect(screen.getByRole('button', { name: 'Authorize a refund' })).toBeTruthy();
  });

  it('names who does the next step and offers no control that writes delivered or collected', () => {
    render(<DealJourney deal={DEAL} currency="USD" mayAct onChanged={() => {}} />);
    expect(screen.getByText('Buyer answered')).toBeTruthy();
    expect(screen.getByText(/^You:/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /deliver|collect|money is in/i })).toBeNull();
  });

  it('records the agreement through the real route shape', async () => {
    const posted: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ agreement: { id: 'cag_1' }, message: 'Agreement recorded.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const changed = vi.fn();
    render(<DealJourney deal={DEAL} currency="USD" mayAct onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record the agreement' }));
    fireEvent.change(screen.getByLabelText('Agreed amount, in USD'), { target: { value: '1,200' } });
    fireEvent.change(screen.getByLabelText('What is delivered'), { target: { value: 'Repair the form' } });
    fireEvent.change(screen.getByLabelText('What counts as acceptance'), { target: { value: 'Three submissions arrive' } });
    fireEvent.change(screen.getByLabelText('Evidence of agreement'), { target: { value: 'WRITTEN_ACCEPTANCE' } });
    fireEvent.change(screen.getByLabelText('Its reference'), { target: { value: 'buyer email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(posted[0]!.url).toBe('/api/cash/opportunities/cop_1/agree');
    expect(posted[0]!.body).toEqual({
      amountCents: 120_000,
      deliverable: 'Repair the form',
      acceptanceCondition: 'Three submissions arrive',
      evidenceKind: 'WRITTEN_ACCEPTANCE',
      evidenceRef: 'buyer email',
    });
  });

  it('shows nothing a member could act on when the reader may not act', () => {
    render(<DealJourney deal={DEAL} currency="USD" mayAct={false} onChanged={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
