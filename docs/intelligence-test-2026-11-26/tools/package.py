import json,re,random,subprocess,sys,os,base64
D=sys.argv[1]; g=sys.argv[2]
def emulate(batchfile):
    b=json.loads(base64.b64decode(open(batchfile).read()))
    facts=b if isinstance(b,list) else b['facts']; cap=40 if isinstance(b,list) else b['maxFindings']
    seen=set(); out=[]
    for i,f in enumerate(facts):
        t=re.sub(r'\s+',' ',f['claim']).strip()
        if len(t)<25: continue
        if re.search('absence|disqualif|ruled_out',f.get('lane') or '',re.I): continue
        n=re.sub(r'[^a-z0-9]+',' ',t.lower()).strip()[:160]
        if n in seen: continue
        seen.add(n); out.append(f"F{len(out)+1} (probe_{i+1}) [{f.get('lane')}] {t[:280]} ({f['sourceUrl']}, {f.get('sourceDate') or ''})")
        if len(out)>=cap: break
    return out
def findings_from_prompt(txt):
    for l in open(txt):
        if l.startswith('PROBE prompt '):
            p=json.loads(l[len('PROBE prompt '):]); m=re.search(r'FINDINGS[^\n]*\n(.*?)\n\n',p,re.S); return m.group(1).split('\n') if m else []
    return None
arms={'R1cap':('probe1_%s_cap.txt','b_%s_cap.b64'),'R1all':('probe1_%s_all.txt','b_%s_all.b64'),'Fcap':('final_%s_cap.txt','b2_%s_cap.b64'),'Fall':('final_%s_all.txt','b2_%s_all.b64')}
# regenerate round-1 batches (b_) as they were delivered: round-1 facts only, question order
os.makedirs(f'{D}/grade_{g}',exist_ok=True)
labels=['X','Y','Z','W','V']; random.seed(hash(g)%1000+7); random.shuffle(labels)
key={}
for (arm,(pf,bf)),lab in zip(list(arms.items())+[('CTRL',(None,None))],labels):
    key[lab]=arm
    if arm=='CTRL':
        reply=open(f'{D}/control_reply_{g}.json').read() if os.path.exists(f'{D}/control_reply_{g}.json') else '(missing)'
        shown=findings_from_prompt(f'{D}/final_{g}_all.txt')
        body="PLANNER REPLY (raw JSON; no critic ranking was applied — judge the routes yourself, the first is its top):\n"+reply
    else:
        body=subprocess.run(['python3','-I',f'{os.path.dirname(D)}/tools/render.py',f'{D}/{pf%g}'],capture_output=True,text=True).stdout
        body=re.sub(r'^objective: .*\n','',body,flags=re.M)
        shown=findings_from_prompt(f'{D}/{pf%g}') or emulate(f'{D}/{bf%g}')
    open(f'{D}/grade_{g}/output_{lab}.txt','w').write(f"OUTPUT {lab}\n\nFINDINGS SHOWN TO THIS PLANNER ({len(shown)}; refs are per output):\n"+'\n'.join(shown)+"\n\n"+body)
json.dump(key,open(f'{D}/grade_key_{g}.json','w'))
v=json.load(open(f'{D}/v_{g}.json'))
open(f'{D}/grade_{g}/all_verified_facts.txt','w').write('\n'.join(f"[{r['q']}] [{r.get('lane')}] {r['claim']} ({r['sourceUrl']})" for r in v if r['v'] in('EXACT','FUZZY')))
print(g,key)
