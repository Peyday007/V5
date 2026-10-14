# Notices and attribution

This project is licensed under the GNU General Public License v3.0 or later, because it
links against Forge.

## Forge — rules engine and AI opponents
- Source: https://github.com/Card-Forge/forge
- License: GPL-3.0. This repository does not vendor Forge. `forge/setup.sh` fetches and
  builds Forge at the revision pinned in `forge/FORGE_REVISION`
  (`b6f135e649de6ab8fd98df3cf8b32905b02340ba`, Forge 2.0.16-SNAPSHOT).
- `bridge/` is a small Java adapter compiled against that build. It is distributed under the
  same license.

## Scryfall — card data and images
- https://scryfall.com, used through its public API and bulk data. Requests follow Scryfall's
  rate limits and identify the app with a User-Agent header. Card images are linked from
  Scryfall's servers, not copied.
- The card data is cached locally in `data/` (Oracle Cards bulk file). The cache records its
  `updated_at` time, which the About page shows.

## Wizards of the Coast
- Magic: The Gathering, its card names, card text, mana symbols and card images are
  copyright Wizards of the Coast, LLC. This is unofficial Fan Content permitted under the
  Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials
  used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
- The Magic: The Gathering Comprehensive Rules are retrieved from
  https://magic.wizards.com/en/rules. The source URL and effective date are stored with them
  and shown on the About page.

## MTGJSON — sample decklists
- The Fallout Commander precon lists in `fixtures/decks/` come from MTGJSON
  (https://mtgjson.com, MIT). Hail, Caesar was checked card by card against Wizards of the
  Coast's published Fallout decklists.

## tesseract.js — local OCR
- https://github.com/naptha/tesseract.js (Apache-2.0). The English model is downloaded once
  into `data/ocr`.
