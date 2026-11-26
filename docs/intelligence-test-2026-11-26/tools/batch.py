import json,sys,base64
D,goal,mode=sys.argv[1],sys.argv[2],sys.argv[3]  # mode: cap | all
v=json.load(open(f'{D}/v_{goal}.json'))
extra=sys.argv[4:]  # extra verified files (follow-ups)
for f in extra: v+=json.load(open(f))
ok=[r for r in v if r['v'] in('EXACT','FUZZY')]
ok=[r for r in ok if r['q'].startswith('F')]+[r for r in ok if not r['q'].startswith('F')]  # newest first, as production orders findings
facts=[{'claim':r['claim'][:280],'sourceUrl':r['sourceUrl'],'sourceTitle':(r.get('sourceTitle') or '')[:80],'sourceDate':r.get('sourceDate'),'lane':r.get('lane') if r.get('lane')!='other' else None} for r in ok]
batch=facts if mode=='cap' else {'facts':facts,'maxFindings':1000}
b=base64.b64encode(json.dumps(batch,ensure_ascii=False).encode()).decode()
open(f'{D}/b_{goal}_{mode}.b64','w').write(b)
print(goal,mode,'facts',len(facts),'b64',len(b))
