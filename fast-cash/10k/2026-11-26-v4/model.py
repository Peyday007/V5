"""$10k-in-30-days decision model, v4 (2026-11-26). Planning only.

Route: AI-drafted, specialist-checked immigration and lender business plans
(E-2 first; also L-1A new office and SBA loans), sold to immigration attorneys
(wholesale) and applicants (direct).

No rate in this file comes from the owner's past campaigns (owner's order,
2026-11-26). Every input is labelled:
  EXTERNAL  published third-party figure (source in SOURCES.md)
  INFERRED  derived from EXTERNAL figures by stated arithmetic
  ASSUMED   no evidence; carried as a range, with a break-even next to it

Run:  python3 -I fast-cash/10k/2026-11-26-v4/model.py > fast-cash/10k/2026-11-26-v4/model-output.txt
Scenario values are not probabilities.
"""
import math

TARGET = 10_000.0
CAP_TOTAL, CAP_PRE = 2_000.0, 300.0

def fee(p):  # Stripe US card: 2.9% + 30c (EXTERNAL)
    return p * 0.029 + 0.30

# ---------------------------------------------------------------- prices
P_WHOLESALE = 1250.0   # attorney price; market $1,500-3,500, law-firm-organized ~$1,000 (EXTERNAL)
P_DIRECT = 1650.0      # applicant price, lower-middle of the $1,500-3,500 band (EXTERNAL)
MIX_WHOLESALE = 0.7    # ASSUMED share of orders through attorneys
AOV = MIX_WHOLESALE * P_WHOLESALE + (1 - MIX_WHOLESALE) * P_DIRECT

# ------------------------------------------------- unit cost of fulfilment
API_PER_PLAN = 15.0    # INFERRED: Opus 5.5 $4/$20 per MTok (EXTERNAL); ~1.5M in + 150k out with web research ~ $9, x1.6 margin
REVIEW_FIRST = 120.0   # ASSUMED: 1.5 h of a contracted business-plan specialist at ~$80/h, first 2 plans
REVIEW_LATER = 40.0    # ASSUMED: 30-min spot-check once two plans are accepted; Brain's checklist QC on every plan
def pay_fee(p, wholesale):  # wholesale invoiced by Stripe ACH: 0.8% capped at $5 (EXTERNAL); direct by card
    return min(5.0, p * 0.008) if wholesale else fee(p)
FEE_AVG = MIX_WHOLESALE * pay_fee(P_WHOLESALE, True) + (1 - MIX_WHOLESALE) * pay_fee(P_DIRECT, False)
def cogs(n_orders):
    n = max(0.0, n_orders)
    first = min(n, 2.0)
    return n * (API_PER_PLAN + FEE_AVG) + first * REVIEW_FIRST + (n - first) * REVIEW_LATER

print("=" * 78); print("A. ROUTE SCREEN: can each acquisition strategy fund $10k inside $2,000?"); print("=" * 78)
need_orders = TARGET / AOV
print(f"AOV ${AOV:,.0f} (70% wholesale ${P_WHOLESALE:,.0f}, 30% direct ${P_DIRECT:,.0f}) -> {need_orders:.1f} orders for $10k")
print(f"Fulfilment + fees for {math.ceil(need_orders)} orders: ${cogs(math.ceil(need_orders)):,.0f}")
room = CAP_TOTAL - cogs(math.ceil(need_orders))
print(f"=> acquisition room inside the cap: ${room:,.0f}; allowed CAC <= ${room/math.ceil(need_orders):,.0f} per order\n")
screens = [
    ("Generic paid search, business services", "LocaliQ 2025 CPL $103.54 (EXTERNAL); lead->paid 20-30% (ASSUMED)", 103.54 / 0.30, 103.54 / 0.20),
    ("Bark-style lead marketplace", "$2.35/credit x 10-15 credits (EXTERNAL); hire per response 10-20% (ASSUMED)", 2.35 * 10 / 0.20, 2.35 * 15 / 0.10),
    ("Upwork proposals (owner rejected freelance work 2026-10-20)", "$2.25-3.75/proposal, win 3-8% (EXTERNAL, vendor), + 10% fee", 2.25 / 0.08 + 0.10 * AOV, 3.75 / 0.03 + 0.10 * AOV),
    ("Attorney outreach, purchased data", "Maps data $3/1k + enrichment $3-14/1k (EXTERNAL); conversion UNKNOWN", None, None),
    ("AILA8 newsletter week, $1,000", "16,000 recipients, 38% open (EXTERNAL, vendor); click/order UNKNOWN", None, None),
]
for name, basis, lo, hi in screens:
    if lo is None:
        print(f"  {name:58} CAC depends on an UNKNOWN conversion: break-even in section C")
    else:
        verdict = "fits" if lo <= room / math.ceil(need_orders) else "does NOT fit"
        print(f"  {name:58} CAC ${lo:,.0f}-${hi:,.0f} -> {verdict} even at the favourable end")
    print(f"      basis: {basis}")
print("  Paid social DTC (holiday gifts): needs ROAS >= 5.9 on ~$1,700 ads; e-commerce benchmarks sit near 2 -> does NOT fit")
print("  Co-op postcard: vendor drop ~$2,309 for 4,944 homes (M13 + print) -> over the cap before any revenue")

# ------------------------------------------------------------------ channels
SC = {  # every conversion value below is ASSUMED; leads are INFERRED
    "conservative": dict(L=1000, p_int=0.002, p_ord=0.30, m=1.0, ad=False, ctr=0.010, intake=0.05, close=0.30, refund=0.15),
    "base":         dict(L=1500, p_int=0.006, p_ord=0.50, m=1.2, ad=True,  ctr=0.030, intake=0.10, close=0.40, refund=0.10),
    "upside":       dict(L=2500, p_int=0.015, p_ord=0.60, m=1.5, ad=True,  ctr=0.060, intake=0.20, close=0.50, refund=0.05),
}
AILA_RECIP, AILA_OPEN, AILA_COST = 16000, 0.38, 1000.0   # EXTERNAL (vendor media kit 2025)
PRE_SPEND = {"domain": 12, "contact data": 70, "sample plan API": 15, "specialist critique of sample": 120, "search-ad CPC/policy probe": 50}
PRE = sum(PRE_SPEND.values())

print(); print("=" * 78); print("B. SCENARIOS (customer payments within the window)"); print("=" * 78)
print(f"Pre-proof spend ${PRE} of ${CAP_PRE:.0f}: " + ", ".join(f"{k} ${v}" for k, v in PRE_SPEND.items()))
res = {}
for name, s in SC.items():
    o_out = s["L"] * 0.97 * s["p_int"] * s["p_ord"] * s["m"]                 # 3% bounce after MX check (ASSUMED)
    buy_ad = s["ad"] and o_out < need_orders and (CAP_TOTAL - PRE - AILA_COST - cogs(need_orders)) >= 0
    o_ad = AILA_RECIP * AILA_OPEN * s["ctr"] * s["intake"] * s["close"] if buy_ad else 0.0
    orders = o_out + o_ad
    spend_fixed = PRE + (AILA_COST if buy_ad else 0)
    cap_orders = orders
    while cap_orders > 0 and spend_fixed + cogs(cap_orders) > CAP_TOTAL:
        cap_orders -= 0.1
    capped = cap_orders < orders - 1e-9
    orders = cap_orders
    pay = orders * AOV
    refunds = pay * s["refund"]
    spend = spend_fixed + cogs(orders)
    net = pay - refunds - spend
    res[name] = dict(orders=orders, pay=pay, refunds=refunds, spend=spend, net=net, o_out=min(o_out, orders), o_ad=max(0.0, orders - o_out), buy_ad=buy_ad)
    print(f"\n{name.upper()}: outreach {s['L']} attorneys x interest {100*s['p_int']:.1f}% x order {int(100*s['p_ord'])}% x {s['m']} = {o_out:.1f} orders;"
          f" AILA8 week {'bought' if buy_ad else 'not bought'} -> {o_ad:.1f} orders" + ("  [SPENDING CAP BINDS]" if capped else ""))
    print(f"   orders fulfilled inside the cap {orders:.1f} | customer payments ${pay:,.0f} | refunds ${refunds:,.0f} | fees ${orders*FEE_AVG:,.0f}")
    print(f"   total spending ${spend:,.0f} (cap $2,000) | net profit ${net:,.0f} | gap to $10k ${max(0, TARGET - pay):,.0f}")

print(); print("=" * 78); print("C. BREAK-EVENS AND SENSITIVITY"); print("=" * 78)
for L in (1000, 1500, 2500):
    for p_ord, m in ((0.5, 1.2), (0.6, 1.5)):
        need = need_orders / (L * 0.97 * p_ord * m)
        print(f"  outreach only: {L} attorneys, order {int(100*p_ord)}% of interested, {m} plans each -> interest needed {100*need:.2f}%")
for ctr in (0.01, 0.03, 0.06):
    for intake, close in ((0.10, 0.4), (0.2, 0.5)):
        o = AILA_RECIP * AILA_OPEN * ctr * intake * close
        print(f"  AILA8 week: click/open {100*ctr:.0f}% x intake {int(100*intake)}% x paid {int(100*close)}% -> {o:5.1f} orders (${o*AOV:,.0f})")
per = API_PER_PLAN + REVIEW_LATER + FEE_AVG
print(f"  Spending cap: after the first two plans each order costs ~${per:,.0f} (API ${API_PER_PLAN:.0f} + spot-check ${REVIEW_LATER:.0f} + fees ${FEE_AVG:.0f}).")
for ad in (False, True):
    room = CAP_TOTAL - PRE - (AILA_COST if ad else 0) - 2 * (API_PER_PLAN + REVIEW_FIRST + FEE_AVG)
    mx = 2 + room / per
    print(f"  max orders the cap can fund {'with' if ad else 'without'} the AILA week: {mx:4.1f} (${mx*AOV:,.0f})")

print(); print("=" * 78); print("D. DATED CASH FLOW, base (day 1 = Mon Nov 30, day 30 = Tue Dec 29)"); print("=" * 78)
for nm in ("base", "upside"):
    b = res[nm]
    pre_orders = min(2.0, b["o_out"])
    rows = [  # order timing ASSUMED: first outreach orders by day 9, rest Dec 10-18; ad orders Dec 15-23
        ("Nov 30", "domain, data, sample plan + critique, CPC probe", 0.0, PRE),
        ("Dec 01-09", "outreach orders before the proof gate", pre_orders * AOV, cogs(pre_orders)),
        ("Dec 10", "AILA8 week booked" if b["buy_ad"] else "AILA8 week not needed", 0.0, AILA_COST if b["buy_ad"] else 0.0),
        ("Dec 10-18", "outreach orders after the gate", (b["o_out"] - pre_orders) * AOV, cogs(b["o_out"]) - cogs(pre_orders)),
        ("Dec 15-23", "AILA8 ad orders", b["o_ad"] * AOV, cogs(b["orders"]) - cogs(b["o_out"])),
        ("Dec 29", "refund provision", -b["refunds"], 0.0),
    ]
    print(f"\n{nm.upper()}")
    cp = cs = 0.0
    for d, ev, p, sp in rows:
        cp += p; cs += sp
        print(f"  {d:9} {ev:48} payments {p:>8,.0f}  spend {sp:>7,.0f}  cum pay {cp:>8,.0f}  cum spend {cs:>7,.0f}")
    # settled by Dec 29: outreach-order money (ACH ~4 business days; card after the first 7-14 day payout) plus
    # half of the ad-week money (orders Dec 15-23), less refunds and every dollar spent (ASSUMED timing)
    settled = b["o_out"] * AOV + 0.5 * b["o_ad"] * AOV - b["refunds"] - b["spend"]
    print(f"  day 30: payments ${b['pay']:,.0f}, refunds ${b['refunds']:,.0f}, spending ${b['spend']:,.0f}, net ${b['net']:,.0f};"
          f" cash settled in the bank by Dec 29 ~${max(0, settled):,.0f}; the rest of the net settles in early January")
print("\nBank: Stripe first payout 7-14 days after the first live payment (EXTERNAL), then rolling; ACH settles in ~4 business days.")
print("Obligations past day 30: up to 2 revision rounds per delivered plan (API + spot-check cost already provisioned).")
