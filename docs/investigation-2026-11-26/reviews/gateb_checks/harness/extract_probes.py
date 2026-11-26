"""Extract recorded PROBE lines (E0 planner probes + E1 E-002 replay) into one JSON file. Read-only on inputs."""
import json, glob, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
files = sorted(glob.glob(f'{ROOT}/docs/intelligence-test-2026-11-26/planner/probe1_*.txt') + glob.glob(f'{ROOT}/docs/intelligence-test-2026-11-26/planner/final_*.txt'))
files.append(f'{ROOT}/docs/investigation-2026-11-26/experiments/raw/E-002/eval.txt')
out = []
for f in files:
    recs = {}
    rev = None
    for line in open(f):
        if line.startswith('SERVING_REVISION'): rev = line.split()[1]
        if line.startswith('PROBE '):
            k, _, v = line[6:].partition(' ')
            recs.setdefault(k, []).append(json.loads(v))
    case = os.path.basename(f).replace('.txt', '')
    if 'E-002' in f: case = 'E-002_eval_p02_cap'
    out.append({'case': case, 'file': os.path.relpath(f, ROOT), 'revision': rev,
                'goal': ('p02' if 'p02' in case else 'p06' if 'p06' in case else 'p10'),
                'delivery': recs.get('delivery', [None])[0], 'objective': recs['objective'][0],
                'findings': recs.get('findings', [[]])[0], 'models': recs.get('models', [[]])[0],
                'prompt': recs.get('prompt', [None])[0], 'replies': recs.get('reply', []),
                'parsed': recs.get('parsed', [None])[0], 'critique': recs.get('critique', [None])[0]})
json.dump(out, open(sys.argv[1], 'w'), indent=1)
print(len(out), 'cases')
for o in out: print(o['case'], o['revision'][:7] if o['revision'] else None, [ (r['model'][:12], len(r['content'])) for r in o['replies']])
