// @vitest-environment jsdom
/**
 * The Build card, in a browser.
 *
 * A service test proves the route does the right thing when it is called. It
 * cannot prove a person can get there, can tell what is missing, or is told the
 * one thing that decides whether the setup task is worth doing today — and every
 * one of those is a way this feature fails while every server test passes.
 *
 * So this renders the actual card, over the actual `FactoryApi` and the actual
 * `api()` helper, with a scripted `fetch` underneath. What it holds to:
 *
 *   - the three readinesses read as three different situations, not three
 *     colours of the same one;
 *   - the remaining steps are printed **in order**, and the step that is not
 *     Brain's says so;
 *   - work already deferred for this repository is named, with the promise that
 *     matters: it resumes by itself;
 *   - pressing the button once issues exactly one invitation, and pressing it
 *     while it is in flight cannot issue a second;
 *   - the invitation is shown once, is selectable rather than a link, and never
 *     reaches the page for a repository nobody onboarded;
 *   - a refusal is shown as a refusal — the card does not pretend it worked;
 *   - a repository that is ready offers no onboarding decision again — only
 *     "Invite another Factory account", which asks nothing about the repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';
import type { RepositoryOnboarding } from '../client/src/lib/factoryApi.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const PROJECT = 'prj_1';
const GRANT = 'brain-worker-bootstrap';
const REPOSITORIES = `GET /api/projects/${PROJECT}/factory/repositories`;
const ONBOARD = `POST /api/projects/${PROJECT}/factory/repositories/${GRANT}/onboard`;
const INVITATIONS = `GET /api/projects/${PROJECT}/factory/repositories/${GRANT}/invitations`;
const INVITE = `POST /api/projects/${PROJECT}/factory/repositories/${GRANT}/invitations`;

const MEMBERS = [
  { userId: 'usr_friend_a', name: 'Friend A' },
  { userId: 'usr_friend_b', name: 'Friend B' },
];

/**
 * Annotated `RepositoryOnboarding` on purpose.
 *
 * It was `Record<string, unknown>`, so TypeScript checked nothing about it —
 * and when the server's card grew a field, every test here went on passing
 * against a payload the real route can no longer produce, until the component
 * read it and crashed at runtime. A fixture the compiler does not check is a
 * fixture that tests itself.
 */
function grant(over: Partial<RepositoryOnboarding> = {}): RepositoryOnboarding {
  return {
    grantId: GRANT,
    remote: 'https://github.com/Peyday007/brain-worker-bootstrap',
    repositoryId: 'Peyday007/brain-worker-bootstrap',
    description: 'The minimal checkout unattended Routines mount.',
    defaultBranch: 'main',
    mayOpenPullRequest: true,
    workerName: `factory-${GRANT}`,
    workerId: null,
    scopesCorrect: false,
    routedFamilies: [],
    routedRepositories: [],
    surfaces: [],
    accountsServing: 0,
    provenSurfaces: 0,
    contributedSurfaces: [],
    connectorPath: '/mcp/factory',
    boundary: null,
    readiness: 'NOT_ONBOARDED',
    remaining: ['Onboard this repository, which registers a worker for it and issues one invitation.'],
    waiting: 0,
    ...over,
  };
}

const REGISTERED = grant({
  workerId: 'wrk_1',
  scopesCorrect: true,
  routedFamilies: ['FACTORY'],
  routedRepositories: ['Peyday007/brain-worker-bootstrap'],
  readiness: 'AWAITING_SURFACE',
  remaining: [
    'In Claude, add a second connector to this Brain’s /mcp endpoint and open the invitation link first.',
    'In Cowork, create a Routine that uses that connector with the repository attached, then register it.',
  ],
  waiting: 1,
});

const ISSUED = {
  onboarding: REGISTERED,
  invitationUrl: 'https://brain.test/oauth/invite/brnv_a-single-use-token',
  invitationExpiresAt: '2026-09-19T00:00:00.000Z',
  createdIdentity: true,
  repairedScopes: false,
};

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = {
    [REPOSITORIES]: { body: { repositories: [grant()] } },
    [`GET /api/projects/${PROJECT}/factory/campaigns`]: { body: { campaigns: [] } },
    [`GET /api/projects/${PROJECT}/factory/change-requests`]: { body: { changeRequests: [] } },
    [INVITATIONS]: {
      body: {
        grantId: GRANT,
        workerName: `factory-${GRANT}`,
        mayIssue: true,
        refusal: null,
        members: MEMBERS,
        invitations: [],
      },
    },
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  bodies = {};
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
    calls.push(key);
    // What was actually sent, so a test can assert the boundary rather than
    // only that a request happened.
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

async function mount(): Promise<void> {
  await act(async () => {
    render(<BuildView projectId={PROJECT} />);
  });
}

/**
 * Answer the boundary question, which onboarding now refuses to default.
 *
 * Every one of these tests has to do it, which is the property being pinned as
 * much as a setup step: the button does nothing until a person has said what
 * this project may change, because the defect the boundary closes is that the
 * widest possible reach used to be what you got by saying nothing.
 */
async function chooseWholeRepository(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(card()).getByLabelText(/The whole repository/));
  });
}

function card(): HTMLElement {
  return document.querySelector('.rs-factory-repositories') as HTMLElement;
}

describe('the Build card says what is connected and what is missing', () => {
  it('names the repository, its readiness, and the one action that starts it', async () => {
    base();
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    const within_ = within(card());
    expect(within_.getByText('Peyday007/brain-worker-bootstrap')).toBeTruthy();
    expect(within_.getByText('No worker registered')).toBeTruthy();
    expect(within_.getByRole('button', { name: /Onboard this repository/ })).toBeTruthy();
  });

  it('prints the remaining steps in the order they have to happen', async () => {
    base({ [REPOSITORIES]: { body: { repositories: [REGISTERED] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    const steps = [...card().querySelectorAll('.rs-repo-remaining li')].map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(2);
    // The connector comes before the Routine, because the Routine has to use it.
    expect(steps[0]).toMatch(/connector/i);
    expect(steps[1]).toMatch(/Routine/);
  });

  /*
   * The sentence this card exists for. Without it a person doing the setup has
   * no idea whether the work they submitted is lost, and the honest answer —
   * that Brain put it aside and will put it back — is exactly the thing that
   * distinguishes deferring from failing.
   */
  it('says what already resumes, rather than describing setup in the abstract', async () => {
    base({ [REPOSITORIES]: { body: { repositories: [REGISTERED] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    const waiting = card().querySelector('.rs-repo-waiting')?.textContent ?? '';
    expect(waiting).toMatch(/One stage is waiting on this/);
    expect(waiting).toMatch(/resumes by itself/);
    expect(waiting).toMatch(/Nothing has to be submitted again/);
  });

  it('says nothing about waiting work when there is none', async () => {
    base();
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(card().querySelector('.rs-repo-waiting')).toBeNull();
  });

  it('offers no action for a repository that can already execute', async () => {
    base({
      [REPOSITORIES]: {
        body: {
          repositories: [
            grant({
              workerId: 'wrk_1',
              scopesCorrect: true,
              routedFamilies: ['FACTORY'],
              routedRepositories: ['Peyday007/brain-worker-bootstrap'],
              surfaces: [
                { routineName: 'V1 factory', accountName: 'primary', proven: true },
                // A second Routine on the **same** subscription. Two surfaces,
                // one account's allowance, and the card must not add them up.
                { routineName: 'V1 factory spare', accountName: 'primary', proven: false },
              ],
              accountsServing: 1,
              provenSurfaces: 1,
              readiness: 'READY',
              remaining: [],
              waiting: 0,
            }),
          ],
        },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByText('Ready to execute')).toBeTruthy();
    /*
     * No onboarding decision is offered again: not the scope question, and not
     * the re-onboarding button. The one control is inviting another account,
     * which asks nothing about the repository. This used to assert that there
     * was no button at all — which was the defect: once the first account
     * worked, nobody could invite the second.
     */
    expect(within(card()).queryByRole('button', { name: /Onboard|Issue a new invitation/ })).toBeNull();
    expect(within(card()).queryByLabelText(/The whole repository/)).toBeNull();
    await waitFor(() =>
      expect(within(card()).getByRole('button', { name: 'Issue a link' })).toBeTruthy(),
    );

    /*
     * Two surfaces on one subscription, and what the card says about them.
     *
     * The sentence used to be "running on V1 factory, V1 factory spare", which
     * a reader counts as two Claude accounts — §23's distinction collapsed on
     * the screen a person sizes the fleet from. So the number of accounts is
     * stated as a number, the surface count is stated separately when the two
     * differ, and neither is presented as the other.
     */
    const text = card().textContent ?? '';
    expect(text).toContain('1 Claude account');
    expect(text).toContain('across 2 surfaces');
    expect(text).not.toContain('2 Claude accounts');

    // And registered is not proven. One of these two has completed work Brain
    // sent it; the card says which, rather than implying both have.
    expect(text).toContain('1 of 2 have completed work');
    const surfaces = [...card().querySelectorAll('.rs-repo-surfaces li')].map(
      (li) => li.textContent ?? '',
    );
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]).toContain('V1 factory — primary');
    expect(surfaces[0]).not.toContain('not yet proven');
    expect(surfaces[1]).toContain('not yet proven');
    // The runtime defect a compiler cannot catch: an array of objects joined
    // into a sentence renders as this, and every type in the chain is correct.
    expect(text).not.toContain('[object Object]');
  });
});

const READY = grant({
  workerId: 'wrk_1',
  scopesCorrect: true,
  routedFamilies: ['FACTORY'],
  routedRepositories: ['Peyday007/brain-worker-bootstrap'],
  surfaces: [{ routineName: 'Factory Brain A', accountName: 'primary', proven: true }],
  accountsServing: 1,
  provenSurfaces: 1,
  readiness: 'READY',
  remaining: [],
  waiting: 0,
  boundary: { scopeKind: 'WHOLE_REPOSITORY', directories: [], sentence: 'the whole repository' },
});

function issuedFor(n: number, member: (typeof MEMBERS)[number]): unknown {
  return {
    invitation: {
      id: `inv_${n}`,
      kind: 'ADDITIONAL',
      intendedUserId: member.userId,
      intendedName: member.name,
      issuedByName: 'Owner',
      createdAt: '2026-09-24T10:00:00.000Z',
      expiresAt: '2026-10-01T10:00:00.000Z',
      status: 'WAITING',
      endedAt: null,
    },
    invitationUrl: `https://brain.test/oauth/invite/brnv_link-${n}`,
  };
}

describe('inviting another Factory account to a repository that is already ready', () => {
  async function chooseMember(name: string): Promise<void> {
    await waitFor(() => expect(within(card()).getByLabelText('Member this link is for')).toBeTruthy());
    const select = within(card()).getByLabelText('Member this link is for') as HTMLSelectElement;
    const value = MEMBERS.find((one) => one.name === name)!.userId;
    await act(async () => {
      fireEvent.change(select, { target: { value } });
    });
  }

  it('is reachable when READY, and asks only who the link is for', async () => {
    let n = 0;
    base({
      [REPOSITORIES]: { body: { repositories: [READY] } },
      [INVITE]: () => {
        n += 1;
        return { body: issuedFor(n, MEMBERS[n - 1]!) };
      },
    });
    await mount();
    await waitFor(() => expect(within(card()).getByText('Invite another Factory account')).toBeTruthy());
    const button = within(card()).getByRole('button', { name: 'Issue a link' }) as HTMLButtonElement;
    // Nothing is issued until somebody says who it is for.
    expect(button.disabled).toBe(true);

    await chooseMember('Friend A');
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Issue a link' }));
    });
    await waitFor(() => expect(card().textContent).toContain('brnv_link-1'));
    expect(bodies[INVITE]).toEqual({ intendedUserId: 'usr_friend_a' });
    // Onboarding was never called, so no scope was asked or sent.
    expect(calls).not.toContain(ONBOARD);

    // A second link, for somebody else, and the first stays on the screen.
    await chooseMember('Friend B');
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Issue a link' }));
    });
    await waitFor(() => expect(card().textContent).toContain('brnv_link-2'));
    expect(card().textContent).toContain('brnv_link-1');
    expect(bodies[INVITE]).toEqual({ intendedUserId: 'usr_friend_b' });
    expect(within(card()).getAllByRole('button', { name: /Copy link/ })).toHaveLength(2);
    expect(card().textContent).toMatch(/Link for Friend A — shown once, expires/);
  });

  it('copies exactly the link it shows', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: async (text: string) => void written.push(text) },
    });
    base({
      [REPOSITORIES]: { body: { repositories: [READY] } },
      [INVITE]: { body: issuedFor(7, MEMBERS[0]!) },
    });
    await mount();
    await chooseMember('Friend A');
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Issue a link' }));
    });
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Copy link' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Copy link' }));
    });
    expect(written).toEqual(['https://brain.test/oauth/invite/brnv_link-7']);
    expect(within(card()).getByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('lists what was sent without ever showing a link again', async () => {
    base({
      [REPOSITORIES]: { body: { repositories: [READY] } },
      [INVITATIONS]: {
        body: {
          grantId: GRANT,
          workerName: `factory-${GRANT}`,
          mayIssue: true,
          refusal: null,
          members: MEMBERS,
          invitations: [
            { ...(issuedFor(1, MEMBERS[0]!) as { invitation: object }).invitation },
            {
              ...(issuedFor(2, MEMBERS[1]!) as { invitation: object }).invitation,
              status: 'CONNECTED',
              endedAt: '2026-09-24T11:00:00.000Z',
            },
          ],
        },
      },
    });
    await mount();
    await waitFor(() => expect(card().querySelectorAll('.rs-factory-invite-list li')).toHaveLength(2));
    const rows = [...card().querySelectorAll('.rs-factory-invite-list li')].map((li) => li.textContent ?? '');
    expect(rows[0]).toMatch(/Friend A — Waiting to be used — expires/);
    expect(rows[1]).toMatch(/Friend B — Used to connect a Claude account/);
    expect(card().textContent).not.toContain('brnv_');
    // Only a waiting link can be withdrawn.
    expect(within(card()).getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1);
  });
});

describe('the boundary is asked, never defaulted', () => {
  it('will not onboard until a person says what this project may change', async () => {
    base({ [ONBOARD]: { body: ISSUED }, [REPOSITORIES]: { body: { repositories: [grant()] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    /*
     * Neither radio starts selected and the button is disabled while that is
     * true. A pre-selected "whole repository" would be the old `['**']` default
     * wearing a control, which is exactly the thing this closes.
     */
    expect(
      within(card()).getByRole('button', { name: /Onboard this repository/ }),
    ).toHaveProperty('disabled', true);
    expect((within(card()).getByLabelText(/The whole repository/) as HTMLInputElement).checked).toBe(
      false,
    );
    expect((within(card()).getByLabelText(/Only these directories/) as HTMLInputElement).checked).toBe(
      false,
    );

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Onboard this repository/ }));
    });
    expect(calls.filter((c) => c === ONBOARD)).toHaveLength(0);
  });

  it('sends the directories a person typed, as directories rather than patterns', async () => {
    base({ [ONBOARD]: { body: ISSUED }, [REPOSITORIES]: { body: { repositories: [grant()] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await act(async () => {
      fireEvent.click(within(card()).getByLabelText(/Only these directories/));
    });
    await act(async () => {
      fireEvent.change(
        within(card()).getByLabelText(/Directories this project may change/),
        { target: { value: 'sites/v4\nshared/ui' } },
      );
    });
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Onboard this repository/ }));
    });

    expect(bodies[ONBOARD]).toEqual({
      scopeKind: 'DIRECTORIES',
      directories: ['sites/v4', 'shared/ui'],
    });
  });

  it('says what a project may change once it has been told', async () => {
    base({
      [REPOSITORIES]: {
        body: {
          repositories: [
            {
              ...grant(),
              readiness: 'READY',
              surfaces: [{ routineName: 'V1 factory', accountName: 'primary', proven: true }],
              accountsServing: 1,
              provenSurfaces: 1,
              boundary: {
                scopeKind: 'DIRECTORIES',
                directories: ['sites/v4'],
                sentence: 'sites/v4/',
              },
            },
          ],
        },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByText(/sites\/v4\//)).toBeTruthy();
  });
});

describe('onboarding, pressed by a person', () => {
  it('issues exactly one invitation and shows it once', async () => {
    base({ [ONBOARD]: { body: ISSUED }, [REPOSITORIES]: { body: { repositories: [grant()] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await chooseWholeRepository();
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Onboard this repository/ }));
    });

    await waitFor(() => expect(card().querySelector('.rs-repo-issued')).toBeTruthy());
    expect(calls.filter((c) => c === ONBOARD)).toHaveLength(1);

    const issued = card().querySelector('.rs-repo-issued') as HTMLElement;
    expect(issued.textContent).toContain('brnv_a-single-use-token');
    // Selectable, deliberately not a link: opening it in this tab would spend it
    // in the wrong browser.
    expect(issued.querySelector('a')).toBeNull();
    expect(issued.querySelector('.rs-repo-invite code')?.textContent).toBe(ISSUED.invitationUrl);
    // And it says what the invitation is not, because a link that looks like a
    // secret gets treated like one.
    expect(issued.textContent).toMatch(/not a credential/i);
    // The deferred work is named here too, where the person is looking.
    expect(issued.textContent).toMatch(/resumes?\b.*on their own|resumes on their own|resumes/i);
  });

  it('re-reads the list afterwards rather than believing its own optimism', async () => {
    let served = 0;
    base({
      [ONBOARD]: { body: ISSUED },
      [REPOSITORIES]: () => {
        served += 1;
        return { body: { repositories: [served === 1 ? grant() : REGISTERED] } };
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(within(card()).getByText('No worker registered')).toBeTruthy();

    await chooseWholeRepository();
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Onboard this repository/ }));
    });

    // The readiness that appears is the server's second answer, not a guess made
    // from the fact that the POST returned 200.
    await waitFor(() => expect(within(card()).getByText('Registered — waiting for a surface')).toBeTruthy());
    expect(calls.filter((c) => c === REPOSITORIES).length).toBeGreaterThanOrEqual(2);
  });

  /*
   * A double press, and a lost response. Both look the same from here: the
   * button is disabled while a request is in flight, so the second click cannot
   * become a second request — and the server side of it is idempotent by
   * identity anyway, which is what makes a genuine retry safe.
   */
  it('cannot be pressed twice into two requests', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    base({
      [REPOSITORIES]: { body: { repositories: [grant()] } },
      [ONBOARD]: { body: ISSUED },
    });
    const scripted = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
      if (key === ONBOARD) await held;
      return scripted(input, init);
    });

    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    await chooseWholeRepository();
    const button = within(card()).getByRole('button', { name: /Onboard this repository/ });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(within(card()).getByRole('button', { name: /Registering…/ })).toHaveProperty('disabled', true);
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Registering…/ }));
    });

    await act(async () => {
      release?.();
      await held;
    });
    await waitFor(() => expect(card().querySelector('.rs-repo-issued')).toBeTruthy());
    expect(calls.filter((c) => c === ONBOARD)).toHaveLength(1);
  });

  /*
   * The defect this test was written from.
   *
   * Pressing the button reloads the list, and the reload used to count as
   * "loading", which unmounted the whole section — taking the invitation shown
   * once down with it. Every service test passed: the row was written, the
   * invitation was issued, the reply carried the link, and the person never saw
   * it. Nothing but a rendered card could have found it.
   */
  it('keeps the invitation on screen through the reload it triggers', async () => {
    let served = 0;
    base({
      [ONBOARD]: { body: ISSUED },
      [REPOSITORIES]: () => {
        served += 1;
        return { body: { repositories: [served === 1 ? grant() : REGISTERED] } };
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await chooseWholeRepository();
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Onboard this repository/ }));
    });

    // The list moved on, and the link is still there to be copied.
    await waitFor(() => expect(within(card()).getByText('Registered — waiting for a surface')).toBeTruthy());
    expect(card().querySelector('.rs-repo-invite code')?.textContent).toBe(ISSUED.invitationUrl);
  });

  it('shows a refusal as a refusal, and issues nothing', async () => {
    base({
      [ONBOARD]: { status: 404, body: { error: 'No project with that id.' } },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await chooseWholeRepository();
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Onboard this repository/ }));
    });

    await waitFor(() => expect(card().querySelector('.rs-state-error')).toBeTruthy());
    expect(card().querySelector('.rs-repo-issued')).toBeNull();
    // The button comes back, because a refusal a person can do nothing about is
    // worse than one they can retry.
    expect(within(card()).getByRole('button', { name: /Onboard this repository/ })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('never puts an invitation on the page for a repository nobody onboarded', async () => {
    base({ [REPOSITORIES]: { body: { repositories: [REGISTERED] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(document.body.textContent ?? '').not.toMatch(/brnv_/);
  });
});
