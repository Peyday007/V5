"""Blind grading. For each question, the answers of every model are shuffled under
anonymous letters and given, with the predetermined key, to a fresh grader
process (Claude Code headless, no tools, no settings, no repository context).
The grader never sees a model name. Usage: python3 exam/grade.py RESULTS_DIR OUT.json
"""
import json, random, subprocess, sys, re, concurrent.futures as cf, pathlib

res_dir, out = pathlib.Path(sys.argv[1]), sys.argv[2]
key = {k['id']: k for k in json.load(open(pathlib.Path(__file__).parent / 'key.json'))}
qs = {q['id']: q for q in json.load(open(pathlib.Path(__file__).parent / 'questions.json'))['questions']}
runs = {}
for f in sorted(res_dir.glob('*.json')):
    d = json.load(open(f)); runs[d['label']] = {r['id']: r for r in d['results']}

def answer(rec):
    a = next((x for x in rec['attempts'] if x.get('ok')), None)
    if not a: return None
    text = a['content']
    if a.get('finish_reason') == 'length': text += '\n[NOTE TO GRADER: this answer was cut off at the token limit]'
    fu = rec.get('followup')
    if fu is not None:
        b = next((x for x in fu if x.get('ok')), None)
        text = f"=== TURN 1 ANSWER ===\n{text}\n\n=== TURN 2 ANSWER (after the new evidence) ===\n" + (b['content'] if b else '[NO TURN-2 ANSWER: serving failure]')
    return text

GRADER = """You are an independent examiner grading anonymous answers to a business-reasoning exam question. You do not know which system wrote which answer. Grade strictly against the PREDETERMINED KEY and CRITICAL ERRORS below; reward correct reasoning that reaches the key's conclusions by a different valid route; do not reward length or style. Arithmetic within the key's stated tolerances is correct. If an answer was cut off, grade what is there.

QUESTION:
{q}

PREDETERMINED KEY (grader only):
{k}

CRITICAL ERRORS (any one present => "correct": false):
{c}

ANSWERS:
{answers}

For EACH answer letter, return a JSON object. Dimensions are scored 0, 1 or 2 (2 = fully right), or null when the question does not exercise them:
- reasoning: correctness of logic and arithmetic
- commercial: commercial feasibility/realism of what it concludes or proposes
- evidence: correct interpretation of the supplied facts/sources (no misreading, no treating assumptions as facts)
- constraints: preservation of every owner constraint, and no invented restrictions
- strategy: quality of strategy generation/selection (null if the question does not ask for one)
- revision: quality of revision after new evidence (only for questions with a turn 2 or a "new evidence" revision task; else null)
- format: followed the requested output and answered every part
Also give: "score" 0-10 overall against the key; "correct": true only if score >= 7 AND no critical error; "critical_errors": list of the critical errors present (verbatim from the list); "constraint_violations", "evidence_errors", "unsupported_assumptions": short lists of specific instances (empty if none); "worst_failure": one sentence quoting or paraphrasing the most serious reasoning failure, or "" if none.

Reply with ONLY a JSON object: {{"A": {{...}}, "B": {{...}}, ...}} for the letters given."""

def grade(qid):
    labels = [l for l in runs if answer(runs[l][qid]) is not None]
    rnd = random.Random(f"exam-{qid}"); order = labels[:]; rnd.shuffle(order)
    letters = {chr(65 + i): l for i, l in enumerate(order)}
    body = "\n\n".join(f"----- ANSWER {L} -----\n{answer(runs[l][qid])}" for L, l in letters.items())
    qtext = qs[qid]['prompt'] + (f"\n\n[TURN 2 GIVEN TO THE ANSWERER]\n{qs[qid]['followup']}" if qs[qid]['followup'] else '')
    prompt = GRADER.format(q=qtext, k=key[qid]['key'], c="\n".join("- " + c for c in key[qid]['critical']), answers=body)
    for attempt in range(3):
        p = subprocess.run(['claude', '-p', prompt, '--model', 'opus', '--output-format', 'json', '--tools', '',
                            '--strict-mcp-config', '--setting-sources', '', '--system-prompt',
                            'You are a rigorous, impartial exam grader. Output only JSON.'],
                           capture_output=True, text=True, timeout=900, cwd='/tmp')
        try:
            txt = json.loads(p.stdout)['result']
            g = json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
            graded = {letters[L]: v for L, v in g.items() if L in letters}
            if len(graded) == len(letters):
                print(qid, {l: (v.get('score'), v.get('correct')) for l, v in graded.items()}, flush=True)
                return qid, {'letters': letters, 'grades': graded}
        except Exception as e:
            err = str(e)
    print(qid, 'GRADER FAILED', flush=True)
    return qid, {'letters': letters, 'grades': {}, 'error': 'grader failed'}

with cf.ThreadPoolExecutor(5) as ex:
    graded = dict(ex.map(grade, sorted(qs)))
json.dump(graded, open(out, 'w'), indent=1)
print('GRADED', len(graded))
