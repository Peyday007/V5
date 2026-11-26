"""Builds the SAMPLE E-2 business plan (fictional business, fictional investor).

python3 -I fast-cash/10k/2026-11-26-v5/sample/build_sample.py
  -> sample-plan.html, financials.csv (and sample-plan.pdf via render.cjs)

Facts about the market are real and cited (Census). Everything about the
business itself (prices, volumes, wages offered, rent) is labelled as the
investor's assumption, as it would be in a real plan. No figure is invented
and presented as a market fact.
"""
import csv, html, os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- real data
CENSUS = {
    "pop_2024": 279_210,      # Census PEP Vintage 2024, Buncombe County NC (co-est2024-alldata.csv)
    "pop_2023": 276_789,
    "estab": 124,             # CBP 2023, NAICS 722515, Buncombe County (cbp23co.txt)
    "emp": 1_406,
    "payroll_k": 32_957,
    "us_estab": 84_105,       # CBP 2023 county sum, NAICS 722515
    "us_emp": 978_901,
    "us_payroll_k": 20_798_517,
}
pay_per_emp_local = CENSUS["payroll_k"] * 1000 / CENSUS["emp"]
pay_per_emp_us = CENSUS["us_payroll_k"] * 1000 / CENSUS["us_emp"]
residents_per_estab = CENSUS["pop_2024"] / CENSUS["estab"]

# ------------------------------------------------------ investor assumptions
A = dict(
    investment=210_000, build_out=92_000, equipment=58_000, roaster=24_000, inventory=6_000,
    deposits_fees=9_000, working_capital=21_000,
    ticket=8.40, days=360, tx_start=110, tx_y1_end=230, tx_growth=[0.08, 0.06, 0.05, 0.04],
    wholesale_start_month=4, wholesale_m4=1_800, wholesale_growth_m=0.06, wholesale_y_growth=[0.30, 0.20, 0.15, 0.10],
    cogs_cafe=0.31, cogs_wholesale=0.45, rent_m=5_200, utilities_m=1_400, insurance_m=420, marketing_m=900,
    software_m=310, repairs_m=350, card_fees=0.027, payroll_tax=0.11, depreciation_years=7,
)
HIRES = [  # title, start month (1-based), annual salary or hourly x hours, FTE
    ("General Manager (investor: Managing Member)", 1, 52_000, 1.0),
    ("Shift Lead / Head Barista", 1, 38_480, 1.0),     # $18.50/h x 2,080
    ("Barista", 1, 33_280, 1.0),                       # $16.00/h x 2,080
    ("Barista (part-time)", 1, 16_640, 0.5),
    ("Barista", 4, 33_280, 1.0),
    ("Roaster / Wholesale Coordinator", 6, 41_600, 1.0),
    ("Barista (part-time)", 10, 16_640, 0.5),
    ("Assistant Manager", 16, 42_000, 1.0),            # year 2
    ("Barista", 18, 33_280, 1.0),
    ("Wholesale Account Manager", 30, 46_000, 1.0),    # year 3
    ("Barista", 34, 33_280, 1.0),
    ("Barista (part-time)", 42, 16_640, 0.5),          # year 4
]
WAGE_GROWTH = 0.03

def payroll_month(m):
    yr = (m - 1) // 12
    return sum(s / 12 * (1 + WAGE_GROWTH) ** yr for _, start, s, _ in HIRES if m >= start)

def fte_at(m):
    return sum(f for _, start, _, f in HIRES if m >= start)

# ------------------------------------------------------------ monthly model
rows = []
tx = A["tx_start"]; wholesale = 0.0
for m in range(1, 61):
    yr = (m - 1) // 12
    if m <= 12:
        tx = A["tx_start"] + (A["tx_y1_end"] - A["tx_start"]) * (m - 1) / 11
    elif (m - 1) % 12 == 0:
        tx = tx * (1 + A["tx_growth"][yr - 1])
    cafe = tx * A["ticket"] * (1 + 0.025) ** yr * A["days"] / 12
    if m == A["wholesale_start_month"]:
        wholesale = A["wholesale_m4"]
    elif m > A["wholesale_start_month"] and m <= 12:
        wholesale *= 1 + A["wholesale_growth_m"]
    elif m > 12 and (m - 1) % 12 == 0:
        wholesale *= 1 + A["wholesale_y_growth"][yr - 1]
    revenue = cafe + wholesale
    cogs = cafe * A["cogs_cafe"] + wholesale * A["cogs_wholesale"]
    pay = payroll_month(m); ptax = pay * A["payroll_tax"]
    opex = (A["rent_m"] * (1.03 ** yr) + A["utilities_m"] + A["insurance_m"] + A["marketing_m"]
            + A["software_m"] + A["repairs_m"] + revenue * A["card_fees"])
    dep = (A["build_out"] + A["equipment"] + A["roaster"]) / (A["depreciation_years"] * 12)
    ebitda = revenue - cogs - pay - ptax - opex
    rows.append(dict(month=m, year=yr + 1, tx_day=round(tx), cafe=cafe, wholesale=wholesale, revenue=revenue,
                     cogs=cogs, payroll=pay, payroll_tax=ptax, opex=opex, ebitda=ebitda, depreciation=dep,
                     net_income=ebitda - dep, fte=fte_at(m)))

def year_sum(y, key):
    return sum(r[key] for r in rows if r["year"] == y)

with open(os.path.join(HERE, "financials.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    for r in rows:
        w.writerow({k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()})

# cash flow and balance sheet (annual)
capex = A["build_out"] + A["equipment"] + A["roaster"]
cash = A["investment"] - capex - A["inventory"] - A["deposits_fees"]
annual = []
for y in range(1, 6):
    rev = year_sum(y, "revenue"); ni = year_sum(y, "net_income"); dep = year_sum(y, "depreciation")
    ocf = ni + dep
    cash += ocf
    nbv = max(0.0, capex - dep * y)
    annual.append(dict(year=y, revenue=rev, cogs=year_sum(y, "cogs"), payroll=year_sum(y, "payroll"),
                       payroll_tax=year_sum(y, "payroll_tax"), opex=year_sum(y, "opex"), ebitda=year_sum(y, "ebitda"),
                       dep=dep, ni=ni, ocf=ocf, cash_end=cash, nbv=nbv, fte=rows[y * 12 - 1]["fte"],
                       equity=A["investment"] + sum(a["ni"] for a in []) ))
eq = A["investment"]
for a in annual:
    eq += a["ni"]; a["equity"] = eq
    a["assets"] = a["cash_end"] + a["nbv"] + A["inventory"] + A["deposits_fees"]
fixed_m = (A["rent_m"] + A["utilities_m"] + A["insurance_m"] + A["marketing_m"] + A["software_m"] + A["repairs_m"])
contrib = 1 - A["cogs_cafe"] - A["card_fees"]
y1_pay_m = year_sum(1, "payroll") * (1 + A["payroll_tax"]) / 12
breakeven_rev_m = (fixed_m + y1_pay_m) / contrib
breakeven_tx = breakeven_rev_m / (A["ticket"] * A["days"] / 12)

# ----------------------------------------------------------------- render
def money(x): return f"${x:,.0f}"
def table(head, body):
    h = "".join(f"<th>{html.escape(c)}</th>" for c in head)
    b = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in body)
    return f"<table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table>"

y1 = [r for r in rows if r["year"] == 1]
pl_rows = [[f"Year {a['year']}", money(a["revenue"]), money(a["cogs"]), money(a["payroll"] + a["payroll_tax"]),
            money(a["opex"]), money(a["ebitda"]), money(a["dep"]), money(a["ni"])] for a in annual]
m_rows = [[f"M{r['month']}", r["tx_day"], money(r["cafe"]), money(r["wholesale"]), money(r["revenue"]),
           money(r["payroll"] + r["payroll_tax"]), money(r["ebitda"])] for r in y1]
cf_rows = [[f"Year {a['year']}", money(a["ni"]), money(a["dep"]), money(a["ocf"]), money(a["cash_end"])] for a in annual]
bs_rows = [[f"Year {a['year']}", money(a["cash_end"]), money(a["nbv"]), money(A['inventory'] + A['deposits_fees']),
            money(a["assets"]), money(a["equity"])] for a in annual]
hire_rows = [[html.escape(t), f"Month {s}" if s <= 12 else f"Year {(s-1)//12+1}, month {(s-1)%12+1}", money(sal), f"{f:g}"]
             for t, s, sal, f in HIRES]
use_rows = [["Leasehold build-out", money(A["build_out"])], ["Espresso, brewing and café equipment", money(A["equipment"])],
            ["12-kg drum roaster and ventilation", money(A["roaster"])], ["Opening inventory", money(A["inventory"])],
            ["Lease deposit, licences, permits", money(A["deposits_fees"])], ["Working capital", money(A["working_capital"])],
            ["<b>Total investment</b>", f"<b>{money(A['investment'])}</b>"]]

y5 = annual[-1]
html_doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>Sample E-2 Business Plan</title>
<style>
body{{font-family:Georgia,serif;max-width:820px;margin:40px auto;color:#1d1d1d;line-height:1.5;font-size:14px}}
h1{{font-size:26px;margin-bottom:4px}} h2{{font-size:18px;border-bottom:1px solid #999;margin-top:30px}}
table{{border-collapse:collapse;width:100%;margin:10px 0;font-size:12.5px}} th,td{{border:1px solid #bbb;padding:4px 6px;text-align:right}}
th:first-child,td:first-child{{text-align:left}} .note{{background:#f4f1ea;padding:10px;border-left:4px solid #8a6d3b;font-size:13px}}
.src{{font-size:12px;color:#444}}
</style></head><body>
<p class="note"><b>SAMPLE.</b> Fictional business and fictional investor, written to show the scope, structure and
financial depth of our E-2 plans. Market statistics are real and cited; every figure about the business itself is
stated as the investor's assumption. Not legal advice; the attorney of record decides how the plan is used.</p>
<h1>Ridgeline Coffee Roasters LLC</h1>
<p>E-2 Treaty Investor Business Plan · Asheville, North Carolina · Prepared for: Eleanor Whitcombe (United Kingdom national), Managing Member</p>

<h2>1. Executive summary</h2>
<p>Ridgeline Coffee Roasters LLC will open a 1,600 sq ft café with an on-site small-batch roastery in Asheville, Buncombe County, NC.
The investor, a UK national, has irrevocably committed <b>{money(A['investment'])}</b> of personal funds, of which
<b>{money(capex + A['inventory'] + A['deposits_fees'])}</b> is spent on build-out, equipment, inventory and deposits before opening,
and {money(A['working_capital'])} is held as working capital. The business has two revenue lines: café sales and wholesale
roasted coffee to local restaurants and offices from month {A['wholesale_start_month']}. Projected revenue grows from
{money(annual[0]['revenue'])} in Year 1 to {money(y5['revenue'])} in Year 5. The plan creates
<b>{y5['fte']:g} full-time-equivalent U.S. jobs by the end of Year 5</b>, with Year-5 payroll of {money(y5['payroll'])},
well beyond supporting the investor and her family.</p>

<h2>2. The investor and the investment</h2>
<p>Ownership: Eleanor Whitcombe holds 100% of the membership interest (≥50% required for E-2 treaty-nationality control).
Source of funds: proceeds of the sale of her UK residence and personal savings, documented separately by bank statements
and the completion statement (to be supplied by the client; the plan references them, it does not substitute for them).</p>
{table(["Use of funds", "Amount"], use_rows)}
<p>Investment at risk: build-out, equipment and the roaster are committed and largely non-recoverable before visa issuance,
which supports a finding that the investment is substantial and irrevocably committed. The attorney confirms the legal analysis.</p>

<h2>3. Market analysis</h2>
<p>Buncombe County had an estimated <b>{CENSUS['pop_2024']:,}</b> residents in 2024, up from {CENSUS['pop_2023']:,} in 2023
(<span class="src">U.S. Census Bureau, Population Estimates, Vintage 2024</span>). The county had
<b>{CENSUS['estab']} snack and non-alcoholic beverage bars</b> (NAICS 722515, which includes coffee shops), employing
{CENSUS['emp']:,} people with annual payroll of ${CENSUS['payroll_k']/1000:,.1f} million
(<span class="src">Census County Business Patterns 2023</span>): one such establishment per
{residents_per_estab:,.0f} residents, and average payroll of {money(pay_per_emp_local)} per employee against
{money(pay_per_emp_us)} for the same industry nationally ({CENSUS['us_estab']:,} establishments,
{CENSUS['us_emp']:,} employees; county-level sum, CBP 2023). The local industry pays above the national average, which
the hiring plan reflects. Tourism-driven demand, a dense independent-restaurant base for wholesale accounts, and
competition from established local roasters are discussed with the investor's site-specific evidence (foot-traffic counts and
letters of intent from wholesale prospects are listed in the exhibits the client supplies).</p>

<h2>4. Operations and competitive position</h2>
<p>Opening hours 6:30–18:00, 360 days a year. Positioning: single-origin and house-roasted espresso, roastery visible
from the counter, wholesale beans delivered weekly. Competitors are identified by name in a full plan with their
price points; this sample omits them because the business is fictional.</p>

<h2>4a. Marketing and sales plan</h2>
<p>Café: opening-week tasting events, a loyalty app, Google Business Profile and local listings, and seasonal menus timed to the
tourist calendar. Wholesale: the roaster/wholesale coordinator calls on independent restaurants, offices and inns, offering a
two-week free trial bag program; target {4} accounts by month 12 (investor's assumption, reflected in the wholesale revenue line).
Marketing budget: {money(A['marketing_m'])} a month.</p>

<h2>4b. SWOT and risks</h2>
{table(["", "Assessment"], [["Strengths", "House roasting gives margin control and a wholesale line competitors without roasters lack."],
 ["Weaknesses", "New brand; single site; investor's first U.S. venture."],
 ["Opportunities", "Wholesale to the county's independent restaurants; online bean subscriptions (not in the projections)."],
 ["Threats", "Established local roasters; seasonality of tourist traffic; green-coffee price swings."],
 ["Mitigation", f"Working capital of {money(A['working_capital'])} plus positive operating cash flow from Year 1; green coffee bought on 3-month contracts."]])}

<h2>4c. Management</h2>
<p>The investor will direct and develop the enterprise as Managing Member and General Manager. Her CV (to be supplied by the
client) is summarized here in a full plan, with the managerial experience relevant to running a food-service business.</p>

<h2>5. Hiring plan (U.S. workers)</h2>
{table(["Position", "Start", "Annual salary (Year-1 basis)", "FTE"], hire_rows)}
<p>Salaries are the investor's offer and rise {int(WAGE_GROWTH*100)}% a year. Hourly roles assume 2,080 hours for full-time
and 1,040 for part-time. Benchmark: local NAICS 722515 payroll averages {money(pay_per_emp_local)} per employee (mixed
full- and part-time; CBP 2023).</p>

<h2>6. Marginality analysis</h2>
<p>A business is marginal if it only supports the investor and family. Ridgeline employs {annual[0]['fte']:g} FTE at the end of
Year 1 and {y5['fte']:g} at the end of Year 5, with Year-5 payroll of {money(y5['payroll'])} and Year-5 net income of
{money(y5['ni'])}. Its capacity to generate income and U.S. employment substantially exceeds a minimal living for the investor.</p>

<h2>7. Financial projections</h2>
<h3>7.1 Profit and loss, Years 1–5</h3>
{table(["", "Revenue", "COGS", "Payroll + taxes", "Operating expenses", "EBITDA", "Depreciation", "Net income"], pl_rows)}
<h3>7.2 Year 1 by month</h3>
{table(["Month", "Café tx/day", "Café", "Wholesale", "Revenue", "Payroll + taxes", "EBITDA"], m_rows)}
<h3>7.3 Cash flow</h3>
{table(["", "Net income", "Add back depreciation", "Operating cash flow", "Year-end cash"], cf_rows)}
<h3>7.4 Balance sheet (simplified, year end)</h3>
{table(["", "Cash", "Net fixed assets", "Inventory + deposits", "Total assets", "Members' equity"], bs_rows)}
<h3>7.5 Break-even</h3>
<p>Year-1 fixed costs including payroll of {money(fixed_m + y1_pay_m)} a month and a café contribution margin of {contrib:.0%}
put break-even at about <b>{money(breakeven_rev_m)}</b> of monthly café revenue, about <b>{breakeven_tx:,.0f} transactions a day</b>
at a {money(A['ticket'])} average ticket.</p>
<h3>7.6 Key assumptions (investor's)</h3>
<p>Average ticket {money(A['ticket'])} rising 2.5% a year; café transactions ramp from {A['tx_start']} to {A['tx_y1_end']} a day in
Year 1, then grow {', '.join(f'{g:.0%}' for g in A['tx_growth'])}; café COGS {A['cogs_cafe']:.0%}, wholesale COGS
{A['cogs_wholesale']:.0%}; rent {money(A['rent_m'])} a month rising 3% a year; card fees {A['card_fees']:.1%}; employer payroll
taxes and benefits {A['payroll_tax']:.0%}. Full monthly model: financials.csv.</p>

<h2>8. Milestones</h2>
<p>Lease signed and LLC formed (before filing) · build-out complete, month 0 · opening, month 1 · first wholesale account,
month {A['wholesale_start_month']} · roaster hire, month 6 · assistant manager, month 16 · wholesale account manager, month 30.</p>
<h2>9. Exhibits supplied by the client (referenced, not reproduced)</h2>
<p>A. Lease or letter of intent · B. Articles of organization and operating agreement · C. Source-of-funds documents
(bank statements, sale completion statement, wire records) · D. Equipment quotes and build-out contract · E. Investor CV ·
F. Wholesale letters of intent · G. Licences and permits.</p>
<p class="src">Sources: U.S. Census Bureau, County Business Patterns 2023 (cbp23co, NAICS 722515);
U.S. Census Bureau, County Population Totals, Vintage 2024 (co-est2024-alldata). Both read 2026-11-26.</p>
</body></html>"""
open(os.path.join(HERE, "sample-plan.html"), "w").write(html_doc)
print(f"written; Y1 revenue {money(annual[0]['revenue'])}, Y5 revenue {money(y5['revenue'])}, Y5 FTE {y5['fte']:g}, "
      f"Y5 NI {money(y5['ni'])}, Y1 NI {money(annual[0]['ni'])}, break-even {breakeven_tx:.0f} tx/day, min cash "
      f"{money(min(a['cash_end'] for a in annual))}")
