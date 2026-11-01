# Magic Deck Lab

A mathematical Magic: The Gathering deck-design system for Commander and Standard, inside Brain, with one saved
workspace — the Precon Commander League — built on the same engine as every other deck. It extends the owners that
already exist (the Russell shell, Express routes behind `requirePerson`, repositories over the async database
adapter, numbered SQLite and Postgres migrations); it adds no second frontend, service, queue, scheduler or
authentication mechanism, and it calls no paid API.

## What a number means

Every number the engine produces carries one label, and a score is never shown as a win rate.

| label | what it is |
|---|---|
| `EXACT_PROBABILITY` | Hypergeometric arithmetic over the library, done with exact rationals. Joint events count a card once. |
| `MODEL_ESTIMATE` | A seeded Monte Carlo result, reported with its runs, mulligan policy and draw rules. |
| `HEURISTIC_SCORE` | A rule-of-thumb score for comparing builds. The composite optimizer score is this and nothing more. |
| `EMPIRICAL_MATCH_RESULT` | Counted from logged league games, with the game count beside it. |

Prices have a status: `CONFIRMED` (a person entered it, with a source and a date) or `ESTIMATE` (Scryfall's figure, which
is not a verified market price). An `ESTIMATE` can never be league-approved. Money is integer cents; $9.99 and $10.00
pass the weekly allowance and $10.01 does not.

## Who owns which fact

- **The catalog** is shared and keyed by Scryfall Oracle ID, with printings kept apart. The bulk file is discovered at
  run time from the Scryfall manifest, streamed with bounds, and refreshed off the request path. On an outage the cached
  index is served and labelled stale. Tests use committed fixtures.
- **Rules** (copy limits, "any number" cards, partner and background pairs, colour identity, legality as of the analysis
  date) come from committed rules data, never from matching strings loosely.
- **A deck** belongs to one person. Versions are append-only; undo moves a pointer. The collection (owned or proxy) is
  stored apart from deck membership.
- **Prices** belong to a printing; a confirmed entry belongs to the person who made it.
- **The league** belongs to its owner and is created, once, on first access. Nothing seeded overwrites an edit.
- **Brain** derives analyses, optimizer results and standings. They are never typed in.

## Unknowns that stay unknown

The league seed is a set of named records, not a set of invented card lists. No official 100-card list has been verified
with a source and a date, so none is loaded: every deck is labelled *unverified cardlist* until one is. Red Foundations
and Green Foundations have an unknown product, commander and list. Sky Warden's replacement commander is unknown until it
is observed, and when it is observed it becomes a new version; the baseline is not rewritten. Rollover is not confirmed:
it is assumed to be none, shown as pending and editable, and unconfirmed money is never accumulated. The booster-pack
option is recorded with its sets unconfirmed and never blocks singles. Simultaneous elimination, commander damage and
alternate losses are house rules a person decides.

## Scoring

The first two credited eliminations are worth 1 point each and the final one 2. Points go to the player whose own spell,
creature or ability causes the elimination; Kardur's own life-loss trigger counts. A kill made by an attacker that
Kardur's goad forced to attack is credited to the attacker's controller, so a game in which the owner causes the first
and last eliminations and a goaded creature causes the middle one scores the owner 3, not 4.

## Endpoints

Every route requires a signed-in person (a worker is refused by type) and every read or write is scoped to that person
inside the repository, so a resource that is somebody else's and one that does not exist are answered with the same 404
and the same body. A database that did not answer is a retryable 503, never a result.

### Catalog
- `GET /api/magic/catalog/status`
- `GET /api/magic/catalog/search`
- `GET /api/magic/catalog/cards`
- `POST /api/magic/catalog/refresh`

### Prices
- `GET /api/magic/prices/printings/:printingId`
- `POST /api/magic/prices/printings/:printingId/snapshots`
- `POST /api/magic/prices/snapshots/:id/lock`
- `GET /api/magic/prices/cards/:oracleId/printings`
- `POST /api/magic/prices/eligibility`

### Decks and collection
- `GET /api/magic/decks`
- `POST /api/magic/decks/import`
- `GET /api/magic/decks/:deckId`
- `GET /api/magic/decks/:deckId/versions`
- `POST /api/magic/decks/:deckId/versions`
- `POST /api/magic/decks/:deckId/undo`
- `POST /api/magic/decks/:deckId/restore`
- `GET /api/magic/decks/:deckId/diff`
- `GET /api/magic/decks/:deckId/export`
- `POST /api/magic/decks/:deckId/commander`
- `GET /api/magic/collection`
- `PUT /api/magic/collection`

### Validate, analyze, optimize
- `POST /api/magic/validate`
- `POST /api/magic/analyze`
- `POST /api/magic/optimize`

### Design
- `POST /api/magic/design/intent`
- `POST /api/magic/design/refine`
- `POST /api/magic/design/choose`
- `POST /api/magic/design/build`

### League
- `GET /api/magic/leagues`
- `GET /api/magic/leagues/:leagueId`
- `PATCH /api/magic/leagues/:leagueId`
- `PUT /api/magic/leagues/:leagueId/rules/:ruleKey`
- `PATCH /api/magic/leagues/:leagueId/players/:playerId`
- `POST /api/magic/leagues/:leagueId/players/:playerId/decks`
- `POST /api/magic/leagues/:leagueId/games`
- `GET /api/magic/leagues/:leagueId/games`
- `POST /api/magic/leagues/:leagueId/ledger`
- `POST /api/magic/leagues/:leagueId/purchases`
- `POST /api/magic/leagues/:leagueId/observations`

`optimize` and `design/build` take an explicit `poolNames` list; the whole catalog is not searched.

## Tables

`magic_catalog_sources`, `magic_cards`, `magic_printings` — the shared catalog and when each source was fetched.
`magic_decks`, `magic_deck_versions`, `magic_deck_cards` — decks, append-only versions and the cards of each.
`magic_design_intents` — what the strategy architect understood, its conflicts and its question.
`magic_analyses` — saved analyses and optimizer results with their seeds and assumptions.
`magic_collections` — owned and proxy copies, apart from any deck.
`magic_price_snapshots` — dated, sourced prices, optionally locked.
`magic_leagues`, `magic_league_rules`, `magic_league_players`, `magic_league_decks` — the league, its rules with their status, its participants and their deck versions.
`magic_weekly_ledgers`, `magic_purchases` — the date-locked weekly ledger and what was actually bought.
`magic_games`, `magic_game_participants`, `magic_eliminations` — the match log with attribution and points.
`magic_observations` — what was seen, labelled observed or hypothesis.

## Not built

Typesetting, purchasing automation and any proxy that avoids the budget are not part of this feature, and nothing in it buys anything.
