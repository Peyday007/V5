// @vitest-environment jsdom
/**
 * A change asked for in a conversation, decided in that conversation.
 *
 * Drives the real `Conversation` against a scripted server and reads the
 * screen, because the defects this pins were invisible to every server test:
 *
 * 1. The thread showed a proposed change and **no way to authorize it** — the
 *    button lived on a different page. And the button that existed posted no
 *    acceptance conditions, which the server correctly refuses; so it always
 *    failed. The card here shows "Done means" as a proposal the person can edit,
 *    and posts exactly what is on the screen.
 * 2. After the pull request, the thread said "Review the pull request" and
 *    nothing about what merging would release. The release card lists the
 *    files, the head commit and whether it is the one Brain reviewed, the
 *    review verdict and the checks — and says plainly that merging is the
 *    release and Brain does not merge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Conversation } from '../client/src/russell/Conversation.tsx';
import type { SoftwareRequestView } from '../server/services/russell/software.ts';
import type { SoftwareRepositoryChoice } from '../server/services/russell/software.ts';

const CONVERSATION = 'rcv_1';
const THREAD = `GET /api/russell/conversations/${CONVERSATION}`;
const AUTHORIZE = 'POST /api/russell/software/rsw_1/authorize';
const REFUSE = 'POST /api/russell/software/rsw_1/refuse-release';

let routes: Record<string, unknown> = {};
let bodies: Record<string, unknown> = {};

const REQUEST: SoftwareRequestView['request'] = {
  id: 'rsw_1',
  projectId: 'prj_1',
  conversationId: CONVERSATION,
  messageId: 'rms_1',
  title: 'Name the project on the card',
  objective: 'Change the conversation card so it names the project a change is for.',
  expectedOutcome: 'The card says which project a change belongs to.',
  grantId: null,
  repositoryId: null,
  baseBranch: null,
  requestedScope: null,
  submissionKey: 'k',
  state: 'PROPOSED',
  changeRequestId: null,
  campaignId: null,
  authorizedByUserId: null,
  declineReason: null,
  acceptanceConditions: [{ statement: 'The card heading names the project.', verification: 'npm test' }],
  liveCheck: { path: '/', contains: 'Changes to Brain' },
  deliveryPolledAt: null,
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
};

const REPOSITORY: SoftwareRepositoryChoice = {
  grantId: 'brain',
  repositoryId: 'peyday007/v5',
  remote: 'https://github.com/Peyday007/V5',
  description: 'Brain itself.',
  defaultBranch: 'production',
  scope: ['**'],
  scopeSentence: 'The whole of peyday007/v5, except what the grant forbids.',
};

function thread(over: Record<string, unknown> = {}): unknown {
  return {
    conversation: {
      id: CONVERSATION,
      ownerUserId: 'usr_1',
      title: 'Brain',
      visibility: 'SHARED',
      projectId: 'prj_1',
      attachmentSource: 'PERSON',
      collectionId: null,
      collectionSource: null,
      legacyConversationId: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
    turns: [],
    software: [],
    clarification: null,
    repositories: [],
    ...over,
  };
}

beforeEach(() => {
  bodies = {};
  routes = { [THREAD]: thread() };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body) as unknown;
    const body = routes[key];
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a proposed change is decided where it was asked for', () => {
  it('shows what done means as an editable proposal, and authorizes with what is on the screen', async () => {
    const proposed: SoftwareRequestView = {
      request: REQUEST,
      campaign: null,
      pullRequestUrl: null,
      line: 'Waiting for you to authorize it. Nothing has been spent.',
      awaitingPerson: true,
      delivery: null,
    };
    routes[THREAD] = thread({ software: [proposed], repositories: [REPOSITORY] });
    routes[AUTHORIZE] = { ok: true, campaignId: 'fcp_1' };
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);

    const statement = (await screen.findByDisplayValue('The card heading names the project.')) as HTMLTextAreaElement;
    expect(screen.getByText(/serves “Changes to Brain”|serves\s+“Changes to Brain”/)).toBeTruthy();
    expect(screen.getByText(/The whole of peyday007\/v5/)).toBeTruthy();

    fireEvent.change(statement, { target: { value: 'The card heading names Brain.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    });
    expect(bodies[AUTHORIZE]).toEqual({
      grantId: 'brain',
      acceptanceConditions: [{ statement: 'The card heading names Brain.', verification: 'npm test' }],
    });
  });

  it('will not authorize with nothing that says what done is', async () => {
    const proposed: SoftwareRequestView = {
      request: REQUEST,
      campaign: null,
      pullRequestUrl: null,
      line: 'Waiting for you to authorize it.',
      awaitingPerson: true,
      delivery: null,
    };
    routes[THREAD] = thread({ software: [proposed], repositories: [REPOSITORY] });
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);
    const statement = await screen.findByDisplayValue('The card heading names the project.');
    fireEvent.change(statement, { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Authorize' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the release decision, in the thread', () => {
  const ready: SoftwareRequestView = {
    request: { ...REQUEST, state: 'AUTHORIZED', campaignId: 'fcp_1', grantId: 'brain' },
    campaign: null,
    pullRequestUrl: 'https://github.com/Peyday007/V5/pull/40',
    line: 'Built, reviewed and ready: the release decision is yours.',
    awaitingPerson: true,
    delivery: {
      phase: 'AWAITING_RELEASE',
      releaseDecisionWaiting: true,
      latestChecks: null,
      timeline: [
        { kind: 'RELEASE_READY', at: '2026-09-23T10:00:00.000Z', text: 'Ready for your release decision.', byPerson: false },
      ],
      release: {
        pullRequest: {
          number: 40,
          url: 'https://github.com/Peyday007/V5/pull/40',
          title: 'Name the project',
          baseRef: 'production',
          headRef: 'factory/campaign/fcp_1',
        },
        headSha: 'a'.repeat(40),
        headIsIntegration: true,
        files: [{ path: 'client/src/russell/Conversation.tsx', status: 'modified', additions: 3, deletions: 1 }],
        filesTotal: 1,
        filesTruncated: false,
        additions: 3,
        deletions: 1,
        checks: { state: 'PASSED', total: 2, failed: [] },
        review: { verdict: 'PASS', independence: 'SESSION_SEPARATED', round: 1, summary: 'ok' },
        openFindings: 0,
        unitsIntegrated: 1,
        acceptanceConditions: [{ statement: 'The card heading names the project.', verification: 'npm test' }],
        liveCheck: { path: '/', contains: 'Changes to Brain' },
        releasesBrain: true,
      },
    },
  };

  it('shows exactly what merging would release, and who does the merging', async () => {
    routes[THREAD] = thread({ software: [ready] });
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);
    await screen.findByText('What merging would release');
    expect(screen.getByText('client/src/russell/Conversation.tsx')).toBeTruthy();
    expect(screen.getByText(/the exact commit Brain integrated and had reviewed/)).toBeTruthy();
    expect(screen.getByText(/PASS \(SESSION_SEPARATED, round 1\)/)).toBeTruthy();
    expect(screen.getByText(/All 2 passed/)).toBeTruthy();
    expect(screen.getByText(/Brain does not merge/)).toBeTruthy();
    const merge = screen.getByRole('link', { name: /Review and merge on GitHub to release/ });
    expect(merge.getAttribute('href')).toBe('https://github.com/Peyday007/V5/pull/40');
  });

  it('records a refusal with its reason', async () => {
    routes[THREAD] = thread({ software: [ready] });
    routes[REFUSE] = { ok: true };
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refuse this release…' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not this week.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refuse this release' }));
    });
    await waitFor(() => expect(bodies[REFUSE]).toEqual({ reason: 'Not this week.' }));
  });
});
