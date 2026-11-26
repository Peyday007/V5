"""Aggregate blind grades into per-model tables. Usage: python3 exam/aggregate.py exam/grades.json exam/summary.json"""
import json, sys, pathlib, collections
root = pathlib.Path(__file__).parent
grades = json.load(open(sys.argv[1]))
key = {k['id']: k for k in json.load(open(root / 'key.json'))}
rel = json.load(open(root / 'reliability.json'))
CAPS = {1: 'constraints without invented restrictions', 2: 'strategy discovery', 3: 'facts vs assumptions', 4: 'who pays',
        5: 'economics, capital, settlement timing', 6: 'unreachable targets', 7: 'delegation / brokerage', 8: 'compare & select',
        9: 'contradictions between sources', 10: 'unsupported criticism', 11: 'deadlines, dependencies, capacity',
        12: 'constraint preservation', 13: 'evidence that does not establish the conclusion', 14: 'useful questions',
        15: 'revision on new evidence', 16: 'real opportunity vs event/prize', 17: 'unfamiliar industries',
        18: 'causal chain discovery->collection', 19: 'self-evaluation', 20: 'complete executable plan'}
# commercial planning = every question exercising strategy discovery, selection, causal chain or a full plan
PLANNING = [q for q, k in key.items() if set(k['caps']) & {2, 8, 18, 20}]
DIMS = ['reasoning', 'commercial', 'evidence', 'constraints', 'strategy', 'revision', 'format']
labels = sorted({l for g in grades.values() for l in g['grades']} | set(rel))
out = {}
for l in labels:
    m = {'correct': 0, 'graded': 0, 'not_answered': [], 'score_sum': 0, 'dims': collections.defaultdict(list),
         'caps': collections.defaultdict(lambda: [0, 0, 0.0]), 'planning': [0, 0, 0.0], 'critical_errors': [],
         'constraint_violations': [], 'evidence_errors': [], 'unsupported_assumptions': [], 'failures': [], 'per_q': {}}
    for qid in sorted(key):
        g = grades.get(qid, {}).get('grades', {}).get(l)
        if g is None:
            m['not_answered'].append(qid); m['per_q'][qid] = None
            for c in key[qid]['caps']: m['caps'][c][1] += 1
            if qid in PLANNING: m['planning'][1] += 1
            continue
        ok, sc = bool(g.get('correct')), float(g.get('score') or 0)
        m['graded'] += 1; m['correct'] += ok; m['score_sum'] += sc; m['per_q'][qid] = [sc, ok]
        for d in DIMS:
            if g.get(d) is not None: m['dims'][d].append(g[d])
        for c in key[qid]['caps']:
            m['caps'][c][0] += ok; m['caps'][c][1] += 1; m['caps'][c][2] += sc
        if qid in PLANNING: m['planning'][0] += ok; m['planning'][1] += 1; m['planning'][2] += sc
        for f in ['critical_errors', 'constraint_violations', 'evidence_errors', 'unsupported_assumptions']:
            m[f] += [f'{qid}: {x}' for x in (g.get(f) or [])]
        if g.get('worst_failure') and not ok: m['failures'].append(f"{qid} ({sc:g}/10): {g['worst_failure']}")
    out[l] = {'correct_of_30': m['correct'], 'graded': m['graded'], 'not_answered': m['not_answered'],
              'mean_score_answered': round(m['score_sum'] / max(m['graded'], 1), 2),
              'mean_score_all30': round(m['score_sum'] / 30, 2),
              'dimensions_mean_0_2': {d: round(sum(v) / len(v), 2) for d, v in m['dims'].items() if v},
              'capabilities': {f'{c:02d} {CAPS[c]}': f'{v[0]}/{v[1]} correct, mean {v[2] / max(v[1], 1):.1f}' for c, v in sorted(m['caps'].items())},
              'planning': f"{m['planning'][0]}/{m['planning'][1]} correct, mean {m['planning'][2] / max(m['planning'][1], 1):.1f}",
              **{f: m[f] for f in ['critical_errors', 'constraint_violations', 'evidence_errors', 'unsupported_assumptions', 'failures']},
              'counts': {f: len(m[f]) for f in ['critical_errors', 'constraint_violations', 'evidence_errors', 'unsupported_assumptions']},
              'per_question': m['per_q'], 'reliability': rel.get(l)}
json.dump(out, open(sys.argv[2], 'w'), indent=1)
for l, v in out.items():
    print(l, v['correct_of_30'], '/30 graded', v['graded'], 'mean', v['mean_score_answered'], v['counts'], v['planning'], v['dimensions_mean_0_2'])
