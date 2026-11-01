/**
 * Magic Deck Lab's door: `/api/magic/...`.
 *
 * Every handler calls `requirePerson()`, so a worker is refused by type, and
 * every read or write of a deck, version, league, game or price entry is scoped
 * to that person's id inside the repository. A resource that is somebody
 * else's and one that does not exist therefore come back as the same thing —
 * `null` — and are answered with the same 404 *and the same body*: a
 * distinguishable refusal would be an oracle for other people's decks.
 *
 * Nothing here decides anything. Rules, analysis, optimization, prices and the
 * league are services; these resolve the caller, hand the request over and turn
 * a refusal into a status. A database that did not answer reaches
 * `errorMiddleware`, which says 503 and retryable; a catalog that could not be
 * refreshed is reported with its stale label, never as a clean result.
 */
import { Router } from 'express';
import {
  badRequest, bodyOf, handler, notFound, optionalInteger, optionalString, pathId, queryOf, requirePerson, requiredString,
  unprocessable,
} from './helpers.ts';
import { getCard, findCardsByName, listLegalCardsWithPrice, listPrintings, getPrinting, type CatalogCard } from '../repos/magicCatalog.ts';
import {
  appendLedger, appendLeagueDeck, appendObservation, appendPurchase,
  getLeague, getPlayer, listGames, listLeagueDecks, listLeagues, listLedger, listObservations, listPlayers, listPurchases, listRules,
  recordGame, setRule, updateLeague, updatePlayer, type GameInput,
} from '../repos/magicLeague.ts';
import { getDeck, currentVersion, getVersion, saveAnalysis, saveDesignIntent, type DeckCardInput } from '../repos/magicDecks.ts';
import { latestPrice, listPriceSnapshots, lockPriceSnapshot, PriceRefused, recordPriceSnapshot } from '../repos/magicPrices.ts';
import { catalogStatus, ensureCatalogFresh, lookupCard, searchCatalog, startCatalogRefresh } from '../services/magic/catalog/index.ts';
import {
  changeCommander, diff, exportDeck, importDeck, listCollection, listDecks, listVersions, restoreVersion, saveVersion,
  setCollectionQuantity, undo, validateCards, validateSaved,
} from '../services/magic/decks/index.ts';
import { analyzeDeck, type AnalysisCard } from '../services/magic/analysis/index.ts';
import { optimizeDeck, type DeckLine, type OptCard } from '../services/magic/optimizer/index.ts';
import { buildDeck, chooseAlternative, parseIdea, planDesign, refineIntent, type DesignIntent } from '../services/magic/design/index.ts';
import {
  alternatePrintings, approveSingles, priceFor, resolvePrinting, validateVerifiedEntry, type PrintingPrice, type VerifiedPrice,
} from '../services/magic/prices/prices.ts';
import { SEED_RULES } from '../services/magic/league/seed.ts';
import { ensureWorkspace } from '../services/magic/league/workspace.ts';
import { standings } from '../services/magic/league/standings.ts';
import { rankSwaps } from '../services/magic/league/nextTen.ts';
import { attackOnlyDefenseStops, valueInPod } from '../services/magic/league/matchups.ts';
import type { MagicFormat, MagicZone } from '../domain/magicTypes.ts';
import { MAGIC_FORMATS, MAGIC_ZONES } from '../domain/magicTypes.ts';

export const magicRouter: Router = Router();

/** One sentence for every resource that is absent or not yours. */
const NO_SUCH = 'No such Magic resource.';
const gone = () => notFound(NO_SUCH);
const today = () => new Date().toISOString().slice(0, 10);

function owner(): string {
  return requirePerson().id;
}

function formatOf(value: unknown): MagicFormat {
  if (typeof value === 'string' && (MAGIC_FORMATS as readonly string[]).includes(value)) return value as MagicFormat;
  throw badRequest(`"format" must be one of ${MAGIC_FORMATS.join(', ')}.`);
}

function cardsOf(value: unknown): DeckCardInput[] {
  if (!Array.isArray(value)) throw badRequest('"cards" must be a list.');
  return value.map((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const zone = c.zone ?? 'main';
    if (typeof zone !== 'string' || !(MAGIC_ZONES as readonly string[]).includes(zone)) throw badRequest(`cards[${i}].zone is not a zone.`);
    const quantity = Number(c.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw badRequest(`cards[${i}].quantity must be a whole number.`);
    return {
      zone: zone as MagicZone, cardName: requiredString(c.cardName ?? c.name, `cards[${i}].cardName`), quantity,
      oracleId: typeof c.oracleId === 'string' ? c.oracleId : null, printingId: typeof c.printingId === 'string' ? c.printingId : null,
      role: typeof c.role === 'string' ? c.role : null,
    };
  });
}

async function cardFor(c: DeckCardInput): Promise<CatalogCard | null> {
  const byId = c.oracleId ? await getCard(c.oracleId) : null;
  if (byId) return byId;
  const found = await findCardsByName(c.cardName);
  return found.length === 1 ? found[0]! : null;
}

async function analysisCards(cards: DeckCardInput[]): Promise<{ cards: AnalysisCard[]; unknown: string[] }> {
  const out: AnalysisCard[] = [];
  const unknown: string[] = [];
  for (const c of cards) {
    const card = await cardFor(c);
    if (!card) { unknown.push(c.cardName); continue; }
    out.push({ name: card.name, quantity: c.quantity, zone: c.zone, typeLine: card.typeLine, manaCost: card.manaCost, cmc: card.cmc, oracleText: card.oracleText });
  }
  return { cards: out, unknown };
}

/** Price of the chosen (or cheapest known) printing: a person's confirmed entry first, Scryfall's estimate otherwise. */
async function optCardFor(card: CatalogCard, printingId: string | null | undefined, who: string): Promise<OptCard> {
  const printings = await listPrintings(card.oracleId);
  const chosen = printingId ? printings.find((p) => p.id === printingId) : undefined;
  const pick = chosen ?? [...printings].filter((p) => p.priceUsdCents !== null).sort((a, b) => (a.priceUsdCents ?? 0) - (b.priceUsdCents ?? 0) || (a.id < b.id ? -1 : 1))[0] ?? printings[0];
  let priceCents: number | null = pick?.priceUsdCents ?? null;
  let priceStatus: OptCard['priceStatus'] = priceCents === null ? null : 'ESTIMATE';
  if (pick) {
    const mine = await latestPrice(pick.id, who);
    if (mine && mine.status === 'CONFIRMED') { priceCents = mine.priceCents; priceStatus = 'CONFIRMED'; }
  }
  return {
    oracleId: card.oracleId, name: card.name, typeLine: card.typeLine, oracleText: card.oracleText, keywords: card.keywords,
    colorIdentity: card.colorIdentity, legalities: card.legalities, manaCost: card.manaCost, cmc: card.cmc, priceCents, priceStatus,
  };
}

async function poolFrom(names: unknown, who: string): Promise<{ pool: OptCard[]; unknown: string[] }> {
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').slice(0, 2000) : [];
  const pool: OptCard[] = [];
  const unknown: string[] = [];
  for (const name of list) {
    const found = await findCardsByName(name);
    if (found.length !== 1) { unknown.push(name); continue; }
    pool.push(await optCardFor(found[0]!, null, who));
  }
  return { pool, unknown };
}

/* ------------------------------------------------------------------ catalog */

/** Reading the status is what keeps the catalog filled: an empty or stale one starts a refresh off the request path. */
magicRouter.get('/magic/catalog/status', handler(async () => {
  owner();
  await ensureCatalogFresh();
  return catalogStatus();
}));

magicRouter.get('/magic/catalog/search', handler(async (req) => {
  owner();
  const q = queryOf(req);
  const prefix = optionalString(q.q, 'q') ?? '';
  return searchCatalog(prefix, optionalInteger(q.limit, 'limit', { min: 1, max: 100 }) ?? 20);
}));

magicRouter.get('/magic/catalog/cards', handler(async (req) => {
  owner();
  const name = requiredString(queryOf(req).name, 'name');
  return lookupCard(name);
}));

/** Starts a refresh off the request path. A failed refresh keeps serving the cache and says so. */
magicRouter.post('/magic/catalog/refresh', handler(async (_req, res) => {
  owner();
  startCatalogRefresh().promise.catch(() => undefined);
  res.status(202);
  return { started: true, status: await catalogStatus() };
}));

/* ------------------------------------------------------------------- prices */

async function printingPrice(printingId: string): Promise<PrintingPrice | null> {
  const p = await getPrinting(printingId);
  if (!p) return null;
  return { printingId: p.id, oracleId: p.oracleId, setCode: p.setCode, collectorNumber: p.collectorNumber, scryfallCents: p.priceUsdCents, scryfallFetchedAt: p.priceFetchedAt };
}

async function verifiedFor(printingId: string, who: string): Promise<VerifiedPrice[]> {
  return (await listPriceSnapshots(printingId, who))
    .filter((s) => s.status === 'CONFIRMED')
    .map((s) => ({ printingId: s.printingId, priceCents: s.priceCents, source: s.source, observedOn: s.observedOn, locked: s.locked }));
}

magicRouter.get('/magic/prices/printings/:printingId', handler(async (req) => {
  const who = owner();
  const printing = await printingPrice(pathId(req, 'printingId'));
  if (!printing) throw gone();
  return { reading: priceFor(printing, await verifiedFor(printing.printingId, who)) };
}));

magicRouter.post('/magic/prices/printings/:printingId/snapshots', handler(async (req, res) => {
  const who = owner();
  const printing = await printingPrice(pathId(req, 'printingId'));
  if (!printing) throw gone();
  const b = bodyOf(req);
  const entry = {
    printingId: printing.printingId, priceCents: Number(b.priceCents), source: requiredString(b.source, 'source'),
    observedOn: requiredString(b.observedOn, 'observedOn'),
  };
  const problems = validateVerifiedEntry(entry);
  if (problems.length) throw unprocessable('That price was not accepted.', { problems });
  try {
    const snap = await recordPriceSnapshot({ ownerUserId: who, ...entry, status: 'CONFIRMED', locked: b.lock === true });
    res.status(201);
    return { snapshot: snap };
  } catch (e) {
    if (e instanceof PriceRefused) throw unprocessable(e.message);
    throw e;
  }
}));

magicRouter.post('/magic/prices/snapshots/:id/lock', handler(async (req) => {
  const who = owner();
  if (!(await lockPriceSnapshot(who, pathId(req, 'id')))) throw gone();
  return { locked: true };
}));

magicRouter.get('/magic/prices/cards/:oracleId/printings', handler(async (req) => {
  const who = owner();
  const oracleId = pathId(req, 'oracleId');
  const card = await getCard(oracleId);
  if (!card) throw gone();
  const printings = await listPrintings(oracleId);
  const prices: PrintingPrice[] = printings.map((p) => ({ printingId: p.id, oracleId, setCode: p.setCode, collectorNumber: p.collectorNumber, scryfallCents: p.priceUsdCents, scryfallFetchedAt: p.priceFetchedAt }));
  const verified: VerifiedPrice[] = [];
  for (const p of prices) verified.push(...(await verifiedFor(p.printingId, who)));
  const ref = typeof queryOf(req).printingId === 'string' ? prices.find((p) => p.printingId === queryOf(req).printingId) : prices[0];
  return {
    card: card.name,
    resolution: resolvePrinting({ name: card.name, printings: prices }, ref && typeof queryOf(req).printingId === 'string' ? ref.printingId : undefined),
    alternates: ref ? alternatePrintings(ref, prices, verified) : [],
  };
}));

magicRouter.post('/magic/prices/eligibility', handler(async (req) => {
  const who = owner();
  const ids = bodyOf(req).printingIds;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw badRequest('"printingIds" must be a list of printing ids.');
  const readings = [];
  for (const id of ids as string[]) {
    const p = await printingPrice(id);
    if (!p) throw gone();
    readings.push(priceFor(p, await verifiedFor(id, who)));
  }
  return { readings, eligibility: approveSingles(readings) };
}));

/* -------------------------------------------------------------------- decks */

magicRouter.get('/magic/decks', handler(async () => ({ decks: await listDecks(owner()) })));

magicRouter.post('/magic/decks/import', handler(async (req, res) => {
  const who = owner();
  const b = bodyOf(req);
  const report = await importDeck(who, { name: requiredString(b.name, 'name'), format: formatOf(b.format), text: requiredString(b.text, 'text'), source: 'IMPORT' });
  if ('error' in report) throw unprocessable('That list has no cards in it.', report);
  res.status(201);
  return report;
}));

magicRouter.get('/magic/decks/:deckId', handler(async (req) => {
  const who = owner();
  const deck = await getDeck(who, pathId(req, 'deckId'));
  if (!deck) throw gone();
  return { deck, version: await currentVersion(who, deck.id) };
}));

magicRouter.get('/magic/decks/:deckId/versions', handler(async (req) => {
  const who = owner();
  const id = pathId(req, 'deckId');
  if (!(await getDeck(who, id))) throw gone();
  return { versions: await listVersions(who, id) };
}));

magicRouter.post('/magic/decks/:deckId/versions', handler(async (req, res) => {
  const result = await saveVersion(owner(), pathId(req, 'deckId'), { cards: cardsOf(bodyOf(req).cards), reason: optionalString(bodyOf(req).reason, 'reason'), source: 'EDIT' });
  if (!result) throw gone();
  res.status(201);
  return result;
}));

magicRouter.post('/magic/decks/:deckId/undo', handler(async (req) => {
  const v = await undo(owner(), pathId(req, 'deckId'));
  if (!v) throw gone();
  return { version: v };
}));

magicRouter.post('/magic/decks/:deckId/restore', handler(async (req) => {
  const v = await restoreVersion(owner(), pathId(req, 'deckId'), requiredString(bodyOf(req).versionId, 'versionId'));
  if (!v) throw gone();
  return { version: v };
}));

magicRouter.get('/magic/decks/:deckId/diff', handler(async (req) => {
  const who = owner();
  if (!(await getDeck(who, pathId(req, 'deckId')))) throw gone();
  const q = queryOf(req);
  const d = await diff(who, requiredString(q.from, 'from'), requiredString(q.to, 'to'));
  if (!d) throw gone();
  return { diff: d };
}));

magicRouter.get('/magic/decks/:deckId/export', handler(async (req) => {
  const text = await exportDeck(owner(), pathId(req, 'deckId'), optionalString(queryOf(req).versionId, 'versionId'));
  if (text === null) throw gone();
  return { text };
}));

magicRouter.post('/magic/decks/:deckId/commander', handler(async (req) => {
  const names = bodyOf(req).commanders;
  if (!Array.isArray(names) || names.length < 1 || names.length > 2 || names.some((n) => typeof n !== 'string')) throw badRequest('"commanders" must be one or two names.');
  const r = await changeCommander(owner(), pathId(req, 'deckId'), names as string[]);
  if (!r) throw gone();
  return r;
}));

magicRouter.get('/magic/collection', handler(async () => ({ collection: await listCollection(owner()) })));

magicRouter.put('/magic/collection', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  const status = b.status;
  if (status !== 'OWNED' && status !== 'PROXY') throw badRequest('"status" must be OWNED or PROXY.');
  const quantity = Number(b.quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 9999) throw badRequest('"quantity" must be a whole number.');
  const name = requiredString(b.cardName, 'cardName');
  const found = await findCardsByName(name);
  await setCollectionQuantity(who, { cardName: found.length === 1 ? found[0]!.name : name, status, quantity, oracleId: found.length === 1 ? found[0]!.oracleId : null });
  return { collection: await listCollection(who) };
}));

/* --------------------------------------------------------- validate/analyze */

async function cardsFromBody(b: Record<string, unknown>, who: string): Promise<{ format: MagicFormat; cards: DeckCardInput[]; deckId: string | null; versionId: string | null }> {
  if (typeof b.deckId === 'string') {
    const deck = await getDeck(who, b.deckId);
    const version = deck ? (typeof b.versionId === 'string' ? await getVersion(who, b.versionId) : await currentVersion(who, deck.id)) : null;
    if (!deck || !version || version.deckId !== deck.id) throw gone();
    return { format: deck.format, cards: version.cards, deckId: deck.id, versionId: version.id };
  }
  return { format: formatOf(b.format), cards: cardsOf(b.cards), deckId: null, versionId: null };
}

magicRouter.post('/magic/validate', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  const analysisDate = optionalString(b.analysisDate, 'analysisDate') ?? today();
  if (typeof b.deckId === 'string') {
    const r = await validateSaved(who, b.deckId, analysisDate, optionalString(b.versionId, 'versionId'));
    if (!r) throw gone();
    return { validation: r, catalog: await catalogStatus() };
  }
  return { validation: await validateCards(formatOf(b.format), cardsOf(b.cards), analysisDate), catalog: await catalogStatus() };
}));

magicRouter.post('/magic/analyze', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  const src = await cardsFromBody(b, who);
  const { cards, unknown } = await analysisCards(src.cards);
  if (unknown.length) throw unprocessable('Some cards are not in the catalog, so they cannot be analysed.', { unknown });
  const runs = optionalInteger(b.simulationRuns, 'simulationRuns', { min: 0, max: 20000 }) ?? 2000;
  const seed = optionalInteger(b.seed, 'seed', { min: 0, max: 2 ** 31 }) ?? 1;
  const result = analyzeDeck({
    format: src.format, cards, onThePlay: b.onThePlay !== false, seed, simulationRuns: runs,
    opponents: optionalInteger(b.opponents, 'opponents', { min: 1, max: 5 }),
  });
  if (src.deckId) await saveAnalysis(who, { deckId: src.deckId, versionId: src.versionId, kind: 'ANALYZE', seed: String(seed), assumptions: { runs, onThePlay: b.onThePlay !== false }, result });
  return { analysis: result, catalog: await catalogStatus() };
}));

/* ----------------------------------------------------------------- optimize */

magicRouter.post('/magic/optimize', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  const src = await cardsFromBody(b, who);
  const deck: DeckLine[] = [];
  const missing: string[] = [];
  for (const c of src.cards) {
    const card = await cardFor(c);
    if (!card) { missing.push(c.cardName); continue; }
    deck.push({ zone: c.zone === 'sideboard' ? 'sideboard' : c.zone, quantity: c.quantity, card: await optCardFor(card, c.printingId, who) });
  }
  if (missing.length) throw unprocessable('Some cards are not in the catalog, so the deck cannot be optimized.', { unknown: missing });
  const c = (b.constraints ?? {}) as Record<string, unknown>;
  if (c.priceCeilingCents !== undefined && c.priceCeilingCents !== null && !Number.isInteger(Number(c.priceCeilingCents))) throw badRequest('"priceCeilingCents" must be whole cents.');
  const named = Array.isArray(b.poolNames) && b.poolNames.length > 0;
  let pool: OptCard[];
  let unknown: string[] = [];
  if (named) {
    ({ pool, unknown } = await poolFrom(b.poolNames, who));
  } else {
    // No pool named: every format-legal catalog card, in the commander's colours for Commander.
    const identity = new Set(deck.filter((l) => l.zone === 'commander').flatMap((l) => l.card.colorIdentity));
    const inDeck = new Set(deck.map((l) => l.card.name));
    pool = (await catalogPool(src.format)).filter((p) => !inDeck.has(p.name) && (src.format !== 'COMMANDER' || p.colorIdentity.every((col) => identity.has(col))));
  }
  if (pool.length === 0) throw unprocessable(named ? 'None of the named cards is in the catalog.' : 'The catalog has no candidate cards for this deck yet.', { unknown, catalog: await catalogStatus() });
  const owned: Record<string, number> = {};
  for (const row of await listCollection(who)) if (row.status === 'OWNED') owned[row.card_name] = Number(row.quantity);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const result = optimizeDeck({
    format: src.format, deck, pool, analysisDate: optionalString(b.analysisDate, 'analysisDate') ?? today(),
    constraints: {
      protectedNames: strings(c.protectedNames), excludedNames: strings(c.excludedNames),
      priceCeilingCents: c.priceCeilingCents === undefined || c.priceCeilingCents === null ? null : Number(c.priceCeilingCents),
      ownedOnly: c.ownedOnly === true, owned,
    },
    weights: (b.weights ?? undefined) as never,
    preferredRoles: strings(b.preferredRoles) as never,
    maxSwaps: optionalInteger(b.maxSwaps, 'maxSwaps', { min: 1, max: 8 }),
    beamWidth: optionalInteger(b.beamWidth, 'beamWidth', { min: 1, max: 8 }),
  });
  if (src.deckId) await saveAnalysis(who, { deckId: src.deckId, versionId: src.versionId, kind: 'OPTIMIZE', assumptions: { constraints: c, unknownPool: unknown }, result });
  return { optimization: result, unknownPoolNames: unknown, catalog: await catalogStatus() };
}));

/* ------------------------------------------------------------------- design */

/**
 * The candidate pool when the person named none: every card legal in the
 * format, priced from the cheapest printing the catalog knows. The price is
 * Scryfall's, so it is an estimate; a person's confirmed price only applies to
 * a card they priced, which the optimizer reads per printing.
 */
async function catalogPool(format: MagicFormat): Promise<OptCard[]> {
  const rows = await listLegalCardsWithPrice(format === 'COMMANDER' ? 'commander' : 'standard');
  return rows.map((card) => ({
    oracleId: card.oracleId, name: card.name, typeLine: card.typeLine, oracleText: card.oracleText, keywords: card.keywords,
    colorIdentity: card.colorIdentity, legalities: card.legalities, manaCost: card.manaCost, cmc: card.cmc,
    priceCents: card.minPriceCents, priceStatus: card.minPriceCents === null ? null : 'ESTIMATE',
  }));
}

function intentOf(value: unknown): DesignIntent {
  if (!value || typeof value !== 'object' || typeof (value as DesignIntent).idea !== 'string') throw badRequest('"intent" must be a design intent returned by this API.');
  return value as DesignIntent;
}

async function remember(who: string, plan: ReturnType<typeof planDesign>, parent: string | null) {
  const row = await saveDesignIntent(who, {
    rawText: plan.intent.idea, structured: plan.intent, conflicts: plan.conflicts, alternatives: plan.alternatives,
    question: plan.question?.text ?? null, assumptions: plan.assumptions, state: plan.state, parentIntentId: parent,
  });
  return { ...plan, intentId: row.id };
}

magicRouter.post('/magic/design/intent', handler(async (req, res) => {
  const who = owner();
  const plan = planDesign(parseIdea(requiredString(bodyOf(req).idea, 'idea')));
  res.status(201);
  return remember(who, plan, null);
}));

magicRouter.post('/magic/design/refine', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  return remember(who, planDesign(refineIntent(intentOf(b.intent), requiredString(b.utterance, 'utterance'))), optionalString(b.intentId, 'intentId') ?? null);
}));

magicRouter.post('/magic/design/choose', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  let next: DesignIntent;
  try {
    next = chooseAlternative(intentOf(b.intent), requiredString(b.alternativeId, 'alternativeId'));
  } catch (e) {
    throw unprocessable(e instanceof Error ? e.message : 'That alternative is not on offer.');
  }
  return remember(who, planDesign(next), optionalString(b.intentId, 'intentId') ?? null);
}));

magicRouter.post('/magic/design/build', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  const intent = intentOf(b.intent);
  const named = Array.isArray(b.poolNames) && b.poolNames.length > 0;
  const { pool, unknown } = named ? await poolFrom(b.poolNames, who) : { pool: await catalogPool(intent.format), unknown: [] as string[] };
  if (pool.length === 0) {
    throw unprocessable(named
      ? 'None of the named cards is in the catalog.'
      : 'The card catalog has not been loaded yet, so there is nothing to build from. It is loading now; try again shortly.', { unknown, catalog: await catalogStatus() });
  }
  let commander: OptCard | undefined;
  if (typeof b.commander === 'string') {
    commander = pool.find((p) => p.name === b.commander);
    if (!commander) {
      const found = await findCardsByName(b.commander);
      if (found.length === 1) { commander = await optCardFor(found[0]!, null, who); pool.push(commander); }
    }
    if (!commander) throw unprocessable('That commander is not in the catalog.');
  }
  const owned: Record<string, number> = {};
  for (const row of await listCollection(who)) if (row.status === 'OWNED') owned[row.card_name] = Number(row.quantity);
  const built = buildDeck(intent, { pool, analysisDate: optionalString(b.analysisDate, 'analysisDate') ?? today(), commander, owned });
  if (built.refused) throw unprocessable(built.refused, { conflicts: planDesign(intent).conflicts });
  return { build: built, unknownPoolNames: unknown, catalog: await catalogStatus() };
}));

/* ------------------------------------------------------------------ leagues */

async function leagueOf(who: string, id: string) {
  const league = await getLeague(who, id);
  if (!league) throw gone();
  return league;
}

magicRouter.get('/magic/leagues', handler(async () => {
  const who = owner();
  await ensureWorkspace(who);
  return { leagues: await listLeagues(who) };
}));

magicRouter.get('/magic/leagues/:leagueId', handler(async (req) => {
  const who = owner();
  const league = await leagueOf(who, pathId(req, 'leagueId'));
  const players = await listPlayers(who, league.id);
  const decks: Record<string, unknown> = {};
  for (const p of players) decks[p.id] = await listLeagueDecks(who, p.id);
  return {
    league, rules: await listRules(who, league.id), players, decks,
    ledger: await listLedger(who, league.id), purchases: await listPurchases(who, league.id), observations: await listObservations(who, league.id),
  };
}));

magicRouter.patch('/magic/leagues/:leagueId', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  if (!(await updateLeague(who, pathId(req, 'leagueId'), {
    name: optionalString(b.name, 'name'), podSize: optionalInteger(b.podSize, 'podSize', { min: 2, max: 8 }), startingLife: optionalInteger(b.startingLife, 'startingLife', { min: 1, max: 1000 }),
  }))) throw gone();
  return { league: await leagueOf(who, pathId(req, 'leagueId')) };
}));

magicRouter.put('/magic/leagues/:leagueId/rules/:ruleKey', handler(async (req) => {
  const who = owner();
  const b = bodyOf(req);
  const status = b.status;
  if (status !== 'CONFIRMED' && status !== 'PENDING' && status !== 'ASSUMED') throw badRequest('"status" must be CONFIRMED, PENDING or ASSUMED.');
  if (!(await setRule(who, pathId(req, 'leagueId'), { ruleKey: pathId(req, 'ruleKey'), value: b.value, status, note: optionalString(b.note, 'note') }))) throw gone();
  return { rules: await listRules(who, pathId(req, 'leagueId')) };
}));

magicRouter.patch('/magic/leagues/:leagueId/players/:playerId', handler(async (req) => {
  const who = owner();
  const league = await leagueOf(who, pathId(req, 'leagueId'));
  const player = await getPlayer(who, pathId(req, 'playerId'));
  if (!player || player.leagueId !== league.id) throw gone();
  const b = bodyOf(req);
  await updatePlayer(who, player.id, {
    label: optionalString(b.label, 'label'), notes: optionalString(b.notes, 'notes'),
    status: b.status === 'CONFIRMED' || b.status === 'PROVISIONAL' ? b.status : undefined,
    unknowns: Array.isArray(b.unknowns) ? b.unknowns.filter((u): u is string => typeof u === 'string') : undefined,
  });
  return { player: await getPlayer(who, player.id) };
}));

/** A new version of a player's deck: the baseline is never rewritten. */
magicRouter.post('/magic/leagues/:leagueId/players/:playerId/decks', handler(async (req, res) => {
  const who = owner();
  const league = await leagueOf(who, pathId(req, 'leagueId'));
  const player = await getPlayer(who, pathId(req, 'playerId'));
  if (!player || player.leagueId !== league.id) throw gone();
  const b = bodyOf(req);
  const status = b.cardListStatus;
  const deck = await appendLeagueDeck(who, player.id, {
    product: optionalString(b.product, 'product') ?? null, commander: optionalString(b.commander, 'commander') ?? null,
    cardListStatus: status === 'VERIFIED' || status === 'HYPOTHESIS' ? status : 'UNVERIFIED',
    sourceCitation: optionalString(b.sourceCitation, 'sourceCitation') ?? null, sourceDate: optionalString(b.sourceDate, 'sourceDate') ?? null,
    observedAt: optionalString(b.observedAt, 'observedAt') ?? today(), detail: (b.detail ?? {}) as Record<string, unknown>,
  });
  if (!deck) throw gone();
  res.status(201);
  return { deck };
}));

magicRouter.post('/magic/leagues/:leagueId/games', handler(async (req, res) => {
  const who = owner();
  const b = bodyOf(req) as unknown as GameInput;
  if (!Array.isArray(b.participants) || !Array.isArray(b.eliminations)) throw badRequest('A game needs "participants" and "eliminations".');
  requiredString((b as unknown as Record<string, unknown>).playedOn, 'playedOn');
  const game = await recordGame(who, pathId(req, 'leagueId'), b);
  if (!game) throw gone();
  res.status(201);
  return { game };
}));

magicRouter.get('/magic/leagues/:leagueId/games', handler(async (req) => {
  const who = owner();
  const league = await leagueOf(who, pathId(req, 'leagueId'));
  const games = await listGames(who, league.id);
  const table = standings(games.map((g) => {
    const points: Record<string, number> = {};
    for (const p of g.participants) points[p.player_id] = 0;
    for (const e of g.eliminations) if (e.credited_player_id) points[e.credited_player_id] = (points[e.credited_player_id] ?? 0) + Number(e.points);
    return { points };
  }));
  return { games, standings: table };
}));

magicRouter.post('/magic/leagues/:leagueId/ledger', handler(async (req, res) => {
  const who = owner();
  const b = bodyOf(req);
  const status = b.priceStatus === 'CONFIRMED' ? 'CONFIRMED' : 'ESTIMATE';
  const row = await appendLedger(who, pathId(req, 'leagueId'), {
    weekStart: requiredString(b.weekStart, 'weekStart'), allowanceCents: Number(b.allowanceCents ?? SEED_RULES.weeklyAllowanceCents),
    option: b.option === 'BOOSTER_PACKS' ? 'BOOSTER_PACKS' : 'SINGLES', cardIn: optionalString(b.cardIn, 'cardIn'), cardOut: optionalString(b.cardOut, 'cardOut'),
    printingId: optionalString(b.printingId, 'printingId') ?? null, valueCents: Number(b.valueCents), priceStatus: status,
    beforeVersionId: optionalString(b.beforeVersionId, 'beforeVersionId') ?? null, afterVersionId: optionalString(b.afterVersionId, 'afterVersionId') ?? null,
  });
  if (!row) throw gone();
  res.status(201);
  return { entry: row };
}));

magicRouter.post('/magic/leagues/:leagueId/purchases', handler(async (req, res) => {
  const who = owner();
  const b = bodyOf(req);
  const row = await appendPurchase(who, pathId(req, 'leagueId'), {
    ledgerId: optionalString(b.ledgerId, 'ledgerId') ?? null, kind: b.kind === 'BOOSTER_PACK' ? 'BOOSTER_PACK' : 'SINGLE',
    description: requiredString(b.description, 'description'), printingId: optionalString(b.printingId, 'printingId') ?? null,
    costCents: Number(b.costCents), priceStatus: b.priceStatus === 'CONFIRMED' ? 'CONFIRMED' : 'ESTIMATE', purchasedOn: requiredString(b.purchasedOn, 'purchasedOn'),
  });
  if (!row) throw gone();
  res.status(201);
  return { purchase: row };
}));

/** The owner's league deck: the latest version on the owner's record, with its cards when it has a deck. */
async function ownerLeagueDeck(who: string, leagueId: string) {
  const players = await listPlayers(who, leagueId);
  const ownerPlayer = players.find((p) => p.isOwner);
  if (!ownerPlayer) throw gone();
  const versions = await listLeagueDecks(who, ownerPlayer.id);
  const latest = versions[versions.length - 1];
  // The deck's current version, so an edit or a recorded swap is what gets evaluated.
  const version = latest?.deckId ? await currentVersion(who, latest.deckId) : latest?.deckVersionId ? await getVersion(who, latest.deckVersionId) : null;
  return { players, ownerPlayer, latest, version };
}

function textOf(card: CatalogCard): string {
  return `${card.oracleText ?? ''}`.toLowerCase();
}

/**
 * "Evaluate the next $10": one-for-one swaps into the owner's current league
 * deck, searched by the optimizer over format-legal catalog cards in the
 * commander's colours that cost at most the weekly allowance. Every candidate
 * carries its price and whether that price is verified; only a verified
 * price within the allowance is approvable, and a suggestion is never a
 * purchase.
 */
magicRouter.post('/magic/leagues/:leagueId/next-ten', handler(async (req) => {
  const who = owner();
  const league = await leagueOf(who, pathId(req, 'leagueId'));
  const allowance = (await listRules(who, league.id)).find((r) => r.ruleKey === 'weekly_allowance_cents');
  const allowanceCents = Number.isInteger(Number(allowance?.value)) ? Number(allowance?.value) : SEED_RULES.weeklyAllowanceCents;
  const { version } = await ownerLeagueDeck(who, league.id);
  if (!version) throw unprocessable('The owner deck has no card list to improve yet.');
  const deck: DeckLine[] = [];
  const missing: string[] = [];
  for (const c of version.cards) {
    const card = await cardFor(c);
    if (!card) { missing.push(c.cardName); continue; }
    deck.push({ zone: c.zone, quantity: c.quantity, card: await optCardFor(card, c.printingId, who) });
  }
  if (missing.length) {
    throw unprocessable('Some cards in the owner deck are not in the catalog yet, so swaps cannot be evaluated.', { unknown: missing.slice(0, 20), catalog: await catalogStatus() });
  }
  const identity = new Set(deck.filter((l) => l.zone === 'commander').flatMap((l) => l.card.colorIdentity));
  const inDeck = new Set(deck.map((l) => l.card.name));
  const pool = (await catalogPool('COMMANDER'))
    .filter((c) => c.priceCents !== null && c.priceCents <= allowanceCents && !inDeck.has(c.name))
    .filter((c) => c.colorIdentity.every((col) => identity.has(col)));
  if (pool.length === 0) throw unprocessable('No priced catalog card within the allowance fits this commander yet.', { catalog: await catalogStatus() });
  const protectedNames = deck.filter((l) => l.zone === 'commander').map((l) => l.card.name);
  const result = optimizeDeck({
    format: 'COMMANDER', deck, pool, analysisDate: today(), opponents: league.pod_size ? Number(league.pod_size) - 1 : 3,
    constraints: { protectedNames, priceCeilingCents: allowanceCents }, maxSwaps: 1, beamWidth: 4, maxScoredPerLevel: 400, topN: 20,
  });
  const ranked = [];
  for (const u of result.upgrades.slice(0, 20)) {
    const found = await findCardsByName(u.swap.add);
    const printings = found.length === 1 ? await listPrintings(found[0]!.oracleId) : [];
    const pick = [...printings].filter((p) => p.priceUsdCents !== null).sort((a, b) => (a.priceUsdCents ?? 0) - (b.priceUsdCents ?? 0))[0];
    const mine = pick ? (await verifiedFor(pick.id, who))[0] : undefined;
    ranked.push({
      add: u.swap.add, cut: u.swap.cut, gain: u.gain,
      price: { printingId: pick?.id ?? 'unknown', cents: mine?.priceCents ?? pick?.priceUsdCents ?? null, status: mine ? 'CONFIRMED' as const : 'ESTIMATE' as const },
      printing: pick ? { setCode: pick.setCode, collectorNumber: pick.collectorNumber } : null,
    });
  }
  return {
    allowanceCents, suggestions: rankSwaps(ranked, allowanceCents), baseline: result.baseline.build.composite,
    note: 'Suggestions are not purchases. A Scryfall price is an estimate, not a verified TCGplayer market price, so only a price a person confirmed for that exact printing can be approved. Gains are HEURISTIC_SCORE changes, not win rates.',
    catalog: await catalogStatus(),
  };
}));

/**
 * How the owner deck stands against each recorded opponent. Pod and 1v1 are
 * separate answers: Kardur's goad redirects attacks in a pod and protects
 * nothing in a duel, while his own life-loss trigger is valued either way. An
 * attack-only defence does nothing against an opponent observed to drain life
 * without attacking. Results are counted from recorded games with their sample
 * size; nothing here is a win probability.
 */
magicRouter.get('/magic/leagues/:leagueId/matchups', handler(async (req) => {
  const who = owner();
  const league = await leagueOf(who, pathId(req, 'leagueId'));
  const { players, ownerPlayer, latest, version } = await ownerLeagueDeck(who, league.id);
  let usesGoad = false;
  let ownLifeLossTrigger = false;
  let unknownCards = 0;
  for (const c of version?.cards ?? []) {
    const card = await cardFor(c);
    if (!card) { unknownCards++; continue; }
    const t = textOf(card);
    if (/\bgoad|attack a player other than you/.test(t)) usesGoad = true; // Kardur's forced attack is goad in all but name
    if (/(each opponent|that player|target player|target opponent) loses \d+ life/.test(t)) ownLifeLossTrigger = true;
  }
  const podOpponents = Math.max(1, Number(league.pod_size ?? 4) - 1);
  const traits = { usesGoad, ownLifeLossTrigger, defenseIsAttackOnly: true, noncombatDrain: false };
  const games = await listGames(who, league.id);
  const opponents = [];
  for (const p of players.filter((x) => !x.isOwner)) {
    const decks = await listLeagueDecks(who, p.id);
    const current = decks[decks.length - 1];
    const observed = Object.assign({}, ...decks.map((d) => (d.detail?.observedTraits ?? {}) as object)) as { noncombatDrain?: boolean; manyCreatures?: boolean };
    const together = games.filter((g) => g.participants.some((x) => x.player_id === p.id) && g.participants.some((x) => x.player_id === ownerPlayer.id));
    const ownerPoints = together.reduce((n, g) => n + g.eliminations.filter((e) => e.credited_player_id === ownerPlayer.id).reduce((m, e) => m + Number(e.points), 0), 0);
    opponents.push({
      playerId: p.id, label: p.label, commander: current?.commander ?? 'UNKNOWN', cardListStatus: current?.cardListStatus ?? 'UNVERIFIED',
      versions: decks.length, observedTraits: observed,
      attackOnlyDefenseStopsThem: attackOnlyDefenseStops(true, observed.noncombatDrain === true),
      goadAgainstThem: observed.manyCreatures ? 'Many creatures observed, so goad has attackers to redirect.' : null,
      record: { games: together.length, ownerPoints, ownerPointsPerGame: together.length ? ownerPoints / together.length : null, label: 'EMPIRICAL_MATCH_RESULT' },
    });
  }
  return {
    owner: {
      label: ownerPlayer.label, commander: latest?.commander ?? null, unknownCards,
      goadInPod: valueInPod(traits, podOpponents), goadIn1v1: valueInPod(traits, 1),
      ownLifeLossTrigger: ownLifeLossTrigger
        ? 'The deck has its own life-loss effects, which score eliminations for you in a pod and close a duel without attacking.'
        : 'No own life-loss effect was found in the deck text.',
    },
    opponents,
    note: 'Pod and 1v1 are separate readings. Records are counts from logged games with their sample size; nothing here is a win probability.',
  };
}));

magicRouter.post('/magic/leagues/:leagueId/observations', handler(async (req, res) => {
  const who = owner();
  const b = bodyOf(req);
  const kinds = ['REVEALED_CARD', 'COMMANDER', 'PURCHASE', 'RESULT', 'NOTE'];
  if (typeof b.kind !== 'string' || !kinds.includes(b.kind)) throw badRequest(`"kind" must be one of ${kinds.join(', ')}.`);
  const leagueId = pathId(req, 'leagueId');
  const label = b.label === 'HYPOTHESIS' ? 'HYPOTHESIS' : 'OBSERVED';
  const playerId = optionalString(b.playerId, 'playerId') ?? null;
  const observedOn = requiredString(b.observedOn, 'observedOn');
  const detail = (b.detail && typeof b.detail === 'object' ? b.detail : {}) as Record<string, unknown>;
  // An observed commander or revealed card is a new version of that opponent's deck; the version
  // before it, and the baseline, are never changed. A hypothesis is recorded but versions nothing.
  if (playerId) {
    const player = await getPlayer(who, playerId);
    if (!player || player.leagueId !== leagueId) throw gone();
  }
  let version = null;
  if (label === 'OBSERVED' && playerId && (b.kind === 'COMMANDER' || b.kind === 'REVEALED_CARD')) {
    const history = await listLeagueDecks(who, playerId);
    const cur = history[history.length - 1];
    const revealedBefore = Array.isArray(cur?.detail?.revealed) ? (cur!.detail.revealed as string[]) : [];
    const commander = b.kind === 'COMMANDER' ? requiredString(detail.commander, 'detail.commander') : cur?.commander ?? null;
    const revealed = b.kind === 'REVEALED_CARD' ? [...new Set([...revealedBefore, requiredString(detail.card, 'detail.card')])] : revealedBefore;
    if (commander !== (cur?.commander ?? null) || revealed.length !== revealedBefore.length) {
      version = await appendLeagueDeck(who, playerId, {
        product: cur?.product ?? null, commander, deckId: cur?.deckId ?? null, deckVersionId: cur?.deckVersionId ?? null,
        cardListStatus: cur?.cardListStatus ?? 'UNVERIFIED', sourceCitation: cur?.sourceCitation ?? null, sourceDate: cur?.sourceDate ?? null,
        observedAt: observedOn,
        detail: {
          ...(cur?.detail ?? {}), revealed, basedOnLeagueDeckId: cur?.id ?? null,
          ...(b.kind === 'COMMANDER' && cur?.commander !== commander ? { priorCommander: cur?.commander ?? cur?.detail?.priorCommander ?? null, needsRevalidation: true } : {}),
        },
      });
    }
  }
  const row = await appendObservation(who, leagueId, {
    playerId, kind: b.kind as never, label, detail, confidence: typeof b.confidence === 'number' ? b.confidence : null,
    resultingLeagueDeckId: version?.id ?? null, observedOn,
  });
  if (!row) throw gone();
  res.status(201);
  return { observation: row, version };
}));
