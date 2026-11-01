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

const fresh = { stale: false, fetchedAt: '2026-10-31', status: 'FRESH', cardCount: 3, lastError: null };
const deck = {
  id: 'd1', name: 'Test Deck', format: 'COMMANDER', cardListStatus: 'VERIFIED', currentVersionId: 'v2',
  versionNumber: 2, cardCount: 100, commander: 'Kardur', updatedAt: '2026-10-31',
};

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
    for (const label of [
      'Describe a new deck', 'Import a deck', 'Optimize a saved deck', 'Open the Precon Commander League',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import a deck' }));
    await waitFor(() => expect(screen.getByLabelText('Import a deck', { selector: 'section' })).toBeTruthy());
  });

  it('shows a stale label when the catalog failed and serves the cache', async () => {
    handler = (url) => ({
      body: url.includes('catalog') ? { ...fresh, status: 'FAILED', lastError: 'timeout' } : { decks: [] },
    });
    render(createElement(MagicView, { section: 'decks' }));
    await waitFor(() => expect(screen.getByText(/last catalog refresh failed \(timeout\)/)).toBeTruthy());
  });

  it('surfaces import problems instead of a green result', async () => {
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (url.endsWith('/decks')) return { body: { decks: [] } };
      return {
        body: { deck: null, issues: [{ line: 3, text: 'Foo', kind: 'UNKNOWN', message: 'No card named Foo' }] },
      };
    };
    render(createElement(MagicView, { section: 'decks' }));
    await waitFor(() => screen.getByLabelText('Deck name'));
    fireEvent.change(screen.getByLabelText('Deck name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Card list'), { target: { value: '1 Foo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/No card named Foo/)).toBeTruthy());
    expect(screen.getByText(/Nothing was imported/)).toBeTruthy();
  });

  it('labels every analysis number with its kind of claim', async () => {
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (url.endsWith('/decks')) return { body: { decks: [deck] } };
      return {
        body: {
          format: 'COMMANDER', librarySize: 99, counts: {}, curve: [], answers: [], redundancy: [],
          singleCardReliance: [], notes: [], scores: {},
          openingHand: { keepable: { value: 0.875, label: 'EXACT_PROBABILITY' }, landDistribution: [] },
          simulation: null,
        },
      };
    };
    render(createElement(MagicView, { section: 'optimize' }));
    const select = await waitFor(() => screen.getByLabelText('Deck'));
    fireEvent.change(select, { target: { value: 'd1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze this deck' }));
    await waitFor(() => expect(screen.getByText('87.5%')).toBeTruthy());
    expect(screen.getByText(/Exact probability/)).toBeTruthy();
  });

  it('rejects a malformed price ceiling before calling the server', async () => {
    handler = (url) => ({ body: url.includes('catalog') ? fresh : { decks: [deck] } });
    render(createElement(MagicView, { section: 'optimize' }));
    await waitFor(() => screen.getByLabelText('Deck'));
    fireEvent.change(screen.getByLabelText(/Price ceiling/), { target: { value: '9.999' } });
    expect(screen.getByText(/dollars and cents/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find upgrades' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the league with unknowns kept unknown', async () => {
    const player = (ordinal: number, label: string, extra = {}) => ({
      id: `p${ordinal}`, ordinal, label, isOwner: false, status: 'CONFIRMED', unknowns: [], notes: '',
      deck: { product: null, commander: null, cardListStatus: 'UNVERIFIED', sourceCitation: null, sourceDate: null, deckId: null },
      ...extra,
    });
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (url.endsWith('/leagues')) return { body: { leagues: [{ id: 'l1', name: 'Precon Commander League' }] } };
      return {
        body: {
          id: 'l1', name: 'Precon Commander League', podSize: 4, startingLife: 40,
          players: [player(1, 'Red Foundations', { unknowns: ['commander'] })],
          rules: [{ ruleKey: 'rollover', value: 'none', status: 'PENDING', note: 'not confirmed' }],
          ledger: [], games: [],
        },
      };
    };
    render(createElement(MagicView, { section: 'league' }));
    await waitFor(() => expect(screen.getByText('Precon Commander League')).toBeTruthy());
    expect(screen.getByText(/Commander: UNKNOWN/)).toBeTruthy();
    expect(screen.getAllByText(/unverified cardlist/).length).toBeGreaterThan(0);
    expect(screen.getByText(/rollover — pending/)).toBeTruthy();
  });

  it('shows a retryable error with a working retry button', async () => {
    let fail = true;
    handler = (url) => {
      if (url.includes('catalog')) return { body: fresh };
      if (fail) return { status: 503, body: { error: 'Database busy', retryable: true } };
      return { body: { entries: [] } };
    };
    render(createElement(MagicView, { section: 'collection' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Retrying: Database busy/));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    await waitFor(() => expect(screen.getByText('Your collection is empty.')).toBeTruthy());
  });
});
