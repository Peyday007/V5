/**
 * The independent review of a delivered file, validated exactly.
 *
 * The native check establishes what the bytes are. What it cannot establish is
 * whether the thing is any *use*: whether the summary answers what the person
 * asked, whether a required content is covered in substance rather than in a
 * heading, whether a cited claim actually supports the sentence it is attached
 * to. Those are a reader's judgements, so a session that did not build the file
 * reads the rendered pages and the cited claims and answers against the
 * request's own acceptance conditions.
 *
 * §8's posture at a new artifact: enums matched exactly, an unknown field
 * refuses the whole review, and `PASS` beside a material finding is refused
 * outright rather than read as either.
 */
import { FINDING_SEVERITIES, isMaterial } from '../../domain/deliverables.ts';
import type { DeliverableSpec, FindingSeverity, ReviewFinding, ReviewReport } from '../../domain/deliverables.ts';

export const REVIEW_UNIT_KEY = 'review';

export type ReviewResult = { ok: true; report: ReviewReport } | { ok: false; problems: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateReview(raw: string, spec: DeliverableSpec, gapped: ReadonlySet<number> = new Set()): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['The review was not valid JSON.'] };
  }
  if (!isObject(parsed)) return { ok: false, problems: ['The review was not a structured object.'] };
  const problems: string[] = [];
  const extra = Object.keys(parsed).filter((k) => !['verdict', 'summary', 'findings', 'coverage'].includes(k));
  if (extra.length) problems.push(`The review carries field(s) this contract does not define: ${extra.join(', ')}.`);

  const verdict = parsed['verdict'];
  if (verdict !== 'PASS' && verdict !== 'REPAIR') problems.push('"verdict" must be exactly "PASS" or "REPAIR".');
  const summary = typeof parsed['summary'] === 'string' ? parsed['summary'].trim() : '';
  if (!summary || summary.length > 2000) problems.push('"summary" must say, in at most 2000 characters, whether the file serves its purpose.');

  const findings: ReviewFinding[] = [];
  const rawFindings = parsed['findings'];
  if (!Array.isArray(rawFindings)) problems.push('"findings" must be an array (empty when there is nothing to fix).');
  else
    rawFindings.forEach((f, i) => {
      if (!isObject(f)) {
        problems.push(`findings[${i}] is not an object.`);
        return;
      }
      const ex = Object.keys(f).filter((k) => !['severity', 'about', 'statement', 'repair'].includes(k));
      if (ex.length) problems.push(`findings[${i}] carries field(s) this contract does not define: ${ex.join(', ')}.`);
      const severity = f['severity'];
      if (typeof severity !== 'string' || !(FINDING_SEVERITIES as readonly string[]).includes(severity)) {
        problems.push(`findings[${i}].severity must be one of ${FINDING_SEVERITIES.join(', ')}.`);
        return;
      }
      const about = typeof f['about'] === 'string' ? f['about'].trim() : '';
      const statement = typeof f['statement'] === 'string' ? f['statement'].trim() : '';
      const repair = typeof f['repair'] === 'string' ? f['repair'].trim() : '';
      if (!about || !statement || !repair) {
        problems.push(`findings[${i}] needs "about", "statement" and "repair" — what it concerns, what is wrong, and what would fix it.`);
        return;
      }
      findings.push({
        severity: severity as FindingSeverity,
        about: about.slice(0, 300),
        statement: statement.slice(0, 2000),
        repair: repair.slice(0, 2000),
      });
    });

  const coverage: ReviewReport['coverage'] = [];
  const rawCoverage = parsed['coverage'];
  if (!Array.isArray(rawCoverage)) problems.push('"coverage" must be an array with one entry per required content.');
  else {
    rawCoverage.forEach((c, i) => {
      if (!isObject(c)) {
        problems.push(`coverage[${i}] is not an object.`);
        return;
      }
      const n = c['requiredContent'];
      const met = c['met'];
      const note = typeof c['note'] === 'string' ? c['note'].trim().slice(0, 1000) : '';
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= spec.requiredContents.length) {
        problems.push(`coverage[${i}].requiredContent must be 0 to ${spec.requiredContents.length - 1}.`);
        return;
      }
      if (typeof met !== 'boolean') {
        problems.push(`coverage[${i}].met must be true or false.`);
        return;
      }
      coverage.push({ requiredContent: n, met, note });
    });
    const seen = new Set(coverage.map((c) => c.requiredContent));
    const missing = spec.requiredContents.map((_r, n) => n).filter((n) => !seen.has(n));
    if (missing.length) problems.push(`coverage has no entry for required content(s) ${missing.join(', ')}.`);
  }

  if (problems.length === 0 && verdict === 'PASS') {
    const material = findings.filter((f) => isMaterial(f.severity));
    if (material.length) problems.push(`A PASS verdict cannot carry ${material.length} BLOCKER or MAJOR finding(s). Either the file passes or it needs repair.`);
    const unmet = coverage.filter((c) => !c.met && !gapped.has(c.requiredContent));
    if (unmet.length) problems.push(`A PASS verdict says required content(s) ${unmet.map((c) => c.requiredContent).join(', ')} are not met and were not declared as gaps.`);
  }
  if (problems.length === 0 && verdict === 'REPAIR' && !findings.some((f) => isMaterial(f.severity))) {
    problems.push('A REPAIR verdict must name at least one BLOCKER or MAJOR finding, so the repair has something to fix.');
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, report: { verdict: verdict as 'PASS' | 'REPAIR', summary, findings, coverage } };
}
