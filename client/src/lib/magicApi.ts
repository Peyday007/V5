/**
 * Magic Deck Lab over HTTP.
 *
 * Thin by design: every number, legality and verdict is the server's. This file
 * names the routes and the shapes; it derives nothing. Row and vocabulary types
 * are imported type-only from the shared domain file so the two halves cannot
 * drift (CLAUDE.md §29, §30 — a client holding its own copy of a contract is a
 * second contract).
 */
import { api } from './api.ts';
import type {
  CardListStatus,
  LabelledNumber,
  MagicFormat,
  MagicZone,
  NumberLabel,
  PriceStatus,
} from '../../../server/domain/magicTypes.ts';

export type { CardListStatus, LabelledNumber, MagicFormat, MagicZone, NumberLabel, PriceStatus };

export const MAGIC_SECTIONS = [
  'design',
  'decks',
  'optimize',
  'matchups',
  'league',
  'collection',
  'exports',
] as const;
export type MagicSection = (typeof MAGIC_SECTIONS)[number];

/** A response that says how fresh the catalog behind it was. */
export interface Freshness {
  /** True when the cached index is being served because the source did not answer. */
  stale: boolean;
  fetchedAt: string | null;
  note?: string | null;
}

export interface DeckSummary {
  id: string;
  name: string;
  format: MagicFormat;
  cardListStatus: 'VERIFIED' | 'UNVERIFIED';
  currentVersionId: string | null;
  versionNumber: number | null;
  cardCount: number;
  commander: string | null;
  updatedAt: string;
}

export interface DeckCardView {
  zone: MagicZone;
  name: string;
  quantity: number;
  printingId: string | null;
  priceCents: number | null;
  priceStatus: PriceStatus | null;
}

export interface DeckVersionView {
  id: string;
  versionNumber: number;
  reason: string;
  source: string;
  createdAt: string;
}

export interface DeckDetail extends DeckSummary {
  cards: DeckCardView[];
  versions: DeckVersionView[];
  freshness?: Freshness;
}

export interface ImportIssue {
  line: number;
  text: string;
  kind: 'UNKNOWN' | 'AMBIGUOUS' | 'PRINTING';
  candidates?: string[];
  message: string;
}

export interface ImportResult {
  deck: DeckSummary | null;
  issues: ImportIssue[];
  freshness?: Freshness;
}

export interface ValidationIssueView {
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  cardName?: string;
}

export interface ValidationView {
  ok: boolean;
  format: MagicFormat;
  analysisDate: string;
  legalitySnapshotAt: string | null;
  counts: { commander: number; main: number; sideboard: number; total: number };
  commanders: string[];
  colorIdentity: string[];
  issues: ValidationIssueView[];
}

export interface DeckDiff {
  from: number;
  to: number;
  added: { name: string; quantity: number; zone: MagicZone }[];
  cut: { name: string; quantity: number; zone: MagicZone }[];
}

export type Labelled = LabelledNumber & { exact?: { num: string; den: string } };

export interface AnalysisView {
  analysisId?: string;
  format: MagicFormat;
  librarySize: number;
  counts: Record<string, number>;
  curve: { cmc: number; count: number }[];
  openingHand: { keepable: Labelled; landDistribution: { lands: number; probability: Labelled }[] };
  answers: { type: string; count: number; byTurn6: Labelled }[];
  redundancy: { role: string; count: number; thin: boolean }[];
  singleCardReliance: { role: string; card: string }[];
  scores: Record<string, Labelled>;
  simulation: {
    runs: number;
    seed: number;
    assumptions?: string[];
    mulliganPolicy?: string;
    metrics?: { name: string; value: Labelled; low?: number; high?: number }[];
  } | null;
  notes: string[];
  freshness?: Freshness;
}

export interface OptimizeWeights {
  consistency: number;
  earlyDevelopment: number;
  threatsAnswered: number;
  survival: number;
  closing: number;
  pointsPotential: number;
  price: number;
  preference: number;
}

export interface OptimizeCandidate {
  id: string;
  adds: { name: string; priceCents: number | null; priceStatus: PriceStatus | null }[];
  cuts: { name: string }[];
  totalCostCents: number;
  vector: Record<string, Labelled>;
  tradeoffs: string[];
  gainPerDollar: Labelled | null;
  frontier: boolean;
}

export interface OptimizeView {
  baseline: Record<string, Labelled>;
  candidates: OptimizeCandidate[];
  rejected: { count: number; reasons: string[] };
  freshness?: Freshness;
}

export interface DesignIntentView {
  id: string;
  state: 'DRAFT' | 'NEEDS_DECISION' | 'COHERENT' | 'BUILT';
  structured: {
    format: MagicFormat;
    primaryOutcome: string;
    archetypes: string[];
    winEngines: string[];
    secondary: string[];
    hardConstraints: string[];
    adjustableWeights: { name: string; weight: number }[];
    risk: string;
    budgetCents: number | null;
    playstyle: string;
  };
  conflicts: { title: string; cost: string }[];
  alternatives: { title: string; tradeoffs: string[] }[];
  question: string | null;
  assumptions: string[];
  deckId: string | null;
}

export interface LeaguePlayerView {
  id: string;
  ordinal: number;
  label: string;
  isOwner: boolean;
  status: 'CONFIRMED' | 'PROVISIONAL';
  unknowns: string[];
  notes: string;
  deck: {
    product: string | null;
    commander: string | null;
    cardListStatus: CardListStatus;
    sourceCitation: string | null;
    sourceDate: string | null;
    deckId: string | null;
  } | null;
}

export interface LeagueRuleView {
  ruleKey: string;
  value: string;
  status: 'CONFIRMED' | 'ASSUMED' | 'PENDING';
  note: string;
}

export interface LedgerEntryView {
  id: string;
  weekStart: string;
  option: 'SINGLES' | 'BOOSTER_PACKS';
  cardIn: string;
  cardOut: string;
  valueCents: number;
  priceStatus: PriceStatus;
  allowanceCents: number;
}

export interface GameView {
  id: string;
  playedOn: string;
  outcome: string;
  turns: number | null;
  notes: string;
  participants: { playerId: string; commander: string | null; placement: number | null }[];
  eliminations: {
    eliminatedPlayerId: string;
    causeSource: string;
    creditedPlayerId: string | null;
    points: number;
    attribution: string;
  }[];
}

export interface LeagueDetail {
  id: string;
  name: string;
  podSize: number;
  startingLife: number;
  players: LeaguePlayerView[];
  rules: LeagueRuleView[];
  ledger: LedgerEntryView[];
  games: GameView[];
  freshness?: Freshness;
}

export interface MatchupRow {
  opponentLabel: string;
  games: number;
  expectedPoints: LabelledNumber | null;
  winRate: (LabelledNumber & { low?: number; high?: number }) | null;
}

export interface MatchupView {
  rows: MatchupRow[];
  hypotheses: { playerId: string; text: string; confidence: number }[];
}

export interface CollectionEntry {
  id: string;
  name: string;
  status: 'OWNED' | 'PROXY';
  quantity: number;
}

export interface CatalogStatus extends Freshness {
  status: 'NEVER' | 'LOADING' | 'FRESH' | 'FAILED';
  cardCount: number;
  lastError: string | null;
}

export interface PriceView {
  printingId: string;
  name: string;
  priceCents: number | null;
  status: PriceStatus;
  source: string;
  observedOn: string | null;
  locked: boolean;
}

const P = '/api/magic';
const enc = encodeURIComponent;
const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

export const MagicApi = {
  catalogStatus: () => api<CatalogStatus>(`${P}/catalog/status`),
  refreshCatalog: () => api<CatalogStatus>(`${P}/catalog/refresh`, body({})),
  searchCatalog: (q: string) =>
    api<{ cards: { name: string; typeLine: string }[]; freshness?: Freshness }>(
      `${P}/catalog/search?q=${enc(q)}`,
    ),

  decks: () => api<{ decks: DeckSummary[]; freshness?: Freshness }>(`${P}/decks`),
  deck: (id: string) => api<DeckDetail>(`${P}/decks/${enc(id)}`),
  importDeck: (input: { name: string; format: MagicFormat; text: string }) =>
    api<ImportResult>(`${P}/decks/import`, body(input)),
  undo: (id: string) => api<DeckDetail>(`${P}/decks/${enc(id)}/undo`, body({})),
  diff: (id: string, from: number, to: number) =>
    api<DeckDiff>(`${P}/decks/${enc(id)}/diff?from=${from}&to=${to}`),
  exportDeck: (id: string) => api<{ text: string; filename: string }>(`${P}/decks/${enc(id)}/export`),
  collection: () => api<{ entries: CollectionEntry[] }>(`${P}/decks/collection`),
  setCollection: (input: { name: string; status: 'OWNED' | 'PROXY'; quantity: number }) =>
    api<{ entries: CollectionEntry[] }>(`${P}/decks/collection`, body(input)),

  validate: (deckId: string) => api<ValidationView>(`${P}/validate`, body({ deckId })),
  analyze: (input: { deckId: string; seed?: number; simulationRuns?: number }) =>
    api<AnalysisView>(`${P}/analyze`, body(input)),
  optimize: (input: { deckId: string; weights: OptimizeWeights; budgetCents: number | null }) =>
    api<OptimizeView>(`${P}/optimize`, body(input)),

  design: (input: { text: string; intentId?: string | null; answer?: string }) =>
    api<DesignIntentView>(`${P}/design/intents`, body(input)),
  buildFromDesign: (intentId: string, alternative?: number) =>
    api<{ deck: DeckSummary }>(`${P}/design/intents/${enc(intentId)}/build`, body({ alternative })),

  leagues: () => api<{ leagues: { id: string; name: string }[] }>(`${P}/leagues`),
  league: (id: string) => api<LeagueDetail>(`${P}/leagues/${enc(id)}`),
  updateRule: (id: string, ruleKey: string, value: string) =>
    api<LeagueDetail>(`${P}/leagues/${enc(id)}/rules`, body({ ruleKey, value })),
  addObservation: (
    id: string,
    input: { playerId: string | null; kind: string; detail: string; label: 'OBSERVED' | 'HYPOTHESIS' },
  ) => api<LeagueDetail>(`${P}/leagues/${enc(id)}/observations`, body(input)),
  logGame: (
    id: string,
    input: { playedOn: string; outcome: string; turns: number | null; notes: string },
  ) => api<LeagueDetail>(`${P}/leagues/${enc(id)}/games`, body(input)),
  matchups: (id: string) => api<MatchupView>(`${P}/leagues/${enc(id)}/matchups`),

  prices: (name: string) => api<{ prices: PriceView[]; freshness?: Freshness }>(`${P}/prices?name=${enc(name)}`),
  lockPrice: (input: { printingId: string; priceCents: number; source: string; observedOn: string }) =>
    api<PriceView>(`${P}/prices/snapshots`, body(input)),
};

/** USD integer-cent display: no floating-point money. */
export function formatCents(cents: number | null): string {
  if (cents === null) return 'unpriced';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parse "9.99" into 999 exactly; null for anything that is not dollars-and-cents. */
export function parseDollars(text: string): number | null {
  const match = /^\s*\$?(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const cents = (match[2] ?? '').padEnd(2, '0');
  return Number(match[1]) * 100 + Number(cents || '0');
}

export function sectionFromPath(path: string): MagicSection | null {
  const part = path.replace(/^\/magic\/?/, '').split('/')[0] ?? '';
  return (MAGIC_SECTIONS as readonly string[]).includes(part) ? (part as MagicSection) : null;
}

export function pathFor(section: MagicSection | null): string {
  return section ? `/magic/${section}` : '/magic';
}
