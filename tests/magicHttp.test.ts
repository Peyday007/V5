/**
 * Magic Deck Lab's door, over a real socket, on the committed fixture catalog.
 *
 * What matters here is the seam: that a second person reading or writing the
 * first person's deck or league gets the same bytes a nonexistent id gets, that
 * a worker is refused by type, that validate, analyze, optimize and the league
 * work end to end, and that a database that did not answer is a retryable 503
 * rather than a result.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { loadMagicFixtures } from './helpers/magicFixtures.ts';
import { createUser } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { magicRouter } from '../server/routes/magic.ts';
import { apiNotFound, errorMiddleware } from '../server/routes/helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { Principal } from '../server/domain/types.ts';

let server: Server | null = null;
let base = '';
let current: Principal | null = null;
let alice = '';
let bob = '';

function person(id: string, name: string): Principal {
  return {
    type: 'HUMAN', id, handle: `${name}@example.test`, displayName: name, isBrainAdmin: false, mustChangePassword: false,
    credentialId: `ses_${name}`, authMethod: 'SESSION_COOKIE', memberships: [], requestId: 'req',
  } as Principal;
}

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

const LIST = 'Commander\n1 Kardur, Doomscourge\n\nDeck\n1 Sol Ring\n1 Lightning Bolt\n1 Mountain\n';

async function importDeck(): Promise<string> {
  const r = await call('POST', '/magic/decks/import', { name: 'Test', format: 'COMMANDER', text: LIST });
  expect(r.status).toBe(201);
  return r.body.deck.id as string;
}

describe('refusals', () => {
  it('a worker is refused by type, with the same answer as no such route', async () => {
    current = { ...person(alice, 'w'), type: 'WORKER' } as Principal;
    const r = await call('GET', '/magic/decks');
    expect(r.status).toBe(404);
    current = person(alice, 'alice');
    expect(r.body).toEqual({ error: 'No such route.' });
  });

  it('a second person gets, byte for byte, what a nonexistent id gets', async () => {
    const deckId = await importDeck();
    const league = (await call('GET', '/magic/leagues')).body.leagues[0].id as string;
    current = person(bob, 'bob');
    const probes: [string, string, unknown?][] = [
      ['GET', `/magic/decks/${deckId}`], ['GET', `/magic/decks/${deckId}/versions`], ['GET', `/magic/decks/${deckId}/export`],
      ['POST', `/magic/decks/${deckId}/undo`], ['POST', `/magic/decks/${deckId}/versions`, { cards: [{ cardName: 'Sol Ring' }] }],
      ['GET', `/magic/leagues/${league}`], ['PATCH', `/magic/leagues/${league}`, { name: 'mine now' }],
      ['GET', `/magic/leagues/${league}/games`], ['POST', `/magic/leagues/${league}/observations`, { kind: 'NOTE', observedOn: '2026-11-01' }],
    ];
    for (const [method, path, body] of probes) {
      const foreign = await call(method, path, body);
      const absent = await call(method, path.replace(deckId, 'mdk_nonexistent').replace(league, 'mlg_nonexistent'), body);
      expect(foreign.status, path).toBe(404);
      expect(foreign.text, path).toBe(absent.text);
    }
    expect((await call('POST', '/magic/validate', { deckId })).text).toBe((await call('POST', '/magic/validate', { deckId: 'mdk_nonexistent' })).text);
    expect((await call('GET', '/magic/decks')).body.decks).toEqual([]);
    current = person(alice, 'alice');
    expect((await call('GET', `/magic/leagues/${league}`)).body.league.name).toBe('Precon Commander League');
  });
});

describe('end to end on the fixture catalog', () => {
  it('imports, validates, analyzes, versions and exports', async () => {
    const deckId = await importDeck();
    const v = await call('POST', '/magic/validate', { deckId });
    expect(v.status).toBe(200);
    expect(v.body.validation.ok).toBe(false); // a 4-card Commander list is not 100
    expect(v.body.validation.issues.some((i: any) => i.code === 'DECK_SIZE')).toBe(true);
    const inline = await call('POST', '/magic/validate', { format: 'STANDARD', cards: [{ cardName: 'Lightning Bolt', quantity: 5 }] });
    expect(inline.body.validation.issues.some((i: any) => i.code === 'COPY_LIMIT')).toBe(true);

    const a = await call('POST', '/magic/analyze', { deckId, simulationRuns: 50, seed: 7 });
    expect(a.status).toBe(200);
    expect(a.body.analysis.commanderZone).toEqual(['Kardur, Doomscourge']);
    expect(a.body.analysis.librarySize).toBe(3);

    const saved = await call('POST', `/magic/decks/${deckId}/versions`, { cards: [{ cardName: 'Kardur, Doomscourge', zone: 'commander' }, { cardName: 'Sol Ring' }], reason: 'trim' });
    expect(saved.status).toBe(201);
    const versions = (await call('GET', `/magic/decks/${deckId}/versions`)).body.versions;
    expect(versions).toHaveLength(2);
    expect((await call('POST', `/magic/decks/${deckId}/undo`)).status).toBe(200);
    const d = await call('GET', `/magic/decks/${deckId}/diff?from=${versions[0].id}&to=${versions[1].id}`);
    expect(d.status).toBe(200);
    expect((await call('GET', `/magic/decks/${deckId}/export`)).body.text).toContain('Sol Ring');
  });

  it('optimizes a saved deck against a named pool, with the baseline comparison', async () => {
    const deckId = await importDeck();
    const r = await call('POST', '/magic/optimize', { deckId, poolNames: ['Lightning Bolt', 'Sol Ring', 'Not A Card'], maxSwaps: 1, constraints: { priceCeilingCents: 100000 } });
    expect(r.status).toBe(200);
    expect(r.body.optimization.comparison).toMatch(/unchanged deck|baseline|recommended/i);
    expect(r.body.unknownPoolNames).toEqual(['Not A Card']);
    expect((await call('POST', '/magic/optimize', { deckId })).status).toBe(422);
  });

  it('turns an idea into a conflict with alternatives, then a decision', async () => {
    const r = await call('POST', '/magic/design/intent', { idea: 'extremely defensive Commander deck, lots of ways to stop threats, lifegain, but able to finish games quickly' });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('NEEDS_DECISION');
    expect(r.body.alternatives.length).toBeGreaterThanOrEqual(2);
    const build = await call('POST', '/magic/design/build', { intent: r.body.intent, poolNames: ['Sol Ring'] });
    expect(build.status).toBe(422);
    const chosen = await call('POST', '/magic/design/choose', { intent: r.body.intent, alternativeId: r.body.alternatives[0].id });
    expect(chosen.body.state).toBe('COHERENT');
    expect((await call('POST', '/magic/design/choose', { intent: r.body.intent, alternativeId: 'nonsense' })).status).toBe(422);
  });

  it('seeds the league once, in the owner scope, and keeps an edit', async () => {
    const first = (await call('GET', '/magic/leagues')).body.leagues;
    expect(first).toHaveLength(1);
    const id = first[0].id as string;
    const detail = (await call('GET', `/magic/leagues/${id}`)).body;
    expect(detail.players).toHaveLength(7);
    expect(detail.players.map((p: any) => p.label)).toEqual(expect.arrayContaining(['CHAOS INCARNATE', 'Red Foundations', 'Token Triumph']));
    expect(detail.rules.find((r: any) => r.ruleKey === 'rollover').status).toBe('PENDING');
    const red = detail.players.find((p: any) => p.label === 'Red Foundations');
    expect(detail.decks[red.id][0].cardListStatus).toBe('UNVERIFIED');
    await call('PATCH', `/magic/leagues/${id}/players/${red.id}`, { label: 'Red Foundations (edited)' });
    await call('GET', '/magic/leagues');
    await call('GET', '/magic/leagues');
    const again = (await call('GET', `/magic/leagues/${id}`)).body;
    expect((await call('GET', '/magic/leagues')).body.leagues).toHaveLength(1);
    expect(again.players.find((p: any) => p.id === red.id).label).toBe('Red Foundations (edited)');
    current = person(bob, 'bob');
    expect((await call('GET', '/magic/leagues')).body.leagues[0].id).not.toBe(id);
  });

  it('prices: a Scryfall figure is an estimate, a person entry is confirmed, 10.01 is not eligible', async () => {
    const printing = (await getDb().get<{ id: string }>("SELECT id FROM magic_printings WHERE price_usd_cents IS NOT NULL LIMIT 1"))!.id;
    expect((await call('GET', `/magic/prices/printings/${printing}`)).body.reading.status).toBe('ESTIMATE');
    expect((await call('POST', `/magic/prices/printings/${printing}/snapshots`, { priceCents: 1001, source: 'Scryfall', observedOn: '2026-11-01' })).status).toBe(422);
    const ok = await call('POST', `/magic/prices/printings/${printing}/snapshots`, { priceCents: 1000, source: 'LGS', observedOn: '2026-11-01', lock: true });
    expect(ok.status).toBe(201);
    const elig = await call('POST', '/magic/prices/eligibility', { printingIds: [printing] });
    expect(elig.body.eligibility.eligible).toBe(true);
    await call('POST', `/magic/prices/printings/${printing}/snapshots`, { priceCents: 1001, source: 'LGS', observedOn: '2026-11-02', lock: true });
    expect((await call('POST', '/magic/prices/eligibility', { printingIds: [printing] })).body.eligibility.eligible).toBe(false);
  });

  it('reports the catalog with its stale label', async () => {
    const s = await call('GET', '/magic/catalog/status');
    expect(s.status).toBe(200);
    expect(s.body.cards).toBeGreaterThan(0);
    const found = await call('GET', '/magic/catalog/cards?name=Sol%20Ring');
    expect(found.body.kind).toBe('FOUND');
    expect(found.body.status).toHaveProperty('stale');
  });
});

describe('a dependency that did not answer', () => {
  it('is a retryable 503, never a green result', async () => {
    const db = getDb();
    vi.spyOn(db, 'get').mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    vi.spyOn(db, 'all').mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    for (const [method, path, body] of [['GET', '/magic/catalog/status'], ['GET', '/magic/decks'], ['POST', '/magic/validate', { format: 'STANDARD', cards: [{ cardName: 'Sol Ring' }] }]] as [string, string, unknown?][]) {
      const r = await call(method, path, body);
      expect(r.status, path).toBe(503);
      expect(r.body.retryable).toBe(true);
    }
  });
});
