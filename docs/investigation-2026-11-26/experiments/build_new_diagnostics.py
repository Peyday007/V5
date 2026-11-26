"""register/new_diagnostics.json: diagnostic requirements the existing 218 questions do not cover.
Sources (deterministic): (a) Map C requirements with coverage NO_CAPABILITY in coverage.json;
(b) Map A decision mechanisms (selector/validator/critic/model_call/parser/state_transition/recovery)
referenced by no question, confirmed by a keyword sweep of question text (lexical join under-reports,
so each (b) row records the sweep keyword and its hit count: 0 = confirmed uncovered).
One requirement per uncovered mechanism or requirement; no arbitrary count."""
import json, os, re, sys
inv = os.path.join(sys.argv[1], 'docs/investigation-2026-11-26')
J = lambda p: json.load(open(os.path.join(inv, p)))
cov = J('register/coverage.json'); q = J('register/questions.json')
mech = {m['id']: m for m in J('maps/A/mechanisms.json')}
reqs = {r['id']: r for r in J('maps/C/requirements.json')['requirements']}
text = [json.dumps({a: x[a] for a in ('test', 'expected', 'component', 'map_evidence')}) for x in q]
DECISION = {'selector', 'validator', 'critic', 'model_call', 'parser', 'state_transition', 'recovery'}
out = []
for r in cov['rows']:
    if r['coverage'] == 'NO_CAPABILITY':
        R = reqs[r['req']]
        out.append({'id': 'ND-R-' + r['req'], 'source': 'MAP_C_REQUIREMENT', 'criticality': r['criticality'],
                    'target': r['title'], 'must_detect': R.get('failure_modes', []),
                    'correct_behaviour': R.get('correct_behaviour'), 'observability': R.get('observability')})
for mid in cov['counts']['map_a_mechanisms_never_referenced_by_a_question']:
    m = mech[mid]
    if m['kind'] not in DECISION: continue
    sym = re.findall(r'[A-Za-z_][A-Za-z0-9_]{5,}', m['symbol'] or '')
    kw = sym[0] if sym else os.path.basename(m['file'])
    hits = sum(1 for t in text if re.search(re.escape(kw), t, re.I))
    out.append({'id': 'ND-M-' + mid, 'source': 'MAP_A_UNCOVERED_DECISION', 'kind': m['kind'],
                'target': f"{m['file']}:{m['line']} {m['symbol']}", 'produces': m.get('produces'),
                'filters_caps_vetoes': m.get('filters_caps_vetoes'),
                'sweep_keyword': kw, 'sweep_hits': hits,
                'confirmed_uncovered': hits == 0,
                'must_detect': 'that its decision on a recorded goal input matches the Map C requirement it serves, '
                               'and that a wrong decision is visible in the plan reading'})
json.dump(out, open(os.path.join(inv, 'register/new_diagnostics.json'), 'w'), indent=1)
from collections import Counter
print(len(out), Counter(o['source'] for o in out), 'confirmed uncovered', sum(1 for o in out if o.get('confirmed_uncovered')))
