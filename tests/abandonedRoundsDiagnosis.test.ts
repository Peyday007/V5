/**
 * The abandoned-rounds diagnosis (dfx_2b21d109a13d) is a research report, and
 * a report is only as good as its weakest claim: every claim must name its
 * source and a failure class from the fixed TRAIL/MAST list, and both of the
 * operator's questions must carry an answer and the claims behind it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FAILURE_CLASSES = [
  'TRAIL_API_ERROR',
  'TRAIL_TIMEOUT',
  'TRAIL_RESOURCE_EXHAUSTION',
  'TRAIL_CONFIGURATION',
  'TRAIL_FORMATTING',
  'TRAIL_CONTEXT_HANDLING',
  'MAST_SYSTEM_DESIGN',
  'MAST_TASK_VERIFICATION',
  'SOURCE_UNREACHABLE',
  'ROUND_CAP_LOGIC',
  'UNATTRIBUTED',
] as const;

const QUESTIONS = ['Q1_FAILURE_POINT', 'Q2_METHOD_RESEARCH_BYPASS'] as const;

interface Claim {
  id: string;
  text: string;
  sourceUrl: string;
  failureClass: string;
}
interface Question {
  id: string;
  question: string;
  answer: string;
  claimIds: string[];
}
interface Report {
  deficiency: string;
  pinnedCommit: string;
  failureClasses: string[];
  questions: Question[];
  claims: Claim[];
}

/** Every problem with a report, empty when it is acceptable. Pure. */
function problems(report: Report): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const claim of report.claims ?? []) {
    if (ids.has(claim.id)) out.push(`${claim.id}: duplicate id`);
    ids.add(claim.id);
    if (!claim.text?.trim()) out.push(`${claim.id}: empty text`);
    if (typeof claim.sourceUrl !== 'string' || !/^https:\/\/\S+$/.test(claim.sourceUrl)) out.push(`${claim.id}: no sourceUrl`);
    if (!(FAILURE_CLASSES as readonly string[]).includes(claim.failureClass)) out.push(`${claim.id}: unknown failure class ${String(claim.failureClass)}`);
  }
  if (ids.size === 0) out.push('no claims');
  for (const q of QUESTIONS) {
    const answered = (report.questions ?? []).find((one) => one.id === q);
    if (!answered || !answered.answer?.trim()) {
      out.push(`${q}: no answer`);
      continue;
    }
    if (!answered.claimIds?.length) out.push(`${q}: no supporting claims`);
    for (const id of answered.claimIds ?? []) if (!ids.has(id)) out.push(`${q}: cites unknown claim ${id}`);
  }
  return out;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/research/abandonedRoundsDiagnosis.json', import.meta.url)), 'utf8'),
) as Report;

describe('abandoned research rounds diagnosis', () => {
  it('is the report for dfx_2b21d109a13d at the pinned commit', () => {
    expect(fixture.deficiency).toBe('dfx_2b21d109a13d');
    expect(fixture.pinnedCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('declares exactly the fixed failure classes', () => {
    expect([...fixture.failureClasses].sort()).toEqual([...FAILURE_CLASSES].sort());
  });

  it('has a sourced, classified claim behind every answer', () => {
    expect(problems(fixture)).toEqual([]);
  });

  it('cites repository claims only at the pinned commit', () => {
    for (const claim of fixture.claims) {
      if (claim.sourceUrl.startsWith('https://github.com/')) {
        expect(claim.sourceUrl, claim.id).toContain(`/blob/${fixture.pinnedCommit}/`);
      }
    }
  });

  it('refuses a claim without a sourceUrl', () => {
    const broken: Report = { ...fixture, claims: fixture.claims.map((c, i) => (i === 0 ? { ...c, sourceUrl: '' } : c)) };
    expect(problems(broken)).toContain(`${fixture.claims[0]!.id}: no sourceUrl`);
  });

  it('refuses an unknown failure class', () => {
    const broken: Report = { ...fixture, claims: fixture.claims.map((c, i) => (i === 0 ? { ...c, failureClass: 'VIBES' } : c)) };
    expect(problems(broken)).toContain(`${fixture.claims[0]!.id}: unknown failure class VIBES`);
  });

  it('refuses an empty answer to either question', () => {
    for (const q of QUESTIONS) {
      const broken: Report = { ...fixture, questions: fixture.questions.map((one) => (one.id === q ? { ...one, answer: '  ' } : one)) };
      expect(problems(broken)).toContain(`${q}: no answer`);
    }
  });
});
