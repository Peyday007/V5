/**
 * Acceptance run 15 (frozen 5603727) failures, kept as regressions on the real records archived in
 * docs/planning-session-reliability-2026-11-26/run15-acceptance, with matched controls.
 *
 * av-01, av-04, av-06: each sound opening's price was a directly comparable offer's current listing, with this offer's
 * measured paid conversion. Brain's price reader read "sellers list … at $240" as no exchange shown — while "sell for
 * $180 (listing prices)" read as a sale — so the planner held OFFER_AND_PRICE unestablished ("no single price on the
 * card"), the reviewer then labelled the price NOT_A_PURCHASE, and the plans went conditional. Three repairs:
 * - Brain's reader treats a listed price like a sold one (the listing fee a seller pays, a grant and a wage still don't);
 * - NOT_A_PURCHASE against an established price names what payment it is instead (`nonPurchase`);
 * - av-04 (critical, PAYER_POPULATION_INFLATED): the members rule asked one organisation's single $2,400 order for 2
 *   deals to carry the target alone; a capped opening states `dealsMax`, and the strategy's members carry the target.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPriceEvidence } from '../server/domain/paymentNature.ts';
import { checkRevision, conditionProblems, type BrainFacts, type GoalContract, type PlanRevisionInput, type ReviewCondition } from '../server/domain/sessionPlanning.ts';

const RUN15 = 'docs/planning-session-reliability-2026-11-26/run15-acceptance';
interface Opening { opportunityId: string; links?: { link: string; ok: boolean; basis: string }[]; facts?: { field: string; value: string; kind: string }[] }
const inputs = (w: string) => JSON.parse(fs.readFileSync(`${RUN15}/grading-inputs/${w}.json`, 'utf8')) as { run: { openings: Opening[] } };
interface State { value: { contract: GoalContract; final: { plan: PlanRevisionInput }; revisions: (PlanRevisionInput & { revisionId: string })[]; reviews: { revisionId: string; verdict: string; conditions?: ReviewCondition[] }[] } }
const read = (w: string) => (JSON.parse(fs.readFileSync(`${RUN15}/published/${w}.state.json`, 'utf8')) as State).value;

describe('run 15: a comparable offer’s listed price is read as a price, like a sold one', () => {
  const card = inputs('a01').run.openings.flatMap((o) => o.facts ?? []).find((f) => f.field === 'price' && /list/.test(f.value))!;

  it('a01’s card ("sellers list … a workbook at $240") is read as a sale; Brain’s run had held it unpriced', () => {
    expect(inputs('a01').run.openings.some((o) => o.links?.some((l) => l.link === 'OFFER_AND_PRICE' && !l.ok && l.basis === 'no single price on the card'))).toBe(true);
    expect(readPriceEvidence(card.value)).toMatchObject({ direction: 'SALE', counts: true });
    expect(readPriceEvidence('Comparable workbooks sell for $180 on the association marketplace (listing prices, 2026-11).')).toMatchObject({ direction: 'SALE', counts: true });
  });

  it('controls: a listing fee a seller pays, a grant, a wage and a person’s word still do not count', () => {
    expect(readPriceEvidence('Marketplace sellers pay a $25 listing fee per item.').counts).toBe(false);
    expect(readPriceEvidence('The state program awards each museum a grant of up to $5,000 (listed on the program page).').counts).toBe(false);
    expect(readPriceEvidence('Vineyard harvest workers in the county are paid a $22 hourly wage (state agricultural wage survey, 2026).').counts).toBe(false);
    expect(readPriceEvidence('The owner says shops would pay $250.').counts).toBe(false);
  });
});

describe('run 15: NOT_A_PURCHASE against an established price names the payment it is instead', () => {
  const s = read('a01');
  const review = s.reviews.find((r) => r.verdict === 'REVISE')!;
  const rev = s.revisions.find((r) => r.revisionId === review.revisionId)!;
  const condition = review.conditions![0]!;
  const established = { [condition.opportunityId]: ['OFFER_AND_PRICE'] };
  const facts = Object.fromEntries(inputs('a01').run.openings.map((o) => [o.opportunityId, (o.facts ?? []).map((f) => ({ field: f.field, kind: f.kind }))])) as never;

  it('fleet-1’s condition ("an asking price by competitors", NOT_A_PURCHASE, no payment named) is refused once the price is established', () => {
    expect(condition.defect).toBe('NOT_A_PURCHASE');
    expect(conditionProblems([condition], rev, facts, established).some((p) => /nonPurchase/.test(p))).toBe(true);
  });

  it('controls: naming the payment (a grant) is accepted; with the price unestablished no defect is needed', () => {
    expect(conditionProblems([{ ...condition, nonPurchase: 'GRANT' }], rev, facts, established)).toEqual([]);
    expect(conditionProblems([condition], rev, facts, {})).toEqual([]);
  });
});

describe('run 15, av-04 (critical): one organisation’s single order is one deal', () => {
  const s = read('a04');
  const plan = s.final.plan;
  const brain = (p: PlanRevisionInput): BrainFacts => ({ admittedOpportunityIds: [...new Set([...p.strategy.opportunityIds, ...(p.chain ?? []).map((c) => c.opportunityId), ...(p.excluded ?? []).map((x) => x.opportunityId)])], integrity: [], completed: true, error: null });
  const problems = (p: PlanRevisionInput) => checkRevision(s.contract, p, brain(p), '2026-11-28').filter((x) => x.code === 'ARITHMETIC_UNSTATED');
  const triCounty = 'cop_90bee0c45cb44d318b77';

  it('the published plan modelled 2 deals from the one purchase order; stated as capped at 1, more deals are refused', () => {
    expect(plan.members!.find((m) => m.opportunityId === triCounty)!.deals).toBe(2);
    const capped = { ...plan, members: plan.members!.map((m) => (m.opportunityId === triCounty ? { ...m, dealsMax: 1 } : m)) };
    expect(problems(capped).some((x) => /exceed the 1 its payer population supports/.test(x.detail))).toBe(true);
  });

  it('control: 1 deal at dealsMax 1 is not asked to carry the target alone; the members together carry it', () => {
    const one = { ...plan, members: plan.members!.map((m) => (m.opportunityId === triCounty ? { ...m, deals: 1, dealsMax: 1 } : m)) };
    expect(problems(one).filter((x) => x.at === triCounty)).toEqual([]);
    // 1 × $2,400 + 7 × $650 = $6,950 ≥ the $4,000 target.
    expect(problems(one).filter((x) => /the strategy's members bring/.test(x.detail))).toEqual([]);
    const short = { ...one, members: one.members!.map((m) => (m.opportunityId === triCounty ? m : { ...m, deals: 1 })) };
    expect(problems(short).some((x) => /the strategy's members bring 3050/.test(x.detail))).toBe(true);
  });
});

describe('production app journey (2026-11-28, 07:50Z): a revision accounts for the goal’s openings, not every one set aside project-wide', () => {
  it('OPENING_UNACCOUNTED reads accountFor (the goal’s own and weighed openings); an excluded opening stays admissible to build on', () => {
    const s = read('a04');
    const plan = s.final.plan;
    const own = [...new Set([...plan.strategy.opportunityIds, ...(plan.chain ?? []).map((c) => c.opportunityId), ...(plan.excluded ?? []).map((x) => x.opportunityId)])];
    const projectWide = Array.from({ length: 514 }, (_, i) => `cop_setaside_${i}`);
    const brain = (accountFor?: string[]): BrainFacts => ({ admittedOpportunityIds: [...own, ...projectWide], integrity: [], completed: true, error: null, ...(accountFor ? { accountFor } : {}) });
    const unaccounted = (b: BrainFacts) => checkRevision(s.contract, plan, b, '2026-11-28').filter((x) => x.code === 'OPENING_UNACCOUNTED');
    // Before: every project-wide exclusion was owed an entry (production: 539 problems).
    expect(unaccounted(brain())).toHaveLength(514);
    expect(unaccounted(brain(own))).toEqual([]);
    // Control: an own opening left out is still refused, and building on a set-aside one is still admitted.
    expect(unaccounted(brain([...own, 'cop_goal_own_missing']))).toHaveLength(1);
    const onSetAside = { ...plan, strategy: { ...plan.strategy, opportunityIds: [...plan.strategy.opportunityIds, projectWide[0]!] } };
    expect(checkRevision(s.contract, onSetAside, brain(own), '2026-11-28').filter((x) => x.code === 'OPPORTUNITY_NOT_ADMITTED')).toEqual([]);
  });
});

describe('production app journey (2026-11-28, 06:24Z-07:05Z): research and revisions under the names callers send', () => {
  it('a research claim is read under snake_case and alternative names, and one naming no source or passage is refused by name', async () => {
    const { claimArg } = await import('../server/mcp/planningTools.ts');
    // The app's 05:54Z call (snake_case) and 05:53Z call (excerpt/locator), recorded as NO_URL and NO_EVIDENCE.
    expect(claimArg({ claim: 'c', source_url: 'https://a.example/p', evidence_excerpt: 'q', evidence_locator: 'step 2', primary_source: true })).toMatchObject({ sourceUrl: 'https://a.example/p', evidenceExcerpt: 'q', evidenceLocator: 'step 2', primarySource: true });
    expect(claimArg({ claim: 'c', sourceUrl: 'https://a.example/p', excerpt: 'q', locator: 'FAQ' })).toMatchObject({ evidenceExcerpt: 'q', evidenceLocator: 'FAQ' });
    expect(claimArg({ claim: 'c', sourceUrl: 'https://a.example/p', passage: 'q', location: 'FAQ' })).toMatchObject({ evidenceExcerpt: 'q', evidenceLocator: 'FAQ' });
    expect(() => claimArg({ claim: 'c', sourceUrl: 'https://a.example/p' }, 2)).toThrow(/claims\[2\] needs evidenceExcerpt/);
    expect(() => claimArg({ claim: 'c', excerpt: 'q', locator: 'x' })).toThrow(/sourceUrl/);
  });

  it('the two submits that failed with server errors (req_qCqbFo-03WGw, req_C9v7E4pD0d3o) are refused by path', async () => {
    const { shapeProblems } = await import('../server/services/planning/sessionPlanning.ts');
    for (const f of ['req_qCqbFo-03WGw', 'req_C9v7E4pD0d3o']) {
      const input = JSON.parse(fs.readFileSync(`tests/fixtures/appJourney/${f}.input.json`, 'utf8')) as { revision: Record<string, unknown> };
      const p = shapeProblems(input.revision as never);
      expect(p).toContain('steps[0].kind is required');
      expect(p).toContain('validation.stop must be array');
    }
  });
});
