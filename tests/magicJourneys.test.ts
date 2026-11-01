/**
 * Eight journeys through Magic Deck Lab's door, on the committed fixture
 * catalog, in-process. The same file runs against SQLite and, under
 * `npm run test:pg`, against Postgres: nothing here names a backend.
 *
 *  1  describe a deck in words, meet the conflict, choose, and build
 *  2  import a list, validate it, analyze it
 *  3  optimize a saved deck under a price ceiling
 *  4  price a printing: estimate, confirmed entry, the $10.00 / $10.01 line
 *  5  first visit to the league: the workspace is already there
 *  6  log a game: the owner scores 3, not 4
 *  7  observe a replacement commander: the baseline version is untouched
 *  8  a second person, a stale catalog and an unavailable database
 *
 * The last test reads docs/MAGIC.md against the router and the table list, so
 * the document cannot drift from what the feature is.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { loadMagicFixtures } from './helpers/magicFixtures.ts';
import { createUser } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { magicRouter } from '../server/routes/magic.ts';
import { apiNotFound, errorMiddleware } from '../server/routes/helpers.ts';
import { getDb } from '../server/db/database.ts';
import { scoreGame } from '../server/services/magic/league/scoring.ts';
import { MAGIC_TABLES } from '../server/domain/magicTypes.ts';
import type { Principal } from '../server/domain/types.ts';

let server: Server | null = null;
let base = '';
let current: Principal | null = null;
let alice = '';
let bob = '';

const person = (id: string, name: string): Principal => ({
  type: 'HUMAN', id, handle: `${name}@example.test`, displayName: name, isBrainAdmin: false, mustChangePassword: false,
  credentialId: `ses_${name}`, authMethod: 'SESSION_COOKIE', memberships: [], requestId: 'req',
} as Principal);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, text, body: parsed };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, { principal: current, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', magicRouter, apiNotFound, errorMiddleware);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); });

beforeEach(async () => {
  await freshProject();
  await loadMagicFixtures();
  const mk = async (n: string) => (await createUser({ email: `${n}-${Math.random().toString(36).slice(2, 8)}@example.com`, displayName: n, password: 'a-long-enough-password' })).id;
  alice = await mk('alice');
  bob = await mk('bob');
  current = person(alice, 'alice');
  vi.restoreAllMocks();
});

async function workspace() {
  const leagues = (await call('GET', '/magic/leagues')).body.leagues;
  const detail = (await call('GET', `/magic/leagues/${leagues[0].id}`)).body;
  const byLabel = (label: string) => detail.players.find((p: any) => p.label === label);
  return { id: leagues[0].id as string, detail, byLabel };
}

describe('journey 1: describe a deck in words', () => {
  it('meets a named conflict with alternatives, chooses one, and is allowed to build', async () => {
    const idea = 'extremely defensive Commander deck, lots of ways to stop threats, lifegain, but able to finish games quickly';
    const first = await call('POST', '/magic/design/intent', { idea });
    expect(first.body.state).toBe('NEEDS_DECISION');
    expect(first.body.conflicts[0].name).toMatch(/defensive/i);
    expect(first.body.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(first.body.question.options.length).toBe(first.body.alternatives.length);
    expect((await call('POST', '/magic/design/build', { intent: first.body.intent, poolNames: ['Sol Ring'] })).status).toBe(422);
    const chosen = await call('POST', '/magic/design/choose', { intent: first.body.intent, alternativeId: first.body.alternatives[0].id, intentId: first.body.intentId });
    expect(chosen.body.state).toBe('COHERENT');
    expect(chosen.body.question).toBeNull();
    const refined = await call('POST', '/magic/design/refine', { intent: chosen.body.intent, utterance: 'under $50' });
    expect(refined.body.intent.budgetCents).toBe(5000);
  });
});

describe('journey 2: import, validate, analyze', () => {
  it('surfaces what is wrong instead of passing it', async () => {
    const imp = await call('POST', '/magic/decks/import', { name: 'Kardur', format: 'COMMANDER', text: 'Commander\n1 Kardur, Doomscourge\n\nDeck\n1 Sol Ring\n1 Mountain\n1 Nonexistent Card\n' });
    expect(imp.status).toBe(201);
    expect(imp.body.clean).toBe(false);
    expect(imp.body.resolutionIssues.some((i: any) => i.code === 'UNKNOWN_CARD')).toBe(true);
    const deckId = imp.body.deck.id as string;
    const v = (await call('POST', '/magic/validate', { deckId })).body.validation;
    expect(v.ok).toBe(false);
    expect(v.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['DECK_SIZE']));
    const a = await call('POST', '/magic/analyze', { format: 'COMMANDER', cards: [{ zone: 'commander', cardName: 'Kardur, Doomscourge' }, { cardName: 'Sol Ring' }, { cardName: 'Mountain', quantity: 30 }], simulationRuns: 0 });
    expect(a.status).toBe(200);
    expect(a.body.analysis.commanderZone).toEqual(['Kardur, Doomscourge']);
    expect(a.body.analysis.librarySize).toBe(31);
    expect(a.body.analysis.scores.closing.label).toBe('HEURISTIC_SCORE');
  });
});

describe('journey 3: optimize a saved deck', () => {
  it('compares to the unchanged baseline and refuses a pool it was not given', async () => {
    const deckId = (await call('POST', '/magic/decks/import', { name: 'D', format: 'COMMANDER', text: 'Commander\n1 Kardur, Doomscourge\n\nDeck\n1 Mountain\n' })).body.deck.id as string;
    const r = await call('POST', '/magic/optimize', { deckId, poolNames: ['Lightning Bolt', 'Sol Ring'], maxSwaps: 1, constraints: { priceCeilingCents: 100000, protectedNames: ['Mountain'] } });
    expect(r.status).toBe(200);
    expect(r.body.optimization.baseline.build.swaps).toEqual([]);
    for (const b of r.body.optimization.candidates) for (const s of b.swaps) expect(s.cut).not.toBe('Mountain');
    expect(r.body.optimization.comparison).toMatch(/unchanged deck|recommended/i);
    expect((await call('POST', '/magic/optimize', { deckId })).status).toBe(422);
    expect((await call('GET', `/magic/decks/${deckId}/versions`)).body.versions).toHaveLength(1); // optimizing saves no version
  });
});

describe('journey 4: prices', () => {
  it('an estimate is not approvable; $10.00 passes and $10.01 does not', async () => {
    const printing = (await getDb().get<{ id: string }>('SELECT id FROM magic_printings WHERE price_usd_cents IS NOT NULL LIMIT 1'))!.id;
    const est = await call('GET', `/magic/prices/printings/${printing}`);
    expect(est.body.reading.status).toBe('ESTIMATE');
    expect((await call('POST', '/magic/prices/eligibility', { printingIds: [printing] })).body.eligibility.eligible).toBe(false);
    for (const [cents, ok] of [[999, true], [1000, true], [1001, false]] as const) {
      await call('POST', `/magic/prices/printings/${printing}/snapshots`, { priceCents: cents, source: 'LGS', observedOn: `2026-11-0${ok ? 1 : 2}`, lock: true });
      const elig = (await call('POST', '/magic/prices/eligibility', { printingIds: [printing] })).body.eligibility;
      expect(elig.eligible, String(cents)).toBe(ok);
    }
  });
});

describe('journey 5: the league is already there', () => {
  it('is seeded on first access with seven records and the pending rules visible', async () => {
    const { detail, byLabel } = await workspace();
    expect(detail.league.name).toBe('Precon Commander League');
    expect(detail.players).toHaveLength(7);
    expect(detail.league.pod_size).toBe(4);
    expect(detail.league.starting_life).toBe(40);
    expect(detail.rules.find((r: any) => r.ruleKey === 'rollover').status).toBe('PENDING');
    expect(detail.rules.find((r: any) => r.ruleKey === 'weekly_allowance_cents').value).toBe(1000);
    for (const label of ['Red Foundations', 'Green Foundations']) {
      const d = detail.decks[byLabel(label).id][0];
      expect(d.commander).toBeNull();
      expect(d.cardListStatus).toBe('UNVERIFIED');
    }
    const kardur = detail.decks[byLabel('CHAOS INCARNATE').id][0];
    expect(kardur.commander).toBe('Kardur, Doomscourge');
    expect(kardur.cardListStatus).toBe('VERIFIED');
    expect(kardur.sourceDate).toBe('2022-10-20');
    expect(kardur.sourceCitation).toContain('magic.wizards.com');
    // The baseline is a real 100-card deck in the deck store, commander in the command zone.
    const deck = await call('GET', `/magic/decks/${kardur.deckId}`);
    expect(deck.status).toBe(200);
    const cards = deck.body.version.cards as { zone: string; cardName: string; quantity: number }[];
    expect(cards.reduce((n, c) => n + c.quantity, 0)).toBe(100);
    expect(cards.filter((c) => c.zone === 'commander').map((c) => c.cardName)).toEqual(['Kardur, Doomscourge']);
    // Token Triumph and Grave Danger load their official 100; First Flight its 99 with the commander unknown.
    for (const [label, commander] of [['Token Triumph', 'Emmara, Soul of the Accord'], ['Undead Girl / Grave Danger', 'Gisa and Geralf']] as const) {
      const d = detail.decks[byLabel(label).id][0];
      expect(d.cardListStatus).toBe('VERIFIED');
      expect(d.commander).toBe(commander);
      expect(d.detail.cards).toBe(100);
    }
    const sky = detail.decks[byLabel('Sky Warden / First Flight').id][0];
    expect(sky.commander).toBeNull();
    expect(sky.detail.cards).toBe(99);
    expect(sky.detail.priorCommander).toBe('Isperia, Supreme Judge');
    expect(detail.decks[byLabel('Other Chaos Incarnate (provisional)').id][0].cardListStatus).toBe('UNVERIFIED');
  });

  it('seeds exactly once: a second visit adds no league, player or deck', async () => {
    await workspace();
    const before = (await call('GET', '/magic/decks')).body.decks.length;
    const again = await workspace();
    expect(again.detail.players).toHaveLength(7);
    expect((await call('GET', '/magic/leagues')).body.leagues).toHaveLength(1);
    expect((await call('GET', '/magic/decks')).body.decks.length).toBe(before);
  });
});

describe('journey 6: a game, scored', () => {
  it("credits the owner 3, not 4: a goaded kill belongs to the attacker's controller", async () => {
    const { id, byLabel } = await workspace();
    const owner = byLabel('CHAOS INCARNATE').id as string;
    const red = byLabel('Red Foundations').id as string;
    const green = byLabel('Green Foundations').id as string;
    const tokens = byLabel('Token Triumph').id as string;
    const scored = scoreGame([
      { eliminated: red, cause: 'OWN_TRIGGER', creditedTo: owner },
      { eliminated: green, cause: 'FORCED_ATTACK', creditedTo: tokens, forcedBy: owner },
      { eliminated: tokens, cause: 'OWN_SPELL_OR_ABILITY', creditedTo: owner },
    ]);
    expect(scored.totals[owner]).toBe(3);
    expect(scored.totals[owner]).not.toBe(4);
    expect(scored.totals[tokens]).toBe(1);

    const game = await call('POST', `/magic/leagues/${id}/games`, {
      playedOn: '2026-11-01', turns: 9, outcome: 'Owner won', notes: 'Goad made the middle kill.',
      participants: [owner, red, green, tokens].map((playerId, seat) => ({ playerId, seat, keyCards: playerId === owner ? ['Kardur, Doomscourge'] : [], lifeSnapshots: [{ turn: 5, life: 31 }] })),
      eliminations: scored.rows.map((row, i) => ({
        eliminatedPlayerId: row.eliminated, orderIndex: i, causeSource: i === 1 ? 'goaded attack' : 'Kardur trigger', creditedPlayerId: row.creditedTo,
        sourceControllerPlayerId: row.creditedTo, points: row.points, attribution: i === 1 ? 'FORCED_ATTACK' : 'OWN_SOURCE', note: row.note,
      })),
    });
    expect(game.status).toBe(201);

    const log = (await call('GET', `/magic/leagues/${id}/games`)).body;
    expect(log.games).toHaveLength(1);
    expect(log.games[0].participants).toHaveLength(4);
    expect(log.games[0].eliminations.map((e: any) => [e.credited_player_id, Number(e.points)])).toEqual([[owner, 1], [tokens, 1], [owner, 2]]);
    expect(log.games[0].eliminations[1].attribution).toBe('FORCED_ATTACK');
    expect(log.standings.find((s: any) => s.player === owner).points).toBe(3);
    expect(log.standings.find((s: any) => s.player === tokens).points).toBe(1);
  });
});

describe('journey 7: a replacement commander is observed', () => {
  it('adds a version and leaves the baseline exactly as it was', async () => {
    const { id, byLabel, detail } = await workspace();
    const sky = byLabel('Sky Warden / First Flight').id as string;
    const before = detail.decks[sky];
    expect(before).toHaveLength(1);
    expect(before[0].commander).toBeNull(); // UNKNOWN until observed
    expect(before[0].isBaseline).toBe(true);

    const obs = await call('POST', `/magic/leagues/${id}/observations`, { playerId: sky, kind: 'COMMANDER', label: 'OBSERVED', detail: { commander: 'Aesi, Tyrant of Gyre Strait' }, observedOn: '2026-11-08' });
    expect(obs.status).toBe(201);
    const next = await call('POST', `/magic/leagues/${id}/players/${sky}/decks`, { commander: 'Aesi, Tyrant of Gyre Strait', cardListStatus: 'UNVERIFIED', observedAt: '2026-11-08', detail: { priorCommander: before[0].commander, candidateContext: 'replacement observed' } });
    expect(next.status).toBe(201);

    const after = (await call('GET', `/magic/leagues/${id}`)).body;
    const versions = after.decks[sky];
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual(before[0]); // the baseline row is byte-for-byte what it was
    expect(versions[1].parentLeagueDeckId).toBe(before[0].id);
    expect(versions[1].commander).toBe('Aesi, Tyrant of Gyre Strait');
    expect(versions[1].isBaseline).toBe(false);
    expect(after.observations).toHaveLength(1);
    // Other players' decks did not move.
    expect(after.decks[byLabel('Red Foundations').id]).toHaveLength(1);
  });
});

describe('journey 8: another person, a stale catalog, an unavailable database', () => {
  it('keeps one person out of another’s league and says when the catalog is stale', async () => {
    const { id } = await workspace();
    current = person(bob, 'bob');
    expect((await call('GET', `/magic/leagues/${id}`)).text).toBe((await call('GET', '/magic/leagues/mlg_nonexistent')).text);
    expect((await call('GET', '/magic/leagues')).body.leagues[0].id).not.toBe(id);
    current = person(alice, 'alice');

    // Cards are loaded but nothing records a successful fetch of the live source, so the catalog cannot claim to be fresh.
    const status = (await call('GET', '/magic/catalog/status')).body;
    expect(status.stale).toBe(true);
    expect(status.state).toBe('STALE');
    expect(String(status.reason).length).toBeGreaterThan(0);
    expect((await call('GET', '/magic/catalog/cards?name=Sol%20Ring')).body.status.stale).toBe(true);

    vi.spyOn(getDb(), 'all').mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const down = await call('GET', '/magic/decks');
    expect(down.status).toBe(503);
    expect(down.body.retryable).toBe(true);
  });
});

describe('docs/MAGIC.md', () => {
  const doc = fs.readFileSync(new URL('../docs/MAGIC.md', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../server/routes/magic.ts', import.meta.url), 'utf8');

  it('names every endpoint the router serves', () => {
    const routes = [...source.matchAll(/magicRouter\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} /api${m[2]}`);
    expect(routes.length).toBeGreaterThan(30);
    for (const route of routes) expect(doc, route).toContain(route);
  });

  it('names every table, and every number label', () => {
    for (const t of MAGIC_TABLES) expect(doc, t).toContain(t);
    for (const label of ['EXACT_PROBABILITY', 'MODEL_ESTIMATE', 'HEURISTIC_SCORE', 'EMPIRICAL_MATCH_RESULT', 'CONFIRMED', 'ESTIMATE']) expect(doc, label).toContain(label);
  });
});
