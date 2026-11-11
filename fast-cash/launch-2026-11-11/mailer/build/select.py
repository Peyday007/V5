"""Pick the carrier routes for Zone 1 (17011) and Zone 2 (17050) from routes-all.csv.

Rule (decided 2026-11-11):
  * one ZIP per zone, so each zone is one EDDM Retail drop at one post office,
    under USPS's 5,000-pieces-per-ZIP-per-day Retail limit;
  * residential count <= 4,950 so a 5,000-card print run leaves >= 50 spares;
  * Zone 1 = 17011 routes whose line is >= 50% inside Camp Hill borough or Hampden Twp;
    Zone 2 = 17050 routes whose line is >= 85% inside Hampden Twp;
  * among subsets meeting that, maximise homes, then median income (brute force).
Writes routes-zone1.csv, routes-zone2.csv and data/selection.json.
"""
import csv, itertools, json, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAP = 4950


def share(row, names):
    tot = 0
    for part in row["municipality_split"].split("; "):
        name, pct = part.rsplit(" ", 1)
        if any(name.startswith(n) for n in names):
            tot += int(pct.rstrip("%"))
    return tot


def best(cands):
    best_key, best_set = None, None
    for k in range(len(cands) + 1):
        for combo in itertools.combinations(cands, k):
            homes = sum(int(r["residential"]) for r in combo)
            if homes > CAP:
                continue
            inc = sum(int(r["median_income"]) * int(r["residential"]) for r in combo) / max(homes, 1)
            key = (homes, inc)
            if best_key is None or key > best_key:
                best_key, best_set = key, combo
    return sorted(best_set, key=lambda r: r["zip_crid"]), best_key


def main():
    rows = list(csv.DictReader(open(os.path.join(HERE, "routes-all.csv"))))
    z1c = [r for r in rows if r["zip"] == "17011" and share(r, ["Camp Hill", "Hampden"]) >= 50]
    z2c = [r for r in rows if r["zip"] == "17050" and share(r, ["Hampden"]) >= 85]
    out = {}
    for name, cands in (("zone1", z1c), ("zone2", z2c)):
        sel, (homes, inc) = best(cands)
        with open(os.path.join(HERE, f"routes-{name}.csv"), "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(sel)
        out[name] = {"routes": [r["zip_crid"] for r in sel], "homes": homes,
                     "weighted_median_income": round(inc), "candidates": len(cands)}
        print(name, len(cands), "candidates ->", len(sel), "routes", homes, "homes", round(inc))
    json.dump(out, open(os.path.join(HERE, "data", "selection.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
