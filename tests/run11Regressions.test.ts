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
