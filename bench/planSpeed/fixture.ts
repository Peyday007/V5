/**
 * A frozen plan input shaped like the live $10K goal (production, 2026-11-15):
 * 11 found openings and 12 constructed arrangements, $3,000 in all, $375 per
 * arrangement before proof, $750 a week, 24 days left, the owner's Instantly
 * capacity (945 a day over 13 accounts) and the workspace's measured campaign
 * record. The figures are the ranges the scenario model sweeps or the cards
 * stated — `tests/fixtures/goal10k.ts` for the eight production carried on
 * 2026-11-09, the rest in the same style — frozen here so a change to a test
 * fixture never moves the benchmark.
 */
import type { OpeningSpec } from '../spec.ts';

export interface PlanLimits {
  remaining: number;
  daysLeft: number;
  capitalCeiling: number | null;
  beforeProof: number | null;
  perWeek: number | null;
  resources: string | null;
  measuredCapacity: { perDay: number; accounts: number } | null;
  measuredRates: { sent: number; replies: number; opportunities: number; bounced: number; campaigns: Array<{ name: string; sent: number; replies: number; opportunities: number; bounced: number; brainOwned: boolean }> } | null;
}

export interface PlanSpeedCase {
  id: string;
  openings: OpeningSpec[];
  limits?: Partial<PlanLimits>;
  required?: number;
  /** The strongest plan's reach recorded on the reference run; the quality guard compares against it. */
  referenceReach?: number;
}

export const GOAL_10K_LIMITS: PlanLimits = {
  remaining: 10_000,
  daysLeft: 24,
  capitalCeiling: 3000,
  beforeProof: 375,
  perWeek: 750,
  resources: 'Budget around 2000 to 3000 dollars, not fixed. Spend little until money comes in, then spread it over the month.',
  measuredCapacity: { perDay: 945, accounts: 13 },
  measuredRates: {
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
  },
};

const outreach = { close: [0.05, 0.25] as [number, number], respond: [0.0045, 0.0343] as [number, number], hours: 0, daysToCash: [5, 15] as [number, number] };

const FOUND: OpeningSpec[] = [
  { id: 'cop_home_improvement', title: 'Market: US residential home improvement (Mechanicsburg, PA)', repeatable: true, ...outreach, price: [100, 500], directCost: [0, 50], capital: [0, 375], close: [0.05, 0.3], volume: [5, 100] },
  { id: 'cop_lists', title: 'Trigger lists Brain compiles from public records', repeatable: true, ...outreach, price: [149, 499], directCost: 0, capital: [0, 375], close: [0.1, 0.35], daysToCash: [3, 10], volume: [10, 300] },
  { id: 'cop_coachella', title: 'Coachella 2026 resale', ...outreach, price: [500, 649], capital: [450, 649], directCost: [0, 50], close: [0.1, 0.4], volume: { assumed: 1 } },
  { id: 'cop_sudoku', title: 'Artisanal Sudoku (a Substack publication of variant-Sudoku puzzles)', ...outreach, price: 50, capital: 0, directCost: [0, 10], close: [0.2, 0.6], daysToCash: [3, 7], volume: { assumed: 1 } },
  { id: 'cop_depositphotos', title: 'Depositphotos standard-licence subscription', repeatable: true, ...outreach, price: [29, 69], directCost: 0, capital: [0, 375], close: [0.02, 0.1], volume: [10, 300] },
  { id: 'cop_bookkeeping', title: 'Month-end bookkeeping clean-up for small agencies', repeatable: true, ...outreach, price: [300, 900], directCost: [0, 100], capital: [0, 375], volume: [10, 150] },
  { id: 'cop_grant', title: 'RFP: county records digitisation services', competitiveAward: true, ...outreach, price: [8000, 15_000], directCost: [2000, 6000], capital: [0, 375], daysToCash: [30, 90], volume: { assumed: 1 } },
  { id: 'cop_reviews', title: 'Review-response writing for multi-location restaurants', repeatable: true, ...outreach, price: [200, 600], directCost: 0, capital: [0, 375], volume: [10, 200] },
  { id: 'cop_pitchdeck', title: 'Pitch-deck rewrite requested on a founders forum', ...outreach, price: 750, directCost: 0, capital: 0, close: [0.2, 0.5], daysToCash: [3, 10], volume: { assumed: 1 } },
  { id: 'cop_catalogue', title: 'Product catalogue data entry for a hardware wholesaler', repeatable: true, ...outreach, price: [400, 1200], directCost: [0, 100], capital: [0, 375], volume: [5, 60] },
  { id: 'cop_rev', title: 'Rev.com publishes a per-minute price of $1.99 for its human transcription', repeatable: true, ...outreach, price: 1.99, directCost: 79, capital: [0, 375], volume: [10, 300] },
];

const constructed = (id: string, title: string, over: Partial<OpeningSpec>): OpeningSpec => ({ id, title: `Constructed: ${title}`, constructed: true, repeatable: true, ...outreach, capital: [0, 375], volume: [20, 400], ...over });

const CONSTRUCTED: OpeningSpec[] = [
  constructed('arr_gifts', 'year-end client and employee gifts, supplier drop-ships', { price: [690, 3450], directCost: [550, 3000], close: [0.08, 0.3] }),
  constructed('arr_ai_reception', 'AI receptionist setups for home-service firms', { price: [1500, 2297], directCost: [75, 300], close: [0.04, 0.2], daysToCash: [10, 20], volume: [50, 2000] }),
  constructed('arr_cleaning', 'commercial cleaning contracts, subcontracted crew', { price: [600, 1800], directCost: [420, 1440], daysToCash: [10, 25], volume: [20, 500] }),
  constructed('arr_pool', 'pool several buyers’ purchases with one supplier', { price: { inferred: [300, 1170, 3000] }, directCost: [0, 300], volume: [1, 200] }),
  constructed('arr_referral', 'refer roofing jobs to a contractor for a finder\'s fee', { price: [250, 900], directCost: 0, close: [0.03, 0.15], volume: [10, 300] }),
  constructed('arr_audit', 'website accessibility audits for clinics', { price: [400, 1500], directCost: [0, 100], volume: [10, 250] }),
  constructed('arr_retainer', 'monthly content retainers for SaaS start-ups', { price: [800, 2500], directCost: [0, 200], close: [0.03, 0.12], daysToCash: [7, 30], volume: [5, 120] }),
  constructed('arr_events', 'event staffing brokered to a local agency', { price: [1200, 4000], directCost: [900, 3200], daysToCash: [10, 30], volume: [5, 80] }),
  constructed('arr_translation', 'document translation via vetted freelancers', { price: [150, 600], directCost: [60, 300], volume: [20, 500] }),
  constructed('arr_leads', 'qualified lead lists for solar installers', { price: [300, 1200], directCost: 0, close: [0.05, 0.2], daysToCash: [3, 12], volume: [10, 200] }),
  constructed('arr_bureaus', 'state technical utility services bureaus', { repeatable: false, price: { inferred: [1_200_000, 2_765_302, 4_500_000] }, directCost: { assumed: 881_310 }, capital: [0, 881_310], daysToCash: [3, 60], close: [0.02, 0.5], respond: [0.002, 0.15], volume: { assumed: 1 } }),
  constructed('arr_onboarding', 'employee onboarding packs for staffing firms', { price: [500, 1500], directCost: [0, 150], volume: [10, 150] }),
];

export const GOAL_10K_PLAN: PlanSpeedCase = {
  id: 'goal10k-23',
  openings: [...FOUND, ...CONSTRUCTED],
  required: 0.9,
};
