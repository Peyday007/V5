"""Recent federal contract awards from the USAspending API (no key), cached on disk for a day."""
import hashlib, json, os, ssl, time, urllib.request
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.dirname(HERE), '.cache', 'usaspending')
API = 'https://api.usaspending.gov/api/v2/search/spending_by_award/'
CA = '/root/.ccr/ca-bundle.crt'
CTX = ssl.create_default_context(cafile=CA) if os.path.exists(CA) else ssl.create_default_context()
FIELDS = ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date',
          'Description', 'Recipient Location', 'Primary Place of Performance', 'Recipient UEI', 'generated_internal_id']


def search(filters, sort='Start Date', limit=5, page=1):
    body = {'filters': {'award_type_codes': ['A', 'B', 'C', 'D'], **filters}, 'fields': FIELDS,
            'sort': sort, 'order': 'desc', 'limit': limit, 'page': page}
    key = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()
    path = os.path.join(CACHE, key + '.json')
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400:
        return json.load(open(path))
    req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                rows = json.loads(r.read()).get('results', [])
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3)
    os.makedirs(CACHE, exist_ok=True)
    json.dump(rows, open(path, 'w'))
    return rows


def window(days):
    end = date.today()
    return [{'start_date': (end - timedelta(days=days)).isoformat(), 'end_date': end.isoformat()}]


def comparable(naics, state, city=None, n=3):
    """The most recent awards in the same NAICS performed in the same city (else state), last two years."""
    if not naics or not state:
        return [], None
    base = {'naics_codes': {'require': [naics]}, 'time_period': window(730)}
    if city:
        rows = search({**base, 'place_of_performance_locations': [{'country': 'USA', 'state': state, 'city': city.upper()}]}, limit=n)
        if rows:
            return rows, f'{city.title()}, {state}'
    rows = search({**base, 'place_of_performance_locations': [{'country': 'USA', 'state': state}]}, limit=n)
    return rows, state
