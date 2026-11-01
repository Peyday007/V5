/**
 * The owner's Precon Commander League, created on first access and never
 * rewritten afterwards. Every row is inserted only when its seed key is absent,
 * so an edit survives and a second visit changes nothing.
 *
 * A player whose precon is known gets its official list as a real deck in the
 * deck store: one version, every card named, the Wizards of the Coast source
 * and date on the league record. A deck nobody has identified stays a named
 * record labelled "unverified cardlist", and nothing here guesses a list.
 */
import {
  appendLeagueDeck, ensureLeague, ensurePlayer, ensureRule, listLeagueDecks, type PlayerView,
} from '../../../repos/magicLeague.ts';
import { appendVersion, createDeck, type DeckCardInput } from '../../../repos/magicDecks.ts';
import {
  OFFICIAL_DECKS, OFFICIAL_SOURCE_DATE, OFFICIAL_SOURCE_TITLE, OFFICIAL_SOURCE_URL, officialCount,
} from './officialLists.ts';
import { LEAGUE_NAME, SEED_PLAYERS, SEED_RULES, playerKey, type SeedPlayer } from './seed.ts';

export const LEAGUE_SEED_KEY = 'precon-commander-league';

/** The cards of a seeded player's baseline: the official list, without the commander when it is not in use. */
export function baselineCards(p: SeedPlayer): DeckCardInput[] | null {
  if (!p.official) return null;
  const deck = OFFICIAL_DECKS[p.official];
  if (officialCount(deck) !== 100) throw new Error(`The official ${deck.title} list does not add up to 100.`);
  const library: DeckCardInput[] = deck.library.map((l) => ({ zone: 'main', cardName: l.name, quantity: l.quantity }));
  if (p.commander === 'UNKNOWN') return library;
  if (p.commander !== deck.commander) throw new Error(`${p.label} names ${p.commander}, but the official list's commander is ${deck.commander}.`);
  return [{ zone: 'commander', cardName: deck.commander, quantity: 1 }, ...library];
}

async function seedBaseline(who: string, player: PlayerView, p: SeedPlayer): Promise<void> {
  if ((await listLeagueDecks(who, player.id)).length > 0) return;
  const cards = baselineCards(p);
  const product = p.product === 'UNKNOWN' ? null : p.product;
  const commander = p.commander === 'UNKNOWN' ? null : p.commander;
  if (!cards) {
    await appendLeagueDeck(who, player.id, {
      product, commander, cardListStatus: 'UNVERIFIED', isBaseline: true,
      detail: { listLabel: 'unverified cardlist', listStatus: p.listStatus, ...(p.observedTraits ? { observedTraits: p.observedTraits } : {}) },
    });
    return;
  }
  const official = OFFICIAL_DECKS[p.official!];
  const deck = await createDeck({
    ownerUserId: who, name: `${p.label} (official ${official.title})`, format: 'COMMANDER', cardListStatus: 'VERIFIED',
    notes: `Official list: ${OFFICIAL_SOURCE_TITLE}, ${OFFICIAL_SOURCE_DATE}, ${OFFICIAL_SOURCE_URL}`,
  });
  const version = await appendVersion(who, deck.id, {
    cards, reason: `Official ${official.title} list as published ${OFFICIAL_SOURCE_DATE}.`, source: 'OFFICIAL_PRECON',
  });
  await appendLeagueDeck(who, player.id, {
    product, commander, deckId: deck.id, deckVersionId: version?.id ?? null, cardListStatus: 'VERIFIED', isBaseline: true,
    sourceCitation: `${OFFICIAL_SOURCE_TITLE} — ${OFFICIAL_SOURCE_URL}`, sourceDate: OFFICIAL_SOURCE_DATE,
    detail: {
      listLabel: p.commander === 'UNKNOWN' ? 'official 99, commander unknown' : 'official 100',
      listStatus: p.listStatus, cards: cards.reduce((n, c) => n + c.quantity, 0),
      ...(p.priorCommander ? { priorCommander: p.priorCommander } : {}),
      ...(p.observedTraits ? { observedTraits: p.observedTraits } : {}),
    },
  });
}

/*
 * One seeding at a time per person on this machine. Two first visits in the
 * same instant would otherwise both see "no baseline" and both create one; the
 * rows below are keyed, but the deck store is not.
 */
const running = new Map<string, Promise<void>>();

export function ensureWorkspace(who: string): Promise<void> {
  const prior = running.get(who) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => seed(who));
  running.set(who, next);
  return next.finally(() => { if (running.get(who) === next) running.delete(who); });
}

async function seed(who: string): Promise<void> {
  const league = await ensureLeague(who, { seedKey: LEAGUE_SEED_KEY, name: LEAGUE_NAME, podSize: SEED_RULES.podSize, startingLife: SEED_RULES.startingLife });
  const rules: [string, unknown, 'CONFIRMED' | 'PENDING' | 'ASSUMED', string][] = [
    ['weekly_allowance_cents', SEED_RULES.weeklyAllowanceCents, 'CONFIRMED', '$10 market value of singles each week.'],
    ['booster_option', SEED_RULES.boosterOption, 'PENDING', 'Two booster packs instead of singles; exact sets pending confirmation and never blocking singles.'],
    ['rollover', SEED_RULES.rollover, 'PENDING', 'Not confirmed: assumed none, and unconfirmed money is never accumulated.'],
    ['scoring', SEED_RULES.scoring, 'CONFIRMED', 'First two eliminations 1 point each, final elimination 2, credited to the controller of the causing source.'],
    ['house_rules_pending', SEED_RULES.houseRulesPending, 'PENDING', 'Simultaneous elimination, commander damage and alternate losses are editable house rules, never silently assigned.'],
  ];
  for (const [ruleKey, value, status, note] of rules) await ensureRule(who, league.id, { ruleKey, value, status, note });
  for (const p of SEED_PLAYERS) {
    const unknowns = [
      p.product === 'UNKNOWN' ? 'product' : null,
      p.commander === 'UNKNOWN' ? 'commander' : null,
      p.official ? null : 'cardlist',
    ].filter((x): x is string => x !== null);
    const player = await ensurePlayer(who, league.id, {
      seedKey: playerKey(p), ordinal: p.slot, label: p.label, isOwner: p.slot === 0, status: p.provisional ? 'PROVISIONAL' : 'CONFIRMED',
      unknowns, notes: p.notes.join(' '),
    });
    if (player) await seedBaseline(who, player, p);
  }
}
