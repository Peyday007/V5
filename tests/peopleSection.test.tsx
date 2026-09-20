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
import type { ConnectionView } from '../client/src/lib/peopleApi.ts';

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const PEOPLE = 'GET /api/people';
const CONNECTIONS = 'GET /api/people/connections';

/**
 * One member, mid-journey: connector authorized, no trigger recorded yet.
 *
 * **Annotated `ConnectionView` on purpose.** The previous version of this
 * fixture was a bare object literal, so TypeScript checked nothing about it —
 * and when the server's contract grew, every test here went on passing against
 * a payload the real route can no longer produce, until the component read a
 * field that was not there and crashed at runtime. A fixture the compiler does
 * not check is a fixture that tests itself.
 */
const CONNECTION: ConnectionView = {
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
    invitationRequestedAt: '2026-09-17T12:00:00.000Z',
    invitationIssuedAt: '2026-09-17T12:30:00.000Z',
    revokedAt: null,
    revokedReason: null,
    revokedByUserId: null,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  },
  state: 'CONNECTOR_AUTHORIZED',
  headline: 'Your connector is authorized. Brain needs your Routine’s trigger id.',
  nextAction: 'Create the Routine in Claude and paste its trigger id here.',
  secretPresent: false,
  connectorAuthenticated: true,
  authorizationExpired: false,
  proven: null,
  identity: {
    workerName: 'research-airyn-a1b2c3',
    workerId: 'wkr_1',
    connectorClientName: 'Claude',
    membership: { projectId: 'prj_root', projectName: 'Cash Mode', scopes: ['project:read'] },
    routineName: null,
    accountName: null,
    authorization: {
      live: true,
      everUsed: true,
      lastUsedAt: '2026-09-18T00:30:00.000Z',
      expiresAt: '2026-09-18T01:30:00.000Z',
    },
    lastVerifiedAt: null,
  },
  checks: [
    {
      key: 'IDENTITY',
      title: 'Your worker identity',
      state: 'PASS',
      detail: 'Brain fires as research-airyn-a1b2c3.',
      remedy: null,
    },
    {
      key: 'MEMBERSHIP',
      title: 'What it may reach',
      state: 'PASS',
      detail: 'A member of Cash Mode, carrying project:read.',
      remedy: null,
    },
    {
      key: 'AUTHORIZATION',
      title: 'Your Claude connector',
      state: 'PASS',
      detail: 'A live authorization.',
      remedy: null,
    },
    {
      key: 'TRIGGER',
      title: 'The Routine Brain fires',
      state: 'PENDING',
      detail: 'No trigger id has been recorded.',
      remedy: 'Create the Routine in Claude and paste its trigger id here.',
    },
    {
      key: 'CREDENTIAL',
      title: 'The trigger credential',
      state: 'PENDING',
      detail: 'There is no registered surface for a credential to belong to yet.',
      remedy: null,
    },
    {
      key: 'BINDING',
      title: 'Bound to you',
      state: 'PENDING',
      detail: 'Nothing is registered to be bound yet.',
      remedy: null,
    },
    {
      key: 'PROVEN',
      title: 'Proven by a session Brain fired',
      state: 'PENDING',
      detail: 'Nothing Brain fired has come back yet.',
      remedy: 'Send the bounded self-test.',
    },
  ],
  controls: [
    {
      key: 'REQUEST_INVITATION',
      label: 'Ask for a connector link',
      enabled: false,
      disabledReason: 'You have already asked.',
    },
    { key: 'SUBMIT_TRIGGER', label: 'Record your trigger id', enabled: true, disabledReason: null },
    {
      key: 'SEND_PROBE',
      label: 'Send the self-test',
      enabled: false,
      disabledReason: 'There is no registered surface to test yet.',
    },
    { key: 'VERIFY', label: 'Check this connection', enabled: true, disabledReason: null },
    { key: 'REVOKE', label: 'Take this connection back', enabled: true, disabledReason: null },
    {
      key: 'RECONNECT',
      label: 'Reconnect',
      enabled: false,
      disabledReason: 'This connection has not been taken back, so there is nothing to restore.',
    },
  ],
  troubleshooting: [
    {
      symptom: 'A self-test was sent and nothing came back.',
      meaning: 'Brain fired your Routine and no session arrived.',
      remedy: 'Check the Routine has the bootstrap repository attached.',
    },
  ],
  steps: [
    {
      key: 'INVITATION',
      title: 'Ask for your one-time connector link',
      detail: 'Claude’s approval screen has to know which Brain worker it is connecting.',
      state: 'DONE',
    },
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
      // The three shapes the live Brain actually holds: a device, an
      // outstanding link, and the bootstrap administrator's password account.
      { userId: 'usr_airyn', displayName: 'Airyn', state: 'READY', signsInWith: 'DEVICE', isYou: true, isBrainAdmin: false },
      { userId: 'usr_caleb', displayName: 'Caleb', state: 'INVITED', signsInWith: 'NONE', isYou: false, isBrainAdmin: false },
      { userId: 'usr_root', displayName: 'Owner', state: 'READY', signsInWith: 'PASSWORD', isYou: false, isBrainAdmin: true },
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
  contributed: {
    surfaces: [
      {
        userId: 'usr_airyn',
        displayName: 'Airyn',
        workerName: 'research-airyn-a1b2c3',
        routineId: null,
        routineName: null,
        accountName: null,
        usable: false,
        because: 'No surface is registered for this member yet.',
        routing: null,
      },
    ],
    usable: 0,
    total: 1,
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
    /*
     * `getAllByText`, because a name now legitimately appears twice: once in
     * *who has joined* and once in *what their connection contributes*. Two
     * questions about one person, on one page, and neither is the other.
     */
    expect(screen.getAllByText('Airyn').length).toBeGreaterThan(0);
    expect(screen.getByText('Caleb')).toBeTruthy();
    // Two of three. Never `2 / 4`: four was the intended topology written down
    // as a constant, and it made a working Brain read as half missing.
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(screen.queryByText(/\/ 4/)).toBeNull();
  });

  /**
   * `Joined` is one word about two different facts, and the page says which.
   *
   * The administrator signs in with a password and holds no device, which the
   * reading used to report as a slot nobody had filled. It is `Joined` now —
   * they can sign in — and the row says `password`, because that is the row a
   * lost-device recovery does *not* apply to.
   */
  it('distinguishes a password account from a registered device', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Owner')).toBeTruthy());
    const owner = screen.getByText('Owner').closest('li');
    expect(owner?.textContent).toMatch(/Joined/);
    expect(owner?.textContent).toMatch(/password/);
    /*
     * The row in the *people* list, picked by the state word beside it rather
     * than by the name alone: the name now appears in two lists on this page —
     * who has joined, and what their connection contributes — and the second
     * one carries no sign-in method at all.
     */
    const airyn = screen
      .getAllByText('Airyn')
      .map((node) => node.closest('li'))
      .find((row) => /Joined/.test(row?.textContent ?? ''));
    expect(airyn).toBeTruthy();
    expect(airyn?.textContent).not.toMatch(/password/);
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
    await waitFor(() => expect(screen.getByText('Your Claude connection')).toBeTruthy());
    expect(screen.getByText(/Brain needs your Routine.s trigger id/)).toBeTruthy();
    expect(
      screen.getAllByText(/Create the Routine in Claude and paste its trigger id/).length,
    ).toBeGreaterThan(0);
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

  /**
   * The control that starts somebody else's journey.
   *
   * A member cannot authorize a connector without the one-time link, and the
   * link is a Brain administrator's to issue — so a route with no control is a
   * journey nobody can begin. The route existed and nothing called it, which is
   * this repository's recurring defect and was very nearly shipped here.
   */
  it('offers an administrator the connector link beside each member who has joined', async () => {
    routes[PEOPLE] = {
      body: PAGE({ you: { userId: 'usr_root', isBrainAdmin: true } }),
    };
    routes[CONNECTIONS] = { body: { connections: [] } };
    routes['GET /api/members'] = { body: { links: [] } };
    routes['POST /api/people/usr_airyn/claude/invitation'] = {
      body: {
        ...CONNECTION,
        invitationUrl: 'https://brain.example/oauth/invite/inv_abc.def',
        invitationExpiresAt: '2026-09-20T00:00:00.000Z',
      },
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('People')).toBeTruthy());

    // One per member who can actually sign in, and none for a slot that has not
    // been filled: a connector for somebody who cannot reach Brain is a link
    // nobody can approve.
    const buttons = screen.getAllByRole('button', { name: /claude connector link/i });
    expect(buttons.length).toBe(2);

    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    await waitFor(() =>
      expect(screen.getByText('https://brain.example/oauth/invite/inv_abc.def')).toBeTruthy(),
    );
    expect(calls).toContain('POST /api/people/usr_airyn/claude/invitation');
  });

  it('offers it to nobody who is not an administrator', async () => {
    await mountPeople();
    await waitFor(() => expect(screen.getByText('People')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /claude connector link/i })).toBeNull();
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
  /**
   * Answering a step has to change the page, not only the card.
   *
   * Recording a trigger id registers a surface, so the capacity list underneath
   * is stale the instant it succeeds. §29's own defect, twice recorded: a status
   * that does not agree with the control beside it teaches a person to stop
   * reading it.
   */
  it('re-reads the whole page when a step is answered', async () => {
    routes['POST /api/people/me/claude/trigger'] = {
      body: {
        ...CONNECTION,
        state: 'WAITING_FOR_ADMIN',
        nextAction: null,
        connection: { ...CONNECTION.connection, triggerRef: 'trig_01ABCDEFGHIJKLMNOPQR', routineId: 'rtn_x' },
      },
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByLabelText(/trigger id/i)).toBeTruthy());
    const before = calls.filter((one) => one === PEOPLE).length;
    fireEvent.change(screen.getByLabelText(/trigger id/i), {
      target: { value: 'trig_01ABCDEFGHIJKLMNOPQR' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /record your trigger id/i }));
    });
    await waitFor(() =>
      expect(calls.filter((one) => one === PEOPLE).length).toBeGreaterThan(before),
    );
  });

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
      fireEvent.click(screen.getByRole('button', { name: /record your trigger id/i }));
    });
    expect(bodies['POST /api/people/me/claude/trigger']).toMatchObject({
      triggerRef: 'trig_01ABCDEFGHIJKLMNOPQR',
    });
    // The screen moves to what the server said, rather than to what it guessed.
    await waitFor(() => expect(screen.getByText('Waiting for administrator')).toBeTruthy());
  });

  it('shows a waiting connection as waiting, and disables rather than removes', async () => {
    routes[PEOPLE] = {
      body: PAGE({
        me: {
          ...CONNECTION,
          state: 'WAITING_FOR_ADMIN',
          headline:
            'Everything you can do is done. Brain is waiting for an administrator to add your trigger’s credential to the deployment.',
          nextAction: null,
          connection: { ...CONNECTION.connection, triggerRef: 'trig_01A', routineId: 'rtn_x' },
          controls: CONNECTION.controls.map((one) =>
            one.key === 'SUBMIT_TRIGGER'
              ? {
                  ...one,
                  enabled: false,
                  disabledReason:
                    'A trigger is already recorded. A Brain administrator repoints a registered surface.',
                }
              : one,
          ),
        },
      }),
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Waiting for administrator')).toBeTruthy());
    // §24: a state that says waiting has to name who it is waiting on.
    expect(screen.getByText(/waiting for an administrator/i)).toBeTruthy();
    /*
     * The control a person may not use is **present and disabled with the
     * reason**, never removed. That is what makes two accounts comparable at
     * all — a screen that drops a control has a different shape per reader, and
     * "there is no button" and "the button is not for you yet" are answers a
     * person reads very differently. It used to be removed; this is the
     * correction, asserted rather than described.
     */
    const field = screen.getByLabelText(/trigger id/i) as HTMLInputElement;
    expect(field.disabled).toBe(true);
    expect(screen.getByText(/A Brain administrator repoints a registered surface/)).toBeTruthy();
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
          /*
           * The proof is reported in exactly one place — the PROVEN check —
           * rather than in a footer beside it. Two readers of one fact is how
           * a screen comes to disagree with itself, and this page already had
           * to be corrected for that once.
           */
          checks: CONNECTION.checks.map((one) =>
            one.key === 'PROVEN'
              ? {
                  ...one,
                  state: 'PASS' as const,
                  detail:
                    'Session cse_01X arrived at 2026-09-18T01:00:00.000Z, was handed bin_01Y and finished it.',
                  remedy: null,
                }
              : one,
          ),
          connection: { ...CONNECTION.connection, triggerRef: 'trig_01A', routineId: 'rtn_x' },
        },
      }),
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Connected and verified')).toBeTruthy());
    // Collapsed: a person who has finished sees one line.
    expect(screen.queryByText('Create the Routine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show the steps/i }));
    expect(screen.getByText(/Session cse_01X arrived/)).toBeTruthy();
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
    best: [
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
        tier: {
          tier: 'READY_TO_TEST',
          establishes: 'that somebody asked what it would cost',
          doesNotEstablish: 'that they have agreed a price',
          toAdvance: [],
          answered: 6,
          required: 6,
          summary: 'Everything a bounded test turns on is answered.',
        },
      },
    ],
    bestAreNearlyQualified: false,
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
        /*
         * Names, tasks and counts — and no value of any commercial term, which
         * is why a tier reading may cross to a member at all.
         */
        tier: {
          tier: 'READY_TO_TEST',
          establishes: 'that somebody asked what it would cost',
          doesNotEstablish: 'that they have agreed a price',
          toAdvance: [],
          answered: 6,
          required: 6,
          summary: 'Everything a bounded test turns on is answered.',
        },
      },
    ],
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
    counts: { total: 1, open: 0, beingQualified: 0, claimed: 1, inExecution: 0, delivered: 0, closed: 0 },
    roadmap: {
      mechanisms: ['EXPLICIT_PAID_REQUEST'],
      rounds: { open: 1, harvested: 2, abandoned: 0, total: 3 },
      active: [],
      /*
       * Every status key, because the server always sends every status key. A
       * fixture that sent a partial map would render NaN and test a shape
       * production cannot produce.
       */
      research: {
        planned: 0,
        byStatus: {
          PLANNED: 0,
          QUEUED: 0,
          RUNNING: 0,
          VALIDATING: 0,
          ACCEPTED: 0,
          BLOCKED: 0,
          REJECTED: 0,
          CANCELLED: 0,
          NEEDS_HUMAN: 0,
        },
      },
      pipeline: [{ key: 'DISCOVERED', label: 'Found', count: 1, note: 'an opening nobody has qualified yet' }],
      whatHappensNext: 'The next thing to move is a deep dive.',
    },
    needs: [],
    activity: [{ kind: 'CASH_OPPORTUNITY_HARVESTED', count: 11, mostRecentAt: '2026-09-17T00:00:00.000Z' }],
    /* Nothing may be pressed, including the two reads: there is nothing here to read. */
    capabilities: {
      mayAdminister: false,
      mayGrantAuthority: false,
      mayViewPrivateJob: false,
      mayActOnJob: false,
    },
  };

  async function mountCash(): Promise<void> {
    routes['GET /api/cash/mode'] = { body: MODE };
    routes['GET /api/projects/prj_root/cash'] = { body: SHARED };
    await act(async () => {
      render(<CashSection projectId={null} isBrainAdmin={false} />);
    });
  }

  /*
   * The headings below are the **canonical** ones, and that is the change.
   *
   * These assertions used to name *The frontier*, *Where the research is*,
   * *Opportunities* and *What Brain has been doing* — a second page's
   * vocabulary, which existed only for a member. There is one skeleton now, so
   * a member's substance is asserted under the same headings an administrator
   * sees. Every claim these tests made is still made; what changed is that they
   * no longer document a divergence.
   */
  it('sees the frontier rather than the project-not-found concealment', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('The cash machine')).toBeTruthy());
    // The exact sentence the production defect produced.
    expect(screen.queryByText(/nothing here for you to see/i)).toBeNull();
    expect(screen.getAllByText('Ready to test').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('A paid intake repair somebody asked for').length,
    ).toBeGreaterThan(0);
  });

  it('is told a claimed piece is claimed, and nothing about the job', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('Everything Brain has found')).toBeTruthy());
    /*
     * A taken piece is **redacted rather than hidden** — another member needs
     * to know it is taken, or two of them research the same opening — and gets
     * nothing else about it.
     */
    expect(screen.getAllByText(/Every load-bearing question about this is answered/).length)
      .toBeGreaterThan(0);
    const text = document.body.textContent ?? '';
    // Matched on the shape `money()` renders, which is a currency code and an amount.
    expect(text).not.toMatch(/\b[A-Z]{3}\s?-?[\d,]+\.\d\d/);
    expect(text).not.toMatch(/750/);
  });

  it('shows where the research is, and why nothing is executing', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('Research detail')).toBeTruthy());
    expect(screen.getByText('The next thing to move is a deep dive.')).toBeTruthy();
    // The absent grant is the answer to "why is none of this executing".
    expect(screen.getAllByText(/Nothing is authorized to be spent/).length).toBeGreaterThan(0);
  });

  it('counts activity rather than quoting it', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('Activity')).toBeTruthy());
    expect(screen.getByText(/An opening was harvested/)).toBeTruthy();
    expect(screen.getByText(/11 times/)).toBeTruthy();
    // No free text from any event reaches a member.
    expect(document.body.textContent ?? '').not.toMatch(/Captured "/);
  });

  it('says plainly what it is not showing', async () => {
    await mountCash();
    await waitFor(() => expect(screen.getByText('The cash machine')).toBeTruthy());
    expect(
      screen.getByText(/Decisions about an execution job belong to whoever owns that job/),
    ).toBeTruthy();
    expect(
      screen.getByText(/The money belongs to whoever owns an execution job/),
    ).toBeTruthy();
  });

  it('renders the same section skeleton the administrator page renders', async () => {
    /*
     * The structural half, asserted where the member payload actually is.
     * `cashSection.test.tsx` holds the two trees against each other; this holds
     * the member's tree against the contract, so a change that quietly dropped
     * a section for a member fails in both files rather than in neither.
     */
    await mountCash();
    await waitFor(() => expect(screen.getByText('The cash machine')).toBeTruthy());
    const root = document.querySelector('section.rs-view-cash') as HTMLElement;
    const ids = [...root.children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .filter((node) => node.classList.contains('rs-card'))
      .map((node) => [...node.classList].find((one) => one.startsWith('rs-cash-')));
    expect(ids).toEqual([
      'rs-cash-status',
      'rs-cash-decisions',
      'rs-cash-best',
      'rs-cash-monetization',
      'rs-cash-money-row',
      'rs-cash-portfolio',
      'rs-cash-needs-detail',
      'rs-cash-research',
      'rs-cash-money-detail',
      'rs-cash-history',
      'rs-cash-lifecycle',
    ]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The same component, rendered from two accounts' payloads.
 *
 * The server suite proves the two payloads have the same shape. This proves the
 * screen built from them does — which is the half a contract test cannot see,
 * because a component is free to render a field for one reader and not another.
 *
 * It is a structural snapshot rather than a pixel one: the headings in order,
 * the control labels in order, the step titles in order. Those are what a
 * person compares when two accounts are on a phone call about one setup, and
 * they are what drifts first.
 */
describe('one screen, whoever is reading it', () => {
  function outline(): { headings: string[]; buttons: string[]; steps: string[] } {
    return {
      headings: Array.from(document.querySelectorAll('.rs-claude-connection h3, .rs-claude-connection h4')).map(
        (node) => node.textContent ?? '',
      ),
      buttons: Array.from(document.querySelectorAll('.rs-claude-connection .rs-controls button')).map(
        (node) => node.textContent ?? '',
      ),
      steps: Array.from(document.querySelectorAll('.rs-claude-connection .rs-step .rs-item-title')).map(
        (node) => (node.textContent ?? '').replace(/(Done|Do this now|Waiting for administrator|Later)$/, ''),
      ),
    };
  }

  it('draws the same outline for an administrator and an ordinary member', async () => {
    routes[PEOPLE] = { body: PAGE() };
    routes[CONNECTIONS] = { body: { connections: [] } };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Your Claude connection')).toBeTruthy());
    const asMember = outline();

    cleanup();
    calls = [];
    /*
     * The administrator's payload: the same connection, and the two things the
     * server sends only to an administrator. Neither of them may reach this
     * component, and that is the point of rendering both.
     */
    routes[PEOPLE] = {
      body: PAGE({
        you: { userId: 'usr_root', isBrainAdmin: true },
        me: { ...CONNECTION, connection: { ...CONNECTION.connection, userId: 'usr_root' } },
      }),
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Your Claude connection')).toBeTruthy());
    const asAdmin = outline();

    expect(asAdmin).toEqual(asMember);
    // And it is a real outline rather than an empty one that trivially matches.
    expect(asMember.headings.length).toBeGreaterThan(2);
    expect(asMember.buttons.length).toBe(5);
    expect(asMember.steps.length).toBe(7);
  });

  it('draws every control, and disables rather than removes the ones it cannot use', async () => {
    routes[PEOPLE] = {
      body: PAGE({
        me: {
          ...CONNECTION,
          controls: CONNECTION.controls.map((one) => ({
            ...one,
            enabled: false,
            disabledReason: `not now: ${one.key}`,
          })),
        },
      }),
    };
    await mountPeople();
    await waitFor(() => expect(screen.getByText('Your Claude connection')).toBeTruthy());

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.rs-claude-connection .rs-controls button'),
    );
    // Every one of them still drawn, every one of them disabled, and every one
    // of them carrying the server's reason where a person can actually read it
    // — a `title` only a mouse can reach is no explanation on a phone.
    expect(buttons.length).toBe(5);
    expect(buttons.every((one) => one.disabled)).toBe(true);
    expect(screen.getByText('not now: REVOKE')).toBeTruthy();
    expect(screen.getByText('not now: RECONNECT')).toBeTruthy();
  });

  /**
   * The mechanism, asserted rather than described.
   *
   * Parity is guaranteed by there being nothing in the component that *could*
   * branch on a reader. A comment saying so is a comment; this reads the file.
   * It classifies rather than bans — the module's own documentation says the
   * words — so it looks for the shapes a branch actually takes.
   */
  it('has no way to know who is reading it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // `process.cwd()` rather than `import.meta.url`: this suite runs under
    // jsdom, where the module URL is not a file URL and `readFileSync` refuses
    // it. Vitest's working directory is the repository root.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'client/src/russell/ClaudeConnection.tsx'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['isBrainAdmin', 'isAdmin', 'requireBrainAdmin', 'role']) {
      expect(code, `the canonical connection component reads ${forbidden}`).not.toContain(forbidden);
    }
  });
});
