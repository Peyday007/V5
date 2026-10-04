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
    owedByBuyerCents: 0,
    invoiceableCents: 0,
  },
  agreements: [],
  invoices: [],
  fulfilments: [],
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

describe('the deal journey panel', () => {
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
