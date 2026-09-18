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
const OPERATIONS = 'GET /api/cash/mode';
const VIEW = `GET /api/projects/${PROJECT}/cash`;
const MODE = `POST /api/projects/${PROJECT}/cash/mode`;
const AUTHORITY = `POST /api/projects/${PROJECT}/cash/authority`;
const PREVIEW = `POST /api/projects/${PROJECT}/cash/authority/preview`;

/**
 * The one Cash Mode, which is what the section runs over.
 *
 * There is no list and no picker: the server resolves the single root and sends
 * its own objective, so the section renders what it is given rather than
 * choosing between sprints.
 */
/**
 * A fleet and a membership that are both full.
 *
 * Declared as the *ready* shape so that a test wanting the gate has to say so,
 * and a test that forgot it fails loudly rather than rendering a disabled
 * button nobody asserted on.
 */
const READY = {
  members: {
    ready: 4,
    required: 4,
    rows: [
      { userId: 'usr_1', displayName: 'One', state: 'READY' as const },
      { userId: 'usr_2', displayName: 'Two', state: 'READY' as const },
      { userId: 'usr_3', displayName: 'Three', state: 'READY' as const },
      { userId: 'usr_4', displayName: 'Four', state: 'READY' as const },
    ],
  },
  capacity: {
    healthy: 4,
    required: 4,
    rows: [
      { accountId: 'fac_a', name: 'Brain Research A', state: 'HEALTHY' as const },
      { accountId: 'fac_b', name: 'Brain Research B', state: 'HEALTHY' as const },
      { accountId: 'fac_c', name: 'Brain Research C', state: 'HEALTHY' as const },
      { accountId: 'fac_d', name: 'Brain Research D', state: 'HEALTHY' as const },
    ],
  },
  mayStart: true,
  blockedBy: [],
};

/** The same reading with one person short, which is the ordinary state today. */
const NOT_READY = {
  ...READY,
  members: {
    ...READY.members,
    ready: 3,
    rows: READY.members.rows.map((row, index) =>
      index === 3 ? { ...row, state: 'INVITED' as const } : row,
    ),
  },
  mayStart: false,
  blockedBy: ['1 more member(s) need a passkey registered.'],
};

const MINE = {
  root: { projectId: PROJECT, projectName: 'Cash Mode' },
  mode: {
    projectId: PROJECT,
    state: 'ACTIVE',
    currency: 'USD',
    activatedAt: '2026-09-15T00:00:00.000Z',
    objective: 'The canonical mandate.',
  },
  objective: {
    summary: 'Find and validate as many lawful ways to produce usable cash quickly as the evidence supports.',
    full: 'The canonical mandate, in full.',
  },
  currencies: ['USD', 'GBP', 'EUR', 'CAD', 'AUD'],
  readiness: READY,
};

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
  otherCurrencies: [],
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
  currencies: ['USD', 'GBP'],
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

/**
 * The roadmap as the server sends it: the plan's own denominator, never a
 * target. Five planned on one round, of which one is with a worker.
 */
const ROADMAP = {
  mechanisms: ['EXPLICIT_PAID_REQUEST'],
  rounds: { open: 1, harvested: 0, abandoned: 0, total: 1 },
  active: [
    {
      roundId: 'cdr_1',
      bucketId: 'paid-requests',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      round: 1,
      state: 'OPEN',
      openedAt: '2026-09-15T00:00:00.000Z',
      found: 2,
      plan: {
        orchestrationId: 'orc_1',
        planned: 5,
        byStatus: {
          PLANNED: 1,
          QUEUED: 1,
          RUNNING: 1,
          VALIDATING: 0,
          ACCEPTED: 1,
          BLOCKED: 1,
          REJECTED: 0,
          CANCELLED: 0,
          NEEDS_HUMAN: 0,
        },
        inFlight: ['Who is publicly asking to pay for work right now?'],
      },
    },
  ],
  research: {
    planned: 5,
    byStatus: {
      PLANNED: 1,
      QUEUED: 1,
      RUNNING: 1,
      VALIDATING: 0,
      ACCEPTED: 1,
      BLOCKED: 1,
      REJECTED: 0,
      CANCELLED: 0,
      NEEDS_HUMAN: 0,
    },
  },
  pipeline: [
    { key: 'DISCOVERED', label: 'Openings found', count: 2, note: 'The card is still blank.' },
    { key: 'EVIDENCE_CARD', label: 'Being validated', count: 1, note: 'Filling in the blanks.' },
    { key: 'READY', label: 'Ready to test', count: 1, note: 'Needs your authorization.' },
    { key: 'EXECUTING', label: 'Being pursued', count: 0, note: 'Against a grant you gave.' },
    { key: 'COLLECTED', label: 'Collected', count: 0, note: 'Delivered and settled.' },
    { key: 'CLOSED', label: 'Declined or archived', count: 0, note: 'Kept with its reason.' },
  ],
  whatHappensNext: '1 opportunity is ready to test. Executing one needs a standing authorization from you.',
};

/**
 * A forecast with one figure and the rest withheld, which is the ordinary shape
 * early on and the one the screen has to render honestly.
 */
const WITHHELD = {
  valueCents: null,
  lowCents: null,
  highCents: null,
  fromRows: 0,
  confidence: 'NONE' as const,
  basis: 'Read from the qualified opportunities.',
  unknown: ['Exposure', 'Payer'],
  blocking: 'Each card needs its exposure answered before Brain can total it.',
};

const FORECAST = {
  currency: 'USD',
  qualified: 1,
  considered: 4,
  upfrontCash: WITHHELD,
  ongoingCosts: WITHHELD,
  revenue: {
    valueCents: 75_000,
    lowCents: 75_000,
    highCents: 75_000,
    fromRows: 1,
    confidence: 'SINGLE_ROW' as const,
    basis: 'The prices stated on qualified opportunities.',
    unknown: [],
    blocking: '',
  },
  contribution: WITHHELD,
  timeToFirstDollar: {
    days: null,
    lowDays: null,
    highDays: null,
    fromRows: 0,
    confidence: 'NONE' as const,
    basis: 'Read from the payment terms and deadline.',
    unknown: ['Cash dates'],
    blocking: 'No opportunity yet states when cash would arrive.',
  },
  breakEven: {
    days: null,
    lowDays: null,
    highDays: null,
    fromRows: 0,
    confidence: 'NONE' as const,
    basis: 'When cumulative contribution covers the cash put in.',
    unknown: ['Cash dates'],
    blocking: 'Break-even needs both a dated cash-in and a recurring cost.',
  },
  humanHours: { total: null, fromRows: 0, unknown: ['Economics'] },
};

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
    authority: {
      exists: false,
      id: null,
      lines: [],
      maxConcurrent: 0,
      heldCents: 20_000,
      maxCommittedCents: 0,
      maxPerActionCents: 0,
      committedCents: 0,
      spentCents: 0,
      allowedActions: [],
    },
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
          sharedRemedy: true,
          costCents: null,
          costNote: 'Approving a grant spends nothing. It sets a ceiling.',
          answer: {
            kind: 'GRANT_AUTHORITY',
            targets: [],
            label: 'Approve a standing commercial authority',
            completionCondition: 'A live commercial grant exists on this project.',
          },
        },
        {
          key: 'MISSING_PAYER',
          title: '3 cards with no payer',
          why: 'An unknown is not a favourable assumption.',
          recommendation: 'Establish who can approve payment.',
          consequence: 'Each becomes ready to test the moment its answer exists.',
          urgency: 'WHENEVER',
          underlying: ['cop_2', 'cop_3', 'cop_4'],
          sharedRemedy: false,
          costCents: null,
          costNote: null,
          answer: {
            kind: 'FILL_CARD_FIELD',
            targets: ['cop_2', 'cop_3', 'cop_4'],
            label: 'Answer the payer on each card',
            completionCondition: 'Every one of these cards records a payer.',
          },
        },
      ],
      underlyingCount: 3,
      summary: '2 things to decide, standing for 3 underlying items.',
    },
    roadmap: ROADMAP,
    forecast: FORECAST,
    vocabulary: VOCABULARY,
    ...over,
  };
}

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = { [OPERATIONS]: { body: MINE }, [VIEW]: { body: view() }, ...over };
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

async function mount(
  projectId: string | null = PROJECT,
  isBrainAdmin = false,
): Promise<void> {
  await act(async () => {
    render(<CashSection projectId={projectId} isBrainAdmin={isBrainAdmin} />);
  });
}

describe('activation does not take the invitation away', () => {
  /*
   * The People and capacity panel used to render only on the card that starts a
   * sprint, so pressing Start removed the one entrance to inviting anybody —
   * an *activation* state deciding an *enrollment* question it has nothing to
   * do with. §32 already records that the readiness counts stop nothing; this
   * is the other half of the same sentence, which is that they must still be
   * reachable once the work is running.
   */
  it('keeps the counts on the running sprint, where they used to disappear', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('People and capacity')).toBeTruthy());
    expect(screen.getByText('Human members')).toBeTruthy();
    expect(screen.getByText('Claude capacity accounts')).toBeTruthy();
    // And says plainly that they are counts rather than a gate, because the
    // last thing this screen did with them was refuse to start.
    expect(screen.getByText(/Counts, not gates/)).toBeTruthy();
  });

  it('offers the same invitation control to an administrator, and no second one', async () => {
    base({ 'GET /api/members': { body: { links: [] } } });
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByLabelText(/invite somebody/i)).toBeTruthy());
    // One entrance. A second invitation path is the thing this must not become.
    expect(screen.getAllByLabelText(/invite somebody/i)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /make a private link/i })).toBeTruthy();
    // The existing route, unchanged — not a Cash-specific one.
    expect(calls).toContain('GET /api/members');
  });

  it('still refuses to offer it to somebody who is not an administrator', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('People and capacity')).toBeTruthy());
    expect(screen.queryByLabelText(/invite somebody/i)).toBeNull();
    expect(calls).not.toContain('GET /api/members');
  });
});

describe('the research roadmap', () => {
  it('sits above the activity log rather than being it', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('What Brain is researching')).toBeTruthy());
    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings.indexOf('What Brain is researching')).toBeLessThan(
      headings.indexOf('Everything that has happened'),
    );
  });

  it('takes every number from the server and invents no target', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('What Brain is researching')).toBeTruthy());

    expect(screen.getByText(ROADMAP.whatHappensNext)).toBeTruthy();
    // The plan's own denominator. Five, because the plan holds five — not
    // twenty, and not a percentage of a number nobody knows.
    expect(screen.getByText('1 of 5 research items done', { exact: false })).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/\b20\b/);
    expect(document.body.textContent ?? '').not.toMatch(/%/);

    // The question a worker is on, in the fragment's own words.
    expect(
      screen.getByText('Who is publicly asking to pay for work right now?'),
    ).toBeTruthy();
    for (const stage of ROADMAP.pipeline) expect(screen.getByText(stage.label)).toBeTruthy();
  });

  it('translates the event code and keeps it', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('Everything that has happened')).toBeTruthy());
    const line = screen.getByText(/An opening was written down/);
    // Translated for the person, and the underlying code is still on the row
    // for somebody who needs it.
    expect(line.getAttribute('title')).toBe('CASH_OPPORTUNITY_CAPTURED');
    expect(screen.getByText('Captured "A paid intake repair".')).toBeTruthy();
  });
});

describe('the money picture', () => {
  it('shows the authorization figures as facts, including zero', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('The money picture')).toBeTruthy());

    expect(screen.getByText('Authorized')).toBeTruthy();
    expect(screen.getByText('Committed')).toBeTruthy();
    expect(screen.getByText('Spent')).toBeTruthy();
    expect(screen.getByText('Remaining authorized capacity')).toBeTruthy();
    // Nothing authorized is something Brain knows. It must not read like a
    // figure that has not been worked out.
    expect(
      screen.getByText(/No spending has been authorized here yet/),
    ).toBeTruthy();
  });

  it('withholds an estimate the evidence does not carry, and says what is blank', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('The money picture')).toBeTruthy());

    expect(screen.getAllByText('Not yet estimable').length).toBeGreaterThan(0);
    // Several withheld estimates name the same blanks, which is correct: they
    // are blocked on the same missing evidence.
    expect(screen.getAllByText(/Still unknown: Exposure, Payer/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Each card needs its exposure answered/).length,
    ).toBeGreaterThan(0);
    // And the one figure the evidence does carry is shown with where it came
    // from, rather than beside the others as though they were alike.
    expect(screen.getByText(/from a single opening/)).toBeTruthy();
  });

  it('reports the hours beside the money and never inside it', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('The money picture')).toBeTruthy());
    expect(screen.getByText(/Nobody has estimated the hours/)).toBeTruthy();
  });
});

describe('the spending limits are limits', () => {
  it('says so, and does not claim to be a forecast or to set money aside', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(
        screen.getByText((_text, node) =>
          (node?.textContent ?? '').startsWith('These are limits, not a forecast'),
        ),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(/Nothing is set aside, reserved or pre-paid by setting them/),
    ).toBeTruthy();
  });

  it('takes ordinary money and sends cents, and refuses what it cannot read', async () => {
    base({ [PREVIEW]: { body: { lines: ['Brain may commit up to USD 1,000.00.'] } } });
    await mount();
    await waitFor(() =>
      expect(screen.getByLabelText(/most that may be committed at once/i)).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText(/most that may be committed at once/i), {
      target: { value: '1,000.50' },
    });
    fireEvent.change(screen.getByLabelText(/most in any single commitment/i), {
      target: { value: '$250' },
    });
    fireEvent.change(screen.getByLabelText(/how many opportunities may be executing/i), {
      target: { value: '2' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /show me what this authorizes/i }));
    });
    // Commas and a currency symbol are tolerated because people type them; the
    // route still receives cents and its guards are untouched.
    expect(bodies[PREVIEW]).toMatchObject({
      maxCommittedCents: 100_050,
      maxPerActionCents: 25_000,
      maxConcurrent: 2,
    });
  });

  it('will not guess at an amount it cannot read', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(screen.getByLabelText(/most that may be committed at once/i)).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText(/most that may be committed at once/i), {
      target: { value: 'about a thousand' },
    });
    fireEvent.change(screen.getByLabelText(/most in any single commitment/i), {
      target: { value: '250' },
    });
    fireEvent.change(screen.getByLabelText(/how many opportunities may be executing/i), {
      target: { value: '2' },
    });
    expect(screen.getByText(/Brain will not guess at an amount it cannot read/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /show me what this authorizes/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

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

  it('chooses the operation rather than inheriting the shell’s project', async () => {
    /*
     * The shell hands out the first project a person can see, so taking it as
     * the answer meant somebody with a broad Brain project and a private cash
     * project could be shown — and could activate — the wrong one. A `null`
     * selection is no longer a dead end: the operation is looked up.
     */
    base();
    await mount(null);
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeTruthy());
    expect(calls).toContain(OPERATIONS);
    expect(calls).toContain(VIEW);
  });

  it('offers to start it when it is not running, and asks nothing else', async () => {
    base({
      [OPERATIONS]: { body: { ...MINE, root: null, mode: null } },
    });
    await mount(null);
    await waitFor(() => expect(screen.getByRole('button', { name: /start cash mode/i })).toBeTruthy());
    // No picker. There is one frontier, so there is nothing to choose between.
    expect(screen.queryByLabelText(/which operation/i)).toBeNull();
    // And it does not read a root that does not exist yet.
    expect(calls).not.toContain(VIEW);
  });
});

describe('Cash Mode is not running yet', () => {
  function none(): void {
    base({ [OPERATIONS]: { body: { ...MINE, root: null, mode: null } } });
  }

  it('offers the one thing that starts it, and says starting it spends nothing', async () => {
    none();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /start cash mode/i })).toBeTruthy());
    expect(screen.getByText(/separate decision, and it is yours/i)).toBeTruthy();
  });

  it('requires no objective, and shows Brain’s own instead', async () => {
    /*
     * The field this replaced was required, with a 12-character floor. An
     * objective typed into a box silently becomes a boundary the Brain will not
     * search past, made of whatever the person did not think to write — and
     * nobody can see that omission afterwards. So the mandate is shown rather
     * than solicited, and the button is live immediately.
     */
    none();
    await mount();
    const button = await screen.findByRole('button', { name: /start cash mode/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByLabelText(/what is this account trying to produce/i)).toBeNull();
    expect(screen.getByText(new RegExp(MINE.objective.summary.slice(0, 40), 'i'))).toBeTruthy();
  });

  it('offers the click below four of four, and still reports the counts', async () => {
    /*
     * The four-of-four count was the owner's decision to wait for everybody
     * rather than a property of the system, and it was withdrawn. What must
     * hold now is both halves at once: the button is pressable, and the counts
     * are still on the screen unchanged — a lock removed by hiding the reading
     * would have taken the one thing that says who still cannot sign in.
     *
     * The sentence that explained the lock is gone with it, and that is
     * asserted rather than left to chance: "not ready to start" beside a
     * button that starts is §29's status contradicting the control beside it.
     */
    base({ [OPERATIONS]: { body: { ...MINE, root: null, mode: null, readiness: NOT_READY } } });
    await mount();
    const button = await screen.findByRole('button', { name: /start cash mode/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/not ready to start/i)).toBeNull();
    // The counters are untouched: still derived, still shown, still honest.
    expect(screen.getByText(/3 \/ 4 READY/)).toBeTruthy();
    expect(screen.getByText(/4 \/ 4 HEALTHY/)).toBeTruthy();
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.getByText(/Link sent/i)).toBeTruthy();
  });

  it('says nothing private about anybody while it counts them', async () => {
    base({ [OPERATIONS]: { body: { ...MINE, root: null, mode: null, readiness: NOT_READY } } });
    await mount();
    await screen.findByRole('button', { name: /start cash mode/i });
    // A name and a state. The payload carries nothing else, and the screen
    // invents nothing: no address, no device, no count of what they can reach.
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.getByText(/Link sent/i)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/@/);
  });

  it('offers no invite control to somebody who is not a Brain administrator', async () => {
    base({ [OPERATIONS]: { body: { ...MINE, root: null, mode: null, readiness: NOT_READY } } });
    await mount();
    await screen.findByRole('button', { name: /start cash mode/i });
    expect(screen.queryByLabelText(/invite somebody/i)).toBeNull();
    // And it does not even ask: the route would refuse, and a refusal on a
    // screen somebody is reading is noise about a control they do not have.
    expect(calls).not.toContain('GET /api/members');
  });

  it('keeps the currency and constraints collapsed, so neither is a step', async () => {
    none();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /start cash mode/i })).toBeTruthy());
    expect(screen.queryByLabelText(/one currency/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /add constraints/i }));
    expect(screen.getByLabelText(/one currency/i)).toBeTruthy();
    expect(screen.getByText(/added to the mandate above, never substituted/i)).toBeTruthy();
  });

  it('starts on one click, sending no objective at all', async () => {
    none();
    routes['POST /api/cash/activate'] = {
      body: { mode: {}, changed: true, message: 'Cash Mode is active.' },
    };
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /start cash mode/i })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start cash mode/i }));
    });
    const sent = bodies['POST /api/cash/activate'] as Record<string, unknown>;
    expect(sent).toBeTruthy();
    expect(sent['objective']).toBeUndefined();
    expect(sent['projectId']).toBeUndefined();
    // Re-read rather than assuming what the POST produced.
    expect(calls.filter((call) => call === OPERATIONS).length).toBe(2);
  });

  it('sends constraints when a person supplied them, as an addition', async () => {
    none();
    routes['POST /api/cash/activate'] = {
      body: { mode: {}, changed: true, message: 'Cash Mode is active.' },
    };
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /start cash mode/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /add constraints/i }));
    fireEvent.change(screen.getByLabelText(/prioritise, rule out/i), {
      target: { value: 'Nothing needing a vehicle.' },
    });
    fireEvent.change(screen.getByLabelText(/one currency/i), { target: { value: 'GBP' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start cash mode/i }));
    });
    expect(bodies['POST /api/cash/activate']).toMatchObject({
      constraints: 'Nothing needing a vehicle.',
      currency: 'GBP',
    });
  });
});

describe('the decision nothing can proceed without', () => {
  it('is named first and is not folded away', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/Spending limits .* what Brain may spend here/)).toBeTruthy(),
    );
    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings[0]).toBe('Decisions for you');
  });

  it('shows the outstanding approval once, as the control rather than twice', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/Spending limits .* what Brain may spend here/)).toBeTruthy(),
    );
    expect(screen.getAllByText(/Spending limits .* what Brain may spend here/).length).toBe(1);
    // The server's own list titles it the old way; the card is the control, so
    // the list entry is the one that goes.
    expect(screen.queryByText('Decide what Brain may spend here')).toBeNull();
    expect(screen.getByText('3 cards with no payer')).toBeTruthy();
  });



  it('reports the compression rather than claiming it', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/standing for 3 underlying items/i)).toBeTruthy(),
    );
    /*
     * "One answer covers" and "the same kind of work on" are different claims,
     * and this group is the second: three cards with no payer are three
     * different buyers. The screen used to say answering it released all three.
     */
    expect(screen.getByText(/The same kind of work on 3 items\./)).toBeTruthy();
    expect(screen.queryByText(/One answer covers 3 items\./)).toBeNull();
  });

  it('shows what can never be authorized, before anybody approves', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('PAID_OVERAGE')).toBeTruthy());
    expect(screen.getByText('BORROW_OR_LEVERAGE')).toBeTruthy();
    expect(screen.getByText(/can never be authorized, by any grant/i)).toBeTruthy();
  });

  it('offers no Approve until somebody has said what the limits are', async () => {
    /*
     * The card used to arrive prefilled — $1,000 committed, $250 per action,
     * three opportunities — with Approve visible and the terms folded away
     * behind "Change details". Nobody chose those numbers, and the person
     * approving could not see what they were approving.
     */
    base();
    await mount();
    await waitFor(() => expect(screen.getByLabelText(/most that may be committed at once/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(
      (screen.getByLabelText(/most that may be committed at once/i) as HTMLInputElement).value,
    ).toBe('');
    expect(
      (screen.getByLabelText(/how many opportunities may be executing/i) as HTMLInputElement).value,
    ).toBe('');
    expect(
      (screen.getByRole('button', { name: /show me what this authorizes/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('answers a grouped need through the operation that already exists', async () => {
    /*
     * The review rendered items and needs as paragraphs with no answer
     * controls, while its own summary claimed answering a group released the
     * underlying work. This is the control, and it calls `closeNeed` — the
     * operation that already exists — rather than a second apply endpoint that
     * would be one forgotten guard away from doing less.
     */
    const answerable = view({
      decisionsForMe: {
        items: [
          {
            key: 'NEED_cnd_1',
            title: '2 blocked actions, one remedy',
            why: 'Both wait on the same small tool.',
            recommendation: 'Buy the same small tool once. (about 5000 cents)',
            consequence: 'Resolving this unblocks 2 actions.',
            urgency: 'WHENEVER',
            underlying: ['cnd_1', 'cnd_2'],
            sharedRemedy: true,
            costCents: 5_000,
            costNote: 'One remedy at 5000 cents, paid once — not 2 times.',
            answer: {
              kind: 'RESOLVE_NEED',
              targets: ['cnd_1', 'cnd_2'],
              label: 'Mark all 2 done, and say what you did',
              completionCondition: 'The tool is reachable from here.',
            },
          },
        ],
        underlyingCount: 2,
        summary: '1 thing to decide, standing for 2 underlying items.',
      },
    });
    base({
      [VIEW]: { body: answerable },
      'POST /api/cash/needs/cnd_1/close': { body: { need: { id: 'cnd_1', state: 'RESOLVED' } } },
      'POST /api/cash/needs/cnd_2/close': { body: { need: { id: 'cnd_2', state: 'RESOLVED' } } },
    });
    await mount();

    // The cost is the remedy's, once — not the sum over what it unblocks.
    await waitFor(() =>
      expect(screen.getByText(/One remedy at 5000 cents, paid once/i)).toBeTruthy(),
    );
    expect(screen.getByText(/One answer covers 2 items\./)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mark all 2 done/i }));
    });
    // Brain says what it will read back, rather than trusting the button. It
    // appears before the control as well as on it, because what an answer
    // *affects* is named before somebody gives it.
    expect(screen.getAllByText(/The tool is reachable from here/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/This answer applies to 2 records/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/what did you do/i), {
      target: { value: 'Bought it on the team card.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });

    expect(bodies['POST /api/cash/needs/cnd_1/close']).toMatchObject({
      to: 'RESOLVED',
      resolution: 'Bought it on the team card.',
    });
    expect(bodies['POST /api/cash/needs/cnd_2/close']).toMatchObject({ to: 'RESOLVED' });
    // Never optimistic: the page goes back to the server for what is true now.
    expect(calls.filter((call) => call === VIEW).length).toBe(2);
  });

  it('answers a card field, and says it is the person’s now', async () => {
    /*
     * Every answer but `RESOLVE_NEED` rendered as a paragraph, on the excuse
     * that the funding and release controls existed elsewhere on the page. They
     * did not: the money panel is a read-only table and the opportunity actions
     * are ready/execute/deliver/collect/decline. So the screen was telling
     * people to do things somewhere that had no way to do them.
     */
    const cardDecision = view({
      decisionsForMe: {
        items: [
          {
            key: 'MISSING_PRICE',
            title: '1 card with no price',
            why: 'An unknown is not a favourable assumption.',
            recommendation: 'Quote one price.',
            consequence: 'It becomes ready to test the moment its answer exists.',
            urgency: 'WHENEVER',
            underlying: ['cop_1'],
            sharedRemedy: true,
            costCents: null,
            costNote: null,
            answer: {
              kind: 'FILL_CARD_FIELD',
              targets: ['cop_1'],
              label: 'Answer the price on this card',
              completionCondition: 'Every one of these cards records a price.',
            },
          },
        ],
        underlyingCount: 1,
        summary: '1 thing to decide, standing for 1 underlying item.',
      },
    });
    base({
      [VIEW]: { body: cardDecision },
      'PATCH /api/cash/opportunities/cop_1': { body: { opportunity: opportunity() } },
    });
    await mount();

    await waitFor(() => expect(screen.getByText(/This answer applies to 1 record/i)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /answer the price on this card/i }));
    });
    fireEvent.change(screen.getByLabelText(/1 card with no price/i), {
      target: { value: '120000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });

    // The same guarded route the card editor uses, so an answer given here and
    // one given on the card are one operation.
    expect(bodies['PATCH /api/cash/opportunities/cop_1']).toMatchObject({ price: '120000' });
    expect(screen.getByText(/Brain will not propose over it/i)).toBeTruthy();
    expect(calls.filter((call) => call === VIEW).length).toBe(2);
  });

  it('records money that actually arrived, and refuses to without a reference', async () => {
    const shortfall = view({
      decisionsForMe: {
        items: [
          {
            key: 'SHORTFALL',
            title: 'Deployable cash is negative',
            why: 'Available funds minus commitments is -20000 cents.',
            recommendation: 'Fund the shortfall or release a commitment.',
            consequence: 'Delivery on work already sold continues regardless.',
            urgency: 'BLOCKING',
            underlying: [],
            sharedRemedy: true,
            costCents: null,
            costNote: null,
            answer: {
              kind: 'RECORD_MONEY',
              targets: [],
              label: 'Record the funding, or release a commitment',
              completionCondition: 'Deployable cash is no longer negative.',
            },
          },
        ],
        underlyingCount: 0,
        summary: '1 thing to decide.',
      },
    });
    base({
      [VIEW]: { body: shortfall },
      [`POST /api/projects/${PROJECT}/cash/money`]: { body: { entry: { id: 'cme_1' } } },
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record the funding/i }));
    });
    fireEvent.change(screen.getByLabelText(/how much, in USD cents/i), {
      target: { value: '50000' },
    });
    // A payment nobody can trace is pipeline, not cash — so there is nothing to
    // press until it can be traced.
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/traced by/i), { target: { value: 'bank-9912' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });
    expect(bodies[`POST /api/projects/${PROJECT}/cash/money`]).toMatchObject({
      amountCents: 50_000,
      verifiedReference: 'bank-9912',
      // Built from what it records rather than from a clock, so a retry after a
      // lost response is the same entry once.
      idempotencyKey: 'funding:bank-9912',
    });
  });

  it('releases a commitment that is not going to be spent', async () => {
    const held = view({
      myCash: {
        position: POSITION,
        entries: [],
        commitments: [
          {
            id: 'ccm_1',
            amountCents: 20_000,
            currency: 'USD',
            purpose: 'A bounded paid test',
            state: 'HELD',
            stopCondition: 'No reply within a week',
          },
        ],
      },
      decisionsForMe: {
        items: [
          {
            key: 'READY_BUT_HELD',
            title: '1 ready opening is held by money or capacity',
            why: 'It waits on deployable cash.',
            recommendation: 'Settle or release a commitment.',
            consequence: 'Answering this once releases all of them.',
            urgency: 'BLOCKING',
            underlying: ['cop_1'],
            sharedRemedy: true,
            costCents: null,
            costNote: null,
            answer: {
              kind: 'RELEASE_COMMITMENT',
              targets: [],
              label: 'Release or settle a commitment',
              completionCondition: 'Deployable cash covers one of these.',
            },
          },
        ],
        underlyingCount: 1,
        summary: '1 thing to decide.',
      },
    });
    base({
      [VIEW]: { body: held },
      'POST /api/cash/commitments/ccm_1/release': { body: { released: true } },
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /release or settle a commitment/i }));
    });
    fireEvent.change(screen.getByLabelText(/which commitment/i), { target: { value: 'ccm_1' } });
    fireEvent.change(screen.getByLabelText(/why it is not being spent/i), {
      target: { value: 'The buyer went elsewhere.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });

    expect(bodies['POST /api/cash/commitments/ccm_1/release']).toMatchObject({
      reason: 'The buyer went elsewhere.',
    });
    // Never released by a clock: this is somebody saying it is not being spent.
    expect(screen.getByText(/Nothing was spent, and the record stays/i)).toBeTruthy();
  });

  it('offers a substitute rather than pretending a condition was met', async () => {
    const needDecision = view({
      decisionsForMe: {
        items: [
          {
            key: 'NEED_cnd_1',
            title: 'Brain needs: take a payment',
            why: 'The buyer cannot pay without it.',
            recommendation: 'Connect a payment processor.',
            consequence: 'Resolving this unblocks 1 action.',
            urgency: 'WHENEVER',
            underlying: ['cnd_1'],
            sharedRemedy: true,
            costCents: null,
            costNote: null,
            answer: {
              kind: 'RESOLVE_NEED',
              targets: ['cnd_1'],
              label: 'Mark this done, and say what you did',
              completionCondition: 'TAKE_A_PAYMENT reads PRESENT.',
            },
          },
        ],
        underlyingCount: 1,
        summary: '1 thing to decide.',
      },
    });
    base({
      [VIEW]: { body: needDecision },
      'POST /api/cash/needs/cnd_1/close': { body: { need: { id: 'cnd_1', state: 'RESOLVED' } } },
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mark this done/i }));
    });
    fireEvent.change(screen.getByLabelText(/what did you do/i), {
      target: { value: 'The buyer paid us.' },
    });
    fireEvent.change(screen.getByLabelText(/doing this another way/i), {
      target: { value: 'Bank transfer outside Brain for now.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    });

    // The integration is still missing, and Brain records that rather than the
    // condition having been met.
    expect(bodies['POST /api/cash/needs/cnd_1/close']).toMatchObject({
      to: 'RESOLVED',
      resolution: 'The buyer paid us.',
      substitute: 'Bank transfer outside Brain for now.',
    });
  });

  it('offers no button for a decision no control on this page answers', async () => {
    const expiring = view({
      decisionsForMe: {
        items: [
          {
            key: 'EXPIRING',
            title: '1 opening closes within three days',
            why: 'It closes on Thursday.',
            recommendation: 'Take it before the slower pieces.',
            consequence: 'Nothing else gets worse by waiting a day; this does.',
            urgency: 'URGENT',
            underlying: ['cop_1'],
            sharedRemedy: false,
            costCents: null,
            costNote: null,
            answer: {
              kind: 'NOTHING_TO_PRESS',
              targets: ['cop_1'],
              label: 'Answered by taking them, not by a control here',
              completionCondition: 'Each of these is executing, declined, or has closed.',
            },
          },
        ],
        underlyingCount: 1,
        summary: '1 thing to decide, standing for 1 underlying item.',
      },
    });
    base({ [VIEW]: { body: expiring } });
    await mount();

    // A disabled button would be a control that pretends to do something.
    await waitFor(() =>
      expect(screen.getByText(/Answered by taking them, not by a control here\./)).toBeTruthy(),
    );
    expect(
      screen.queryByRole('button', { name: /Answered by taking them/i }),
    ).toBeNull();
  });

  it('says the concurrency bounds execution rather than the portfolio', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText(/bounds what may be/i)).toBeTruthy());
    expect(screen.getByText(/not a limit on how many pieces the portfolio may hold/i)).toBeTruthy();
  });

  it('shows the server’s own terms before there is anything to approve', async () => {
    base({
      [PREVIEW]: {
        body: { lines: ['Brain may commit up to USD 500.00 of your money at any one time.'] },
      },
      [AUTHORITY]: { body: { authority: { id: 'cau_1' }, lines: [] } },
    });
    await mount();
    await waitFor(() => expect(screen.getByLabelText(/most that may be committed at once/i)).toBeTruthy());

    /*
     * Typed in ordinary money and sent in cents.
     *
     * The two ceilings used to be typed in cents, which asked a person to do a
     * hundredfold conversion in the one box where being out by a factor of a
     * hundred is a spending limit. Nothing about the grant moved: what arrives
     * at the route is what always arrived.
     */
    fireEvent.change(screen.getByLabelText(/most that may be committed at once/i), {
      target: { value: '500.00' },
    });
    fireEvent.change(screen.getByLabelText(/most in any single commitment/i), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText(/how many opportunities may be executing/i), {
      target: { value: '2' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /show me what this authorizes/i }));
    });
    expect(bodies[PREVIEW]).toMatchObject({
      maxCommittedCents: 50_000,
      maxPerActionCents: 10_000,
      maxConcurrent: 2,
    });
    // The preview creates nothing.
    expect(calls).not.toContain(AUTHORITY);
    expect(
      screen.getByText('Brain may commit up to USD 500.00 of your money at any one time.'),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(bodies[AUTHORITY]).toMatchObject({
      allowedActions: VOCABULARY.commercialActions,
      maxCommittedCents: 50_000,
      maxPerActionCents: 10_000,
      maxConcurrent: 2,
    });
    expect(calls.filter((call) => call === VIEW).length).toBe(2);
  });

  it('withdraws the preview when a limit changes, so stale terms cannot be approved', async () => {
    base({
      [PREVIEW]: { body: { lines: ['Brain may commit up to USD 500.00.'] } },
    });
    await mount();
    await waitFor(() => expect(screen.getByLabelText(/most that may be committed at once/i)).toBeTruthy());
    for (const [label, value] of [
      [/most that may be committed at once/i, '500'],
      [/most in any single commitment/i, '100'],
      [/how many opportunities may be executing/i, '2'],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /show me what this authorizes/i }));
    });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/most that may be committed at once/i), {
      target: { value: '9000' },
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
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
            allowedActions: ['CONTACT_BUYER'],
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
    // Three now: the two the position carries, plus the forecast's revenue —
    // which is a *forecast* of the same money and is in its own table under its
    // own heading, because a figure Brain worked out from a card is not the
    // same kind of number as one an append-only entry produced.
    expect(screen.getAllByText('USD 750.00').length).toBe(3);
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
