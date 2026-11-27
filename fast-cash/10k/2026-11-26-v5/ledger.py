"""Append-only money ledger for the E-2 test, and the gates that read it.

python3 -I fast-cash/10k/2026-11-26-v5/ledger.py   -> reconciled scenario statements (ledger-output.txt)

Design (see LEDGER.md): every money event is one immutable entry. Balances,
caps and gates are derived from the entries, never stored. Refunds never
lower the spending counters; processor fees count as spending; a Stripe
payout is a settlement (cash moves to the bank), not revenue.
"""
from dataclasses import dataclass, field
import datetime as dt

PRE_CAP, TOTAL_CAP = 300.00, 2000.00
KINDS = {"CUSTOMER_PAYMENT", "REFUND", "PROCESSOR_FEE", "SPEND", "PAYOUT", "OBLIGATION_OPEN", "OBLIGATION_CLOSE"}

@dataclass(frozen=True)
class Entry:
    date: dt.date
    kind: str
    amount: float          # positive number; the kind gives the sign
    ref: str               # order id, vendor, payout id
    phase: str = ""        # SPEND only: PRE (before proof) or POST
    category: str = ""     # SPEND: domain, data, api, review, probe, ads ...; PAYMENT: ach / card

class Ledger:
    def __init__(self):
        self.entries: list[Entry] = []
        self.proof_at: dt.date | None = None

    def add(self, e: Entry):
        assert e.kind in KINDS and e.amount >= 0
        if e.kind == "SPEND":
            assert e.phase in ("PRE", "POST"), "spend needs a phase"
            if e.phase == "POST":
                assert self.proof_at is not None and e.date >= self.proof_at, "post-proof spend before proof"
            if e.phase == "PRE":
                assert self.pre_spend() + e.amount <= PRE_CAP + 1e-9, "pre-proof cap ($300) would be exceeded"
        if e.kind == "PROCESSOR_FEE" and (self.proof_at is None or e.date < self.proof_at):
            assert self.pre_spend() + e.amount <= PRE_CAP + 1e-9, "pre-proof cap ($300) would be exceeded (fee)"
        if e.kind in ("SPEND", "PROCESSOR_FEE"):
            assert self.total_spend() + e.amount <= TOTAL_CAP + 1e-9, "total cap ($2,000) would be exceeded"
        self.entries.append(e)

    def s(self, kind, **kw):
        return sum(e.amount for e in self.entries if e.kind == kind and all(getattr(e, k) == v for k, v in kw.items()))
    def pre_spend(self):
        fees_pre = sum(e.amount for e in self.entries if e.kind == "PROCESSOR_FEE" and (self.proof_at is None or e.date < self.proof_at))
        return self.s("SPEND", phase="PRE") + fees_pre
    def total_spend(self): return self.s("SPEND") + self.s("PROCESSOR_FEE")
    def payments(self): return self.s("CUSTOMER_PAYMENT")
    def refunds(self): return self.s("REFUND")
    def net(self): return self.payments() - self.refunds() - self.total_spend()
    def paid_orders(self): return len({e.ref for e in self.entries if e.kind == "CUSTOMER_PAYMENT"})
    def open_obligations(self, on):
        o = {e.ref for e in self.entries if e.kind == "OBLIGATION_OPEN" and e.date <= on}
        c = {e.ref for e in self.entries if e.kind in ("OBLIGATION_CLOSE", "REFUND") and e.date <= on}
        return sorted(o - c)
    def settled_by(self, d):
        """Cash that reached the bank by d: payouts, less the fees of refunded orders, which Stripe keeps
        and debits from the balance (and so from a later payout) on the refund date."""
        paid_out = sum(e.amount for e in self.entries if e.kind == "PAYOUT" and e.date <= d)
        refunded = {e.ref for e in self.entries if e.kind == "REFUND" and e.date <= d}
        kept_fees = sum(e.amount for e in self.entries if e.kind == "PROCESSOR_FEE" and e.ref in refunded)
        return paid_out - kept_fees

# ------------------------------------------------------------ fees and timing
def stripe_fee(amount, method):          # US: ACH 0.8% capped $5; card 2.9% + $0.30 (published Stripe pricing)
    return min(5.0, round(amount * 0.008, 2)) if method == "ach" else round(amount * 0.029 + 0.30, 2)

FIRST_LIVE_PAYMENT = None
def payout_date(paid, method, first_live):
    """Stripe: first payout 7-14 days after the first live payment (use 14, conservative); then
    standard US rolling ~2 business days for card; ACH debits settle ~4 business days, then payout."""
    lag = dt.timedelta(days=6 if method == "ach" else 3)
    first_ok = first_live + dt.timedelta(days=14)
    return max(paid + lag, first_ok)

# --------------------------------------------------------------- scenarios
D = lambda m, d: dt.date(2026, m, d)
PRE_ITEMS = [  # proof-stage purchases; fulfilment of the proof orders below ALSO counts against the $300
    (D(11, 30), 12.00, "domain", "brand domain + DNS"),
    (D(11, 30), 30.00, "data", "Maps records + email enrichment (~8k records at $3/1k after 500 free)"),
    (D(11, 30), 15.00, "api", "sample plan regeneration on the API"),
]
REVIEW_PRE = 95.00   # specialist review on each proof order: <= 1 h at the Upwork "intermediate" $79/h band + margin
POST_ITEMS = [       # moved after proof: they are not needed to obtain proof
    (D(12, 15), 150.00, "review", "specialist critique of the sample (one-off)"),
    (D(12, 15), 50.00, "probe", "search-ad CPC/policy probe"),
]
API_PER_PLAN = 15.00

def run(name, orders, review_per_plan, refund_ids=(), ad=False, proof_date=D(12, 14)):
    """orders: list of (order_id, paid_date, amount, method). Every order gets: API drafting,
    a specialist review at review_per_plan, a delivery obligation (5 business days) and
    a revision obligation (30 days)."""
    L = Ledger()
    for d, amt, cat, ref in PRE_ITEMS:
        L.add(Entry(d, "SPEND", amt, ref, "PRE", cat))
    first_live = min((o[1] for o in orders), default=None)
    paid_before_proof = [o for o in orders if o[1] <= proof_date]
    if len({o[0] for o in paid_before_proof}) >= 2:
        L.proof_at = proof_date
    for oid, paid, amt, method in sorted(orders, key=lambda o: o[1]):
        phase = "POST" if L.proof_at and paid >= L.proof_at else "PRE"
        L.add(Entry(paid, "OBLIGATION_OPEN", 0, oid))
        L.add(Entry(paid, "CUSTOMER_PAYMENT", amt, oid, category=method))
        L.add(Entry(paid, "PROCESSOR_FEE", stripe_fee(amt, method), oid, category=method))
        # fulfilment cost of each paid plan; before proof it draws on the $300 allowance
        L.add(Entry(paid, "SPEND", API_PER_PLAN, oid, phase, "api"))
        L.add(Entry(paid, "SPEND", REVIEW_PRE if phase == "PRE" else review_per_plan, oid, phase, "review"))
        if oid in refund_ids:
            L.add(Entry(paid + dt.timedelta(days=6), "REFUND", amt, oid))      # inside the review window, before payout; fee is not returned
        else:
            L.add(Entry(paid + dt.timedelta(days=37), "OBLIGATION_CLOSE", 0, oid))
            L.add(Entry(payout_date(paid, method, first_live), "PAYOUT", amt - stripe_fee(amt, method), oid))
    if L.proof_at:
        for d, amt, cat, ref in POST_ITEMS:
            L.add(Entry(d, "SPEND", amt, ref, "POST", cat))
    if ad:
        L.add(Entry(D(12, 15), "SPEND", 1000.00, "AILA8 weekly ad", "POST", "ads"))
    return L

def statement(name, L, note):
    by_cat = {}
    for e in L.entries:
        if e.kind == "SPEND":
            by_cat[e.category] = by_cat.get(e.category, 0) + e.amount
    print(f"\n{name}  ({note})")
    print(f"  paid orders {L.paid_orders()}; proof reached: {L.proof_at or 'no'}; collected net of refunds {L.payments() - L.refunds():,.2f} (target 10,000)")
    print(f"  customer payments          {L.payments():>10,.2f}")
    print(f"  - refunds                  {L.refunds():>10,.2f}")
    print(f"  - processor fees           {L.s('PROCESSOR_FEE'):>10,.2f}   (not returned on refunds)")
    for c, v in sorted(by_cat.items()):
        print(f"  - spend: {c:<17} {v:>10,.2f}")
    print(f"  = net profit               {L.net():>10,.2f}")
    print(f"  total spending             {L.total_spend():>10,.2f}  of {TOTAL_CAP:,.0f}   | pre-proof spending {L.pre_spend():,.2f} of {PRE_CAP:,.0f}")
    settled = L.settled_by(D(12, 29))
    unsettled = L.payments() - L.refunds() - L.s("PROCESSOR_FEE") - settled
    print(f"  settled to bank by Dec 29  {settled:>10,.2f};  still in Stripe on Dec 29 {unsettled:>9,.2f}")
    print(f"  cash position Dec 29 = settled - all spending paid from the card = {settled - (L.total_spend() - L.s('PROCESSOR_FEE')):,.2f}")
    print(f"  open obligations on Dec 29: {len(L.open_obligations(D(12, 29)))} plan(s) inside their 30-day revision window (cost already counted)")
    # reconciliation identity
    lhs = L.payments() - L.refunds() - L.s("PROCESSOR_FEE") - (L.total_spend() - L.s("PROCESSOR_FEE"))
    assert abs(lhs - L.net()) < 0.01

if __name__ == "__main__":
    print("RECONCILED SCENARIOS (illustrations at the test thresholds, not forecasts)")
    print("Prices: $1,250 attorney-referred (ACH), $1,650 direct (card). Review: specialist on EVERY plan.")
    ach = lambda i, d: (f"A{i}", d, 1250.0, "ach")
    card = lambda i, d: (f"D{i}", d, 1650.0, "card")
    T0 = run("T0", [], 120.0)
    statement("T0 no demand", T0, "test stops on Dec 14; only proof-stage purchases spent")
    T1 = run("T1", [ach(1, D(12, 10)), ach(2, D(12, 12))], 120.0)
    statement("T1 proof, nothing more", T1, "exactly the proof threshold: 2 paid by Dec 14, then no further orders")
    T2o = [ach(1, D(12, 10)), ach(2, D(12, 12)), ach(3, D(12, 14)), ach(4, D(12, 15)), ach(5, D(12, 16)),
           card(6, D(12, 17)), ach(7, D(12, 18)), ach(8, D(12, 21)), ach(9, D(12, 22))]
    T2 = run("T2", T2o, 120.0, refund_ids={"A7"})
    statement("T2 $10k threshold, outreach only", T2, "9 paid orders by Dec 22, one refunded -> payments less refunds >= $10,000; review $120 on every plan")
    try:
        run("T3", T2o, 120.0, refund_ids={"A7"}, ad=True)
        print("\nT3 fits the cap")
    except AssertionError as err:
        print(f"\nT3 $10k threshold WITH the $1,000 AILA week at $120/plan review: REFUSED by the ledger -> {err}")
    T3 = run("T3", T2o, 40.0, refund_ids={"A7"}, ad=True)
    statement("T3' $10k threshold with the AILA week", T3, "only possible if per-plan review falls to a $40 spot-check")


# ------------------------------------------------------------------------------------------------
# Committed obligations (2026-11-26, owner request): money is reserved against both caps when an
# order is ACCEPTED at intake, not when it is spent. A pay-after-approval first case commits the
# API run and the reviewer fee before any payment; every delivered plan keeps a revision allowance
# committed until its 30-day window closes.
API_PER_REVISION = 3.00          # ASSUMED: a revision pass re-runs part of the draft on the API
FIXED_PROOF_STAGE = 57.00        # domain 12 + data 30 + sample API 15 (PRE_ITEMS)

def proof_stage_exposure(review_fee, recheck_fee, rechecks, orders=2, ach_fee=5.00):
    """Worst-case cash plus commitment before proof for the two pay-after-approval proof orders."""
    per_order = API_PER_PLAN + review_fee + rechecks * (recheck_fee + API_PER_REVISION) + ach_fee
    return FIXED_PROOF_STAGE + orders * per_order

def committed_open(n_open_plans, recheck_fee, rechecks):
    """Revision allowance still committed for plans inside their 30-day window."""
    return n_open_plans * rechecks * (recheck_fee + API_PER_REVISION)

if __name__ == "__main__":
    print("\nCOMMITTED OBLIGATIONS: affordability of 'unlimited revisions' and 'pay after approval'")
    print("Proof stage (2 first-case orders, pay after approval) must keep cash + commitments <= $300:")
    print(f"  {'review fee':>10} {'re-check fee':>12} {'re-checks committed':>20} {'exposure':>9}  fits $300?")
    for rf in (75.0, 95.0, 120.0):
        for rc in (0.0, 25.0, 40.0):
            for n in (1, 2, 3):
                x = proof_stage_exposure(rf, rc, n)
                print(f"  {rf:>10.0f} {rc:>12.0f} {n:>20} {x:>9.2f}  {'yes' if x <= PRE_CAP else 'NO'}")
    print("  'Unlimited' re-checks have no finite commitment, so they cannot be shown to fit any cap:")
    print("  the promise is affordable only if the reviewer's fixed fee includes every re-check in 30 days")
    print("  (re-check fee 0), or if the promise is capped (e.g. 2 included rounds, then $X a round).")
    print("If an approved first case is never paid, its spend is a loss and the receivable is not revenue:")
    for rf in (75.0, 95.0):
        print(f"  review ${rf:.0f}: unrecovered cost per unpaid first case ${API_PER_PLAN + rf + 2 * API_PER_REVISION:.2f} (2 re-checks included in the fee)")
    print("\nT2 ($10k threshold) with commitments: 8 plans inside their revision window on Dec 29")
    for rc, n in ((0.0, 2), (25.0, 2), (40.0, 3)):
        c = committed_open(8, rc, n)
        print(f"  re-check fee ${rc:.0f} x {n} committed: open commitments ${c:,.2f}; spend $1,510.15 + commitments = ${1510.15 + c:,.2f} (cap 2,000)")
