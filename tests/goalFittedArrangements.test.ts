/**
 * A goal's arrangements are fitted to the goal (production transfer test,
 * release ca2efe4d, 2026-11-19).
 *
 * Six goals of different shapes — $10K/30d, $100K/90d with $10K capital,
 * $5K/mo over 60d with $1.5K, $3K with no capital, $2K/14d with $500 and 80h,
 * $50K with $25K capital — each admitted the same 12 estimated arrangements:
 *
 *   1. nothing about the goal's capital or hours reached the screen, so a
 *      $0-capital goal admitted designs that tie money up and the $25K goal
 *      admitted none that would use it;
 *   2. an arrangement whose money cannot settle before the deadline, or whose
 *      deals each lose money (homeowner: price p50 $2,569 against a direct
 *      cost p50 $47,021), still took a slot;
 *   3. every design Brain produces named its deliverable as the whole
 *      deliverables list;
 *   4. the reconstruction's "favourable" probes moved close and volume up on a
 *      deal that loses money, and never moved its cost, so they read worse
 *      than the baseline.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement, Primitive } from '../server/services/cash/construct.ts';
import { BRAIN_CAPABILITY_PATH, arrangementSignature, capabilityPart, fittedDeliverable } from '../server/services/cash/construct.ts';
import { losesMoneyPerDeal, screenArrangement, selectEstimatedArrangements, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { reconstructPlan } from '../server/services/goals/reconstruction.ts';

type Exposure = 'SAFE' | 'BOUNDED' | 'UNKNOWN';
function arrangement(key: string, over: { p50: number; exposure?: Exposure; worstCents?: number | null; base?: 'PRODUCE' | 'BROKER' | 'RESELL'; repeat?: 'ONE_OFF' | 'RECURRING_COHORT'; leader?: boolean }): ConstructedArrangement {
  const base = over.base ?? 'BROKER';
  const exposure = over.exposure ?? 'SAFE';
  return {
    key,
    structure: base,
    design: { base, funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: over.repeat ?? 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'services',
    demand: { name: `buyers of ${key}`, claimId: null, from: 'EVENT_GRAPH', ref: `hyp_${key}`, path: `GRAPH_BUYER:${key}` },
    need: null,
    supply: null,
    label: `Arrangement ${key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure, worstCaseCents: exposure === 'SAFE' ? 0 : (over.worstCents ?? null), failures: [] },
    evidenced: 1,
    value: { tier: 'COMPONENT', p10: over.p50 / 2, p50: over.p50, p90: over.p50 * 2, observations: 4 },
    unknownParts: ['buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    signature: `sig_${key}`,
    inputsDigest: `in_${key}`,
    ...(over.leader ? { leader: true } : {}),
  } as ConstructedArrangement;
}

// Fee designs that spend nothing first, and designs that tie money up before buyers commit.
const safe = Array.from({ length: 14 }, (_, i) => arrangement(`fee${String(i).padStart(2, '0')}`, { p50: 2_000 + i * 50 }));
const bounded = arrangement('stock', { p50: 2_500, exposure: 'BOUNDED', worstCents: 4_000_00, base: 'RESELL' });
const unbounded = arrangement('inventory', { p50: 2_400, exposure: 'UNKNOWN', base: 'RESELL' });
const all = [...safe, bounded, unbounded];
const base = { projectId: 'prj_fit', currency: 'USD', beforeProofCents: null, exclusions: [] };
const picked = (sel: ReturnType<typeof selectEstimatedArrangements>) => sel.selection.picked.map((one) => one.arrangementKey);

describe("the goal's own terms shape which arrangements enter its model", () => {
  it('reproduces the defect: with nothing about capital passed, every goal admits the same set', () => {
    const a = selectEstimatedArrangements(all, { ...base, remaining: 2_000, daysLeft: 14 });
    const b = selectEstimatedArrangements(all, { ...base, remaining: 50_000, daysLeft: 180 });
    expect(picked(a).sort()).toEqual(picked(b).sort());
  });

  it('a goal that allows no money up front cuts the designs that tie money up, with the reason', () => {
    const sel = selectEstimatedArrangements(all, { ...base, remaining: 3_000, daysLeft: 30, capitalAvailable: 0 });
    expect(picked(sel)).not.toContain('stock');
    expect(picked(sel)).not.toContain('inventory');
    const cut = sel.selection.cut.find((one) => one.arrangementKey === 'stock')!;
    expect(cut.reason).toMatch(/^it does not fit this goal: it ties up .* before money comes in, and this goal allows 0/);
    // Designs that spend nothing first are untouched.
    expect(picked(sel).every((key) => key.startsWith('fee'))).toBe(true);
  });

  it('a goal with capital to use admits the strongest design that uses it, in its own slot, undiscounted when its worst case is covered', () => {
    const sel = selectEstimatedArrangements(all, { ...base, remaining: 50_000, daysLeft: 180, capitalAvailable: 25_000 });
    const slot = sel.selection.picked.find((one) => one.slot === 'CAPITAL');
    expect(slot).toBeDefined();
    expect(['stock', 'inventory']).toContain(slot!.arrangementKey);
    expect(slot!.basis).toMatch(/capital: 100% of its swept up-front money within the 25,000 allowed/);
    // The same goal shape without the capital never admits it in a CAPITAL slot.
    const none = selectEstimatedArrangements(all, { ...base, remaining: 50_000, daysLeft: 180, capitalAvailable: 0 });
    expect(none.selection.picked.some((one) => one.slot === 'CAPITAL')).toBe(false);
    // So two goals of different capital no longer read the same set.
    expect(picked(sel).sort()).not.toEqual(picked(none).sort());
  });

  it("a held leader that does not fit this goal's capital is not held in its model", () => {
    const leader = arrangement('lead', { p50: 3_000, exposure: 'BOUNDED', worstCents: 2_000_00, base: 'RESELL', leader: true });
    const sel = selectEstimatedArrangements([...safe, leader], { ...base, remaining: 2_000, daysLeft: 14, capitalAvailable: 0 });
    expect(picked(sel)).not.toContain('lead');
    expect(sel.selection.cut.find((one) => one.arrangementKey === 'lead')!.reason).toMatch(/does not fit this goal/);
  });
});

const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
function opening(id: string, over: Partial<ModelledOpportunity>): ModelledOpportunity {
  return {
    opportunity: { id, title: id } as ModelledOpportunity['opportunity'],
    index: 0,
    tier: 'ESTIMATE',
    repeatable: true,
    price: swept(100, 500),
    capital: swept(0, 0.01),
    hours: swept(1, 40),
    daysToCash: swept(3, 60),
    close: swept(0.02, 0.5),
    respond: swept(0.002, 0.15),
    directCost: swept(0, 50),
    volume: swept(1, 200),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

describe('the screen reads the deadline, the hours and the margin', () => {
  const value = { tier: 'COMPONENT', p10: 1_000, p50: 2_000, p90: 4_000, observations: 3 } as ConstructedArrangement['value'];
  const stress = { exposure: 'SAFE', worstCaseCents: 0, failures: [] } as unknown as ConstructedArrangement['stress'];
  const terms = { remaining: 2_000, daysLeft: 14, contactsPerDay: 10 };

  it('money that settles no sooner than the deadline is a misfit, not a lower reading', () => {
    const late = screenArrangement(opening('late', { daysToCash: swept(21, 45) }), { value, stress }, terms);
    expect(late.value).toBe(0);
    expect(late.misfit).toBe('its money settles no sooner than 21 days, after the 14 this goal has left');
    // An unknown that may settle in time is read lower, never cut.
    expect(screenArrangement(opening('maybe', {}), { value, stress }, terms).misfit).toBeNull();
  });

  it("the goal's hours bound the deals a repeatable design is read at", () => {
    const wide = { ...terms, remaining: 1_000_000, daysLeft: 120 };
    const unlimited = screenArrangement(opening('h', { close: fixed(0.3), respond: fixed(0.1), volume: fixed(200) }), { value, stress }, wide);
    const bounded = screenArrangement(opening('h', { close: fixed(0.3), respond: fixed(0.1), volume: fixed(200) }), { value, stress }, { ...wide, hours: 80 });
    expect(bounded.value).toBeLessThan(unlimited.value);
    expect(bounded.basis).toMatch(/hours: at most 2\.6 deal\(s\) in 80 h at 30\.3 h\/deal/);
    expect(screenArrangement(opening('big', { hours: swept(120, 200) }), { value, stress }, { ...terms, hours: 80 }).misfit).toMatch(/needs at least 120 owner hours, more than the 80 owner hours/);
  });

  it('a deal whose direct cost outruns its price is left out, the cost not lowered', () => {
    // arr_0a5793917577: price p50 $2,569 against a direct cost swept 0–$94,042 (p50 $47,021).
    const homeowner = opening('arr_0a5793917577', { price: { ...swept(42, 156_737), inferred: { tier: 'MECHANISM', justified: false, p10: 42, p50: 2_569, p90: 156_737, observations: 6 } }, directCost: swept(0, 94_042) });
    expect(losesMoneyPerDeal(homeowner)).toBe('every deal loses money at the middle readings: direct cost p50 47021 against price p50 2569');
    // Its cost is the blind sweep (nothing to 60% of the top price): nothing shows the loss, so it is not cut,
    // but it is read as keeping nothing at the middle and can enter only on its upside, said so.
    const s = screenArrangement(homeowner, { value, stress }, terms);
    expect(s.value).toBe(0);
    expect(s.misfit).toBeNull();
    expect(s.flag).toMatch(/^every deal loses money .*blind sweep nobody established/);
    expect(homeowner.directCost.high).toBe(94_042);
    // A cost something established (here inferred) that outruns the price is a misfit: left out with the reason.
    const established = { ...homeowner, directCost: { ...swept(20_000, 80_000), provenance: 'ASSUMPTION' as const, inferred: { tier: 'COMPARABLE' as const, justified: false, p10: 20_000, p50: 47_021, p90: 80_000, observations: 3 } } };
    expect(screenArrangement(established, { value, stress }, terms).misfit).toBe('every deal loses money at the middle readings: direct cost p50 47021 against price p50 2569');
    // A deal that keeps money is untouched; money a buyer agreed is never second-guessed.
    expect(losesMoneyPerDeal(opening('ok', { price: swept(1_000, 3_000), directCost: swept(0, 1_200) }))).toBeNull();
    expect(losesMoneyPerDeal({ ...homeowner, agreedValue: 5_000 })).toBeNull();
  });
});

describe('the deliverable is what these buyers pay for, never the list', () => {
  const delivers = ['spreadsheet', 'business document', 'presentation', 'data operations', 'website', 'programming', 'graphic design', '3D model'];
  const capability = capabilityPart(delivers)!;
  const buyer = (name: string): Primitive => ({ name, claimId: null, from: 'INDUSTRY_MAP', ref: `n_${name}`, path: `BUYER:${name}` });
  const need = (name: string): Primitive => ({ name, claimId: null, from: 'INDUSTRY_MAP', ref: `need_${name}`, path: `NEED:${name}` });

  it('reproduces the defect: the capability part is named by the whole list', () => {
    expect(capability.name).toBe(delivers.join(', '));
  });

  it("names the one deliverable the need calls for, keeps the identity, and says so when none matches", () => {
    const fitted = fittedDeliverable(capability, delivers, buyer('dental practices'), need('patient newsletters'));
    expect(fitted.name).toBe('business document for "patient newsletters"');
    expect(fitted.path).toBe(BRAIN_CAPABILITY_PATH);
    const design = { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as const;
    expect(arrangementSignature(design, buyer('dental practices'), need('patient newsletters'), fitted)).toBe(arrangementSignature(design, buyer('dental practices'), need('patient newsletters'), capability));
    expect(fittedDeliverable(capability, delivers, buyer('homeowner'), need('roof repair')).name).toBe('the deliverable "roof repair" calls for (not yet matched to one Brain has proved)');
    expect(fittedDeliverable(capability, delivers, buyer('homeowner'), null).name).toBe('what homeowner pay for (not yet specified)');
    for (const name of [fitted.name, fittedDeliverable(capability, delivers, buyer('homeowner'), null).name]) expect(name).not.toContain('spreadsheet, business document');
  });
});

describe("the reconstruction's favourable probes on a deal that loses money", () => {
  it('moves the cost to its favourable end, so every factor at once never reads below the plan as held', async () => {
    // arr_0a5793917577 as production read it: price p50 $2,569 over a wide sweep, direct cost swept 0–$94,042.
    const losing = opening('arr_0a5793917577', {
      price: { ...swept(42, 156_737), inferred: { tier: 'MECHANISM', justified: false, p10: 42, p50: 2_569, p90: 156_737, observations: 6 } },
      directCost: swept(0, 94_042),
      daysToCash: swept(3, 10),
      respond: swept(0.0045, 0.0343),
      hours: fixed(0),
      volume: swept(10, 300),
    });
    const limits = { remaining: 10_000, daysLeft: 30, capitalCeiling: null, beforeProof: null, perWeek: null, resources: '', measuredCapacity: { perDay: 945, accounts: 13 }, worlds: 400, seed: 7 };
    const baseline = evaluateGoalPortfolio({ ...limits, openings: [losing] });
    const r = await reconstructPlan({ openings: [losing], portfolio: limits, baseline, required: 0.9, explore: null });
    const by = new Map(r.diagnosis.map((d) => [d.factor, d]));
    // Before: the headroom probe moved close and volume up on a losing deal and never its cost, and read
    // 0.69 against a 0.705 baseline. The cost is now a factor, and the headroom moves it first.
    expect(by.get('COST')!.reach).toBeGreaterThan(r.baseline.reach);
    expect(r.headroom.reach).toBeGreaterThanOrEqual(by.get('COST')!.reach);
    // Close and volume are not "favourable" on a deal that loses money: those probes leave it as held.
    expect(by.get('CLOSE')!.reach).toBe(r.baseline.reach);
    expect(by.get('MARKET_SIZE')!.reach).toBe(r.baseline.reach);
  }, 120_000);
});
