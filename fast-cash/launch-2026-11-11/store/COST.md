# Cost, economics and platform choice

All prices below were read on **2026-11-11**. The source is linked on each figure.

## Cash to activate: **$0**

| Item | Cost | Source |
|---|---|---|
| Fourthwall Free plan | **$0/month**. "There are no monthly fees, no upfront costs, and no contracts." | [fourthwall.com/pricing](https://fourthwall.com/pricing), [fourthwall.com/faq](https://www.fourthwall.com/faq) |
| Storefront, checkout, card processing | Included. You pay only the per-sale fee (2.9% + $0.30 on US cards). | [fourthwall.com/pricing](https://fourthwall.com/pricing) |
| Domain | **$0**: use the free `yourshop.fourthwall.com` subdomain. **Skip a custom domain at launch.** (Pro at $15/mo includes a free .store domain. Not worth it until there are sales.) | [fourthwall.com/pricing](https://fourthwall.com/pricing) |
| Sales-tax registration | **$0, none needed.** Fourthwall is merchant of record. It collects sales tax by ship-to address and remits it. "You don't need to file state sales tax returns for Fourthwall transactions." | [Fourthwall creator tax info](https://help.fourthwall.com/frequently-asked-questions/payments-and-pricing/creator-tax-information) |
| Inventory | $0. Every item is made to order. | catalog pages |
| **Optional:** one sample order | At cost (for example, a mug at $5.95 + $6.69 shipping ≈ $12.64), paid by card. Recommended but not required to launch. | [Order samples](https://help.fourthwall.com/create-and-sell-products/how-to-guides/order-samples) |

## Per-order economics (Fourthwall Free)

- **The customer pays:** retail price + shipping (pass-through carrier cost) + sales tax.
- **Fourthwall deducts:**
  - the product's catalog base cost (a flat fee, with "no extra percentages"),
  - 2.9% + $0.30 card processing,
  - shipping and tax, which pass straight through.
- **You keep:** retail − base − card fee.

Example: the 11 oz mug at $18.99.

| Line | Amount |
|---|---|
| Base cost | −$5.95 |
| Card processing (≈2.9% of $25.68 + $0.30) | −$1.04 |
| **Your profit** | **$12.00** |
| Shipping ($6.69) | paid by the buyer |

Across the 10 products, profit is **$6.75 to $19.50 per unit, about $13 on average**. Margins are 40–63%. The full table is in `CATALOG.md`.

Free-shipping promos come out of your profit ([shipping costs](https://help.fourthwall.com/frequently-asked-questions/shipping-and-orders/shipping-costs)). Do not run them at launch.

## Payout timing

The figures here come from [How you get paid](https://help.fourthwall.com/frequently-asked-questions/payments-and-pricing/how-you-get-paid) and [Creator tax info](https://help.fourthwall.com/frequently-asked-questions/payments-and-pricing/creator-tax-information).

- **Method:** Stripe Connect to your bank account or debit card. Set it up under **Settings → Billing and payouts → Set up your payouts**.
- **Schedule:** **monthly**. "Fourthwall tries to send Stripe Connect … payouts in the first few days of each month." It can take up to 7 business days after month end.
- **Minimum:** the balance must reach **$25**. Below that, it carries over.
- **So:** profit from November sales arrives about **Dec 1–10, 2026**. December profit arrives early January.
- **Tax forms:** Fourthwall issues a 1099-MISC through Stripe if your payouts reach the IRS threshold ($2,000 for 2026, per the same article). Report the payouts as income either way. Pennsylvania state sales tax is Fourthwall's job, not yours.

## Holiday delivery (2026)

| | Figure | Source |
|---|---|---|
| Fourthwall production | 2–5 business days for most on-demand items; may lengthen at peak | [Production timelines](https://help.fourthwall.com/create-and-sell-products/how-to-guides/production-timelines-and-fulfillment-expectations) |
| US transit, standard | 7–9 days (tees, white mug, stickers), 8–10 days (sweatshirt, tote, poster, coaster) | `products.fourthwall.com` catalog pages |
| Faster shipping | Expedited, plus "Super Rush" (~3 business days) on popular Printful apparel. Automatic, and paid by the buyer. | [Rush delivery](https://help.fourthwall.com/manage-my-shop/shop-settings/rush-delivery-options-for-printful-products) |
| Fourthwall 2026 holiday cut-off | **Not published as of 2026-11-11.** The only Fourthwall page found is for 2023. | [2023 post](https://fourthwall.com/blog/important-holiday-shipping-cutoffs-for-2023) |
| Printful (Fourthwall's maker for 9 of 10 items), last published US cut-off | 2025: US-fulfilled apparel and home goods by **Dec 11** (standard), Dec 16 (express). No 2026 page yet. | [Printful guide](https://www.printful.com/blog/your-holiday-shipping-and-order-deadline-guide) |
| USPS 2026 | Ground Advantage Dec 17, Priority Mail Dec 18 | [via ship.com / fitsmallbusiness](https://fitsmallbusiness.com/smb-news/2026-holiday-shipping-deadlines-small-businesses/) |

**Store banner to use:** "Order by **Dec 8** for Christmas delivery with standard US shipping. Expedited is available at checkout until about Dec 15."

That date is 5 business days of production plus 9 days of transit, counted back from Dec 24. It is deliberately conservative. Update it when Fourthwall publishes its 2026 dates.

---

## Why Fourthwall: the comparison

| Option | Cash to launch | Checkout + payments | Supplier auto-fulfils, US production | Payout | Sales tax | Verdict |
|---|---|---|---|---|---|---|
| **Fourthwall Free** | **$0** ([pricing](https://fourthwall.com/pricing)) | Built in. 2.9% + 30¢. | Yes. Catalog made by Printful/Spoke, ships from the US (catalog pages). | Monthly via Stripe, $25 minimum | **Fourthwall is merchant of record**: it registers, collects and remits | **PRIMARY.** $0, nothing to register, real checkout, US printing. |
| Printful Quick Stores | $0 (Free plan includes "10 Quick Stores", [pricing](https://www.printful.com/pricing)) | Printful collects payment via Stripe | Yes (Printful US) | Monthly if over $25 ([billing](https://help.printful.com/hc/en-us/articles/15045715768604-How-is-Quick-Stores-billing-different-from-usual-Printful-billing-e-g-Shopify-billing)) | Printful is seller of record ([tax](https://help.printful.com/hc/en-us/articles/15045922586780-Why-is-the-sales-tax-collected-on-my-Quick-Stores-orders-and-who-pays-it)) | **BACKUP.** Same maker, same $0, same tax relief, so these exact design files work unchanged. Thinner storefront. Third-party reviews say US sellers and buyers only. |
| Shopify + Printify | 3-day free trial, then **$1/month for 3 months**, then Basic **$39/mo** ($29/mo yearly) ([shopify.com/pricing](https://www.shopify.com/pricing)). The Starter plan is no longer listed. | Shopify Payments 2.9% + 30¢. 2% extra if you use a third-party gateway. | Printify Free $0. Premium from $24.99/mo yearly ([printify.com/pricing](https://printify.com/pricing/)). Choose US providers. | Shopify payouts | **You** are the seller: register for a PA sales-tax licence and file returns yourself | Best for scaling later. Not for a 24-hour launch: it means more setup, a card on file, and tax registration. |
| Printify Pop-Up Store | $0 | Built in | Yes | 15th of the following month ([Printify help](https://help.printify.com/hc/en-us/articles/12051908094993)) | **Seller is now merchant of record** after the 2025 changes, so you handle the tax | No. You would carry tax compliance for a free storefront. |
| CJ Dropshipping / AliExpress general dropship | $0 supplier, but needs a paid store (Shopify) | Store's | China warehouse: CJPacket 7–12 days to the US per CJ ([CJ blog](https://blog.cjdropshipping.cn/detail/how-to-choose-the-best-shipping-method-delivery-time-shipping-costs-comparison-under-the-quarantine)). Third parties report 10–22 days. US warehouses (2–7 days) carry only part of the range. | Store's | You | **Rejected.** Orders placed after about Nov 25 risk missing Christmas, and generic products have no edge. Print-on-demand with our own proven puzzles is differentiated and ships domestically. |

Sources in this table were read 2026-11-11. Third-party figures are marked as such.
