import json, sys, re, html, hashlib, os, subprocess, glob, unicodedata, concurrent.futures as cf
D=sys.argv[1]; goal=sys.argv[2]
CACHE=os.path.join(D,'pages'); os.makedirs(CACHE,exist_ok=True)
def norm(t):
    t=unicodedata.normalize('NFKC',t)
    t=t.replace('’',"'").replace('‘',"'").replace('“','"').replace('”','"').replace('–','-').replace('—','-').replace('\xa0',' ')
    t=re.sub(r'[^a-z0-9$%.]+',' ',t.lower())
    return re.sub(r'\s+',' ',t).strip()
def fetch(url):
    h=hashlib.sha1(url.encode()).hexdigest()[:16]; p=os.path.join(CACHE,h+'.txt')
    if os.path.exists(p): return open(p).read()
    try:
        r=subprocess.run(['curl','-sL','--max-time','25','-A','Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36','-H','Accept-Language: en-US','-w','\n__STATUS__%{http_code}',url],capture_output=True,timeout=40)
        raw=r.stdout.decode('utf8','replace')
    except Exception as e:
        raw='\n__STATUS__000'
    m=re.search(r'\n__STATUS__(\d+)$',raw); status=m.group(1) if m else '000'; body=raw[:m.start()] if m else raw
    body=re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>',' ',body)
    text=html.unescape(re.sub(r'<[^>]+>',' ',body))
    out=f'{status}\n'+text
    open(p,'w').write(out); return out
def grams(t,n=4):
    w=t.split(); return set(tuple(w[i:i+n]) for i in range(max(0,len(w)-n+1))) or {tuple(w)}
res=[]
files=sorted(glob.glob(os.path.join(D,f'r_{goal}_*.json')))
facts=[]
qstatus={}
for f in files:
    d=json.load(open(f))
    for r in d['results']:
        qstatus[r['id']]=r
        for x in r.get('facts',[]): facts.append((r['id'],x))
urls=sorted(set(x['sourceUrl'] for _,x in facts))
with cf.ThreadPoolExecutor(12) as ex: pages=dict(zip(urls,ex.map(fetch,urls)))
for qid,x in facts:
    pg=pages[x['sourceUrl']]; status=pg.split('\n',1)[0]; text=norm(pg.split('\n',1)[1] if '\n' in pg else '')
    q=norm(x.get('quote','') or '')
    if not q: v='NO_QUOTE'; score=0
    elif len(text)<400 or not status.startswith('2'): v='UNREADABLE_HERE'; score=0
    elif q in text: v='EXACT'; score=1
    else:
        g=grams(q); score=len([1 for k in g if ' '.join(k) in text])/len(g)
        v='FUZZY' if score>=0.6 else 'NOT_FOUND'
    # numbers in claim must appear in quote or page
    nums=re.findall(r'\d[\d,.]*',x.get('claim',''))
    missing=[n for n in nums if n.strip('.,').replace(',','') not in (q+' '+text).replace(',','')]
    res.append({'q':qid,'v':v,'score':round(score,2),'status':status,'numsMissing':missing[:5],**x})
json.dump(res,open(os.path.join(D,f'v_{goal}.json'),'w'),indent=1)
from collections import Counter
c=Counter(r['v'] for r in res)
print(goal,'facts',len(res),'urls',len(urls),dict(c))
st=Counter(r['status'] for r in qstatus.values())
print(goal,'questions',len(qstatus),dict(st))
