"""Builds register/coverage.json: the reconciled, machine-checkable coverage matrix
   requirement (Map C) -> existing capability -> diagnostic questions -> implementation (Map A)
   -> investigation experiments/evidence -> coverage verdict,
and fills impl_refs / req_refs / handoff_refs / diagnostic_validation in register/questions.json.

Deterministic joins only (no hidden judgement):
  req -> caps          register/C_to_existing_capabilities.json (lead crosswalk, Gate A reviewed)
  cap -> questions     questions.json 'cap'
  question -> impl     Map A mechanism whose file basename or symbol token occurs in the question's
                       component string (case-insensitive, tokens >= 5 chars)
  question -> expt     an experiment/evidence file names the question id
  diagnostic_validation  VERIFIED if Gate B listed the citing experiment VERIFIED, PARTIAL likewise,
                       else UNVERIFIED; a spec_defect forces DEFECTIVE_SPEC
Coverage verdict per requirement:
  NO_CAPABILITY        crosswalk found no capability (a new diagnostic requirement)
  NO_DIAGNOSTIC        capability exists but no question has any evidence
  UNVERIFIED_DIAGNOSTIC questions have evidence but none is backed by a verified experiment
  DIAGNOSED_E0_ONLY    a verified experiment exists but only pre-change evidence / code replay
  DIAGNOSED            a verified experiment re-ran on REF or E1
Run after build_register.py:  python3 -I build_coverage.py <repo_root>
"""
import json, os, re, sys, glob
from collections import Counter

root = sys.argv[1]
inv = os.path.join(root, 'docs/investigation-2026-11-26')
J = lambda p: json.load(open(os.path.join(inv, p)))
reqs = J('maps/C/requirements.json')['requirements']
cross = {r['req']: r for r in J('register/C_to_existing_capabilities.json')['rows']}
mechs = J('maps/A/mechanisms.json')
handA = J('maps/A/handoffs.json')
handA = handA if isinstance(handA, list) else handA.get('handoffs', [])
qs = J('register/questions.json')

# Gate B verdicts on experiments (reviews/GATE-B.md section 1)
GATE_B = {'E-012': 'VERIFIED', 'E-013': 'VERIFIED', 'E-014': 'VERIFIED', 'E-015': 'VERIFIED',
          'E-016': 'VERIFIED', 'L-001': 'VERIFIED',
          'E-001': 'PARTIAL', 'E-002': 'PARTIAL', 'E-010': 'PARTIAL', 'E-011': 'PARTIAL'}
E1_OR_REF = {'E-002': 'E1', 'E-010': 'REF', 'E-011': 'REF', 'E-012': 'REF', 'E-013': 'REF',
             'E-014': 'REF', 'E-015': 'REF', 'E-016': 'REF'}

docs = {}
for p in glob.glob(os.path.join(inv, 'experiments/*.md')) + glob.glob(os.path.join(inv, 'evidence/*.md')):
    key = os.path.basename(p)[:5]
    docs[key] = open(p).read()

def tokens(mech):
    t = set()
    base = os.path.splitext(os.path.basename(mech['file']))[0]
    if len(base) >= 5: t.add(base.lower())
    for tok in re.findall(r'[A-Za-z_][A-Za-z0-9_]{4,}', mech.get('symbol') or ''):
        t.add(tok.lower())
    return t - {'brain', 'operator', 'export', 'function', 'const'}

mtok = [(m['id'], tokens(m)) for m in mechs]

def impl_for(component):
    c = (component or '').lower()
    if not c: return []
    words = set(re.findall(r'[a-z_][a-z0-9_]{4,}', c))
    return sorted({mid for mid, t in mtok if t & words})

cap_to_reqs = {}
for r in cross.values():
    for c in r['existing_caps']:
        cap_to_reqs.setdefault(c, []).append(r['req'])

for q in qs:
    q['impl_refs'] = impl_for(q['component'])
    q['req_refs'] = sorted(cap_to_reqs.get(q['cap'], []))
    q['handoff_refs'] = sorted({h['id'] for h in handA if h.get('id') and any(m in json.dumps(h) for m in q['impl_refs'])})[:20]
    cited = sorted(k for k, txt in docs.items() if re.search(r'\b' + re.escape(q['id']) + r'\b', txt))
    q['investigation_refs'] = cited
    verdicts = [GATE_B.get(k, 'UNREVIEWED') for k in cited]
    if q['spec_defect']:
        q['diagnostic_validation'] = 'DEFECTIVE_SPEC'
    elif 'VERIFIED' in verdicts:
        q['diagnostic_validation'] = 'VERIFIED'
    elif 'PARTIAL' in verdicts:
        q['diagnostic_validation'] = 'PARTIAL'
    else:
        q['diagnostic_validation'] = 'UNVERIFIED'

rows = []
for r in reqs:
    x = cross.get(r['id'], {'existing_caps': [], 'match': 'NOT_IN_CROSSWALK'})
    rq = [q for q in qs if q['cap'] in x['existing_caps']]
    impl = sorted({i for q in rq for i in q['impl_refs']})
    expts = sorted({k for q in rq for k in q['investigation_refs']} |
                   {k for k, t in docs.items() if r['id'] in t})
    evidenced = [q for q in rq if q['evidence_class'] != 'UNVERIFIED']
    ver = [k for k in expts if GATE_B.get(k) == 'VERIFIED']
    if not x['existing_caps']:
        verdict = 'NO_CAPABILITY'
    elif not evidenced:
        verdict = 'NO_DIAGNOSTIC'
    elif not ver:
        verdict = 'UNVERIFIED_DIAGNOSTIC'
    elif any(k in E1_OR_REF for k in ver):
        verdict = 'DIAGNOSED'
    else:
        verdict = 'DIAGNOSED_E0_ONLY'
    rows.append({
        'req': r['id'], 'title': r['title'], 'stage': r['stage'], 'criticality': r['criticality'],
        'crosswalk_match': x['match'], 'caps': x['existing_caps'],
        'questions': [q['id'] for q in rq],
        'questions_with_evidence': len(evidenced),
        'questions_defective_spec': sum(1 for q in rq if q['spec_defect']),
        'impl_mechanisms': impl, 'investigation_refs': expts, 'verified_refs': ver,
        'coverage': verdict,
        'new_diagnostic_requirement': verdict in ('NO_CAPABILITY', 'NO_DIAGNOSTIC'),
    })

out = {
    'note': 'Generated by experiments/build_coverage.py; joins documented in its header. '
            'impl join is lexical (component string vs Map A file/symbol) and under-reports; '
            'a requirement with no impl mechanism is not proof the code lacks it.',
    'counts': {
        'by_coverage': dict(Counter(x['coverage'] for x in rows)),
        'critical_by_coverage': dict(Counter(x['coverage'] for x in rows if x['criticality'] == 'CRITICAL')),
        'questions_with_impl_ref': sum(1 for q in qs if q['impl_refs']),
        'questions_by_validation': dict(Counter(q['diagnostic_validation'] for q in qs)),
        'map_a_mechanisms_never_referenced_by_a_question':
            sorted({m['id'] for m in mechs} - {i for q in qs for i in q['impl_refs']}),
    },
    'rows': rows,
}
json.dump(out, open(os.path.join(inv, 'register/coverage.json'), 'w'), indent=1)
json.dump(qs, open(os.path.join(inv, 'register/questions.json'), 'w'), indent=1)
c = out['counts']
print('coverage', c['by_coverage']); print('critical', c['critical_by_coverage'])
print('q impl', c['questions_with_impl_ref'], 'validation', c['questions_by_validation'])
print('unreferenced mechanisms', len(c['map_a_mechanisms_never_referenced_by_a_question']), 'of', len(mechs))
