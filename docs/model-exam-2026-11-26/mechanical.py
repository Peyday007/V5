"""Grader-independent cross-check: does each answer contain the key's load-bearing numbers?
No model judges this; a regex does. Usage: python3 exam/mechanical.py"""
import json, re, pathlib
root = pathlib.Path(__file__).parent
CHECKS = {
 'Q05': [r'7\.13', r'\b82\b'],
 'Q06': [r'\b84\b', r'37,?560'],
 'Q08': [r'7,?700'],
 'Q11': [r'Dec(ember)?\.?\s*10', r'Dec(ember)?\.?\s*20', r'\$?900'],
 'Q25': [r'Mar(ch)?\.?\s*7'],
}
out = {}
for f in sorted((root / 'results').glob('*.json')):
    d = json.load(open(f)); row = {}
    for r in d['results']:
        if r['id'] not in CHECKS: continue
        a = next((x for x in r['attempts'] if x.get('ok')), None)
        t = a['content'] if a else ''
        row[r['id']] = f"{sum(bool(re.search(p, t)) for p in CHECKS[r['id']])}/{len(CHECKS[r['id']])}" if a else 'no answer'
    hits = sum(int(v.split('/')[0]) for v in row.values() if '/' in v); tot = sum(len(c) for c in CHECKS.values())
    out[d['label']] = {'per_question': row, 'key_values_present': f'{hits}/{tot}'}
    print(d['label'], out[d['label']])
json.dump(out, open(root / 'mechanical.json', 'w'), indent=1)
