// @vitest-environment jsdom
/**
 * The card a person authorizes a change to their own code on, driven rather
 * than described.
 *
 * `russellSoftwareJourney` proves the server: the gate, the boundary, the
 * compare-and-swap, the refusals. None of that is worth anything if the control
 * a person actually presses is absent, disabled, or shows a reach that is not
 * the reach the validator will enforce — and every one of those is invisible to
 * a service test. §27 records the shape exactly: the invitation card's server
 * tests all passed while the person would never have seen the invitation,
 * because pressing the button unmounted the section that held it.
 *
 * So this renders the real `NeedsYouView` against a scripted server and presses
 * things. Three properties it exists for:
 *
 * **The reach is on the card, in the server's words.** `scopeSentence` travels
 * down with the repository choice rather than being composed in the browser, so
 * what a person is shown and what `resolveProjectScope` enforces are one object.
 * A screen that paraphrased a permission would eventually paraphrase it wrongly.
 *
 * **A request nobody can authorize says so.** A project with no onboarded
 * repository has nowhere to run the work, and offering a button that will always
 * refuse is §24's stuck-not-waiting defect wearing a control.
 *
 * **The settled state counts all three kinds of decision.** An unauthorized
 * software change is a decision, and a page saying "nothing needs your decision"
 * above one is the contradiction §29 has now recorded at the briefing, the badge
 * and this panel.
 *
 * Width is asserted where jsdom can actually decide it — the card declares no
 * fixed width and no `min-width`, so it reflows with the container `.rs-main`
 * already establishes. jsdom does not lay out, and a screenshot is what proves
 * the pixels; `scripts/visual-qa.ts` takes those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { NeedsYouView } from '../client/src/russell/Views.tsx';

const PROJECT = 'prj_1';
const NEEDS_YOU = `GET /api/russell/projects/${PROJECT}/needs-you`;
const AUTHORITY = `GET /api/russell/projects/${PROJECT}/authority`;
const AUTHORIZE = 'POST /api/russell/software/rsw_1/authorize';
const DECLINE = 'POST /api/russell/software/rsw_1/decline';

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

/** One repository the project was given, with the directory boundary on it. */
function repository(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grantId: 'sites-monorepo',
    repositoryId: 'peyday007/sites',
    remote: 'https://github.com/Peyday007/sites',
    defaultBranch: 'main',
    description: 'The sites monorepo.',
    scope: ['sites/v4/**'],
    scopeSentence: 'Only sites/v4/ in peyday007/sites.',
    ...over,
  };
}

/** A change waiting for a person, in the shape the projection returns. */
function waiting(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: {
      id: 'rsw_1',
      projectId: PROJECT,
      conversationId: 'rcv_1',
      messageId: 'rms_1',
      title: 'Live total on checkout',
      objective: 'Change the checkout page so the total updates without a reload.',
      expectedOutcome: 'Changing quantity updates the total in place.',
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
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    },
    campaign: null,
    pullRequestUrl: null,
    line: 'Waiting for you to authorize it. Nothing has been spent.',
    awaitingPerson: true,
    ...over,
  };
}

/**
 * A grant already given, so the standing approval is not the outstanding thing.
 *
 * The full shape rather than a convenient subset: `AuthorityPanel` renders
 * `grantedAt` and the permit sentences directly, and a fixture that omitted
 * them would fail for a reason that has nothing to do with this card.
 */
const GRANTED = {
  grant: {
    id: 'rgl_1',
    name: 'Research Deal Dispatch',
    grantedBy: 'An owner',
    grantedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    expired: false,
    permits: ['Russell may research this project.'],
    neverPermits: ['Spend money.'],
    spend: {},
  },
  history: [],
  headline: 'Russell may research this project.',
  limits: [],
  counters: [],
  proposal: null,
};

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = {
    [NEEDS_YOU]: { body: { requests: [], software: [], repositories: [] } },
    [AUTHORITY]: { body: GRANTED },
    ...over,
  };
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

async function mount(): Promise<void> {
  await act(async () => {
    render(<NeedsYouView projectId={PROJECT} />);
  });
}

function card(): HTMLElement {
  const found = document.querySelector('.rs-decision-software');
  if (!found) throw new Error('no software decision card is on the page');
  return found as HTMLElement;
}

describe('the authorization card renders and operates', () => {
  it('shows what was asked, in the person’s own terms', async () => {
    base({
      [NEEDS_YOU]: {
        body: { requests: [], software: [waiting()], repositories: [repository()] },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    expect(within(card()).getByText('Live total on checkout')).toBeTruthy();
    expect(within(card()).getByText(/total updates without a reload/)).toBeTruthy();
    expect(within(card()).getByText(/Changing quantity updates the total in place/)).toBeTruthy();
    expect(within(card()).getByText(/Waiting for you/)).toBeTruthy();
  });

  it('names the reach in the server’s own sentence, above the button that grants it', async () => {
    base({
      [NEEDS_YOU]: {
        body: { requests: [], software: [waiting()], repositories: [repository()] },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    const scope = card().querySelector('.rs-software-scope');
    expect(scope?.textContent).toContain('Only sites/v4/ in peyday007/sites.');
    // And the two things a person is owed beside a reach: what happens to work
    // outside it, and that nothing is merged or deployed for them.
    expect(scope?.textContent).toMatch(/rejected whole/i);
    expect(scope?.textContent).toMatch(/nothing is merged or deployed without you/i);
  });

  it('authorizes with the repository the project was given, and re-reads', async () => {
    base({
      [NEEDS_YOU]: {
        body: { requests: [], software: [waiting()], repositories: [repository()] },
      },
      [AUTHORIZE]: { body: { ok: true, campaignId: 'fcp_1', scope: ['sites/v4/**'] } },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Authorize/ }));
    });

    expect(bodies[AUTHORIZE]).toEqual({ grantId: 'sites-monorepo' });
    // No optimistic update: the list re-reads, so what a person sees afterwards
    // is what the server did rather than what was asked for.
    expect(calls.filter((c) => c === NEEDS_YOU).length).toBeGreaterThan(1);
  });

  it('makes the person choose when the project has more than one repository', async () => {
    base({
      [NEEDS_YOU]: {
        body: {
          requests: [],
          software: [waiting()],
          repositories: [
            repository(),
            repository({
              grantId: 'other',
              repositoryId: 'peyday007/other',
              scope: ['**'],
              scopeSentence: 'Anywhere in peyday007/other.',
            }),
          ],
        },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    // Nothing is preselected and Authorize is disabled until it is: which
    // repository a change lands in is not a guess the interface should make.
    expect(within(card()).getByRole('button', { name: /Authorize/ })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => {
      fireEvent.change(within(card()).getByRole('combobox'), { target: { value: 'other' } });
    });
    expect(card().querySelector('.rs-software-scope')?.textContent).toContain(
      'Anywhere in peyday007/other.',
    );
    expect(within(card()).getByRole('button', { name: /Authorize/ })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('says a change has nowhere to run rather than offering a button that will refuse', async () => {
    base({
      [NEEDS_YOU]: { body: { requests: [], software: [waiting()], repositories: [] } },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    expect(within(card()).queryByRole('button', { name: /Authorize/ })).toBeNull();
    expect(card().textContent).toMatch(/has not been given a repository/i);
    expect(card().textContent).toMatch(/Build → Repositories/);
  });

  it('shows a refusal as a refusal rather than appearing to have worked', async () => {
    base({
      [NEEDS_YOU]: {
        body: { requests: [], software: [waiting()], repositories: [repository()] },
      },
      [AUTHORIZE]: {
        status: 422,
        body: { error: 'SCOPE', message: 'This project may change sites/v4/ in peyday007/sites.' },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Authorize/ }));
    });
    await waitFor(() =>
      expect(document.querySelector('.rs-software .rs-state-error')).toBeTruthy(),
    );
  });

  it('declines with a reason, and re-reads', async () => {
    base({
      [NEEDS_YOU]: {
        body: { requests: [], software: [waiting()], repositories: [repository()] },
      },
      [DECLINE]: { body: { ok: true } },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: /Not this/ }));
    });
    expect(bodies[DECLINE]).toHaveProperty('reason');
    expect(calls.filter((c) => c === NEEDS_YOU).length).toBeGreaterThan(1);
  });

  it('reports a running campaign in the server’s words, and links its pull request', async () => {
    base({
      [NEEDS_YOU]: {
        body: {
          requests: [],
          software: [
            waiting({
              request: { ...(waiting().request as object), state: 'AUTHORIZED', campaignId: 'fcp_1' },
              line: 'The campaign is blocked and cannot proceed on its own.',
              pullRequestUrl: 'https://github.com/Peyday007/sites/pull/7',
            }),
          ],
          repositories: [repository()],
        },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());

    // Not the authorize control: this one is under way, and the sentence is
    // `campaignBriefing`'s rather than one composed in the browser.
    expect(within(card()).queryByRole('button', { name: /Authorize/ })).toBeNull();
    expect(card().querySelector('.rs-software-progress')?.textContent).toBe(
      'The campaign is blocked and cannot proceed on its own.',
    );
    const link = card().querySelector('.rs-software-pr a') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/Peyday007/sites/pull/7');
    expect(link.rel).toContain('noreferrer');
  });
});

describe('the settled state counts a software change as a decision', () => {
  it('does not say nothing needs a decision while one is waiting', async () => {
    base({
      [NEEDS_YOU]: {
        body: { requests: [], software: [waiting()], repositories: [repository()] },
      },
    });
    await mount();
    await waitFor(() => expect(card()).toBeTruthy());
    expect(screen.queryByText(/Nothing needs your decision/i)).toBeNull();
  });

  it('still reads as settled when there is genuinely nothing', async () => {
    base();
    await mount();
    await waitFor(() => expect(screen.getByText(/Nothing needs your decision/i)).toBeTruthy());
    expect(document.querySelector('.rs-decision-software')).toBeNull();
  });
});

describe('the card is as wide as its container and no wider', () => {
  const CSS = fs.readFileSync(
    path.join(process.cwd(), 'client/src/russell/design.css'),
    'utf8',
  );

  /** Every rule this feature added, so a fixed width cannot be slipped in later. */
  const OURS = [
    '.rs-software',
    '.rs-software-scope',
    '.rs-software-where',
    '.rs-software-actions',
    '.rs-software-progress',
    '.rs-software-pr',
    '.rs-thread-software',
    '.rs-thread-software-item',
    '.rs-repo-scope',
    '.rs-repo-scope-choice',
    '.rs-repo-boundary',
    '.rs-build-scope',
  ];

  it('declares no width wider than a phone anywhere in the new rules', () => {
    for (const selector of OURS) {
      const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'g');
      let match: RegExpExecArray | null;
      while ((match = block.exec(CSS)) !== null) {
        const body = match[1] ?? '';
        expect(body, `${selector} must not set a min-width`).not.toMatch(/min-width/);
        expect(body, `${selector} must not set a fixed width`).not.toMatch(/(^|[;\s])width:\s*\d/);
      }
    }
  });

  it('lets the actions and the choices wrap rather than overflow', () => {
    // The two rows that hold more than one thing. A phone is 390 wide and two
    // buttons plus a select do not fit in a row that cannot wrap.
    expect(CSS).toMatch(/\.rs-software-actions\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(CSS).toMatch(/\.rs-thread-software-item\s*\{[^}]*flex-wrap:\s*wrap/);
    // And the select, which is the one element that sizes to its longest option.
    expect(CSS).toMatch(/\.rs-software-where select\s*\{[^}]*max-width:\s*100%/);
  });
});
