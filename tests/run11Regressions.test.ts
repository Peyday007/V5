/**
 * Acceptance run 11 (frozen e8ef992) discovery failures, kept as regressions on the real published revisions archived in
 * docs/planning-session-reliability-2026-11-26/run11-acceptance, with matched controls.
 *
 * ao-01 (d01) and ao-02 (d02): CONDITIONAL plans whose conversion test passed at 1 paid from 200 (or 150) contacts while
 * continuing to too few contacts for the deals the target needed. Passing the test proved nothing about the goal. Run 9's
 * ak-03 failed the same way. Brain's checker now requires the threshold as a ratio with the plan's reach, and refuses one
 * that cannot carry the members' deals (`PROOF_INSUFFICIENT`).
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRevision, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';

const RUN11 = 'docs/planning-session-reliability-2026-11-26/run11-acceptance';
interface State { value: { contract: GoalContract; final: { plan: PlanRevisionInput } } }
const read = (w: string) => (JSON.parse(fs.readFileSync(`${RUN11}/published/${w}.state.json`, 'utf8')) as State).value;
const brainFor = (plan: PlanRevisionInput): BrainFacts => ({ admittedOpportunityIds: [...new Set([...(plan.chain ?? []).map((c) => c.opportunityId), ...(plan.excluded ?? []).map((x) => x.opportunityId)])], integrity: [], completed: true, error: null });
const problems = (w: string, over: (p: PlanRevisionInput) => PlanRevisionInput = (p) => p) => {
  const s = read(w);
  const plan = over(s.final.plan);
  return checkRevision(s.contract, plan, brainFor(plan), '2026-11-28').filter((p) => p.code === 'PROOF_INSUFFICIENT');
};
const withThreshold = (paid: number, of: number, reach: number) => (p: PlanRevisionInput): PlanRevisionInput => ({ ...p, validation: { ...p.validation!, threshold: { paid, of, reach } } });

describe('run 11: a conversion test proves the goal only if passing it carries the target', () => {
  it('ao-01 and ao-02 as published are refused: their conversion tests state no threshold Brain can check', () => {
    expect(read('d01').final.plan.validation?.decides).toContain('CONVERSION');
    expect(problems('d01').length).toBe(1);
    expect(problems('d02').length).toBe(1);
  });

  it('ao-01 with its own figures (1 paid from 200, continuing to 600 contacts in all: 3 sales against the 4 needed) is refused, naming the threshold that would carry it', () => {
    const p = problems('d01', withThreshold(1, 200, 600));
    expect(p).toHaveLength(1);
    expect(p[0]!.detail).toMatch(/3 sales over the 600 contacts/);
    expect(p[0]!.detail).toMatch(/at least 2 from 200/);
  });

  it('controls: a threshold whose rate over the plan’s reach carries the members’ deals passes (ao-01 at 1 from 200 over 800; ao-02 at 1 from 150 over 1,050)', () => {
    expect(problems('d01', withThreshold(1, 200, 800))).toEqual([]);
    expect(problems('d02', withThreshold(1, 150, 1050))).toEqual([]);
    expect(problems('d02', withThreshold(1, 150, 900))).toHaveLength(1);
  });
});

describe('run 11 (fleet report): a verification call without verdicts or sufficiency is refused, not taken as INSUFFICIENT', () => {
  it('refuses missing or empty verdicts and a missing sufficiency; passes a complete call through unchanged', async () => {
    const { verdictsArg, sufficiencyArg } = await import('../server/mcp/planningTools.ts');
    expect(() => verdictsArg({})).toThrow(/verdicts/);
    expect(() => verdictsArg({ verdicts: [] })).toThrow(/verdicts/);
    expect(() => sufficiencyArg({})).toThrow(/sufficiency/);
    expect(() => sufficiencyArg({ sufficiency: 'maybe' })).toThrow(/sufficiency/);
    expect(verdictsArg({ verdicts: [{ claimId: 'c' }] })).toEqual([{ claimId: 'c' }]);
    expect(sufficiencyArg({ sufficiency: 'INSUFFICIENT' })).toBe('INSUFFICIENT');
  });
});

describe('production app journey (2026-11-28, Cash Mode 1): the planning path answers on a large project', () => {
  it('a malformed revision is refused by path before any check runs (strategy without opportunityIds crashed every submit)', async () => {
    const { shapeProblems } = await import('../server/services/planning/sessionPlanning.ts');
    expect(shapeProblems({ strategy: { title: 'No plan', why: 'w' } as never })).toEqual(['strategy.opportunityIds must be an array of opening ids (empty for a no-plan result)']);
    expect(shapeProblems({ chain: [{ opportunityId: 'o', missing: 'CONVERSION' as never }] })).toHaveLength(1);
    expect(shapeProblems({ strategy: { title: 't', opportunityIds: [], why: 'w' }, chain: [{ opportunityId: 'o', missing: ['CONVERSION'] }], resolves: ['CONVERSION'] })).toEqual([]);
  });

  it('a context over the transport limit is compacted under budget, keeping every id, need and link verdict', async () => {
    const { fitContext } = await import('../server/services/planning/sessionPlanning.ts');
    const long = 'x'.repeat(5_000);
    const opening = (i: number) => ({ opportunityId: `cop_${i}`, title: `opening ${i}`, missing: ['CONVERSION'], links: [{ link: 'CONVERSION', ok: false, basis: 'unmeasured' }], card: { notes: long }, facts: Array.from({ length: 20 }, (_, k) => ({ field: `f${k}`, value: long, kind: 'EVIDENCE' })) });
    const ctx = { goal: { id: 'g' }, openings: [{ id: 'cop_0', title: 'own', facts: [{ field: 'price', value: long, kind: 'EVIDENCE' }] }], brain: { openings: Array.from({ length: 19 }, (_, i) => opening(i)), excluded: Array.from({ length: 10 }, (_, i) => ({ ...opening(100 + i), reason: 'set aside' })) }, questions: [{ needId: 'need_1', opportunityId: 'cop_0', field: 'price', submitted: [{ claimId: 'c1', evidenceExcerpt: long }] }] };
    expect(Buffer.byteLength(JSON.stringify(ctx))).toBeGreaterThan(256 * 1024);
    const fit = fitContext(ctx);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(200 * 1024);
    expect(fit.compacted?.length).toBeGreaterThan(0);
    expect((fit.brain.openings as { opportunityId: string; links: unknown[] }[]).map((o) => o.opportunityId)).toEqual(ctx.brain.openings.map((o) => o.opportunityId));
    expect((fit.brain.openings[3] as { links: unknown[] }).links).toEqual(ctx.brain.openings[3]!.links);
    expect(fit.questions[0]!.needId).toBe('need_1');
    // Production at 30835d5: the goal's own openings (kept in full) and the open questions alone passed the limit, so the
    // context was refused again. The longest lists are now halved until it fits, each cut named.
    const ownHeavy = { goal: { id: 'g' }, openings: Array.from({ length: 400 }, (_, i) => ({ id: `own_${i}`, title: `own ${i}`, facts: Array.from({ length: 12 }, (_, k) => ({ field: `f${k}`, value: 'v'.repeat(100), kind: 'EVIDENCE' })) })), brain: null, questions: Array.from({ length: 900 }, (_, i) => ({ needId: `need_${i}`, opportunityId: `own_${i % 400}`, field: 'price', submitted: [] })) };
    expect(Buffer.byteLength(JSON.stringify(ownHeavy))).toBeGreaterThan(256 * 1024);
    const fitOwn = fitContext(ownHeavy);
    expect(Buffer.byteLength(JSON.stringify(fitOwn))).toBeLessThanOrEqual(200 * 1024);
    expect(fitOwn.compacted?.some((n) => /only the first \d+ of \d+ shown/.test(n))).toBe(true);
    expect(fitOwn.openings[0]!.id).toBe('own_0');
    // A context already under budget is returned unchanged.
    const small = { goal: { id: 'g' }, openings: [], brain: null, questions: [] };
    expect(fitContext(small)).toBe(small);
  });
});
