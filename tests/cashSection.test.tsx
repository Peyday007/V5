// @vitest-environment jsdom
/**
 * The Cash section, in a browser.
 *
 * A service test proves the routes decide correctly when they are called. It
 * cannot prove a person can tell what is outstanding, that the screen agrees
 * with the control beside it, or that answering the one decision changes the
 * page — and every one of those is a way this fails while every server test
 * passes. §29 records two of them happening for real.
 *
 * So this renders the actual section over the actual `CashApi` and `api()`
 * helper with a scripted `fetch` underneath. What it holds to:
 *
 *   - loading, forbidden and error are three different screens, and the
 *     forbidden one does not claim the work is absent;
 *   - a project with no sprint offers the one thing that starts it, and says
 *     plainly that starting it authorizes nothing;
 *   - the outstanding approval is named first and is never folded away;
 *   - every figure on the screen comes from the server, including the ones
 *     that would be easy to recompute;
 *   - a disposition always carries the server's sentence saying what decided
 *     it, so "waiting" names what it waits on;
 *   - the permanent prohibitions are shown before anybody approves;
 *   - answering a decision goes back to the server rather than optimistically
 *     redrawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { CashSection } from '../client/src/russell/Cash.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const PROJECT = 'prj_1';
const VIEW = `GET /api/projects/${PROJECT}/cash`;
const MODE = `POST /api/projects/${PROJECT}/cash/mode`;
const AUTHORITY = `POST /api/projects/${PROJECT}/cash/authority`;

const POSITION = {
  currency: 'USD',
  pipelineCents: 0,
  customerPaymentsCents: 75_000,
  availableFundsCents: 0,
  unpaidCommitmentsCents: 0,
  heldCommitmentsCents: 20_000,
  reservesCents: 0,
  deployableCents: -20_000,
  completedContributionCents: 75_000,
  shortfall: true,
};

const VOCABULARY = {
  mechanisms: ['EXPLICIT_PAID_REQUEST', 'TEMPORARY_EXPLOIT', 'OTHER'],
  moneyKinds: ['CUSTOMER_PAYMENT', 'SETTLEMENT'],
  commercialActions: ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'],
  neverAuthorizable: ['PAID_OVERAGE', 'BORROW_OR_LEVERAGE'],
  lifecycleStates: ['ACTIVE', 'WINDING_DOWN', 'ARCHIVED'],
  envelopes: ['RUSSELL_CASH_DISCOVERY_V1'],
  defaultEnvelope: 'RUSSELL_CASH_DISCOVERY_V1',
  defaultHorizonDays: 7,
};

function opportunity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cop_1',
    title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    state: 'READY',
    currency: 'USD',
    priceCents: 75_000,
    peakFundingCents: 0,
    expiresAt: null,
    expiryReason: null,
    exhaustedAt: null,
    exhaustedReason: null,
    nextAction: null,
    outcome: null,
    ...over,
  };
}

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: {
      id: 'csm_1',
      projectId: PROJECT,
      ownerUserId: 'usr_1',
      objective: 'Maximize additional usable cash over the next few weeks.',
      horizonDays: 7,
      envelopeId: 'RUSSELL_CASH_DISCOVERY_V1',
      state: 'ACTIVE',
      activatedAt: '2026-09-15T00:00:00.000Z',
      stateReason: null,
    },
    objective: 'Maximize additional usable cash over the next few weeks.',
    discovery: { open: true, reason: 'Cash Mode is active.' },
    authority: { exists: false, id: null, lines: [], maxConcurrent: 0, heldCents: 20_000 },
    myCash: { position: POSITION, entries: [], commitments: [] },
    myCurrentWork: {
      placements: [
        {
          opportunity: opportunity(),
          disposition: 'WAIT_FOR_DEPENDENCY',
          because: '2 of 2 execution slots are taken, so this waits on fulfilment capacity.',
          missing: [],
        },
      ],
      executeNow: [],
      waiting: [],
      combinedContributionCents: 75_000,
      peakFundingCents: 0,
      cards: { cop_1: { ready: true, missing: [], summary: 'Ready.' } },
    },
    whatBrainHasDone: [
      {
        id: 'cse_1',
        kind: 'CASH_OPPORTUNITY_CAPTURED',
        summary: 'Captured "A paid intake repair".',
        actorRef: 'usr_1',
        createdAt: '2026-09-15T00:00:00.000Z',
      },
    ],
    whatBrainNeeds: [],
    decisionsForMe: {
      items: [
        {
          key: 'AUTHORITY',
          title: 'Decide what Brain may spend here',
          why: 'There is no standing commercial authority on this account.',
          recommendation: 'Approve a standing commercial authority.',
          consequence: 'Until it exists, every execution step is refused.',
          urgency: 'BLOCKING',
          underlying: [],
        },
        {
          key: 'MISSING_PAYER',
          title: '3 cards with no payer',
          why: 'An unknown is not a favourable assumption.',
          recommendation: 'Establish who can approve payment.',
          consequence: 'Each becomes ready to test the moment its answer exists.',
          urgency: 'WHENEVER',
          underlying: ['cop_2', 'cop_3', 'cop_4'],
        },
      ],
      underlyingCount: 3,
      summary: '2 things to decide, standing for 3 underlying items.',
    },
    vocabulary: VOCABULARY,
    ...over,
  };
}

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = { [VIEW]: { body: view() }, ...over };
}

beforeEach(() => {
  calls = [];
  bodies = {};
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
    calls.push(key);
    if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body) as unknown;
    const found = routes[key];
    const answer: Reply = !found
      ? { status: 404, body: { error: 'No such route.' } }
      : typeof found === 'function'
        ? found()
        : found;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => JSON.stringify(answer.body),
    } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(projectId: string | null = PROJECT): Promise<void> {
  await act(async () => {
    render(<CashSection projectId={projectId} />);
  });
}

describe('the four states of a read are four screens', () => {
  it('does not claim the work is absent when a person may not see it', async () => {
    base({ [VIEW]: { status: 404, body: { error: 'No project with that id.' } } });
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/nothing here for you to see/i)).toBeTruthy(),
    );
    // Forbidden is not empty, and it does not offer a retry that cannot help.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('offers a retry on a real error, which is a different situation', async () => {
    base({ [VIEW]: { status: 500, body: { error: 'Something broke.' } } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy());
  });

  it('says a sprint belongs to one project when none is chosen', async () => {
    base();
    await mount(null);
    expect(screen.getByText(/privacy boundary/i)).toBeTruthy();
    // And it asks the server nothing.
    expect(calls).toEqual([]);
  });
});

describe('a project with no sprint', () => {
  it('offers the one thing that starts it, and says starting it spends nothing', async () => {
    base({ [VIEW]: { body: view({ mode: null }) } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /start cash mode/i })).toBeTruthy());
    expect(screen.getByText(/separate decision, and it is yours/i)).toBeTruthy();
  });

  it('will not start one on an objective nobody wrote', async () => {
    base({ [VIEW]: { body: view({ mode: null }) } });
    await mount();
    const button = screen.getByRole('button', { name: /start cash mode/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/what is this account trying to produce/i), {
      target: { value: 'money' },
    });
    expect((screen.getByRole('button', { name: /start cash mode/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('starts one when there is an objective, and re-reads rather than assuming', async () => {
    base({
      [VIEW]: { body: view({ mode: null }) },
      [MODE]: { body: { mode: {}, changed: true, message: 'Cash Mode is active.' } },
    });
    await mount();
    fireEvent.change(screen.getByLabelText(/what is this account trying to produce/i), {
      target: { value: 'Maximize additional usable cash over the next few weeks.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start cash mode/i }));
    });
    expect(bodies[MODE]).toMatchObject({
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    // Two reads: the first, and the one after the change. Nothing is drawn
    // optimistically from what the POST returned.
    expect(calls.filter((call) => call === VIEW).length).toBe(2);
  });
});

describe('the decision nothing can proceed without', () => {
  it('is named first and is not folded away', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('Decide what Brain may spend here')).toBeTruthy());
    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings[0]).toBe('Decisions for you');
  });

  it('shows the outstanding approval once, as the control rather than twice', async () => {
    /*
     * The server names it first because nothing can proceed without it, and the
     * card below is what answers it. Printing both put the same sentence on the
     * screen twice, one of them with no button — which teaches a person to skim
     * the list, for the same reason §29's contradicting status does.
     */
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('Decide what Brain may spend here')).toBeTruthy());
    expect(screen.getAllByText('Decide what Brain may spend here').length).toBe(1);
    // And the one that survives is the one with the control on it.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    // The other decisions are still listed.
    expect(screen.getByText('3 cards with no payer')).toBeTruthy();
  });

  it('reports the compression rather than claiming it', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/standing for 3 underlying items/i)).toBeTruthy(),
    );
    expect(screen.getByText(/Stands for 3 items\./)).toBeTruthy();
  });

  it('shows what can never be authorized, before anybody approves', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('PAID_OVERAGE')).toBeTruthy());
    expect(screen.getByText('BORROW_OR_LEVERAGE')).toBeTruthy();
    expect(screen.getByText(/can never be authorized, by any grant/i)).toBeTruthy();
  });

  it('keeps the detailed controls hidden until somebody asks for them', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    expect(screen.queryByLabelText(/most that may be committed at once/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /change details/i }));
    expect(screen.getByLabelText(/most that may be committed at once/i)).toBeTruthy();
  });

  it('approves with the prefilled limits, and goes back to the server', async () => {
    base({ [AUTHORITY]: { body: { authority: { id: 'cau_1' }, lines: [] } } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(bodies[AUTHORITY]).toMatchObject({
      allowedActions: VOCABULARY.commercialActions,
    });
    expect(calls.filter((call) => call === VIEW).length).toBe(2);
  });

  it('shows a live grant in the server’s own words, and composes none of its own', async () => {
    base({
      [VIEW]: {
        body: view({
          authority: {
            exists: true,
            id: 'cau_1',
            lines: ['Brain may commit up to USD 1,000.00 of your money at any one time.'],
            maxConcurrent: 2,
            heldCents: 20_000,
          },
        }),
      },
    });
    await mount();
    await waitFor(() =>
      expect(
        screen.getByText('Brain may commit up to USD 1,000.00 of your money at any one time.'),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('the money, and the work', () => {
  it('prints every figure the server sent, and computes none of them', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeTruthy());
    // A payment that has not settled is earned and is not available. Two rows
    // carry it — customer payments and completed contribution — which is the
    // point of keeping them as separate figures.
    expect(screen.getAllByText('USD 750.00').length).toBe(2);
    expect(screen.getAllByText('USD 0.00').length).toBeGreaterThan(0);
    // Deployable is negative and is printed as such rather than clamped to nil.
    expect(screen.getByText('-USD 200.00')).toBeTruthy();
    expect(screen.getByText(/Deployable cash is negative/i)).toBeTruthy();
  });

  it('carries the server’s sentence for every disposition, so a wait names what it waits on', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('Wait for a named dependency')).toBeTruthy());
    expect(screen.getByText(/waits on fulfilment capacity/i)).toBeTruthy();
  });

  it('says an exhausted opening still counts for whatever it earned', async () => {
    base({
      [VIEW]: {
        body: view({
          myCurrentWork: {
            ...(view().myCurrentWork as Record<string, unknown>),
            placements: [
              {
                opportunity: opportunity({
                  state: 'COLLECTED',
                  exhaustedAt: '2026-09-15T00:00:00.000Z',
                  exhaustedReason: 'the supplier repriced',
                }),
                disposition: 'EXECUTE_NOW',
                because: 'The money is in.',
                missing: [],
              },
            ],
          },
        }),
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByText(/Whatever it earned still counts/i)).toBeTruthy());
  });

  it('asks for a reason in the page rather than in a browser dialog', async () => {
    base({
      [VIEW]: {
        body: view({
          myCurrentWork: {
            ...(view().myCurrentWork as Record<string, unknown>),
            placements: [
              {
                opportunity: opportunity({ state: 'DISCOVERED' }),
                disposition: 'TEST_A_DECISIVE_UNKNOWN',
                because: 'The payer is unknown.',
                missing: ['payer'],
              },
            ],
          },
        }),
      },
      'POST /api/cash/opportunities/cop_1/decline': { body: { opportunity: {}, message: 'Passed.' } },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /pass on this/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /pass on this/i }));
    const field = screen.getByLabelText(/Why\?/i);
    expect(field).toBeTruthy();

    // And it will not send an empty one.
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(field, { target: { value: 'No capacity this month.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(bodies['POST /api/cash/opportunities/cop_1/decline']).toEqual({
      reason: 'No capacity this month.',
    });
  });
});

describe('winding down', () => {
  it('will not move the lifecycle without a reason, and shows the server’s consequence', async () => {
    base({
      [MODE]: {
        body: {
          mode: {},
          changed: true,
          message: 'No new discovery will start. Everything already in the portfolio keeps running.',
        },
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /wind it down/i })).toBeTruthy());
    expect((screen.getByRole('button', { name: /wind it down/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(screen.getByLabelText(/^why$/i), {
      target: { value: 'Established cash flow makes the urgency unnecessary.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /wind it down/i }));
    });
    expect(bodies[MODE]).toMatchObject({ state: 'WINDING_DOWN' });
    await waitFor(() =>
      expect(screen.getByText(/Everything already in the portfolio keeps running/i)).toBeTruthy(),
    );
  });

  it('does not offer the state it is already in', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /wind it down/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /make it active/i })).toBeNull();
  });
});
