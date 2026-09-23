// @vitest-environment jsdom
/**
 * The commercial path on the Cash page, rendered from a real briefing shape.
 *
 * Two things a screen could get wrong that the server tests cannot see: a
 * decision shown without the recipient, amount, scope and consequence a person
 * needs to answer it, and a control that makes money read as collected on a
 * press. The first is asserted as present and the second as absent.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CommercialPath } from '../client/src/russell/CommercialPath.tsx';
import type { CommercialReading } from '../client/src/lib/commerceApi.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reading(): CommercialReading {
  return {
    briefing: {
      projectId: 'prj_1',
      readAt: '2026-09-23T16:00:00.000Z',
      sprint: { state: 'ACTIVE', currency: 'USD' },
      grant: { present: false, covers: {}, summary: 'No standing commercial authority exists.' },
      doing: [{ subject: 'Demand test on "Clinic"', opportunityId: 'cop_1', text: 'Prepared by Brain.' }],
      happened: [],
      blocked: [{ subject: 'Demand test on "Clinic"', opportunityId: 'cop_1', text: 'Waiting on your authority to contact buyers.' }],
      next: [],
      decisions: [
        {
          key: 'contact:cdt_1',
          authorityAction: 'CONTACT_BUYER',
          action: 'Contact up to 10 clinic managers.',
          recipient: 'Clinic managers (via email)',
          amountCents: 0,
          currency: 'USD',
          scope: 'Intake form repair',
          consequence: 'No money moves.',
          prepared: 'Demand test cdt_1',
          where: 'Cash → What Brain may do',
        },
      ],
      money: {
        currency: 'USD',
        pipelineCents: 0,
        invoicedUnpaidCents: 0,
        customerPaymentsCents: 0,
        paidNotSettledCents: 0,
        availableFundsCents: 0,
        costsCents: 0,
        contributionCents: 0,
        unpaidCommitmentsCents: 0,
      },
      continuing: [],
      selection: { selectedId: 'cop_1', because: 'x', decisiveGap: null, closestId: 'cop_1', closestTitle: 'Clinic' },
      learned: [],
      text: '',
    },
    tests: [],
    obligations: [],
    invoices: [],
  };
}

describe('the commercial path', () => {
  it('prepares every decision with what a person needs to answer it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(reading()), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    render(<CommercialPath projectId="prj_1" />);
    await waitFor(() => expect(screen.getByText('Decisions that need your authority')).toBeTruthy());
    const decisions = document.querySelector('.rs-cash-commercial-decisions') as HTMLElement;
    const one = within(decisions);
    expect(one.getByText(/Recipient: Clinic managers/)).toBeTruthy();
    expect(one.getByText(/Amount: USD 0.00/)).toBeTruthy();
    expect(one.getByText(/Scope: Intake form repair/)).toBeTruthy();
    expect(one.getByText(/Consequence: No money moves/)).toBeTruthy();
    expect(screen.getByText('Pipeline (agreed, unpaid)')).toBeTruthy();
    expect(screen.getByText('Paid, not yet settled')).toBeTruthy();
  });

  it('offers no control that turns a promise into collected money', () => {
    const cash = readFileSync(path.join(process.cwd(), 'client/src/russell/Cash.tsx'), 'utf8');
    expect(cash).not.toMatch(/label: 'Money is in'/);
    expect(cash).not.toMatch(/action: 'collect'/);
  });
});
