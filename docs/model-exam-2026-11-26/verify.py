"""Checks the exam record proves what the report claims. Usage: python3 verify.py GROUP
GROUP: design | caps | execution | dimensions | report"""
import json, sys, pathlib, re
d = pathlib.Path(__file__).parent
Q = json.load(open(d / 'questions.json')); K = json.load(open(d / 'key.json'))
R = {f.stem: json.load(open(f)) for f in (d / 'results').glob('*.json')}
G = json.load(open(d / 'grades.json')); S = json.load(open(d / 'summary.json')); REL = json.load(open(d / 'reliability.json'))
rep = open(d / 'REPORT.md').read()
g = sys.argv[1]
if g == 'design':
    assert len(Q['questions']) == 30 and len(K) == 30
    assert 'Brain' not in Q['system'] and 'tools' in Q['system']
    assert all(k['key'] and k['critical'] for k in K)
    assert sum(1 for k in K if len(k['caps']) > 1) >= 15  # multi-ability questions
elif g == 'caps':
    assert set(c for k in K for c in k['caps']) == set(range(1, 21))
elif g == 'execution':
    assert set(R) == {'claude_opus', 'gptoss120b', 'qwen38_27b', 'fallback_auto'}
    for r in R.values():
        assert len(r['results']) == 30 and all(a.get('content') is not None or not a.get('ok') for x in r['results'] for a in x['attempts'])
    assert len(G) == 30 and all(set(v['grades']) == set(v['letters'].values()) and v['letters'] for v in G.values())
    assert all(set(v['letters']) <= set('ABCD') for v in G.values())  # anonymous letters only
elif g == 'dimensions':
    for l in R:
        dims = S[l]['dimensions_mean_0_2']
        assert {'reasoning', 'commercial', 'evidence', 'constraints', 'strategy', 'revision'} <= set(dims), l
        assert l in REL
    assert REL['gptoss120b']['first_attempt_failure_kinds'].get('http') == 11
elif g == 'report':
    for l in R: assert S[l]['correct_of_30'] is not None
    assert f"**{S['claude_opus']['correct_of_30']}**" in rep and f"**{S['fallback_auto']['correct_of_30']}**" in rep
    for h in ['**A.', '**B.', '**C.', '**D.', '**E.', 'Constraint violations', 'Evidence-interpretation errors',
              'Unsupported assumptions', 'Empty replies', 'Timeouts', 'genuine reasoning failures', 'Performance by reasoning capability',
              'Commercial planning', 'No purchase of a stronger model is recommended']:
        assert h in rep, h
else:
    sys.exit(f'unknown group {g}')
print('OK', g)
