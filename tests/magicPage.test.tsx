/**
 * The Magic page: each subsection renders from its address, buttons act, and
 * failures and stale data are said out loud. The server is a scripted fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/magic',
  pretendToBeVisual: true,
});
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
  'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'MutationObserver', 'DOMParser',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { createElement } = await import('react');
const { MagicView } = await import('../client/src/russell/Magic.tsx');
const { formatCents, parseDollars, sectionFromPath, MAGIC_SECTIONS } = await import(
  '../client/src/lib/magicApi.ts'
);

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
let handler: Handler = () => ({ body: {} });
const calls: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const out = handler(url, init);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const fresh = {
  state: 'FRESH', stale: false, cards: 3, fetchedAt: '2026-10-31T00:00:00.000Z', sourceUpdatedAt: null,
  lastError: null, reason: null,
};
const deck = {
  id: 'd1', ownerUserId: 'u1', name: 'Test Deck', format: 'COMMANDER', currentVersionId: 'v2',
  cardListStatus: 'VERIFIED', notes: '', archivedAt: null, createdAt: '2026-10-31', updatedAt: '2026-10-31',
};
const validation = {
  ok: false, format: 'COMMANDER', analysisDate: '2026-11-01', legalitySnapshotAt: '2026-10-31',
  counts: { commander: 1, main: 1, sideboard: 0, total: 2 }, commanders: ['Kardur, Doomscourge'], colorIdentity: ['B', 'R'],
  issues: [{ code: 'DECK_SIZE', severity: 'ERROR', message: 'A Commander deck has exactly 100 cards.' }],
};
const path = (url: string): string => new URL(url, 'http://x').pathname;

describe('money and paths', () => {
  it('handles the 9.99 / 10.00 / 10.01 boundary in integer cents', () => {
    expect(parseDollars('9.99')).toBe(999);
    expect(parseDollars('10.00')).toBe(1000);
    expect(parseDollars('10.01')).toBe(1001);
    expect(parseDollars('10.011')).toBeNull();
    expect(formatCents(1001)).toBe('$10.01');
    expect(formatCents(null)).toBe('unpriced');
  });
  it('maps every section to its address and back', () => {
    for (const s of MAGIC_SECTIONS) expect(sectionFromPath(`/magic/${s}`)).toBe(s);
    expect(sectionFromPath('/magic')).toBeNull();
  });
});

describe('Magic page', () => {
  it('offers the four first-entry choices and each one navigates', async () => {
    handler = (url) => ({ body: url.includes('catalog') ? fresh : { decks: [], leagues: [] } });
    render(createElement(MagicView, { section: null, onNavigate: () => {} }));
    await waitFor(() => expect(screen.getByText(/Card catalog: 3 cards/)).toBeTruthy());
    for (const label of [
      'Describe a new deck', 'Import a deck', 'Optimize a saved deck', 'Open the Precon Commander League',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import a deck' }));
    await waitFor(() => expect(screen.getByLabelText('Import a deck', { selector: 'section' })).toBeTruthy());
  });

  it('shows a stale label with the server\'s reason, and refreshes on request', async () => {
    let refreshed = false;
    handler = (url, init) => {
      if (url.includes('/catalog/refresh')) {
        expect(init?.method).toBe('POST');
        refreshed = true;
        return { status: 202, body: { started: true, status: fresh } };
      }
      if (url.includes('catalog')) {
        return refreshed
          ? { body: fresh }
          : { body: { ...fresh, state: 'STALE', stale: true, lastError: 'timeout', reason: 'The last refresh failed (timeout); serving the cached catalog.' } };
      }
      return { body: { decks: [] } };
    };
    render(createElement(MagicView, { section: 'decks' }));
    await waitFor(() => expect(screen.getByText(/Stale card catalog/)).toBeTruthy());
    expect(screen.getByText(/last refresh failed \(timeout\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh card catalog' }));
    await waitFor(() => expect(screen.getByText(/Card catalog: 3 cards/)).toBeTruthy());
    expect(calls.some((c) => c.url === '/api/magic/catalog/refresh')).toBe(true);
  });

  it('says the catalog is loading while it is empty', async () => {
    handler = (url) => ({
      body: url.includes('catalog') ? { ...fresh, state: 'LOADING', cards: 0, fetchedAt: null, reason: 'No catalog has been loaded yet.' } : { decks: [] },
    });
    render(createElement(MagicView, { section: 'decks' }));
    await waitFor(() => expect(screen.getByText(/The card catalog is loading/)).toBeTruthy());
  });

  it('surfaces import problems instead of a green result', async () => {
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (path(url) === '/api/magic/decks') return { body: { decks: [] } };
      if (path(url) === '/api/magic/decks/import') {
        return {
          status: 201,
          body: {
            deck: { ...deck, cardListStatus: 'UNVERIFIED' },
            version: { id: 'v1', deckId: 'd1', versionNumber: 1, parentVersionId: null, reason: '', source: 'IMPORT', validation: {}, createdAt: '', cards: [] },
            parseProblems: [],
            resolutionIssues: [{ code: 'UNKNOWN_CARD', line: 3, name: 'Foo', message: 'No card named Foo' }],
            validation, clean: false,
          },
        };
      }
      return { body: {} };
    };
    render(createElement(MagicView, { section: 'decks' }));
    await waitFor(() => screen.getByLabelText('Deck name'));
    fireEvent.change(screen.getByLabelText('Deck name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Card list'), { target: { value: '1 Foo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/No card named Foo/)).toBeTruthy());
    expect(screen.getByText(/unknown card/)).toBeTruthy();
    expect(screen.getByText(/Not legal/)).toBeTruthy();
    const posted = calls.find((c) => path(c.url) === '/api/magic/decks/import');
    expect(posted?.body).toEqual({ name: 'X', format: 'COMMANDER', text: '1 Foo' });
  });

  it('labels every analysis number with its kind of claim', async () => {
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (path(url) === '/api/magic/decks') return { body: { decks: [deck] } };
      return {
        body: {
          analysis: {
            format: 'COMMANDER', librarySize: 99, commanderZone: ['Kardur, Doomscourge'], counts: {}, curve: [], pips: {}, sources: {},
            byTurn: [], answers: [], commanderCastable: [], redundancy: [], singleCardReliance: [], notes: [],
            scores: { closing: { value: 0.4, label: 'HEURISTIC_SCORE' } },
            openingHand: { keepable: { value: 0.875, label: 'EXACT_PROBABILITY' }, landDistribution: [] },
            simulation: null,
          },
          catalog: fresh,
        },
      };
    };
    render(createElement(MagicView, { section: 'optimize' }));
    const select = await waitFor(() => screen.getByLabelText('Deck'));
    fireEvent.change(select, { target: { value: 'd1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze this deck' }));
    await waitFor(() => expect(screen.getByText('87.5%')).toBeTruthy());
    expect(screen.getByText(/\(EXACT_PROBABILITY\)/)).toBeTruthy();
    expect(screen.getByText(/\(HEURISTIC_SCORE\)/)).toBeTruthy();
    expect(calls.find((c) => path(c.url) === '/api/magic/analyze')?.body).toEqual({ deckId: 'd1' });
  });

  it('rejects a malformed price ceiling before calling the server, and sends whole cents', async () => {
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (path(url) === '/api/magic/decks') return { body: { decks: [deck] } };
      const build = (composite: number) => ({
        key: 'k', swaps: [], costCents: 0, objectives: {}, vsBaseline: {}, composite: { value: composite, label: 'HEURISTIC_SCORE', note: '' },
      });
      return {
        body: {
          optimization: {
            format: 'COMMANDER', baseline: { valid: true, issues: [], build: build(1) }, candidates: [], frontier: [],
            upgrades: [{ swap: { cut: 'Mountain', add: 'Sol Ring', addPriceCents: 150 }, gain: 0.2, costCents: 150, gainPerDollar: 0.13, free: false }],
            recommended: build(1.2), comparison: 'The recommended build beats the unchanged deck.', weights: {},
            searched: { scored: 3, rejected: 0, levels: 1 }, notes: [],
          },
          unknownPoolNames: ['Nope'], catalog: fresh,
        },
      };
    };
    render(createElement(MagicView, { section: 'optimize' }));
    fireEvent.change(await waitFor(() => screen.getByLabelText('Deck')), { target: { value: 'd1' } });
    fireEvent.change(screen.getByLabelText(/Cards to consider adding/), { target: { value: 'Sol Ring\nNope' } });
    fireEvent.change(screen.getByLabelText(/Price ceiling/), { target: { value: '9.999' } });
    expect(screen.getByText(/dollars and cents/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find upgrades' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Price ceiling/), { target: { value: '10.01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find upgrades' }));
    await waitFor(() => expect(screen.getByText(/beats the unchanged deck/)).toBeTruthy());
    expect(screen.getByText(/Not in the catalog, so not considered: Nope/)).toBeTruthy();
    expect(calls.find((c) => path(c.url) === '/api/magic/optimize')?.body).toEqual({
      deckId: 'd1', poolNames: ['Sol Ring', 'Nope'], constraints: { priceCeilingCents: 1001, protectedNames: [] },
    });
  });

  it('renders the league with unknowns kept unknown and rule status visible', async () => {
    const player = (ordinal: number, label: string) => ({
      id: `p${ordinal}`, leagueId: 'l1', seedKey: `s${ordinal}`, ordinal, label, isOwner: ordinal === 0, status: 'CONFIRMED',
      unknowns: [], notes: '', updatedAt: '',
    });
    const version = (playerId: string, extra = {}) => ({
      id: `ld-${playerId}`, leagueId: 'l1', playerId, versionNumber: 1, parentLeagueDeckId: null, deckId: null, deckVersionId: null,
      product: null, commander: null, cardListStatus: 'UNVERIFIED', sourceCitation: null, sourceDate: null, isBaseline: true,
      observedAt: null, detail: { listLabel: 'unverified cardlist' }, createdAt: '', ...extra,
    });
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (path(url) === '/api/magic/leagues') return { body: { leagues: [{ id: 'l1', name: 'Precon Commander League' }] } };
      if (path(url) === '/api/magic/leagues/l1/games') return { body: { games: [], standings: [] } };
      return {
        body: {
          league: { id: 'l1', name: 'Precon Commander League', pod_size: 4, starting_life: 40 },
          players: [player(0, 'CHAOS INCARNATE'), player(1, 'Red Foundations')],
          decks: {
            p0: [version('p0', { commander: 'Kardur, Doomscourge', cardListStatus: 'VERIFIED', sourceDate: '2022-10-20', sourceCitation: 'WotC' })],
            p1: [version('p1')],
          },
          rules: [{ ruleKey: 'rollover', value: { confirmed: false }, status: 'PENDING', note: 'not confirmed', updatedAt: '' }],
          ledger: [], purchases: [], observations: [],
        },
      };
    };
    render(createElement(MagicView, { section: 'league' }));
    await waitFor(() => expect(screen.getByText('Precon Commander League')).toBeTruthy());
    expect(screen.getByText(/commander UNKNOWN/)).toBeTruthy();
    expect(screen.getAllByText(/unverified cardlist/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Source: WotC \(2022-10-20\)/)).toBeTruthy();
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
  });

  it('renders matchups with the empirical label and the sample size', async () => {
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (path(url) === '/api/magic/leagues') return { body: { leagues: [{ id: 'l1' }] } };
      return {
        body: {
          owner: {
            label: 'CHAOS INCARNATE', commander: 'Kardur, Doomscourge', unknownCards: 0,
            goadInPod: { goad: 'USEFUL', note: 'pod note' }, goadIn1v1: { goad: 'WEAK_OR_HARMFUL', note: 'duel note' },
            ownLifeLossTrigger: 'The deck has its own life-loss effects.',
          },
          opponents: [{
            playerId: 'p4', label: 'Undead Girl / Grave Danger', commander: 'Gisa and Geralf', cardListStatus: 'VERIFIED', versions: 1,
            observedTraits: { noncombatDrain: true }, attackOnlyDefenseStopsThem: false, goadAgainstThem: null,
            record: { games: 2, ownerPoints: 3, ownerPointsPerGame: 1.5, label: 'EMPIRICAL_MATCH_RESULT' },
          }],
          note: 'nothing here is a win probability',
        },
      };
    };
    render(createElement(MagicView, { section: 'matchups' }));
    await waitFor(() => expect(screen.getByText('Undead Girl / Grave Danger')).toBeTruthy());
    expect(screen.getByText('WEAK_OR_HARMFUL')).toBeTruthy();
    expect(screen.getByText(/\(EMPIRICAL_MATCH_RESULT\)/)).toBeTruthy();
    expect(screen.getByText(/n = 2/)).toBeTruthy();
  });

  it('shows a retryable error with a working retry button', async () => {
    let fail = true;
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (fail) return { status: 503, body: { error: 'Database busy', retryable: true } };
      return { body: { collection: [] } };
    };
    render(createElement(MagicView, { section: 'collection' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Retrying: Database busy/));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    await waitFor(() => expect(screen.getByText('Your collection is empty.')).toBeTruthy());
  });
});
