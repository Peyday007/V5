import json, os, sys, collections
sys.path.insert(0, os.path.dirname(__file__))
import importlib; M=importlib.import_module('map')
D=os.path.dirname(__file__)
qs=[]
for cid,stage,name,why,dims in M.CAPS:
    for k,v in dims.items():
        # A status nobody can point evidence at is not a status: it is UNKNOWN until a test answers it.
        if v['status']!='UNKNOWN' and not v['evidence']: v['status']='UNKNOWN'; v['evidence']=''
        qs.append(dict(id=f'{cid}-{k}',cap=cid,capName=name,stage=stage,why=why,dim=k,**v))
c=collections.Counter(q['status'] for q in qs)
out=[]
w=out.append
w('# Planning failure map: the authoritative record\n')
w('Rendered from `docs/planning-failure-map/map.py` by `render_md.py`; edit the data, never this file. `node scripts/planningFailureMapCheck.mjs` recomputes every count.\n')
w(f'**Outcome the map is derived from:** {M.OUTCOME}\n')
w('## Summary\n')
w(f'- Capabilities required: **{len(M.CAPS)}**')
w(f'- Diagnostic questions (5 per capability, +1 model-isolation question for each of the {sum(1 for x in M.CAPS if "M" in x[4])} model-dependent ones): **{len(qs)}**')
w(f'- PASS {c["PASS"]} · FAIL {c["FAIL"]} · NEEDS RECHECK {c["NEEDS RECHECK"]} · UNKNOWN {c["UNKNOWN"]}')
w(f'- Root causes established: **{len(M.ROOT_CAUSES)}**\n')
w('## A. What creating a successful plan requires (capability map)\n')
w('| id | stage | capability | why a plan needs it |\n|---|---|---|---|')
for cid,stage,name,why,dims in M.CAPS: w(f'| {cid} | {stage} | {name} | {why} |')
w('\nDimensions: ' + '; '.join(f'**{k}** {v}' for k,v in M.DIMS.items()) + '\n')
w('## B–C. Every diagnostic question and its status\n')
for cid,stage,name,why,dims in M.CAPS:
    w(f'### {cid} {name}\n')
    w('| id | dimension | test | expected (pass condition) | status | evidence | component | root cause |\n|---|---|---|---|---|---|---|---|')
    for k,v in dims.items():
        cell=lambda t: (t or '—').replace('|','/').replace('\n',' ')
        w(f"| {cid}-{k} | {M.DIMS[k]} | {cell(v['test'])} | {cell(v['expected'])} | **{v['status']}** | {cell(v['evidence'])} | {cell(v['component'])} | {cell(v['rc'])} |")
    w('')
w('## D. Root causes and the failures they explain\n')
byrc=collections.defaultdict(list)
for q in qs:
    for r in [x for x in q['rc'].split(',') if x]: byrc[r].append(q['id'])
for rid,rc in M.ROOT_CAUSES.items():
    w(f"### {rid} {rc['name']} ({rc['kind']})\n")
    w(f"- **What is wrong:** {rc['wrong']}")
    w(f"- **Owner of the correction:** {rc['owner']}")
    w(f"- **How a correction is proved:** {rc['proof']}")
    w(f"- **Evidence:** {rc['evidence']}")
    w(f"- **Questions it explains ({len(byrc[rid])}):** {', '.join(byrc[rid]) or '—'}\n")
w('## E. Repairs, owners and dependencies\n')
w('| id | root cause | repair | owner | depends on | state | evidence |\n|---|---|---|---|---|---|---|')
for r in M.REPAIRS: w(f"| {r['id']} | {r['rc'] or '—'} | {r['what']} | {r['owner']} | {r['depends'] or '—'} | {r['state']} | {r['evidence'] or '—'} |")
w('\n## F. Production evidence of repairs\n')
prod=[r for r in M.REPAIRS if r['state'].startswith('VERIFIED')]
w('\n'.join(f"- {r['id']}: {r['evidence']}" for r in prod) or '- None verified on production yet.')
w('\n## G. Remaining untested or unresolved requirements\n')
w(', '.join(q['id'] for q in qs if q['status'] in ('UNKNOWN','NEEDS RECHECK')))
w('\n## H. Measured progress toward 27/30 usable plans\n')
w('| date | measure | usable | source |\n|---|---|---|---|')
for p in M.PROGRESS: w(f"| {p['at']} | {p['measure']} | {p['usable']} | {p['note']} |")
open(os.path.join(D,'..','PLANNING-FAILURE-MAP.md'),'w').write('\n'.join(out)+'\n')
json.dump(dict(outcome=M.OUTCOME,dimensions=M.DIMS,rootCauses=M.ROOT_CAUSES,repairs=M.REPAIRS,progress=M.PROGRESS,capabilities=[dict(id=x[0],stage=x[1],name=x[2],why=x[3]) for x in M.CAPS],questions=qs),open(os.path.join(D,'map.json'),'w'),indent=1)
print(len(M.CAPS),len(qs),dict(c),len(M.ROOT_CAUSES),len(M.REPAIRS))
