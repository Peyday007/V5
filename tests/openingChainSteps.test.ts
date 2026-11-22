/**
 * A sale is a whole transaction (`openingSteps`, `openingMember`; completion
 * spec §3a). Planning-reliability baseline, 2026-11-22: every executable plan
 * a sale led read one step, `Sell "…"` — no fulfilment, no collection, no
 * supplier payment, its cost null with "none held", and no evidence, price or
 * owner hours on any step. Each case builds steps with the real builders
 * (`planSteps`) and checks them with the real integrity check; every opening
 * here is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { planIntegrity } from '../server/domain/planIntegrity.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { COLLECTION_COST, openingMember, openingMembers, type OpeningChainMember } from '../server/services/goals/arrangementSteps.ts';
import { planSteps, type MarketTest, type PlanReading, type PlanStep } from '../server/services/goals/plan.ts';
import { integrityInput } from '../server/services/goals/planIntegrityInput.ts';
import { declaredInventory, type CapabilityInventory } from '../server/services/goals/stepExecutor.ts';

const adoption = { source: 'BASELINE' as const, hypothetical: true, reason: 'the reconstruction is flagged' };

function connected(): CapabilityInventory {
  const inv = declaredInventory();
  for (const e of Object.values(inv.entries)) e.state = 'PRESENT';
  return inv;
}

const sale = (id: string, title: string): MarketTest => ({
  opportunityId: id,
  title,
  potentialReach: 1000,
  test: { link: 'CONVERSION', test: `Sell "${title}": offer it to its reachable buyers for an actual sale.`, by: 'BRAIN', blocker: null },
});

const member = (over: Partial<OpeningChainMember> & Pick<OpeningChainMember, 'id' | 'title' | 'fulfils'>): OpeningChainMember => ({
  price: 500,
  directCost: { low: 0, high: 0, standing: 'established' },
  reachCost: { amount: 0, basis: 'reached through an owned channel (email, form, listing): no cash cost per contact, only outreach capacity' },
  cash: { span: { low: 7, high: 7 }, standing: 'proven' },
  evidence: { offer: [over.id, `clm_price_${over.id}`], deliver: [over.id, `clm_fulfil_${over.id}`], collect: [over.id, `clm_days_${over.id}`] },
  ...over,
});

const steps = (members: OpeningChainMember[], daysLeft = 30): PlanStep[] =>
  planSteps({
    adoption,
    reconstruction: null,
    sales: members.map((m) => sale(m.id, m.title)),
    nextTest: null,
    permissionsMissing: [],
    capabilities: connected(),
    daysLeft,
    capital: { allowed: null, currency: 'USD' },
    members: new Map(members.map((m) => [m.id, m])),
  });

const integrity = (s: PlanStep[]) =>
  planIntegrity(integrityInput({ goalId: 'wst_chain', verdict: 'NEEDS_EVIDENCE', summary: 's', acceptance: { status: 'CANDIDATE_ONLY', candidate: null, shortfalls: [] }, steps: s, nextTest: null, portfolio: null } as unknown as PlanReading)).violations;

describe('a sale is sequenced through fulfilment and collection', () => {
  const s = steps([member({ id: 'opp_a', title: 'Compliance workbook', fulfils: { by: 'BRAIN', capability: 'PRODUCE_SPREADSHEET' } })]);

  it('sells, delivers and collects, each following the step before it', () => {
    expect(s.map((x) => x.stage?.stage)).toEqual(['OFFER', 'DELIVER', 'COLLECT']);
    expect(s.map((x) => x.executor?.operation)).toEqual(['SEND_OFFER', 'BRAIN_PRODUCES', 'COLLECT_PAYMENT']);
    expect(s[1]!.dependsOn).toBe(s[0]!.order);
    expect(s[2]!.dependsOn).toBe(s[1]!.order);
  });

  it('every step acts on its opening, names what it rests on, and states a cost from a named source', () => {
    for (const x of s) {
      expect(x.openings).toEqual(['opp_a']);
      expect(x.evidence!.length).toBeGreaterThan(0);
      expect(x.cost, x.label).not.toBeNull();
    }
    expect(s[0]!.stage!.costSource).toBe('MODEL');
    expect(s[0]!.detail).toMatch(/owned channel/);
    expect(s[2]!.stage!.costSource).toBe('NOT_OWNERS');
    expect(s[2]!.detail).toContain(COLLECTION_COST);
  });

  it('the selling step carries the price the plan judged it at', () => {
    expect(s[0]!.price).toBe(500);
  });

  it('collection lands on the sale day plus the days to usable cash', () => {
    expect(s[2]!.startDay).toEqual({ low: 7, high: 7 });
    expect(s[2]!.withinLimits).toBe(true);
  });

  it('breaks no integrity rule', () => {
    expect(integrity(s)).toEqual([]);
  });
});

describe('the fulfiller is the one the evidence names', () => {
  it('a subcontractor with a direct cost delivers, and its charge is a payment the owner approves', () => {
    const s = steps([member({ id: 'opp_s', title: 'Courier run', fulfils: { by: 'PROVIDER', name: 'A courier co-op (quoted)' }, directCost: { low: 120, high: 140, standing: 'established' } })]);
    const d = s.find((x) => x.stage?.stage === 'DELIVER')!;
    expect(d.executor).toMatchObject({ performedBy: 'PROVIDER', operation: 'SUPPLIER_DELIVERS', provider: '"A courier co-op (quoted)"' });
    expect(d.executor!.approval.reasons.map((r) => r.kind)).toContain('PAYMENT');
    expect(d.cost).toBe(140);
    expect(d.stage!.costSource).toBe('MODEL');
  });

  it('the owner named as fulfiller performs it, with the hours a deal takes him', () => {
    const s = steps([member({ id: 'opp_o', title: 'On-site styling', fulfils: { by: 'OWNER', hours: 4 } })]);
    const d = s.find((x) => x.stage?.stage === 'DELIVER')!;
    expect(d.executor).toMatchObject({ performedBy: 'OWNER', operation: 'OWNER_TASK', routine: true });
    expect(d.hours).toBe(4);
  });

  it('nobody named is nobody: no performer is claimed', () => {
    const s = steps([member({ id: 'opp_n', title: 'Cleanup', fulfils: { by: 'NOBODY', why: 'nobody is named to fulfil it' } })]);
    expect(s.find((x) => x.stage?.stage === 'DELIVER')!.executor!.performedBy).toBe('NOT_ESTABLISHED');
  });
});

describe('an unknown stays unknown', () => {
  it('a direct cost the model holds no figure for is unestablished, never 0', () => {
    const s = steps([member({ id: 'opp_u', title: 'Workbook', fulfils: { by: 'PROVIDER', name: 'A bookkeeper' }, directCost: null })]);
    const d = s.find((x) => x.stage?.stage === 'DELIVER')!;
    expect(d.cost).toBeNull();
    expect(d.stage!.costSource).toBe('NONE_HELD');
  });

  it('a reach cost nothing holds leaves the sale unestablished, and an unpriced member carries no price', () => {
    const s = steps([member({ id: 'opp_r', title: 'Workbook', fulfils: { by: 'BRAIN', capability: 'PRODUCE_SPREADSHEET' }, reachCost: null, price: null })]);
    expect(s[0]!.cost).toBeNull();
    expect(s[0]!.stage!.costSource).toBe('NONE_HELD');
    expect(s[0]!.price).toBeUndefined();
  });

  it('cash usable only after the deadline is not scheduled as if it settled', () => {
    const s = steps([member({ id: 'opp_l', title: 'Transcripts', fulfils: { by: 'BRAIN', capability: 'PRODUCE_SPREADSHEET' }, cash: { span: { low: 45, high: 60 }, standing: 'proven' } })], 30);
    const c = s.find((x) => x.stage?.stage === 'COLLECT')!;
    expect(c.startDay).toBeNull();
    expect(c.stage!.unscheduled).toBe('AFTER_DEADLINE');
    expect(integrity(s).filter((v) => v.rule === 'STEPS_SCHEDULED')).toEqual([]);
  });
});

describe('several sales', () => {
  const s = steps([
    member({ id: 'opp_1', title: 'Workbook', fulfils: { by: 'BRAIN', capability: 'PRODUCE_SPREADSHEET' }, cash: { span: { low: 20, high: 25 }, standing: 'proven' } }),
    member({ id: 'opp_2', title: 'Retainer', fulfils: { by: 'PROVIDER', name: 'A bookkeeper' }, cash: { span: { low: 3, high: 5 }, standing: 'proven' } }),
  ]);
  it('each opening has its own chain, every label is distinct, and the plan reads in day order', () => {
    expect(new Set(s.map((x) => x.label)).size).toBe(s.length);
    for (const id of ['opp_1', 'opp_2']) expect(s.filter((x) => x.openings?.includes(id)).map((x) => x.stage?.stage).sort()).toEqual(['COLLECT', 'DELIVER', 'OFFER']);
    expect(s.map((x) => x.order)).toEqual(s.map((_, i) => i + 1));
    expect(integrity(s)).toEqual([]);
  });
  it('a sale whose opening the plan holds no facts for keeps its one step', () => {
    const lone = planSteps({ adoption, reconstruction: null, sales: [sale('opp_x', 'Unread')], nextTest: null, permissionsMissing: [], capabilities: connected(), members: new Map() });
    expect(lone.map((x) => x.label)).toEqual(['Sell "Unread"']);
  });
});

describe('a member is read from what the plan judged', () => {
  const input = (value: number | null, provenance: 'EVIDENCE' | 'ASSUMPTION' = 'EVIDENCE', ref = 'clm_x'): ModelInput => ({ value, low: value, high: value, provenance, source: value === null ? null : { kind: 'CLAIM', ref }, note: '' });
  const opening = (over: { fulfillmentOwner?: string | null; requiredCapabilities?: string[] }) =>
    ({
      opportunity: { id: 'cop_m', title: 'Synthetic opening', sourceClaimId: 'clm_src', fulfillmentOwner: over.fulfillmentOwner ?? null, requiredCapabilities: over.requiredCapabilities ?? [] },
      price: input(800, 'EVIDENCE', 'clm_price'),
      directCost: input(90, 'EVIDENCE', 'clm_cost'),
      daysToCash: input(10, 'EVIDENCE', 'clm_days'),
      hours: input(3),
      close: input(null),
      respond: input(null),
      fulfilledBy: null,
      agreedDeals: 1,
    }) as unknown as ModelledOpportunity;
  const pathway = (status: 'PROVEN' | 'UNKNOWN', producedBy: string | null = null) => ({ producedBy, fulfiller: { value: null, low: null, high: null, status, basis: 'who does the work' }, acquisitionCost: { value: 0, low: 0, high: 0, status: 'ESTIMATED' as const, basis: 'owned channel' } });

  it('uses the demand row\'s price and held cost, and the card facts\' claims as evidence', () => {
    const m = openingMember(opening({ fulfillmentOwner: 'A named subcontractor (quoted)' }), pathway('PROVEN') as never, { price: { p10: 700, p50: 800, p90: 900 }, costHeld: { low: 90, high: 90, own: true } });
    expect(m.fulfils).toEqual({ by: 'PROVIDER', name: 'A named subcontractor (quoted)' });
    expect(m.price).toBe(800);
    expect(m.directCost).toEqual({ low: 90, high: 90, standing: 'established' });
    expect(m.reachCost?.amount).toBe(0);
    expect(m.cash?.span).toEqual({ low: 10, high: 10 });
    expect(m.evidence.offer).toEqual(expect.arrayContaining(['cop_m', 'clm_src', 'clm_price', 'cop_m:agreements']));
    expect(m.evidence.deliver).toEqual(expect.arrayContaining(['clm_cost']));
    expect(m.evidence.collect).toEqual(expect.arrayContaining(['clm_days']));
  });

  it('the owner named is the owner, with the model\'s hours', () => {
    expect(openingMember(opening({ fulfillmentOwner: 'The owner, personally' }), pathway('PROVEN') as never, null).fulfils).toEqual({ by: 'OWNER', hours: 3 });
  });

  it('Brain only where its own proved deliverable produces it', () => {
    expect(openingMember(opening({}), pathway('UNKNOWN', 'PRODUCE_SPREADSHEET') as never, null).fulfils).toEqual({ by: 'BRAIN', capability: 'PRODUCE_SPREADSHEET' });
    expect(openingMember(opening({}), pathway('UNKNOWN') as never, null).fulfils.by).toBe('NOBODY');
  });

  it('openingMembers keys each member by its opening', () => {
    const map = openingMembers([opening({})], [{ opportunityId: 'cop_m', ...pathway('UNKNOWN') } as never], []);
    expect([...map.keys()]).toEqual(['cop_m']);
  });
});

describe('a sale beside the plan\'s lead', () => {
  it('stays one step on the plan as a whole — costed and evidenced — so no step acts outside the lead', () => {
    const lead = member({ id: 'opp_lead', title: 'Lead workbook', fulfils: { by: 'BRAIN', capability: 'PRODUCE_SPREADSHEET' } });
    const beside = member({ id: 'opp_beside', title: 'Beside retainer', fulfils: { by: 'PROVIDER', name: 'A bookkeeper' } });
    const s = planSteps({
      adoption,
      reconstruction: null,
      sales: [sale(lead.id, lead.title), sale(beside.id, beside.title)],
      nextTest: null,
      permissionsMissing: [],
      capabilities: connected(),
      daysLeft: 30,
      members: new Map([lead, beside].map((m) => [m.id, m])),
      lead: ['opp_lead'],
    });
    const other = s.find((x) => x.label === 'Sell "Beside retainer"')!;
    expect(other.openings).toBeUndefined();
    expect(other).toMatchObject({ cost: 0, stage: { stage: 'OFFER', costSource: 'MODEL' } });
    expect(other.evidence).toContain('opp_beside');
    expect(s.filter((x) => x.openings?.includes('opp_lead')).map((x) => x.stage?.stage)).toEqual(['OFFER', 'DELIVER', 'COLLECT']);
    const violations = planIntegrity(
      integrityInput({ goalId: 'wst_chain', verdict: 'NEEDS_EVIDENCE', summary: 's', acceptance: { status: 'CANDIDATE_ONLY', candidate: { label: 'Lead workbook', opportunityIds: ['opp_lead'] }, shortfalls: [] }, steps: s, nextTest: null, portfolio: null } as unknown as PlanReading),
    ).violations;
    expect(violations).toEqual([]);
  });
});
