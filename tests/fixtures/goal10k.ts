/**
 * The $10K goal as production read it on 2026-11-09 (Goals plan 42692716368),
 * reduced to what the quant engine sees: its openings' ranges, its limits, the
 * owner's Instantly capacity and the workspace's measured campaign record.
 * The regression case for §99.
 */
import type { ModelInput, ModelledOpportunity } from '../../server/services/cash/goalScenario.ts';

const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function opening(id: string, title: string, index: number, over: Partial<ModelledOpportunity>): ModelledOpportunity {
  return {
    opportunity: { id, title } as ModelledOpportunity['opportunity'],
    index,
    tier: 'QUALIFIED',
    repeatable: true,
    price: swept(100, 500),
    capital: swept(0, 375),
    hours: fixed(0),
    daysToCash: swept(5, 15),
    close: swept(0.05, 0.25),
    respond: swept(0.0045, 0.0343),
    directCost: swept(0, 50),
    volume: swept(10, 300),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

export const GOAL_10K_OPENINGS: ModelledOpportunity[] = [
  opening('arr_gifts', 'Constructed: year-end client and employee gifts, supplier drop-ships', 1, { price: swept(690, 3450), directCost: swept(550, 3000), close: swept(0.08, 0.3), daysToCash: swept(5, 15), volume: swept(20, 400) }),
  opening('arr_ai_reception', 'Constructed: AI receptionist setups for home-service firms', 2, { price: swept(1500, 2297), directCost: swept(75, 300), close: swept(0.04, 0.2), daysToCash: swept(10, 20), volume: swept(50, 2000) }),
  opening('arr_cleaning', 'Constructed: commercial cleaning contracts, subcontracted crew', 3, { price: swept(600, 1800), directCost: swept(420, 1440), close: swept(0.05, 0.25), daysToCash: swept(10, 25), volume: swept(20, 500) }),
  opening('cop_home_improvement', 'Market: US residential home improvement (Mechanicsburg, PA)', 4, { price: swept(100, 500), close: swept(0.05, 0.3), volume: swept(5, 100) }),
  opening('cop_lists', 'Trigger lists Brain compiles from public records', 5, { price: swept(149, 499), directCost: fixed(0), close: swept(0.1, 0.35), daysToCash: swept(3, 10) }),
  opening('cop_coachella', 'Coachella 2026 resale', 6, { repeatable: false, price: swept(500, 649), capital: swept(450, 649), close: swept(0.1, 0.4) }),
  opening('cop_sudoku', 'Artisanal Sudoku (a Substack publication of variant-Sudoku puzzles)', 7, { repeatable: false, price: fixed(50), capital: fixed(0), close: swept(0.2, 0.6), daysToCash: swept(3, 7) }),
  opening('cop_depositphotos', 'Depositphotos standard-licence subscription', 8, { price: swept(29, 69), directCost: fixed(0), close: swept(0.02, 0.1) }),
];

export const GOAL_10K_LIMITS = {
  remaining: 10_000,
  daysLeft: 30,
  capitalCeiling: 3000,
  beforeProof: 375,
  perWeek: 750,
  resources: 'Budget around 2000 to 3000 dollars, not fixed. Spend little until money comes in, then spread it over the month.',
  measuredCapacity: { perDay: 945, accounts: 13 },
};

/** Read from the owner's workspace on 2026-11-09 (`GET /api/v2/campaigns/analytics`). */
export const GOAL_10K_RECORD = {
  sent: 4096,
  replies: 15,
  opportunities: 2,
  bounced: 396,
  campaigns: [
    { name: 'AI Dispatch', sent: 1319, replies: 6, opportunities: 0, bounced: 33, brainOwned: false },
    { name: 'Venture Cleaning', sent: 1437, replies: 5, opportunities: 1, bounced: 151, brainOwned: false },
    { name: 'Local ad campaign', sent: 1138, replies: 3, opportunities: 1, bounced: 131, brainOwned: false },
    { name: 'Airyn Mailer', sent: 202, replies: 1, opportunities: 0, bounced: 81, brainOwned: false },
  ],
};
