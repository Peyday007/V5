"""Build prospects.csv: West Shore local businesses with PUBLISHED contact details.

Sources (all public pages, read 2026-11-11):
  * data/chamber*.json  - Mechanicsburg Chamber of Commerce public member directory
    (https://business.mechanicsburgchamber.org/list/...), one member page per row
    (data/member-extra.json holds the website each member page links to).
  * fast-cash/10k/buyers-gift-boxes.csv - Brain's 2026-11-02 list (published contacts, own source URLs).
Only categories that buy co-op mail in January are kept (decided list below).
Run: python3 -I build/prospects.py  (from the mailer directory)
"""
import csv, json, os, string

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
D = os.path.join(HERE, "data")

# member-page slug -> (card category, January angle, priority 1=call first)
PICK = {
    "carlisle-pike-family-dentistry-1073": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "fields-family-dentistry-1072": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "east-main-dental-1049": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "dental-health-of-silver-spring-113": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "rother-dental-1025": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "smiles-on-trindle-dental-care-486": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "craig-m-anzur-dmd-anzur-periodontics-p-c-939": ("Dental specialist", "Gum-health consult offer", 2),
    "metro-hvac-1249": ("HVAC", "January furnace check / no-heat call", 1),
    "daflure-heating-cooling-661": ("HVAC", "January furnace check / no-heat call", 1),
    "buchanan-erb-inc-226": ("HVAC", "January furnace check / no-heat call", 1),
    "zimmerman-plumbing-heating-air-conditioning-438": ("HVAC", "January furnace check / no-heat call", 1),
    "pronto-plumbing-342": ("Plumbing", "Frozen-pipe / water-heater season", 1),
    "hb-home-service-team-1213": ("HVAC", "January furnace check / no-heat call", 2),
    "haller-enterprises-716": ("HVAC", "January furnace check / no-heat call", 2),
    "crawlspace-medic-of-harrisburg-1312": ("Home services", "Winter moisture / crawlspace inspection", 2),
    "a-b-automotive-mechanicsburg-915": ("Auto repair", "Winter service / battery & tire check", 1),
    "clay-s-service-center-inc-82": ("Auto repair", "Winter service / battery & tire check", 1),
    "zimmerman-s-automotive-tire-pros-439": ("Tires", "Winter tires / alignment", 1),
    "major-s-select-collision-center-724": ("Collision", "Winter fender-bender season", 2),
    "autobodies-by-lucas-select-collision-group-722": ("Collision", "Winter fender-bender season", 2),
    "mermaid-car-wash-1231": ("Car wash", "Road-salt wash plan", 1),
    "modwash-1138": ("Car wash", "Road-salt wash plan", 1),
    "snappers-bar-grill-353": ("Restaurant", "January dine-in / take-out offer", 2),
    "arooga-s-grille-house-sports-bar-597": ("Restaurant", "Playoff-season take-out / party trays", 1),
    "isaac-s-craft-kitchen-brewery-507": ("Restaurant", "January dine-in / take-out offer", 2),
    "visaggio-s-ristorante-1285": ("Restaurant", "January dine-in / take-out offer", 2),
    "flinchy-s-998": ("Restaurant", "Playoff-season take-out / party trays", 1),
    "sophia-s-at-walden-740": ("Restaurant", "January dine-in / take-out offer", 2),
    "denim-coffee-company-1235": ("Coffee", "Loyalty / free-drink offer", 2),
    "eckels-ice-cream-fountain-795": ("Dessert", "Gift-card / birthday offer", 3),
    "luna-italian-cuisine-1286": ("Restaurant", "January dine-in / take-out offer", 2),
    "revolutionary-hot-sauce-eatery-brewpub-1211": ("Restaurant", "January dine-in / take-out offer", 2),
    "wolf-brewing-co-1173": ("Brewery", "January events", 3),
    "amici-pizza-1275": ("Pizza", "Playoff-season pizza deal", 1),
    "dalicia-ristorante-bakery-1150": ("Restaurant", "January dine-in / take-out offer", 2),
    "kanagawa-1088": ("Restaurant", "January dine-in / take-out offer", 2),
    "marzoni-s-brick-oven-brewing-co-1066": ("Restaurant", "January dine-in / take-out offer", 2),
    "spice-restaurant-bar-1205": ("Restaurant", "January dine-in / take-out offer", 2),
    "jojo-s-pizza-pasta-208": ("Pizza", "Playoff-season pizza deal", 1),
    "dough-n-joe-1243": ("Bakery/cafe", "Loyalty offer", 3),
    "7-brew-drive-thru-coffee-1264": ("Coffee", "Loyalty / free-drink offer", 3),
    "texas-roadhouse-504": ("Restaurant", "January dine-in / take-out offer", 3),
    "rich-valley-golf-512": ("Recreation", "Spring membership pre-sale", 3),
    "the-craft-barber-co-1156": ("Barber", "New-client cut offer", 2),
    "hair-counselors-llc-1133": ("Salon", "New-client offer", 1),
    "waxed-worth-it-1294": ("Salon/waxing", "New-client offer", 2),
    "vraie-wellnes-spa-1037": ("Spa", "January self-care / gift-card redemption", 1),
    "revelations-day-spa-1116": ("Spa", "January self-care / gift-card redemption", 1),
    "rubai-aesthetics-and-wellness-clinic-1284": ("Med spa", "New-year aesthetics offer", 1),
    "glo-skin-care-993": ("Skin care", "New-year skin offer", 2),
    "be-balanced-1052": ("Wellness", "New-year wellness offer", 3),
    "ark-fitness-1169": ("Gym", "New-year membership", 1),
    "blitz-45-1117": ("Gym", "New-year membership", 1),
    "orangetheory-fitness-1268": ("Gym", "New-year membership", 1),
    "h2l-studio-llc-860": ("Fitness studio", "New-year membership", 2),
    "itten-dojo-inc-1291": ("Martial arts", "Kids' winter session", 2),
    "chase-fitness-pt-llc-1254": ("Personal training", "New-year training offer", 2),
    "sky-zone-harrisburg-856": ("Family fun", "Winter-break / birthday parties", 2),
    "camp-hill-family-chiropractic-65": ("Chiropractor", "New-patient exam offer", 1),
    "cornerstone-chiropractic-llc-1114": ("Chiropractor", "New-patient exam offer", 1),
    "herd-chiropractic-clinic-475": ("Chiropractor", "New-patient exam offer", 1),
    "acri-family-chiropractic-clinic-mechanicsburg-465": ("Chiropractor", "New-patient exam offer", 1),
    "baker-chiropractic-sport-and-spine-center-1168": ("Chiropractor", "New-patient exam offer", 1),
    "advanced-physical-therapy-and-fitness-14": ("Physical therapy", "Free screen offer", 2),
    "gilbert-physical-therapy-805": ("Physical therapy", "Free screen offer", 2),
    "pivot-physical-therapy-1076": ("Physical therapy", "Free screen offer", 3),
    "weiss-physical-therapy-associates-pc-422": ("Physical therapy", "Free screen offer", 2),
    "mechanicsburg-eye-associates-254": ("Eye care", "New-year benefits reset: eye exam", 1),
    "silver-spring-foot-and-ankle-1229": ("Podiatry", "New-patient offer", 3),
    "afc-urgent-care-camp-hill-1270": ("Urgent care", "Flu season walk-in", 2),
    "home-instead-184": ("Senior home care", "Adult children planning care", 2),
    "senior-helpers-345": ("Senior home care", "Adult children planning care", 2),
    "assisting-hands-1271": ("Senior home care", "Adult children planning care", 2),
    "caring-transitions-of-mechanicsburg-mechanicsburg-843": ("Downsizing/estate", "New-year downsizing", 2),
    "lawyers-realty-llc-682": ("Real estate", "Spring-market listing appointment", 1),
    "m-c-walker-realty-234": ("Real estate", "Spring-market listing appointment", 1),
    "karen-trynoski-next-home-capital-realty-478": ("Real estate", "Spring-market listing appointment", 1),
    "sonnie-minick-coldwell-banker-1266": ("Real estate", "Spring-market listing appointment", 2),
    "valerie-nash-coldwell-banker-1265": ("Real estate", "Spring-market listing appointment", 2),
    "beth-williamson-coldwell-banker-48": ("Real estate", "Spring-market listing appointment", 2),
    "carrie-seymore-coldwell-banker-realty-1192": ("Real estate", "Spring-market listing appointment", 2),
    "tide-cleaners-1262": ("Dry cleaning", "New-customer offer", 2),
    "classic-drycleaners-and-laundromats-81": ("Dry cleaning", "New-customer offer", 2),
    "weed-man-lawn-care-970": ("Lawn care", "Spring program pre-sign-up", 2),
    "red-rock-landscape-774": ("Landscaping", "Spring design booking", 3),
    "grassroots-landscaping-168": ("Landscaping", "Spring design booking", 3),
    "the-learning-experience-mechanicsburg-1279": ("Child care", "Winter enrollment", 2),
    "mechanicsburg-learning-center-1070": ("Tutoring/learning", "Second-semester help", 2),
}

GIFT_CATS = {  # buyers-gift-boxes.csv category -> card category, angle, priority
    "Dental practice": ("Dentist", "New-year benefits reset; new-patient exam offer", 1),
    "Orthodontic practice": ("Orthodontist", "Free consult; new-year start", 1),
    "HVAC/plumbing": ("HVAC", "January furnace check / no-heat call", 1),
    "HVAC": ("HVAC", "January furnace check / no-heat call", 1),
    "Roofing": ("Roofing", "Winter storm inspection", 2),
    "Real estate brokerage": ("Real estate", "Spring-market listing appointment", 2),
    "Independent insurance agency": ("Insurance", "New-year policy review", 2),
}


def town(city):
    return string.capwords(city.lower()).replace("Enonla", "Enola").replace("Mechanisburg", "Mechanicsburg")


def main():
    listings = json.load(open(os.path.join(D, "chamber.json"))) + json.load(open(os.path.join(D, "chamber-ql.json")))
    extra = json.load(open(os.path.join(D, "member-extra.json")))
    rows, seen = [], set()
    for x in listings:
        slug = x["member"].rsplit("/", 1)[-1]
        if slug not in PICK or slug in seen:
            continue
        seen.add(slug)
        cat, angle, pri = PICK[slug]
        ex = extra.get(slug, {})
        contact = (ex.get("mail") or ex.get("web") or [""])[0]
        rows.append({
            "name": string.capwords(x["name"].lower()) if x["name"].isupper() else x["name"], "category": cat,
            "town": town(x["city"]), "address": f'{string.capwords(x["addr"].lower())}, {town(x["city"])}, PA {x["zip"]}',
            "phone": x["phone"], "website_or_email": contact, "priority": pri, "january_angle": angle,
            "source_url": x["member"], "source": "Mechanicsburg Chamber public directory, read 2026-11-11",
        })
    names = {r["name"].lower() for r in rows}
    gift = os.path.join(REPO, "fast-cash", "10k", "buyers-gift-boxes.csv")
    insurance = 0
    for g in csv.DictReader(open(gift)):
        if g["category"] not in GIFT_CATS:
            continue
        if g["name"].lower() in names or "smiles on trindle" in g["name"].lower() or "zimmerman plumbing" in g["name"].lower():
            continue
        if g["category"] == "Independent insurance agency":
            insurance += 1
            if insurance > 8:
                continue
        if not (g["phone"] or g["email_or_contact_url"]):
            continue
        cat, angle, pri = GIFT_CATS[g["category"]]
        rows.append({
            "name": g["name"], "category": cat, "town": g["town"], "address": g["address"],
            "phone": g["phone"], "website_or_email": g["email_or_contact_url"], "priority": pri,
            "january_angle": angle, "source_url": g["source_url"],
            "source": "fast-cash/10k/buyers-gift-boxes.csv (Brain, 2026-11-02)",
        })
    rows.sort(key=lambda r: (r["priority"], r["category"], r["name"]))
    for i, r in enumerate(rows, 1):
        r["id"] = f"P{i:03d}"
    fields = ["id", "name", "category", "town", "address", "phone", "website_or_email", "priority",
              "january_angle", "source_url", "source", "status", "contacted_on", "outcome", "paid_amount"]
    with open(os.path.join(HERE, "prospects.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            r.setdefault("status", "not contacted")
            w.writerow(r)
    from collections import Counter
    print(len(rows), Counter(r["category"] for r in rows).most_common())


if __name__ == "__main__":
    main()
