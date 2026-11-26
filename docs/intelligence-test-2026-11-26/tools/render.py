import json,sys
f=sys.argv[1]
L={}
for l in open(f):
    if l.startswith('PROBE '):
        k,_,v=l[6:].partition(' ')
        try: L.setdefault(k,[]).append(json.loads(v))
        except Exception: L.setdefault(k,[]).append(v.strip())
out=[]
for k in ('objective','delivery','mode','models'):
    if k in L: out.append(f'{k}: {json.dumps(L[k][0])[:600]}')
for r in L.get('reply',[]):
    out.append(f"reply model={r['model']} error={str(r.get('error'))[:200]} ms={r.get('ms')} chars={len(r.get('content') or '')}")
p=L.get('parsed',[None])[-1]
if isinstance(p,dict):
    out.append(f"PARSED routes kept by parser: {len(p.get('routes',[]))}; rejected: {json.dumps(p.get('rejected',[]))[:1500]}")
    for i,r in enumerate(p.get('routes',[])):
        out.append(f"ROUTE {i+1}: "+json.dumps({k:r.get(k) for k in ('title','payer','offer','price','priceAnchor','channel','performer','fulfiller','directCost','capital','ownerHoursPerDeal','daysToFirstCash','buyerCount','volumeBasis','assumptions','grounds')},ensure_ascii=False))
c=L.get('critique',[None])[-1]
if isinstance(c,dict):
    for r in c.get('ranked',[]): out.append(f"CRITIC RANK {r.get('rank')} score={r.get('score')} title={r['route'].get('title')} why={r.get('why')}")
    for d in c.get('dropped',[]): out.append(f"CRITIC DROPPED {json.dumps(d,ensure_ascii=False)[:500]}")
elif c: out.append(f'critique: {str(c)[:500]}')
print('\n'.join(out))
