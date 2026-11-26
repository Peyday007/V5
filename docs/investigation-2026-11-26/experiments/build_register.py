"""Builds register/questions.json: the 218 existing diagnostic questions, each with an
evidence classification tied to the revision it was measured on (REFERENCE.md epochs).

Deterministic rules (no judgement hidden in prose):
  epoch        all existing evidence predates PROD a8c4699 (W1 deploy ~05:50Z) -> E0, or NONE
  kind         MODEL_ISOLATION (model exam) | CODE_ONLY (evidence says code / proven in code /
               'None' / 'No check') | BEHAVIORAL (production reading, probe, 30Q, fm1126a, traces)
  w1_touched   the question's root cause or component is on a file a W1 repair changed
               (routeProposal.ts, cash/discovery.ts, repos/research.ts, intent.ts, modelBench.ts)
  class        UNVERIFIED (no evidence) | CONTRADICTED (lead override, cited) |
               VALID BUT NEEDS RECHECK AFTER CHANGES (w1_touched, any status) |
               INCOMPLETE (code-only, or 'NEEDS RECHECK' with no measurement) |
               VALID AND REUSABLE (behavioral or model-isolation, not touched)
Lead overrides are listed in OVERRIDES with the primary evidence that justifies them and are
subject to Gate B review.
Run:  python3 -I build_register.py <repo_root>
"""
import json, re, sys, os

root = sys.argv[1]
m = json.load(open(os.path.join(root, 'docs/planning-failure-map/map.json')))

W1_RC = {'RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC7', 'RC8', 'RC9', 'RC15'}
W1_COMPONENT = re.compile(r'routeProposal|route prompt|routeContext|parseRoutes|applyCritique|critiqueAndRevise|critiquePrompt|directionPrompt|findingsOf|limitLines|critic\b|proposer|discovery|projectEvidenceClaims|repos/research|intent\.ts|readObjective|ask\b|operatorChats|modelBench|ownerProfileOf|ownerLabourOffer|ROUTE_RULES', re.I)
CODE_ONLY = re.compile(r'\(code\)|^code:|proven in code|^none\.?$|no check exists|no computed|^no repair|^only hours computed|^no reader|code\)\.?$', re.I)
MODEL = re.compile(r'model exam', re.I)

# Lead overrides — each cites primary evidence. Reviewed by Gate B.
OVERRIDES = {
    'C23-M': ('CONTRADICTED',
              'Map says the empty replies "are the proxy idle cut, not the model (repaired W1j)". Primary evidence: '
              'docs/intelligence-test-2026-11-26/planner/*.txt PROBE reply lines show 6/12 gpt-oss replies with content "" '
              'and error null at 47-85 s, below the ~100 s idle cut that yields HTTP 524 (the 524 case is a different, '
              'error-carrying symptom). Route asks send max_tokens 3500-4000 (routeProposal.ts:1874,1898,2037,2097) vs 16000 '
              'in the exam (0/47 empty). Supported alternative: reasoning tokens exhaust the completion budget. W1j (streaming) '
              'does not address it; W1a (one retry at 2x budget) partly does. See experiments/E-001.'),
    'C07-M': ('INCOMPLETE',
              'Mixes two measurements: model exam (no Brain prompt) and 30Q control (Brain prompt, Claude Sonnet, 0/3). '
              'They disagree; which factor (prompt vs model) dominates is not distinguished. See H-PROMPT-vs-MODEL.'),
    'C36-P': ('INCOMPLETE',
              'Merges a model-isolation result (exam cap 20) and a structural production observation (fm1126a f01 plan = '
              'constructed-arrangement research steps). Two different mechanisms; split required.'),
}

def classify(q):
    ev = (q.get('evidence') or '').strip()
    rcs = {r.strip() for r in (q.get('rc') or '').split(',') if r.strip()}
    if q['id'] in OVERRIDES:
        cls, note = OVERRIDES[q['id']]
        return cls, note
    if not ev or ev == '-':
        return 'UNVERIFIED', 'no evidence recorded'
    touched = bool(rcs & W1_RC) or bool(W1_COMPONENT.search(q.get('component') or ''))
    if touched:
        return 'VALID BUT NEEDS RECHECK AFTER CHANGES', 'measured in E0 on a path a W1 repair changed; the observed failure/pass is kept, not discarded'
    if CODE_ONLY.search(ev):
        return 'INCOMPLETE', 'code reading only; behaviour not measured'
    if q['status'] == 'NEEDS RECHECK':
        return 'INCOMPLETE', 'map marks it unmeasured'
    return 'VALID AND REUSABLE', 'E0 evidence on a path no change has touched since'

def kind(q):
    ev = (q.get('evidence') or '').strip()
    if not ev or ev == '-':
        return 'NONE'
    if MODEL.search(ev):
        return 'MODEL_ISOLATION'
    if CODE_ONLY.search(ev):
        return 'CODE_ONLY'
    return 'BEHAVIORAL'

out = []
for q in m['questions']:
    cls, note = classify(q)
    out.append({
        'id': q['id'], 'cap': q['cap'], 'dim': q['dim'], 'test': q['test'], 'expected': q['expected'],
        'map_status': q['status'], 'map_rc': q['rc'] or None, 'component': q['component'] or None,
        'map_evidence': q['evidence'] or None,
        'evidence_epoch': 'NONE' if kind(q) == 'NONE' else 'E0',
        'evidence_kind': kind(q), 'evidence_class': cls, 'class_note': note,
        # filled by reconciliation (Step 5) and Gate B:
        'impl_refs': [], 'req_refs': [], 'handoff_refs': [],
        'can_detect_intended_failure': 'UNTESTED', 'distinguishes_causes': 'UNTESTED',
        'redundant_with': [], 'spec_defect': None, 'diagnostic_validation': 'UNVERIFIED',
    })

os.makedirs(os.path.join(root, 'docs/investigation-2026-11-26/register'), exist_ok=True)
json.dump(out, open(os.path.join(root, 'docs/investigation-2026-11-26/register/questions.json'), 'w'), indent=1)
from collections import Counter
print(len(out), dict(Counter(o['evidence_class'] for o in out)))
print(dict(Counter(o['evidence_kind'] for o in out)))
print(dict(Counter((o['map_status'], o['evidence_class']) for o in out)))
