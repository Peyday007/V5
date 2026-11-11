# Sales kit: emails, phone and walk-in script, social post

**Nothing here has been sent or posted.** Fill in the `[brackets]` first.

## Who to contact

The prospect list is `prospects.csv`: 117 West Shore businesses, each with a
published phone or website and a source URL.

- **Sources.** 88 rows come from the Mechanicsburg Chamber's public member
  directory (read 2026-11-11). 29 come from `fast-cash/10k/buyers-gift-boxes.csv`
  (dentists, orthodontists, HVAC, roofing, realtors, insurance).
- **Order.** Work `priority = 1` first (dentists, HVAC, gyms, chiropractors, spas,
  auto, car washes, pizza, realtors), then priority 2, then 3. Log every contact
  in the `status`, `contacted_on`, `outcome` and `paid_amount` columns. The
  kill tests count from those columns.
- **Emails.** Most rows have a website rather than an email address. Collect the
  address from the business's own Contact page when you email it, or call
  instead.

## What prospects asked for (evidence)

The owner's earlier "Local ad campaign" in Instantly had 1,138 sends, produced
1 opportunity, and drew "show me the mailer" replies. The one engaged prospect
wrote:

> "Before we move forward, I'd like to see what is getting sent and I'd like to
> know the percent of the 5000 homes that fall within our cities."

Every first touch therefore carries:

1. **the card itself**: `mockup/card-front-preview.jpg` and
   `mockup/card-back-preview.jpg`, or the 2-page `mockup/card-mockup-2-sides.pdf`;
2. **the homes by town**, from the route table below and `mockup/route-map-preview.jpg`;
3. **the one-page rate card**: `mockup/rate-card.pdf`.

Route table to paste:

| Where the 4,944 homes are (USPS carrier routes, ZIP 17011) | Homes | Share |
|---|---|---|
| Camp Hill borough | 2,804 | 57% |
| Hampden Township | 1,565 | 32% |
| East Pennsboro Township | 431 | 9% |
| Lemoyne borough | 140 | 3% |
| **Total: 11 whole carrier routes** | **4,944** | 100% |

---

## Email sequence (3 steps)

This is written for a **one-to-one send from the owner's own mailbox** to
addresses the businesses published.

**Sending from the owner's Instantly workspace.** Under §94 this is the owner's
sending system. Load these steps into a new campaign of the owner's choosing.
Brain only activates outreach under a standing `CONTACT_BUYER` grant. **This kit
creates nothing in Instantly.**

Day plan: Step 1 on day 0, Step 2 on day 3, Step 3 on day 8. Stop the sequence
on any reply.

### Step 1: day 0

**Subject:** A January postcard to 4,944 Camp Hill homes, one {{category}} spot

> Hi {{first_name}},
>
> I'm [Owner name], a [Mechanicsburg/Camp Hill] neighbour. I'm putting together
> **The Neighbor Card**, a big 9×12 postcard of local offers that USPS delivers to
> **4,944 homes in Camp Hill & East Hampden** on **January 4**. That's the week
> people book the dentist, join a gym and fix the furnace.
>
> **Here's exactly what gets mailed** (front and back attached), and **where the
> homes are**:
>
> - Camp Hill borough: 2,804 homes (57%)
> - Hampden Twp: 1,565 (32%)
> - East Pennsboro Twp: 431 (9%)
> - Lemoyne: 140 (3%)
>
> These are 11 whole USPS carrier routes in 17011, with residential homes only. A
> route map is attached.
>
> - **One {{category}} per card.** The spot is yours if you take it first.
> - **$295 for a standard spot** (about 6¢ a home), and I design the ad for free.
> - **No risk to you.** It prints only if 10 of the 22 spaces are paid by Dec 9.
>   Otherwise you get a full refund by Dec 11.
>
> Want me to hold the {{category}} spot while you look at the rate card?
>
> [Owner name] · The Neighbor Card · [phone]
> [Physical mailing address], [Town], PA [ZIP]
>
> *This is an advertising offer. Reply "no thanks" and I won't contact you again.*

Attachments: `card-front-preview.jpg`, `card-back-preview.jpg`,
`route-map-preview.jpg`, `rate-card.pdf` (about 2 MB in total).

**Over Instantly,** send the images as links instead. Attachments hurt
deliverability. Host the files in a shared folder, or as a page the owner
publishes.

### Step 2: day 3

**Subject:** Re: A January postcard to 4,944 Camp Hill homes

> Hi {{first_name}}, a quick follow-up with the one number most people ask
> about:
>
> At $295, a single new {{customer_type}} pays for the spot. [Example:
> one new-patient exam / one furnace tune-up / two months of membership.]
> The card goes to 4,944 homes with a USPS-counted median household income of
> about $109k.
>
> {{category}} is still open. Should I send the 2-minute order form?
>
> [Owner name] · [phone] · [address]
> *Reply "no thanks" to opt out.*

### Step 3: day 8

**Subject:** Closing the {{category}} spot on the Camp Hill card

> Hi {{first_name}}, last note from me on this. I'm filling the January card's
> remaining categories this week. If {{category}} isn't for you this time, no
> problem, and I'll leave you alone.
>
> If you'd like it, reply "yes" and I'll send the order form and a secure payment
> link. You're still covered by the full refund if the card doesn't fill by
> Dec 9.
>
> [Owner name] · [phone] · [address]
> *Reply "no thanks" to opt out.*

**CAN-SPAM checklist.** Requirements are in the FTC guide at
https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business (read 2026-11-11).
- Accurate From name and subject line.
- The message says it is an advertising offer.
- A valid physical postal address.
- A working opt-out, honoured within 10 business days and never charged for.
- No purchased lists.
- The owner stays responsible even if a tool sends for them.

---

## Phone and walk-in script (about 90 seconds)

Best times: dentists and offices 9–11 am; restaurants 2–4 pm; gyms and salons
mid-morning. Bring printed copies of the rate card and the card front/back. A
local print shop charges about $1–2 per colour page (ESTIMATE). Ask for the
**owner or manager**.

> **Open:** "Hi, I'm [name]. I live in [town]. I'm putting together a big
> postcard of local offers that goes to every home in Camp Hill and East
> Hampden, 4,944 homes, the first week of January. I have one spot per
> category, and [category] is open. Can I show you in 30 seconds?"
>
> **Show** the card mock-up and the route table: "Here's exactly what gets
> mailed. Here's where the homes are: 57% Camp Hill borough, 32% Hampden. These
> are whole USPS carrier routes, so homes only."
>
> **Price:** "A standard spot is $295, about 6 cents a home, and I design the ad.
> January is when people [book the dentist / join the gym / fix the furnace]."
>
> **Risk reversal:** "You pay now so I never print on credit. But if I don't
> have 10 of the 22 spaces paid by December 9, you get every dollar back by
> December 11."
>
> **Close:** "Do you want me to lock [category] for you today? I can text you the
> payment link right now."

**Objections.**

| They say | You say |
|---|---|
| "We tried Valpak / Money Mailer." | "Same idea, but only 18 local businesses, one per category, and an oversized card that stands out from envelopes. You see the whole card before you pay." |
| "Send me something." | "Sure. What's your email? I'll send the card, the route map and the order form now, and call you Thursday." Log the follow-up date. |
| "Too expensive." | "What's one new customer worth to you? If one booking pays for it, the rest is upside. I also have it at $495 for nearly 10,000 homes across both zones." |
| "Which homes exactly?" | Show the route table and map. "These 11 USPS routes, by town." |
| "Is this a real thing?" | "It's USPS Every Door Direct Mail. I hand the bundles to the Camp Hill Post Office on January 4 and send you a photo of the USPS receipt." |
| "Not now." | "Totally fine. Can I put you down for the February card?" Log it. |

---

## Facebook / Nextdoor post (business page)

Post only where the group's rules allow business posts. Nextdoor allows posts
from a Business Page; personal-profile selling is restricted.

> **Local businesses on the West Shore:** I'm putting together **The Neighbor
> Card**, a big 9×12 postcard of local offers mailed by USPS to **4,944 homes in
> Camp Hill & East Hampden** on **January 4**.
>
> - One business per category. Dentist, HVAC, gym, salon, spa, pizza, auto and
>   more are still open.
> - **$295 a spot**, ad design included.
> - Prints only if 10 of the 22 spaces are paid by Dec 9. Otherwise a full refund
>   by Dec 11.
>
> Here's the actual card and the route map 👇 Message me or call [phone].
> [Owner name] · [Town], PA

Images: `mockup/card-front-preview.jpg`, `mockup/route-map-preview.jpg`.

---

## Daily target, from the kill tests

The research estimates about 10–20 conversations per sold cell when cold. To
reach 10 cells by Dec 9 takes about 150–200 real conversations: about **10 a
business day** across calls and walk-ins, plus Step 1 emails to every
priority-1 and priority-2 row in the first week.
