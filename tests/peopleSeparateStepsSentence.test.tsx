// @vitest-environment jsdom
/**
 * People & capacity says that joining and contributing are separate steps.
 * One sentence, asserted as what a person sees on the screen. The fixture is
 * the server-shaped payload `peopleSection.test.tsx` uses, typed the same way.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PeopleAndCapacityView } from '../client/src/russell/People.tsx';
import type { ConnectionView, PersonRow } from '../client/src/lib/peopleApi.ts';
import { CONNECTION_SCOPE } from '../server/domain/connectionScope.ts';

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
    workerId: null,
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
  scope: CONNECTION_SCOPE,
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

const ROWS: PersonRow[] = [
  {
    userId: 'usr_nadia',
    displayName: 'Nadia',
    state: 'READY',
    signsInWith: 'PIN',
    isYou: true,
    isBrainAdmin: false,
  },
  {
    userId: 'usr_caleb',
    displayName: 'Caleb',
    state: 'INVITED',
    signsInWith: 'NONE',
    isYou: false,
    isBrainAdmin: false,
  },
  {
    userId: 'usr_root',
    displayName: 'Owner',
    state: 'READY',
    signsInWith: 'PASSWORD',
    isYou: false,
    isBrainAdmin: true,
  },
  {
    userId: 'usr_airyn',
    displayName: 'Airyn',
    state: 'NEEDS_A_NEW_LINK',
    signsInWith: 'DEVICE',
    isYou: false,
    isBrainAdmin: false,
  },
];

const PAGE = (over: Record<string, unknown> = {}): unknown => ({
  you: { userId: 'usr_nadia', isBrainAdmin: false },
  people: {
    /*
     * Typed, because it was not and that is how it went stale.
     *
     * These rows were literals inside an `unknown` fixture, so when the server
     * gained a credential and a state the compiler had nothing to check them
     * against: `Airyn` went on claiming READY over a device, which is a shape
     * the server can no longer produce. §35 records the same lesson about the
     * connection payload beside this one — a fixture the compiler does not
     * check is a fixture that tests itself.
     */
    rows: ROWS,
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
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    statusText: '',
    text: async () => JSON.stringify(PAGE()),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows that joining and contributing capacity are separate steps', async () => {
  await act(async () => {
    render(<PeopleAndCapacityView />);
  });
  await waitFor(() =>
    expect(
      screen.getByText('Joining this Brain and contributing capacity are separate steps.'),
    ).toBeTruthy(),
  );
});
