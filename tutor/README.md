# Deck Tutor — learn the Magic deck you own

Import your actual Commander deck. Deck Tutor teaches you how it works, then lets you play real
practice games against Forge's AI, with a tutor beside the board explaining decisions.

- **Gameplay is Forge.** Every rule, every legal action and every AI move comes from the
  [Forge](https://github.com/Card-Forge/forge) rules engine. Nothing in this app simulates
  Magic.
- **Card facts come from Scryfall.** That covers card identity, Oracle text, images, legality
  and rulings, cached locally from Scryfall's bulk data.
- **Rule references come from the official Comprehensive Rules.** The current version is
  fetched from Wizards of the Coast, and its effective date is shown.
- **The language model only explains and recommends.** It sees only what you can see. Any
  action it suggests must be one Forge currently offers; the server checks this again, and you
  choose whether to take it. Without a model configured, everything except live model
  commentary still works.

Only **Magic: The Gathering — Commander** is implemented. A small `GameAdapter` interface
(`server/games/types.ts`) keeps room for another game, such as Pokémon, without building it now.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite`).
- Java **17+** and **Maven 3.8+**, to build Forge once.
- About 2 GB of disk for the Forge build and 400 MB for the card cache.
- Outbound HTTPS to `github.com`, Maven Central, `api.scryfall.com`, `data.scryfall.io` and
  `magic.wizards.com` / `media.wizards.com`, during setup and card syncs.

## Setup

```sh
cd tutor
npm install
cp env.example .env          # optional: add ANTHROPIC_API_KEY for live coaching
npm run forge:setup          # fetch + build the pinned Forge revision, then compile the bridge (~5-10 min)
npm run cards:sync           # download Scryfall's Oracle data + rulings and the Comprehensive Rules
npm run build                # typecheck and build the web client
```

`forge:setup` checks out Forge at the revision in `forge/FORGE_REVISION` into `../../forge-src/forge`
by default, outside this repository. Pass another path as the first argument to use a different
directory. It records the built jar's location in `forge/FORGE_JAR`.

## Run

Use two terminals:

```sh
npm run bridge               # Forge bridge on 127.0.0.1:8765 (loads ~33,500 cards in ~10 s)
npm start                    # web app on http://127.0.0.1:8790
```

Then open <http://127.0.0.1:8790>.

For development with hot reload, run `npm run dev`. The client is served on
<http://127.0.0.1:5180> and proxies `/api` to the server.

## Environment variables

See `env.example`. All of them are read by the server only, and nothing is sent to the browser.

| Variable | Default | Meaning |
|---|---|---|
| `TUTOR_PORT` | `8790` | Web server port (binds 127.0.0.1) |
| `TUTOR_DATA_DIR` | `./data` | Saved decks, card cache, rules, match records, OCR model |
| `FORGE_BRIDGE_URL` | `http://127.0.0.1:8765` | Where the Forge bridge listens |
| `FORGE_BRIDGE_PORT` | `8765` | Port the bridge binds (read by `npm run bridge`) |
| `ANTHROPIC_API_KEY` | *(empty)* | Turns on live model coaching; leave empty to run without it |
| `TUTOR_MODEL` | `claude-opus-5-5` | Model used for coaching and card-photo reading |
| `SCRYFALL_USER_AGENT` | `MTGDeckTutor/0.1` | Identifies the app to Scryfall, as its API asks |
| `TUTOR_BRIDGE_SCENARIOS` | *(unset)* | Tests only: allow set-up positions (bridge and server) |

## Using it

1. **My decks → Import a deck.**
   - Paste a list, upload a `.txt` or `.csv` file, or read a screenshot or card photo. Images
     go through an editable recognition preview.
   - Lines are shown exactly as recognized, and nothing is guessed. Anything unclear stays on
     screen with a fix until you resolve it, under one of four problem kinds:
     - **recognition**: an unknown name, an ambiguous name, an unreadable line, or a printing
       mismatch;
     - **Commander deckbuilding**: size, singleton, color identity, banned cards, or the
       commander;
     - **engine support**: a legal card this Forge build cannot play;
     - **Forge's own deck check**.
   - Confirm the commander. It is taken from a `Commander` section or `*CMDR*` marker, or
     chosen by you.
   - Save the deck. Saved decks open again without re-importing.
   - *Try the Hail, Caesar sample* loads the Fallout precon: Caesar, Legion's Emperor as
     commander, with Mr. House, President and CEO in the 99. Edit it to match your own copy.
2. **Deck guide.** It covers:
   - the game plan and how the deck wins;
   - what the commander does;
   - card roles and key cards;
   - keywords, with their rule numbers;
   - the mana curve;
   - opening-hand and mulligan advice;
   - interactions between cards in the deck.

   Tap any card for its image (both faces where relevant), Oracle text, a plain-language
   explanation, how it fits the deck, keyword rules and rulings.
3. **Practice.** Choose 1 AI opponent (two-player Commander practice: Commander rules, not Duel
   Commander) or 3 AI opponents. The opponents play the other three Fallout precons. Pick a
   coach mode:
   - **Teach me** explains each new kind of decision;
   - **Hints** answers only when asked;
   - **Practice** stays quiet and gives a review afterwards.

   The board shows:
   - each player's battlefield, with lands in their own row;
   - your hand;
   - life, commander damage, counters and tokens;
   - the command zone with commander tax;
   - graveyard, exile and library counts;
   - turn, phase, priority holder, stack and combat;
   - Forge's log.

   Forge asks every choice — modes, targets, costs, mana payment, triggers, ordering,
   attackers, blockers and commander-zone choices — and each one is answered in the right-hand
   panel. *Automation* sets which routine priority stops are skipped. Forge never skips a stop
   with something on the stack, unless you leave "auto-pass when you can't respond" on.
4. **Tutor.** It answers five questions:
   - *What can I do?*
   - *What would you recommend, and why?* Recommendations are labelled as judgment, not a
     proven best move. *Choose this* is enabled only while that exact action is still legal.
   - *What just happened?*
   - *Why can't I play this?* The reason comes from Forge's own checks: timing, mana, targets,
     zone, or a restriction.
   - *Explain this card.*
5. **Review and Learning.** After a game, the review separates illegal attempts from judgment
   calls and gives one next lesson tied to the deck. *Learning* keeps the concepts you've
   practised and the ones to revisit.

## Tests

```sh
npm run typecheck
npx vitest run               # parsing, resolution, the four issue kinds, hidden-info filtering, recommendation legality
npm run walkthrough          # real browser against the running app + bridge (see below)
npx tsx scripts/recognize-demo.ts   # screenshot-of-a-decklist → recognition preview
npm run scenarios            # blocking, responding on the stack, commander-zone choice (see below)
```

`npm run scenarios` plays three focused positions through the browser. Each is set up with
Forge's own game-state format, the one its puzzle mode and developer "Setup Game State" use;
Forge decides everything after that.

- **block**: the AI attacks, and you declare a blocker by clicking cards.
- **respond**: with an opposing Lightning Bolt on the stack, you ask the tutor "What can I do?",
  cast your own Bolt in response, target their creature, and pay by tapping a chosen Mountain.
- **commander**: you cast Caesar from the command zone, with its cast count and tax tracked.
  When it is exiled, Forge asks whether it returns to the command zone (CR 903.9a).

It needs both the bridge and the server started with `TUTOR_BRIDGE_SCENARIOS=1`. Without that
flag a set-up position is refused.

`npm run walkthrough` drives Chromium through the whole flow. It decides each click from the
state shown and clicks the control the UI rendered, then saves screenshots and `results.json`
in `data/walkthrough/`. The flow:

1. import the sample;
2. save and reload;
3. the guide;
4. a card explanation;
5. a Forge match;
6. the tutor;
7. the review;
8. a phone-width check.

Variables: `WALKTHROUGH_TURNS` (default 8), `WALKTHROUGH_OPPONENTS=3`, `CHROMIUM` (path to a
Chromium binary).

## How it fits together

```
client/ (React)  ──HTTP──>  server/ (Node, Express, SQLite)  ──HTTP──>  bridge/ (Java)  ──>  Forge
                                 │  games/mtg/: Scryfall catalog, Comprehensive Rules,
                                 │  deck resolution + validation, guide, tutor context
                                 └─ tutor/: game-independent tutor + optional model
```

- `bridge/` is a small Java adapter that hosts Forge's real `HostedMatch` headlessly.
  - It turns each pause where Forge waits for the human into a revisioned, viewer-safe
    snapshot with the closed set of legal actions.
  - It applies a chosen action exactly as a click would.
  - It refuses an action from an earlier decision, or one that is not on offer.
  - Hidden cards (opponents' hands, libraries, face-down cards) are masked inside the bridge,
    before anything leaves Forge.
- `server/games/mtg/` implements the `GameAdapter` (`server/games/types.ts`): card resolution,
  validation, match creation, viewer-safe state, legal actions, actions and events.
- `server/tutor/` is game-independent. A game supplies a `TutorKit`, and the tutor adds the
  optional model under the same constraints.

## Limitations

- **Live model coaching is optional and has not been exercised with a real key in this
  environment.** No `ANTHROPIC_API_KEY` was available here. Without it, the app says that live
  coaching is not configured. The tutor then answers from Forge and the rules, and its
  recommendations are rule-of-thumb hints labelled as such. The model path is covered by tests
  with a fake model.
- **Commander is the only format offered,** because it is the only one implemented and
  verified.
- **74 Commander-legal cards are missing from the pinned Forge build,** mostly Unfinity
  attractions such as *Costume Shop*. A deck containing one is flagged as an engine-support
  problem. The card stays in the deck and study view, but no "accurate" match starts. The
  message says whether Forge's current master has a script for it.
- **No undo, no branching, and no save/resume of a game in progress.** Forge's hosted match
  offers none of these. Games and decisions are recorded for review only.
- **The match state lives in the bridge's memory.** Restarting the bridge ends running games;
  saved decks and match records are kept.
- **One active match at a time.** Starting a new match ends the previous one in the bridge.
