/**
 * Magic Deck Lab with nothing scripted between the button and the row.
 *
 * `magicPage.test.tsx` renders the real page over a scripted `fetch`, and
 * `magicJourneys.test.ts` drives the real routes with no screen. Neither can
 * see the seam between them — and that seam is exactly where the first version
 * of the client failed: it was written against routes, methods and shapes the
 * server never had, so every scripted suite passed while production would have
 * answered almost every press with a 404. This mounts the actual `MagicView`,
 * points `fetch` at a real Express app holding the actual `magicRouter` over a
 * fresh database loaded with the committed fixture catalog, presses the
 * controls a person would, and asserts what the screen says and what the rows
 * say afterwards.
 *
 * No network: the catalog auto-refresh is disabled under Vitest and nothing
 * here presses "Refresh card catalog", which would ask Scryfall.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { loadMagicFixtures } from './helpers/magicFixtures.ts';
import { createUser } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { magicRouter } from '../server/routes/magic.ts';
import { apiNotFound, errorMiddleware } from '../server/routes/helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { Principal } from '../server/domain/types.ts';

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

const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { MagicView } = await import('../client/src/russell/Magic.tsx');

type Section = 'design' | 'decks' | 'league' | 'matchups' | 'collection' | 'exports' | 'optimize';

let server: Server | null = null;
let userId = '';
const realFetch = globalThis.fetch;

function principal(): Principal {
  return {
    type: 'HUMAN', id: userId, handle: 'owner@example.test', displayName: 'Owner', isBrainAdmin: false,
    mustChangePassword: false, credentialId: 'ses_magic_browser', authMethod: 'SESSION_COOKIE', memberships: [], requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  await freshProject();
  await loadMagicFixtures();
  userId = (await createUser({
    email: `magic-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  })).id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, { principal: principal(), requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', magicRouter, apiNotFound, errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  // The one substitution is the address, never the answer.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    return realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function mount(section: Section): Promise<void> {
  await act(async () => {
    render(createElement(MagicView, { section, onNavigate: () => {} }));
  });
}

async function click(name: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(button);
  });
}

async function type(label: string | RegExp, value: string): Promise<void> {
  const field = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

const PLAYERS = [
  'CHAOS INCARNATE',
  'Red Foundations',
  'Other Chaos Incarnate (provisional)',
  'Sky Warden / First Flight',
  'Undead Girl / Grave Danger',
  'Green Foundations',
  'Token Triumph',
];

describe('Magic Deck Lab, browser to database', () => {
  it('renders the catalog banner from the real status', async () => {
    await mount('collection');
    // Nine fixture cards are loaded, but nothing records a fetch of the live source, so the server calls it stale.
    const banner = await screen.findByLabelText('Card catalog', { selector: 'section' });
    await waitFor(() => expect(banner.textContent).toMatch(/Stale card catalog \(9 cards/));
    expect(within(banner).getByRole('button', { name: 'Refresh card catalog' })).toBeTruthy();
  });

  it('opens the seeded league: seven players, Kardur verified from the 2022-10-20 list', async () => {
    await mount('league');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Precon Commander League' })).toBeTruthy(), { timeout: 20_000 });
    for (const label of PLAYERS) expect(screen.getByLabelText(label, { selector: 'li' })).toBeTruthy();
    const kardur = screen.getByLabelText('CHAOS INCARNATE', { selector: 'li' });
    expect(kardur.textContent).toMatch(/commander Kardur, Doomscourge/);
    expect(kardur.textContent).toMatch(/verified card list/);
    expect(kardur.textContent).toMatch(/2022-10-20/);
    const sky = screen.getByLabelText('Sky Warden / First Flight', { selector: 'li' });
    expect(sky.textContent).toMatch(/commander UNKNOWN/);
    expect(sky.textContent).toMatch(/printed commander: Isperia, Supreme Judge/);
    expect(screen.getByLabelText('Red Foundations', { selector: 'li' }).textContent).toMatch(/unverified cardlist/);
    // Rule statuses are visible as the server reported them.
    expect(screen.getAllByText('PENDING').length).toBeGreaterThan(0);
    const leagues = await getDb().all<{ id: string }>('SELECT id FROM magic_leagues WHERE owner_user_id = ?', [userId]);
    expect(leagues).toHaveLength(1);
  }, 30_000);

  it('records an observed commander for Sky Warden, which becomes a new version', async () => {
    await mount('league');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Precon Commander League' })).toBeTruthy(), { timeout: 20_000 });
    const sky = await getDb().get<{ id: string }>(
      `SELECT id FROM magic_league_players WHERE owner_user_id = ? AND label = 'Sky Warden / First Flight'`, [userId],
    );
    await type('Player', sky!.id);
    await type('Kind', 'COMMANDER');
    await type('Commander seen', 'Aesi, Tyrant of Gyre Strait');
    await type('Observed on', '2026-11-08');
    await click('Save observation');
    await waitFor(() => expect(screen.getByText(/is now on version 2/)).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByLabelText('Sky Warden / First Flight', { selector: 'li' }).textContent).toMatch(/v2: commander Aesi, Tyrant of Gyre Strait/),
    );
    const rows = await getDb().all<{ version_number: number; commander: string | null; is_baseline: number }>(
      'SELECT version_number, commander, is_baseline FROM magic_league_decks WHERE player_id = ? ORDER BY version_number', [sky!.id],
    );
    expect(rows.map((r) => [Number(r.version_number), r.commander, Number(r.is_baseline)])).toEqual([
      [1, null, 1],
      [2, 'Aesi, Tyrant of Gyre Strait', 0],
    ]);
    const obs = await getDb().all<{ kind: string; resulting_league_deck_id: string | null }>(
      'SELECT kind, resulting_league_deck_id FROM magic_observations WHERE player_id = ?', [sky!.id],
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.kind).toBe('COMMANDER');
    expect(obs[0]!.resulting_league_deck_id).not.toBeNull();
  }, 30_000);

  it('designs from a rough idea: a conflict, a choice, a build, a validation, and a saved deck', async () => {
    await mount('design');
    await type('What do you want the deck to do?', 'extremely defensive Commander deck, lots of ways to stop threats, lifegain, but able to finish games quickly');
    await click('Structure this idea');
    const conflicts = await screen.findByLabelText('Conflicts');
    expect(conflicts.textContent).toMatch(/defensive/i);
    expect(screen.getByText(/One decision:/)).toBeTruthy();
    // Nothing can be built while the conflict stands.
    expect(screen.queryByRole('button', { name: 'Build' })).toBeNull();
    const choices = within(screen.getByLabelText('Alternatives')).getAllByRole('button');
    expect(choices.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.click(choices[0]!);
    });
    await waitFor(() => expect(screen.getByText(/coherent — ready to build/)).toBeTruthy());
    await click('Build');
    const validation = await screen.findByLabelText('Validation', {}, { timeout: 20_000 });
    expect(validation.textContent).toMatch(/Legal in commander/);
    expect(screen.getByText(/Built from real cards \(100 cards\)/)).toBeTruthy();

    await type('Deck name', 'Defensive drain');
    await click('Save as a deck');
    await waitFor(() => expect(screen.getByText(/Saved “Defensive drain” as version 1/)).toBeTruthy());
    const intents = await getDb().all<{ state: string }>('SELECT state FROM magic_design_intents WHERE owner_user_id = ? ORDER BY created_at', [userId]);
    expect(intents.map((i) => i.state)).toEqual(['NEEDS_DECISION', 'COHERENT']);
    const deck = await getDb().get<{ id: string; format: string; current_version_id: string }>(
      `SELECT id, format, current_version_id FROM magic_decks WHERE owner_user_id = ? AND name = 'Defensive drain'`, [userId],
    );
    expect(deck?.format).toBe('COMMANDER');
    const total = await getDb().get<{ n: number }>('SELECT SUM(quantity) AS n FROM magic_deck_cards WHERE version_id = ?', [deck!.current_version_id]);
    expect(Number(total?.n)).toBe(100);
  }, 40_000);

  it('imports a list and reports the unknown name instead of passing it', async () => {
    await mount('decks');
    await type('Deck name', 'Kardur test');
    await type('Card list', 'Commander\n1 Kardur, Doomscourge\n\nDeck\n1 Sol Ring\n1 Nonexistent Card');
    await click('Import');
    const problems = await screen.findByLabelText('Import problems');
    expect(problems.textContent).toMatch(/unknown card/);
    expect(problems.textContent).toMatch(/Nonexistent Card/);
    expect(screen.getByLabelText('Import a deck', { selector: 'section' }).textContent).toMatch(/unverified cardlist/);
    const deck = await getDb().get<{ id: string; card_list_status: string; current_version_id: string }>(
      `SELECT id, card_list_status, current_version_id FROM magic_decks WHERE owner_user_id = ? AND name = 'Kardur test'`, [userId],
    );
    expect(deck?.card_list_status).toBe('UNVERIFIED');
    const names = (await getDb().all<{ card_name: string }>('SELECT card_name FROM magic_deck_cards WHERE version_id = ? ORDER BY card_name', [deck!.current_version_id]))
      .map((r) => r.card_name);
    expect(names).toEqual(expect.arrayContaining(['Kardur, Doomscourge', 'Sol Ring']));

    // Open it, validate it, and export it — each a real route.
    await click('Open the imported deck');
    const panel = await screen.findByLabelText('Deck Kardur test', { selector: 'section' });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Validate' }));
    });
    await waitFor(() => expect(within(panel).getByLabelText('Validation').textContent).toMatch(/Not legal/));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Export' }));
    });
    await waitFor(() =>
      expect((within(panel).getByLabelText(/Exported list/) as HTMLTextAreaElement).value).toMatch(/Commander\n1 Kardur, Doomscourge/),
    );
  }, 30_000);

  it('logs a game with eliminations and shows the standings from the rows', async () => {
    await mount('league');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Precon Commander League' })).toBeTruthy(), { timeout: 20_000 });
    const form = screen.getByLabelText('Log a game', { selector: 'section' });
    for (const label of ['CHAOS INCARNATE', 'Red Foundations', 'Green Foundations', 'Token Triumph']) {
      await act(async () => {
        fireEvent.click(within(form).getByLabelText(label));
      });
    }
    const players = await getDb().all<{ id: string; label: string }>('SELECT id, label FROM magic_league_players WHERE owner_user_id = ?', [userId]);
    const id = (label: string) => players.find((p) => p.label === label)!.id;
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Add an elimination' }));
    });
    await type('Elimination 1: who was eliminated', id('Red Foundations'));
    await type('Elimination 1: credited to', id('CHAOS INCARNATE'));
    await type('Elimination 1: cause', 'Kardur trigger');
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Add an elimination' }));
    });
    await type('Elimination 2: who was eliminated', id('Green Foundations'));
    await type('Elimination 2: credited to', id('Token Triumph'));
    await type('Elimination 2: attribution', 'FORCED_ATTACK');
    await type('Outcome', 'Owner won');
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save game' }));
    });
    await waitFor(() => expect(screen.getByText('Game saved.')).toBeTruthy());
    const games = screen.getByLabelText('Games', { selector: 'section' });
    await waitFor(() => expect(games.textContent).toMatch(/Owner won/));
    expect(games.textContent).toMatch(/Red Foundations eliminated by Kardur trigger \(OWN_SOURCE\)/);
    const elims = await getDb().all<{ credited_player_id: string; points: number; attribution: string }>(
      'SELECT credited_player_id, points, attribution FROM magic_eliminations ORDER BY order_index',
    );
    expect(elims.map((e) => [e.credited_player_id, Number(e.points), e.attribution])).toEqual([
      [id('CHAOS INCARNATE'), 1, 'OWN_SOURCE'],
      [id('Token Triumph'), 1, 'FORCED_ATTACK'],
    ]);
  }, 30_000);

  it('says why the next $10 cannot be evaluated, as a recoverable message', async () => {
    await mount('league');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Precon Commander League' })).toBeTruthy(), { timeout: 20_000 });
    await click('Evaluate next $10');
    // The official Kardur list names cards the nine-card fixture catalog does not hold.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not in the catalog/));
    expect(screen.getByRole('button', { name: 'Evaluate next $10' })).toBeTruthy();
  }, 30_000);

  it('renders matchups and keeps a collection', async () => {
    await mount('matchups');
    const table = await screen.findByRole('table', {}, { timeout: 20_000 });
    expect(table.textContent).toMatch(/Undead Girl \/ Grave Danger/);
    expect(table.textContent).toMatch(/EMPIRICAL_MATCH_RESULT/);
    expect(screen.getByText(/Goad in 1v1/)).toBeTruthy();
    cleanup();

    await mount('collection');
    await type('Card name', 'sol ring');
    await type('Quantity', '2');
    await click('Save to collection');
    await waitFor(() => expect(screen.getByText(/2 × Sol Ring — owned/)).toBeTruthy());
    const row = await getDb().get<{ card_name: string; quantity: number; status: string }>(
      'SELECT card_name, quantity, status FROM magic_collections WHERE owner_user_id = ?', [userId],
    );
    expect([row?.card_name, Number(row?.quantity), row?.status]).toEqual(['Sol Ring', 2, 'OWNED']);
  }, 30_000);
});
