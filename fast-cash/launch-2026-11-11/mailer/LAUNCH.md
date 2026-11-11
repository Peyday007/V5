# LAUNCH: The Neighbor Card, a West Shore co-op EDDM postcard (prepared 2026-11-11)

**Status.** The kit is complete, and nothing has been sent, posted, bought or
created anywhere. The first advertiser can pay as soon as the owner opens a
Stripe account and makes the payment links, which takes about 30–60 minutes and
costs $0.

## 1. What is ready (this folder)

| File | What it is |
|---|---|
| `mockup/card-front.png`, `mockup/card-back.png` | Both sides at print resolution: 3675 × 2775 px = 12.25" × 9.25" at 300 dpi, including 0.125" bleed. Slot grid, placeholder ads marked "YOUR AD HERE – [category]", and the USPS mailing panel with the EDDM Retail indicia. |
| `mockup/card-front.pdf`, `card-back.pdf`, `card-mockup-2-sides.pdf` | Vector PDFs of the same, one page per side, plus a 2-page file to send prospects |
| `mockup/card-*-preview.jpg`, `route-map-preview.jpg` | Email- and post-sized images |
| `mockup/route-map.png` | Zone 1 (red) and Zone 2 (blue) USPS carrier routes on municipal boundaries |
| `mockup/rate-card.pdf` / `.png` | One-page rate card: map, homes by town, card thumbnails, prices, refund threshold, dates, how to order |
| `ROUTE-PLAN.md`, `routes-zone1.csv`, `routes-zone2.csv`, `routes-all.csv` | Real USPS route counts (121 West Shore routes) and the chosen zones |
| `RATE-CARD.md` | Slot sizes and prices, cost table with sources, break-even, and why the card mails in January |
| `ADVERTISER-AGREEMENT.md` | Terms: exclusivity, threshold and refund, content and proof deadlines, truth-in-advertising warranty, limits |
| `ORDER-FORM-EMAIL.md` | Order form to fill in by email reply, plus Stripe setup steps |
| `SALES-KIT.md` | 3-step CAN-SPAM-compliant email sequence, phone and walk-in script with objection answers, Facebook/Nextdoor post |
| `prospects.csv` | 117 West Shore businesses with a published phone or website and a source URL, ranked by January fit, with logging columns |
| `build/` | Scripts that regenerate everything: `routes.py` → `select.py` → `prospects.py` → `make_html.py` → `render.cjs` → `previews.py` → `render.cjs` |
| `data/` | Raw USPS EDDM and Census TIGERweb responses, and the chamber directory pulls the lists were built from |

## 2. The offer in one paragraph

**The Neighbor Card, New Year 2027 Edition.**
- **Card and audience:** a 9×12 card mailed by EDDM Retail to **4,944 homes in
  Camp Hill & East Hampden (17011, 11 USPS routes)**. By town: Camp Hill 57%,
  Hampden 32%, East Pennsboro 9%, Lemoyne 3%.
- **Mailing:** it goes to the Camp Hill Post Office on **Mon Jan 4, 2027**.
- **Spaces:** 18 spaces (22 cells), one business per category, ad design
  included.
- **Founding prices:** Standard **$295**, Double **$525**, Back Premium **$575**,
  Front Feature **$625**. Both zones (adds Hampden Twp West, 17050, 4,950 homes;
  9,894 total): $495 / $895 / $975 / $1,050.
- **Threshold:** the card **prints only if 10 of the 22 cells are paid by Wed
  Dec 9, 2026, 5 pm ET**. Otherwise everyone gets a full refund by Fri Dec 11.

## 3. Costs (sources in `RATE-CARD.md`)

| | Zone 1 (4,944) | Both zones (9,894) |
|---|---|---|
| Print, 9×12 14 pt UV (Clubflyers, PUBLISHED) | $743.99 | $1,482.99 (one design) / $1,487.98 (two) |
| Freight (ESTIMATE) | $150–$350 | $200–$500 |
| Postage at $0.26 (USPS, PUBLISHED) | $1,285.44 | $2,572.44 |
| Supplies (ESTIMATE) | $15 | $30 |
| **Fixed cost** | **≈ $2,294** | **≈ $4,335** |
| Break-even | 8–9 standard cells | |
| At threshold (10 standard cells) | +$567 | |
| Full card | +$3,895 | ≈ +$6,090 if both zones sell out |

**Activation cost before any advertiser pays: $0.**
- **Stripe:** no setup or monthly fee; 2.9% + 30¢ per card payment, taken only
  from money received. https://stripe.com/pricing, read 2026-11-11.
- **USPS EDDM Retail:** no permit or account fee. Postage is paid at the drop.
  https://www.usps.com/business/every-door-direct-mail.htm
- **Mock-ups and design:** built here.
- **Optional:** $5–$20 to print rate cards for walk-ins (ESTIMATE).
- **Only possible loss:** if the threshold is missed, the processor fees on
  refunded payments, which Stripe does not return: about 3% of what was
  collected, roughly $80 at 9 cells.

## 4. Legal and registration checks (Pennsylvania)

| Question | Answer | Source |
|---|---|---|
| Does a sole proprietor selling under their own name need to register? | **No.** "Individuals doing business under their full and proper name are not required to register." Trading as "The Neighbor Card" **is** a fictitious name. Either (a) contract and invoice as "[Full legal name]", with the card title used only as a product name, or (b) file a Registration of Fictitious Name (DSCB:54-311) with the PA Department of State before using it as a business name. A court can impose a $500 penalty for a late registration when you try to enforce a contract. The agreement template uses option (a): "[Full legal name], publisher of The Neighbor Card". | https://www.pa.gov/agencies/dos/programs/business/types-of-filings-and-registrations/fictitious-names (read 2026-11-11) |
| Does PA sales tax apply to the ad spots? | **Reading: no tax to collect.** The owner sells advertising space, a service, on printed matter delivered by USPS. PA exempts "direct mail advertising literature or materials" distributed through USPS (72 P.S. § 7204; 61 Pa. Code § 31.29). § 31.21 says advertising agencies need not collect tax on services for preparing and placing advertising. The same exemption makes the owner's own purchase of the printed cards exempt; give the printer an exemption certificate (REV-1220) if it charges PA tax. **Caveat:** a 2014 DOR ruling (SUT-13-002) taxed flyers inserted into shopping guides, which were not USPS direct mail. A free PA DOR question settles this; it does not block the launch. | https://law.cornell.edu/regulations/pennsylvania/61-Pa-Code-SS-31-29 ; https://law.cornell.edu/regulations/pennsylvania/61-Pa-Code-SS-31-21 ; https://www.revenue.pa.gov/TaxLawPoliciesBulletinsNotices/LetterRulings/SUT/Documents/sut-13-002.pdf |
| Local business tax? | Not found for Hampden, Lower Allen, Silver Spring or Upper Allen in a search (those townships levy a Local Services Tax on employees). **Owner check:** the business privilege or mercantile tax of the owner's own municipality, by a call to the Cumberland County Tax Bureau, (717) 590-7997. It does not block selling. | search, 2026-11-11 (ecode360; cumberlandcountypa.gov) |
| Income tax | Net profit goes on the owner's federal Schedule C, PA personal income tax and local earned income tax. Keep the Stripe, printer and USPS receipts. | general |
| Mail rules | Indicia lines **PRSRT STD / ECRWSS / U.S. POSTAGE / PAID / EDDM Retail**. Indicia "above and to the right of the address block", all caps, ≥ 4 pt, larger than 0.5"×0.5". Addressed "Postal Customer". Bundles of 50–100, ≤ 6" high, with facing slips. 200–5,000 pieces per ZIP per day. Whole routes only. No lottery offers. | USPS EDDM page (read 2026-11-11); Postal Bulletin 22312 https://about.usps.com/postal-bulletin/2011/pb22312/html/kit_005.htm ; DMM 144 https://pe.usps.com/text/dmm300/144.htm |
| Ad claims | Each advertiser warrants truth (FTC Act, PA UTPCPL). Advertisers in regulated trades carry their own disclosures, such as the HIC registration number or the broker name. | `ADVERTISER-AGREEMENT.md` §6 |

The mock-up's mailing panel follows the USPS rule. **Before the print order,**
check the indicia against the EDDM tool's downloadable indicia and the
printer's EDDM template; the printer may also place its small tag.

## 5. What is missing before an advertiser can pay (owner only)

1. **A Stripe account** in the owner's name, with SSN and bank account for
   payouts, plus 8 Payment Links (`ORDER-FORM-EMAIL.md`). *Login and identity
   only the owner holds.*
2. **The owner's details** in the placeholders: legal name, physical mailing
   address (CAN-SPAM needs one; a PO box is fine), phone and email. Put them
   into `build/make_html.py` and the `.md` files, then re-run the build so the
   card and rate card carry them.
3. **The name decision:** sell as "[Full legal name]" (no filing), or register
   "The Neighbor Card" as a fictitious name. See §4.

Nothing else blocks the first sale. The routes, mock-up, rate card, terms,
order form, prospect list and scripts are done.

## 6. Owner steps, in order

| # | When | Step |
|---|---|---|
| 1 | Thu Nov 12, morning | Fill in the placeholders (§5.2). Re-run `python3 -I build/make_html.py && NODE_PATH=$(npm root -g) node build/render.cjs && python3 -I build/previews.py && NODE_PATH=$(npm root -g) node build/render.cjs` from this folder, or ask Brain to. |
| 2 | Thu Nov 12 | Create the Stripe account and the 8 Payment Links. Make one $1 test payment and refund it. |
| 3 | Thu Nov 12 | Open https://eddm.usps.com, select the 11 Zone 1 routes (`routes-zone1.csv`), choose Residential only, and confirm about 4,944. No purchase needed. |
| 4 | Thu Nov 12 – Fri Nov 13 | Call or walk in to every `priority = 1` row in `prospects.csv` (50). Email Step 1 to the rest, from your own mailbox, or from Instantly once you approve the campaign. Log every contact. |
| 5 | Daily to Dec 9 | About 10 conversations a day. Follow-ups on day 3 and day 8. When someone says yes: send the order form, then the payment link, collect the content, and send the proof within 1 business day. |
| 6 | Fri Nov 20 | **Kill test 1** (below) |
| 7 | Fri Dec 4 | **Kill test 2.** If Zone 1 has ≥ 10 cells, start selling Zone 2 upgrades. |
| 8 | Wed Dec 9, 5 pm | **Threshold.** Email every advertiser "printing" or "refunding". |
| 9 | Fri Dec 11 | **Printing:** get the live Clubflyers checkout quote with freight, order 5,000 9×12 14 pt UV at 5 business days, and upload the final files. **Refunding:** refund every payment in Stripe. |
| 10 | Dec 28–31 | Count and bundle the cards in 50–100s, ≤ 6" high. Print facing slips from the EDDM tool and pay postage there ($1,285.44). |
| 11 | **Mon Jan 4, 2027** | Drop at the Camp Hill Post Office (and the Mechanicsburg PO for Zone 2). Photograph the receipt and send it to each advertiser. |
| 12 | Wed Jan 13 | Delivery note plus a February-edition renewal offer at the Founding price |

## 7. Kill tests (counted from `prospects.csv` / Stripe, never from memory)

| Date | Test | If it fails |
|---|---|---|
| **Fri Nov 20** | ≥ 100 logged contacts (calls, walk-ins, emails) **and** ≥ 2 paid cells, or 1 paid + ≥ 4 "send me the order form" | Either double the daily contact rate until Dec 4, or stop now and refund the few paid cells (loss ≈ 3% of them). |
| **Fri Dec 4** | ≥ 7 paid cells | Last-week push to all "maybe" rows. If < 5 cells, announce on Dec 7 that the card is likely cancelled and refund on Dec 9. |
| **Wed Dec 9, 5 pm** | ≥ 10 paid cells (≥ $2,950 collected) | Refund everyone by Fri Dec 11. Loss ≈ 3% of collected (Stripe fees). |
| Fri Dec 11 | The live print + freight quote is ≤ collected cash − $1,300 postage | Take the cheaper of Clubflyers and a local shop; never front the gap. |

## 8. Production timeline

Thu Nov 12 sell → Fri Nov 20 K1 → Fri Dec 4 K2 → **Wed Dec 9 threshold** →
Thu Dec 10 proofs → **Fri Dec 11 print order** → about Fri Dec 18 printed →
about Dec 22–23 delivered → Dec 28–31 bundle and buy postage →
**Mon Jan 4, 2027 drop** → about Jan 5–12 in homes.

**Why January, not December.** On a December schedule the threshold would fall
on Fri Nov 20, leaving 7 selling days for a first card. Vendors report first
cards taking 4–6 weeks to fill, and the print run would land in Thanksgiving
week. January gives 19 selling days and the strongest category season
(benefits reset, gyms, furnaces). Every sale is still prepaid on the day it is
made.

## 9. What failed or is unverified

- **Live print quotes beyond Clubflyers.** 55printing (9×12), GotPrint,
  Primoprint and Vistaprint show prices only in a JS configurator, and
  Click2Mail returned 403. Clubflyers' freight charge isn't published, so it is
  an ESTIMATE ($150–$350).
- **West Shore Chamber directory.** It is JavaScript-only and did not render,
  so the prospect list leans on Mechanicsburg Chamber members. Camp Hill
  coverage comes from the 11-02 list.
- **Emails.** Only 1 of 117 rows has a published email. The rest have a website
  contact page or a phone number.
- **PA sales-tax treatment** is my reading of the regulations, not a DOR ruling.
- **USPS counts and the in-home window** move. Recheck the counts in the EDDM
  tool (step 3); in-home dates are an estimate.
