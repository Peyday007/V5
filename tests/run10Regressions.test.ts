/**
 * Acceptance run 10 (frozen a5412ec) failures, kept as regressions on the real published revisions archived in
 * docs/planning-session-reliability-2026-11-26/run10-acceptance, with matched controls.
 *
 * - am-03 (raw-objective discovery): a NO_PLAN whose test sold owner-built websites (bids, deposits) while the owner's
 *   ability to fulfil them was unestablished, with per-opening arithmetic for only some openings. Brain's checker
 *   accepted it; it now refuses both (`FULFILMENT_UNESTABLISHED`, `ARITHMETIC_UNSTATED`).
 * - al-08 (objective changed to forklift training): graded UNJUSTIFIED_REFUSAL against a rubric expecting EXECUTABLE.
 *   An independent adjudication (rubric-adjudication-al08.md) found the rubric assumed a trainer capacity the record
 *   does not state, so the CONDITIONAL plan's FULFILMENT test was correct. It also found a separate plan defect: the
 *   bowling opening the change put out of scope appears in no structured field. The original grade is reproduced
 *   unchanged here; the corrected rubric is graded beside it, never in its place.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRevision, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';
import { observeSession } from '../bench/planningReliability/session.ts';
import { grade } from '../bench/planningReliability/grade.ts';
import { caseAtStep, type PlanningCase } from '../bench/planningReliability/case.ts';

const RUN10 = 'docs/planning-session-reliability-2026-11-26/run10-acceptance';
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(`${RUN10}/${f}`, 'utf8')) as T;
interface State { contract: GoalContract; final: { plan: PlanRevisionInput } }
const brainFor = (ids: string[]): BrainFacts => ({ admittedOpportunityIds: ids, integrity: [], completed: true, error: null });
const codes = (s: State, plan: PlanRevisionInput, ids: string[]) => checkRevision(s.contract, plan, brainFor(ids), '2026-11-27').map((p) => p.code);

describe('run 10 am-03: a limitation that sells before fulfilment is established, without per-opening arithmetic', () => {
  const s = read<State>('published/d03.state.json');
  const plan = s.final.plan;
  const ids = (plan.chain ?? []).map((c) => c.opportunityId);

  it('the published revision is refused: its test measures CONVERSION on openings whose FULFILMENT is unestablished, and the arithmetic per opening is unstated', () => {
    const c = codes(s, plan, ids);
    expect(c).toContain('FULFILMENT_UNESTABLISHED');
    expect(c).toContain('ARITHMETIC_UNSTATED');
  });

  it('control: the same limitation passes once its test measures fulfilment and each opening states its figures, unknowns as null', () => {
    const fixed: PlanRevisionInput = {
      ...plan,
      resolves: [...(plan.resolves ?? []), 'FULFILMENT'],
      // Every link is unestablished on every opening here, so every figure is honestly unknown.
      members: ids.map((opportunityId) => ({ opportunityId, deals: null, price: null, directCost: null, capital: null, settlesDay: null })),
    };
    const c = codes(s, fixed, ids);
    expect(c).not.toContain('FULFILMENT_UNESTABLISHED');
    expect(c).not.toContain('ARITHMETIC_UNSTATED');
  });

  it('control: a known figure may not be dropped as unknown, and deals at a known price must carry the target', () => {
    const established = { ...plan, chain: (plan.chain ?? []).map((c, i) => (i === 0 ? { ...c, missing: c.missing.filter((l) => l !== 'OFFER_AND_PRICE') } : c)) };
    const base = ids.map((opportunityId) => ({ opportunityId, deals: null, price: null, directCost: null, capital: null, settlesDay: null }));
    expect(codes(s, { ...established, resolves: [...(plan.resolves ?? []), 'FULFILMENT'], members: base }, ids)).toContain('ARITHMETIC_UNSTATED');
    const short = base.map((m, i) => (i === 0 ? { ...m, price: 500, deals: 10 } : m));
    expect(checkRevision(s.contract, { ...established, resolves: [...(plan.resolves ?? []), 'FULFILMENT'], members: short }, brainFor(ids), '2026-11-27').some((p) => p.code === 'ARITHMETIC_UNSTATED' && /do not carry/.test(p.detail))).toBe(true);
    const enough = base.map((m, i) => (i === 0 ? { ...m, price: 500, deals: 24 } : m));
    expect(codes(s, { ...established, resolves: [...(plan.resolves ?? []), 'FULFILMENT'], members: enough }, ids)).not.toContain('ARITHMETIC_UNSTATED');
  });
});

describe('run 10 al-08: the objective change, the trainer schedule and every opening accounted for', () => {
  const s = read<State>('published/a08.state.json');
  const plan = s.final.plan;
  const inputs = read<{ keys: Record<string, string>; run: never }>('grading-inputs/a08.json');
  const keyOf = (id: string) => inputs.keys[id] ?? id;
  const idOf = (key: string) => Object.entries(inputs.keys).find(([, k]) => k === key)![0];
  const c = read<PlanningCase[]>('cases/cases.json').find((x) => x.id === 'al-08-forklift-objective-change')!;
  const graded = caseAtStep(c, 1)!;
  const o = observeSession(plan, inputs.run, keyOf);

  it('reproduces the recorded grade unchanged: UNJUSTIFIED_REFUSAL against the rubric as written', () => {
    const g = grade(graded, o);
    expect(g.pass).toBe(false);
    expect(g.failures).toEqual(['UNJUSTIFIED_REFUSAL']);
    expect(g.e2e.failures).toContain('OPENING_UNACCOUNTED');
  });

  it('against the adjudicated rubric (trainer capacity unknown, FULFILMENT decisive) the verdict is correct and the unaccounted bowling opening still fails end to end', () => {
    const corrected: PlanningCase = { ...graded, expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['FULFILMENT'], opening: 'forklift' }, mustNotUse: ['bowling', 'forkliftAudit'], capitalMax: 0 } };
    const g = grade(corrected, o);
    expect(g.pass).toBe(true);
    expect(g.e2e.failures).toEqual(['OPENING_UNACCOUNTED']);
  });

  it("Brain's checker now refuses the out-of-scope bowling opening left unaccounted, and accepts it set aside with its reason", () => {
    const ids = Object.keys(inputs.keys);
    expect(codes(s, plan, ids)).toContain('OPENING_UNACCOUNTED');
    const accounted = { ...plan, excluded: [...(plan.excluded ?? []), { opportunityId: idOf('bowling'), why: 'outside the changed objective: the owner names forklift operator training only' }] };
    expect(codes(s, accounted, ids)).not.toContain('OPENING_UNACCOUNTED');
  });

  it('controls on the schedule: four sessions whose net-10 payments settle after day 30 are refused as executable; four settling in time pass', () => {
    const member = idOf('forklift');
    const steps: PlanRevisionInput['steps'] = [
      { id: 'reach', kind: 'REACH', label: 'confirm the four signed plants', performer: 'BRAIN', costCents: 0, day: 1, dependsOn: null, evidence: ['signed orders'] },
      { id: 'order', kind: 'ORDER', label: 'book the trainer', performer: 'BRAIN', costCents: 0, day: 1, dependsOn: 'reach', evidence: ['trainer quote'] },
      { id: 'deliver', kind: 'DELIVER', label: 'trainer delivers four sessions, paid on completion', performer: 'Dale Ruiz', costCents: 208_000, day: 4, dependsOn: 'order', evidence: ['trainer quote'] },
      { id: 'collect', kind: 'COLLECT', label: 'collect net-10 invoices', performer: 'BRAIN', costCents: 0, day: 14, dependsOn: 'deliver', evidence: ['signed orders'] },
    ];
    const sessions = (days: number[]): PlanRevisionInput['cash'] => days.flatMap((d) => [
      { day: d + 10, kind: 'RECEIPT' as const, amountCents: 95_000, label: `session day ${d} paid net 10`, settlesDay: d + 10 },
      { day: d + 10, kind: 'SPEND' as const, amountCents: 52_000, label: `trainer for day ${d}`, stepId: 'deliver' },
    ]);
    const executable = (days: number[]): PlanRevisionInput => ({
      ...plan, stance: 'EXECUTABLE', strategy: { ...plan.strategy, opportunityIds: [member] }, steps, cash: sessions(days),
      chain: [{ opportunityId: member, missing: [] }], resolves: [], validation: null, quantities: [], members: undefined,
      excluded: [{ opportunityId: idOf('forkliftAudit'), why: 'price only the owner’s word' }, { opportunityId: idOf('bowling'), why: 'outside the changed objective' }],
    });
    // One session a week from day 4: the fourth settles on day 35.
    const weekly = codes(s, executable([4, 11, 18, 25]), Object.keys(inputs.keys));
    expect(weekly).toContain('COLLECTION_AFTER_DEADLINE');
    expect(weekly).toContain('TARGET_NOT_CARRIED');
    // Two sessions in one early week (capacity the record would have to state): all four settle by day 28.
    const twoAWeek = codes(s, executable([4, 4, 11, 18]), Object.keys(inputs.keys));
    expect(twoAWeek).not.toContain('COLLECTION_AFTER_DEADLINE');
    expect(twoAWeek).not.toContain('TARGET_NOT_CARRIED');
  });
});
