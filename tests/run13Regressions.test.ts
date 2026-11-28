/**
 * Acceptance run 13 (frozen df922b3) discovery failure as-02 (d02), kept as regressions on the real published revision
 * archived in docs/planning-session-reliability-2026-11-26/run13-acceptance, with matched controls.
 *
 * as-02, $6,000 in 30 days with $500 and 4 owner hours a week:
 * - the plan marked the SBA count of 36,207,130 US small businesses EVIDENCED and argued the buyer pool was "not the
 *   constraint", although Brain's evidence gate had rejected that claim for its population and definitions;
 * - two of its three openings stated no owner hours, so none could be compared with the hours the goal allows.
 * Both are now Brain's checks: `REJECTED_EVIDENCE_USED`, and `ARITHMETIC_UNSTATED` asking each member's `ownerHours`
 * under an owner-hours limit.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRevision, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';

const RUN13 = 'docs/planning-session-reliability-2026-11-26/run13-acceptance';
interface State { value: { contract: GoalContract; final: { plan: PlanRevisionInput } } }
const read = (w: string) => (JSON.parse(fs.readFileSync(`${RUN13}/published/${w}.state.json`, 'utf8')) as State).value;
const SBA = 'https://advocacy.sba.gov/2026/02/03/advocacy-releases-frequently-asked-questions-about-small-businesses-2026/';
// The gate's recorded reason for the SBA claim in the d02 world.
const SBA_REASON = 'Scope does not match on population (mismatch vs "local small-business owner with an outdated or missing website"), definitions (mismatch).';
const brainFor = (plan: PlanRevisionInput, over: Partial<BrainFacts> = {}): BrainFacts => ({
  admittedOpportunityIds: [...new Set([...plan.strategy.opportunityIds, ...(plan.chain ?? []).map((c) => c.opportunityId), ...(plan.excluded ?? []).map((x) => x.opportunityId)])],
  integrity: [], completed: true, error: null, ...over,
});
const codes = (w: string, over: Partial<BrainFacts>, edit: (p: PlanRevisionInput) => PlanRevisionInput = (p) => p) => {
  const s = read(w);
  const plan = edit(structuredClone(s.final.plan));
  return checkRevision(s.contract, plan, brainFor(plan, over), '2026-11-28');
};

describe('run 13, as-02: evidence Brain’s gate rejected is not evidence', () => {
  it('the published d02 plan marks the gate-rejected SBA count EVIDENCED, and is refused', () => {
    const buyers = read('d02').final.plan.quantities.find((q) => q.name === 'buyers')!;
    expect(buyers.status).toBe('EVIDENCED');
    const p = codes('d02', { rejectedSources: { [SBA]: SBA_REASON } }).filter((x) => x.code === 'REJECTED_EVIDENCE_USED');
    expect(p).toHaveLength(1);
    expect(p[0]!.at).toBe('buyers');
    expect(p[0]!.detail).toContain('Scope does not match on population');
  });

  it('controls: the same quantity as an ESTIMATE passes; a quantity also resting on accepted evidence passes; no rejected source, no problem', () => {
    const asEstimate = (p: PlanRevisionInput) => ({ ...p, quantities: p.quantities.map((q) => (q.name === 'buyers' ? { ...q, status: 'ESTIMATE' as const } : q)) });
    expect(codes('d02', { rejectedSources: { [SBA]: SBA_REASON } }, asEstimate).filter((x) => x.code === 'REJECTED_EVIDENCE_USED')).toEqual([]);
    const alsoAccepted = (p: PlanRevisionInput) => ({
      ...p,
      sources: [...p.sources, { ...p.sources[0]!, id: 'src_accepted', url: 'https://example.org/accepted-count' }],
      quantities: p.quantities.map((q) => (q.name === 'buyers' ? { ...q, sources: [...q.sources, 'src_accepted'] } : q)),
    });
    expect(codes('d02', { rejectedSources: { [SBA]: SBA_REASON } }, alsoAccepted).filter((x) => x.code === 'REJECTED_EVIDENCE_USED')).toEqual([]);
    expect(codes('d02', {}).filter((x) => x.code === 'REJECTED_EVIDENCE_USED')).toEqual([]);
  });
});

describe('run 13, as-02: under an owner-hours limit every weighed opening states its owner hours', () => {
  const ownerHourGaps = (over: Partial<BrainFacts>, edit?: (p: PlanRevisionInput) => PlanRevisionInput) =>
    codes('d02', over, edit).filter((x) => x.code === 'ARITHMETIC_UNSTATED' && /ownerHours/.test(x.detail));

  it('the published d02 plan, under its 17-hour limit, states no owner hours for its openings, and is refused', () => {
    const plan = read('d02').final.plan;
    expect((plan.members ?? []).every((m) => (m as { ownerHours?: unknown }).ownerHours === undefined)).toBe(true);
    expect(ownerHourGaps({ hoursCeiling: 17 }).length).toBeGreaterThan(0);
  });

  it('controls: with each opening’s owner hours stated it passes; with no hours limit nothing is asked', () => {
    const withHours = (p: PlanRevisionInput) => ({ ...p, members: (p.members ?? []).map((m) => ({ ...m, ownerHours: 10.5 })) });
    expect(ownerHourGaps({ hoursCeiling: 17 }, withHours)).toEqual([]);
    expect(ownerHourGaps({})).toEqual([]);
  });
});

describe('production app journey (2026-11-28, Cash Mode 1): no revision can crash the check', () => {
  it('the two submits that failed with server errors (req_pV0ETX4AxVMv, req_Cq3hdNIVYhto: a validation with no proof) are refused by path', async () => {
    const { shapeProblems } = await import('../server/services/planning/sessionPlanning.ts');
    for (const f of ['submit_034157', 'submit_040143']) {
      const input = JSON.parse(fs.readFileSync(`tests/fixtures/appJourney/${f}.input.json`, 'utf8')) as { revision: Record<string, unknown> };
      expect(shapeProblems(input.revision as never)).toEqual(['validation.proof is required', 'validation.stop is required']);
    }
  });

  it('every revision stored by acceptance runs passes the shape gate (it refuses only what the checks cannot read)', async () => {
    const { shapeProblems } = await import('../server/services/planning/sessionPlanning.ts');
    const root = 'docs/planning-session-reliability-2026-11-26';
    let n = 0;
    for (const run of fs.readdirSync(root)) {
      const dir = `${root}/${run}/published`;
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.state.json'))) {
        const v = (JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')) as { value?: { revisions?: Partial<PlanRevisionInput>[] } }).value;
        for (const r of v?.revisions ?? []) { n += 1; expect(shapeProblems(r), `${run}/${f}`).toEqual([]); }
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('removing or nulling any field of a real published revision is refused by path or checked cleanly, never thrown', async () => {
    const { shapeProblems } = await import('../server/services/planning/sessionPlanning.ts');
    const s = read('d02');
    const base = s.final.plan as unknown as Record<string, unknown>;
    const paths: (string | number)[][] = [];
    const walk = (v: unknown, p: (string | number)[]) => {
      // Fields Brain writes itself (each step's executor, the record's identity) are never the caller's to send.
      if (p.includes('executor') || ['revisionId', 'digest', 'author', 'createdAt'].includes(String(p[0]))) return;
      if (p.length) paths.push(p);
      if (Array.isArray(v)) v.slice(0, 2).forEach((x, i) => walk(x, [...p, i]));
      else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...p, k]);
    };
    walk(base, []);
    expect(paths.length).toBeGreaterThan(100);
    for (const p of paths) {
      for (const mode of ['delete', 'null'] as const) {
        const r = structuredClone(base);
        let o: Record<string | number, unknown> = r;
        for (const k of p.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
        const last = p[p.length - 1]!;
        if (mode === 'delete') { if (Array.isArray(o)) (o as unknown[]).splice(Number(last), 1); else delete o[last]; } else o[last] = null;
        if (shapeProblems(r as never).length) continue;
        // As submitRevision fills an absent or null section (`??`) before the checks run.
        const filled = { stance: 'NO_PLAN', strategy: { title: '', opportunityIds: [], why: '' }, alternatives: [], steps: [], cash: [], proofDay: null, quantities: [], sources: [], validation: null, noPlan: null, reach: null, answers: [], parentRevisionId: null, contractDigest: s.contract.digest, ...Object.fromEntries(Object.entries(r).filter(([, x]) => x !== undefined && x !== null)) } as unknown as PlanRevisionInput;
        expect(() => checkRevision(s.contract, filled, brainFor(filled, { hoursCeiling: 17, rejectedSources: { [SBA]: SBA_REASON } }), '2026-11-28'), `${mode} ${p.join('.')}`).not.toThrow();
      }
    }
  });
});
