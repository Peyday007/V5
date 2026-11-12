// @vitest-environment jsdom
/**
 * The three manufacturing decisions the Machines screen was missing.
 *
 * `server/routes/manufacturing.ts` has always had a route to withdraw a held
 * capability, retire a category and name one — all three person-only writes
 * §39 describes — and `Machines.tsx` called none of them. This is
 * `cashSection.test.tsx`'s seam: the real components over a scripted `fetch`,
 * so a control that posts a field the route does not take, or a screen that
 * silently drops a refusal, fails here rather than only in production.
 *
 * Three properties hold across all three controls:
 *
 *   - each is offered only where it applies (withdraw only beside a held
 *     capability), and its submit is disabled while its required reason is
 *     empty;
 *   - each sends exactly the body the route expects, and nothing else — the
 *     category form in particular must never send a `kind`, because naming
 *     one is a person's decision Brain must not narrow for them;
 *   - a refusal from the server renders verbatim via the screen's own
 *     `describe()`, and a success calls the view's existing `reload()`
 *     exactly as `DeclareHeld` and `SetAside` already do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MachinesView } from '../client/src/russell/Machines.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const PROJECT = 'prj_1';
const VIEW = `GET /api/projects/${PROJECT}/manufacturing`;

const CONDITION_ANY = {
  condition: 'DEMAND_ESTABLISHED',
  answer: 'UNKNOWN' as const,
  because: 'Nothing published settles this yet.',
};

const CAPITAL = {
  state: 'UNEXAMINED' as const,
  scenarios: [],
  cheapestFullyPriced: null,
  unpricedRequirements: [],
  because: 'Nothing has priced entry yet.',
};

const EVIDENCE = { demand: [], distribution: [], against: [], boughtIn: [] };

function category(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categoryId: 'mcat_1',
    path: ['Powered equipment'],
    verdict: 'UNEXAMINED',
    conditions: [CONDITION_ANY],
    missing: [],
    held: [],
    wouldTeach: [],
    barriers: [],
    capital: CAPITAL,
    evidence: EVIDENCE,
    because: 'Nobody has looked at this yet.',
    ...over,
  };
}

/** A ledger row, held or not, with a stable id so a test can find it. */
function capabilityRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: {
      id: 'cap_1',
      name: 'Small-engine integration',
      heldAt: null,
      heldEvidence: null,
      heldBy: null,
      heldNote: null,
    },
    requiredBy: [],
    taughtBy: [],
    ...over,
  };
}

/** The whole `ProgrammeView` the server would answer with. */
function programmeView(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    program: { id: 'mfp_1', objective: 'A real objective, well over the length floor.', state: 'ACTIVE' },
    authorized: true,
    directive: {
      path: null,
      sha256: null,
      reaching: false,
      why: 'No directive has been registered.',
      bands: [],
      sequencingRefusal: null,
    },
    frontier: [],
    counts: {
      categories: 1,
      retired: 0,
      capabilities: 1,
      capabilitiesHeld: 0,
      openRounds: 0,
      settledRounds: 0,
      capitalRequirements: 0,
      capitalRequirementsPriced: 0,
      acquisitionCandidates: 0,
      acquisitionCandidatesSetAside: 0,
    },
    ladder: [category()],
    enterable: [],
    acquisitions: [],
    openQuestions: [],
    next: [],
    plan: { asks: [], declined: [] },
    open: [],
    progress: [],
    capabilities: [capabilityRow()],
    history: [],
    refusals: [],
    decisions: [],
    ...over,
  };
}

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = { [VIEW]: { body: { programme: programmeView() } }, ...over };
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
    render(<MachinesView projectId={PROJECT} />);
  });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Categories' })).toBeTruthy());
}

describe('withdrawing a held capability', () => {
  it('does not render beside a capability that is not held', async () => {
    base({
      [VIEW]: { body: { programme: programmeView({ capabilities: [capabilityRow()] }) } },
    });
    await mount();
    expect(screen.queryByRole('button', { name: /withdraw this holding/i })).toBeNull();
  });

  it('renders beside a held capability, disables submit until a reason is given, and PATCHes {reason}', async () => {
    const held = capabilityRow({
      capability: {
        id: 'cap_1',
        name: 'Small-engine integration',
        heldAt: '2026-09-01T00:00:00.000Z',
        heldEvidence: 'DECLARED',
        heldBy: 'usr_1',
        heldNote: 'Hired a contract machinist.',
      },
    });
    const withdrawn = capabilityRow({
      capability: {
        id: 'cap_1',
        name: 'Small-engine integration',
        heldAt: null,
        heldEvidence: null,
        heldBy: null,
        heldNote: null,
      },
    });
    let reloaded = false;
    base({
      [VIEW]: () => ({
        body: { programme: programmeView({ capabilities: [reloaded ? withdrawn : held] }) },
      }),
      [`PATCH /api/projects/${PROJECT}/manufacturing/capabilities/cap_1`]: () => {
        reloaded = true;
        return { body: { capability: withdrawn.capability } };
      },
    });
    await mount();

    const button = screen.getByRole('button', { name: /withdraw this holding/i });
    expect(button).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/withdraw this holding, and why/i), {
      target: { value: 'The contract ended and nobody kept the skill in house.' },
    });
    expect(button).toHaveProperty('disabled', false);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(bodies[`PATCH /api/projects/${PROJECT}/manufacturing/capabilities/cap_1`]).toStrictEqual({
      reason: 'The contract ended and nobody kept the skill in house.',
    });
    // reload() re-read the programme, and the capability now reads not held.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /withdraw this holding/i })).toBeNull(),
    );
  });

  it('renders the server refusal verbatim and does not reload', async () => {
    const held = capabilityRow({
      capability: {
        id: 'cap_1',
        name: 'Small-engine integration',
        heldAt: '2026-09-01T00:00:00.000Z',
        heldEvidence: 'DECLARED',
        heldBy: 'usr_1',
        heldNote: 'Hired a contract machinist.',
      },
    });
    let viewCalls = 0;
    base({
      [VIEW]: () => {
        viewCalls += 1;
        return { body: { programme: programmeView({ capabilities: [held] }) } };
      },
      [`PATCH /api/projects/${PROJECT}/manufacturing/capabilities/cap_1`]: {
        status: 422,
        body: { error: 'Withdrawing a declaration records why.' },
      },
    });
    await mount();
    const readsBefore = viewCalls;

    fireEvent.change(screen.getByLabelText(/withdraw this holding, and why/i), {
      target: { value: 'It no longer applies.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /withdraw this holding/i }));
    });

    expect(screen.getByText('Withdrawing a declaration records why.')).toBeTruthy();
    expect(viewCalls).toBe(readsBefore);
  });
});

describe('naming a category', () => {
  it('renders above the category list, requires a name, and never sends a kind', async () => {
    base();
    await mount();

    const submit = screen.getByRole('button', { name: /^name a category$/i });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/^name a category$/i), {
      target: { value: 'Marine propulsion' },
    });
    expect(submit).toHaveProperty('disabled', false);

    routes[`POST /api/projects/${PROJECT}/manufacturing/categories`] = {
      body: { category: { id: 'mcat_2', name: 'Marine propulsion' }, created: true },
    };
    await act(async () => {
      fireEvent.click(submit);
    });

    const sent = bodies[`POST /api/projects/${PROJECT}/manufacturing/categories`] as Record<
      string,
      unknown
    >;
    expect(sent).toStrictEqual({ name: 'Marine propulsion' });
    expect('kind' in sent).toBe(false);
  });

  it('sends the description only when it is not empty', async () => {
    base({
      [`POST /api/projects/${PROJECT}/manufacturing/categories`]: {
        body: { category: { id: 'mcat_2', name: 'Marine propulsion' }, created: true },
      },
    });
    await mount();

    fireEvent.change(screen.getByLabelText(/^name a category$/i), {
      target: { value: 'Marine propulsion' },
    });
    fireEvent.change(screen.getByLabelText(/description, if it helps/i), {
      target: { value: 'Outboard and inboard motors alike.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^name a category$/i }));
    });

    expect(bodies[`POST /api/projects/${PROJECT}/manufacturing/categories`]).toStrictEqual({
      name: 'Marine propulsion',
      description: 'Outboard and inboard motors alike.',
    });
  });

  it('renders the server refusal verbatim', async () => {
    base({
      [`POST /api/projects/${PROJECT}/manufacturing/categories`]: {
        status: 422,
        body: { error: 'That parent category is not on this programme’s ladder.' },
      },
    });
    await mount();

    fireEvent.change(screen.getByLabelText(/^name a category$/i), {
      target: { value: 'Marine propulsion' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^name a category$/i }));
    });

    expect(
      screen.getByText('That parent category is not on this programme’s ladder.'),
    ).toBeTruthy();
  });
});

describe('retiring a category', () => {
  it('renders beside every category, requires a reason, and PATCHes {reason}', async () => {
    base({
      [`PATCH /api/projects/${PROJECT}/manufacturing/categories/mcat_1`]: {
        body: { category: { categoryId: 'mcat_1', verdict: 'RETIRED' } },
      },
    });
    await mount();

    const button = screen.getByRole('button', { name: /retire this category/i });
    expect(button).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText(/retire this category, and why/i), {
      target: { value: 'No demand was ever found for it.' },
    });
    expect(button).toHaveProperty('disabled', false);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(
      bodies[`PATCH /api/projects/${PROJECT}/manufacturing/categories/mcat_1`],
    ).toStrictEqual({ reason: 'No demand was ever found for it.' });
  });

  it('is not offered beside a category that is already retired', async () => {
    base({
      [VIEW]: {
        body: {
          programme: programmeView({
            ladder: [category({ verdict: 'RETIRED' }), category({ categoryId: 'mcat_2' })],
          }),
        },
      },
    });
    await mount();

    // Only the live category offers it; the retired one has nothing left to say.
    expect(screen.getAllByRole('button', { name: /retire this category/i })).toHaveLength(1);
  });

  it('renders the server refusal verbatim', async () => {
    base({
      [`PATCH /api/projects/${PROJECT}/manufacturing/categories/mcat_1`]: {
        status: 422,
        body: { error: 'Retiring a category records why, so that it stays answerable.' },
      },
    });
    await mount();

    fireEvent.change(screen.getByLabelText(/retire this category, and why/i), {
      target: { value: 'trying anyway' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retire this category/i }));
    });

    expect(
      screen.getByText('Retiring a category records why, so that it stays answerable.'),
    ).toBeTruthy();
  });
});

describe('every new control calls reload on success', () => {
  it('re-reads the programme after naming a category', async () => {
    let viewCalls = 0;
    base({
      [VIEW]: () => {
        viewCalls += 1;
        return { body: { programme: programmeView() } };
      },
      [`POST /api/projects/${PROJECT}/manufacturing/categories`]: {
        body: { category: { id: 'mcat_2', name: 'Marine propulsion' }, created: true },
      },
    });
    await mount();
    const readsBefore = viewCalls;

    fireEvent.change(screen.getByLabelText(/^name a category$/i), {
      target: { value: 'Marine propulsion' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^name a category$/i }));
    });

    await waitFor(() => expect(viewCalls).toBe(readsBefore + 1));
  });

  it('re-reads the programme after retiring a category', async () => {
    let viewCalls = 0;
    base({
      [VIEW]: () => {
        viewCalls += 1;
        return { body: { programme: programmeView() } };
      },
      [`PATCH /api/projects/${PROJECT}/manufacturing/categories/mcat_1`]: {
        body: { category: { categoryId: 'mcat_1', verdict: 'RETIRED' } },
      },
    });
    await mount();
    const readsBefore = viewCalls;

    fireEvent.change(screen.getByLabelText(/retire this category, and why/i), {
      target: { value: 'No demand was ever found for it.' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retire this category/i }));
    });

    await waitFor(() => expect(viewCalls).toBe(readsBefore + 1));
  });
});

describe('no control marks a capability held from research', () => {
  it('the ledger never posts to the capabilities-create route', async () => {
    base();
    await mount();
    expect(calls).not.toContain(`POST /api/projects/${PROJECT}/manufacturing/capabilities`);
  });
});
