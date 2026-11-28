/**
 * Acceptance run 14 (frozen 5519919) discovery failures, kept as regressions on the real published revisions archived in
 * docs/planning-session-reliability-2026-11-26/run14-acceptance, with matched controls.
 *
 * au-01 (d01), CRITICAL: the plan's only member was a platform's published hourly pay for evaluation work the owner
 * performs — a wage, not a price a buyer pays for an offer (COMPLETION-SPEC §3). Brain's checker now refuses it
 * (`WAGE_AS_PRICE`) where the opening's card states its revenue as hourly pay and the owner does the work.
 * au-03 (d03): the test scheduled 3.5 owner hours in week 1 against "2 hours a week, no more"; the checker compared
 * only the window's total. A weekly allowance now binds each week (`OWNER_HOURS_OVER`).
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRevision, wageWording, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';

const RUN14 = 'docs/planning-session-reliability-2026-11-26/run14-acceptance';
interface State { value: { contract: GoalContract; final: { plan: PlanRevisionInput } } }
const read = (w: string) => (JSON.parse(fs.readFileSync(`${RUN14}/published/${w}.state.json`, 'utf8')) as State).value;
const brainFor = (plan: PlanRevisionInput, over: Partial<BrainFacts> = {}): BrainFacts => ({
  admittedOpportunityIds: [...new Set([...plan.strategy.opportunityIds, ...(plan.chain ?? []).map((c) => c.opportunityId), ...(plan.excluded ?? []).map((x) => x.opportunityId)])],
  integrity: [], completed: true, error: null, ...over,
});
const codes = (w: string, over: Partial<BrainFacts>, code: string, edit: (p: PlanRevisionInput) => PlanRevisionInput = (p) => p) => {
  const s = read(w);
  const plan = edit(structuredClone(s.final.plan));
  return checkRevision(s.contract, plan, brainFor(plan, over), '2026-11-28').filter((x) => x.code === code);
};

describe('run 14, au-01 (critical): pay for the owner’s own hours is a wage, not a purchase price', () => {
  const ctx = JSON.parse(fs.readFileSync(`${RUN14}/grading-inputs/d01.context.json`, 'utf8')) as { value: { openings: { id: string; facts: { field: string; value: string }[] }[] } };
  const plan = read('d01').final.plan;
  const id = plan.strategy.opportunityIds[0]!;
  const card = ctx.value.openings.find((o) => o.id === id)!;
  const revenue = card.facts.filter((f) => ['price', 'revenueRange', 'offer', 'captureMechanism'].includes(f.field)).map((f) => f.value).join(' ');

  it('the published plan’s only opening is described by its own card as hourly pay, and the owner does the work: refused', () => {
    expect(wageWording(revenue)).toBe(true);
    const owner = { [id]: { by: 'OWNER' as const, name: null, capability: null, capabilityState: null } };
    const p = codes('d01', { wagePriced: [id], fulfilment: owner }, 'WAGE_AS_PRICE');
    expect(p).toHaveLength(1);
    expect(p[0]!.detail).toMatch(/a wage, not a price a buyer pays/);
  });

  it('controls: an hourly service sold to buyers, a workbook price and a wage the owner does not earn are not refused', () => {
    expect(wageWording('Owner-led tutoring sold to parents at $50 per hour (published rate card)')).toBe(false);
    expect(wageWording('Comparable workbooks sell for $180 on the association store')).toBe(false);
    const supplier = { [id]: { by: 'PROVIDER' as const, name: 'a contractor', capability: null, capabilityState: null } };
    expect(codes('d01', { wagePriced: [id], fulfilment: supplier }, 'WAGE_AS_PRICE')).toEqual([]);
    expect(codes('d01', {}, 'WAGE_AS_PRICE')).toEqual([]);
  });
});

describe('run 14, au-03: a weekly owner-hours allowance binds every week', () => {
  it('the published d03 test gives the owner 3.5 hours in week 1 against 2 a week: refused', () => {
    expect(read('d03').contract.terms.ownerHoursPerWeek).toBe(2);
    const p = codes('d03', {}, 'OWNER_HOURS_OVER');
    expect(p.some((x) => /week 1 .* gives the owner 3\.5 hours; the goal allows 2 a week/.test(x.detail))).toBe(true);
  });

  it('control: the same hours spread to at most 2 a week pass the weekly rule', () => {
    const spread = (p: PlanRevisionInput) => {
      let used = 0;
      return { ...p, steps: p.steps.map((s) => {
        if (s.performer !== 'OWNER' || typeof s.ownerHours !== 'number') return s;
        const day = Math.floor(used / 2) * 7; used += s.ownerHours;
        return { ...s, day };
      }) };
    };
    expect(codes('d03', {}, 'OWNER_HOURS_OVER', spread).filter((x) => /a week/.test(x.detail))).toEqual([]);
  });
});

describe('production app journey (2026-11-28, 06:00Z): every planning result fits what the app reads in one call', () => {
  it('a planning tool whose value is over the app budget comes back under it, the cuts named; a small one is untouched', async () => {
    const { fitted, APP_RESULT_BUDGET_BYTES } = await import('../server/mcp/planningTools.ts');
    const big = { revisions: Array.from({ length: 300 }, (_, i) => ({ revisionId: `rev_${i}`, note: 'n'.repeat(900) })), currentCheck: { problems: Array.from({ length: 40 }, (_, i) => ({ code: 'OPENING_UNACCOUNTED', detail: `opening ${i}` })) } };
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(158_464);
    const tool = fitted({ name: 't', title: 't', description: 'd', inputSchema: { type: 'object' }, annotations: {} as never, run: async () => ({ projectId: 'p', value: big }) } as never);
    const out = (await tool.run({}, {} as never)) as unknown as { value: { compacted?: string[]; currentCheck: { problems: unknown[] } } };
    expect(Buffer.byteLength(JSON.stringify(out.value))).toBeLessThanOrEqual(APP_RESULT_BUDGET_BYTES);
    expect(out.value.compacted?.length).toBeGreaterThan(0);
    expect(out.value.currentCheck.problems).toHaveLength(40);
    const small = fitted({ name: 's', title: 's', description: 'd', inputSchema: { type: 'object' }, annotations: {} as never, run: async () => ({ projectId: 'p', value: { ok: true } }) } as never);
    expect(((await small.run({}, {} as never)) as { value: unknown }).value).toEqual({ ok: true });
  });
});
