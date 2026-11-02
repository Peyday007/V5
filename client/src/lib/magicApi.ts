/**
 * Magic Deck Lab over HTTP.
 *
 * Thin by design: every number, legality and verdict is the server's. This file
 * names the routes in `server/routes/magic.ts` exactly — path, method and body —
 * and the shapes they answer with. Every response type is imported type-only
 * from the server module that produces it, so the two halves cannot drift
 * (CLAUDE.md §29, §30 — a client holding its own copy of a contract is a second
 * contract, and the first version of this file was exactly that).
 */
import { api } from './api.ts';
import type {
  CardListStatus,
  LabelledNumber,
  MagicCollectionRow,
  MagicFormat,
  MagicObservationRow,
  MagicPurchaseRow,
  MagicWeeklyLedgerRow,
  MagicZone,
  NumberLabel,
  ObservationKind,
  PriceStatus,
  EliminationAttribution,
} from '../../../server/domain/magicTypes.ts';
import type { MagicLeagueRow } from '../../../server/domain/magicTypes.ts';
import type { CatalogStatus } from '../../../server/services/magic/catalog/lookup.ts';
import type { CatalogCard } from '../../../server/repos/magicCatalog.ts';
import type {
  DeckCardInput,
  DeckVersionView,
  DeckView,
  VersionDiff,
} from '../../../server/repos/magicDecks.ts';
import type { ImportReport } from '../../../server/services/magic/decks/service.ts';
import type { ParseProblem } from '../../../server/services/magic/decks/parse.ts';
import type { ResolutionIssue } from '../../../server/services/magic/decks/resolve.ts';
import type { ValidationResult } from '../../../server/services/magic/rules/validate.ts';
import type { AnalysisResult, Labelled } from '../../../server/services/magic/analysis/analyze.ts';
import type { OptimizeResult, ScoredBuild } from '../../../server/services/magic/optimizer/types.ts';
import type {
  Alternative,
  Conflict,
  DesignIntent,
  DesignPlan,
  HardConstraint,
  Question,
} from '../../../server/services/magic/design/types.ts';
import type { BuildResult, BuiltCard } from '../../../server/services/magic/design/build.ts';
import type {
  GameInput,
  GameView,
  LeagueDeckView,
  PlayerView,
  RuleView,
} from '../../../server/repos/magicLeague.ts';
import type { RankedSwap } from '../../../server/services/magic/league/nextTen.ts';
import type { PriceSnapshot } from '../../../server/repos/magicPrices.ts';
import type {
  AlternatePrinting,
  PriceReading,
  Resolution,
} from '../../../server/services/magic/prices/prices.ts';

export type {
  Alternative, AnalysisResult, BuildResult, BuiltCard, CardListStatus, CatalogCard, CatalogStatus, Conflict,
  DeckCardInput, DeckVersionView, DeckView, DesignIntent, DesignPlan, EliminationAttribution, GameInput, GameView,
  ImportReport, LabelledNumber, Labelled, LeagueDeckView, MagicFormat, MagicZone, NumberLabel, ObservationKind,
  OptimizeResult, ParseProblem, PlayerView, PriceStatus, Question, ResolutionIssue, RuleView, ScoredBuild,
  ValidationResult, VersionDiff,
};

export type HardConstraintView = HardConstraint;

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

/* ------------------------------------------------------------- response shapes */

/** `POST /magic/design/{intent,refine,choose}`: the plan, plus the row it was saved as. */
export type DesignPlanResponse = DesignPlan & { intentId: string };

export interface BuildResponse {
  build: BuildResult;
  unknownPoolNames: string[];
  catalog: CatalogStatus;
}

export interface DeckResponse {
  deck: DeckView;
  version: DeckVersionView | null;
}

export type DeckVersionSummary = Omit<DeckVersionView, 'cards'>;

export interface ValidateResponse {
  validation: ValidationResult;
  catalog: CatalogStatus;
}

export interface AnalyzeResponse {
  analysis: AnalysisResult;
  catalog: CatalogStatus;
}

export interface OptimizeResponse {
  optimization: OptimizeResult;
  unknownPoolNames: string[];
  catalog: CatalogStatus;
}

export interface CommanderChangeResponse {
  version: DeckVersionView;
  validation: ValidationResult;
  issues: ResolutionIssue[];
}

export interface LeagueDetail {
  league: MagicLeagueRow;
  rules: RuleView[];
  players: PlayerView[];
  /** Every player's league-deck versions, oldest first, keyed by player id. */
  decks: Record<string, LeagueDeckView[]>;
  ledger: MagicWeeklyLedgerRow[];
  purchases: MagicPurchaseRow[];
  observations: MagicObservationRow[];
}

export interface GamesResponse {
  games: GameView[];
  standings: { player: string; points: number; games: number }[];
}

export type NextTenSuggestion = RankedSwap & { printing: { setCode: string; collectorNumber: string } | null };

export interface NextTenResponse {
  allowanceCents: number;
  suggestions: NextTenSuggestion[];
  baseline: ScoredBuild['composite'];
  note: string;
  catalog: CatalogStatus;
}

export interface MatchupOpponent {
  playerId: string;
  label: string;
  commander: string;
  cardListStatus: CardListStatus;
  versions: number;
  observedTraits: { noncombatDrain?: boolean; manyCreatures?: boolean };
  attackOnlyDefenseStopsThem: boolean;
  goadAgainstThem: string | null;
  record: { games: number; ownerPoints: number; ownerPointsPerGame: number | null; label: 'EMPIRICAL_MATCH_RESULT' };
}

export interface GoadReading {
  goad: 'USEFUL' | 'WEAK_OR_HARMFUL' | 'NONE';
  note: string;
}

export interface MatchupsResponse {
  owner: {
    label: string;
    commander: string | null;
    unknownCards: number;
    goadInPod: GoadReading;
    goadIn1v1: GoadReading;
    ownLifeLossTrigger: string;
  };
  opponents: MatchupOpponent[];
  note: string;
}

export interface ObservationInput {
  playerId: string | null;
  kind: ObservationKind;
  label: 'OBSERVED' | 'HYPOTHESIS';
  detail: Record<string, unknown>;
  observedOn: string;
}

export interface ObservationResponse {
  observation: MagicObservationRow;
  version: LeagueDeckView | null;
}

export interface CardPrintingsResponse {
  card: string;
  resolution: Resolution;
  alternates: AlternatePrinting[];
}

export type CollectionEntry = MagicCollectionRow;

/* --------------------------------------------------------------------- routes */

const P = '/api/magic';
const enc = encodeURIComponent;
const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
const put = (value: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(value) });

export const MagicApi = {
  /* catalog */
  catalogStatus: () => api<CatalogStatus>(`${P}/catalog/status`),
  refreshCatalog: () => api<{ started: boolean; status: CatalogStatus }>(`${P}/catalog/refresh`, post({})),
  searchCatalog: (q: string, limit = 20) =>
    api<{ cards: CatalogCard[]; status: CatalogStatus }>(`${P}/catalog/search?q=${enc(q)}&limit=${limit}`),

  /* decks */
  decks: () => api<{ decks: DeckView[] }>(`${P}/decks`),
  deck: (id: string) => api<DeckResponse>(`${P}/decks/${enc(id)}`),
  importDeck: (input: { name: string; format: MagicFormat; text: string }) =>
    api<ImportReport>(`${P}/decks/import`, post(input)),
  versions: (id: string) => api<{ versions: DeckVersionSummary[] }>(`${P}/decks/${enc(id)}/versions`),
  saveVersion: (id: string, input: { cards: DeckCardInput[]; reason?: string }) =>
    api<{ version: DeckVersionView; validation: ValidationResult }>(`${P}/decks/${enc(id)}/versions`, post(input)),
  undo: (id: string) => api<{ version: DeckVersionView }>(`${P}/decks/${enc(id)}/undo`, post({})),
  restore: (id: string, versionId: string) =>
    api<{ version: DeckVersionView }>(`${P}/decks/${enc(id)}/restore`, post({ versionId })),
  diff: (id: string, fromVersionId: string, toVersionId: string) =>
    api<{ diff: VersionDiff }>(
      `${P}/decks/${enc(id)}/diff?from=${enc(fromVersionId)}&to=${enc(toVersionId)}`,
    ),
  exportDeck: (id: string, versionId?: string) =>
    api<{ text: string }>(
      `${P}/decks/${enc(id)}/export${versionId ? `?versionId=${enc(versionId)}` : ''}`,
    ),
  changeCommander: (id: string, commanders: string[]) =>
    api<CommanderChangeResponse>(`${P}/decks/${enc(id)}/commander`, post({ commanders })),

  /* collection */
  collection: () => api<{ collection: CollectionEntry[] }>(`${P}/collection`),
  setCollection: (input: { cardName: string; status: 'OWNED' | 'PROXY'; quantity: number }) =>
    api<{ collection: CollectionEntry[] }>(`${P}/collection`, put(input)),

  /* validate / analyze / optimize */
  validate: (deckId: string) => api<ValidateResponse>(`${P}/validate`, post({ deckId })),
  analyze: (input: { deckId: string; seed?: number; simulationRuns?: number; onThePlay?: boolean }) =>
    api<AnalyzeResponse>(`${P}/analyze`, post(input)),
  optimize: (input: {
    deckId: string;
    poolNames?: string[];
    constraints: { priceCeilingCents: number | null; protectedNames: string[]; excludedNames?: string[]; ownedOnly?: boolean };
    maxSwaps?: number;
  }) => api<OptimizeResponse>(`${P}/optimize`, post(input)),

  /* design */
  designIntent: (idea: string) => api<DesignPlanResponse>(`${P}/design/intent`, post({ idea })),
  designRefine: (intent: DesignIntent, utterance: string, intentId: string | null) =>
    api<DesignPlanResponse>(`${P}/design/refine`, post({ intent, utterance, intentId })),
  designChoose: (intent: DesignIntent, alternativeId: string, intentId: string | null) =>
    api<DesignPlanResponse>(`${P}/design/choose`, post({ intent, alternativeId, intentId })),
  /** No pool is named: the server draws on every format-legal card in the catalog. */
  designBuild: (intent: DesignIntent) => api<BuildResponse>(`${P}/design/build`, post({ intent })),

  /* league */
  leagues: () => api<{ leagues: MagicLeagueRow[] }>(`${P}/leagues`),
  league: (id: string) => api<LeagueDetail>(`${P}/leagues/${enc(id)}`),
  setRule: (id: string, ruleKey: string, input: { value: unknown; status: RuleView['status']; note?: string }) =>
    api<{ rules: RuleView[] }>(`${P}/leagues/${enc(id)}/rules/${enc(ruleKey)}`, put(input)),
  addObservation: (id: string, input: ObservationInput) =>
    api<ObservationResponse>(`${P}/leagues/${enc(id)}/observations`, post(input)),
  logGame: (id: string, input: GameInput) => api<{ game: GameView }>(`${P}/leagues/${enc(id)}/games`, post(input)),
  games: (id: string) => api<GamesResponse>(`${P}/leagues/${enc(id)}/games`),
  nextTen: (id: string) => api<NextTenResponse>(`${P}/leagues/${enc(id)}/next-ten`, post({})),
  matchups: (id: string) => api<MatchupsResponse>(`${P}/leagues/${enc(id)}/matchups`),

  /* prices */
  printingPrice: (printingId: string) =>
    api<{ reading: PriceReading }>(`${P}/prices/printings/${enc(printingId)}`),
  cardPrintings: (oracleId: string, printingId?: string) =>
    api<CardPrintingsResponse>(
      `${P}/prices/cards/${enc(oracleId)}/printings${printingId ? `?printingId=${enc(printingId)}` : ''}`,
    ),
  recordPrice: (printingId: string, input: { priceCents: number; source: string; observedOn: string; lock?: boolean }) =>
    api<{ snapshot: PriceSnapshot }>(`${P}/prices/printings/${enc(printingId)}/snapshots`, post(input)),
  lockPrice: (snapshotId: string) => api<{ locked: boolean }>(`${P}/prices/snapshots/${enc(snapshotId)}/lock`, post({})),
};

/* -------------------------------------------------------------------- helpers */

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

/**
 * A built deck as the plaintext list `POST /magic/decks/import` reads: a
 * Commander section and a Deck section, one "N Name" line each.
 */
export function deckListText(cards: { zone: MagicZone; quantity: number; name: string }[]): string {
  const section = (title: string, zone: MagicZone): string => {
    const rows = cards.filter((c) => c.zone === zone).map((c) => `${c.quantity} ${c.name}`);
    return rows.length ? `${title}\n${rows.join('\n')}` : '';
  };
  return [section('Commander', 'commander'), section('Deck', 'main'), section('Sideboard', 'sideboard')]
    .filter(Boolean)
    .join('\n\n');
}

export function sectionFromPath(path: string): MagicSection | null {
  const part = path.replace(/^\/magic\/?/, '').split('/')[0] ?? '';
  return (MAGIC_SECTIONS as readonly string[]).includes(part) ? (part as MagicSection) : null;
}

export function pathFor(section: MagicSection | null): string {
  return section ? `/magic/${section}` : '/magic';
}
