/**
 * The completion specification's grader on a plan an app session authored (bench/planningReliability/session.ts):
 * the same `grade` the planner's readings are scored with, reading only the revision's structured fields.
 */
import { describe, expect, it } from 'vitest';
import { PUBLIC_CASES } from '../bench/planningReliability/cases.ts';
import { CRITICAL, grade } from '../bench/planningReliability/grade.ts';
import { observeSession } from '../bench/planningReliability/session.ts';
import type { PlanRevisionInput } from '../server/domain/sessionPlanning.ts';

const caseOf = (id: string) => PUBLIC_CASES.find((c) => c.id === id)!;
const brain = { scope: { targetCents: 500_000, daysLeft: 30, hoursCeiling: null, industry: null, recurring: null, hoursPerWeek: null }, openings: [], excluded: [] };
const keyOf = (id: string) => ({ opp_p: 'property', opp_d: 'dentalReport' })[id] ?? id;

function executable(opp: string, over: Partial<PlanRevisionInput> = {}): PlanRevisionInput {
  return {
    goalId: 'g', contractDigest: 'd', parentRevisionId: null, stance: 'EXECUTABLE',
    strategy: { title: 'sell the spreadsheet', opportunityIds: [opp], why: 'every link evidenced' }, alternatives: [],
    steps: [
      { id: 'reach', kind: 'REACH', label: 'email managers', performer: 'BRAIN', costCents: 0, day: 1, dependsOn: null, evidence: ['s1'] },
      { id: 'collect', kind: 'COLLECT', label: 'collect', performer: 'BRAIN', costCents: 0, day: 5, dependsOn: 'reach', evidence: ['s1'] },
      { id: 'deliver', kind: 'DELIVER', label: 'Brain produces it', performer: 'BRAIN', costCents: 9_000, day: 6, dependsOn: 'collect', evidence: ['s1'] },
    ],
    cash: [{ day: 5, kind: 'RECEIPT', amountCents: 540_000, label: '9 orders', settlesDay: 10 }],
    proofDay: null, quantities: [], sources: [], validation: null, noPlan: null, reach: null, answers: [],
    chain: [{ opportunityId: opp, missing: [] }], members: [{ opportunityId: opp, deals: 9, price: 600, directCost: 10, capital: 0 }], resolves: [],
    ...over,
  };
}

describe('the completion grader on a session-authored plan', () => {
  it('passes a complete, evidenced executable plan on a case that has one', () => {
    const g = grade(caseOf('fam-01-property-executable'), observeSession(executable('opp_p'), brain, keyOf));
    expect(g.pass).toBe(true);
    expect(g.outcome).toBe('EXECUTABLE_PLAN_CORRECT');
  });

  it('fails a plan executed on a price somebody only said as FALSE_EXECUTABLE, a critical failure', () => {
    const g = grade(caseOf('fam-06-dental-price-only-said'), observeSession(executable('opp_d'), { ...brain, scope: { ...brain.scope, targetCents: 300_000 } }, keyOf));
    expect(g.pass).toBe(false);
    expect(g.failures).toContain('FALSE_EXECUTABLE');
    expect(g.failures.some((f) => CRITICAL.has(f))).toBe(true);
  });

  it('passes a no-plan result only when it names the blocker the evidence decides, and refuses a wrong one', () => {
    const noPlan = (missing: string[]): PlanRevisionInput => executable('opp_d', {
      stance: 'NO_PLAN', strategy: { title: 'no plan', opportunityIds: [], why: 'price unestablished' }, steps: [], cash: [], members: [],
      chain: [{ opportunityId: 'opp_d', missing }], noPlan: { decisiveGap: 'price', resolution: 'find a sourced price' }, resolves: missing,
      alternatives: [{ title: 'sell anyway', why: 'no price' }],
    });
    const c = caseOf('fam-06-dental-price-only-said');
    const s = { ...brain, scope: { ...brain.scope, targetCents: 300_000 } };
    expect(grade(c, observeSession(noPlan(['OFFER_AND_PRICE']), s, keyOf)).pass).toBe(true);
    expect(grade(c, observeSession(noPlan(['FULFILMENT']), s, keyOf)).failures).toContain('UNJUSTIFIED_REFUSAL');
  });
});
