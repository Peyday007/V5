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
import { readFile } from 'node:fs/promises';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * A tier reading, as the server derives it.
 *
 * Names, tasks and counts — and no value of any commercial term, which is why
 * it may cross to a member at all. The fixture says so explicitly rather than
 * relying on the reader noticing.
 */
function tier(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tier: 'READY_TO_TEST',
    establishes: 'that somebody published a paid request',
    doesNotEstablish: 'that they would pay us',
    toAdvance: [],
    answered: 6,
    required: 6,
    summary: 'Everything a bounded test turns on is answered.',
    ...over,
  };
}

/** One record on the shared frontier: identity, evidence, progress. No values. */
function sharedOpportunity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cop_1',
    title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    industry: null,
    state: 'READY',
    availability: 'CLAIMED',
    because: '2 of 2 execution slots are taken, so this waits on fulfilment capacity.',
    validationState: null,
    buyingSignal: 'A published request to pay for intake repair.',
    signalObservedAt: '2026-09-14T00:00:00.000Z',
    sourceClaimId: 'clm_1',
    orchestrationId: 'orc_1',
    fragmentId: 'frg_1',
    discoveryRoundId: 'cdr_1',
    expiresAt: null,
    deadline: null,
    qualification: { ready: true, missing: [], summary: 'Ready.' },
    tier: tier(),
    ...over,
  };
}

/**
 * The shared frontier — the **one object** both roles' shared sections render
 * from. An owner's payload carries it under `frontier`; a member's payload *is*
 * it. The fixture builds it once for exactly that reason.
 */
function frontier(over: Record<string, unknown> = {}): Record<string, unknown> {
  const opportunities = (over['opportunities'] as unknown[]) ?? [sharedOpportunity()];
  return {
    mode: {
      projectId: PROJECT,
      state: 'ACTIVE',
      currency: 'USD',
      activatedAt: '2026-09-15T00:00:00.000Z',
      objective: 'Maximize additional usable cash over the next few weeks.',
    },
    discovery: { open: true, reason: 'Cash Mode is active.' },
    commercialGrant: 'ABSENT',
    opportunities,
    best: opportunities,
    bestAreNearlyQualified: false,
    byTier: { SIGNAL: 0, CANDIDATE: 0, QUALIFIED: 0, READY_TO_TEST: 1 },
    byState: {
      DISCOVERED: 0,
      EVIDENCE_CARD: 0,
      READY: 1,
      EXECUTING: 0,
      DELIVERING: 0,
      COLLECTED: 0,
      DECLINED: 0,
      ARCHIVED: 0,
    },
    counts: {
      total: 1,
      open: 0,
      beingQualified: 0,
      claimed: 1,
      inExecution: 0,
      delivered: 0,
      closed: 0,
    },
    roadmap: ROADMAP,
    needs: [],
    activity: [
      { kind: 'CASH_OPPORTUNITY_CAPTURED', count: 1, mostRecentAt: '2026-09-15T00:00:00.000Z' },
    ],
    ...over,
  };
}

/** Everything a project administrator may do. */
const ALL_CAPABILITIES = {
  mayAdminister: true,
  mayGrantAuthority: true,
  mayViewPrivateJob: true,
  mayActOnJob: true,
};

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'FULL',
    capabilities: ALL_CAPABILITIES,
    frontier: frontier(),
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
          tier: tier(),
        },
      ],
      byTier: { SIGNAL: 0, CANDIDATE: 0, QUALIFIED: 0, READY_TO_TEST: 1 },
      best: [],
      bestAreNearlyQualified: false,
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
        /*
         * A second decision that is genuinely a person's.
         *
         * This used to be `MISSING_PAYER` — "3 cards with no payer", with a
         * control offering to answer the payer on each — and the server does
         * not produce that item any more, because a payer is a fact about the
         * world that Brain researches. A client fixture modelling a shape the
         * server can no longer emit tests nothing, so it is replaced by one it
         * still does: several needs sharing one remedy, which is one tool
         * bought once.
         */
        {
          key: 'NEED_cnd_1',
          title: '3 blocked actions, one remedy',
          why: 'Reaching a buyer needs a way to send a message, and Brain has none.',
          recommendation: 'Connect a way to send messages. Next step: pick one and connect it.',
          consequence: 'Resolving this unblocks 3 actions. Independent work is running meanwhile.',
          urgency: 'WHENEVER',
          underlying: ['cnd_1', 'cnd_2', 'cnd_3'],
          sharedRemedy: true,
          costCents: null,
          costNote: null,
          answer: {
            kind: 'RESOLVE_NEED',
            targets: ['cnd_1', 'cnd_2', 'cnd_3'],
            label: 'Mark all 3 done, and say what you did',
            completionCondition: 'A way to send a message is connected.',
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

describe('people and capacity are not on this page', () => {
  /*
   * They used to be, inline: a member list, an invite control, the outstanding
   * links and every Claude capacity account, rendered at the bottom of Cash.
   *
   * None of it is about Cash. A person joins a **Brain** and a Routine serves
   * every project in it; §32 removed the last count on this surface that gated
   * anything, so what was left was Brain-wide account infrastructure
   * administered from a section that is meant to be wound down in a month or
   * two — §30's own first sentence failing in the navigation.
   *
   * Asserted as an absence *and* as a link, because deleting the panel without
   * leaving a way to reach what it did would be the disappearing control §29
   * keeps having to correct.
   */
  it('renders no member list, no capacity list and no invite control', async () => {
    base({ 'GET /api/members': { body: { links: [] } } });
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    expect(screen.queryByText('People and capacity')).toBeNull();
    expect(screen.queryByText('Human members')).toBeNull();
    expect(screen.queryByText('Claude capacity accounts')).toBeNull();
    expect(screen.queryByLabelText(/invite somebody/i)).toBeNull();
  });

  /*
   * And does not *ask* for them either.
   *
   * A page that still fetched the member list and threw it away would be one
   * refactor from rendering it again, and would be reading a list of people on
   * a screen that has no reason to hold one.
   */
  it('asks for neither the member list nor a readiness count', async () => {
    base({ 'GET /api/members': { body: { links: [] } } });
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    expect(calls).not.toContain('GET /api/members');
    expect(calls).not.toContain('GET /api/people');
  });

  it('carries one link to where they now live', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    const link = screen.getByRole('link', { name: /People & capacity/i });
    expect(link.getAttribute('href')).toBe('/people');
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

    // The server's one sentence about where this is, in one place: the status
    // screen. It used to be here too, which put it on the page twice.
    expect(screen.getAllByText(ROADMAP.whatHappensNext).length).toBe(1);
    // The plan's own denominator. Five, because the plan holds five — not
    // twenty, and not a percentage of a number nobody knows.
    expect(screen.getByText('1 of 5 research items done', { exact: false })).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/\b20\b/);
    expect(document.body.textContent ?? '').not.toMatch(/%/);

    // The question a worker is on, in the fragment's own words.
    expect(
      screen.getByText('Who is publicly asking to pay for work right now?'),
    ).toBeTruthy();
    /*
     * Scoped to this section. The status screen above counts pieces *ready to
     * test*, which is a tier of the portfolio and shares a label with a stage
     * of the pipeline — two different facts that happen to be said the same
     * way, so the query says which one it means.
     */
    const roadmap = document.querySelector('.rs-cash-roadmap') as HTMLElement;
    for (const stage of ROADMAP.pipeline) {
      expect(within(roadmap).getByText(stage.label)).toBeTruthy();
    }
  });

  it('translates the event code and keeps it', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('Everything that has happened')).toBeTruthy());
    expect(screen.getByText(/An opening was written down/)).toBeTruthy();
    /*
     * Translated for the person, and the underlying code still on the row for
     * somebody who needs it — in the document rather than in a `title`
     * attribute, which is unreachable on a phone and unreachable by a screen
     * reader on a span. The one reader it was there for could not get at it on
     * either.
     */
    expect(screen.getByText('CASH_OPPORTUNITY_CAPTURED')).toBeTruthy();
    expect(screen.getByText('Captured "A paid intake repair".')).toBeTruthy();
  });

  it('pages the history rather than printing all of it', async () => {
    const many = Array.from({ length: 24 }, (_, index) => ({
      id: `evt_${index}`,
      kind: 'CASH_OPPORTUNITY_CAPTURED',
      summary: `Event number ${index}.`,
      actorRef: 'BRAIN',
      createdAt: '2026-09-15T00:00:00.000Z',
    }));
    base({ [VIEW]: { body: view({ whatBrainHasDone: many }) } });
    await mount();
    await waitFor(() => expect(screen.getByText('Everything that has happened')).toBeTruthy());

    expect(screen.getByText('Event number 0.')).toBeTruthy();
    expect(screen.queryByText('Event number 15.')).toBeNull();
    const more = screen.getByText(/Show 10 more of 24/);
    fireEvent.click(more);
    expect(screen.getByText('Event number 15.')).toBeTruthy();
    expect(screen.queryByText('Event number 23.')).toBeNull();
  });
});

describe('the first screen is a summary, not the database', () => {
  it('puts the whole portfolio, the needs, the research and the history behind a disclosure', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('The cash machine')).toBeTruthy());

    /*
     * Production met thirty-one raw signals and five "decisions" standing for
     * ninety-eight items before anything said what state the sprint was in.
     * Nothing is deleted — each of these is one click away and complete — but
     * none of them is the first screen.
     */
    for (const heading of [
      'Everything Brain has found',
      'What Brain is working on',
      'Research detail',
      'Money detail and the spending authority',
      'Activity',
      /*
       * `People and capacity` was a seventh disclosure here and is not one any
       * more: it is not about Cash at all, and collapsing it is what the
       * instruction that removed it rules out by name. Its absence — and the one
       * link that replaces it — is asserted in *people and capacity are not on
       * this page*, so removing it from this list loses no coverage.
       */
    ]) {
      const node = screen.getByText(heading);
      const disclosure = node.closest('details');
      expect(disclosure).not.toBeNull();
      expect(disclosure!.open).toBe(false);
    }

    // And what *is* on the first screen: the status, the decisions and the
    // best openings, none of them folded.
    for (const heading of ['The cash machine', 'Decisions for you', 'Best opportunities', 'Money']) {
      expect(screen.getByText(heading).closest('details')).toBeNull();
    }
  });
});

describe('the money picture', () => {
  it('shows the authorization figures as facts, including zero', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText('The money picture')).toBeTruthy());

    /*
     * Scoped to the detailed picture, because the compact money row above says
     * the same four words about the same four figures. That is a summary of
     * this rather than a second opinion — one server-derived source, rendered
     * twice — so the query names which rendering it is asserting about.
     */
    const picture = document.querySelector('.rs-cash-picture') as HTMLElement;
    expect(within(picture).getByText('Authorized')).toBeTruthy();
    expect(within(picture).getByText('Committed')).toBeTruthy();
    expect(within(picture).getByText('Spent')).toBeTruthy();
    expect(within(picture).getByText('Remaining authorized capacity')).toBeTruthy();
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
    await mount(null, true);
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
    await mount(PROJECT, true);
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
    await mount(PROJECT, true);
    const button = await screen.findByRole('button', { name: /start cash mode/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByLabelText(/what is this account trying to produce/i)).toBeNull();
    expect(screen.getByText(new RegExp(MINE.objective.summary.slice(0, 40), 'i'))).toBeTruthy();
  });

  it('counts nobody on this card, because the counts are not its question', async () => {
    /*
     * The four-of-four count was the owner's decision to wait for everybody
     * rather than a property of the system, and §32 withdrew the lock. What
     * went next is the reading itself: who has joined is true of the whole
     * Brain, so it is on its own page and this card neither renders it nor
     * asks for it.
     *
     * Both halves are asserted at once. The button is pressable, and the
     * sentence that explained the lock is not on the screen — "not ready to
     * start" beside a button that starts is §29's status contradicting the
     * control beside it.
     */
    none();
    await mount(PROJECT, true);
    const button = await screen.findByRole('button', { name: /start cash mode/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/not ready to start/i)).toBeNull();
    expect(screen.queryByText(/READY$/)).toBeNull();
    expect(screen.queryByText(/HEALTHY/)).toBeNull();
  });

  it('says nothing about anybody at all', async () => {
    none();
    await mount(PROJECT, true);
    await screen.findByRole('button', { name: /start cash mode/i });
    // No name, no state, no address. The payload does not carry them and the
    // screen invents nothing.
    expect(document.body.textContent ?? '').not.toMatch(/@/);
    expect(screen.queryByLabelText(/invite somebody/i)).toBeNull();
  });

  it('offers no Start control to somebody who is not a Brain administrator', async () => {
    /*
     * A convenience rather than the control: `POST /api/cash/activate` is
     * `requirePerson` plus `requireBrainAdmin` whatever this renders. What
     * matters on the screen is that the absence says whose decision it is
     * rather than implying nothing exists.
     */
    none();
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/Brain administrator.s decision/i)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: /start cash mode/i })).toBeNull();
    expect(calls).not.toContain('GET /api/members');
  });

  it('keeps the currency and constraints collapsed, so neither is a step', async () => {
    none();
    await mount(PROJECT, true);
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
    await mount(PROJECT, true);
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
    await mount(PROJECT, true);
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
    /*
     * The status screen is first and the decisions are second, and neither is
     * folded.
     *
     * This asserted that the decisions were the very first thing. That was
     * right while the page had no summary at all, and it is the wrong shape
     * now: a person arriving needed to know what state the machine was in
     * before being handed something to decide. What matters is unchanged — the
     * decision nothing can proceed without is above everything it blocks, and
     * is not inside a disclosure.
     */
    expect(headings[0]).toBe('The cash machine');
    expect(headings[1]).toBe('Decisions for you');
    const decisions = document.querySelector('.rs-cash-decisions');
    expect(decisions?.closest('details')).toBeNull();
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
    expect(screen.getByText('3 blocked actions, one remedy')).toBeTruthy();
  });



  it('reports the compression rather than claiming it', async () => {
    base();
    await mount();
    await waitFor(() =>
      expect(screen.getByText(/standing for 3 underlying items/i)).toBeTruthy(),
    );
    /*
     * "One answer covers" and "the same kind of work on" are different claims,
     * and the screen still draws both. This group is the first: three needs
     * recommending the identical path are one tool bought once, so answering
     * it genuinely releases all three.
     *
     * The second branch used to be exercised here by three cards with no
     * payer, and the server does not produce that group any more — a payer is
     * a fact Brain researches rather than a question for a person. It is still
     * drawn for an expiring opening, which is several pieces that share no
     * remedy at all.
     */
    expect(screen.getByText(/One answer covers 3 items\./)).toBeTruthy();
    expect(screen.queryByText(/The same kind of work on 3 items\./)).toBeNull();
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

  it('answers a card question on the card itself, and says it is the person’s now', async () => {
    /*
     * This drove the review's `FILL_CARD_FIELD` control, which is gone with
     * the section that produced it: every field it could have offered is a
     * fact Brain researches or a proposal Brain composes, so the server emits
     * no such item any more.
     *
     * The capability moved rather than went, and it matters more than it did:
     * twelve of the card's questions have no column at all, so until this
     * control existed the bounded deep dive was the only thing that could
     * answer one — and the tier requires them. A person who knew the answer
     * had nowhere to put it.
     */
    const withUnknown = view({
      myCurrentWork: {
        ...(view().myCurrentWork as Record<string, unknown>),
        best: [
          {
            opportunity: opportunity(),
            disposition: 'TEST_A_DECISIVE_UNKNOWN',
            because: 'One thing on this card is unknown.',
            missing: [],
            tier: {
              tier: 'QUALIFIED',
              establishes: 'a named buyer published that they want something',
              doesNotEstablish: 'that they would buy it from us',
              toAdvance: [],
              answered: 15,
              required: 16,
              summary: 'The execution thesis is supported.',
            },
          },
        ],
        byTier: { SIGNAL: 0, CANDIDATE: 0, QUALIFIED: 1, READY_TO_TEST: 0 },
        bestAreNearlyQualified: false,
        engineCards: {
          cop_1: {
            opportunityId: 'cop_1',
            validationState: 'COMPLETE',
            recommendation: null,
            unknowns: ['eligibility'],
            entries: [
              {
                key: 'eligibility',
                label: 'Eligibility and permission',
                value: null,
                kind: 'UNKNOWN',
                task: 'Find what published rule decides whether we may take it at all.',
                claimId: null,
                basis: null,
                assumptions: null,
                uncertainty: null,
              },
            ],
          },
        },
        economics: { cop_1: [] },
      },
    });
    base({
      [VIEW]: { body: withUnknown },
      'PATCH /api/cash/opportunities/cop_1': { body: { opportunity: opportunity() } },
    });
    await mount();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /show the full card/i })[0]!);
    });
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('button', { name: /answer the eligibility and permission/i })[0]!,
      );
    });
    fireEvent.change(screen.getAllByLabelText(/^Eligibility and permission$/)[0]!, {
      target: { value: 'No licence applies to work this size.' },
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[0]!);
    });

    // The same guarded route the card editor uses, under the field's own key —
    // an engine field has no column, so its name is what `fillCard` matches.
    expect(bodies['PATCH /api/cash/opportunities/cop_1']).toMatchObject({
      eligibility: 'No licence applies to work this size.',
    });
    await waitFor(() =>
      expect(screen.getByText(/It is yours now, so Brain will not propose over it/i)).toBeTruthy(),
    );
  });

  it('never renders a control for a review item the server cannot produce', async () => {
    // `FILL_CARD_FIELD` is still in the wire vocabulary because the type is
    // shared; nothing composes one. The arm that rendered it is deleted, so a
    // stale item would show its words and no control rather than a control
    // posting to a path the section no longer has an opinion about.
    const source = await readFile('client/src/russell/Cash.tsx', 'utf8');
    expect(source).not.toMatch(/kind === 'FILL_CARD_FIELD'/);
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
    // Scoped, because the compact money row above reports the same figure as
    // remaining capacity — a summary of this table rather than a second one.
    const mine = document.querySelector('.rs-cash-money') as HTMLElement;
    expect(within(mine).getByText('-USD 200.00')).toBeTruthy();
    expect(screen.getByText(/Deployable cash is negative/i)).toBeTruthy();
  });

  it('carries the server’s sentence for every disposition, so a wait names what it waits on', async () => {
    base();
    await mount();
    /*
     * Scoped to the portfolio, because the same piece legitimately appears in
     * *Best opportunities* too — one page, one record, two sections that are
     * both about it. A bare `getByText` here would be asserting that only one
     * section mentions it, which was never the claim.
     */
    await waitFor(() => expect(screen.getByText('Wait for a named dependency')).toBeTruthy());
    const portfolio = within(document.querySelector('details.rs-cash-portfolio') as HTMLElement);
    expect(portfolio.getByText(/waits on fulfilment capacity/i)).toBeTruthy();
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
    // Scoped for the same reason as above: the piece is in two sections.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /pass on this/i }).length).toBeGreaterThan(0),
    );
    const portfolio = within(document.querySelector('details.rs-cash-portfolio') as HTMLElement);

    fireEvent.click(portfolio.getByRole('button', { name: /pass on this/i }));
    const field = portfolio.getByLabelText(/Why\?/i);
    expect(field).toBeTruthy();

    // And it will not send an empty one.
    expect((portfolio.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
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

/**
 * ---------------------------------------------------------------------------
 * View parity: one page, two roles
 * ---------------------------------------------------------------------------
 *
 * There used to be an early `return <SharedFrontier/>` in this component, and
 * it was a **second page**: nine sections against five, no heading in common,
 * and not one section identifier in common — every member card was a bare
 * `.rs-card` with no `rs-cash-*` class, so nothing on the member's page was
 * even addressable by the name the owner's page used for the same subject.
 *
 * The privacy boundary it protected was right and is asserted here too. What
 * was wrong is that a permission chose a *layout*, which meant a defect on one
 * of the two pages was invisible to anybody looking at the other — and one of
 * them is the page nobody with access to the other ever opens.
 *
 * Every assertion below is deliberately about **structure** rather than about
 * a sentence: the section order, the identifiers, the headings, the shared
 * figures and the absence of private ones. A wording change must be free; a
 * section appearing, vanishing or moving for one role must not be.
 */

/** The ordered section identifiers the page is contracted to render. */
const SECTIONS = [
  'rs-cash-status',
  'rs-cash-decisions',
  'rs-cash-best',
  'rs-cash-money-row',
  'rs-cash-portfolio',
  'rs-cash-needs-detail',
  'rs-cash-research',
  'rs-cash-money-detail',
  'rs-cash-history',
  'rs-cash-lifecycle',
];

/**
 * The page's own section tree, read from the document.
 *
 * Only the top-level cards under the view, so a nested `.rs-cash-portfolio`
 * inside its own disclosure is not counted twice and a section that grew a
 * child does not read as two sections.
 */
function sectionTree(): { id: string; heading: string }[] {
  const root = document.querySelector('section.rs-view-cash') as HTMLElement;
  return [...root.children]
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .filter((node) => node.classList.contains('rs-card'))
    .map((node) => ({
      id: [...node.classList].find((one) => one.startsWith('rs-cash-')) ?? '(unnamed)',
      heading: node.querySelector('h3')?.textContent?.trim() ?? '(none)',
    }));
}

/** What a member's server answer looks like: the frontier, and no private block. */
function memberBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'SHARED',
    capabilities: {
      mayAdminister: false,
      mayGrantAuthority: false,
      mayViewPrivateJob: false,
      mayActOnJob: false,
    },
    ...frontier(),
    ...over,
  };
}

describe('view parity between an administrator and an ordinary member', () => {
  it('renders the same ordered section identifiers and headings for both roles', async () => {
    base();
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    const owner = sectionTree();

    cleanup();
    base({ [VIEW]: { body: memberBody() } });
    await mount(PROJECT, false);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    const member = sectionTree();

    expect(owner.map((one) => one.id)).toEqual(SECTIONS);
    expect(member).toEqual(owner);
  });

  it('renders the same shared counts and the same records, from one object', async () => {
    /*
     * The frontier is built once by the fixture and appears in both payloads —
     * the owner's under `frontier`, the member's as the payload itself —
     * because that is exactly how the server sends it. If the page ever went
     * back to deriving the owner's stage counts from `myCurrentWork` and the
     * member's from `counts`, the two would disagree the first time an
     * availability word and a state stopped lining up, which is a defect this
     * repository has already had twice.
     */
    const read = (): string[] =>
      [...document.querySelectorAll('.rs-cash-status .rs-cash-tiers li')].map((node) =>
        (node.textContent ?? '').trim(),
      );

    base();
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    const ownerTiers = read();
    const ownerRecords = document.querySelectorAll('.rs-cash-portfolio .rs-list > li').length;

    cleanup();
    base({ [VIEW]: { body: memberBody() } });
    await mount(PROJECT, false);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());

    expect(read()).toEqual(ownerTiers);
    expect(document.querySelectorAll('.rs-cash-portfolio .rs-list > li').length).toBe(ownerRecords);
    // And the counts are real rather than both being empty.
    expect(ownerTiers.join(' ')).toMatch(/Ready to test/);
    expect(ownerRecords).toBeGreaterThan(0);
  });

  it('sends a member no private field, at any depth, and offers them no control', async () => {
    /*
     * Matched as **JSON keys** rather than as words. `entries`, `commitments`
     * and `provenance` are ordinary English and would match prose on the page;
     * a false finding in a boundary test costs somebody an hour and teaches
     * them to stop believing it — §29's defect, where it would do most damage.
     */
    const body = memberBody();
    const json = JSON.stringify(body);
    for (const forbidden of [
      'myCash',
      'entries',
      'commitments',
      'deployableCents',
      'availableFundsCents',
      'heldCents',
      'maxCommittedCents',
      'maxPerActionCents',
      'committedCents',
      'spentCents',
      'allowedActions',
      'decisionsForMe',
      'engineCards',
      'executionPaths',
      'provenance',
      'forecast',
      'priceCents',
    ]) {
      expect(json).not.toContain(`"${forbidden}":`);
    }

    base({ [VIEW]: { body } });
    await mount(PROJECT, false);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());

    for (const control of [
      /wind it down/i,
      /archive it/i,
      /make it active/i,
      /^approve$/i,
      /withdraw/i,
      /pass on this/i,
      /mark .* ready/i,
    ]) {
      expect(screen.queryByRole('button', { name: control })).toBeNull();
    }
    /*
     * And no money figure reaches the screen either. Matched on the rendered
     * shape `money()` actually produces — a currency code then an amount —
     * rather than on a dollar sign, which this sprint never renders and which
     * would therefore have passed against a page full of figures.
     */
    expect(document.body.textContent ?? '').not.toMatch(/\b[A-Z]{3}\s?-?[\d,]+\.\d\d/);
  });

  it('keeps every administrator control on the administrator page', async () => {
    base();
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    expect(screen.getByRole('button', { name: /wind it down/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /archive it/i })).toBeTruthy();
    expect(screen.getByLabelText(/^why$/i)).toBeTruthy();
    // The grant, which is the one thing nothing can proceed without.
    expect(screen.getByText(/what Brain may spend here/i)).toBeTruthy();
  });

  it('withholds a control the server says may not be pressed, and keeps its section', async () => {
    /*
     * A project member who is not a project administrator. The server decided
     * it — the client holds only a Brain-administrator flag, and every one of
     * these three decisions is project `ADMIN`, so a client deriving them would
     * have hidden a lifecycle control from the administrator entitled to press
     * it.
     *
     * The section stays, which is the half that matters: removing a control
     * must not remove or move a section, or the two pages diverge again one
     * permission at a time.
     */
    base({
      [VIEW]: {
        body: view({
          capabilities: {
            mayAdminister: false,
            mayGrantAuthority: false,
            mayViewPrivateJob: true,
            mayActOnJob: true,
          },
        }),
      },
    });
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());

    expect(sectionTree().map((one) => one.id)).toEqual(SECTIONS);
    expect(screen.queryByRole('button', { name: /wind it down/i })).toBeNull();
    expect(screen.getByText(/decisions for whoever administers this project/i)).toBeTruthy();
    // The private figures are still theirs to read: the payload carries them.
    expect(document.body.textContent ?? '').toMatch(/\b[A-Z]{3}\s?-?[\d,]+\.\d\d/);
  });

  it('fails closed when the server sent no capabilities at all', async () => {
    /*
     * An older server, a truncated response, or a shape this client did not
     * expect. Deny by default: the page renders, every section is there, and
     * nothing is offered. The cost of being wrong in this direction is a
     * control somebody reloads to see; the cost in the other direction is a
     * button that should not have been there.
     */
    const body = view();
    delete (body as Record<string, unknown>)['capabilities'];
    base({ [VIEW]: { body } });
    await mount(PROJECT, true);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    expect(sectionTree().map((one) => one.id)).toEqual(SECTIONS);
    expect(screen.queryByRole('button', { name: /wind it down/i })).toBeNull();
  });

  it('reads the frontier for a member and does not ask for a second thing', async () => {
    /*
     * Reading either page performs no effect. A member's Cash read is one GET
     * and nothing else: no enqueue, no claim, no registration, no fire.
     */
    base({ [VIEW]: { body: memberBody() } });
    await mount(PROJECT, false);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
    expect(calls.every((one) => one.startsWith('GET '))).toBe(true);
  });
});

/**
 * A deleted branch comes back as a component.
 *
 * §26 makes the same argument about a deleted page, and tests it by reading the
 * repository rather than by driving it: what must not exist is somewhere to go.
 * Here what must not exist is a second render path — so this reads `Cash.tsx`
 * and refuses one, because the parity assertions above hold only while both
 * roles reach the same skeleton, and a fresh `if (scope === 'SHARED') return`
 * would satisfy every one of them by making the member's tree its own.
 *
 * It classifies rather than bans, exactly as `operatorConsoleRemoved` does: the
 * comment recording why the branch was wrong is history worth keeping, and this
 * file's own name appears in it. What is refused is a `return` on the scope.
 */
describe('there is one render path, and no second one can be added quietly', () => {
  it('has no early return keyed on the read scope', async () => {
    const source = await readFile('client/src/russell/Cash.tsx', 'utf8');
    /*
     * A `return` whose guard mentions the scope, on one line or across two.
     * Prose about the scope is fine; a control-flow decision on it is not.
     */
    const branches = [...source.matchAll(/if\s*\([^)]*scope[^)]*\)\s*\{?\s*return/g)];
    expect(branches).toEqual([]);
  });

  it('renders every section from one component, with no page-level alternative', async () => {
    const source = await readFile('client/src/russell/Cash.tsx', 'utf8');
    /*
     * Exactly one element carries the view class. Two would be two pages
     * whatever chose between them, which is the thing that was wrong.
     */
    const views = [...source.matchAll(/className="rs-view rs-view-cash"/g)];
    /*
     * Four of them are the states a read can be in before there is anything to
     * render — reading Cash Mode, reading the frontier, an error, and a
     * forbidden answer — plus the page itself. None is a second *page*: they
     * carry no section, and a state is not a layout.
     */
    expect(views.length).toBeLessThanOrEqual(5);

    /*
     * And each section identifier is rendered by exactly **one** component.
     *
     * Counting occurrences would be the wrong check: a component may
     * legitimately have two branches — `Decisions` renders one card for an
     * owner and one for a member, which is a permission changing what is
     * inside a section. What must not happen is two *components* claiming one
     * identifier, because that is a second page wearing the first one's names.
     */
    const bodies = source.split(/\nfunction /);
    for (const id of SECTIONS) {
      const owners = bodies.filter((body) => body.includes(`rs-card ${id}"`));
      expect([id, owners.length]).toEqual([id, 1]);
    }
  });

  it('reads the capabilities the server sent rather than deriving any', async () => {
    const model = await readFile('client/src/russell/cashPage.ts', 'utf8');
    /*
     * The browser holds only a Brain-administrator flag, and administering the
     * sprint, moving its lifecycle and granting commercial authority are all
     * project `ADMIN` — so a client deriving them would hide a control from the
     * project administrator entitled to press it, and offer one where the level
     * was the real question. The server decides, in `services/cash/access.ts`,
     * with the same `decideProjectAccess` every route applies.
     */
    expect(model).not.toMatch(/isBrainAdmin/);
    expect(model).toMatch(/reading\.capabilities \?\? NOTHING/);
  });
});
