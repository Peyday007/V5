-- ---------------------------------------------------------------------------
-- MAGIC DECK LAB
-- ---------------------------------------------------------------------------
--
-- The card catalog (cards, printings, sources) is one shared catalog: facts
-- about Magic cards, not about any account. Everything else is owner-scoped by
-- `owner_user_id`. Deck versions, weekly ledgers, price snapshots, games,
-- eliminations and observations are append-only: a row is never updated in
-- place to say something different, so a prior deck or league state can be
-- replayed. Prices are integer cents. A Scryfall price is an ESTIMATE.

-- Per-source fetch record: when each catalog source was last read, and from
-- what URI the manifest named at that time. Nothing here is a fixed URI.
CREATE TABLE magic_catalog_sources (
  source_key       TEXT PRIMARY KEY,
  download_uri     TEXT,
  source_updated_at TEXT,
  fetched_at       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('NEVER', 'LOADING', 'FRESH', 'FAILED')),
  card_count       INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE magic_cards (
  oracle_id        TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL,
  layout           TEXT NOT NULL,
  mana_cost        TEXT NOT NULL DEFAULT '',
  cmc              INTEGER NOT NULL DEFAULT 0,
  type_line        TEXT NOT NULL DEFAULT '',
  oracle_text      TEXT NOT NULL DEFAULT '',
  colors           TEXT NOT NULL DEFAULT '[]',
  color_identity   TEXT NOT NULL DEFAULT '[]',
  keywords         TEXT NOT NULL DEFAULT '[]',
  faces            TEXT NOT NULL DEFAULT '[]',
  legalities       TEXT NOT NULL DEFAULT '{}',
  rulings          TEXT NOT NULL DEFAULT '[]',
  game_changer     INTEGER NOT NULL DEFAULT 0,
  source_key       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_cards_name ON magic_cards (name_key);

CREATE TABLE magic_printings (
  id               TEXT PRIMARY KEY,
  oracle_id        TEXT NOT NULL REFERENCES magic_cards(oracle_id) ON DELETE CASCADE,
  set_code         TEXT NOT NULL,
  collector_number TEXT NOT NULL,
  rarity           TEXT NOT NULL DEFAULT '',
  finishes         TEXT NOT NULL DEFAULT '[]',
  image_uris       TEXT NOT NULL DEFAULT '{}',
  price_usd_cents  INTEGER,
  price_usd_foil_cents INTEGER,
  price_fetched_at TEXT,
  released_at      TEXT,
  UNIQUE (set_code, collector_number, oracle_id)
);
CREATE INDEX idx_magic_printings_oracle ON magic_printings (oracle_id);

CREATE TABLE magic_decks (
  id               TEXT PRIMARY KEY,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  format           TEXT NOT NULL CHECK (format IN ('COMMANDER', 'STANDARD')),
  current_version_id TEXT,
  card_list_status TEXT NOT NULL DEFAULT 'VERIFIED' CHECK (card_list_status IN ('VERIFIED', 'UNVERIFIED')),
  notes            TEXT NOT NULL DEFAULT '',
  archived_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_decks_owner ON magic_decks (owner_user_id, updated_at);

CREATE TABLE magic_deck_versions (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  deck_id          TEXT NOT NULL REFERENCES magic_decks(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  version_number   INTEGER NOT NULL,
  parent_version_id TEXT,
  reason           TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'MANUAL',
  validation       TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  UNIQUE (deck_id, version_number)
);

CREATE TABLE magic_deck_cards (
  id               TEXT PRIMARY KEY,
  version_id       TEXT NOT NULL REFERENCES magic_deck_versions(id) ON DELETE CASCADE,
  zone             TEXT NOT NULL CHECK (zone IN ('commander', 'main', 'sideboard')),
  oracle_id        TEXT,
  card_name        TEXT NOT NULL,
  printing_id      TEXT,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  role             TEXT,
  UNIQUE (version_id, zone, card_name)
);
CREATE INDEX idx_magic_deck_cards_version ON magic_deck_cards (version_id);

CREATE TABLE magic_design_intents (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id          TEXT,
  raw_text         TEXT NOT NULL,
  structured       TEXT NOT NULL,
  conflicts        TEXT NOT NULL DEFAULT '[]',
  alternatives     TEXT NOT NULL DEFAULT '[]',
  question         TEXT,
  assumptions      TEXT NOT NULL DEFAULT '[]',
  state            TEXT NOT NULL CHECK (state IN ('DRAFT', 'NEEDS_DECISION', 'COHERENT', 'BUILT')),
  parent_intent_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_design_intents_owner ON magic_design_intents (owner_user_id, created_at);

CREATE TABLE magic_analyses (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id          TEXT,
  version_id       TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('ANALYZE', 'OPTIMIZE')),
  seed             TEXT,
  assumptions      TEXT NOT NULL DEFAULT '{}',
  result           TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_analyses_deck ON magic_analyses (owner_user_id, deck_id, created_at);

CREATE TABLE magic_collections (
  id               TEXT PRIMARY KEY,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oracle_id        TEXT,
  card_name        TEXT NOT NULL,
  printing_id      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('OWNED', 'PROXY')),
  quantity         INTEGER NOT NULL CHECK (quantity >= 0),
  updated_at       TEXT NOT NULL,
  UNIQUE (owner_user_id, card_name, status)
);

CREATE TABLE magic_leagues (
  id               TEXT PRIMARY KEY,
  owner_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seed_key         TEXT NOT NULL,
  name             TEXT NOT NULL,
  pod_size         INTEGER NOT NULL DEFAULT 4,
  starting_life    INTEGER NOT NULL DEFAULT 40,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (owner_user_id, seed_key)
);

CREATE TABLE magic_league_rules (
  id               TEXT PRIMARY KEY,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  rule_key         TEXT NOT NULL,
  value            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'ASSUMED', 'PENDING')),
  note             TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL,
  UNIQUE (league_id, rule_key)
);

CREATE TABLE magic_league_players (
  id               TEXT PRIMARY KEY,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  seed_key         TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  label            TEXT NOT NULL,
  is_owner         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'PROVISIONAL')),
  unknowns         TEXT NOT NULL DEFAULT '[]',
  notes            TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL,
  UNIQUE (league_id, seed_key)
);

-- A player's deck in a league. Opponent versions are rows here: a new
-- observation inserts a new row pointing at the one it follows, and the
-- precon baseline row is never changed.
CREATE TABLE magic_league_decks (
  id               TEXT PRIMARY KEY,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  player_id        TEXT NOT NULL REFERENCES magic_league_players(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  version_number   INTEGER NOT NULL,
  parent_league_deck_id TEXT,
  deck_id          TEXT,
  deck_version_id  TEXT,
  product          TEXT,
  commander        TEXT,
  card_list_status TEXT NOT NULL CHECK (card_list_status IN ('VERIFIED', 'UNVERIFIED', 'HYPOTHESIS')),
  source_citation  TEXT,
  source_date      TEXT,
  is_baseline      INTEGER NOT NULL DEFAULT 0,
  observed_at      TEXT,
  detail           TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  UNIQUE (player_id, version_number)
);

CREATE TABLE magic_weekly_ledgers (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  week_start       TEXT NOT NULL,
  allowance_cents  INTEGER NOT NULL,
  option           TEXT NOT NULL CHECK (option IN ('SINGLES', 'BOOSTER_PACKS')),
  card_in          TEXT NOT NULL DEFAULT '',
  card_out         TEXT NOT NULL DEFAULT '',
  printing_id      TEXT,
  value_cents      INTEGER NOT NULL DEFAULT 0,
  price_status     TEXT NOT NULL CHECK (price_status IN ('CONFIRMED', 'ESTIMATE')),
  before_version_id TEXT,
  after_version_id TEXT,
  locked_at        TEXT NOT NULL
);
CREATE INDEX idx_magic_weekly_ledgers_league ON magic_weekly_ledgers (league_id, week_start);

CREATE TABLE magic_purchases (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  ledger_id        TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('SINGLE', 'BOOSTER_PACK')),
  description      TEXT NOT NULL,
  printing_id      TEXT,
  cost_cents       INTEGER NOT NULL,
  price_status     TEXT NOT NULL CHECK (price_status IN ('CONFIRMED', 'ESTIMATE')),
  purchased_on     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE magic_price_snapshots (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  owner_user_id    TEXT,
  printing_id      TEXT NOT NULL,
  price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
  status           TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'ESTIMATE')),
  source           TEXT NOT NULL,
  observed_on      TEXT NOT NULL,
  locked           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_price_snapshots_printing ON magic_price_snapshots (printing_id, created_at);

CREATE TABLE magic_games (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  played_on        TEXT NOT NULL,
  turns            INTEGER,
  outcome          TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  house_rules      TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_games_league ON magic_games (league_id, played_on);

CREATE TABLE magic_game_participants (
  id               TEXT PRIMARY KEY,
  game_id          TEXT NOT NULL REFERENCES magic_games(id) ON DELETE CASCADE,
  player_id        TEXT NOT NULL,
  league_deck_id   TEXT,
  commander        TEXT,
  seat             INTEGER NOT NULL,
  life_snapshots   TEXT NOT NULL DEFAULT '[]',
  key_cards        TEXT NOT NULL DEFAULT '[]',
  threats          TEXT NOT NULL DEFAULT '[]',
  placement        INTEGER,
  UNIQUE (game_id, player_id)
);

CREATE TABLE magic_eliminations (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  game_id          TEXT NOT NULL REFERENCES magic_games(id) ON DELETE CASCADE,
  eliminated_player_id TEXT NOT NULL,
  order_index      INTEGER NOT NULL,
  cause_source     TEXT NOT NULL DEFAULT '',
  source_controller_player_id TEXT,
  credited_player_id TEXT,
  points           INTEGER NOT NULL DEFAULT 0,
  attribution      TEXT NOT NULL CHECK (attribution IN ('OWN_SOURCE', 'FORCED_ATTACK', 'HOUSE_RULE', 'UNASSIGNED')),
  note             TEXT NOT NULL DEFAULT '',
  UNIQUE (game_id, eliminated_player_id)
);

CREATE TABLE magic_observations (
  id               TEXT PRIMARY KEY,
  seq              BIGSERIAL,
  league_id        TEXT NOT NULL REFERENCES magic_leagues(id) ON DELETE CASCADE,
  owner_user_id    TEXT NOT NULL,
  player_id        TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('REVEALED_CARD', 'COMMANDER', 'PURCHASE', 'RESULT', 'NOTE')),
  label            TEXT NOT NULL CHECK (label IN ('OBSERVED', 'HYPOTHESIS')),
  detail           TEXT NOT NULL,
  confidence       DOUBLE PRECISION,
  resulting_league_deck_id TEXT,
  observed_on      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_magic_observations_league ON magic_observations (league_id, observed_on);
