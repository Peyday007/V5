# Store setup: owner's click-by-click

**Platform:** Fourthwall Free ($0). **Your work:** sign up, verify payouts, create one API user, flip the shop to Live, and authorize a free Pinterest business account (§6). **Brain creates, prices and publishes every product** through Fourthwall's official Platform API (`scripts/launch/store.ts`). You upload nothing. **Time:** about 30 minutes.

Why this works: Fourthwall's API creates design products from print files: upload → register image → `POST /open-api/v1.0/products` with `type: "design"` → publish ([Create design products](https://docs.fourthwall.com/guides/create-design-products), [Create a product](https://docs.fourthwall.com/api-reference/platform/products/create-product.md), read 2026-11-11). A shop's API user has full access ([Authentication](https://docs.fourthwall.com/guides/authentication.md)). The Free plan allows 50 products for accounts made after Aug 25, 2025 ([Free FAQs](https://help.fourthwall.com/frequently-asked-questions/account-and-plans/fourthwall-free-faqs)). Brain publishes 12.

Menu names below are from Fourthwall's help center, updated Oct–Nov 2026. If a label differs slightly, the dashboard search ("Omnisearch") finds it.

---

## 1. Store name (pick one)

| # | Name | Subdomain to request | Why |
|---|---|---|---|
| **1 (recommended)** | **Exactly One Solution** | `exactlyonesolution.fourthwall.com` | It is the product's one promise, and it is true of every item. |
| 2 | Nine by Nine Goods | `ninebynine.fourthwall.com` | Short and giftable. Ties to the holiday sweatshirt. |
| 3 | Pencil & Grid | `pencilandgrid.fourthwall.com` | Warm, and suits the large-print and grandparent angle. |

Before you commit, search the name on the USPTO trademark search and Etsy (5 minutes). Pick another if a puzzle or apparel brand already uses it.

---

## 2. Sign up and get paid (≈20 min)

1. Go to **fourthwall.com/get-started**. Sign up with email or Google. No card is needed for the Free plan.
2. When asked, enter the shop name. Stay on the **Free** plan. Pro ($15/mo) is not needed.
3. Open **Settings → General**. Set:
   - **Shop title:** `Exactly One Solution`
   - **Shop description:** "Puzzle gifts with a real sudoku on every item, and every one has exactly one solution."
   - **Social sharing image:** upload `designs/06-one-solution-poster/mockup-preview.png`.
4. Open **Settings → Domain**. Set the free subdomain from the table above. **Do not buy a domain.**
5. Open **Settings → Billing and payouts → Set up your payouts**. Complete Stripe Connect: legal name, DOB, SSN last 4, home address, bank account or debit card. Payouts arrive monthly once the balance is at least $25.
6. **Sales tax:** nothing to do. Fourthwall is merchant of record and collects and remits US sales tax ([source](https://help.fourthwall.com/frequently-asked-questions/payments-and-pricing/creator-tax-information)). Do **not** register for a PA sales-tax licence for this shop.

## 3. Give Brain the API key (≈3 min). Brain does the products.

1. In the Fourthwall dashboard: **Settings → For developers** ([direct link](https://my-shop.fourthwall.com/admin/dashboard/settings/for-developers?redirect)). Under **Open API**, click **Create API User**. Only the shop owner (Super Admin) can do this.
2. It shows a **Username** and a **Password**. In GitHub, open **Peyday007/V5 → Settings → Secrets and variables → Actions → New repository secret** and add:
   - `FOURTHWALL_API_USERNAME` = the username
   - `FOURTHWALL_API_PASSWORD` = the password
3. That's all. On its next hourly run, the launch workflow creates and publishes every product. It uploads each print file, picks the colours and sizes, and sets the price to `retail_usd` (base cost + a profit margin, so 2XL+ upcharges are automatic). It checks each price before it publishes. Re-runs never duplicate a product.

What Brain publishes (12 listings for the 10 products):
- Both shirts are split into a **Light Colors** and a **Dark Colors** listing, because each print file suits one shade.
- **Product 10** uses the **Hardcover Bound Notebook | JournalBook®** (5.5×8.5 in, 80 lined pages, Navy, $12.71 base) instead of the Spoke Hardcover Journal. Fourthwall's API cannot render the Spoke journal (`supportsBackendRendering: false`). The cover is front-only, so the answer is printed small and upside-down in its corner (`designs/10-puzzle-notes-journal/front-journalbook-1678x2501.png`).
- The 15 oz mug uses `print-15oz-fourthwall-5400x2100.png`: the same art, padded with white to Fourthwall's 18:7 mug wrap.
- Tags and SEO titles in `catalog.csv` are not settable through the API. They are optional, and the listing works without them.

Optional (about $13 plus a week's wait, so it does not block launch): **Place order → Choose products to order** for one mug at cost, to see print quality.

## 4. Pages and policies (optional, ≈20 min; the API cannot edit pages, and the defaults are fine to launch)

Fourthwall gives every shop four default pages: **Contact, Privacy Policy, Terms of Service, Returns & FAQ**. The policy pages are **kept up to date by Fourthwall until you edit them** ([source](https://help.fourthwall.com/manage-my-shop/shop-settings/edit-site-policies)). That is the platform's free generator.

- **Leave Privacy Policy and Terms of Service unedited.** They stay managed and auto-updated. Fourthwall's own Merchandise Terms cover its role as seller.
- **Returns & FAQ:** replace the body with the text below (Site design → Layout → the policy page).
- **Homepage and About:** Site design → Pages. Paste the text below.

### Homepage copy
> **A real puzzle on everything we make.**
> Every mug, tee and print here carries a genuine sudoku. Each was generated and then proved by an independent solver to have **exactly one solution**. No broken grids, no "two answers" arguments over breakfast.
>
> Gifts for the person who does the puzzle before the news. Made to order in the US and shipped to your door.
>
> 🎄 **Order by December 8** for Christmas delivery (standard US shipping). Expedited shipping is available at checkout.
>
> [Shop mugs] [Shop apparel] [Shop gifts under $25]

### About
> We love a good grid. We also hate the puzzle-mug knock-offs whose "sudoku" has no solution, or three.
>
> So every puzzle in this shop is generated by our own puzzle engine and checked twice, by two separate solvers, before it goes anywhere near a product. Each has exactly one answer, and we print that answer somewhere on the item (upside down, so no accidental spoilers).
>
> Everything is printed to order by our US production partner, so nothing sits in a warehouse and nothing is wasted. Pencil not included. Patience sold separately.

### Shipping policy (put it at the top of Returns & FAQ, and in the FAQ)
> **Production:** each item is made for you after you order. Production usually takes 2–5 business days, and longer during the holidays.
> **Delivery (US):** standard shipping usually arrives 7–10 days after your item ships. Expedited and (on many shirts) 3-day rush shipping are offered at checkout.
> **Cost:** shipping is calculated at checkout from your address and the items in your cart.
> **Holiday:** order by **December 8** for Christmas delivery with standard shipping.
> **International:** we ship to many countries. Rates and times are shown at checkout.
> **Tracking:** you'll get an email with tracking as soon as your order ships.

### Returns policy
> Because every item is printed just for you, we can't accept returns or exchanges for buyer's remorse or the wrong size. Please check the size guide on each product page.
>
> **If something is wrong, we'll make it right.** If your item arrives misprinted, damaged or defective, or if it's not what you ordered, email us within 30 days of delivery with your order number and a photo. We'll send a free replacement or a full refund. You don't need to send the item back.
>
> Lost package? Contact us and we'll help trace it, or replace it.

(This matches Fourthwall's own policy: catalog items with a print error or visible quality issue are replaced or refunded, and general or sizing returns are not accepted ([FAQ](https://www.fourthwall.com/faq)). Report each claim through the order in your dashboard.)

### FAQ
> **Does the puzzle really have one solution?** Yes. Every grid was proved to have exactly one solution by two independent solvers. Each has a recorded ID, and the answer is printed on the item.
> **Where's the answer?** Mugs: on the opposite side, upside down. Notebook: small and upside down in the corner of the cover. Poster: tiny and upside down in the bottom corner. Shirts, tote and coaster: email us the product name and we'll send it.
> **How hard are they?** Most are easy to medium (28–42 starting numbers). The Large Print mug is the easiest, and Focus Mode and the poster are the toughest.
> **Can I write on the mug?** We'd stick to solving it in your head, or copy it onto paper. The print is dishwasher and microwave safe, not pencil-proof.
> **When will it arrive?** See the shipping policy: usually 9–15 days in total with standard US shipping. Order by Dec 8 for Christmas.
> **Who handles sales tax?** It's calculated at checkout from your address and collected and remitted by our platform, Fourthwall.
> **Can I order a custom puzzle or a name?** Not yet. Email us; if enough people ask, we'll add it.

## 5. Go live (≈5 min)

1. **Site design** → click the status tag at the top right → **Live** → **Save** ([source](https://help.fourthwall.com/manage-my-shop/shop-settings/change-site-status)). The API can read the shop status but cannot change it, so this one click is yours. The launch summary flags it until it is done.
2. Open the shop in a private window. Add a mug to the cart and go as far as the payment page to see shipping and tax. Don't pay.
3. Done. The store can take real orders.

---

## 6. Customer acquisition: Brain does it, $0, no ads

Pinterest is the free channel where gift shoppers search in November, and its API lets Brain do all of it. **Your part is creating and authorizing accounts; nothing else, ever.** No posting, pinning, group answers or videos are asked of you, and no money is spent (no ads, no paid tools).

**What Brain does by itself** (Launch workflow, stage `scripts/launch/pinterest.ts`, every hour):
- Creates two public boards, **Puzzle gifts** and **Large print & printable puzzles**.
- Pins every product the moment its store is live: one pin per Fourthwall listing (12, from `designs/*/mockup-preview*.png`) and one per active Etsy listing (8, from `etsy/images/*/01-hero.png`). Each pin links to the live product page it was read from, with the product's own description, its `catalog.csv` / `listings.csv` tags and honest "gift for a puzzle lover" keywords.
- Creates the shop's launch code **PUZZLE10** (10% off, one use per customer) through Fourthwall's Promotions API and quotes it in every store pin. The discount comes out of the margin only when a buyer uses it; the smallest margin (coaster, $6.75) stays positive.
- Never pins twice: it lists the account's pins first and matches them by product link. Never pins early: a store that is not live yet shows as **WAITING** in the launch summary, and its pins go up on the first run after it goes live.

**Your actions (account creation and authorization only).** The launch summary prints each one, with the exact link, when it is the next step:
1. Create a free **Pinterest business account** (pinterest.com/business/create), or convert yours (Settings → Account management → Convert to a business account).
2. At **developers.pinterest.com/apps → Connect app**, register an app (name "Brain pin publisher"; website and privacy policy = the shop's URL and its Privacy Policy page). Pinterest reviews it; when it shows **Trial access**, add the redirect URI `http://localhost:8085/` and save the App ID and App secret key as the secrets `PINTEREST_APP_ID` and `PINTEREST_APP_SECRET`.
3. Authorize: click the link the next Launch run prints, press **Give access**, and paste the address-bar URL (a localhost page that does not load) into **Actions → Launch → Run workflow → pinterest_redirect_url**. The login then carries over from run to run.
4. **Standard access** (one time): Pinterest shows pins made by a Trial app to nobody but the account owner, so public pins need its Standard tier. On the app card click **Upgrade** and attach a screen recording of step 3 plus the Launch run log showing "Pinterest account verified" (Pinterest requires a video of the authorization flow and an API call). Pinterest reviews it by hand and publishes no turnaround; developers report one to several weeks. When the approval email arrives, add the secret `PINTEREST_STANDARD_ACCESS` = `approved`; the next run pins everything live.

**What the API cannot do, said plainly:** until Standard access is approved, nothing Brain pins is visible to shoppers, so it pins nothing and the summary says so. Etsy's API has no endpoint for coupons or sales, so the PUZZLE10 code is the store's only; the Etsy pins carry no code.

## 7. Timing summary

| Step | Minutes |
|---|---|
| Sign up, settings, payouts | 20 |
| API user + two GitHub secrets | 3 |
| 10 products | 0: Brain publishes them |
| Pages and policies (optional; the defaults work) | 0–20 |
| Go live and test cart | 5–10 |
| Pinterest business account, app and authorization (§6) | ≈15, plus Pinterest's review |
| Customer acquisition (pins, boards, launch code) | 0: Brain does it |
| **Total** | **≈30 minutes**: a store able to accept real orders the same day |
