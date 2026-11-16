/**
 * The JSON form of an opening a benchmark case states, and its translation into
 * the `ModelledOpportunity` the plan machinery reads.
 *
 * A case is data — public cases live in this directory, hidden ones in Brain's
 * database (docs/evolution/DESIGN.md) — so the form is JSON-serialisable and
 * small. Every figure is in the goal's major units.
 *
 *   number                     → evidence: a sourced, fixed figure
 *   [low, high]                → unknown: a swept range nobody has established
 *   { assumed: v }             → an assumption: a fixed figure nobody sourced
 *   { inferred: [p10,p50,p90], justified?, tier? }
 *                              → reconstructed by the inference engine (§79):
 *                                value null, never a link of the causal chain
 */
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

export type InputSpec = number | [number, number] | { assumed: number } | { inferred: [number, number, number]; justified?: boolean; tier?: string };

export interface OpeningSpec {
  id: string;
  title: string;
  payer?: string | null;
  reachableChannel?: string | null;
  buyingSignal?: string | null;
  signalObservedAt?: string | null;
  offerScope?: string | null;
  fulfillmentOwner?: string | null;
  economicsNote?: string | null;
  expiresAt?: string | null;
  paymentTerms?: string | null;
  source?: string | null;
  opportunitySignal?: string | null;
  requiredCapabilities?: string[];
  /** A constructed arrangement (§82): entered on reconstructed estimates, not found. */
  constructed?: boolean;
  repeatable?: boolean;
  competitiveAward?: boolean;
  /** Who does the work, when a source said so; `evidence` false means a person or model only said so. */
  fulfilledBy?: { value: string; evidence?: boolean } | null;
  /** Set only by a reconstructed strategy; a case may force it to test the critic. */
  fundedByBuyer?: boolean;
  price?: InputSpec;
  capital?: InputSpec;
  hours?: InputSpec;
  daysToCash?: InputSpec;
  close?: InputSpec;
  respond?: InputSpec;
  directCost?: InputSpec;
  volume?: InputSpec;
  agreedValue?: number;
}

export function inputOf(spec: InputSpec, note = 'bench'): ModelInput {
  if (typeof spec === 'number') return { value: spec, low: spec, high: spec, provenance: 'EVIDENCE', source: null, note: `${note}: evidence` };
  if (Array.isArray(spec)) return { value: null, low: spec[0], high: spec[1], provenance: 'UNKNOWN', source: null, note: `${note}: swept` };
  if ('assumed' in spec) return { value: spec.assumed, low: spec.assumed, high: spec.assumed, provenance: 'ASSUMPTION', source: null, note: `${note}: assumed` };
  const [p10, p50, p90] = spec.inferred;
  return {
    value: null,
    low: p10,
    high: p90,
    provenance: spec.justified ? 'EVIDENCE' : 'ASSUMPTION',
    source: null,
    note: `${note}: inferred`,
    inferred: { tier: (spec.tier ?? 'COMPARABLE') as never, justified: !!spec.justified, p10, p50, p90, observations: 3 },
  };
}

/** The defaults: what the scenario model sweeps for an opening nobody has researched (goalScenario.ts). */
const DEFAULTS = {
  price: [100, 500] as [number, number],
  capital: [0, 375] as [number, number],
  hours: [1, 40] as [number, number],
  daysToCash: [3, 60] as [number, number],
  close: [0.02, 0.5] as [number, number],
  respond: [0.002, 0.15] as [number, number],
  directCost: [0, 100] as [number, number],
};

export function modelledOf(spec: OpeningSpec, index = 1): ModelledOpportunity {
  const repeatable = spec.repeatable ?? false;
  const opportunity = {
    id: spec.id,
    projectId: 'prj_bench',
    title: spec.title,
    mechanism: 'OTHER',
    industry: null,
    payer: spec.payer ?? null,
    reachableChannel: spec.reachableChannel ?? null,
    buyingSignal: spec.buyingSignal ?? null,
    signalObservedAt: spec.signalObservedAt ?? null,
    offerScope: spec.offerScope ?? null,
    priceCents: null,
    currency: 'USD',
    fulfillmentOwner: spec.fulfillmentOwner ?? null,
    economicsNote: spec.economicsNote ?? null,
    expiresAt: spec.expiresAt ?? null,
    paymentTerms: spec.paymentTerms ?? null,
    source: spec.source ?? null,
    requiredCapabilities: spec.requiredCapabilities ?? [],
    opportunitySignal: spec.opportunitySignal ?? null,
    state: 'EVIDENCE_CARD',
  } as unknown as CashOpportunity;
  const one: ModelledOpportunity = {
    opportunity,
    index,
    tier: spec.constructed ? 'ESTIMATE' : 'QUALIFIED',
    repeatable,
    price: inputOf(spec.price ?? DEFAULTS.price, 'price'),
    capital: inputOf(spec.capital ?? DEFAULTS.capital, 'capital'),
    hours: inputOf(spec.hours ?? DEFAULTS.hours, 'hours'),
    daysToCash: inputOf(spec.daysToCash ?? DEFAULTS.daysToCash, 'days to cash'),
    close: inputOf(spec.close ?? DEFAULTS.close, 'close'),
    respond: inputOf(spec.respond ?? DEFAULTS.respond, 'respond'),
    directCost: inputOf(spec.directCost ?? DEFAULTS.directCost, 'direct cost'),
    volume: inputOf(spec.volume ?? (repeatable ? [10, 300] : { assumed: 1 }), 'volume'),
    agreed: (spec.agreedValue ?? 0) > 0,
    agreedValue: spec.agreedValue ?? 0,
    agreedDeals: (spec.agreedValue ?? 0) > 0 ? 1 : 0,
    fulfilledBy: spec.fulfilledBy ? { value: spec.fulfilledBy.value, provenance: spec.fulfilledBy.evidence === false ? 'ASSUMPTION' : 'EVIDENCE', source: null } : null,
    competitiveAward: spec.competitiveAward ?? false,
  };
  if (spec.constructed) one.estimated = { arrangementKey: spec.id.replace(/^arr_/, ''), tier: 'COMPARABLE', observations: 3 };
  if (spec.fundedByBuyer) one.fundedByBuyer = true;
  return one;
}
