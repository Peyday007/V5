/**
 * The abandoned-rounds diagnosis (dfx_2b21d109a13d) is a research report, and
 * a report is only as good as its weakest claim: every claim must name its
 * source and a failure class from the fixed TRAIL/MAST list, and both of the
 * operator's questions must carry an answer and the claims behind it.
 *
 * A claim is either a FAILURE_POINT — evidence, from the repository, of how
 * these rounds end, carrying the one class it evidences — or CONTEXT (the
 * literature, or a description of where work is routed), which carries no
 * class, so a count of claims per class counts only evidence about the rounds.
 * Literature cannot say how Brain's rounds ended, so a claim sourced outside
 * the repository is always CONTEXT. And every class the bypass answer says
 * method research does or does not escape must be backed by a cited
 * repository claim of that class.
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
  'ROUND_SETTLEMENT',
  'ROUND_CAP_LOGIC',
  'UNATTRIBUTED',
] as const;

const QUESTIONS = ['Q1_FAILURE_POINT', 'Q2_METHOD_RESEARCH_BYPASS'] as const;
const REPOSITORY = 'https://github.com/Peyday007/V5/';

interface Claim {
  id: string;
  kind: 'FAILURE_POINT' | 'CONTEXT';
  text: string;
  sourceUrl: string;
  failureClass: string | null;
}
interface Question {
  id: string;
  question: string;
  answer: string;
  claimIds: string[];
  /** Q2 only: the classes method research escapes, and the ones it still meets. */
  bypasses?: string[];
  doesNotBypass?: string[];
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
    if (claim.kind === 'FAILURE_POINT') {
      if (!(FAILURE_CLASSES as readonly string[]).includes(claim.failureClass ?? '')) out.push(`${claim.id}: unknown failure class ${String(claim.failureClass)}`);
      if (typeof claim.sourceUrl === 'string' && !claim.sourceUrl.startsWith(REPOSITORY)) out.push(`${claim.id}: a failure point sourced outside the repository`);
    } else if (claim.kind === 'CONTEXT') {
      if (claim.failureClass !== null) out.push(`${claim.id}: context carries failure class ${String(claim.failureClass)}`);
    } else out.push(`${claim.id}: unknown kind ${String(claim.kind)}`);
  }
  const byId = new Map((report.claims ?? []).map((claim) => [claim.id, claim]));
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
  const bypass = (report.questions ?? []).find((one) => one.id === 'Q2_METHOD_RESEARCH_BYPASS');
  if (bypass) {
    const asserted = [...(bypass.bypasses ?? []), ...(bypass.doesNotBypass ?? [])];
    if (!bypass.doesNotBypass) out.push('Q2_METHOD_RESEARCH_BYPASS: does not say which classes it does not bypass');
    for (const cls of asserted) {
      if (!(FAILURE_CLASSES as readonly string[]).includes(cls)) out.push(`Q2_METHOD_RESEARCH_BYPASS: unknown failure class ${cls}`);
      const backed = (bypass.claimIds ?? []).some((id) => {
        const claim = byId.get(id);
        return claim?.kind === 'FAILURE_POINT' && claim.failureClass === cls;
      });
      if (!backed) out.push(`Q2_METHOD_RESEARCH_BYPASS: ${cls} asserted without a cited repository claim`);
    }
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

  it('refuses a literature claim tagged as a failure point of these rounds', () => {
    const literature = fixture.claims.find((c) => !c.sourceUrl.startsWith(REPOSITORY))!;
    const broken: Report = {
      ...fixture,
      claims: fixture.claims.map((c) => (c.id === literature.id ? { ...c, kind: 'FAILURE_POINT', failureClass: 'TRAIL_API_ERROR' } : c)),
    };
    expect(problems(broken)).toContain(`${literature.id}: a failure point sourced outside the repository`);
  });

  it('refuses a context claim that carries a failure class', () => {
    const context = fixture.claims.find((c) => c.kind === 'CONTEXT')!;
    const broken: Report = { ...fixture, claims: fixture.claims.map((c) => (c.id === context.id ? { ...c, failureClass: 'MAST_SYSTEM_DESIGN' } : c)) };
    expect(problems(broken)).toContain(`${context.id}: context carries failure class MAST_SYSTEM_DESIGN`);
  });

  it('refuses a bypass verdict on a class no cited repository claim backs', () => {
    for (const cls of ['MAST_TASK_VERIFICATION', 'SOURCE_UNREACHABLE']) {
      const broken: Report = {
        ...fixture,
        questions: fixture.questions.map((q) =>
          q.id === 'Q2_METHOD_RESEARCH_BYPASS'
            ? { ...q, claimIds: q.claimIds.filter((id) => fixture.claims.find((c) => c.id === id)?.failureClass !== cls) }
            : q,
        ),
      };
      expect(problems(broken)).toContain(`Q2_METHOD_RESEARCH_BYPASS: ${cls} asserted without a cited repository claim`);
    }
  });

  it('says which classes method research still meets', () => {
    const q2 = fixture.questions.find((q) => q.id === 'Q2_METHOD_RESEARCH_BYPASS')!;
    expect(q2.doesNotBypass).toEqual(expect.arrayContaining(['MAST_TASK_VERIFICATION', 'SOURCE_UNREACHABLE']));
  });

  it('refuses an empty answer to either question', () => {
    for (const q of QUESTIONS) {
      const broken: Report = { ...fixture, questions: fixture.questions.map((one) => (one.id === q ? { ...one, answer: '  ' } : one)) };
      expect(problems(broken)).toContain(`${q}: no answer`);
    }
  });
});
