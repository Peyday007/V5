#!/usr/bin/env python3
"""An AgentRx run, as a finding for Hermes' inventory (§109, the operator's register).

Reads what AgentRx wrote for one trajectory and states it in the inventory's
own fields, which Hermes reads through `inventoryDeficiencies` and the director
decides on (`decideIntervention`): engineering only when the cause is
established, research first when it is not.

Confirmed or suspected is decided here, from what AgentRx itself produced, and
never upgraded by wording:

  CONFIRMED  the judge names a failure step and a category other than
             "no error" / "inconclusive", AND the invariant checker recorded a
             code-evaluated (python_check) violation at that same step. Two
             independent stages agree on one step whose text quotes the row it
             came from.  -> status ROOT_CAUSE_CONFIRMED
  SUSPECTED  the judge names a step and category, but no code-evaluated
             violation agrees.                -> status DISCOVERED, the cause
             recorded as suspected, so the director treats it as unestablished
  INCONCLUSIVE  the judge names no failure.    -> DISCOVERED, no cause

The recommended correction and the verification are asked of the same model
(one call through llm_bridge.py) with the trajectory, the judge's verdict and
the violations, and are labelled as proposals: AgentRx localizes and
classifies; it does not prove a fix.

  python3 to_finding.py --run-dir runs/<name> --meta meta.json --bridge llm_bridge.py [--run-url URL] > finding.json
"""

import argparse
import glob
import json
import os
import subprocess
import sys

TAXONOMY = {
    0: "No error predicted",
    1: "Instruction/Plan Adherence Failure",
    2: "Invention of New Information",
    3: "Invalid Invocation",
    4: "Misinterpretation of Tool Output",
    5: "Intent-Plan Misalignment",
    6: "Underspecified User Intent",
    7: "Intent Not Supported",
    8: "Guardrails Triggered",
    9: "System Failure",
    10: "Inconclusive",
}


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def judge_verdict(run_dir):
    data = load(os.path.join(run_dir, "judge_output", "runs", "run1.json"), {})
    results = data.get("detailed_results") if isinstance(data, dict) else data
    for report in results or []:
        for failure in report.get("failures") or []:
            case = failure.get("failure_case")
            try:
                case = int(case)
            except (TypeError, ValueError):
                case = 10
            step = failure.get("step_number")
            try:
                step = int(step) if step is not None else None
            except (TypeError, ValueError):
                step = None
            return {
                "case": case,
                "category": TAXONOMY.get(case, "Inconclusive"),
                "step": step,
                "description": (failure.get("description") or "").strip(),
                "reasoning": failure.get("checklist_reasoning"),
            }
    return None


def violations(run_dir):
    out = []
    for path in glob.glob(os.path.join(run_dir, "checker_results", "*", "violations_*.json")):
        out.extend(load(path, []) or [])
    return out


def ir_steps(run_dir):
    ir = load(os.path.join(run_dir, "trajectory_ir.json"), [])
    traj = ir[0] if isinstance(ir, list) and ir else {}
    steps = {}
    for s in traj.get("steps") or []:
        text = " ".join(sub.get("content", "") for sub in s.get("substeps") or [])
        steps[s.get("index")] = text
    return steps


def ask_model(bridge, meta, verdict, found):
    prompt = (
        "You are given a failed execution of Brain's work queue as a numbered trajectory, the failure step and "
        "category an AgentRx judge chose, and the invariant violations its checker recorded. Propose the smallest "
        "correction to Brain that would prevent this failure, and the verification that would show the correction "
        "worked on production. Ground both in the trajectory: quote row ids. If the trajectory does not establish "
        "what to change, say so in the correction rather than guessing.\n\n"
        f"TRAJECTORY:\n{meta['markdown']}\n\n"
        f"JUDGE: {json.dumps(verdict)}\n\n"
        f"VIOLATIONS: {json.dumps(found[:12])[:6000]}\n\n"
        'Answer with ONLY JSON: {"correction": "<what to change, 2-4 sentences>", '
        '"verification": "<a measurable check on Brain rows after the change, 1-3 sentences>"}'
    )
    try:
        result = subprocess.run([sys.executable, bridge], input=prompt, capture_output=True, text=True, timeout=900)
        text = result.stdout.strip()
        start, end = text.find("{"), text.rfind("}")
        parsed = json.loads(text[start:end + 1]) if start >= 0 and end > start else {}
        return (parsed.get("correction") or "").strip(), (parsed.get("verification") or "").strip()
    except Exception as e:  # the finding is still filed, without a proposal
        print(f"correction call failed: {e}", file=sys.stderr)
        return "", ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--bridge", required=True)
    ap.add_argument("--run-url", default="")
    args = ap.parse_args()

    meta = load(args.meta, {})
    verdict = judge_verdict(args.run_dir)
    found = violations(args.run_dir)
    steps = ir_steps(args.run_dir)

    step = verdict["step"] if verdict else None
    at_step = [v for v in found if step is not None and v.get("step_index") == step]
    coded = [v for v in at_step if v.get("check_type") == "python_check"]
    named = verdict is not None and verdict["case"] not in (0, 10) and step is not None
    if named and coded:
        confidence = "CONFIRMED"
    elif named:
        confidence = "SUSPECTED"
    else:
        confidence = "INCONCLUSIVE"

    correction, verification = ("", "")
    if confidence != "INCONCLUSIVE":
        correction, verification = ask_model(args.bridge, meta, verdict, at_step or found)

    recurrence = int(meta.get("recurrence") or 1)
    severity = "BLOCKING" if recurrence >= 10 else "MAJOR" if recurrence >= 3 else "MINOR"
    quoted = steps.get(step, "") if step is not None else ""
    viol_text = "; ".join(
        f"[{v.get('check_type')}] {v.get('assertion_name')} at step {v.get('step_index')}: {json.dumps(v.get('evidence'))[:300]}"
        for v in (at_step or found)[:6]
    )
    source = f" AgentRx run: {args.run_url}." if args.run_url else ""

    evidence = (
        f"AgentRx (microsoft/AgentRx) on work item {meta.get('workItemId')} (packet {meta.get('packetId')}), "
        f"{meta.get('steps')} steps exported from work_items, work_leases, bin_events and project_events.{source} "
        + (f"Failure step {step}: \"{quoted[:700]}\". " if quoted else "")
        + (f"Judge ({verdict['category']}): {verdict['description'][:600]}. " if verdict else "Judge named no failure. ")
        + (f"Invariant violations: {viol_text}." if viol_text else "No invariant violation recorded.")
    )[:2000]

    if confidence == "CONFIRMED":
        root_cause = f"CONFIRMED by AgentRx (judge and code-evaluated invariant agree on step {step}; {verdict['category']}): {verdict['description']}"
    elif confidence == "SUSPECTED":
        root_cause = f"SUSPECTED by AgentRx (judge only, step {step}; {verdict['category']}; no code-evaluated invariant agrees): {verdict['description']}"
    else:
        root_cause = None

    finding = {
        "id": meta["findingId"],
        "confidence": confidence,
        "status": "ROOT_CAUSE_CONFIRMED" if confidence == "CONFIRMED" else "DISCOVERED",
        "capability": f"Brain work queue: {meta.get('workType')}",
        "symptom": (
            f"{meta.get('workType')} work items fail with {meta.get('failureCategory') or 'FAILED'} "
            f"({recurrence} in the last 7 days); diagnosed example {meta.get('workItemId')}, failed {meta.get('failedAt')}."
        ),
        "evidence": evidence,
        "root_cause": root_cause[:1500] if root_cause else None,
        "severity": severity,
        "verification_criteria": (
            (f"Proposed by AgentRx's model: {verification} " if verification else "")
            + f"And: no new {meta.get('workType')} item fails with {meta.get('failureCategory') or 'FAILED'} in the 24 hours after the fix is live, "
            + "and a fresh AgentRx run on the next failure of this class does not name the same step."
        )[:1500],
        "note": (
            f"AgentRx diagnosis ({confidence}). Proposed correction: {correction}" if correction
            else f"AgentRx diagnosis ({confidence}); no correction proposed."
        )[:1500],
        "failedAt": meta.get("failedAt"),
        "agentrx": {"verdict": verdict, "violationsAtStep": len(at_step), "codeViolationsAtStep": len(coded), "violations": len(found)},
    }
    json.dump(finding, sys.stdout, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
