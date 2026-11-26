"""$10k-in-30-days decision model, version 3 (2026-11-26). Planning only.

Run:  python3 -I fast-cash/10k/2026-11-26-v3/model.py  > fast-cash/10k/2026-11-26-v3/model-output.txt

Every input carries its basis:
  OBSERVED  - read from a live record (Instantly, Brain, a run of Brain's generator)
  EXTERNAL  - published third-party figure
  INFERRED  - derived from observed/external figures through a stated model
  ASSUMED   - no evidence; shown with a range and a break-even instead of a point claim

The model is deterministic scenario arithmetic plus a labelled sweep. Sweep
quantiles are spreads over stated ranges, not probabilities.
"""
import json, math, os, random, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
EV = json.load(open(os.path.join(HERE, "evidence.json")))
TARGET = 10_000.0

def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)

def stripe_fee(price):
    return round(price * 0.029 + 0.30, 2)

# --------------------------------------------------------------------------
# 1. Observed engagement per contacted lead, from the owner's own workspace
# --------------------------------------------------------------------------
print("=" * 78)
print("1. ENGAGEMENT EVIDENCE (OBSERVED, Instantly, hand-classified human buying replies)")
print("=" * 78)
rows = EV["campaigns"]
for r in rows:
    k, n = r["engaged_hand_classified"], r["new_leads_contacted"]
    lo, hi = wilson(k, n)
    print(f"{r['campaign'][:44]:44} engaged {k:>2}/{n:<5} = {100*k/max(n,1):5.2f}%  95% CI {100*lo:5.2f}-{100*hi:5.2f}%")
nc = [r for r in rows if r["campaign"] == "Neighbor Card · Camp Hill Jan 2027"][0]
others = [r for r in rows if not r["campaign"].startswith("Neighbor Card")]
k_o = sum(r["engaged_hand_classified"] for r in others); n_o = sum(r["new_leads_contacted"] for r in others)
lo_o, hi_o = wilson(k_o, n_o)
lo_nc, hi_nc = wilson(nc["engaged_hand_classified"], nc["new_leads_contacted"])
print(f"{'Pooled, every non-Neighbor-Card campaign':44} engaged {k_o:>2}/{n_o:<5} = {100*k_o/n_o:5.2f}%  95% CI {100*lo_o:5.2f}-{100*hi_o:5.2f}%")
paid_total = sum(r["paid_orders"] for r in rows)
print(f"Paid orders ever recorded in this workspace: {paid_total}; payment links ever sent: 0 (no Stripe).")
print("=> purchase-given-engagement has NO observation at all. It is ASSUMED below, with a break-even.")

E_CONS = k_o / n_o                                   # OBSERVED pooled history (most of the record)
E_UP = nc["engaged_hand_classified"] / nc["new_leads_contacted"]   # OBSERVED best campaign
E_BASE = math.sqrt(E_CONS * E_UP)                     # INFERRED: geometric midpoint, no direct evidence

# --------------------------------------------------------------------------
# 2. Route screen: what yield per contacted lead does $10k require?
# --------------------------------------------------------------------------
print()
print("=" * 78)
print("2. ROUTE SCREEN: required average order value (AOV) for $10k, given lead supply")
print("=" * 78)
print("Required AOV = 10,000 / (leads x engaged x paid|engaged x paid-in-window x (1-refund))")
for leads in (1000, 2500, 5000):
    for e, en in ((E_CONS, "hist"), (E_BASE, "mid"), (E_UP, "NC-best")):
        for c in (0.10, 0.20, 0.35):
            y = leads * e * c * 0.9 * 0.93
            aov = TARGET / y if y else float("inf")
            print(f"  leads {leads:>5}  e={100*e:4.2f}% ({en:7})  c={int(100*c):>2}%  ->  required AOV ${aov:>10,.0f}")
print("Reading: with the best engagement ever observed (1.06%) and 2,500 leads, $10k needs an AOV")
print("of roughly $1,000-$3,700; under the pooled history it needs $50k+. Low-ticket offers cannot reach it.")

# --------------------------------------------------------------------------
# 3. Recommended route: accessibility reports, two segments
# --------------------------------------------------------------------------
SEG = {
    # AOV mixes are ASSUMED (a stated product mix), prices are the offer's own.
    "SMB":    {"products": [(149, 0.70), (395, 0.30)]},      # Report / Fix Kit
    "Agency": {"products": [(349, 0.50), (990, 0.50)]},      # 10-site / 40-site white-label pack
}
for s in SEG.values():
    s["aov"] = sum(p * w for p, w in s["products"])
    s["fee"] = sum(stripe_fee(p) * w for p, w in s["products"])

SCEN = {
    #             leads delivered (INFERRED supply)   engaged    paid|eng  paid-in-window refund
    "conservative": {"SMB": 600,  "Agency": 150, "e": E_CONS, "c": 0.10, "w": 0.70, "r": 0.10},
    "base":         {"SMB": 1500, "Agency": 400, "e": E_BASE, "c": 0.20, "w": 0.85, "r": 0.07},
    "upside":       {"SMB": 3000, "Agency": 1000, "e": E_UP,  "c": 0.35, "w": 0.95, "r": 0.05},
}
print()
print("=" * 78)
print("3. SCENARIOS (accessibility reports; leads = verified, delivered, contacted in window)")
print("=" * 78)
print(f"Engagement: conservative {100*E_CONS:.3f}% (OBSERVED pooled history), base {100*E_BASE:.3f}% (INFERRED midpoint),")
print(f"upside {100*E_UP:.2f}% (OBSERVED best campaign). Paid|engaged 10/20/35% ASSUMED. AOV SMB ${SEG['SMB']['aov']:.0f}, Agency ${SEG['Agency']['aov']:.0f} (ASSUMED mix).")
results = {}
for name, s in SCEN.items():
    gross = refunds = fees = orders = 0.0
    detail = []
    for seg in ("SMB", "Agency"):
        o = s[seg] * s["e"] * s["c"] * s["w"]
        g = o * SEG[seg]["aov"]
        f = o * SEG[seg]["fee"]
        rf = g * s["r"]
        orders += o; gross += g; fees += f; refunds += rf
        detail.append(f"{seg}: {s[seg]} leads -> {s[seg]*s['e']:.1f} engaged -> {o:.2f} orders -> ${g:,.0f}")
    verification = 50 if name != "conservative" else 0     # optional list verification (pre-proof allowance)
    spend = fees + verification
    net = gross - refunds - spend
    results[name] = dict(orders=orders, gross=gross, refunds=refunds, fees=fees, spend=spend, net=net)
    print(f"\n{name.upper()}")
    for d in detail:
        print("   ", d)
    print(f"    customer payments ${gross:,.0f} | refunds ${refunds:,.0f} | Stripe fees ${fees:,.0f} | other spend ${verification}")
    print(f"    total spending ${spend:,.0f} | net profit ${net:,.0f} | gap to $10k ${max(0, TARGET-gross):,.0f}")

# --------------------------------------------------------------------------
# 4. Sensitivity and thresholds
# --------------------------------------------------------------------------
print()
print("=" * 78)
print("4. SENSITIVITY: customer payments (window) for Agency leads x engaged x paid|engaged,")
print("   SMB held at base (1,500 leads); window 0.85, refund 7%")
print("=" * 78)
def payments(smb, ag, e, c, w=0.85):
    return (smb * SEG["SMB"]["aov"] + ag * SEG["Agency"]["aov"]) * e * c * w
for ag in (400, 1000, 2000):
    line = f"agency leads {ag:>5}: "
    for e in (E_CONS, 0.003, 0.006, E_UP, 0.02):
        cells = [f"{100*e:4.2f}%/{int(100*c)}%=${payments(1500, ag, e, c):>6,.0f}" for c in (0.2, 0.35)]
        line += " | ".join(cells) + " || "
    print(line)

print("\nThresholds for $10,000 in customer payments (window factor 0.95, SMB 1,500 leads):")
for e in (E_UP, 0.015, 0.02, 0.03):
    for c in (0.20, 0.35, 0.50):
        need = (TARGET / (e * c * 0.95) - 1500 * SEG["SMB"]["aov"]) / SEG["Agency"]["aov"]
        print(f"  engaged {100*e:4.2f}% & paid|engaged {int(100*c)}%  ->  agency leads needed {max(0,need):>7,.0f}")
print("Agency lead supply inside the window is INFERRED at 150-1,000. $10k therefore needs engagement")
print("at or above ~2% AND paid|engaged at or above ~35-50% - both above anything this workspace has recorded.")

# --------------------------------------------------------------------------
# 5. Labelled sweep (correlated): spread only, not a probability
# --------------------------------------------------------------------------
random.seed(20261126)
N = 20000
vals = []
for _ in range(N):
    fit = random.random()                                   # one shared offer-market-fit factor
    e = math.exp(math.log(E_CONS) + fit * (math.log(E_UP) - math.log(E_CONS))) * random.uniform(0.7, 1.3)
    c = 0.10 + 0.25 * min(1, max(0, fit + random.uniform(-0.25, 0.25)))  # fit raises close too
    smb = random.uniform(600, 3000); ag = random.uniform(150, 1000)
    w = random.uniform(0.7, 0.95)
    vals.append(payments(smb, ag, e, c, w))
vals.sort()
q = lambda p: vals[int(p * (N - 1))]
print()
print("=" * 78)
print("5. CORRELATED SWEEP over the stated ranges (spread, NOT a probability)")
print("=" * 78)
print(f"customer payments  10th ${q(.10):,.0f} | median ${q(.5):,.0f} | 90th ${q(.9):,.0f} | max ${vals[-1]:,.0f}")
print(f"sweep share of worlds >= $10,000: {100*sum(v >= TARGET for v in vals)/N:.2f}% (over assumed ranges; not calibrated)")

# --------------------------------------------------------------------------
# 6. Dated cash flow, base and upside
# --------------------------------------------------------------------------
print()
print("=" * 78)
print("6. DATED CASH FLOW (orders spread by week ASSUMED 15/30/35/20%; Stripe first payout ~10 days")
print("   after first live payment (Stripe: 7-14 days), then rolling ~2 business days)")
print("=" * 78)
weeks = [("Dec 01-06", dt.date(2026, 12, 6), 0.15), ("Dec 07-13", dt.date(2026, 12, 13), 0.30),
         ("Dec 14-20", dt.date(2026, 12, 20), 0.35), ("Dec 21-29", dt.date(2026, 12, 29), 0.20)]
first_payout = dt.date(2026, 12, 4) + dt.timedelta(days=10)
for name in ("base", "upside"):
    r = results[name]
    cum_g = cum_s = cum_r = 0.0
    print(f"\n{name.upper()}  (first live payment assumed Dec 4; first payout ~{first_payout})")
    print(f"  {'week':10} {'payments':>9} {'refunds':>8} {'fees+spend':>11} {'cum pay':>9} {'cum spend':>10} {'settled to bank by week end':>28}")
    for wk, end, share in weeks:
        g = r["gross"] * share; rf = r["refunds"] * share; sp = r["spend"] * share
        cum_g += g; cum_r += rf; cum_s += sp
        settled = 0.0 if end < first_payout else (cum_g - cum_r - cum_s) - (g * 0.3 if end < dt.date(2026, 12, 29) else g * 0.15)
        print(f"  {wk:10} {g:>9,.0f} {rf:>8,.0f} {sp:>11,.0f} {cum_g:>9,.0f} {cum_s:>10,.0f} {max(0,settled):>28,.0f}")
    print(f"  day-30 totals: payments ${r['gross']:,.0f}, refunds ${r['refunds']:,.0f}, spending ${r['spend']:,.0f}, net ${r['net']:,.0f}")
    print("  open obligations after day 30: Fix Kit re-scans (2 each) and agency re-scans; $0 marginal cost each")

# --------------------------------------------------------------------------
# 7. Comparator: the postcard route under the $2,000 all-in cap
# --------------------------------------------------------------------------
print()
print("=" * 78)
print("7. COMPARATOR: Neighbor Card under the cap (EXTERNAL prices; OBSERVED pool)")
print("=" * 78)
m13 = 120 + 0.262 * 4944
print(f"M13 full-service EDDM processing+postage for 4,944 homes: ${m13:,.2f} (+ print, est. $744 Clubflyers-equivalent, + drop boxes ~$150)")
print(f"=> ~${m13+744+150:,.0f} before Stripe fees, over the $2,000 cap; revenue ceiling $6,380 (full card).")
print("Local lead pool: 407 leads added Nov 11-12, then 1-20/day (OBSERVED) -> pool exhausted;")
print("5 engaged leads cannot fill the 10-cell threshold without paid phone work, which the cap cannot fund.")

# --------------------------------------------------------------------------
# 8. Arm S1 (urgent buyers: recently sued website defendants, $750 pack)
#    Needs a CourtListener account (new access: HTTP 401 today). Not counted as
#    available; shown so the owner can see what that access is worth.
# --------------------------------------------------------------------------
print()
print("=" * 78)
print("8. ARM S1 - recently sued website defendants, $750 pack (NEW ACCESS REQUIRED)")
print("=" * 78)
# EXTERNAL: Seyfarth 3,117 federal website suits in 2025 (~260/month); UsableNet 5,114 incl. NY/CA state.
# INFERRED: 90-day backlog 780-1,280 suits; 40-70% with a findable published business email -> 300-900 leads.
S1 = {"conservative": (300, E_CONS, 0.10), "base": (600, 0.006, 0.20), "upside": (900, 0.03, 0.40)}
for name, (L, e, c) in S1.items():
    o = L * e * c * SCEN[name]["w"]; g = o * 750
    print(f"  {name:12} leads {L:>4} x engaged {100*e:4.2f}% (ASSUMED; urgency) x paid {int(100*c)}% -> {o:4.2f} orders -> ${g:>7,.0f}"
          f"  | with accessibility arms: ${g + results[name]['gross']:>7,.0f}")
print("  $10k with all three arms needs S1 engagement near 3% (about 3x the best ever observed) and")
print("  SMB/agency arms at the best observed engagement with 35% paid|engaged.")

# --------------------------------------------------------------------------
# 9. Test power: what an 8-day, $0 test can and cannot distinguish
# --------------------------------------------------------------------------
print()
print("=" * 78)
print("9. TEST POWER (binomial/Poisson arithmetic)")
print("=" * 78)
for leads, label in ((120, "current permissions: one owner-named mailbox, ~15/day shared"), (1500, "with multi-sender authorization")):
    print(f"  {label}: {leads} delivered leads")
    for e in (E_CONS, E_BASE, E_UP):
        lam = leads * e
        print(f"     if true engagement {100*e:5.3f}%: expected engaged {lam:5.1f}; P(0 engaged) {math.exp(-lam):5.3f}")
for n_eng in (5, 10, 16):
    print(f"  after {n_eng} engaged leads with 0 orders: P(that | paid-given-engaged 20%) = {0.8**n_eng:.3f}; (| 35%) = {0.65**n_eng:.3f}")
print("  => the test is decision-grade only with multi-sender authorization (~1,500 leads in 8 days).")
print("     Under current permissions it cannot separate the pooled history from the best campaign.")
