import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import {
  appendLeagueDeck, appendObservation, ensureBaselineDeck, ensureLeague, ensurePlayer, ensureRule, getGame, listLeagueDecks,
  listLeagues, listObservations, listPlayers, listRules, recordGame, setRule, updatePlayer,
} from '../server/repos/magicLeague.ts';

let owner = '';
beforeEach(async () => {
  await freshProject();
  owner = (await createUser({ email: `o-${Math.random().toString(36).slice(2, 8)}@example.com`, displayName: 'o', password: 'a-long-enough-password' })).id;
});

async function seed() {
  const league = await ensureLeague(owner, { seedKey: 'precon', name: 'Precon Commander League' });
  await ensureRule(owner, league.id, { ruleKey: 'weekly_allowance_cents', value: 1000, status: 'CONFIRMED' });
  await ensureRule(owner, league.id, { ruleKey: 'rollover', value: 'none', status: 'PENDING' });
  const p1 = (await ensurePlayer(owner, league.id, { seedKey: 'owner', ordinal: 0, label: 'Chaos Incarnate', isOwner: true }))!;
  const p2 = (await ensurePlayer(owner, league.id, { seedKey: 'red', ordinal: 1, label: 'Red Foundations', unknowns: ['product', 'commander', 'list'] }))!;
  await ensureBaselineDeck(owner, p1.id, { cardListStatus: 'VERIFIED', commander: 'Kardur, Doomscourge' });
  await ensureBaselineDeck(owner, p2.id, { cardListStatus: 'UNVERIFIED' });
  return { league, p1, p2 };
}

describe('league seeding', () => {
  it('is idempotent and never overwrites an edit', async () => {
    const { league, p2 } = await seed();
    await updatePlayer(owner, p2.id, { label: 'Red Foundations (edited)' });
    await setRule(owner, league.id, { ruleKey: 'rollover', value: 'none', status: 'CONFIRMED', note: 'owner confirmed' });
    await seed();
    await seed();
    expect(await listLeagues(owner)).toHaveLength(1);
    expect(await listPlayers(owner, league.id)).toHaveLength(2);
    expect((await listPlayers(owner, league.id))[1]?.label).toBe('Red Foundations (edited)');
    expect((await listRules(owner, league.id)).find((r) => r.ruleKey === 'rollover')?.status).toBe('CONFIRMED');
    expect(await listLeagueDecks(owner, p2.id)).toHaveLength(1);
  });
  it('keeps the baseline when a later observation adds a version', async () => {
    const { p2 } = await seed();
    const observed = await appendLeagueDeck(owner, p2.id, { cardListStatus: 'HYPOTHESIS', commander: 'Revealed Commander', observedAt: '2026-11-03' });
    const all = await listLeagueDecks(owner, p2.id);
    expect(all.map((d) => d.versionNumber)).toEqual([1, 2]);
    expect(all[0]?.isBaseline).toBe(true);
    expect(all[0]?.cardListStatus).toBe('UNVERIFIED');
    expect(observed?.parentLeagueDeckId).toBe(all[0]?.id);
    expect(observed?.isBaseline).toBe(false);
  });
});

describe('games', () => {
  it('writes a game with participants and eliminations atomically', async () => {
    const { league, p1, p2 } = await seed();
    const game = await recordGame(owner, league.id, {
      playedOn: '2026-11-03', turns: 7,
      participants: [{ playerId: p1.id, seat: 1, lifeSnapshots: [{ turn: 3, life: 40 }] }, { playerId: p2.id, seat: 2 }],
      eliminations: [{ eliminatedPlayerId: p2.id, orderIndex: 1, creditedPlayerId: p1.id, points: 1, attribution: 'OWN_SOURCE', causeSource: "Kardur's trigger" }],
    });
    expect(game?.participants[0]?.lifeSnapshots).toEqual([{ turn: 3, life: 40 }]);
    expect((await getGame(owner, game!.id))?.eliminations[0]?.points).toBe(1);
  });
  it('writes nothing when a participant is not in the league', async () => {
    const { league, p1 } = await seed();
    const before = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM magic_games');
    expect(await recordGame(owner, league.id, { playedOn: '2026-11-03', participants: [{ playerId: p1.id, seat: 1 }, { playerId: 'mlp_nobody', seat: 2 }], eliminations: [] })).toBeNull();
    const after = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM magic_games');
    expect(Number(after?.n)).toBe(Number(before?.n));
  });
  it('keeps observations as an ordered, append-only record', async () => {
    const { league, p2 } = await seed();
    await appendObservation(owner, league.id, { playerId: p2.id, kind: 'COMMANDER', label: 'OBSERVED', detail: { name: 'X' }, observedOn: '2026-11-04' });
    await appendObservation(owner, league.id, { playerId: p2.id, kind: 'PURCHASE', label: 'HYPOTHESIS', detail: { card: 'Y' }, confidence: 0.3, observedOn: '2026-11-02' });
    expect((await listObservations(owner, league.id)).map((o) => o.label)).toEqual(['HYPOTHESIS', 'OBSERVED']);
  });
});
