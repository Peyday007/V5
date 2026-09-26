// @vitest-environment jsdom
/**
 * The Research Intelligence disclosure on a mission card, driven rather than
 * described.
 *
 * `client/src/russell/ResearchIntelligence.tsx` and its wiring into
 * `MissionCard` (`client/src/russell/Views.tsx`) both pass `npm run
 * typecheck` on their own, which proves nothing about what a person actually
 * sees: whether the disclosure exists at all, whether it costs a request
 * before anybody opens it, whether an unknown belief basis reads as a stray
 * `null`, and whether an absent packet and a forbidden one look the same. §27
 * records the shape this test exists to close — a card's server-side story
 * can be perfect while the control a person presses is silently missing.
 *
 * `fetch` is replaced with a scripted one rather than mocking a module, so
 * `WorkView` — and, through it, `MissionCard` and `ResearchIntelligence` —
 * goes through the real `api()` helper, exactly as it does in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { WorkView } from '../client/src/russell/Views.tsx';
import type { ResearchIntelligenceView as ClientResearchIntelligenceView } from '../client/src/lib/researchIntelligenceApi.ts';
import type { ResearchIntelligenceView as ServerResearchIntelligenceView } from '../server/services/research/intelligence/view.ts';

// React 18 wants to be told this is an act-capable environment; without it
// every update logs a warning that hides real ones.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* --------------------------------------------------------------------------
 * A05: the client's type cannot silently stop matching the server's.
 *
 * `researchIntelligenceApi.ts` re-exports `ResearchIntelligenceView` type-only
 * from the server module rather than restating it, so today the two names
 * resolve to the identical type. This assertion is what stops that ever
 * changing unnoticed: if a future edit gave the client its own hand-written
 * declaration that dropped, renamed or added a field relative to the server's,
 * the mutual `extends` below stops type-checking and the whole suite fails at
 * `npm run typecheck` — before any test body runs.
 * ------------------------------------------------------------------------ */
type KeysMatchExactly<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;

describe('the client and server type contracts cannot silently diverge', () => {
  it('holds the client ResearchIntelligenceView to the server’s own key set', () => {
    const keysMatch: KeysMatchExactly<
      ClientResearchIntelligenceView,
      ServerResearchIntelligenceView
    > = true;
    expect(keysMatch).toBe(true);
  });
});

/* --------------------------------------------------------------------------
 * The scripted server
 * ------------------------------------------------------------------------ */

const PROJECT = 'prj_1';
const ORCHESTRATION = 'orc_1';
const WORK = `GET /api/russell/projects/${PROJECT}/work`;
const GOALS = 'GET /api/goals';
const REGISTER = 'GET /api/register';
const INTELLIGENCE = `GET /api/research/${ORCHESTRATION}/intelligence`;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];

/** Both panels above Work fetch on mount; give them something harmless. */
const GOALS_EMPTY = {
  briefing: {
    headline: 'Nothing needs you.',
    delivered: [],
    decisions: [],
    agingBlockers: [],
    commitments: [],
  },
  goals: [],
};
const REGISTER_EMPTY = {
  workstreams: [],
  answers: { pursuingMoney: [], running: [], blocked: [], needsYou: [], shipped: [] },
  unknown: 0,
  unfiled: [],
};

function base(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = {
    [GOALS]: { body: GOALS_EMPTY },
    [REGISTER]: { body: REGISTER_EMPTY },
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
    render(<WorkView projectId={PROJECT} />);
  });
}

function missionCard(): HTMLElement {
  const found = document.querySelector('.rs-mission');
  if (!found) throw new Error('no mission card is on the page');
  return found as HTMLElement;
}

/** One WorkEntry, matching `server/services/russell/work.ts`'s own shape. */
function workEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'packet:orc_1',
    source: 'ORCHESTRATION',
    sourceId: ORCHESTRATION,
    group: 'WORKING_NOW',
    provenance: 'PROJECT',
    title: 'Establish who publishes trailer axle specs',
    why: 'Needed before a supplier can be qualified.',
    state: 'AUDITING',
    waitingOn: null,
    updatedAt: '2026-09-13T00:00:00.000Z',
    priority: 'WORTH_DOING',
    priorityLabel: 'Worth doing',
    priorityReason: 'Useful, and nothing is blocking it.',
    blocked: false,
    how: [],
    links: {
      missionId: null,
      orchestrationId: ORCHESTRATION,
      binId: null,
      documentId: null,
      conversationId: null,
      layerId: null,
    },
    ...overrides,
  };
}

function workBody(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    missions: [],
    work: {
      items: [entry],
      emptyReason: null,
      explanation: null,
      groups: [{ group: 'WORKING_NOW', entries: [entry] }],
      includesTechnical: false,
      technicalHidden: 0,
    },
  };
}

const UNDERSTANDING = {
  outcomeSought: 'Whether this trailer class may be sold in the target market.',
  decisionSupported: 'Whether to quote this deal.',
  stakes: 'HIGH',
  reversibility: 'LOW',
  searchableProperties: ['axle rating'],
  unexplainedExamples: ['a 40-foot flatbed'],
  nonGoals: ['Pricing the deal'],
  assumptions: ['The buyer has not changed the destination'],
  version: 3,
  derivedFrom: 'the original assignment',
};

/** A decisive question with nothing known yet, exactly the case A03 asks for. */
function unknownQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'uq_1',
    question: 'Does the trailer need a type approval in this market?',
    whyItMatters: 'Without it the trailer cannot be registered at all.',
    disposition: 'OPEN',
    reason: null,
    belief: null,
    beliefBasis: 'UNKNOWN',
    decisive: true,
    couldInvalidateEverything: true,
    depth: 'DEEP',
    depthBasis: 'the fragment declared it decisive',
    origin: 'PLAN',
    ...overrides,
  };
}

function intelligenceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orchestrationId: ORCHESTRATION,
    understanding: UNDERSTANDING,
    next: [{ key: 'uq_1', question: unknownQuestion().question, why: 'It could invalidate everything else.' }],
    decisive: [unknownQuestion()],
    settled: [],
    retired: [],
    needsPerson: [],
    openContradictions: [],
    changes: [],
    sufficiency: {
      verdict: 'KEEP_RESEARCHING',
      detail: 'The decisive question above is still open.',
      decisive: { settled: 0, total: 1 },
      mandatory: { covered: 2, total: 3 },
      // A distinctive value: if this number ever leaked into the panel as a
      // rendered percentage, it would be unmistakable in the assertions below.
      readiness: 42,
      blockers: ['Something is still standing in the way.'],
    },
    lessons: [],
    ...overrides,
  };
}

/** A packet with nothing in it at all — the fourth of the four states. */
function emptyIntelligenceBody(): Record<string, unknown> {
  return {
    orchestrationId: ORCHESTRATION,
    understanding: null,
    next: [],
    decisive: [],
    settled: [],
    retired: [],
    needsPerson: [],
    openContradictions: [],
    changes: [],
    sufficiency: {
      verdict: 'KEEP_RESEARCHING',
      detail: 'Nothing has been researched yet.',
      decisive: { settled: 0, total: 0 },
      mandatory: { covered: 0, total: 0 },
      readiness: null,
      blockers: [],
    },
    lessons: [],
  };
}

/** Open the disclosure and wait for whatever it fetched to render. */
async function openDisclosure(): Promise<void> {
  fireEvent.click(within(missionCard()).getByText('What Brain is working out'));
}

/* --------------------------------------------------------------------------
 * A01 + A02: closed by default, one request, everything read from the wire
 * ------------------------------------------------------------------------ */

describe('the disclosure on a mission card', () => {
  it('renders no disclosure at all for an entry with no orchestration id', async () => {
    base({ [WORK]: { body: workBody(workEntry({ links: { ...(workEntry().links as object), orchestrationId: null } })) } });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());

    expect(within(missionCard()).queryByText('What Brain is working out')).toBeNull();
    expect(calls).not.toContain(INTELLIGENCE);
  });

  it('makes no request until it is opened', async () => {
    base({ [WORK]: { body: workBody(workEntry()) } });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());

    expect(within(missionCard()).getByText('What Brain is working out')).toBeTruthy();
    expect(calls).not.toContain(INTELLIGENCE);
  });

  it('opening it issues the one request and renders the packet in the server’s own words', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: { body: intelligenceBody() },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());

    await openDisclosure();
    await waitFor(() => expect(calls).toContain(INTELLIGENCE));
    expect(calls.filter((call) => call === INTELLIGENCE).length).toBe(1);

    await waitFor(() =>
      expect(within(missionCard()).getByText(UNDERSTANDING.outcomeSought)).toBeTruthy(),
    );
    // The agenda, read from `next`.
    expect(
      within(missionCard()).getByText('It could invalidate everything else.'),
    ).toBeTruthy();
    // The decisive question, and why it matters.
    expect(
      within(missionCard()).getByText('Without it the trailer cannot be registered at all.'),
    ).toBeTruthy();
    // The sufficiency reading.
    expect(
      within(missionCard()).getByText('The decisive question above is still open.'),
    ).toBeTruthy();
    expect(within(missionCard()).getByText(/0 of 1 decisive question/)).toBeTruthy();
    expect(within(missionCard()).getByText(/2 of 3 mandatory requirement/)).toBeTruthy();
    expect(
      within(missionCard()).getByText('Something is still standing in the way.'),
    ).toBeTruthy();
  });

  it('does not disturb any other rendering on the card', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: { body: intelligenceBody() },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();
    await waitFor(() => expect(calls).toContain(INTELLIGENCE));

    // Title, priority pill, why and the next-state line are all untouched.
    expect(
      within(missionCard()).getByText('Establish who publishes trailer axle specs'),
    ).toBeTruthy();
    expect(within(missionCard()).getByText('Worth doing')).toBeTruthy();
    expect(
      within(missionCard()).getByText('Needed before a supplier can be qualified.'),
    ).toBeTruthy();
  });
});

/* --------------------------------------------------------------------------
 * A03: an unknown belief renders as words, and nothing here is a score
 * ------------------------------------------------------------------------ */

describe('an unknown belief, and the absence of an invented score', () => {
  it('renders "not known yet" for a null belief and an UNKNOWN basis', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: { body: intelligenceBody() },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();
    await waitFor(() =>
      expect(within(missionCard()).getByText(/not known yet/)).toBeTruthy(),
    );
  });

  it('never renders the readiness figure or a percentage anywhere in the panel', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: { body: intelligenceBody() },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();
    await waitFor(() =>
      expect(within(missionCard()).getByText(UNDERSTANDING.outcomeSought)).toBeTruthy(),
    );

    const panelText = missionCard().textContent ?? '';
    // `readiness: 42` in the fixture must never surface as a rendered number.
    expect(panelText).not.toMatch(/42/);
    expect(panelText).not.toMatch(/%/);
  });
});

/* --------------------------------------------------------------------------
 * A04: absent and forbidden are one state; an error and an empty packet are
 * neither that state nor each other
 * ------------------------------------------------------------------------ */

describe('four states, kept apart', () => {
  it('renders an absent packet and a forbidden one identically', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: {
        status: 404,
        body: { error: 'No orchestration with that id.' },
      },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();
    let absentMessage = '';
    await waitFor(() => {
      const found = missionCard().querySelector('.rs-state-forbidden');
      expect(found).toBeTruthy();
      absentMessage = found?.textContent ?? '';
      expect(absentMessage.length).toBeGreaterThan(0);
    });
    cleanup();

    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: {
        status: 404,
        body: { error: 'You may not read this project.' },
      },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();
    await waitFor(() => {
      const found = missionCard().querySelector('.rs-state-forbidden');
      expect(found).toBeTruthy();
      // Byte-identical: the server refuses to say which one it was, so the
      // interface must not invent a difference either.
      expect(found?.textContent).toBe(absentMessage);
    });
  });

  it('renders a transport error visibly differently from the not-available state', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: { status: 500, body: { error: 'The database is unreachable.' } },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();

    await waitFor(() => expect(missionCard().querySelector('.rs-state-error')).toBeTruthy());
    expect(missionCard().querySelector('.rs-state-forbidden')).toBeNull();
  });

  it('renders a genuinely empty packet as its own state, distinct from loading, error and forbidden', async () => {
    base({
      [WORK]: { body: workBody(workEntry()) },
      [INTELLIGENCE]: { body: emptyIntelligenceBody() },
    });
    await mount();
    await waitFor(() => expect(missionCard()).toBeTruthy());
    await openDisclosure();

    await waitFor(() => expect(missionCard().querySelector('.rs-state-empty')).toBeTruthy());
    expect(missionCard().querySelector('.rs-state-error')).toBeNull();
    expect(missionCard().querySelector('.rs-state-forbidden')).toBeNull();
    expect(missionCard().querySelector('.rs-state-loading')).toBeNull();
  });
});
