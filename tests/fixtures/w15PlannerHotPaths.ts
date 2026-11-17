/** A production-shaped planner fixture (W15): priced openings with prose payers, and plan candidates that overlap. */
import type { ComparablePrice } from '../../server/services/cash/goalScenario.ts';
import { MODEL_FIELDS, type ModelField, type PlanCandidate, type PlanModel } from '../../server/services/goals/planSet.ts';

/** Payers as production stores them: the claim's prose, not a name. */
const PAYERS = [
  'GitHub, Inc. is the payer: it runs the bounty programme',
  'The payer/buyer is St. Louis Development Corporation',
  'Buyers who pay for transcription are primarily small business operators, freelancers and educators',
  'Pennsylvania Department of Transportation issued RFP 2026-114 for bridge inspection',
  'School District of Philadelphia',
  'A homeowner (the payer) can hire a gutter cleaner on Thumbtack',
  'Contracting party for the Ohio opening: City of Columbus, Columbus, OH',
  'The client who posted the request, describing themselves as the owner of a small bakery in Austin',
  'US residential homeowners',
  'Dental practices pay $2,500 per month for managed IT',
];

export function priceFixture(n = 300): ComparablePrice[] {
  return Array.from({ length: n }, (_, i) => ({
    value: 100 + ((i * 137) % 4_900),
    industry: i % 3 === 0 ? 'home improvement' : null,
    payer: i % 2 === 0 ? PAYERS[i % PAYERS.length]! : `${PAYERS[i % PAYERS.length]!} (${i})`,
  }));
}

export const DEMANDS = ['Dental practices', 'state transportation departments', 'school districts', 'small bakery owners', 'municipal governments', 'Dog groomers', 'US residential homeowners', 'universities and colleges'];

const field = (status: ModelField['status']): ModelField => ({ value: 'x', low: null, high: null, status, basis: `fixture ${status}` });

export function candidateFixture(n = 400): PlanCandidate[] {
  return Array.from({ length: n }, (_, i) => {
    const m = {} as PlanModel;
    for (const f of MODEL_FIELDS) m[f] = field(i % 7 === 0 ? 'UNKNOWN' : 'ESTIMATED');
    const k = i % 120;
    return {
      id: `c${String(i).padStart(4, '0')}`,
      title: `Plan ${i}`,
      source: 'PATHWAY',
      opportunityIds: [`o${i}`],
      dimensions: { mechanism: `Reselling the ${k % 40} services of a broker`, channel: `Cold email to the ${k % 30} owners`, fulfilment: `Subcontracted fulfilment ${k % 20}`, risk: `Buyer churn ${k % 10}`, revenue: k % 2 ? 'one-off' : 'recurring' },
      customers: [`Customers of segment ${i}`, `Secondary buyers ${i}`, `Tertiary list ${i}`],
      cashSources: [`Payers in pool ${i}`, `Grant ${i}`],
      channels: [`Channel ${i % 50}`, `Marketplace listing ${i % 17}`],
      suppliers: [`Supplier ${i % 40}`],
      model: m,
      modelled: { p10: 1_000 + i, p50: 5_000 + i * 3, p90: 12_000 + i * 5 },
      observedCollections: i % 11 === 0 ? 200 : 0,
      enforceableCommitments: 0,
      capitalRequired: 300 + (i % 9) * 100,
      daysToCash: 10 + (i % 30),
      attempts: { researched: i % 2 === 0, authorized: i % 5 === 0, executed: false },
      whyItWorks: [`why ${i}`],
      transfers: [`transfers ${i % 13}`],
      stopsTransferringWhen: [],
    } satisfies PlanCandidate;
  });
}
