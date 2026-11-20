/**
 * Owner, 2026-11-20: "An opportunity requires $4,000 of upfront capital. The
 * user's available limit is $3,000. Brain should recognize that the current
 * structure is infeasible. It should also consider whether the structure can
 * be changed: customer prepayment, deposits, alternative fulfillment, supplier
 * terms, staged delivery, reduced working-capital requirements, different
 * transaction roles … If a verified restructuring reduces required exposure
 * to $1,000, Brain can reconsider the opportunity. … This is not permission
 * to invent favorable assumptions."
 *
 * Before this change an opening held out on a limit (NO_FAVOURABLE_UNKNOWN,
 * #1157) carried one generic sentence, no question was sent about any way of
 * restructuring it, and even a stated deposit on its own terms never brought
 * it back: only a reconstruction's `fundedByBuyer` assumption could.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio, restructuringOf, statedPrepayment, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { RESTRUCTURE_ASKS_PER_READ, restructureNeedsOf, sendPortfolioNeeds } from '../server/services/goals/portfolioNeeds.ts';
import { inheritedTerms, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { modelledTiming, timingOfText } from '../server/services/cash/paymentTiming.ts';
import type { SendNeedsInput } from '../server/services/quant/needs.ts';

const fixed = (v: number): ModelInput => ({ value: v, low: v, high: v, provenance: 'EVIDENCE', source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
/** Capital the model estimates from comparable openings (not this opening's own evidence): 4000–4200 at its start. */
const estimatedCapital: ModelInput = {
  value: null,
  low: 4_000,
  high: 4_200,
  provenance: 'UNKNOWN',
  source: null,
  note: 'inferred from comparable openings',
  inferred: { tier: 'COMPARABLE', justified: false, p10: 4_000, p50: 4_100, p90: 4_200, observations: 3 },
};

const ID = 'cop_install';
const TITLE = 'Commercial kitchen equipment install';
function opening(paymentTerms: string | null, over: Partial<ModelledOpportunity> = {}): PlannedOpening {
  return {
    opportunity: { id: ID, title: TITLE, paymentTerms } as unknown as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: false,
    price: fixed(4_000),
    capital: estimatedCapital,
    hours: fixed(4),
    daysToCash: fixed(7),
    close: swept(0.3, 0.6),
    respond: swept(0.05, 0.15),
    directCost: fixed(2_500),
    volume: fixed(1),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  } as PlannedOpening;
}

const LIMITS = { remaining: 10_000, daysLeft: 30, capitalCeiling: 3_000, beforeProof: null, perWeek: null, resources: '40 emails a day', worlds: 400, seed: 7 };
const read = (one: PlannedOpening, remaining = LIMITS.remaining) => {
  const p = evaluateGoalPortfolio({ ...LIMITS, remaining, openings: [one] });
  return { p, d: p.demand.find((x) => x.opportunityId === ID)! };
};

describe('a held-out opening names its restructurings as decision-relevant research (a)', () => {
  it('derives one question per defensible mechanism, each naming the exposure limit, and the plan lists them', () => {
    const { p, d } = read(opening(null));
    expect(d.refused).toBeNull();
    expect(d.heldOut).toMatch(/^held out of every combination: the model estimates it ties up 4000–4200 at its start \(not established\), more than the 3000 this goal may tie up in all — restructure the cash/);
    const r = d.restructure!;
    expect(r).toMatchObject({ kind: 'CAPITAL', exposure: { low: 4_000, high: 4_200 }, limit: 3_000, material: true });
    expect(r.mechanisms.map((m) => m.mechanism)).toEqual(['PREPAYMENT', 'SUPPLIER_TERMS', 'STAGED_DELIVERY', 'BROKER_ROLE', 'CHEAPER_FULFILMENT']);
    for (const m of r.mechanisms) {
      expect(m.question).toContain(TITLE);
      expect(m.question).toMatch(/ties up 4000–4200 before any money comes in, more than the 3000/);
    }
    // The prepayment question names the share the decision needs: (4000 − 3000) / 4000 = 25% of its lowest price.
    expect(r.mechanisms[0]!.question).toMatch(/^Do buyers of "Commercial kitchen equipment install" pay a deposit or prepay before it is delivered, and what share of the price\?/);
    expect(r.mechanisms[0]!.question).toMatch(/At least 25% of its lowest price \(4000\) paid before delivery would bring it within 3000/);
    // The plan's line lists what is being investigated, not a generic sentence.
    expect(d.heldOut).toMatch(/investigating the buyer's prepayment or deposit \(at least 25% of the price before delivery\); supplier terms/);
    expect(d.heldOut).toMatch(/staged delivery.*a broker or referral role instead of principal.*cheaper fulfilment/);
    expect(p.missing.some((m) => m.startsWith(TITLE) && m.includes('investigating'))).toBe(true);
    expect(p.best?.members.map((m) => m.opportunityId) ?? []).not.toContain(ID);
  });

  it('stops expanding where no answer could change the decision', () => {
    // Too small to matter to the goal: nothing asked, and the plan says why.
    const small = read(opening(null), 1_000_000).d;
    expect(small.heldOut).toMatch(/^held out of every combination/);
    expect(small.restructure).toMatchObject({ material: false, mechanisms: [] });
    expect(small.heldOut).toMatch(/not investigated: at most \d+ of the 1000000 still needed, too little for any restructuring to change the plan/);
    // Buyers stated to pay in arrears: prepayment is already answered, so it is not asked; the other mechanisms are.
    const arrears = read(opening('Invoiced net 30 after acceptance')).d.restructure!;
    expect(arrears.mechanisms.map((m) => m.mechanism)).not.toContain('PREPAYMENT');
    expect(arrears.mechanisms.map((m) => m.mechanism)).toContain('BROKER_ROLE');
    // No share of its price could cover the gap: prepayment cannot change the decision, so it is not asked.
    const cheap = restructuringOf(opening(null, { price: fixed(500) }), { kind: 'CAPITAL', exposure: { low: 4_000, high: 4_200 }, limit: 3_000, potential: 5_000, remaining: 10_000 });
    expect(cheap.mechanisms.map((m) => m.mechanism)).not.toContain('PREPAYMENT');
  });

  it('the goal tick sends them keyed by the opening and mechanism (never a figure), capped per read', async () => {
    const { p, d } = read(opening(null));
    const calls: SendNeedsInput[] = [];
    const sendNeeds = (async (input: SendNeedsInput) => {
      calls.push(input);
      return input.needs.map((n) => ({ subject: n.subject, sent: true as const, to: 'RESEARCH_CANDIDATE' as const, ref: 'c', created: true }));
    }) as never;
    const out = await sendPortfolioNeeds({ goalId: 'g1', projectId: 'p1', portfolio: { ...p, causal: null, assurance: null, marketHistory: [] }, unpriced: [] }, { sendNeeds });
    const restructure = calls.filter((c) => c.graphScope === `goal:g1:opening:${ID}`);
    expect(restructure).toHaveLength(RESTRUCTURE_ASKS_PER_READ);
    expect(out.created).toBe(RESTRUCTURE_ASKS_PER_READ);
    for (const c of restructure) {
      expect(c.needs[0]!.route).toBe('RESEARCH');
      expect(c.needs[0]!.subject).not.toMatch(/\d/);
      expect(c.needs[0]!.question).toContain('3000');
    }
    expect(restructure[0]!.needs[0]!.subject).toMatch(/can be restructured within the goal's limit: prepayment$/);
    // Subjects are stable across reads whatever the figures do.
    const moved = restructureNeedsOf({ title: d.title, restructure: { ...d.restructure!, exposure: { low: 9_000, high: 9_900 } } });
    expect(moved.map((n) => n.subject)).toEqual(restructureNeedsOf(d).map((n) => n.subject));
  });
});

describe('evidence of a mechanism re-admits it at the restructured exposure (b)', () => {
  it('a stated 75% deposit brings 4000–4200 down to 1000–1200 inside the 3000 limit', () => {
    const one = opening('Buyers pay a 75% deposit at order, the balance on delivery');
    expect(statedPrepayment(one)).toMatchObject({ share: 0.75, offset: 3_000 });
    const { p, d } = read(one);
    // Reconsidered: it may be a member again, where without the deposit it never is.
    expect(p.best?.members.map((m) => m.opportunityId) ?? []).toContain(ID);
    expect(d.refused).toBeNull();
    expect(d.heldOut).toBeNull();
    expect(d.restructure).toBeNull();
    expect(d.capitalAtStart).toBe(1_200);
    expect(d.cashStructure).toMatch(/^EVIDENCE: .*75% of the price \(at least 3000\) arrives before delivery, so it ties up 1000–1200 at its start/);
    // Still not established: what it ties up stays an unknown the plan reports.
    expect(d.unestablished).toContain('money tied up');
  });

  it('full prepayment stated on its terms: only what exceeds the lowest price is ours', () => {
    const { d } = read(opening('Paid in full up-front at checkout'));
    expect(d.heldOut).toBeNull();
    // 4000–4200 less the whole 4000 lowest price: the estimate's top above the price is still ours, never read away.
    expect(d.capitalAtStart).toBe(200);
    expect(d.cashStructure).toMatch(/^EVIDENCE: .*100% of the price \(at least 4000\) arrives before delivery, so it ties up 0–200 at its start/);
  });

  it('a constructed arrangement keeps its buyers\' stated deposit share, never widened to full prepayment', () => {
    const buyerTerms = timingOfText('Clients pay a 40% deposit at signing, balance on delivery', 'claim c1');
    expect(buyerTerms).toMatchObject({ timing: 'PREPAID', share: 0.4 });
    const terms = inheritedTerms({ buyerTerms });
    expect(terms).toMatch(/^40% paid before delivery/);
    expect(modelledTiming({ opportunity: { id: 'a', title: 'a', paymentTerms: terms }, competitiveAward: false })).toMatchObject({ timing: 'PREPAID', share: 0.4 });
    // A deposit stated with no share is still a deposit, not the whole price.
    const unsized = inheritedTerms({ buyerTerms: timingOfText('A deposit is taken at booking', 'claim c2') });
    expect(modelledTiming({ opportunity: { id: 'a', title: 'a', paymentTerms: unsized }, competitiveAward: false })).toMatchObject({ timing: 'PREPAID', share: null });
    // Full prepayment is carried as before.
    expect(inheritedTerms({ buyerTerms: timingOfText('Paid in full up-front at checkout', 'claim c3') })).toBe("paid in advance, as these buyers' evidence states");
  });
});

describe('without evidence it stays held out: no favourable assumption (c)', () => {
  for (const [label, terms] of [
    ['nothing stated', null],
    ['a deposit stated without its share', 'A deposit is taken at order'],
    ['a deposit too small to bring it within the limit', 'Buyers pay a 10% deposit at order'],
    ['stated arrears', 'Invoiced net 30 after acceptance'],
    ['a competitive award', null],
  ] as const) {
    it(label, () => {
      const one = opening(terms, label === 'a competitive award' ? { competitiveAward: true } : {});
      const { p, d } = read(one);
      expect(d.heldOut).toMatch(/^held out of every combination/);
      expect(d.cashStructure ?? null).toBeNull();
      expect(p.best?.members.map((m) => m.opportunityId) ?? []).not.toContain(ID);
      for (const alt of p.alternatives) expect(alt.members.map((m) => m.opportunityId)).not.toContain(ID);
    });
  }

  it('a deposit with no stated share is asked for its share; a stated share already decided prepayment', () => {
    expect(read(opening('A deposit is taken at order')).d.restructure!.mechanisms.map((m) => m.mechanism)).toContain('PREPAYMENT');
    expect(read(opening('Buyers pay a 10% deposit at order')).d.restructure!.mechanisms.map((m) => m.mechanism)).not.toContain('PREPAYMENT');
  });
});
