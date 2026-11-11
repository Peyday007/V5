# Three businesses: ready, and what only the owner can do

Brain finishes each launch by itself. The **Launch** workflow
(`.github/workflows/launch.yml`, every hour at :17) runs `scripts/launch/run.ts`.
As soon as a platform's key is saved, it creates, uploads and publishes
everything for that business. It is idempotent: a second run finds what
exists and changes nothing. The status is the job summary of the latest Launch
run. `node fast-cash/launch-2026-11-11/check.mjs` checks the kits, and
`npx tsx scripts/launch/run.ts dry-run` validates every upload before any
account exists.

Secrets go in **github.com/Peyday007/V5 → Settings → Secrets and variables →
Actions → New repository secret**.

---

## Local co-op mailer

**What is ready**
- *The Neighbor Card*, a January 2027 postcard to 4,944 Camp Hill & East
  Hampden homes. Mock-up, route map, rate card, advertiser agreement, order
  form, sales scripts and 117 prospects are all done (`mailer/`).
- **Payment links:** Brain creates the 8 Stripe payment links automatically.
  Prices are $295–$625 for Zone 1 and $495–$1,050 for both zones. Each link
  asks for the business name, category and phone, and shows the refund
  threshold after payment.
- **Your details:** Brain reads your public business name, phone, email and
  address from the Stripe account. It fills every placeholder in the card,
  rate card, agreement, order form and sales kit with them, adds the links,
  and re-renders the print files. The finished set is the `launch-out`
  artifact of the Launch run.
- **Costs:** $0 to activate. Stripe takes 2.9% + 30¢ only from payments
  received.

**Your personal actions**
1. Create a Stripe account and finish its verification: ID, SSN, bank
   account, and public business details (support phone, email and address).
2. Save Developers → API keys → **Secret key** (`sk_live_…`) as the secret
   `STRIPE_SECRET_KEY`.

---

## Etsy shop

**What is ready**
- 8 digital listings: 382 validated puzzles, 47 photos, titles, 13 tags each,
  descriptions and prices of $3.49–$9.99 (`etsy/`).
- **Brain publishes them through Etsy's API:** creates each listing, uploads
  its photos in order and its PDFs (5 on the bundle), sets the tags, and
  publishes. All 8 pass validation against Etsy's limits today.
- **The login carries over:** Etsy's renewed token is kept, encrypted, from
  run to run, so you authorize once.
- **Costs:** about $16.60 to activate, i.e. Etsy's setup fee (about $15,
  shown at sign-up) plus 8 listings × $0.20.

**Your personal actions**
1. Open the Etsy shop: sign up, then ID and selfie, bank, card, two-step
   sign-in, and pay the setup fee. Etsy will not open a shop without one
   listing. When it asks, paste **Listing #1's title, price and PDF** from
   `etsy/LISTINGS.md`; Brain completes that listing rather than duplicating
   it.
2. At etsy.com/developers/register choose **Create a seller app** (approved
   within minutes for an open shop). Add the callback URL
   `http://localhost:3003/oauth/redirect`.
3. Save the app's Keystring and Shared secret as the secrets `ETSY_API_KEY`
   and `ETSY_SHARED_SECRET`.
4. The next Launch run prints a **Grant access** link. Click it; the browser
   lands on a localhost page that does not load. Copy that address-bar URL
   into **Actions → Launch → Run workflow → etsy_redirect_url** and press Run
   within about 5 minutes. Brain publishes all 8 listings in that run.

---

## Dropshipping store (Fourthwall, print-on-demand)

**What is ready**
- 10 products as 12 listings: mug, two tees in light and dark versions,
  holiday sweatshirt, tote, poster, 15 oz mug, colour-inside mug, coaster and
  notebook, at $12.99–$39.99.
- **All 12 validated against Fourthwall's live catalog:** print sizes,
  variants, and base cost plus margin equal to retail (`store/`).
- **Brain publishes them through Fourthwall's API:** uploads each print file,
  creates the product with its colours, sizes and price, checks the price it
  reads back, and publishes. Printful prints and ships every order.
- **Costs:** $0. Fourthwall is the merchant of record, so it collects the
  sales tax.

**Your personal actions**
1. Sign up at fourthwall.com (Free plan) and connect payouts (Stripe Connect:
   ID and bank).
2. Settings → For developers → Open API → **Create API User**. Save the two
   values as the secrets `FOURTHWALL_API_USERNAME` and
   `FOURTHWALL_API_PASSWORD`.
3. Site design → status → **Live**. Fourthwall's API cannot switch this, so
   it is one click.
