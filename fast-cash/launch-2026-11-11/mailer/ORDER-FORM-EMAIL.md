# Order form: fillable in an email reply

Send this block to a prospect who says yes. The prospect replies with the
blanks filled in, and the owner then sends the Stripe payment link for the
chosen space. Replying "I agree" plus paying accepts the Advertiser Agreement
(attach `ADVERTISER-AGREEMENT.md` as a PDF, or paste its link).

---

**Subject:** Your Neighbor Card spot: order form (2 minutes)

Hi [first name],

Great. Here's the order form. Reply with the blanks filled in, and I'll send
your secure payment link right away. Your category is locked the moment it's
paid.

```
BUSINESS (legal name):
NAME AS IT SHOULD APPEAR ON THE AD:
CATEGORY (one line, e.g. "family dentistry"):
CONTACT NAME / PHONE / EMAIL:
BUSINESS ADDRESS:

SPACE (pick one):
  [ ] Standard 2.8" x 2.33"        Zone 1 $295   | Both zones $495
  [ ] Double 5.7" x 2.33"          Zone 1 $525   | Both zones $895
  [ ] Back Premium (by address)    Zone 1 $575   | Both zones $975
  [ ] Front Feature (top of front) Zone 1 $625   | Both zones $1,050
ZONE:  [ ] Zone 1 – Camp Hill & East Hampden (4,944 homes)
       [ ] Both zones (+ Hampden Twp West, 9,894 homes)

AD CONTENT (or attach):
  Headline offer:
  Expiry date of the offer (suggest Feb 28, 2027):
  Phone / website / address to print:
  Logo: attached [ ] / use the one on our website [ ]
  Licence or registration number to print (if your trade requires one):

PAY BY:  [ ] card   [ ] bank account (ACH)
I have read the Advertiser Agreement and I agree:  (type your name)
```

**How it works**

- **Payment.** You pay now through Stripe, so nothing is printed on credit.
- **Minimum.** The card prints only if at least 10 of its 22 ad cells are paid
  by **Wed Dec 9, 5 pm**. If not, you get a **full refund by Fri Dec 11**.
- **Proof.** I design your ad and email a proof within 1 business day. One round
  of changes is included. Final approvals are due Thu Dec 10 at noon.
- **Mailing.** The card goes to the post office on **Mon Jan 4, 2027** and
  reaches homes about Jan 5–12. Afterwards I send you a photo of the drop-off
  and the USPS receipt.

Thanks,
[Owner name] · The Neighbor Card · [mailing address], PA · [phone]

---

## Stripe set-up for this form (owner, once)

1. Go to stripe.com and create an account. There is no monthly or setup fee
   (https://stripe.com/pricing, read 2026-11-11).
2. Go to **Product catalogue** and add 8 products: Standard, Double, Back
   Premium and Front Feature, each in a "Zone 1" and a "Both zones" version, at
   the prices above. Set tax behaviour to **no tax**.
3. Create a **Payment Link** for each product. Payment Links carry no extra fee.
   Card payments cost 2.9% + 30¢. Turn on "US bank account" as well; ACH costs
   0.8%, capped at $5.
4. On each link, collect the business name and phone, and set the
   confirmation message to: "Thanks! Your category is locked. Reply to my email
   with your ad content."
5. Use an invoice instead (Brain can issue it once Stripe is connected; see
   `docs/CASH-PROVIDERS.md`) when a business needs one for its books. Stripe
   Invoicing adds 0.4% per paid invoice.
6. **Record each payment** in `prospects.csv` (`status = paid`, `paid_amount`),
   or in Brain as `CUSTOMER_PAYMENT`, so the threshold count uses real rows.
