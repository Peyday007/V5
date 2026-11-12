# Route plan: which homes get the card

Prepared 2026-11-11. **Source: real USPS carrier-route counts.** The USPS EDDM
tool's public map service answered without a login:
`https://gis.usps.com/arcgis/rest/services/EDDM/selectZIP/GPServer/routes/execute?f=json&ZIP=<zip>&Rte_Box=R&UserName=EDDM`
(read 2026-11-11; raw responses saved in `data/usps-eddm-*.json`). Each route
record carries its residential count (`RES_CNT`), business count, drop-off
post office and USPS's own demographic fields (median household income, median
age). Municipal boundaries come from Census TIGERweb (`data/tiger-cousub.json`).

**Recheck before paying postage.** In the EDDM online tool
(https://eddm.usps.com) select the same routes, choose **Residential only**, and
confirm the count. USPS updates counts, so expect the total to move by a few homes.
Re-run with `python3 -I build/routes.py && python3 -I build/select.py`.

## West Shore coverage, all routes (USPS, 2026-11-11)

| ZIP | Drop-off post office | Routes | Residential | Business |
|---|---|---|---|---|
| 17011 Camp Hill | CAMP HILL | 30 | 15,061 | 1,452 |
| 17025 Enola | CAMP HILL | 12 | 8,987 | 245 |
| 17043 Lemoyne / Wormleysburg | CAMP HILL | 6 | 3,087 | 561 |
| 17050 Mechanicsburg (Hampden / Silver Spring) | MECHANICSBURG | 29 | 18,434 | 1,124 |
| 17055 Mechanicsburg (borough / Upper & Lower Allen) | MECHANICSBURG | 31 | 19,400 | 957 |
| 17070 New Cumberland | NEW CUMBERLAND | 13 | 7,477 | 336 |

All 121 routes, with each route's municipal split, are in `routes-all.csv`.

## Decision

- **Zone 1, the first drop: Camp Hill & East Hampden (ZIP 17011).** 11 whole
  routes, **4,944 homes**, dropped at the Camp Hill Post Office.
- **Zone 2, the stretch: Hampden Township West (ZIP 17050).** 7 whole routes,
  **4,950 homes**, dropped at the Mechanicsburg Post Office.
- **Both zones: 9,894 homes.**

Why these routes:

1. **One ZIP per zone.** EDDM Retail allows "at least 200 and up to 5,000 pieces
   per day per ZIP Code" (https://www.usps.com/business/every-door-direct-mail.htm,
   read 2026-11-11). Each zone is a single drop at a single counter, and both
   zones can go on the same day because they are different ZIPs.
2. **4,950 homes or fewer per zone.** A 5,000-card print run then leaves at least
   50 spares for damaged cards.
3. **Coherent towns.** Prospects asked which towns the homes are in. Zone 1 is
   the routes that run at least 50% inside Camp Hill borough or Hampden Twp.
   Zone 2 is the routes that run at least 85% inside Hampden Twp. Within those
   limits, `build/select.py` picks the set with the most homes, and on a tie the
   set with the highest income. Camp Hill is the strongest local identity and
   home to most prospects on Market St, Trindle Rd and Simpson Ferry. Hampden
   joins it along the Carlisle Pike / Trindle corridor.
4. **Spending power.** The USPS median household income, weighted by homes, is
   **$109,386 for Zone 1** and **$112,979 for Zone 2**.

## Zone 1: Camp Hill & East Hampden (17011): 4,944 homes

| Route | Type | Homes | Businesses (not mailed) | Median HH income (USPS) | Median age | Where the route runs (estimate) |
|---|---|---|---|---|---|---|
| C002 | city | 439 | 7 | $95,879 | 42 | Camp Hill borough 100% |
| C003 | city | 544 | 3 | $137,041 | 48 | Camp Hill 38%; Hampden 37%; East Pennsboro 26% |
| C013 | city | 391 | 94 | $61,469 | 43 | Camp Hill 73%; Hampden 27% |
| C016 | city | 482 | 44 | $31,825 | 37 | Camp Hill 68%; Lemoyne 29% |
| C020 | city | 315 | 14 | $202,996 | 46 | Camp Hill 85%; East Pennsboro 15% |
| C023 | city | 558 | 1 | $137,041 | 48 | Hampden 64%; East Pennsboro 36% |
| C024 | city | 380 | 82 | $107,774 | 46 | Camp Hill 91%; East Pennsboro 9% |
| C028 | city | 501 | 77 | $121,716 | 46 | Hampden 100% |
| C032 | city | 421 | 61 | $62,661 | 47 | Hampden 97% |
| C037 | city | 472 | 29 | $103,422 | 42 | Camp Hill borough 100% |
| C039 | city | 441 | 79 | $152,483 | 46 | Camp Hill borough 100% |
| **Total** | | **4,944** | | | | |

**Homes by municipality (ESTIMATE).** Each route's homes are split by the share
of its line inside each boundary.

| Municipality | Homes | Share |
|---|---|---|
| Camp Hill borough | 2,804 | 57% |
| Hampden Township | 1,565 | 32% |
| East Pennsboro Township | 431 | 9% |
| Lemoyne borough | 140 | 3% |

## Zone 2: Hampden Township West (17050): 4,950 homes

| Route | Type | Homes | Businesses | Median HH income | Median age | Where |
|---|---|---|---|---|---|---|
| C005 | city | 792 | 12 | $129,903 | 39 | Hampden 100% |
| C006 | city | 831 | 187 | $61,469 | 43 | Hampden 95% |
| C015 | city | 630 | 0 | $115,563 | 40 | Hampden 100% |
| C022 | city | 755 | 115 | $129,903 | 39 | Hampden 100% |
| R014 | rural | 631 | 3 | $131,577 | 50 | Hampden 100% |
| R015 | rural | 683 | 1 | $102,876 | 42 | Hampden 100% |
| R018 | rural | 628 | 2 | $129,158 | 49 | Hampden 100% |
| **Total** | | **4,950** | | | | Hampden ≈ 99% (4,907), Mechanicsburg borough ≈ 41 |

## Map

`mockup/route-map.png` shows Zone 1 in red, Zone 2 in blue, the routes not
included in grey, and the municipal lines dashed. The same map is on the rate
card and attached to the first email. It answers the question an engaged
prospect asked in the owner's May 2026 campaign: *"I'd like to know the percent
of the 5000 homes that fall within our cities."*

## Caveats

- The municipal split is an estimate. It assumes a route's homes are spread
  evenly along its line. The route totals are USPS's own figures.
- The income and age figures are USPS's demographic fields, whose source is
  ACS. They describe the area, not every household.
- USPS sets no in-home delivery standard for EDDM.
