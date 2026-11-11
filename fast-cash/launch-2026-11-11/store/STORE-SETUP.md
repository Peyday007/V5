# Store setup: owner's click-by-click

**Platform:** Fourthwall Free ($0). **Your work:** sign up, upload, paste, publish. **Time:** about 2–2½ hours at a laptop. The product designer does not work on a phone ([Fourthwall](https://help.fourthwall.com/create-and-sell-products/how-to-guides/design-a-new-product)).

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

## 3. Upload the 10 products (≈75 min, about 7 min each)

For each row of `CATALOG.md` / `catalog.csv`:

1. **Products → Create new product → Design a new product.**
2. Search the catalog for the exact blank name, for example "White Glossy Mug". Check that the **brand/model** matches the catalog (for example Mugz WGM78). Click **Design now**.
3. **Upload image.** Use the file from `designs/<product>/`.
   - **Apparel:** pick the **Front Large** print area and let the 4500×5400 file fill it. Size it to 100% of the print area.
   - **Mugs:** the file is the full wrap. Fit it to the print area so the left grid and the right answer both stay clear of the handle.
   - **Journal:** align the wrap to the overlay. The front is the right half.
4. **Colours/variants:** tick only the colours listed in `CATALOG.md`.
   - Use the **light-shirt file on light colours only** and the **dark-shirt file on dark colours only**. Make two listings if the designer will not take a different file per colour, for example "Solve Responsibly Tee – Light" and "Solve Responsibly Tee – Dark".
   - Poster: tick **12×16 and 18×24** only.
   - 15 oz mug (product 07): tick **15 oz** only.
5. **Check the base cost** shown at the bottom of the designer against `CATALOG.md`. If it is higher, raise retail by the difference.
6. **Listing details:** paste the title, description and tags from `catalog.csv`. Set the **price** to the `retail_usd` column. For apparel 2XL+, add the upcharge the designer shows.
7. Click publish / **Add to shop**. Use **Save as hidden** if you want to finish all ten first.

Optional, recommended (about $13 plus a week's wait, so it does not block launch): **Place order → Choose products to order** for one mug at cost, to see print quality.

## 4. Pages and policies (≈20 min)

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
> **Where's the answer?** Mugs: on the opposite side, upside down. Journal: on the back cover. Poster: tiny and upside down in the bottom corner. Shirts, tote and coaster: email us the product name and we'll send it.
> **How hard are they?** Most are easy to medium (28–42 starting numbers). The Large Print mug is the easiest, and Focus Mode and the poster are the toughest.
> **Can I write on the mug?** We'd stick to solving it in your head, or copy it onto paper. The print is dishwasher and microwave safe, not pencil-proof.
> **When will it arrive?** See the shipping policy: usually 9–15 days in total with standard US shipping. Order by Dec 8 for Christmas.
> **Who handles sales tax?** It's calculated at checkout from your address and collected and remitted by our platform, Fourthwall.
> **Can I order a custom puzzle or a name?** Not yet. Email us; if enough people ask, we'll add it.

## 5. Go live (≈5 min)

1. **Site design** → click the status tag at the top right → **Live** → **Save** ([source](https://help.fourthwall.com/manage-my-shop/shop-settings/change-site-status)).
2. Open the shop in a private window. Add a mug to the cart and go as far as the payment page to see shipping and tax. Don't pay.
3. Done. The store can take real orders.

---

## 6. $0 traffic plan for week 1 (≈30 min/day)

1. **Day 1: your own circle.** Post the mockup previews (`designs/*/mockup-preview*.png`) on your personal Facebook, Instagram and Nextdoor. Text: "I opened a little puzzle-gift shop: every sudoku on it has exactly one solution. Order by Dec 8 for Christmas." Text 10–20 people who'd actually buy (the sudoku-solving relatives). In practice the first orders come from here.
2. **Days 1–3: Pinterest** (free business account). Make 3 pins per product: the mockup, the plain design, and a close-up of the grid. Link each to its product URL. Use the tags from `catalog.csv` in pin descriptions, plus "Christmas gift for grandparents" and "gift for puzzle lover". Pinterest is the one free channel where gift shoppers search in November.
3. **Days 2–7: communities.** Answer genuinely in Facebook puzzle and sudoku groups and r/sudoku when it's on-topic. Read each group's self-promo rules first, and only post the shop where allowed. Post one free printable of a puzzle (the poster grid) with the shop link.
4. **Day 3:** a short phone video: "solving the puzzle on my mug" (TikTok / Reels / Shorts). Show the answer upside down on the back.
5. **Etsy?** Not in week 1. An Etsy print-on-demand shop is a **separate store**: its own per-listing and per-sale fees, its own policies, and you connect a supplier such as Printify or Printful to it. It is not part of Fourthwall. Revisit in January if the designs sell.

## 7. Timing summary

| Step | Minutes |
|---|---|
| Sign up, settings, payouts | 20 |
| 10 products | 75 |
| Pages and policies | 20 |
| Go live and test cart | 5–10 |
| **Total** | **≈2–2½ hours**: a store able to accept real orders the same day |
