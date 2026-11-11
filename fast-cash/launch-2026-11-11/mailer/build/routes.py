"""Turn the USPS EDDM route pulls + Census TIGERweb municipalities into routes-all.csv.

Inputs (read 2026-11-11, public endpoints, no login):
  data/usps-eddm-<ZIP>.json  https://gis.usps.com/arcgis/rest/services/EDDM/selectZIP/GPServer/routes/execute?f=json&ZIP=<ZIP>&Rte_Box=R&UserName=EDDM
  data/tiger-cousub.json     https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/1/query (PA, Cumberland 041 + York 133)

Each route's line is resampled every ~25 m and each sample is placed in a municipality
polygon; a route's homes are split across municipalities by that share (ESTIMATE: it
assumes homes are spread evenly along the carrier's line).
Run: python3 -I build/routes.py  (from the mailer directory)
"""
import csv, glob, json, math, os, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")


def merc_to_ll(x, y):
    lon = x / 6378137 * 180 / math.pi
    lat = (2 * math.atan(math.exp(y / 6378137)) - math.pi / 2) * 180 / math.pi
    return lon, lat


def pip(lon, lat, rings):
    inside = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi:
                inside = not inside
            j = i
    return inside


def load_munis():
    d = json.load(open(os.path.join(DATA, "tiger-cousub.json")))
    out = []
    for f in d["features"]:
        rings = f["geometry"]["rings"]
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        county = "Cumberland" if f["attributes"]["COUNTY"] == "041" else "York"
        out.append((f["attributes"]["NAME"], county, rings, (min(xs), min(ys), max(xs), max(ys))))
    return out


def muni_of(lon, lat, munis):
    for name, county, rings, (x0, y0, x1, y1) in munis:
        if x0 <= lon <= x1 and y0 <= lat <= y1 and pip(lon, lat, rings):
            return f"{name} ({county})"
    return "outside Cumberland/York"


def samples(paths, step=25.0):
    pts = []
    for path in paths:
        for (x0, y0), (x1, y1) in zip(path, path[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            k = max(1, int(seg / step))
            for t in range(k):
                pts.append((x0 + (x1 - x0) * t / k, y0 + (y1 - y0) * t / k))
    return pts


def main():
    munis = load_munis()
    rows = []
    geo = {}
    for fn in sorted(glob.glob(os.path.join(DATA, "usps-eddm-*.json"))):
        feats = json.load(open(fn))["results"][0]["value"]["features"]
        for f in feats:
            a = f["attributes"]
            pts = samples(f["geometry"]["paths"])
            share = {}
            for x, y in pts:
                lon, lat = merc_to_ll(x, y)
                m = muni_of(lon, lat, munis)
                share[m] = share.get(m, 0) + 1
            tot = sum(share.values()) or 1
            ranked = sorted(share.items(), key=lambda kv: -kv[1])
            ll = [merc_to_ll(x, y) for x, y in pts]
            clon = sum(p[0] for p in ll) / len(ll)
            clat = sum(p[1] for p in ll) / len(ll)
            rows.append({
                "zip_crid": a["ZIP_CRID"], "zip": a["ZIP_CODE"], "route": a["CRID_ID"],
                "type": {"C": "city", "R": "rural"}.get(a["TYPE"], a["TYPE"]),
                "post_office": a["FACILITY_NAME"], "residential": a["RES_CNT"],
                "business": a["BUS_CNT"], "total": int(a["TOT_CNT"]),
                "median_income": a["MED_INCOME"], "median_age": a["MED_AGE"],
                "avg_hh_size": round(a["AVG_HH_SIZ"], 2),
                "main_municipality": ranked[0][0],
                "municipality_split": "; ".join(f"{k} {round(100*v/tot)}%" for k, v in ranked if v / tot >= 0.05),
                "centroid_lat": round(clat, 5), "centroid_lon": round(clon, 5),
            })
            geo[a["ZIP_CRID"]] = {"paths": [[[round(c, 5) for c in merc_to_ll(*p)] for p in path] for path in f["geometry"]["paths"]],
                                  "split": {k: v / tot for k, v in ranked}}
    rows.sort(key=lambda r: r["zip_crid"])
    with open(os.path.join(HERE, "routes-all.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    json.dump(geo, open(os.path.join(DATA, "routes-geo.json"), "w"))
    print(len(rows), "routes written")


if __name__ == "__main__":
    main()
