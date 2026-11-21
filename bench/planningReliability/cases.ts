/**
 * The public planningReliability cases (docs/COMPLETION-SPEC.md §4–5). Each rubric is
 * written from the arithmetic and the evidence the case files — never from what the
 * planner answers today. A case the planner fails is a measurement (BASELINE.md), not a
 * case to edit.
 *
 * Familiar cases reuse the sectors of the existing fixtures (tests/planTransfer.test.ts:
 * property management, dental practices, restaurant equipment, commercial cleaning, farm
 * grant planning; bench/feasibility: credit-union reports, roofing lead lists, corporate
 * gifts, HVAC, records digitisation). Held-out cases use industries and mechanisms none of
 * those fixtures use.
 */
import type { CaseDimensions, OpeningFixture, PlanningCase } from './case.ts';

const dims = (over: Partial<CaseDimensions> & Pick<CaseDimensions, 'industry' | 'mechanism'>): CaseDimensions => ({
  capital: 'none',
  target: 'small',
  deadline: 'long',
  autonomy: 'unlimited',
  missingEvidence: 'none',
  contradictoryEvidence: false,
  objectiveChanged: false,
  ...over,
});

/* ---------------- familiar openings (the transfer and feasibility fixtures' sectors) ---------------- */

/** Every link evidenced: 400 buyers, a measured 10% of visitors pre-paid, Brain produces it, $600 at $10 cost. */
const PROPERTY: OpeningFixture = {
  key: 'property', title: 'Vendor-compliance spreadsheet for property managers', mechanism: 'PRODUCTIZED_SERVICE', industry: 'property management',
  payer: 'Property managers', price: 600, cost: 10, capital: 0, daysToCash: 5, hours: 1, performer: 'BRAIN',
  volume: '400 property managers are listed in the state directory; each needs one.', conversion: { paid: 40, of: 400 },
};

/** Post-construction cleanup: a crew subcontracted at half the price, two contractors signed. */
const CLEANING: OpeningFixture = {
  key: 'cleaning', title: 'Post-construction cleanup for general contractors', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning',
  payer: 'General contractors', price: 3000, cost: 1500, capital: 0, daysToCash: 10, hours: 2, performer: 'SUBCONTRACTOR', subcontractor: 'BrightCrew Cleaning LLC (quoted)',
  agreements: [3000, 3000],
};

const DENTAL_RETAINER: OpeningFixture = {
  key: 'dental', title: 'Monthly bookkeeping retainer for dental practices', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'dental practices',
  payer: 'Dental practice owners', price: 900, monthly: true, cost: 450, capital: 0, daysToCash: 30, hours: 1, performer: 'SUBCONTRACTOR', subcontractor: 'LedgerPro Bookkeeping (quoted)',
  volume: '250 independent dental practices are listed in the state dental board directory; each pays monthly.', agreements: [900, 900, 900],
};

const RESTAURANT: OpeningFixture = {
  key: 'restaurant', title: 'Resale of liquidated restaurant kitchen equipment', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'restaurant equipment',
  payer: 'Restaurant operators', price: 14_000, cost: 8000, capital: 8000, daysToCash: 21, hours: 4, performer: 'SUBCONTRACTOR', subcontractor: 'Regional Auction & Freight (quoted)',
  agreements: [14_000, 14_000],
};

const FARM_GRANT: OpeningFixture = {
  key: 'farm', title: 'Farm grant planning service for Pennsylvania farm operators', mechanism: 'PRODUCTIZED_SERVICE', industry: 'farm grant planning',
  payer: 'Pennsylvania farm operators', price: 5000, cost: 300, capital: 0, daysToCash: 6, hours: 3, performer: 'NOBODY',
  volume: '120 Pennsylvania farm operators apply for the Farm Vitality Planning Grant each round, per the state agriculture department.', conversion: { paid: 12, of: 240 },
};

const CREDIT_UNION: OpeningFixture = {
  key: 'creditUnion', title: 'Quarterly market data workbook for Lakeside Credit Union', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'credit unions',
  payer: 'Lakeside Credit Union', price: 2500, cost: 50, capital: 0, daysToCash: 7, hours: 2, performer: 'BRAIN', agreements: [2500],
};

const ROOFING: OpeningFixture = {
  key: 'roofing', title: 'Weekly permit lead lists for regional roofing contractors', mechanism: 'INFORMATION_ASYMMETRY', industry: 'roofing contractors',
  payer: 'Regional roofing contractors', price: 199, cost: 0, capital: 0, daysToCash: 5, hours: 1, performer: 'BRAIN',
  volume: 'Contractors in the region buy permit lead lists weekly.', volumeBasis: 'ESTIMATE', conversion: { paid: 20, of: 250 },
};

const GIFTS: OpeningFixture = {
  key: 'gifts', title: 'Corporate year-end gifts, supplier drop-ships', mechanism: 'RESALE_OR_ASSET', industry: 'corporate gifting',
  payer: 'HR departments of mid-size firms', price: 1200, cost: null, capital: 0, daysToCash: 10, hours: 1, performer: 'SUBCONTRACTOR', subcontractor: 'GiftLine Wholesale (drop-ship supplier)',
  volume: '300 mid-size firms in the metro area order year-end gifts each December.', conversion: { paid: 25, of: 300 },
};

const RECORDS_RFP: OpeningFixture = {
  key: 'records', title: 'RFP: county records digitisation services', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'records digitisation',
  payer: 'Clark County Records Office', channel: 'the solicitation portal', price: 15_000, cost: 6000, capital: 0, daysToCash: null, hours: 4,
  performer: 'SUBCONTRACTOR', subcontractor: 'ScanWorks LLC (subcontractor quote)', agreements: [15_000],
};

const HVAC: OpeningFixture = {
  key: 'hvac', title: 'Commercial HVAC installation for Riverside Mall', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'commercial HVAC',
  payer: 'Riverside Mall management', price: 9000, cost: 5000, capital: 0, daysToCash: 14, hours: 40, performer: 'NOBODY', agreements: [9000],
};

/** The owner's own consulting: 10 owner hours a deal. */
const OWNER_CONSULTING: OpeningFixture = {
  key: 'ownerConsulting', title: 'Tenant-screening policy consultation for property managers', mechanism: 'CAPABILITY_ARBITRAGE', industry: 'property management',
  payer: 'Property managers', price: 1000, cost: 0, capital: 0, daysToCash: 7, hours: 10, performer: 'OWNER', agreements: [1000, 1000, 1000, 1000],
};

/* ---------------- held-out openings (industries and mechanisms no fixture uses) ---------------- */

const VET: OpeningFixture = {
  key: 'vet', title: 'Controlled-substance log reconciliation workbook for veterinary clinics', mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION', industry: 'veterinary clinics',
  payer: 'Veterinary clinic managers', price: 450, cost: 5, capital: 0, daysToCash: 4, hours: 1, performer: 'BRAIN',
  volume: '1,200 veterinary clinics are licensed by the state board; each must reconcile its controlled-substance log quarterly.', conversion: { paid: 36, of: 300 },
};

const BREWERY: OpeningFixture = {
  key: 'brewery', title: 'Monthly federal excise (TTB) report preparation for craft breweries', mechanism: 'PRODUCTIZED_SERVICE', industry: 'craft breweries',
  payer: 'Craft brewery owners', price: 300, monthly: true, cost: 10, capital: 0, daysToCash: 15, hours: 1, performer: 'BRAIN',
  volume: '180 licensed craft breweries in the state file TTB excise returns monthly.', agreements: [300, 300, 300, 300, 300, 300],
};

const MARITIME: OpeningFixture = {
  key: 'maritime', title: 'Ballast-water management record packs for coastal ship operators', mechanism: 'DIAGNOSTIC_OPPORTUNITY', industry: 'coastal shipping',
  payer: 'Coastal ship operators', channel: null, price: 2500, cost: 50, capital: 0, daysToCash: 14, hours: 2, performer: 'BRAIN',
  volume: '90 coastal operators are registered with the port authority; each needs a pack per vessel each year.', conversion: { paid: 9, of: 120 },
};

const SOLAR: OpeningFixture = {
  key: 'solar', title: 'Interconnection permit packages for residential solar installers', mechanism: 'PRODUCTIZED_SERVICE', industry: 'residential solar installation',
  payer: 'Residential solar installers', price: 400, cost: 20, capital: 0, daysToCash: null, hours: 1, performer: 'BRAIN',
  volume: '150 solar installers hold state contractor licences; each files 10 interconnection applications a month.', conversion: { paid: 30, of: 300 },
};

const COURT: OpeningFixture = {
  key: 'court', title: 'Expedited deposition transcript production for litigation firms', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'court reporting',
  payer: 'Litigation firms', price: 1800, cost: 900, capital: 0, daysToCash: 60, hours: 1, performer: 'SUBCONTRACTOR', subcontractor: 'Verbatim Reporting Group (quoted)',
  agreements: [1800, 1800, 1800, 1800],
};

const WEDDING: OpeningFixture = {
  key: 'wedding', title: 'Seating chart and vendor run-sheet workbooks for wedding venues', mechanism: 'PRODUCTIZED_SERVICE', industry: 'wedding venues',
  payer: 'Wedding venue coordinators', price: 350, cost: 5, capital: 0, daysToCash: 3, hours: 1, performer: 'BRAIN',
  volume: '500 wedding venues are listed in the regional venue directory; each hosts weddings every weekend in season.', conversion: { paid: 30, of: 250 },
};

const TRANSLATION: OpeningFixture = {
  key: 'translation', title: 'Certified document translation for immigration law firms', mechanism: 'CAPABILITY_ARBITRAGE', industry: 'immigration law',
  payer: 'Immigration law firms', price: 400, cost: 0, capital: 0, daysToCash: 7, hours: 6, performer: 'OWNER',
  agreements: [400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
};

const AVIATION: OpeningFixture = {
  key: 'aviation', title: 'Brokered overhaul exchange units for regional aircraft maintenance shops', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'aviation maintenance',
  payer: 'Regional MRO shops', price: 40_000, cost: 34_000, capital: 34_000, daysToCash: 20, hours: 6, performer: 'SUBCONTRACTOR', subcontractor: 'AeroSpares Exchange (quoted)',
  agreements: [40_000],
};

const WATER: OpeningFixture = {
  key: 'water', title: 'Lead service line inventory workbooks for small water utilities', mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION', industry: 'municipal water utilities',
  payer: 'Small water utility managers', price: 4000, cost: 40, capital: 0, daysToCash: 21, hours: 3, performer: 'BRAIN', agreements: [4000, 4000],
};

const LOCALISATION: OpeningFixture = {
  key: 'localisation', title: 'Brokered game-text localisation for indie studios', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'indie game studios',
  payer: 'Indie game studios', price: 2000, cost: 2300, capital: 0, daysToCash: 10, hours: 2, performer: 'SUBCONTRACTOR', subcontractor: 'Polyglot Freelance Collective (quoted)',
  agreements: [2000, 2000, 2000, 2000, 2000],
};

const PHARMACY: OpeningFixture = {
  key: 'pharmacy', title: 'Cold-chain prescription delivery for independent pharmacies', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'independent pharmacies',
  payer: 'Independent pharmacy owners', price: 180, cost: 95, capital: 0, daysToCash: 7, hours: 0.5, performer: 'SUBCONTRACTOR', subcontractor: 'MedCourier LLC (quoted)',
  volume: '35 independent pharmacies in the county ship 20 temperature-controlled deliveries a week.', conversion: { paid: 22, of: 200 },
};

const BEEKEEPING: OpeningFixture = {
  key: 'beekeeping', title: 'Brokered almond-pollination hive contracts for beekeepers', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'commercial beekeeping',
  payer: 'Almond growers', price: 150, priceBasis: 'PERSON', cost: 110, capital: 0, daysToCash: 14, hours: 0.2, performer: 'SUBCONTRACTOR', subcontractor: 'Valley Apiaries (quoted)',
  volume: '400 almond growers in the valley rent hives every February.', conversion: { paid: 20, of: 200 },
};

const EQUESTRIAN: OpeningFixture = {
  key: 'equestrian', title: 'Liability waiver and boarding-agreement management for horse boarding stables', mechanism: 'PRODUCTIZED_SERVICE', industry: 'horse boarding',
  payer: 'Boarding stable owners', price: 900, priceContradiction: 90, cost: 5, capital: 0, daysToCash: 5, hours: 1, performer: 'BRAIN',
  volume: '260 boarding stables are registered with the state equine council.', conversion: { paid: 26, of: 260 },
};

const GROOMING: OpeningFixture = {
  key: 'grooming', title: 'No-show analysis workbook for dog grooming salons', mechanism: 'DIAGNOSTIC_OPPORTUNITY', industry: 'pet grooming',
  payer: 'Grooming salon owners', price: 250, cost: 5, capital: 0, daysToCash: 3, hours: 1, performer: 'BRAIN', agreements: [250, 250, 250, 250, 250],
};

const FUNERAL: OpeningFixture = {
  key: 'funeral', title: 'Obituary syndication workbooks for funeral homes', mechanism: 'PRODUCTIZED_SERVICE', industry: 'funeral homes',
  payer: 'Funeral home directors', price: 200, cost: 5, capital: 0, daysToCash: 5, hours: 1, performer: 'BRAIN',
  volume: '600 funeral homes are licensed by the state board; each publishes obituaries weekly.',
};

export const PUBLIC_CASES: PlanningCase[] = [
  /* ================= familiar ================= */
  {
    id: 'fam-01-property-executable', heldOut: false,
    description: 'Every link evidenced: 400 buyers × a measured 10% × $600 = $24,000 against a $5,000 target in 30 days, Brain performs, $10 cost. An executable plan exists.',
    dimensions: dims({ industry: 'property management', mechanism: 'PRODUCTIZED_SERVICE' }),
    objective: 'Collect $5,000 of settled cash within 30 days using no up-front capital.',
    openings: [PROPERTY],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'fam-02-dental-monthly-executable', heldOut: false,
    description: 'Three practices signed a $900/month retainer: $2,700 a month against a $2,000 monthly target, subcontracted at half the price. Executable.',
    dimensions: dims({ industry: 'dental practices', mechanism: 'SUBCONTRACTED_FULFILMENT', target: 'small' }),
    objective: 'Earn $2,000 a month in recurring revenue within 60 days using no up-front capital.',
    openings: [DENTAL_RETAINER],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'fam-03-cleaning-no-fulfiller', heldOut: false,
    description: 'Two contractors signed, but nobody is established to do the cleanup (no crew, no Brain capability). No executable plan: the decisive gap is fulfilment.',
    dimensions: dims({ industry: 'commercial cleaning', mechanism: 'SUBCONTRACTED_FULFILMENT', missingEvidence: 'FULFILMENT' }),
    objective: 'Collect $5,000 of settled cash within 45 days using no up-front capital.',
    openings: [{ ...CLEANING, performer: 'NOBODY', subcontractor: undefined }],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['FULFILMENT'], opening: 'cleaning' } },
  },
  {
    id: 'fam-04-out-of-reach-target', heldOut: false,
    description: '$500,000 in 5 days: the whole evidenced market (400 buyers × $600 = $240,000) is under the target, at any conversion. Infeasible as stated.',
    dimensions: dims({ industry: 'property management', mechanism: 'PRODUCTIZED_SERVICE', target: 'out-of-reach', deadline: 'short' }),
    objective: 'Collect $500,000 of settled cash within 5 days using no up-front capital.',
    openings: [PROPERTY],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['TARGET', 'DEADLINE'] } },
  },
  {
    id: 'fam-05-restaurant-capital-limit', heldOut: false,
    description: 'The only opening ties up $8,000 per lot; the objective allows $1,000. Nothing evidences a buyer prepaying. The capital limit rules it out.',
    dimensions: dims({ industry: 'restaurant equipment', mechanism: 'SUPPLY_DEMAND_MISMATCH', capital: 'small', target: 'medium' }),
    objective: 'Collect $10,000 of settled cash within 30 days with at most $1,000 of capital.',
    openings: [RESTAURANT],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['CAPITAL'], links: ['ECONOMICS'] } },
  },
  {
    id: 'fam-06-dental-price-only-said', heldOut: false,
    description: 'A compliance report whose $200 price only the owner stated: nothing shows buyers pay it. No executable plan until the price is evidenced.',
    dimensions: dims({ industry: 'dental practices', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'OFFER_AND_PRICE' }),
    objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.',
    openings: [{ ...PROPERTY, key: 'dentalReport', title: 'Infection-control compliance report for dental practices', industry: 'dental practices', payer: 'Dental practice owners', price: 200, priceBasis: 'PERSON', volume: '250 independent dental practices are listed in the state dental board directory; each needs one a year.' }],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE'] } },
  },
  {
    id: 'fam-07-property-price-contradicted', heldOut: false,
    description: 'The card says $600, but the sourced price is $60: the evidence contradicts the figure the plan would rest on (at $60, 400 buyers × 10% is $2,400, under the $5,000 target). The price must be settled first; no executable plan on a contested price.',
    dimensions: dims({ industry: 'property management', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'OFFER_AND_PRICE', contradictoryEvidence: true }),
    objective: 'Collect $5,000 of settled cash within 30 days using no up-front capital.',
    openings: [{ ...PROPERTY, priceContradiction: 60 }],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE', 'ECONOMICS'] } },
  },
  {
    id: 'fam-08-cleaning-industry-scope', heldOut: false,
    description: 'The owner names commercial cleaning: two signed $3,000 cleanups cover $5,000. The property spreadsheet is outside the named industry and may not be used.',
    dimensions: dims({ industry: 'commercial cleaning', mechanism: 'SUBCONTRACTED_FULFILMENT' }),
    objective: 'Generate $5,000 within 45 days in a single industry the owner names: commercial cleaning.',
    openings: [CLEANING, PROPERTY],
    expect: { verdict: 'EXECUTABLE_PLAN', mustNotUse: ['property'] },
  },
  {
    id: 'fam-09-owner-hours', heldOut: false,
    description: '5 owner hours a week over 30 days is ~21 hours. The Brain-produced spreadsheet reaches $4,000 alone with no owner hours; the owner consultation would take 10 hours a deal. A correct plan stays inside the hours.',
    dimensions: dims({ industry: 'property management', mechanism: 'CAPABILITY_ARBITRAGE', autonomy: 'owner-hours-limited' }),
    objective: 'Collect $4,000 of settled cash within 30 days with no more than 5 hours a week of owner time.',
    openings: [PROPERTY, OWNER_CONSULTING],
    expect: { verdict: 'EXECUTABLE_PLAN', ownerHoursMax: 21 },
  },
  {
    id: 'fam-10-gifts-cost-unknown', heldOut: false,
    description: 'Drop-shipped gifts whose supplier cost nobody established: the margin, and so the economics, are unknown. No executable plan until the cost is known.',
    dimensions: dims({ industry: 'corporate gifting', mechanism: 'RESALE_OR_ASSET', target: 'medium', missingEvidence: 'ECONOMICS' }),
    objective: 'Collect $10,000 of settled cash within 30 days using no up-front capital.',
    openings: [GIFTS],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['ECONOMICS'] } },
  },
  {
    id: 'fam-11-rfp-settlement-unknown', heldOut: false,
    description: 'A county award agreed at $15,000, but nobody established when the county pays; with 20 days, settlement inside the window is the decisive unknown.',
    dimensions: dims({ industry: 'records digitisation', mechanism: 'EXPLICIT_PAID_REQUEST', deadline: 'short', target: 'medium', missingEvidence: 'SETTLES_IN_TIME' }),
    objective: 'Collect $12,000 of settled cash within 20 days using no up-front capital.',
    openings: [RECORDS_RFP],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['SETTLES_IN_TIME'] } },
  },
  {
    id: 'fam-12-credit-union-agreed', heldOut: false,
    description: 'The credit union signed for a $2,500 workbook Brain produces, paying in 7 days: $2,000 in 14 days with $500 of capital is executable.',
    dimensions: dims({ industry: 'credit unions', mechanism: 'EXPLICIT_PAID_REQUEST', capital: 'small', deadline: 'short' }),
    objective: 'Collect $2,000 of settled cash within 14 days with at most $500 of capital.',
    openings: [CREDIT_UNION],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 500 },
  },
  {
    id: 'fam-13-roofing-volume-estimated', heldOut: false,
    description: 'Lead lists at $199 need 16+ sales for $3,000; how many contractors buy is only Brain’s estimate. Market volume is the decisive unknown.',
    dimensions: dims({ industry: 'roofing contractors', mechanism: 'INFORMATION_ASYMMETRY', missingEvidence: 'MARKET_VOLUME' }),
    objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.',
    openings: [ROOFING],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['MARKET_VOLUME'] } },
  },
  {
    id: 'fam-14-objective-changed-industry', heldOut: false,
    description: 'Planned for property management, then the owner changed the industry to commercial cleaning: the plan must follow the new objective (the signed cleanups), not the property spreadsheet.',
    dimensions: dims({ industry: 'commercial cleaning', mechanism: 'SUBCONTRACTED_FULFILMENT', objectiveChanged: true }),
    objective: 'Generate $5,000 within 45 days in a single industry the owner names: property management.',
    changedObjective: 'Generate $5,000 within 45 days in a single industry the owner names: commercial cleaning.',
    openings: [PROPERTY, CLEANING],
    expect: { verdict: 'EXECUTABLE_PLAN', mustNotUse: ['property'] },
  },
  {
    id: 'fam-15-objective-changed-to-blocked', heldOut: false,
    description: 'An open objective the property spreadsheet meets, changed to farm grant planning only — where nobody is established to prepare the plans. After the change no executable plan; fulfilment is the gap.',
    dimensions: dims({ industry: 'farm grant planning', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'FULFILMENT', objectiveChanged: true }),
    objective: 'Collect $5,000 of settled cash within 30 days using no up-front capital.',
    changedObjective: 'Generate $5,000 within 30 days in a single industry the owner names: farm grant planning.',
    openings: [PROPERTY, FARM_GRANT],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['FULFILMENT'], opening: 'farm' }, mustNotUse: ['property'] },
  },
  {
    id: 'fam-16-restaurant-large-capital', heldOut: false,
    description: 'Two restaurants signed at $14,000; each lot ties up $8,000 inside a $10,000 limit and pays in 21 days, so two lots fit in 60 days: $28,000 ≥ $20,000. Executable.',
    dimensions: dims({ industry: 'restaurant equipment', mechanism: 'SUPPLY_DEMAND_MISMATCH', capital: 'large', target: 'large' }),
    objective: 'Collect $20,000 of settled cash within 60 days with at most $10,000 of capital.',
    openings: [RESTAURANT],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 10_000 },
  },
  {
    id: 'fam-17-hvac-no-installer', heldOut: false,
    description: 'The mall signed for $9,000 of HVAC installation, but nobody established who installs it. Fulfilment is the decisive gap.',
    dimensions: dims({ industry: 'commercial HVAC', mechanism: 'EXPLICIT_PAID_REQUEST', target: 'medium', missingEvidence: 'FULFILMENT' }),
    objective: 'Collect $9,000 of settled cash within 30 days using no up-front capital.',
    openings: [HVAC],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['FULFILMENT'] } },
  },
  {
    id: 'fam-18-property-conversion-unmeasured', heldOut: false,
    description: 'The property spreadsheet with no buyer asked and no measured rate: how many of 400 agree is unknown. No executable plan is established; conversion is the decisive unknown the first offers measure.',
    dimensions: dims({ industry: 'property management', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'CONVERSION' }),
    objective: 'Collect $5,000 of settled cash within 30 days using no up-front capital.',
    openings: [{ ...PROPERTY, conversion: null }],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['CONVERSION'] } },
  },

  /* ================= held-out ================= */
  {
    id: 'ho-01-vet-executable', heldOut: true,
    description: '1,200 clinics × a measured 12% × $450 ≈ $64,800 against $3,000 in 30 days; Brain produces the workbook at $5. Executable.',
    dimensions: dims({ industry: 'veterinary clinics', mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION' }),
    objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.',
    openings: [VET],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'ho-02-brewery-monthly', heldOut: true,
    description: 'Six breweries signed at $300 a month: $1,800 monthly against a $1,500 monthly target in 45 days, Brain prepares it. Executable.',
    dimensions: dims({ industry: 'craft breweries', mechanism: 'PRODUCTIZED_SERVICE' }),
    objective: 'Earn $1,500 a month in recurring revenue within 45 days using no up-front capital.',
    openings: [BREWERY],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'ho-03-maritime-no-channel', heldOut: true,
    description: 'Operators pay and a rate is measured, but nobody established how to reach them. The reachable buyer is the decisive gap.',
    dimensions: dims({ industry: 'coastal shipping', mechanism: 'DIAGNOSTIC_OPPORTUNITY', missingEvidence: 'REACHABLE_BUYER' }),
    objective: 'Collect $5,000 of settled cash within 30 days using no up-front capital.',
    openings: [MARITIME],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['REACHABLE_BUYER'] } },
  },
  {
    id: 'ho-04-solar-settlement-unknown', heldOut: true,
    description: 'Permit packages with every link but when installers pay; the deadline is 10 days, so settlement inside it is the decisive unknown.',
    dimensions: dims({ industry: 'residential solar installation', mechanism: 'PRODUCTIZED_SERVICE', deadline: 'short', missingEvidence: 'SETTLES_IN_TIME' }),
    objective: 'Collect $2,000 of settled cash within 10 days using no up-front capital.',
    openings: [SOLAR],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['SETTLES_IN_TIME'] } },
  },
  {
    id: 'ho-05-court-pays-after-deadline', heldOut: true,
    description: 'Four firms signed at $1,800, but transcripts are paid 60 days out and the deadline is 14 days: no cash can settle in time. Infeasible on the deadline.',
    dimensions: dims({ industry: 'court reporting', mechanism: 'SUBCONTRACTED_FULFILMENT', deadline: 'short', target: 'medium' }),
    objective: 'Collect $6,000 of settled cash within 14 days using no up-front capital.',
    openings: [COURT],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['DEADLINE'], links: ['SETTLES_IN_TIME'] } },
  },
  {
    id: 'ho-06-wedding-owner-hours', heldOut: true,
    description: '3 owner hours a week, but Brain performs every deal: 500 venues × a measured 12% × $350 against $2,500 in 21 days. Executable with no owner labour.',
    dimensions: dims({ industry: 'wedding venues', mechanism: 'PRODUCTIZED_SERVICE', autonomy: 'owner-hours-limited' }),
    objective: 'Collect $2,500 of settled cash within 21 days with no more than 3 hours a week of owner time.',
    openings: [WEDDING],
    expect: { verdict: 'EXECUTABLE_PLAN', ownerHoursMax: 9 },
  },
  {
    id: 'ho-07-translation-owner-hours-exceeded', heldOut: true,
    description: 'Ten firms signed at $400, but the owner translates personally at 6 hours a deal: $4,000 needs 60 owner hours against ~13 allowed. Infeasible on owner hours.',
    dimensions: dims({ industry: 'immigration law', mechanism: 'CAPABILITY_ARBITRAGE', autonomy: 'owner-hours-limited' }),
    objective: 'Collect $4,000 of settled cash within 30 days with no more than 3 hours a week of owner time.',
    openings: [TRANSLATION],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['OWNER_HOURS'], links: ['FULFILMENT'] }, ownerHoursMax: 13 },
  },
  {
    id: 'ho-08-aviation-unfunded', heldOut: true,
    description: 'A signed $40,000 exchange unit costs $34,000 up front; the objective allows $2,000 and nothing evidences the shop prepaying. The capital limit rules it out.',
    dimensions: dims({ industry: 'aviation maintenance', mechanism: 'SUPPLY_DEMAND_MISMATCH', capital: 'small' }),
    objective: 'Collect $5,000 of settled cash within 30 days with at most $2,000 of capital.',
    openings: [AVIATION],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['CAPITAL'], links: ['ECONOMICS'] } },
  },
  {
    id: 'ho-09-water-utility-agreed', heldOut: true,
    description: 'Two utilities signed $4,000 lead-line inventories Brain produces, paid in 21 days: $8,000 against $6,000 in 30 days. Executable.',
    dimensions: dims({ industry: 'municipal water utilities', mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION', target: 'medium' }),
    objective: 'Collect $6,000 of settled cash within 30 days using no up-front capital.',
    openings: [WATER],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'ho-10-localisation-loses-money', heldOut: true,
    description: 'Five studios signed at $2,000, but each translation costs $2,300: collecting $8,000 loses $1,500. No sound plan on this opening; the economics are the blocker.',
    dimensions: dims({ industry: 'indie game studios', mechanism: 'SUBCONTRACTED_FULFILMENT', target: 'medium', missingEvidence: 'ECONOMICS' }),
    objective: 'Collect $8,000 of settled cash within 30 days using no up-front capital.',
    openings: [LOCALISATION],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['ECONOMICS'] } },
  },
  {
    id: 'ho-11-pharmacy-courier', heldOut: true,
    description: '700 deliveries a week across 35 pharmacies, a measured 11%, $85 margin a delivery subcontracted: $3,000 in 30 days is executable.',
    dimensions: dims({ industry: 'independent pharmacies', mechanism: 'SUBCONTRACTED_FULFILMENT' }),
    objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.',
    openings: [PHARMACY],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'ho-12-beekeeping-price-said', heldOut: true,
    description: 'The $150-a-hive rental price is only the owner’s word; nothing shows growers pay it. Price is the decisive gap.',
    dimensions: dims({ industry: 'commercial beekeeping', mechanism: 'SUPPLY_DEMAND_MISMATCH', missingEvidence: 'OFFER_AND_PRICE' }),
    objective: 'Collect $2,000 of settled cash within 30 days using no up-front capital.',
    openings: [BEEKEEPING],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE'] } },
  },
  {
    id: 'ho-13-equestrian-price-contradicted', heldOut: true,
    description: 'The card prices it at $900; the sourced price is $90. On a contested price no executable plan is established; the price is the decisive gap.',
    dimensions: dims({ industry: 'horse boarding', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'OFFER_AND_PRICE', contradictoryEvidence: true }),
    objective: 'Collect $4,000 of settled cash within 30 days using no up-front capital.',
    openings: [EQUESTRIAN],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE', 'ECONOMICS'] } },
  },
  {
    id: 'ho-14-objective-changed-to-recurring', heldOut: true,
    description: 'Planned as one-time cash, then changed to monthly recurring revenue: only the signed brewery retainers ($1,800 a month) count; the one-off vet workbook may not be planned.',
    dimensions: dims({ industry: 'craft breweries', mechanism: 'PRODUCTIZED_SERVICE', objectiveChanged: true }),
    objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.',
    changedObjective: 'Earn $1,500 a month in recurring revenue within 45 days using no up-front capital.',
    openings: [VET, BREWERY],
    expect: { verdict: 'EXECUTABLE_PLAN', mustNotUse: ['vet'], targetAfterChange: 1500 },
  },
  {
    id: 'ho-15-out-of-reach-target', heldOut: true,
    description: '$2,000,000 in 14 days: every licensed clinic at $450 is $540,000. Infeasible as stated.',
    dimensions: dims({ industry: 'veterinary clinics', mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION', target: 'out-of-reach', deadline: 'short' }),
    objective: 'Collect $2,000,000 of settled cash within 14 days using no up-front capital.',
    openings: [VET],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'INFEASIBLE', constraints: ['TARGET', 'DEADLINE'] } },
  },
  {
    id: 'ho-16-grooming-short-deadline', heldOut: true,
    description: 'Five salons signed at $250, paid in 3 days, Brain produces it: $1,250 against $1,000 in 7 days. Executable.',
    dimensions: dims({ industry: 'pet grooming', mechanism: 'DIAGNOSTIC_OPPORTUNITY', deadline: 'short' }),
    objective: 'Collect $1,000 of settled cash within 7 days using no up-front capital.',
    openings: [GROOMING],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'ho-17-funeral-conversion-unmeasured', heldOut: true,
    description: 'Every link but conversion: nobody has asked a funeral home and no rate is measured. Conversion is the decisive unknown.',
    dimensions: dims({ industry: 'funeral homes', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'CONVERSION' }),
    objective: 'Collect $4,000 of settled cash within 30 days using no up-front capital.',
    openings: [FUNERAL],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['CONVERSION'] } },
  },
];
