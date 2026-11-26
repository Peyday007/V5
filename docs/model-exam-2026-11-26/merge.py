"""Merge pass 1 and pass 2 into exam/results/<label>.json and write exam/reliability.json.
Pass 2 re-asked only items whose pass 1 ended without an answer the named model served; every
attempt of both passes is kept in order, marked with its pass. A reply served by a model other
than the one named (the switchboard's silent substitution) is not that model's answer and is
re-marked kind 'substituted'. Usage: python3 exam/merge.py PASS2_DIR
"""
import json, sys, pathlib
root = pathlib.Path(__file__).parent
p1, p2 = root / 'raw' / 'pass1', pathlib.Path(sys.argv[1])
EXPECT = {'gptoss120b': 'gpt-oss', 'qwen38_27b': 'qwen', 'fallback_auto': None}

def mark(attempts, pas, expect):
    for a in attempts:
        a['pass'] = pas
        if expect and a.get('ok') and a.get('served_model') and expect not in a['served_model']:
            a['ok'], a['kind'] = False, 'substituted'
    return attempts

rel = {}
for label, expect in EXPECT.items():
    d = json.load(open(p1 / f'{label}.json'))
    two = p2 / f'{label}_p2.json'
    extra = {r['id']: r for r in json.load(open(two))['results']} if two.exists() else {}
    stats = {'questions': 30, 'first_attempt_answer': 0, 'first_attempt_failure_kinds': {}, 'served_by_other_model': 0,
             'truncated_at_limit': 0, 'unanswered_after_all_attempts': [], 'attempts_total': 0}
    for r in d['results']:
        mark(r['attempts'], 1, expect)
        if 'followup' in r: mark(r['followup'], 1, expect)
        f0 = r['attempts'][0]
        if f0['ok']: stats['first_attempt_answer'] += 1
        else: stats['first_attempt_failure_kinds'][f0['kind']] = stats['first_attempt_failure_kinds'].get(f0['kind'], 0) + 1
        if r['id'] in extra and not any(a['ok'] for a in r['attempts']):
            r['attempts'] += mark(extra[r['id']]['attempts'], 2, expect)
        stats['served_by_other_model'] += sum(a['kind'] == 'substituted' for a in r['attempts'])
        stats['attempts_total'] += len(r['attempts'])
        ok = next((a for a in r['attempts'] if a['ok']), None)
        if not ok: stats['unanswered_after_all_attempts'].append(r['id'])
        elif ok.get('finish_reason') == 'length': stats['truncated_at_limit'] += 1
    d['note'] = 'pass 1 = identical first run; pass 2 = serving-failure re-asks only (see exam/README.md)'
    json.dump(d, open(root / 'results' / f'{label}.json', 'w'), indent=1)
    rel[label] = stats

c = json.load(open(root / 'results' / 'claude_opus.json'))
rel['claude_opus'] = {'questions': 30, 'first_attempt_answer': sum(r['attempts'][0]['ok'] for r in c['results']),
                      'unanswered_after_all_attempts': [r['id'] for r in c['results'] if not any(a['ok'] for a in r['attempts'])]}
json.dump(rel, open(root / 'reliability.json', 'w'), indent=1)
print(json.dumps(rel, indent=1))
