import random
random.seed(11); N=20000
def bern(n,p): return sum(random.random()<p for _ in range(n))
out=[];nets=[];A=[];B=[]
for _ in range(N):
    shared=random.uniform(0.6,1.4)                 # one December/credibility factor shared by both lines
    close=min(0.8,random.uniform(0.15,0.45)*shared)  # UNMEASURED: interested -> paid
    # Line A: Neighbor Card Zone 1, threshold 10 cells by Dec 9 (measured email interest 5/453)
    pE=random.betavariate(6,449)*shared
    intA=bern(5,0.35*shared)+bern(250,pE)+bern(450*2,random.uniform(.15,.35)*random.uniform(.03,.12)*shared)
    cells=0;revA=0
    for _ in range(bern(intA,close)):
        c=1 if random.random()<.75 else 2
        if cells+c<=22: cells+=c; revA+=295 if c==1 else random.choice([525,575,625])
    revA = revA if cells>=10 else 0
    costA = random.uniform(2300,2800) if revA else 0
    # Line B: national done-for-you solo January EDDM, ~$2,700 per 5,000-home drop, prepaid
    leads=int(random.uniform(1800,3000))           # Brain share of 930/day over ~15 sending days, 3-step sequence
    pB=random.betavariate(1,386)*shared  # measured analog: AI Dispatch, national high-ticket, 0 real interest of 385 leads
    dealsB=bern(bern(leads,pB),close*0.7)          # higher ticket closes worse: assumed x0.7
    revB=sum(random.uniform(2600,2900) for _ in range(dealsB))
    costB=dealsB*random.uniform(2150,2400)
    g=revA+revB; out.append(g); nets.append(g-costA-costB-1500); A.append(revA); B.append(revB)
out.sort(); nets.sort()
q=lambda a,p:a[int(p*len(a))]
print("gross p10 %.0f p50 %.0f p90 %.0f | >=10k %.1f%% | >=5k %.1f%%"%(q(out,.1),q(out,.5),q(out,.9),100*sum(x>=1e4 for x in out)/N,100*sum(x>=5e3 for x in out)/N))
print("net (after print/post, solo COGS, $1.5k caller+tools) p10 %.0f p50 %.0f p90 %.0f; worst %.0f"%(q(nets,.1),q(nets,.5),q(nets,.9),nets[0]))
print("line A mean %.0f, line B mean %.0f"%(sum(A)/N,sum(B)/N))
