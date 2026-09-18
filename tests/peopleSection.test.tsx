// @vitest-environment jsdom
/**
 * People & Capacity in a browser, and the shared frontier beside it.
 *
 * Two screens that a server test cannot see, and both of them are where the
 * production defects were *visible*:
 *
 *   * an ordinary member reading the shared Cash frontier rather than the
 *     project-not-found concealment, with no money, no grant and no commercial
 *     term on the page;
 *   * a member's own Claude setup, resumable at whatever step they reached,
 *     with every pasted value in its own box.
 *
 * Nothing here derives a count or composes a sentence about a state: every
 * number and every word on these screens is the server's, so the fixtures are
 * server-shaped payloads and the assertions are about what a person sees.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleAndCapacityView } from '../client/src/russell/People.tsx';
import { CashSection } from '../client/src/russell/Cash.tsx';

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const PEOPLE = 'GET /api/people';
const CONNECTIONS = 'GET /api/people/connections';

/** One member, mid-journey: connector authorized, no trigger recorded yet. */
const CONNECTION = {
  connection: {
    id: 'cxn_1',
    userId: 'usr_airyn',
    connectorName: 'Brain (Airyn)',
    routineName: 'Brain Research — Airyn',
    secretName: 'BRAIN_ROUTINE_TOKEN_AIRYN_A1B2C3',
    triggerRef: null,
    accountId: null,
    routineId: null,
    state: 'CONNECTOR_AUTHORIZED',
    failureReason: null,
    probeBinId: null,
    probeSentAt: null,
    healthyAt: null,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  },
  state: 'CONNECTOR_AUTHORIZED',
  headline: 'Your connector is authorized. Brain needs your Routine’s trigger id.',
  nextAction: 'Create the Routine in Claude and paste its trigger id here.',
  secretPresent: false,
  connectorAuthenticated: true,
  proven: null,
  steps: [
    {
      key: 'CONNECTOR',
      title: 'Add Brain as a custom connector in Claude',
      detail: 'In Claude, open Settings → Connectors → Add custom connector.',
      copy: [
        { label: 'Connector name', value: 'Brain (Airyn)' },
        { label: 'MCP URL', value: 'https://brain.example/mcp' },
      ],
      state: 'DONE',
    },
    {
      key: 'ROUTINE',
      title: 'Create the Routine',
      detail: 'Attach the bootstrap repository, enable the connector, leave scheduling off.',
      copy: [
        { label: 'Routine name', value: 'Brain Research — Airyn' },
        { label: 'Repository to attach', value: 'brain-worker-bootstrap' },
        { label: 'Connector to enable', value: 'Brain (Airyn)' },
        { label: 'Schedule', value: 'off — no cron' },
      ],
      state: 'NOW',
    },
    {
      key: 'TRIGGER',
      title: 'Paste the trigger id here',
      detail: 'The trigger id is an address rather than a secret.',
      state: 'NOW',
    },
    {
      key: 'SECRET',
      title: 'A Brain administrator adds the trigger credential',
      detail: 'It goes into the deployment environment rather than into Brain’s database.',
      copy: [{ label: 'Secret name to set', value: 'BRAIN_ROUTINE_TOKEN_AIRYN_A1B2C3' }],
      state: 'LATER',
    },
    {
      key: 'PROBE',
      title: 'Brain sends one bounded self-test',
      detail: 'A single deterministic check.',
      state: 'LATER',
    },
    { key: 'HEALTHY', title: 'Healthy', detail: 'A session arrived and finished work.', state: 'LATER' },
  ],
};

const PAGE = (over: Record<string, unknown> = {}): unknown => ({
  you: { userId: 'usr_airyn', isBrainAdmin: false },
  people: {
    rows: [
      { userId: 'usr_airyn', displayName: 'Airyn', state: 'READY', isYou: true, isBrainAdmin: false },
      { userId: 'usr_caleb', displayName: 'Caleb', state: 'INVITED', isYou: false, isBrainAdmin: false },
      { userId: 'usr_root', displayName: 'Owner', state: 'READY', isYou: false, isBrainAdmin: true },
    ],
    joined: 2,
    invited: 1,
  },
  capacity: {
    eligibleNow: 4,
    proven: 4,
    waiting: 1,
    unavailable: 0,
    target: null,
    surfaces: [
      { routineId: 'rtn_a', name: 'Brain Research A', accountId: 'acc_1', accountName: 'Brain Research A', health: 'HEALTHY' },
      { routineId: 'rtn_b', name: 'Brain Research 1-B', accountId: 'acc_1', accountName: 'Brain Research A', health: 'HEALTHY' },
      { routineId: 'rtn_c', name: 'Brain Research 1-C', accountId: 'acc_1', accountName: 'Brain Research A', health: 'HEALTHY' },
      { routineId: 'rtn_d', name: 'Brain Research 1-D', accountId: 'acc_1', accountName: 'Brain Research A', health: 'HEALTHY' },
      {
        routineId: 'rtn_new',
        name: 'Brain Research — Caleb',
        accountId: 'acc_2',
        accountName: 'member-caleb',
        health: 'WAITING',
        because: 'its trigger credential is not in this deployment yet.',
      },
    ],
    historical: [
      {
        routineId: 'rtn_oak',
        name: 'V1-oak',
        accountId: 'acc_1',
        accountName: 'Brain Research A',
        health: 'UNAVAILABLE',
        because: 'oakwood factory proof complete surface out of active dispatch',
      },
    ],
  },
  me: CONNECTION,
  contract: { mcpUrl: 'https://brain.example/mcp', bootstrapRepository: 'brain-worker-bootstrap' },
  ...over,
});

beforeEach(() => {
  calls = [];
  bodies = {};
  routes = { [PEOPLE]: { body: PAGE() } };
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

async function mountPeople(): Promise<void> {
  await act(async () => {
    render(<PeopleAndCapacityView />);
  });
}

/* -------------------------------------------------------------------------- */

describe('the default view answers four questions', () => {
  it('says who has joined, without inventing a denominator', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('People')).toBeTruthy());
    expect(screen.getByText('Airyn')).toBeTruthy();
    expect(screen.getByText('Caleb')).toBeTruthy();
    // Two of three. Never `2 / 4`: four was the intended topology written down
    // as a constant, and it made a working Brain read as half missing.
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.queryByText(/\/ 4/)).toBeNull();
  });

  it('says how much capacity can be fired, and labels the readings apart', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Brain research capacity')).toBeTruthy());
    expect(screen.getByText('Surfaces Brain can fire right now')).toBeTruthy();
    expect(screen.getByText('Proven by a completed session')).toBeTruthy();
    expect(screen.getByText('Waiting on something an administrator does')).toBeTruthy();
    // Five surfaces under two accounts, counted as surfaces. The old reading
    // counted accounts and said `1 / 4`.
    expect(screen.getByText('Brain Research 1-B')).toBeTruthy();
    expect(screen.getByText('Brain Research 1-D')).toBeTruthy();
  });

  it('says what my Claude connection is waiting for, in the server’s words', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('My Claude connection')).toBeTruthy());
    expect(screen.getByText(/Brain needs your Routine.s trigger id/)).toBeTruthy();
    expect(screen.getByText(/Create the Routine in Claude and paste its trigger id/)).toBeTruthy();
  });

  it('keeps retired surfaces collapsed rather than deleted', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Brain research capacity')).toBeTruthy());
    expect(screen.queryByText('V1-oak')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retired surfaces \(1\)/i }));
    expect(screen.getByText('V1-oak')).toBeTruthy();
    expect(screen.getByText(/oakwood factory proof complete/)).toBeTruthy();
  });

  it('offers no administration to somebody who is not an administrator', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('People')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /invite somebody/i })).toBeNull();
    expect(screen.queryByText('Diagnostics')).toBeNull();
    // And it does not ask for the administrator's list either.
    expect(calls).not.toContain(CONNECTIONS);
  });

  it('opens the administrator’s controls for an administrator, collapsed', async () => {
    routes[PEOPLE] = {
      body: PAGE({
        you: { userId: 'usr_root', isBrainAdmin: true },
        people: {
          ...(PAGE() as { people: Record<string, unknown> }).people,
          excluded: { systemIdentities: 2, disabledAccounts: 0 },
        },
      }),
    };
    routes[CONNECTIONS] = { body: { connections: [] } };
    routes['GET /api/members'] = { body: { links: [] } };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Diagnostics')).toBeTruthy());
    // Collapsed. §29's progressive disclosure: short status cards first.
    expect(screen.getByRole('button', { name: /connections \(0\)/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /invite somebody/i })).toBeTruthy();
    // And says what the member list deliberately left out, rather than dropping
    // it silently.
    expect(screen.getByText(/2 system identities are deliberately not counted/)).toBeTruthy();
  });
});

describe('every pasted value is its own box', () => {
  it('gives each one a label, the literal value and a copy button', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Create the Routine')).toBeTruthy());
    for (const value of [
      'Brain (Airyn)',
      'https://brain.example/mcp',
      'Brain Research — Airyn',
      'brain-worker-bootstrap',
      'off — no cron',
    ]) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    // One copy button per value rather than one for the card.
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThanOrEqual(6);
  });

  it('shows the secret’s name and never asks for its value', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Create the Routine')).toBeTruthy());
    expect(screen.getByText('BRAIN_ROUTINE_TOKEN_AIRYN_A1B2C3')).toBeTruthy();
    // No field anywhere that would take a credential.
    expect(screen.queryByLabelText(/credential|token|bearer|secret value/i)).toBeNull();
    expect(screen.getByText(/never the credential printed next to it/i)).toBeTruthy();
  });
});

describe('the journey resumes where it was', () => {
  it('asks for a trigger id when that is the step, and posts it', async () => {
    routes['POST /api/people/me/claude/trigger'] = {
      body: {
        ...CONNECTION,
        state: 'WAITING_FOR_ADMIN',
        headline: 'Everything you can do is done.',
        nextAction: null,
        connection: { ...CONNECTION.connection, triggerRef: 'trig_01ABCDEFGHIJKLMNOPQR', routineId: 'rtn_x' },
      },
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByLabelText(/trigger id/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/trigger id/i), {
      target: { value: 'trig_01ABCDEFGHIJKLMNOPQR' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record this trigger/i }));
    });
    expect(bodies['POST /api/people/me/claude/trigger']).toMatchObject({
      triggerRef: 'trig_01ABCDEFGHIJKLMNOPQR',
    });
    // The screen moves to what the server said, rather than to what it guessed.
    await waitFor(() => expect(screen.getByText('Waiting for administrator')).toBeTruthy());
  });

  it('shows a waiting connection as waiting, with no control it cannot use', async () => {
    routes[PEOPLE] = {
      body: PAGE({
        me: {
          ...CONNECTION,
          state: 'WAITING_FOR_ADMIN',
          headline:
            'Everything you can do is done. Brain is waiting for an administrator to add your trigger’s credential to the deployment.',
          nextAction: null,
          connection: { ...CONNECTION.connection, triggerRef: 'trig_01A', routineId: 'rtn_x' },
        },
      }),
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Waiting for administrator')).toBeTruthy());
    // §24: a state that says waiting has to name who it is waiting on.
    expect(screen.getByText(/waiting for an administrator/i)).toBeTruthy();
    expect(screen.queryByLabelText(/trigger id/i)).toBeNull();
  });

  it('folds itself away once it is proven, and says what proved it', async () => {
    routes[PEOPLE] = {
      body: PAGE({
        me: {
          ...CONNECTION,
          state: 'HEALTHY',
          headline: 'Connected and proven.',
          nextAction: null,
          secretPresent: true,
          proven: { sessionRef: 'cse_01X', binId: 'bin_01Y', observedAt: '2026-09-18T01:00:00.000Z' },
          connection: { ...CONNECTION.connection, triggerRef: 'trig_01A', routineId: 'rtn_x' },
        },
      }),
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Healthy')).toBeTruthy());
    // Collapsed: a person who has finished sees one line.
    expect(screen.queryByText('Create the Routine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show the steps/i }));
    expect(screen.getByText(/session cse_01X arrived/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */

describe('an ordinary member reading the shared frontier', () => {
  const MODE = {
    root: { projectId: 'prj_root', projectName: 'Cash Mode' },
    mode: {
      projectId: 'prj_root',
      state: 'ACTIVE',
      currency: 'USD',
      activatedAt: '2026-09-15T00:00:00.000Z',
      objective: 'The canonical mandate.',
    },
    objective: { summary: 'Find and validate lawful ways to produce usable cash quickly.', full: 'In full.' },
    currencies: ['USD'],
  };

  const SHARED = {
    scope: 'SHARED',
    mode: MODE.mode,
    discovery: { open: true, reason: 'Cash Mode is active.' },
    commercialGrant: 'ABSENT',
    opportunities: [
      {
        id: 'cop_1',
        title: 'A paid intake repair somebody asked for',
        mechanism: 'EXPLICIT_PAID_REQUEST',
        industry: null,
        state: 'READY',
        availability: 'CLAIMED',
        because: 'Every load-bearing question about this is answered.',
        validationState: null,
        buyingSignal: 'Asked what it would cost',
        signalObservedAt: '2026-09-14T09:00:00.000Z',
        sourceClaimId: 'clm_1',
        orchestrationId: null,
        fragmentId: null,
        discoveryRoundId: null,
        expiresAt: null,
        deadline: null,
        qualification: { ready: true, missing: [], summary: 'Every load-bearing field is answered.' },
      },
    ],
    counts: { total: 1, open: 0, beingQualified: 0, claimed: 1, inExecution: 0, delivered: 0, closed: 0 },
    roadmap: {
      mechanisms: ['EXPLICIT_PAID_REQUEST'],
      rounds: { open: 1, harvested: 2, abandoned: 0, total: 3 },
      active: [],
      research: { planned: 0, byStatus: {} },
      pipeline: [{ key: 'DISCOVERED', label: 'Found', count: 1, note: 'an opening nobody has qualified yet' }],
      whatHappensNext: 'The next thing to move is a deep dive.',
    },
    needs: [],
    activity: [{ kind: 'CASH_OPPORTUNITY_HARVESTED', count: 11, mostRecentAt: '2026-09-17T00:00:00.000Z' }],
  };

  async function mountCash(): Promise<void> {
    routes['GET /api/cash/mode'] = { body: MODE };
    routes['GET /api/projects/prj_root/cash'] = { body: SHARED };
    await act(async () => {
      render(<CashSection projectId={null} isBrainAdmin={false} />);
    });
  }

  it('sees the frontier rather than the project-not-found concealment', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('The frontier')).toBeTruthy());
    // The exact sentence the production defect produced.
    expect(screen.queryByText(/nothing here for you to see/i)).toBeNull();
    expect(screen.getByText('Opportunities found')).toBeTruthy();
    expect(screen.getByText('A paid intake repair somebody asked for')).toBeTruthy();
  });

  it('is told a claimed piece is claimed, and nothing about the job', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('Opportunities')).toBeTruthy());
    expect(screen.getByText('Claimed')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/750/);
  });

  it('shows where the research is, and why nothing is executing', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('Where the research is')).toBeTruthy());
    expect(screen.getByText('The next thing to move is a deep dive.')).toBeTruthy();
    expect(screen.getByText(/No commercial grant has been made yet/)).toBeTruthy();
  });

  it('counts activity rather than quoting it', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('What Brain has been doing')).toBeTruthy());
    expect(screen.getByText('opportunity harvested')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
  });

  it('says plainly what it is not showing', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('The frontier')).toBeTruthy());
    expect(
      screen.getByText(/The money, the spending authority and each execution job/),
    ).toBeTruthy();
  });
});
