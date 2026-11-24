/**
 * The investment committee reads its research back (§117): a role's UNKNOWN for
 * want of evidence names the research need it is sent as, and when a sourced
 * answer to that need arrives, the next committee reading settles the question
 * from it — the fact established (PASS) or broken (a RESEARCH defect, critical
 * where the role's own rule would be). Pure, but for the fake owners.
 */
import { describe, expect, it } from 'vitest';
import { committeeIdeaTitle, committeeNeeds, committeeOf, committeeResearchSubject, reviewPlan, reviewRole, settleByAnswers, type CommitteeAnswer, type CommitteeInput, type CommitteeLeg } from '../server/services/goals/committee.ts';
import type { PathFact } from '../server/services/goals/pathways.ts';
import { committeeAnswersOf, goalCommitteeScope, sendCommitteeNeeds } from '../server/services/goals/portfolioNeeds.ts';
import { needIdeaTitle, needKeyOf } from '../server/services/quant/needs.ts';
import type { ResearchClaim } from '../server/domain/types.ts';

const fact = (value: number | string | null, status: PathFact['status'] = 'PROVEN', basis = 'evidence on the card', low: number | null = typeof value === 'number' ? value : null, high: number | null = low): PathFact => ({ value, low, high, status, basis });

const leg = (path: Record<string, unknown> = {}): CommitteeLeg => ({
  opportunityId: 'cop_meal',
  scope: 'COUNTED',
  pathway: {
    title: 'Allergen meal-plan spreadsheet for marketplace shoppers',
    origin: 'FOUND',
    buyer: fact('Marketplace shoppers planning allergen-free meals'),
    channel: fact('The marketplace listing'),
    offer: fact('Allergen meal-plan spreadsheet', 'ESTIMATED'),
    fulfiller: fact('Brain produces it: spreadsheet', 'ESTIMATED'),
    revenuePerDeal: fact(29, 'PROVEN', 'Comparable allergen meal-plan spreadsheets sell for $29 on the marketplace'),
    fulfilmentCost: fact(3),
    acquisitionCost: fact(null, 'UNKNOWN'),
    volume: fact(40, 'PROVEN', '40 reachable buyers'),
    daysToCash: fact(3),
    capital: fact(0),
    gaps: [],
    contribution: { p10: 400, p50: 900, p90: 1040 },
    permissionsMissing: [],
    ...path,
  } as CommitteeLeg['pathway'],
  demand: { deals: { p10: 16, p50: 36, p90: 40 }, price: { p10: 29, p50: 29, p90: 29 }, unestablished: [], capitalAtStart: 0, repeatable: true } as CommitteeLeg['demand'],
});

const input = (legs: CommitteeLeg[], answers: CommitteeAnswer[] = [], tier: CommitteeInput['tier'] = 'FULL'): CommitteeInput => ({
  evidence: { goalId: 'wst_x', objective: 'settled cash of $1,000 more within 30 days', remaining: 1000, daysLeft: 30, capitalCeiling: null, currency: 'USD', legs },
  claims: { reach: 0.47, reachBasis: 'COVERAGE', probability: null, portfolioBasis: 'COVERAGE', settledP50: 1073, presentedHigh: 1000, adverse: 468, pathwayP10: 447, keptP50: 900, modelChallenge: null },
  tier,
  answers,
});

const answer = (research: string, text: string, id = 'clm_1'): CommitteeAnswer => ({ ideaTitle: needIdeaTitle(research), claimId: id, text, sourceUrl: `https://example.org/${id}` });

const estimatedVolume = leg({ volume: fact(40, 'ESTIMATED', 'inferred from listings') });
const estimatedPrice = leg({ revenuePerDeal: fact(29, 'ESTIMATED', 'inferred') });
const unknownPayment = leg({ daysToCash: fact(null, 'UNKNOWN', 'nobody has established', 3, 60) });

describe('an UNKNOWN for want of evidence names its research question', () => {
  it('each open question carries the research need it is sent as, and committeeNeeds sends exactly that subject', () => {
    const r = reviewRole('MARKET_EXPERT', input([estimatedVolume]));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.open[0]!.research).toBe(committeeResearchSubject(r.open[0]!.subject));
    expect(r.open[0]!.research).toMatch(/^committee MARKET_EXPERT: how many buyers of "Allergen/);
    const needs = committeeNeeds(reviewPlan(input([estimatedVolume])));
    expect(needs.map((n) => n.subject)).toContain(r.open[0]!.research);
  });

  it('the committee matches an answer by the same title sendNeeds gives the research idea', () => {
    for (const s of ['committee OPERATOR: when buyers of "x" pay', `committee ${'y'.repeat(260)}`]) expect(committeeIdeaTitle(s)).toBe(needIdeaTitle(s));
  });
});

describe('research answers change the next committee reading', () => {
  const volumeQ = reviewRole('MARKET_EXPERT', input([estimatedVolume])).open[0]!.research;
  const priceQ = reviewRole('MARKET_EXPERT', input([estimatedPrice])).open[0]!.research;
  const paymentQ = reviewRole('OPERATOR', input([unknownPayment])).open[0]!.research;

  it('a sourced count settles a volume question: UNKNOWN becomes PASS, citing the claim and its source', () => {
    const r = reviewRole('MARKET_EXPERT', input([estimatedVolume], [answer(volumeQ, 'The marketplace lists 1,240 distinct buyers of allergen meal plans in the last 90 days')]));
    expect(r.verdict).toBe('PASS');
    expect(r.open).toEqual([]);
    expect(r.settled[0]).toMatchObject({ outcome: 'PASS', fact: 'volume', claimIds: ['clm_1'], sourceUrls: ['https://example.org/clm_1'] });
    expect(r.citations.join(' ')).toMatch(/research clm_1 \(https:\/\/example\.org\/clm_1\)/);
    // The whole committee: the question no longer holds a FULL review.
    const before = reviewPlan(input([estimatedVolume]));
    const after = reviewPlan(input([estimatedVolume], [answer(volumeQ, 'The marketplace lists 1,240 distinct buyers')]));
    expect(before.roles.find((x) => x.role === 'MARKET_EXPERT')!.verdict).toBe('UNKNOWN');
    expect(after.roles.find((x) => x.role === 'MARKET_EXPERT')!.verdict).toBe('PASS');
    expect(after.answered).toBe(1);
  });

  it('an answer that settles nothing keeps the question open, with the claims read', () => {
    const r = reviewRole('MARKET_EXPERT', input([estimatedVolume], [answer(volumeQ, 'No public data on the number of buyers could be found')]));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.open[0]!.answeredBy).toEqual(['clm_1']);
    expect(r.settled[0]!.outcome).toBe('UNKNOWN');
  });

  it('an answer that breaks the fact fails the role: a prize is not a price (critical), cash after the window (critical)', () => {
    const prize = reviewRole('MARKET_EXPERT', input([estimatedPrice], [answer(priceQ, 'The organisers award a $5,000 prize to the winning meal plan')]));
    expect(prize.verdict).toBe('FAIL');
    expect(prize.defects[0]).toMatchObject({ source: 'RESEARCH', critical: true, fact: 'price', opportunityId: 'cop_meal' });
    expect(prize.defects[0]!.evidenceRef).toMatch(/^research clm_1/);
    const late = reviewRole('OPERATOR', input([unknownPayment], [answer(paymentQ, 'Buyers in this channel pay on net 60 terms after delivery')]));
    expect(late.verdict).toBe('FAIL');
    expect(late.defects[0]).toMatchObject({ source: 'RESEARCH', critical: true, fact: 'payment' });
    const prompt = reviewRole('OPERATOR', input([unknownPayment], [answer(paymentQ, 'Buyers pay at checkout through the marketplace')]));
    expect(prompt.verdict).toBe('PASS');
    const priced = reviewRole('MARKET_EXPERT', input([estimatedPrice], [answer(priceQ, 'Shoppers pay $24 to $35 for comparable meal-plan spreadsheets')]));
    expect(priced.verdict).toBe('PASS');
  });

  it('an answer to another question changes nothing', () => {
    expect(reviewRole('MARKET_EXPERT', input([estimatedVolume], [answer(paymentQ, 'The marketplace lists 1,240 buyers')])).verdict).toBe('UNKNOWN');
  });

  it('settleByAnswers reads only the claims: no figure is UNKNOWN, never a pass', () => {
    expect(settleByAnswers('price', [answer('q', 'Shoppers buy these spreadsheets often')], 30).outcome).toBe('UNKNOWN');
    expect(settleByAnswers('payment', [answer('q', 'Paid within 14 business days')], 30).outcome).toBe('PASS');
  });
});

describe('the round trip through the existing owners', () => {
  it('a question sent through sendNeeds is answered under its idea, read back by committeeAnswersOf, and settles the next reading', async () => {
    const reading = reviewPlan(input([estimatedVolume]));
    const sent: { scope: string; subjects: string[] }[] = [];
    await sendCommitteeNeeds(
      { goalId: 'wst_x', projectId: 'prj_1', committee: reading },
      {
        sendNeeds: async (i) => {
          sent.push({ scope: i.graphScope, subjects: i.needs.map((n) => n.subject) });
          return i.needs.map((n) => ({ subject: n.subject, sent: true as const, to: 'RESEARCH_CANDIDATE' as const, ref: 'kc_1', created: true }));
        },
      },
    );
    const subject = sent[0]!.subjects.find((s) => s.startsWith('committee MARKET_EXPERT'))!;
    expect(sent[0]!.scope).toBe(goalCommitteeScope('wst_x'));
    expect(needKeyOf(sent[0]!.scope, { subject, question: '', route: 'RESEARCH', permissions: [] })).toMatch(/^causal-/);
    // The research path files an accepted, sourced claim under the idea the need opened.
    const scopes: string[] = [];
    const answers = await committeeAnswersOf('prj_1', 'wst_x', {
      claimsAnsweringScope: async (_p, scope) => {
        scopes.push(scope);
        return [
          { claim: { id: 'clm_9', claim: 'Marketplace data shows 1,240 distinct buyers of allergen meal plans per quarter', sourceUrl: 'https://example.org/data' } as ResearchClaim, idea: { candidateId: 'kc_1', title: needIdeaTitle(subject), statement: `For causal graph ${goalCommitteeScope('wst_x')}, establish from sourced evidence: …` } },
          { claim: { id: 'clm_x', claim: 'unsourced', sourceUrl: null } as ResearchClaim, idea: { candidateId: 'kc_1', title: needIdeaTitle(subject), statement: '' } },
        ];
      },
    });
    expect(scopes).toEqual(['goal:wst_x:committee']);
    expect(answers.map((a) => a.claimId)).toEqual(['clm_9']);
    const again = reviewPlan(input([estimatedVolume], answers));
    expect(again.roles.find((r) => r.role === 'MARKET_EXPERT')).toMatchObject({ verdict: 'PASS' });
    expect(committeeNeeds(again).map((n) => n.subject)).not.toContain(subject);
  });

  it('committeeOf passes the answers through to the roles', () => {
    const r = committeeOf({ goalId: 'wst_x', target: undefined, acceptance: undefined, portfolio: undefined, pathways: undefined, objective: undefined } as never, { answers: [] });
    expect(r.answered).toBe(0);
    expect(r.specialists.state).toBe('NOT_RUN');
  });
});
