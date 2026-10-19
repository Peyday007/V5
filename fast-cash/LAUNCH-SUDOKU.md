# Sudoku Interiors Vol. 1: launch pack

**Operation:** KDP-ready sudoku interiors with a commercial-use licence, sold to
low-content (Amazon KDP) publishers on Gumroad.

**Status:** prepared, not launched. Everything below is done except one owner
action (bottom of this file).

## The product (done)

| File | What it is |
|---|---|
| `sudoku-v1.pdf` | 100 puzzles, 2 per page, 70 pages, 8.5"×11" no bleed |
| `sudoku-v1-large-print.pdf` | The same 100 puzzles, 1 per page, 120 pages |
| `sudoku-v1.manifest.json`, `sudoku-v1-large-print.manifest.json` | For each puzzle: seed, canonical hash and validator checks, plus the PDF's sha-256 |
| `cover-1280x720.png`, `thumbnail-600.png` | Gumroad cover and thumbnail, made from the real pages |

**How it was made:** `npm run puzzle-book -- --volume v1 --count 100 --out <dir> [--layout large-print]`, in Brain (merged in PR #227).

- **Puzzles:** every one is proved by the sudoku validator, which reads only the printed grid. 100 of 100 passed, with 0 invalid and 0 duplicates. Measured difficulty: Easy 48, Medium 34, Hard 1, Expert 17.
- **KDP rules:** margins 0.75" inside and 0.5" elsewhere, which clears KDP's 0.375" minimum for 24–150 pages. Fonts are embedded (DejaVu Sans), as KDP requires. Both books are above KDP's 24-page minimum.
- **Not provided:** a KDP *cover* (front, spine and back for a printed book) is not made by Brain. A buyer of the interior makes their own, which is normal for this product type.

## Listing copy (paste into Gumroad)

**Name:** Sudoku Interior Vol. 1: 100 Puzzles, Each Proved to Have Exactly One Solution (KDP-Ready, Standard + Large Print)

**Price:** $7 (a proposal, not validated; see Economics)

**Description:**

> Two print-ready 8.5" × 11" sudoku interiors for your next low-content book.
>
> - 100 puzzles, Easy to Expert, ordered by measured difficulty
> - Two layouts of the same puzzles: Standard (2 per page, 70 pages) and Large Print (1 per page, 120 pages)
> - Solutions at the back of each book
> - Margins meet KDP's paperback minimums, and all fonts are embedded
> - Every puzzle has been checked by a solver that read only the printed grid, and has exactly one solution. No broken puzzles in your reviews.
>
> **Commercial-use licence:** you may print, publish and sell these puzzles in your own books, including on Amazon KDP. You may change the layout, cover and title. You may not resell or give away the PDF files, or the puzzle set as a set, as a template or interior product.
>
> You get two PDFs, plus a manifest listing every puzzle's verification record.

**Tags:** kdp interior, sudoku, sudoku book, large print sudoku, puzzle book, low content book, printable

**Category:** Design / Templates or Self-publishing (whichever Gumroad offers)

## Evidence behind the choice (read 2026-10-18)

- **Who buys.** Gumroad's own search returns 823 products for "kdp interior" and 57 for "kdp sudoku". Rated sellers in this segment include kdptools (KDP Mega Tool $30, 17 ratings; Logic Grid Puzzle Generator $37, 16; Detective Mystery Puzzles $59, 9), SudoLab, a sudoku book generator ($9.99, 6), and a maze PLR pack ($10, 2). Done-for-you sudoku interiors list at $1–$5, with no ratings. Consumer sudoku printables list at $0–$3.
- **Fees.** Gumroad's pricing page says 10% + $0.50 per direct sale, or 30% via Discover, with no monthly or listing fee.
- **Payout.** Gumroad's help page says "You need a minimum balance of $100 USD to receive a payout."
- **Platform rule.** Gumroad's prohibited list includes "reselling private label rights products". This product is original work, licensed by its creator, not resold PLR, and the copy deliberately does not call it PLR. That classification is Gumroad's to make. If Gumroad refuses it, the fallback is the same files under a personal-use licence for consumers, at about $3.
- **KDP spec.** kdp.amazon.com, "Set Trim Size, Bleed, and Margins": inside margin 0.375" for 24–150 pages and 0.5" for 151–300, with at least 0.25" on the outside without bleed.

## Economics

| | Direct sale | Via Gumroad Discover |
|---|---|---|
| Price | $7.00 | $7.00 |
| Gumroad fee | $1.20 | $2.10 |
| **Net per sale** | **$5.80** | **$4.90** |

- **Cost and capital.** Marginal cost per sale is $0: Brain produces the files on the existing subscription, and Gumroad hosts and delivers them. Capital required is $0. No spend or commercial permission is needed to list.
- **Time to first cash.** The first sale could come the day it is listed. Cash is held until $100 accumulates, which is about 18–21 sales at $7. This is slow, and it is the main weakness of this channel.
- **Faster-cash alternative.** Payhip's free plan charges 5% and "will deposit your sales to you immediately after a transaction has been completed", but it has no marketplace traffic of its own.
- **Unknowns, which are real.** Neither the conversion rate nor demand at $7 is known. Comparable interiors with published ratings are tools at $10–$59, not $1–$5 interiors, so $7 sits above the unrated comps.

## Fulfilment

Gumroad hosts the files and delivers them automatically on purchase. Nothing after the sale needs a person or Brain.

## The one owner action that launches it

1. Create a free Gumroad account, or sign in to yours.
2. New product, type "Digital product". Paste the name, description, price and tags above. Upload both PDFs and both manifests as the content, and the cover and thumbnail images. Publish.
3. In Brain, open **More → Puzzles** and, under Sudoku, record what you read
   (for example, "solved puzzles 1, 40 and 90 of the Vol. 1 PDF"). This is the
   one recorded reading that lets Brain move the format to SELLABLE and promote
   its products into Cash, where each sale can be recorded.

This needs no Brain commercial authority, no spending and no API keys.

## After it is live: what Brain does and does not do

- **Brain can, today:** make further volumes on request (new seeds, Easy-only or Expert-only books, large print), each proved and typeset with its own manifest, in seconds.
- **Brain will, by itself, after step 3:** move Sudoku to SELLABLE and promote its qualified products into Cash on the next tick.
- **Brain cannot, today: see sales.** There is no Gumroad integration, so a sale reaches Brain only if a person records it: Cash → *Record a payment received*, with the Gumroad sale id as the reference. That entry is what puts the money on Brain's ledger and feeds what it learns.
  - The missing tool is a reader for Gumroad's sales API (`GET /v2/sales`). It would need an access token created in Gumroad settings, which is a second, separate owner action and not needed to launch.
- **Brain cannot, by design: publish or update the listing itself.** Publishing an offer is a prohibited commercial action for Brain whatever integration exists.
