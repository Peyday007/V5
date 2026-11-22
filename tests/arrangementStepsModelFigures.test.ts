/**
 * Production plan reads, 2026-11-19: every step of a leading arrangement read
 * "cost 0", and Collect, Deliver and Renew carried no day — although the
 * model the plan was screened on held a swept days-to-cash and direct cost.
 * With no portfolio there is no simulated draw, and `fieldFromInput` reads
 * only an established or justified figure, so the steps read nothing.
 *
 * Steps now carry the figures the model used for their stage (labelled an
 * assumption when swept), a stage the model prices nothing for has a null
 * cost — unestablished, never 0 — and a renewal falls one cycle (the model's
 * days to usable cash) after the first payment.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import type { ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { arrangementSteps } from '../server/services/goals/arrangementSteps.ts';

const bookkeeping = {
  key: 'bk',
  structure: 'PRODUCE',
  design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' },
  origin: 'FORWARD',
  precedent: null,
  sector: null,
  demand: { name: 'Dental practices', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_dent' },
  need: { name: 'monthly reports', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_rep' },
  supply: null,
  label: 'Dental practices: monthly reports',
  properties: [],
  targetsMet: [],
  emergent: [],
  stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] },
  evidenced: 0,
  value: { tier: 'COMPARABLE', p10: 200, p50: 300, p90: 450, observations: 3 },
  conversion: { tier: 'COMPARABLE', p10: 0.02, p50: 0.04, p90: 0.07, observations: 3, sources: ['claim:c9'] },
  buyerTerms: { timing: 'ARREARS', basis: 'net-14 stated' },
  unknownParts: [],
  relatedOpenings: [],
  question: '',
} as unknown as ConstructedArrangement;

const swept = (low: number, high: number) => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });
const modelled = { daysToCash: swept(5, 15), directCost: swept(40, 90), capital: swept(0, 0) } as unknown as ModelledOpportunity;
const ctx = { currency: 'USD', daysLeft: 60, capitalBeforeProof: 500, send: ['CONTACT_BUYER'], collect: [] };

describe('steps carry the model\'s own figures', () => {
  it('a swept days-to-cash gives Deliver, Collect and Renew their days, as an assumption', () => {
    const steps = arrangementSteps(bookkeeping, { ...ctx, modelled });
    const by = (l: string) => steps.find((s) => s.label.startsWith(l))!;
    expect(by('Offer it').startDay).toEqual({ low: 0, high: 0 });
    expect(by('Collect payment').startDay).toEqual({ low: 5, high: 15 });
    expect(by('Collect payment').basis).toBe('ASSUMPTION');
    expect(by('Collect payment').when).toMatch(/the range the model swept: an assumption/);
    expect(by('Deliver and confirm').startDay).toEqual({ low: 0, high: 15 });
    // One cycle (5–15 days to usable cash) after the first payment.
    expect(by('Renew').startDay).toEqual({ low: 10, high: 30 });
    expect(by('Renew').when).toMatch(/^day 10–30: one cycle after the first payment/);
    expect(by('Renew').withinLimits).toBe(true);
  });

  it('a stage the model costs carries that cost; one it does not is unestablished, never 0', () => {
    const steps = arrangementSteps(bookkeeping, { ...ctx, modelled });
    const by = (l: string) => steps.find((s) => s.label.startsWith(l))!;
    expect(by('Deliver and confirm')).toMatchObject({ cost: 90, owner: 'PERSON', basis: 'ASSUMPTION', withinLimits: true });
    expect(by('Deliver and confirm').detail).toMatch(/Direct cost per deal about USD 40–90 \(the range the model swept/);
    for (const label of ['Reach', 'Offer it', 'Renew']) expect(by(label).cost, label).toBeNull();
    // Collecting commits nothing before the buyer pays, and says why: the provider's fee comes out of the payment.
    expect(by('Collect payment')).toMatchObject({ cost: 0, arrangement: { costSource: 'NOT_OWNERS' } });
    expect(by('Collect payment').detail).toMatch(/fee, which the plan's net does not model, is taken out of each payment/);
  });

  it('with no model at all, nothing is invented: no day after the offer and no delivery cost', () => {
    const steps = arrangementSteps(bookkeeping, ctx);
    const by = (l: string) => steps.find((s) => s.label.startsWith(l))!;
    for (const label of ['Deliver and confirm', 'Collect payment', 'Renew']) expect(by(label).startDay, label).toBeNull();
    expect(by('Deliver and confirm').cost).toBeNull();
    expect(steps.some((s) => (s.cost ?? 0) > 0)).toBe(false);
  });
});
