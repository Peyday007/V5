# Etsy shop: set-up kit and owner click-path

Everything needed to open the shop and publish 8 instant-download listings. Your part is: **sign up, paste, upload, publish.**
Estimated owner time: **about 75–100 minutes** (shop opening 25–35 min, incl. ID check; 8 listings × 6–8 min each).

## What is in this folder

| Path | What |
|---|---|
| `products/<slug>/*.pdf` | The 7 product PDFs (each < 0.5 MB, US Letter) — **these are what you upload as the digital files** |
| `products/<slug>/manifest.json` | Every puzzle's seed, validator checks and the PDF's sha-256 (proof every puzzle passed) |
| `images/<slug>/NN-*.png` | Listing photos, 2700×2025 (4:3), already in upload order |
| `LISTINGS.md` | Paste-ready title, tags, price, description, files and photo order for each listing |
| `listings.csv` | The same in one spreadsheet row per listing |
| `COST.md` | Activation cash, fee figures with sources, per-sale net |
| `tools/` | The scripts that made all of the above (re-runnable: see bottom) |

The 8 listings:

| # | Listing | Price | Files |
|---|---|---|---|
| 1 | Large Print Christmas Sudoku (50) | $3.99 | 1 PDF, 62 pp |
| 2 | Large Print Sudoku 100 (Easy–Expert) | $4.49 | 1 PDF, 120 pp |
| 3 | Easy Sudoku for Beginners (60) | $3.49 | 1 PDF, 73 pp |
| 4 | Expert Sudoku (60) | $3.49 | 1 PDF, 73 pp |
| 5 | Large Print Christmas Word Search (40) | $3.99 | 1 PDF, 53 pp |
| 6 | Christmas Activity Pack for kids (32: word search, mazes, easy sudoku) | $3.49 | 1 PDF, 43 pp |
| 7 | Large Print Mazes for Adults (40) | $3.49 | 1 PDF, 53 pp |
| 8 | Large Print Puzzle Bundle (books 1–5, 310 puzzles) | $9.99 | 5 PDFs |

All 382 puzzles are distinct across products (no puzzle appears in two products, except that the bundle contains books 1–5 as-is).

---

## 1. Shop name — pick one

Etsy rule: 4–20 characters, no spaces or special characters, not used by another member, not someone's trademark ([Etsy](https://help.etsy.com/hc/articles/115015672808)).

| Candidate | Chars | Why | Check done (2026-11-11) |
|---|---|---|---|
| **CozyPuzzlePress** (recommended) | 15 | Warm, gift-y, fits sudoku + word search + mazes, room to grow | Web search: no business by this exact name; closest are "Cozy Sunday Crosswords" (a book title) and a game dev "CozyPuzzleGames" — different names |
| **LargePrintLane** | 14 | Says exactly what the shop does; strong for the seniors audience | Web search: no business by this name |
| **WestShorePuzzles** | 16 | Local (West Shore, PA) story for the About section | Web search: no puzzle business by this name |

I could not run a USPTO trademark search from here. Before you pick, take 1 minute: https://tmsearch.uspto.gov → search the words (e.g. "COZY PUZZLE PRESS"). Etsy itself tells you instantly if the name is taken; if it is, try the next candidate.

## 2. Shop announcement (paste)

> 🎄 Welcome! Every puzzle book here is an INSTANT DOWNLOAD — buy, download and print tonight. Large print, one puzzle per page, solutions included, and every sudoku is proved to have exactly one solution. Holiday sale: see the banner for this week's discount.

(If you don't run a sale, drop the last sentence.)

## 3. About section (paste)

**Story headline:** Big, friendly puzzles you can print at home

**Story:**

> We make printable puzzle books that are easy on the eyes: large print, one puzzle per page, and an answer key at the back of every book.
>
> Every puzzle is created and checked by our own puzzle software before it goes into a book. Every sudoku has been solved by a computer to prove it has exactly one solution, every word search has been searched to prove each word appears exactly once, and every maze has been walked to prove there is exactly one way through. No broken puzzles, no impossible grids, no "two right answers".
>
> We're based in Pennsylvania's West Shore. Our books make a simple, thoughtful gift for grandparents and parents, a quiet hour for anyone who loves a pencil puzzle, and an easy resource for teachers and activity directors (non-commercial use in your own classroom or care community).
>
> Questions or a file that won't open? Message us — we answer quickly.

## 4. Shop policies (paste into Settings › Policies)

**Returns & exchanges:** select *I don't accept returns, exchanges or cancellations* (digital items).

Additional policy text:

> **Digital downloads.** All items are instant digital downloads (PDF). Nothing is shipped. Your files are available immediately after payment under You › Purchases and reviews, and by the link in your Etsy receipt email.
>
> **Returns.** Because files are delivered instantly, we can't accept returns or cancellations. **But if anything is wrong** — a file won't open, won't download or doesn't print properly — message us and we will fix it, send a new file, or refund you. You won't be left with something that doesn't work.
>
> **Personal-use license.** Print as many copies as you like for yourself, your family, and non-commercial use in your own classroom, church group or care community. Please do not resell, share, upload or redistribute the files or puzzles, in print or digital form.
>
> **Printing.** Files are US Letter (8.5" × 11"). On A4 paper, choose "Fit to page" in your print dialog. Colors may vary slightly between screens and printers.
>
> **Privacy.** We use your information only to deliver your order and answer your messages, as required by Etsy. We never sell or share it.

## 5. FAQ (paste each into Shop › FAQ, or Settings › Info & appearance › FAQs)

1. **How do I get my files?** — Straight after payment, go to **You › Purchases and reviews** on Etsy (website or app) and tap **Download Files**. Etsy also emails you a link. Download on a computer if your phone won't open PDFs.
2. **Will anything be mailed to me?** — No. These are digital downloads; you print them yourself.
3. **What paper size?** — US Letter 8.5" × 11". On A4, choose "Fit to page".
4. **Can I print it more than once?** — Yes, as many times as you like for personal use — redo a favorite puzzle or print a copy for a friend in your household.
5. **Can I use it with my class or residents?** — Yes, for non-commercial use in your own classroom, church group or care community. Please don't resell or share the file.
6. **Are the answers included?** — Yes, every book has solutions at the back.
7. **How do I know the puzzles work?** — Every sudoku is proved by a solver to have exactly one solution; every word search was searched to confirm each word appears exactly once; every maze has exactly one route.
8. **Can I print it at a store?** — Yes. Download the PDF and take it on a USB stick or email it to a copy shop (e.g. Staples, FedEx Office, or your library). Ask for single-sided, black & white for the puzzle pages.
9. **The file won't open.** — Message us. We'll send it another way or refund you.

---

## 6. Owner click-path: open the shop and publish everything

Prepare first (5 min): a **desktop/laptop browser**, your **driver's license or passport** (not expired), your **phone** (for the selfie and two-factor), **bank account login** (US banks connect via Plaid) or routing+account number, a **debit/credit card**, and this folder downloaded to the computer (or the repo checked out).

Etsy's documented order ([Etsy](https://help.etsy.com/hc/articles/115015672808)):

1. Go to **etsy.com** → **Sign in** → **Register** (or sign in). Use an email you check. Add a profile photo later if you like.
2. Go to **etsy.com/sell** → **Get started**. Answer the short questions about your business.
3. **Shop preferences:** Language **English** (cannot change later), Country **United States**, Currency **US Dollar** → Save and continue.
4. **Name your shop:** type your pick from §1 → Check availability → Save and continue.
5. **Stock your shop:** Etsy asks you to add a first listing now. Do **Listing #1** using §7 below, then continue (you'll add the other 7 after the shop is open).
6. **How you'll get paid:** Individual/sole owner → your legal name, date of birth, home address and the tax ID details Etsy asks for → connect your **bank** via Plaid (or enter routing/account) and verify.
7. **Billing:** add your **debit/credit card** (pays Etsy fees).
8. **Verify your identity:** follow the Persona prompts — photo of your ID + selfie. The ID name must match the bank account name.
9. **Two-factor authentication:** choose authenticator app (recommended) or SMS.
10. **Set-up fee:** check the box in **Total due now** to authorize the one-time fee (expected $15; see COST.md) → **Open your shop**.
11. Shop Manager › **Settings › Info & appearance**: paste the **announcement** (§2) and set a shop icon if you like (optional: crop `images/large-print-christmas-sudoku/01-hero.png`). › **About**: paste §3. › **Policies**: paste §4. › **FAQ**: add §5.
12. **Offsite Ads** (Settings › Offsite Ads): **leave on** — you pay only when an ad actually produces a sale (15%), and it is free exposure for a new shop. (Opting out is allowed under $10k sales if you prefer.)
13. **Etsy Ads**: leave **off** (costs money per click).
14. Add listings #2–#8 (§7). Each costs $0.20 when published.
15. Open your shop page in a private window and buy-test nothing — just check each listing shows its photos and "Digital download".

### 7. Adding one listing (repeat for each of the 8; ~6–8 min each)

Shop Manager › **Listings › + Add a listing** ([Etsy: digital listings](https://help.etsy.com/hc/en-us/articles/115015628347-How-to-Add-Files-to-a-Digital-Listing)). Use the matching section of **LISTINGS.md**.

1. **Photos:** drag in all files from `images/<slug>/` (they are numbered; keep the order — 01 is the thumbnail).
2. **Title:** paste.
3. **Category:** type `word & number puzzles` → choose **Toys & Games › Games & Puzzles › Puzzles › Word & Number Puzzles**.
4. **What type of item is it?** → **Digital files**.
5. **Who made it?** I did · **What is it?** A finished product · **When was it made?** 2020 – 2026.
6. **Description:** paste.
7. **Attributes:** fill any that are offered and fit (Holiday: Christmas for the holiday products). Leave the rest blank.
8. **Tags:** paste the 13 tags.
9. **Price:** as listed · **Quantity:** 999.
10. **Digital files:** upload the PDF(s) listed (bundle: 5 PDFs). Instant download = files attached now.
11. **Renewal:** Automatic.
12. **Publish.**

Etsy may say "Your listing is being reviewed" for a new shop; that is normal.

---

## 8. After launch

**When an order comes in: do nothing.** Etsy delivers the files instantly and emails the buyer. Etsy notifies you of the sale. Digital sales are not held in reserve ([Etsy](https://help.etsy.com/hc/articles/360058722214)); deposits go to your bank weekly on Mondays by default ([Etsy](https://help.etsy.com/hc/articles/360046998234)). Only act if a buyer messages you about a file problem: reply with the PDF attached in Etsy Messages, or refund from the order page.

**Free ($0) promotion that Etsy itself provides:**

1. **Shop sale** — Shop Manager › Marketing › Sales and discounts › *Run a sale*: 20–25% off everything, Nov 11 – Dec 24. Sale prices show a strike-through in search. Cost: only the discount on sales you'd make.
2. **Thank-you coupon** — same page: automatic coupon (e.g. 25% off) sent after each purchase, to win the bundle upsell.
3. **Offers to interested shoppers** (if your shop is offered it): automatic discount to people who favorited an item or left something in their cart.
4. **Share buttons** — every listing has a **Share** button (Facebook, Pinterest, X, email). Pinterest is the strongest free channel for printables: pin each hero image with a link to the listing.
5. **Shop updates / Etsy app** — post a photo of a printed page on your desk ("printing Christmas sudoku for Grandma") from the Etsy Seller app.
6. **Renew/refresh** — after 2–3 weeks, edit titles/tags of listings with views but no sales (Shop Manager › Stats shows search terms used to find you). Editing is free.
7. **Reviews** — Etsy automatically asks buyers for a review; first reviews matter more than anything else for new-shop ranking.
8. **Local, offline, free:** a flyer at West Shore / Mechanicsburg / Camp Hill senior centers, libraries or church bulletins pointing to the shop (the products themselves are personal-use; activity directors are explicitly allowed to use them with their residents).

**Do not spend** on Etsy Ads until listings have organic views and a few sales (then a $1/day test on the bundle only).

---

## Re-running the generators

```
npx tsx fast-cash/launch-2026-11-11/etsy/tools/build-products.ts     # PDFs + manifests (deterministic seeds)
SCRATCH=/tmp node fast-cash/launch-2026-11-11/etsy/tools/build-images.mjs   # listing images (Playwright + pdftoppm)
node fast-cash/launch-2026-11-11/etsy/tools/build-listings.mjs       # listings.csv + LISTINGS.md, checks Etsy limits
```
