/**
 * Magic Deck Lab: closed vocabularies, row types and the API payloads shared by
 * the server and the client.
 *
 * Rows hold the database shape (booleans as 0/1, JSON as text, money as integer
 * cents); repositories are the only place that shape meets the view types.
 * Every number the engine produces carries one of NUMBER_LABELS, and a price
 * carries a PRICE_STATUS: a Scryfall price is an ESTIMATE, never CONFIRMED.
 */

export const MAGIC_FORMATS = ['COMMANDER', 'STANDARD'] as const;
export type MagicFormat = (typeof MAGIC_FORMATS)[number];

export const MAGIC_ZONES = ['commander', 'main', 'sideboard'] as const;
export type MagicZone = (typeof MAGIC_ZONES)[number];

export const NUMBER_LABELS = [
  'EXACT_PROBABILITY',
  'MODEL_ESTIMATE',
  'HEURISTIC_SCORE',
  'EMPIRICAL_MATCH_RESULT',
] as const;
export type NumberLabel = (typeof NUMBER_LABELS)[number];

export const PRICE_STATUSES = ['CONFIRMED', 'ESTIMATE'] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

export const MAGIC_COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export type MagicColor = (typeof MAGIC_COLORS)[number];

export const CARD_LIST_STATUSES = ['VERIFIED', 'UNVERIFIED', 'HYPOTHESIS'] as const;
export type CardListStatus = (typeof CARD_LIST_STATUSES)[number];

export const ELIMINATION_ATTRIBUTIONS = ['OWN_SOURCE', 'FORCED_ATTACK', 'HOUSE_RULE', 'UNASSIGNED'] as const;
export type EliminationAttribution = (typeof ELIMINATION_ATTRIBUTIONS)[number];

export const OBSERVATION_KINDS = ['REVEALED_CARD', 'COMMANDER', 'PURCHASE', 'RESULT', 'NOTE'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const DESIGN_STATES = ['DRAFT', 'NEEDS_DECISION', 'COHERENT', 'BUILT'] as const;
export type DesignState = (typeof DESIGN_STATES)[number];

export const ARCHETYPES = [
  'aggro', 'control', 'midrange', 'tempo', 'combo', 'defensive', 'political',
  'go-wide', 'sacrifice', 'recursion', 'life-drain', 'tribal', 'artifacts', 'budget', 'custom',
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** A number the engine produced, and what kind of claim it is. */
export interface LabelledNumber {
  value: number;
  label: NumberLabel;
  note?: string;
}

export interface MagicCardRow {
  oracle_id: string;
  name: string;
  name_key: string;
  layout: string;
  mana_cost: string;
  cmc: number;
  type_line: string;
  oracle_text: string;
  colors: string;
  color_identity: string;
  keywords: string;
  faces: string;
  legalities: string;
  rulings: string;
  game_changer: number;
  source_key: string;
  fetched_at: string;
}

export interface MagicPrintingRow {
  id: string;
  oracle_id: string;
  set_code: string;
  collector_number: string;
  rarity: string;
  finishes: string;
  image_uris: string;
  price_usd_cents: number | null;
  price_usd_foil_cents: number | null;
  price_fetched_at: string | null;
  released_at: string | null;
}

export interface MagicCatalogSourceRow {
  source_key: string;
  download_uri: string | null;
  source_updated_at: string | null;
  fetched_at: string | null;
  status: 'NEVER' | 'LOADING' | 'FRESH' | 'FAILED';
  card_count: number;
  last_error: string | null;
  updated_at: string;
}

export interface MagicDeckRow {
  id: string;
  owner_user_id: string;
  name: string;
  format: MagicFormat;
  current_version_id: string | null;
  card_list_status: 'VERIFIED' | 'UNVERIFIED';
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MagicDeckVersionRow {
  id: string;
  deck_id: string;
  owner_user_id: string;
  version_number: number;
  parent_version_id: string | null;
  reason: string;
  source: string;
  validation: string;
  created_at: string;
}

export interface MagicDeckCardRow {
  id: string;
  version_id: string;
  zone: MagicZone;
  oracle_id: string | null;
  card_name: string;
  printing_id: string | null;
  quantity: number;
  role: string | null;
}

export interface MagicDesignIntentRow {
  id: string;
  owner_user_id: string;
  deck_id: string | null;
  raw_text: string;
  structured: string;
  conflicts: string;
  alternatives: string;
  question: string | null;
  assumptions: string;
  state: DesignState;
  parent_intent_id: string | null;
  created_at: string;
}

export interface MagicAnalysisRow {
  id: string;
  owner_user_id: string;
  deck_id: string | null;
  version_id: string | null;
  kind: 'ANALYZE' | 'OPTIMIZE';
  seed: string | null;
  assumptions: string;
  result: string;
  created_at: string;
}

export interface MagicCollectionRow {
  id: string;
  owner_user_id: string;
  oracle_id: string | null;
  card_name: string;
  printing_id: string | null;
  status: 'OWNED' | 'PROXY';
  quantity: number;
  updated_at: string;
}

export interface MagicLeagueRow {
  id: string;
  owner_user_id: string;
  seed_key: string;
  name: string;
  pod_size: number;
  starting_life: number;
  created_at: string;
  updated_at: string;
}

export interface MagicLeagueRuleRow {
  id: string;
  league_id: string;
  rule_key: string;
  value: string;
  status: 'CONFIRMED' | 'ASSUMED' | 'PENDING';
  note: string;
  updated_at: string;
}

export interface MagicLeaguePlayerRow {
  id: string;
  league_id: string;
  owner_user_id: string;
  seed_key: string;
  ordinal: number;
  label: string;
  is_owner: number;
  status: 'CONFIRMED' | 'PROVISIONAL';
  unknowns: string;
  notes: string;
  updated_at: string;
}

export interface MagicLeagueDeckRow {
  id: string;
  league_id: string;
  player_id: string;
  owner_user_id: string;
  version_number: number;
  parent_league_deck_id: string | null;
  deck_id: string | null;
  deck_version_id: string | null;
  product: string | null;
  commander: string | null;
  card_list_status: CardListStatus;
  source_citation: string | null;
  source_date: string | null;
  is_baseline: number;
  observed_at: string | null;
  detail: string;
  created_at: string;
}

export interface MagicWeeklyLedgerRow {
  id: string;
  league_id: string;
  owner_user_id: string;
  week_start: string;
  allowance_cents: number;
  option: 'SINGLES' | 'BOOSTER_PACKS';
  card_in: string;
  card_out: string;
  printing_id: string | null;
  value_cents: number;
  price_status: PriceStatus;
  before_version_id: string | null;
  after_version_id: string | null;
  locked_at: string;
}

export interface MagicPurchaseRow {
  id: string;
  league_id: string;
  owner_user_id: string;
  ledger_id: string | null;
  kind: 'SINGLE' | 'BOOSTER_PACK';
  description: string;
  printing_id: string | null;
  cost_cents: number;
  price_status: PriceStatus;
  purchased_on: string;
  created_at: string;
}

export interface MagicPriceSnapshotRow {
  id: string;
  owner_user_id: string | null;
  printing_id: string;
  price_cents: number;
  status: PriceStatus;
  source: string;
  observed_on: string;
  locked: number;
  created_at: string;
}

export interface MagicGameRow {
  id: string;
  league_id: string;
  owner_user_id: string;
  played_on: string;
  turns: number | null;
  outcome: string;
  notes: string;
  house_rules: string;
  created_at: string;
}

export interface MagicGameParticipantRow {
  id: string;
  game_id: string;
  player_id: string;
  league_deck_id: string | null;
  commander: string | null;
  seat: number;
  life_snapshots: string;
  key_cards: string;
  threats: string;
  placement: number | null;
}

export interface MagicEliminationRow {
  id: string;
  game_id: string;
  eliminated_player_id: string;
  order_index: number;
  cause_source: string;
  source_controller_player_id: string | null;
  credited_player_id: string | null;
  points: number;
  attribution: EliminationAttribution;
  note: string;
}

export interface MagicObservationRow {
  id: string;
  league_id: string;
  owner_user_id: string;
  player_id: string | null;
  kind: ObservationKind;
  label: 'OBSERVED' | 'HYPOTHESIS';
  detail: string;
  confidence: number | null;
  resulting_league_deck_id: string | null;
  observed_on: string;
  created_at: string;
}

/** Every table this feature owns, for guards that must see them all. */
export const MAGIC_TABLES = [
  'magic_catalog_sources', 'magic_cards', 'magic_printings', 'magic_decks', 'magic_deck_versions',
  'magic_deck_cards', 'magic_design_intents', 'magic_analyses', 'magic_collections', 'magic_leagues',
  'magic_league_rules', 'magic_league_players', 'magic_league_decks', 'magic_weekly_ledgers',
  'magic_purchases', 'magic_price_snapshots', 'magic_games', 'magic_game_participants',
  'magic_eliminations', 'magic_observations',
] as const;
