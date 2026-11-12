/**
 * Leagues and everything that happens inside one: rules, players, their deck
 * versions, the weekly ledger, purchases, games, eliminations and observations.
 *
 * Seeding is by `ensure*` functions that insert with ON CONFLICT DO NOTHING and
 * read back, so seeding twice — or from two sessions — leaves one league and
 * never overwrites an edit. Opponent deck versions, ledger rows, games,
 * eliminations and observations are appended and never updated. Every function
 * is owner-scoped; a league that is not the owner's reads exactly like one that
 * does not exist.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CardListStatus, EliminationAttribution, MagicEliminationRow, MagicGameParticipantRow, MagicGameRow,
  MagicLeagueDeckRow, MagicLeaguePlayerRow, MagicLeagueRow, MagicLeagueRuleRow, MagicObservationRow,
  MagicPurchaseRow, MagicWeeklyLedgerRow, ObservationKind, PriceStatus,
} from '../domain/magicTypes.ts';

/* ---- leagues ---- */

export async function ensureLeague(
  ownerUserId: string,
  input: { seedKey: string; name: string; podSize?: number; startingLife?: number },
): Promise<MagicLeagueRow> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO magic_leagues (id, owner_user_id, seed_key, name, pod_size, starting_life, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_user_id, seed_key) DO NOTHING`,
    [newId('mlg'), ownerUserId, input.seedKey, input.name, input.podSize ?? 4, input.startingLife ?? 40, at, at],
  );
  return (await getDb().get<MagicLeagueRow>('SELECT * FROM magic_leagues WHERE owner_user_id = ? AND seed_key = ?', [ownerUserId, input.seedKey]))!;
}

export async function getLeague(ownerUserId: string, leagueId: string): Promise<MagicLeagueRow | null> {
  return (await getDb().get<MagicLeagueRow>('SELECT * FROM magic_leagues WHERE id = ? AND owner_user_id = ?', [leagueId, ownerUserId])) ?? null;
}

export async function listLeagues(ownerUserId: string): Promise<MagicLeagueRow[]> {
  return getDb().all<MagicLeagueRow>('SELECT * FROM magic_leagues WHERE owner_user_id = ? ORDER BY created_at, id', [ownerUserId]);
}

export async function updateLeague(
  ownerUserId: string, leagueId: string, patch: { name?: string; podSize?: number; startingLife?: number },
): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE magic_leagues SET name = COALESCE(?, name), pod_size = COALESCE(?, pod_size),
            starting_life = COALESCE(?, starting_life), updated_at = ?
      WHERE id = ? AND owner_user_id = ?`,
    [patch.name ?? null, patch.podSize ?? null, patch.startingLife ?? null, nowIso(), leagueId, ownerUserId],
  );
  return r.changes === 1;
}

/* ---- rules ---- */

export async function ensureRule(
  ownerUserId: string, leagueId: string, input: { ruleKey: string; value: unknown; status: MagicLeagueRuleRow['status']; note?: string },
): Promise<void> {
  if (!(await getLeague(ownerUserId, leagueId))) return;
  await getDb().run(
    `INSERT INTO magic_league_rules (id, league_id, rule_key, value, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (league_id, rule_key) DO NOTHING`,
    [newId('mlr'), leagueId, input.ruleKey, toJson(input.value), input.status, input.note ?? '', nowIso()],
  );
}

export async function setRule(
  ownerUserId: string, leagueId: string, input: { ruleKey: string; value: unknown; status: MagicLeagueRuleRow['status']; note?: string },
): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE magic_league_rules SET value = ?, status = ?, note = ?, updated_at = ?
      WHERE league_id = ? AND rule_key = ?
        AND EXISTS (SELECT 1 FROM magic_leagues l WHERE l.id = ? AND l.owner_user_id = ?)`,
    [toJson(input.value), input.status, input.note ?? '', nowIso(), leagueId, input.ruleKey, leagueId, ownerUserId],
  );
  return r.changes === 1;
}

export interface RuleView { ruleKey: string; value: unknown; status: MagicLeagueRuleRow['status']; note: string; updatedAt: string }

export async function listRules(ownerUserId: string, leagueId: string): Promise<RuleView[]> {
  const rows = await getDb().all<MagicLeagueRuleRow>(
    `SELECT r.* FROM magic_league_rules r JOIN magic_leagues l ON l.id = r.league_id
      WHERE r.league_id = ? AND l.owner_user_id = ? ORDER BY r.rule_key`,
    [leagueId, ownerUserId],
  );
  return rows.map((r) => ({ ruleKey: r.rule_key, value: parseJson(r.value, null), status: r.status, note: r.note, updatedAt: r.updated_at }));
}

/* ---- players ---- */

export interface PlayerView {
  id: string; leagueId: string; seedKey: string; ordinal: number; label: string; isOwner: boolean;
  status: 'CONFIRMED' | 'PROVISIONAL'; unknowns: string[]; notes: string; updatedAt: string;
}

const mapPlayer = (r: MagicLeaguePlayerRow): PlayerView => ({
  id: r.id, leagueId: r.league_id, seedKey: r.seed_key, ordinal: Number(r.ordinal), label: r.label, isOwner: Number(r.is_owner) === 1,
  status: r.status, unknowns: parseJson<string[]>(r.unknowns, []), notes: r.notes, updatedAt: r.updated_at,
});

export async function ensurePlayer(
  ownerUserId: string, leagueId: string,
  input: { seedKey: string; ordinal: number; label: string; isOwner?: boolean; status?: 'CONFIRMED' | 'PROVISIONAL'; unknowns?: string[]; notes?: string },
): Promise<PlayerView | null> {
  if (!(await getLeague(ownerUserId, leagueId))) return null;
  await getDb().run(
    `INSERT INTO magic_league_players (id, league_id, owner_user_id, seed_key, ordinal, label, is_owner, status, unknowns, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (league_id, seed_key) DO NOTHING`,
    [newId('mlp'), leagueId, ownerUserId, input.seedKey, input.ordinal, input.label, input.isOwner ? 1 : 0, input.status ?? 'CONFIRMED',
      toJson(input.unknowns ?? []), input.notes ?? '', nowIso()],
  );
  const row = await getDb().get<MagicLeaguePlayerRow>('SELECT * FROM magic_league_players WHERE league_id = ? AND seed_key = ?', [leagueId, input.seedKey]);
  return row ? mapPlayer(row) : null;
}

export async function getPlayer(ownerUserId: string, playerId: string): Promise<PlayerView | null> {
  const row = await getDb().get<MagicLeaguePlayerRow>('SELECT * FROM magic_league_players WHERE id = ? AND owner_user_id = ?', [playerId, ownerUserId]);
  return row ? mapPlayer(row) : null;
}

export async function listPlayers(ownerUserId: string, leagueId: string): Promise<PlayerView[]> {
  const rows = await getDb().all<MagicLeaguePlayerRow>(
    'SELECT * FROM magic_league_players WHERE league_id = ? AND owner_user_id = ? ORDER BY ordinal, id',
    [leagueId, ownerUserId],
  );
  return rows.map(mapPlayer);
}

export async function updatePlayer(
  ownerUserId: string, playerId: string,
  patch: { label?: string; status?: 'CONFIRMED' | 'PROVISIONAL'; unknowns?: string[]; notes?: string },
): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE magic_league_players SET label = COALESCE(?, label), status = COALESCE(?, status),
            unknowns = COALESCE(?, unknowns), notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ? AND owner_user_id = ?`,
    [patch.label ?? null, patch.status ?? null, patch.unknowns ? toJson(patch.unknowns) : null, patch.notes ?? null, nowIso(), playerId, ownerUserId],
  );
  return r.changes === 1;
}

/* ---- a player's deck, as versions ---- */

export interface LeagueDeckView {
  id: string; leagueId: string; playerId: string; versionNumber: number; parentLeagueDeckId: string | null;
  deckId: string | null; deckVersionId: string | null; product: string | null; commander: string | null;
  cardListStatus: CardListStatus; sourceCitation: string | null; sourceDate: string | null; isBaseline: boolean;
  observedAt: string | null; detail: Record<string, unknown>; createdAt: string;
}

const mapLeagueDeck = (r: MagicLeagueDeckRow): LeagueDeckView => ({
  id: r.id, leagueId: r.league_id, playerId: r.player_id, versionNumber: Number(r.version_number), parentLeagueDeckId: r.parent_league_deck_id,
  deckId: r.deck_id, deckVersionId: r.deck_version_id, product: r.product, commander: r.commander, cardListStatus: r.card_list_status,
  sourceCitation: r.source_citation, sourceDate: r.source_date, isBaseline: Number(r.is_baseline) === 1, observedAt: r.observed_at,
  detail: parseJson<Record<string, unknown>>(r.detail, {}), createdAt: r.created_at,
});

export interface NewLeagueDeck {
  product?: string | null; commander?: string | null; deckId?: string | null; deckVersionId?: string | null;
  cardListStatus: CardListStatus; sourceCitation?: string | null; sourceDate?: string | null; isBaseline?: boolean;
  observedAt?: string | null; detail?: Record<string, unknown>;
}

/**
 * Append the next version of a player's deck. The first version is the
 * baseline when `isBaseline` is set; a baseline row is never rewritten, and a
 * later observation is a new row pointing at the one before it.
 */
export async function appendLeagueDeck(ownerUserId: string, playerId: string, input: NewLeagueDeck): Promise<LeagueDeckView | null> {
  const player = await getPlayer(ownerUserId, playerId);
  if (!player) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await getDb().transaction(async () => {
        const db = getDb();
        const last = await db.get<{ id: string; version_number: number | string }>(
          'SELECT id, version_number FROM magic_league_decks WHERE player_id = ? ORDER BY version_number DESC LIMIT 1',
          [playerId],
        );
        const number = Number(last?.version_number ?? 0) + 1;
        const id = newId('mld');
        await db.run(
          `INSERT INTO magic_league_decks (id, league_id, player_id, owner_user_id, version_number, parent_league_deck_id, deck_id, deck_version_id,
                                           product, commander, card_list_status, source_citation, source_date, is_baseline, observed_at, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, player.leagueId, playerId, ownerUserId, number, last?.id ?? null, input.deckId ?? null, input.deckVersionId ?? null,
            input.product ?? null, input.commander ?? null, input.cardListStatus, input.sourceCitation ?? null, input.sourceDate ?? null,
            input.isBaseline && number === 1 ? 1 : 0, input.observedAt ?? null, toJson(input.detail ?? {}), nowIso()],
        );
        return mapLeagueDeck((await db.get<MagicLeagueDeckRow>('SELECT * FROM magic_league_decks WHERE id = ?', [id]))!);
      });
    } catch (error) {
      if (attempt === 4 || !/unique|duplicate/i.test(String((error as Error).message))) throw error;
    }
  }
  return null;
}

/** Seed the baseline only if the player has no deck yet; never touches an existing one. */
export async function ensureBaselineDeck(ownerUserId: string, playerId: string, input: NewLeagueDeck): Promise<LeagueDeckView | null> {
  const existing = await listLeagueDecks(ownerUserId, playerId);
  if (existing.length > 0) return existing[0]!;
  return appendLeagueDeck(ownerUserId, playerId, { ...input, isBaseline: true });
}

export async function listLeagueDecks(ownerUserId: string, playerId: string): Promise<LeagueDeckView[]> {
  const rows = await getDb().all<MagicLeagueDeckRow>(
    'SELECT * FROM magic_league_decks WHERE player_id = ? AND owner_user_id = ? ORDER BY version_number',
    [playerId, ownerUserId],
  );
  return rows.map(mapLeagueDeck);
}

export async function getLeagueDeck(ownerUserId: string, id: string): Promise<LeagueDeckView | null> {
  const row = await getDb().get<MagicLeagueDeckRow>('SELECT * FROM magic_league_decks WHERE id = ? AND owner_user_id = ?', [id, ownerUserId]);
  return row ? mapLeagueDeck(row) : null;
}

/* ---- weekly ledger and purchases (append-only) ---- */

export async function appendLedger(
  ownerUserId: string, leagueId: string,
  input: { weekStart: string; allowanceCents: number; option: 'SINGLES' | 'BOOSTER_PACKS'; cardIn?: string; cardOut?: string; printingId?: string | null;
    valueCents: number; priceStatus: PriceStatus; beforeVersionId?: string | null; afterVersionId?: string | null },
): Promise<MagicWeeklyLedgerRow | null> {
  if (!(await getLeague(ownerUserId, leagueId))) return null;
  const id = newId('mwl');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO magic_weekly_ledgers (id, league_id, owner_user_id, week_start, allowance_cents, option, card_in, card_out, printing_id,
                                       value_cents, price_status, before_version_id, after_version_id, locked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, leagueId, ownerUserId, input.weekStart, input.allowanceCents, input.option, input.cardIn ?? '', input.cardOut ?? '', input.printingId ?? null,
      input.valueCents, input.priceStatus, input.beforeVersionId ?? null, input.afterVersionId ?? null, at],
  );
  return (await getDb().get<MagicWeeklyLedgerRow>('SELECT * FROM magic_weekly_ledgers WHERE id = ?', [id])) ?? null;
}

export async function listLedger(ownerUserId: string, leagueId: string): Promise<MagicWeeklyLedgerRow[]> {
  return getDb().all<MagicWeeklyLedgerRow>(
    'SELECT * FROM magic_weekly_ledgers WHERE league_id = ? AND owner_user_id = ? ORDER BY week_start, locked_at, id',
    [leagueId, ownerUserId],
  );
}

export async function appendPurchase(
  ownerUserId: string, leagueId: string,
  input: { ledgerId?: string | null; kind: 'SINGLE' | 'BOOSTER_PACK'; description: string; printingId?: string | null; costCents: number; priceStatus: PriceStatus; purchasedOn: string },
): Promise<MagicPurchaseRow | null> {
  if (!(await getLeague(ownerUserId, leagueId))) return null;
  const id = newId('mpu');
  await getDb().run(
    `INSERT INTO magic_purchases (id, league_id, owner_user_id, ledger_id, kind, description, printing_id, cost_cents, price_status, purchased_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, leagueId, ownerUserId, input.ledgerId ?? null, input.kind, input.description, input.printingId ?? null, input.costCents, input.priceStatus, input.purchasedOn, nowIso()],
  );
  return (await getDb().get<MagicPurchaseRow>('SELECT * FROM magic_purchases WHERE id = ?', [id])) ?? null;
}

export async function listPurchases(ownerUserId: string, leagueId: string): Promise<MagicPurchaseRow[]> {
  return getDb().all<MagicPurchaseRow>(
    'SELECT * FROM magic_purchases WHERE league_id = ? AND owner_user_id = ? ORDER BY purchased_on, created_at, id',
    [leagueId, ownerUserId],
  );
}

/* ---- games and eliminations ---- */

export interface GameInput {
  playedOn: string; turns?: number | null; outcome?: string; notes?: string; houseRules?: Record<string, unknown>;
  participants: { playerId: string; leagueDeckId?: string | null; commander?: string | null; seat: number; lifeSnapshots?: unknown[]; keyCards?: string[]; threats?: string[]; placement?: number | null }[];
  eliminations: { eliminatedPlayerId: string; orderIndex: number; causeSource?: string; sourceControllerPlayerId?: string | null; creditedPlayerId?: string | null;
    points: number; attribution: EliminationAttribution; note?: string }[];
}

export interface GameView {
  id: string; leagueId: string; playedOn: string; turns: number | null; outcome: string; notes: string; houseRules: Record<string, unknown>;
  participants: (Omit<MagicGameParticipantRow, 'life_snapshots' | 'key_cards' | 'threats'> & { lifeSnapshots: unknown[]; keyCards: string[]; threats: string[] })[];
  eliminations: MagicEliminationRow[];
}

/** One game, its participants and its eliminations, written together or not at all. */
export async function recordGame(ownerUserId: string, leagueId: string, input: GameInput): Promise<GameView | null> {
  if (!(await getLeague(ownerUserId, leagueId))) return null;
  const known = new Set((await listPlayers(ownerUserId, leagueId)).map((p) => p.id));
  const mentioned = [
    ...input.participants.map((p) => p.playerId),
    ...input.eliminations.flatMap((e) => [e.eliminatedPlayerId, e.sourceControllerPlayerId, e.creditedPlayerId].filter((x): x is string => !!x)),
  ];
  if (mentioned.some((id) => !known.has(id))) return null;
  const id = newId('mgm');
  await getDb().transaction(async () => {
    const db = getDb();
    await db.run(
      `INSERT INTO magic_games (id, league_id, owner_user_id, played_on, turns, outcome, notes, house_rules, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, leagueId, ownerUserId, input.playedOn, input.turns ?? null, input.outcome ?? '', input.notes ?? '', toJson(input.houseRules ?? {}), nowIso()],
    );
    for (const p of input.participants) {
      await db.run(
        `INSERT INTO magic_game_participants (id, game_id, player_id, league_deck_id, commander, seat, life_snapshots, key_cards, threats, placement)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('mgp'), id, p.playerId, p.leagueDeckId ?? null, p.commander ?? null, p.seat, toJson(p.lifeSnapshots ?? []), toJson(p.keyCards ?? []), toJson(p.threats ?? []), p.placement ?? null],
      );
    }
    for (const e of input.eliminations) {
      await db.run(
        `INSERT INTO magic_eliminations (id, game_id, eliminated_player_id, order_index, cause_source, source_controller_player_id, credited_player_id, points, attribution, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('mel'), id, e.eliminatedPlayerId, e.orderIndex, e.causeSource ?? '', e.sourceControllerPlayerId ?? null, e.creditedPlayerId ?? null, e.points, e.attribution, e.note ?? ''],
      );
    }
  });
  return getGame(ownerUserId, id);
}

export async function getGame(ownerUserId: string, gameId: string): Promise<GameView | null> {
  const db = getDb();
  const g = await db.get<MagicGameRow>('SELECT * FROM magic_games WHERE id = ? AND owner_user_id = ?', [gameId, ownerUserId]);
  if (!g) return null;
  const parts = await db.all<MagicGameParticipantRow>('SELECT * FROM magic_game_participants WHERE game_id = ? ORDER BY seat', [gameId]);
  const elims = await db.all<MagicEliminationRow>('SELECT * FROM magic_eliminations WHERE game_id = ? ORDER BY order_index', [gameId]);
  return {
    id: g.id, leagueId: g.league_id, playedOn: g.played_on, turns: g.turns === null ? null : Number(g.turns), outcome: g.outcome, notes: g.notes,
    houseRules: parseJson<Record<string, unknown>>(g.house_rules, {}),
    participants: parts.map((p) => {
      const { life_snapshots, key_cards, threats, ...rest } = p;
      return { ...rest, lifeSnapshots: parseJson<unknown[]>(life_snapshots, []), keyCards: parseJson<string[]>(key_cards, []), threats: parseJson<string[]>(threats, []) };
    }),
    eliminations: elims,
  };
}

export async function listGames(ownerUserId: string, leagueId: string): Promise<GameView[]> {
  const rows = await getDb().all<{ id: string }>(
    'SELECT id FROM magic_games WHERE league_id = ? AND owner_user_id = ? ORDER BY played_on, created_at, id',
    [leagueId, ownerUserId],
  );
  const out: GameView[] = [];
  for (const r of rows) {
    const g = await getGame(ownerUserId, r.id);
    if (g) out.push(g);
  }
  return out;
}

/* ---- observations (append-only) ---- */

export async function appendObservation(
  ownerUserId: string, leagueId: string,
  input: { playerId?: string | null; kind: ObservationKind; label: 'OBSERVED' | 'HYPOTHESIS'; detail: unknown; confidence?: number | null; resultingLeagueDeckId?: string | null; observedOn: string },
): Promise<MagicObservationRow | null> {
  if (!(await getLeague(ownerUserId, leagueId))) return null;
  if (input.playerId && !(await getPlayer(ownerUserId, input.playerId))) return null;
  const id = newId('mob');
  await getDb().run(
    `INSERT INTO magic_observations (id, league_id, owner_user_id, player_id, kind, label, detail, confidence, resulting_league_deck_id, observed_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, leagueId, ownerUserId, input.playerId ?? null, input.kind, input.label, toJson(input.detail), input.confidence ?? null, input.resultingLeagueDeckId ?? null, input.observedOn, nowIso()],
  );
  return (await getDb().get<MagicObservationRow>('SELECT * FROM magic_observations WHERE id = ?', [id])) ?? null;
}

export async function listObservations(ownerUserId: string, leagueId: string): Promise<MagicObservationRow[]> {
  return getDb().all<MagicObservationRow>(
    'SELECT * FROM magic_observations WHERE league_id = ? AND owner_user_id = ? ORDER BY observed_on, created_at, id',
    [leagueId, ownerUserId],
  );
}
