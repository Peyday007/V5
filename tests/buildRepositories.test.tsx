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
 *   - a repository that is ready offers no button at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { BuildView } from '../client/src/russell/Build.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];

const PROJECT = 'prj_1';
const GRANT = 'brain-worker-bootstrap';
const REPOSITORIES = `GET /api/projects/${PROJECT}/factory/repositories`;
const ONBOARD = `POST /api/projects/${PROJECT}/factory/repositories/${GRANT}/onboard`;

function grant(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
    calls.push(key);
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
              surfaces: ['V1 factory'],
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
    expect(within(card()).queryByRole('button')).toBeNull();
    expect(within(card()).getByText(/V1 factory/)).toBeTruthy();
  });
});

describe('onboarding, pressed by a person', () => {
  it('issues exactly one invitation and shows it once', async () => {
    base({ [ONBOARD]: { body: ISSUED }, [REPOSITORIES]: { body: { repositories: [grant()] } } });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

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
