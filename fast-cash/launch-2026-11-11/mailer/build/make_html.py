"""Generate the HTML sources for the mock-up, the route map and the rate card.

Reads routes-zone1.csv, routes-zone2.csv, data/routes-geo.json, data/tiger-cousub.json.
Writes build/html/*.html; build/render.cjs turns them into PNG + PDF under mockup/.
Run: python3 -I build/make_html.py  (from the mailer directory)
"""
import csv, html, json, math, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "build", "html")
os.makedirs(OUT, exist_ok=True)

# ---- decided offer (see RATE-CARD.md) -------------------------------------------------
CARD = "The Neighbor Card"
EDITION = "New Year 2027 Edition"
ZONE1_NAME = "Camp Hill & East Hampden"
ZONE2_NAME = "Hampden Township West"
PRICES = [  # name, size, cells, zone1 founding, both zones
    ("Standard spot", '2.8" × 2.33"', 1, 295, 495, 14),
    ("Double spot", '5.7" × 2.33"', 2, 525, 895, 2),
    ("Back Premium (beside the address)", '5.7" × 2.33"', 2, 575, 975, 1),
    ("Front Feature (top of the front)", '5.7" × 2.33"', 2, 625, 1050, 1),
]
SELL_BY = "Wed Dec 9, 2026, 5 pm"
THRESHOLD_CELLS = 10
DROP = "Mon Jan 4, 2027"
IN_HOME = "about Jan 5–12, 2027"

zones = {}
geo = json.load(open(os.path.join(HERE, "data", "routes-geo.json")))
for z in ("zone1", "zone2"):
    rows = list(csv.DictReader(open(os.path.join(HERE, f"routes-{z}.csv"))))
    munis = {}
    for r in rows:
        for k, v in geo[r["zip_crid"]]["split"].items():
            munis[k] = munis.get(k, 0) + int(r["residential"]) * v
    zones[z] = {"rows": rows, "homes": sum(int(r["residential"]) for r in rows),
                "munis": sorted(((k, round(v)) for k, v in munis.items() if round(v) >= 1), key=lambda kv: -kv[1])}
Z1 = zones["zone1"]["homes"]
Z2 = zones["zone2"]["homes"]

FONT = "font-family: Inter, 'DejaVu Sans', sans-serif;"
NAVY, GOLD, INK, PAPER = "#13294b", "#e0a526", "#1b1f24", "#fffdf8"


def esc(s):
    return html.escape(str(s))


# ---- the card ---------------------------------------------------------------------------
TINTS = ["#e8f1fb", "#fdf1e0", "#e9f6ee", "#f6e9f3", "#eef0f3", "#fff6d6", "#e6f4f6", "#f9e8e6"]


def ad(label, category, size_note, tint, big=False, sample=None):
    sample = sample or ["Your offer, in big type", "Logo · phone · website"]
    return f"""
<div class="ad {'big' if big else ''}" style="background:{tint}">
  <div class="tag">{esc(label)} · {esc(size_note)}</div>
  <div class="yah">YOUR AD HERE</div>
  <div class="cat">– {esc(category)} –</div>
  <div class="lines">{''.join(f'<div>{esc(s)}</div>' for s in sample)}</div>
  <div class="sample">SAMPLE · placeholder, not a real business</div>
</div>"""


CARD_CSS = f"""
@page {{ size: 12.25in 9.25in; margin: 0 }}
* {{ box-sizing: border-box; margin: 0; padding: 0 }}
html, body {{ width: 12.25in; height: 9.25in; background: {PAPER}; {FONT} color: {INK} }}
.sheet {{ position: relative; width: 12.25in; height: 9.25in; overflow: hidden; background: {PAPER} }}
.safe {{ position: absolute; left: 0.375in; top: 0.375in; width: 11.5in; height: 8.5in;
        display: grid; grid-template-columns: repeat(4, 2.8in); column-gap: 0.1in;
        grid-template-rows: 1.2in repeat(3, 2.333in); row-gap: 0.1in }}
.back .safe {{ grid-template-rows: repeat(3, 2.333in) 1.2in }}
.bleedband {{ position: absolute; left: 0; right: 0; height: 1.575in; background: {NAVY} }}
.mast {{ grid-column: 1 / 5; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 0.1in }}
.mast h1 {{ font-size: 40pt; font-weight: 800; letter-spacing: -0.5pt; line-height: 1 }}
.mast h1 span {{ color: {GOLD} }}
.mast .sub {{ font-size: 13pt; font-weight: 600; margin-top: 4pt; color: #dfe7f3 }}
.mast .right {{ text-align: right; font-size: 11.5pt; line-height: 1.35; color: #dfe7f3 }}
.mast .right b {{ color: {GOLD}; font-size: 15pt }}
.ad {{ border: 2.5pt dashed #8a96a8; border-radius: 8pt; padding: 0.12in 0.14in; position: relative; overflow: hidden;
      display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center }}
.ad.span2 {{ grid-column: span 2 }}
.ad .tag {{ position: absolute; top: 0.07in; left: 0.1in; font-size: 7.5pt; font-weight: 700; color: #4a5568; letter-spacing: 0.3pt; text-transform: uppercase }}
.ad .yah {{ font-size: 20pt; font-weight: 800; color: {NAVY}; letter-spacing: 0.5pt; margin-top: 0.12in }}
.ad.big .yah {{ font-size: 30pt }}
.ad .cat {{ font-size: 14pt; font-weight: 700; color: #b5651d; margin-top: 2pt }}
.ad.big .cat {{ font-size: 18pt }}
.ad .lines {{ margin-top: 6pt; font-size: 9pt; color: #5a6472; line-height: 1.35 }}
.ad.big .lines {{ font-size: 11pt }}
.ad .sample {{ position: absolute; bottom: 0.06in; font-size: 6pt; color: #8a96a8; letter-spacing: 0.4pt }}
.mail {{ grid-column: 3 / 5; border: 1pt solid #c7ced8; border-radius: 6pt; background: #fff; position: relative; padding: 0.14in 0.18in }}
.mail .from {{ font-size: 7.5pt; color: #4a5568; line-height: 1.35; width: 3.0in }}
.indicia {{ position: absolute; top: 0.14in; right: 0.18in; width: 1.05in; border: 1.2pt solid #000; padding: 4pt 2pt;
            text-align: center; font-size: 8pt; font-weight: 700; line-height: 1.3; color: #000; letter-spacing: 0.2pt }}
.addr {{ position: absolute; left: 2.2in; top: 1.32in; font-size: 11pt; font-weight: 700; letter-spacing: 0.6pt; color: #000 }}
.clear {{ position: absolute; left: 0.18in; bottom: 0.1in; font-size: 6.5pt; color: #9aa3af }}
.foot {{ grid-column: 1 / 5; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 0.1in }}
.foot .l {{ font-size: 18pt; font-weight: 800; line-height: 1.15 }}
.foot .l span {{ color: {GOLD} }}
.foot .r {{ text-align: right; font-size: 10pt; line-height: 1.45; color: #dfe7f3 }}
.foot .r b {{ color: #fff }}
.legal {{ position: absolute; left: 0.375in; bottom: 0.2in; font-size: 6.5pt; color: #c9d3e1 }}
.mock {{ position: absolute; right: 0.4in; bottom: 0.2in; font-size: 7pt; color: #c9d3e1; letter-spacing: 0.5pt }}
"""


def front():
    a = [
        ad("Front Feature", "Dentist", '5.7" × 2.33"', TINTS[0], big=True,
           sample=["New-patient exam + cleaning: $XX", "Benefits just reset — book in January", "Logo · (717) 555-0100 · yoursite.com"]),
        ad("Standard", "Pizza", '2.8" × 2.33"', TINTS[1]),
        ad("Standard", "Salon", '2.8" × 2.33"', TINTS[2]),
        ad("Standard", "Gym / Fitness", '2.8" × 2.33"', TINTS[3]),
        ad("Standard", "Auto Repair", '2.8" × 2.33"', TINTS[4]),
        ad("Double", "Heating & Cooling", '5.7" × 2.33"', TINTS[5], big=True,
           sample=["January furnace tune-up: $XX", "No-heat emergency line", "Logo · (717) 555-0100 · yoursite.com"]),
        ad("Standard", "Chiropractor", '2.8" × 2.33"', TINTS[6]),
        ad("Standard", "Car Wash", '2.8" × 2.33"', TINTS[7]),
        ad("Standard", "Spa", '2.8" × 2.33"', TINTS[0]),
        ad("Standard", "Restaurant", '2.8" × 2.33"', TINTS[1]),
    ]
    a[0] = a[0].replace('class="ad big"', 'class="ad big span2"')
    a[5] = a[5].replace('class="ad big"', 'class="ad big span2"')
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Card front</title><style>{CARD_CSS}</style></head>
<body><div class="sheet front"><div class="bleedband" style="top:0"></div><div class="safe">
<div class="mast"><div><h1>The <span>Neighbor</span> Card</h1>
<div class="sub">{ZONE1_NAME} · {EDITION}</div></div>
<div class="right">Local offers from businesses down the street.<br><b>{Z1:,} homes</b> in Camp Hill &amp; Hampden Twp<br>Keep it on the fridge — offers as stated in each ad</div></div>
{''.join(a)}
</div><div class="mock">SAMPLE LAYOUT · MOCK-UP FOR ADVERTISERS</div></div></body></html>"""


def back():
    a1 = ad("Back Premium", "Real Estate", '5.7" × 2.33"', TINTS[2], big=True,
            sample=["Thinking of selling this spring?", "Free home value report", "Logo · (717) 555-0100 · yoursite.com"]).replace('class="ad big"', 'class="ad big span2"')
    std = [("Insurance", 3), ("Plumbing", 4), ("Eye Care", 5), ("Dry Cleaning", 6), ("Physical Therapy", 7), ("Coffee & Bakery", 0)]
    s = [ad("Standard", c, '2.8" × 2.33"', TINTS[t]) for c, t in std]
    d2 = ad("Double", "Orthodontist", '5.7" × 2.33"', TINTS[1], big=True,
            sample=["Free braces & aligner consult", "Start the new year smiling", "Logo · (717) 555-0100 · yoursite.com"]).replace('class="ad big"', 'class="ad big span2"')
    mail = f"""<div class="mail">
  <div class="from"><b>{CARD}</b><br>[Owner's legal name]<br>[Owner's mailing address]<br>[Town], PA [ZIP]</div>
  <div class="indicia">PRSRT STD<br>ECRWSS<br>U.S. POSTAGE<br>PAID<br>EDDM RETAIL</div>
  <div class="addr">POSTAL CUSTOMER</div>
  <div class="clear">USPS area: EDDM Retail indicia above and to the right of the address; no ads in this panel.</div>
</div>"""
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Card back</title><style>{CARD_CSS}</style></head>
<body><div class="sheet back"><div class="bleedband" style="bottom:0"></div><div class="safe">
{a1}{mail}{''.join(s[:4])}{''.join(s[4:])}{d2}
<div class="foot"><div class="l">Advertise to <span>{Z1:,} homes</span><br>in Camp Hill &amp; Hampden</div>
<div class="r">One business per category · ad design included<br><b>[Owner phone] · [owner email]</b><br>Next edition: February 2027</div></div>
</div>
<div class="legal">Each advertiser is responsible for the accuracy and lawfulness of its own ad. Mailed by [Owner's legal name], [Town], PA.</div>
</div></body></html>"""


# ---- the route map ---------------------------------------------------------------------
def route_map_svg(width_px=1400, height_px=900, zones_to_show=("zone1", "zone2")):
    sel = {r["zip_crid"]: z for z in zones_to_show for r in zones[z]["rows"]}
    pts = [p for k in sel for path in geo[k]["paths"] for p in path]
    lon0, lon1 = min(p[0] for p in pts), max(p[0] for p in pts)
    lat0, lat1 = min(p[1] for p in pts), max(p[1] for p in pts)
    padx, pady = (lon1 - lon0) * 0.08, (lat1 - lat0) * 0.12
    lon0, lon1, lat0, lat1 = lon0 - padx, lon1 + padx, lat0 - pady, lat1 + pady
    k = math.cos(math.radians((lat0 + lat1) / 2))
    sx = width_px / ((lon1 - lon0) * k)
    sy = height_px / (lat1 - lat0)
    s = min(sx, sy)
    w, h = (lon1 - lon0) * k * s, (lat1 - lat0) * s

    def xy(lon, lat):
        return ((lon - lon0) * k * s, (lat1 - lat) * s)

    out = []
    tiger = json.load(open(os.path.join(HERE, "data", "tiger-cousub.json")))
    labels = []
    for f in tiger["features"]:
        rings = f["geometry"]["rings"]
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        if max(xs) < lon0 or min(xs) > lon1 or max(ys) < lat0 or min(ys) > lat1:
            continue
        d = " ".join("M" + " L".join(f"{xy(*p)[0]:.1f},{xy(*p)[1]:.1f}" for p in r) + " Z" for r in rings)
        out.append(f'<path d="{d}" fill="#f4f1ea" stroke="#9aa3af" stroke-width="1.6" stroke-dasharray="6 4"/>')
        big = max(rings, key=len)
        cx = sum(p[0] for p in big) / len(big)
        cy = sum(p[1] for p in big) / len(big)
        labels.append((f["attributes"]["NAME"].replace(" township", " Twp").replace(" borough", ""), cx, cy))
    for key, g in geo.items():
        if key in sel:
            continue
        for path in g["paths"]:
            d = "M" + " L".join(f"{xy(*p)[0]:.1f},{xy(*p)[1]:.1f}" for p in path)
            out.append(f'<path d="{d}" fill="none" stroke="#cfd5dd" stroke-width="1.2"/>')
    colors = {"zone1": "#c0392b", "zone2": "#1f6fb2"}
    for key, z in sel.items():
        for path in geo[key]["paths"]:
            d = "M" + " L".join(f"{xy(*p)[0]:.1f},{xy(*p)[1]:.1f}" for p in path)
            out.append(f'<path d="{d}" fill="none" stroke="{colors[z]}" stroke-width="2.4" stroke-linejoin="round"/>')
    for name, cx, cy in labels:
        x, y = xy(cx, cy)
        if 30 < x < w - 30 and 20 < y < h - 20:
            out.append(f'<text x="{x:.0f}" y="{y:.0f}" text-anchor="middle" font-size="22" font-weight="800" fill="#13294b" '
                       f'stroke="#fffdf8" stroke-width="5" paint-order="stroke">{esc(name)}</text>')
    legend = (f'<g transform="translate(14,{h-88:.0f})"><rect width="700" height="74" rx="8" fill="#fff" stroke="#c7ced8"/>'
              f'<line x1="14" y1="24" x2="54" y2="24" stroke="#c0392b" stroke-width="5"/><text x="64" y="30" font-size="20" fill="#1b1f24">Zone 1 · {ZONE1_NAME} (17011) · {Z1:,} homes</text>'
              f'<line x1="14" y1="54" x2="54" y2="54" stroke="#1f6fb2" stroke-width="5"/><text x="64" y="60" font-size="20" fill="#1b1f24">Zone 2 · {ZONE2_NAME} (17050) · {Z2:,} homes</text></g>')
    src = (f'<rect x="0" y="0" width="{w:.0f}" height="24" fill="#fffdf8" opacity="0.85"/><text x="10" y="17" font-size="14" fill="#6b7280">Lines: USPS EDDM carrier routes (gis.usps.com, read 2026-11-11). '
           f'Dashed: municipal boundaries (Census TIGERweb). Grey lines: routes not included.</text>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}" style="{FONT}">'
            f'<rect width="100%" height="100%" fill="#fffdf8"/>{"".join(out)}{legend}{src}</svg>'), w, h


def route_map_html():
    svg, w, h = route_map_svg()
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>Route map</title><style>*{{margin:0}}body{{background:#fffdf8}}</style></head>'
            f'<body>{svg}</body></html>'), w, h


# ---- rate card ---------------------------------------------------------------------------
def muni_table(z):
    tot = zones[z]["homes"]
    return "".join(f"<tr><td>{esc(n.replace(' (Cumberland)', '').replace(' (York)', ''))}</td><td class=n>{v:,}</td><td class=n>{100*v/tot:.0f}%</td></tr>"
                   for n, v in zones[z]["munis"] if v / tot >= 0.005)


def route_list(z):
    return ", ".join(f"{r['route']} ({int(r['residential']):,})" for r in zones[z]["rows"])


def rate_card():
    rows = "".join(f"<tr><td><b>{esc(n)}</b></td><td class=nw>{esc(sz)}</td><td class=n>{c}</td><td class=n><b>${p1:,}</b></td><td class=n>${p2:,}</td><td class=n>{q}</td></tr>"
                   for n, sz, c, p1, p2, q in PRICES)
    css = f"""
@page {{ size: Letter; margin: 0.4in 0.45in }}
* {{ box-sizing: border-box }}
body {{ {FONT} color: {INK}; font-size: 8.6pt; line-height: 1.32; margin: 0; background: #fff }}
h1 {{ font-size: 21pt; margin: 0; color: {NAVY}; letter-spacing: -0.3pt }}
h1 span {{ color: {GOLD} }}
h2 {{ font-size: 10.5pt; margin: 9pt 0 3pt; color: {NAVY}; text-transform: uppercase; letter-spacing: 0.6pt }}
.lead {{ font-size: 10pt; margin: 3pt 0 0 }}
table {{ border-collapse: collapse; width: 100% }}
td, th {{ padding: 2.2pt 4pt; border-bottom: 0.6pt solid #d9dee5; text-align: left; vertical-align: top }}
th {{ font-size: 7.8pt; color: #4a5568; text-transform: uppercase; letter-spacing: 0.3pt }}
.n {{ text-align: right; white-space: nowrap }}
.nw {{ white-space: nowrap }}
.cols {{ display: grid; grid-template-columns: 1fr 1fr; column-gap: 0.25in }}
.imgs {{ display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 6pt; margin-top: 4pt }}
.imgs img {{ width: 100%; border: 0.6pt solid #c7ced8; display: block }}
.map {{ width: 100%; border: 0.6pt solid #c7ced8 }}
.box {{ background: #f4f6fa; border-left: 3pt solid {GOLD}; padding: 5pt 7pt; margin-top: 6pt }}
.small {{ font-size: 7.4pt; color: #4a5568 }}
ol {{ margin: 2pt 0 0 14pt; padding: 0 }}
"""
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Rate card</title><style>{css}</style></head><body>
<h1>The <span>Neighbor</span> Card — Founding Advertiser rate card</h1>
<div class="lead">A shared 9" × 12" postcard mailed by USPS Every Door Direct Mail to <b>{Z1:,} homes</b> in Camp Hill &amp; East Hampden (ZIP 17011).
{EDITION}: mails <b>{DROP}</b>, in homes {IN_HOME}. One business per category. Ad design included.</div>
<div class="cols">
<div>
<h2>Where the {Z1:,} homes are</h2>
<img class="map" src="../../mockup/route-map.png">
</div>
<div>
<h2>The card (front · back)</h2>
<div class="imgs"><img src="../../mockup/card-front-preview.jpg"><img src="../../mockup/card-back-preview.jpg"></div>
<div class="small">Shown with placeholder spaces. 18 ad spaces: 14 standard, 2 double, 1 Back Premium, 1 Front Feature. 14 pt gloss, full colour both sides.</div>
<table style="margin-top:4pt"><tr><th>Zone 1 municipality (estimate)</th><th class=n>Homes</th><th class=n>Share</th></tr>{muni_table('zone1')}
<tr><td><b>Total: 11 whole carrier routes (USPS)</b></td><td class=n><b>{Z1:,}</b></td><td class=n>100%</td></tr></table>
</div></div>
<div class="small" style="margin-top:3pt">Routes (ZIP 17011, homes): {route_list('zone1')}. Homes = USPS residential count per route (USPS EDDM map service, read 2026-11-11); businesses are not mailed. Municipal split = share of each route inside each boundary (Census TIGERweb), an estimate.
Optional Zone 2, {ZONE2_NAME} (ZIP 17050, blue): {Z2:,} homes, {zones['zone2']['munis'][0][1]*100//Z2}% Hampden Twp.</div>
<h2>Prices — Founding Advertiser, first edition</h2>
<table><tr><th>Space</th><th>Size</th><th class=n>Cells</th><th class=n>Zone 1 ({Z1:,} homes)</th><th class=n>Both zones ({Z1+Z2:,} homes)</th><th class=n>Spaces on card</th></tr>{rows}</table>
<div class="small">A Zone 1 standard spot is about {PRICES[0][3]/Z1*100:.0f}¢ a home. Ad design included. Founding price held for your next two editions if you renew by each sell-by date. No sales tax charged (advertising space on USPS direct mail).</div>
<div class="cols">
<div>
<div class="box"><b>No risk to you.</b> The card prints only if at least <b>{THRESHOLD_CELLS} of the 22 ad cells are paid by {SELL_BY} ET</b>.
If not, every advertiser gets a full refund within 2 business days (by Fri Dec 11). One business per category, locked in the order spaces are <i>paid</i>.</div>
<h2>To reserve</h2>
<ol><li>Reply with your business name and category, or call [owner phone].</li>
<li>Pay the secure Stripe link we send (card or bank account).</li>
<li>Send your logo, offer and contact details; approve your proof.</li></ol>
<div class="small" style="margin-top:5pt">[Owner's legal name] · [mailing address], PA · [phone] · [email]. Full terms: Advertiser Agreement.</div>
</div>
<div>
<h2>Dates</h2>
<table>
<tr><td>Now – {SELL_BY}</td><td>Reserve and pay; send logo, offer, phone</td></tr>
<tr><td>Within 1 business day</td><td>Proof sent; approve or request one change</td></tr>
<tr><td>Thu Dec 10, noon</td><td>Last proof approvals</td></tr>
<tr><td>Fri Dec 11</td><td>Print order placed (or refunds sent)</td></tr>
<tr><td>{DROP}</td><td>Handed to the Camp Hill Post Office</td></tr>
<tr><td>{IN_HOME}</td><td>In homes (estimate; USPS sets no standard)</td></tr>
</table>
</div></div></body></html>"""


def main():
    open(os.path.join(OUT, "card-front.html"), "w").write(front())
    open(os.path.join(OUT, "card-back.html"), "w").write(back())
    m, w, h = route_map_html()
    open(os.path.join(OUT, "route-map.html"), "w").write(m)
    json.dump({"map_w": round(w), "map_h": round(h)}, open(os.path.join(OUT, "sizes.json"), "w"))
    open(os.path.join(OUT, "rate-card.html"), "w").write(rate_card())
    print("html written", Z1, Z2, round(w), round(h))


if __name__ == "__main__":
    main()
