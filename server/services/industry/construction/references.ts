/**
 * Published evidence about an industry, held as evidence (§92).
 *
 * A reference pack is not a template and names no business: it is the facts a
 * researcher found, each with its source, its status and the market it was
 * measured in. It is the weakest layer the construction reads — anything the
 * industry map establishes through the evidence gate, and anything the
 * operation itself observes, answers ahead of it (`model.resolveFact`), and a
 * figure measured somewhere else is a comparable, never a fact about this
 * market.
 *
 * Contract rates nobody publishes are deliberately absent or marked
 * ASSUMPTION. What Amazon pays a Delivery Service Partner per route is not
 * public, so it is UNKNOWN here, and the construction solves for the rate at
 * which that entry would break even instead of inventing one.
 *
 * Gathered 2026-11-07. A pack is matched to an operator's words by its tags.
 */
import type { Fact, FactKey, FactSource, IndustryEvidence } from '../../../domain/construction.ts';

const S = {
  amazonDsp: { title: 'Amazon Delivery Service Partner program brochure (startup costs "as low as $10,000", based on the first 5 vans and third-party deals)', url: 'https://go.pardot.com/l/714563/2020-09-25/nrl6g', kind: 'PRIMARY' },
  geekwire: { title: 'GeekWire: owning an Amazon delivery business — risks, rewards and economic realities', url: 'https://www.geekwire.com/2018/owning-amazon-delivery-business-risks-rewards-economic-realities-tech-giants-new-program-entrepreneurs/', kind: 'SECONDARY' },
  adbadger: { title: 'AD Badger: how much it costs to start an Amazon DSP ($30,000 liquid assets to qualify — unconfirmed by Amazon)', url: 'https://www.adbadger.com/blog/how-much-does-it-cost-to-start-an-amazon-dsp/', kind: 'SECONDARY' },
  wagedex: { title: 'WageDex (BLS OEWS): light truck drivers, Detroit-Warren-Dearborn — median $21.25/h, p10 $29,750/y, p90 $82,800/y', url: 'https://wagedex.com/jobs/light-truck-drivers/metro/detroit-warren-dearborn-mi', kind: 'SECONDARY' },
  bond: { title: 'FMCSA property broker financial security: $75,000 BMC-84 bond or BMC-85 trust; premiums about 1.25%–10% a year', url: 'https://www.suretybonds.com/freight-broker-bond.html', kind: 'SECONDARY' },
  ontrac: { title: 'Cargo-van route posting for OnTrac (NYC): $2.00 per stop, 50–60 stops a day, no fuel reimbursement', url: 'https://www.cbdriver.com/nyc-driver-cargo-van-sprinter-only-ontrac-68197-ad.aspx', kind: 'SECONDARY' },
  contractor: { title: '1099 cargo-van final-mile posting (Texas): $3.50–$4.10 per stop for experienced drivers', url: 'https://www.careerbuilder.com/job-details/delivery-driver-cargo-van-independent-contractor-waco-tx--0a9d85a6-7d92-4924-8eb2-1a6b879dd581', kind: 'SECONDARY' },
  costPerStop: { title: 'FleetRabbit: cost per delivery benchmarks for last-mile (average all-in carrier cost per stop about $10.10)', url: 'https://fleetrabbit.com/industry/e-commerce-logistics/what-is-cost-per-delivery-roi-and-savings-guide', kind: 'SECONDARY' },
  insurify: { title: 'Insurify: cargo van commercial insurance $1,200–$6,800 a year', url: 'https://insurify.com/business-insurance/commercial-auto/cargo-van-insurance', kind: 'SECONDARY' },
  logrock: { title: 'LogRock: courier van insurance 2026 — $1,200–$3,500 liability-only, $2,500–$7,500+ full coverage', url: 'https://www.logrock.com/commercial-truck-insurance/courier-motor-insurance-2/', kind: 'SECONDARY' },
  moneygeek: { title: 'MoneyGeek: courier business insurance averages $2,022 a year', url: 'https://www.moneygeek.com/insurance/business/transportation/courier/cost/', kind: 'SECONDARY' },
  vanRental: { title: 'Roseville Midway Ford (Roseville, MI): Transit cargo van rental $799–$899 a week', url: 'https://www.rosevillemidwayford.com/ford-transit-cargo-van-rental', kind: 'SECONDARY' },
  michiganLlc: { title: 'Michigan LARA: articles of organization for a domestic LLC, $50 filing fee', url: 'https://www.michigan.gov/lara', kind: 'PRIMARY' },
  assumption: { title: 'Brain planning assumption, not researched — the first buyer and supplier conversations settle it', url: null, kind: 'OPERATOR' },
} satisfies Record<string, FactSource>;

function f(key: FactKey, low: number, high: number, status: Fact['status'], source: FactSource, measures: string, segment: string | null = null, geography: string | null = null): Fact {
  return { key, segment, low, high, status, source, measures, geography };
}

const A = S.assumption;

/** Last-mile and local delivery, with Metro Detroit figures where a source states them. */
export function lastMileDelivery(): IndustryEvidence {
  return {
    industry: 'last-mile delivery',
    geography: 'Metro Detroit',
    workUnit: 'delivery stop',
    capacityUnit: 'cargo van',
    needsEquipment: true,
    provenance: ['reference pack: last-mile delivery (published sources gathered 2026-11-07)'],
    actors: [
      { id: 'local_merchants', name: 'Metro Detroit merchants, pharmacies, auto-parts and B2B distributors', role: 'BUYER', description: 'businesses that ship locally and own their end customer; buy scheduled or same-day runs', status: 'ASSUMPTION', source: A },
      { id: 'regional_carriers', name: 'regional last-mile carriers and 3PLs', role: 'BUYER', description: 'carriers that hold shipper volume and subcontract routes to cargo-van operators paid per stop', status: 'ESTIMATE', source: S.ontrac },
      { id: 'amazon_dsp', name: 'Amazon Logistics (Delivery Service Partner program)', role: 'BUYER', description: 'allocates route volume to selected partner companies that lease vans and employ drivers', status: 'VERIFIED', source: S.amazonDsp },
      { id: 'dsp_operators', name: 'existing DSP and contractor fleet owners in Metro Detroit', role: 'BUYER', description: 'operators whose constraint is hiring and keeping drivers', status: 'ESTIMATE', source: S.geekwire },
      { id: 'end_recipients', name: 'households and businesses receiving parcels', role: 'END_CUSTOMER', description: 'never pay the delivery operator directly; the shipper owns them', status: 'ESTIMATE', source: S.costPerStop },
      { id: 'independent_operators', name: 'independent cargo-van owner-operators (1099)', role: 'OPERATOR', description: 'bring their own van, insurance and labour; paid per stop or per day', status: 'ESTIMATE', source: S.contractor },
      { id: 'drivers', name: 'delivery drivers (W-2)', role: 'LABOR', description: 'employed by delivery companies at roughly $21/h in Metro Detroit', status: 'ESTIMATE', source: S.wagedex },
      { id: 'van_lessors', name: 'van dealers, rental and lease companies', role: 'ASSET_PROVIDER', description: 'rent or lease cargo vans weekly or long-term', status: 'ESTIMATE', source: S.vanRental },
      { id: 'insurers', name: 'commercial auto and cargo insurers', role: 'INSURER', description: 'price each van and each operation; buyers require proof of cover', status: 'ESTIMATE', source: S.insurify },
      { id: 'regulators', name: 'FMCSA and Michigan LARA', role: 'REGULATOR', description: 'interstate broker authority and bond; state business registration', status: 'VERIFIED', source: S.bond },
      { id: 'gig_platforms', name: 'app-based courier platforms', role: 'PLATFORM', description: 'match shippers to gig drivers and keep a take rate', status: 'ASSUMPTION', source: A },
    ],
    flows: [
      { from: 'local_merchants', to: 'end_recipients', kind: 'DEMAND', terms: 'the merchant owns the customer relationship and chooses the carrier', status: 'ASSUMPTION', source: A },
      { from: 'local_merchants', to: 'regional_carriers', kind: 'MONEY', terms: 'pays per stop or per route, invoiced weekly or monthly', status: 'ASSUMPTION', source: A },
      { from: 'regional_carriers', to: 'independent_operators', kind: 'MONEY', terms: '$2.00–$4.10 per stop to 1099 cargo-van operators, often without fuel reimbursement', status: 'ESTIMATE', source: S.ontrac },
      { from: 'amazon_dsp', to: 'dsp_operators', kind: 'MONEY', terms: 'route payments set by Amazon; the rate is not public', status: 'VERIFIED', source: S.geekwire },
      { from: 'dsp_operators', to: 'drivers', kind: 'MONEY', terms: 'hourly wages, about $21/h median in Metro Detroit', status: 'ESTIMATE', source: S.wagedex },
      { from: 'independent_operators', to: 'end_recipients', kind: 'WORK', terms: 'the physical delivery, with their own van', status: 'ESTIMATE', source: S.contractor },
      { from: 'drivers', to: 'end_recipients', kind: 'WORK', terms: 'the physical delivery, in leased vans', status: 'ESTIMATE', source: S.amazonDsp },
      { from: 'van_lessors', to: 'dsp_operators', kind: 'CAPACITY', terms: 'vans by the week ($799–$899 retail rental) or on long leases', status: 'ESTIMATE', source: S.vanRental },
      { from: 'dsp_operators', to: 'insurers', kind: 'RISK', terms: 'accident, cargo and liability risk transferred per van, $1,200–$7,500 a year', status: 'ESTIMATE', source: S.logrock },
      { from: 'amazon_dsp', to: 'dsp_operators', kind: 'AUTHORITY', terms: 'Amazon holds the shipper relationship and can end a partner’s routes', status: 'ESTIMATE', source: S.geekwire },
      { from: 'regulators', to: 'regional_carriers', kind: 'AUTHORITY', terms: 'brokering interstate freight needs FMCSA broker authority and $75,000 financial security', status: 'VERIFIED', source: S.bond },
    ],
    segments: [
      {
        actorId: 'local_merchants',
        buys: 'WORK',
        requires: ['INSURANCE_COVER'],
        acceptsIntermediary: true,
        channel: 'direct outreach to store and operations managers (calls, email, LinkedIn) with a scheduled-route quote',
        firstTransaction: 'one merchant’s scheduled weekday delivery run, invoiced weekly',
        status: 'ASSUMPTION',
        source: A,
      },
      {
        actorId: 'regional_carriers',
        buys: 'WORK',
        requires: ['INSURANCE_COVER', 'FLEET'],
        acceptsIntermediary: false,
        channel: 'carrier contractor-onboarding desks and station managers',
        firstTransaction: 'one dedicated cargo-van route for a regional carrier station, paid per stop',
        status: 'ESTIMATE',
        source: S.ontrac,
      },
      {
        actorId: 'amazon_dsp',
        buys: 'WORK',
        requires: ['PROGRAM_SELECTION', 'INSURANCE_COVER'],
        acceptsIntermediary: false,
        refuses: { supply: ['NETWORK'], because: 'program routes are driven by the partner’s own employed drivers, not subcontracted' },
        channel: 'the Amazon DSP application and selection process',
        firstTransaction: 'the first week of Amazon-assigned routes after selection and onboarding',
        status: 'VERIFIED',
        source: S.amazonDsp,
      },
      {
        actorId: 'dsp_operators',
        buys: 'LABOR',
        requires: [],
        acceptsIntermediary: true,
        channel: 'direct outreach to DSP and contractor-fleet owners in Metro Detroit',
        firstTransaction: 'one placed driver who completes 30 days, invoiced per placement',
        status: 'ASSUMPTION',
        source: A,
      },
    ],
    gates: [
      { id: 'llc', name: 'Michigan LLC registration', kind: 'REGISTRATION', applies: {}, upfrontLow: 50, upfrontHigh: 50, days: 3, grants: ['OPERATING_AUTHORITY'], status: 'VERIFIED', source: S.michiganLlc },
      { id: 'liability', name: 'General liability and cargo cover held in our name (first premium)', kind: 'INSURANCE', applies: { contract: ['PRIME'] }, upfrontLow: 500, upfrontHigh: 2_000, days: 7, grants: ['INSURANCE_COVER'], status: 'ESTIMATE', source: S.moneygeek },
      { id: 'broker_authority', name: 'FMCSA broker authority with BMC-84 bond premium (only when the brokered moves are interstate)', kind: 'BOND', applies: { contract: ['INTRODUCE'], segments: ['regional_carriers'] }, upfrontLow: 1_250, upfrontHigh: 7_800, days: 30, grants: ['OPERATING_AUTHORITY'], status: 'VERIFIED', source: S.bond },
      { id: 'dsp_program', name: 'Amazon DSP selection and startup (brochure: as low as $10,000 for five vans with every partner deal; $30,000 liquidity reported, unconfirmed)', kind: 'PROGRAM_SELECTION', applies: { segments: ['amazon_dsp'] }, upfrontLow: 10_000, upfrontHigh: 30_000, days: 120, grants: ['PROGRAM_SELECTION'], requires: [], status: 'ESTIMATE', source: S.amazonDsp },
    ],
    chokepoints: [
      { id: 'shipper_contracts', name: 'the shipper contract and its end customer', why: 'whoever holds the merchant’s contract sets the price and chooses who carries it; carriers below are paid per stop', controlledBy: ['CUSTOMER_CONTRACTS', 'DELIVERY_RECORD'], status: 'ESTIMATE', source: S.ontrac },
      { id: 'program_routes', name: 'route allocation inside national carrier partner programs', why: 'programs allocate dense, recurring route volume to a few selected operators', controlledBy: ['PROGRAM_SELECTION', 'FLEET', 'OPERATING_CAPABILITY'], status: 'ESTIMATE', source: S.geekwire },
      { id: 'driver_supply', name: 'reliable driver and owner-operator supply', why: 'every operator’s growth is limited by hiring and keeping drivers', controlledBy: ['SUPPLY_NETWORK', 'LABOR_PIPELINE'], status: 'ASSUMPTION', source: A },
      { id: 'zone_density', name: 'stop density in a delivery zone', why: 'cost per stop falls as stops per route rise, so the densest operator in a zone undercuts the rest', controlledBy: ['ROUTE_DENSITY', 'DISPATCH_DATA'], status: 'ESTIMATE', source: S.costPerStop },
    ],
    scale: [
      { id: 'density', kind: 'DENSITY', rewards: 'ROUTE_DENSITY', statement: 'cost per stop falls with stops per route; pooling several merchants on one van raises stops per van-day', status: 'ESTIMATE', source: S.costPerStop },
      { id: 'scope', kind: 'SCOPE', rewards: 'CUSTOMER_CONTRACTS', statement: 'the same van and driver can carry parcels, pharmacy and auto-parts work for different buyers', status: 'ASSUMPTION', source: A },
      { id: 'scale', kind: 'SCALE', rewards: 'FLEET', statement: 'insurance, dispatch and management overhead spread across more vans', status: 'ASSUMPTION', source: A },
    ],
    failures: [
      { id: 'accident', statement: 'a van accident or cargo claim costs the deductible and can raise every premium', applies: { supply: ['EMPLOY'] }, costLow: 1_000, costHigh: 2_500, status: 'ASSUMPTION', source: A },
      { id: 'no_show', statement: 'an independent operator misses a route and the account is put at risk', applies: { supply: ['NETWORK'] }, status: 'ASSUMPTION', source: A },
      { id: 'concentration', statement: 'one buyer holds all the volume and can end the routes', applies: { contract: ['PRIME'], supply: ['EMPLOY'] }, status: 'ESTIMATE', source: S.geekwire },
      { id: 'misclassification', statement: 'independent operators are controlled like employees and the arrangement is reclassified', applies: { supply: ['NETWORK'] }, status: 'ASSUMPTION', source: A },
      { id: 'late_payment', statement: 'a buyer pays later than invoiced while supply is paid weekly', applies: { contract: ['PRIME'] }, status: 'ASSUMPTION', source: A },
    ],
    adjacencies: [
      { id: 'medical', name: 'medical and pharmacy courier', via: ['DELIVERY_RECORD', 'INSURANCE_COVER'], statement: 'higher-value scheduled runs for buyers who require a clean record', status: 'ASSUMPTION', source: A },
      { id: 'auto_parts', name: 'automotive parts hot-shot runs for Detroit suppliers and dealers', via: ['CUSTOMER_CONTRACTS', 'FLEET'], statement: 'time-critical B2B runs in the region’s auto supply chain', status: 'ASSUMPTION', source: A },
      { id: 'cross_dock', name: 'cross-dock and micro-fulfilment', via: ['ROUTE_DENSITY', 'CUSTOMER_CONTRACTS'], statement: 'once dense volume runs through one operator, holding it overnight is the next service', status: 'ASSUMPTION', source: A },
      { id: 'program_routes', name: 'national carrier partner programs (Amazon DSP, FedEx Ground ISP)', via: ['OPERATING_CAPABILITY', 'FLEET', 'DELIVERY_RECORD'], statement: 'dense recurring routes for an operator that already runs a fleet', status: 'ESTIMATE', source: S.geekwire },
    ],
    competition: [
      { id: 'nationals', statement: 'national carriers and Amazon Logistics hold most parcel volume; app-based courier platforms compete for on-demand local work', status: 'ASSUMPTION', source: A },
      { id: 'barriers', statement: 'entry into local courier work is cheap; entry into program routes is gated by selection and capital', status: 'ESTIMATE', source: S.amazonDsp },
    ],
    bargaining: [
      { id: 'amazon_power', holder: 'amazon_dsp', over: 'dsp_operators', statement: 'Amazon sets route pay and can end a partner’s routes; partners have little say', status: 'ESTIMATE', source: S.geekwire },
      { id: 'merchant_power', holder: 'local_merchants', over: 'regional_carriers', statement: 'merchants have many carriers to choose from for small local volume', status: 'ASSUMPTION', source: A },
      { id: 'driver_power', holder: 'drivers', over: 'dsp_operators', statement: 'in a tight driver market, drivers move for small wage differences', status: 'ASSUMPTION', source: A },
    ],
    facts: [
      // What buyers pay — the decisive unverified rates.
      f('price_per_unit', 9, 18, 'ASSUMPTION', A, 'what a local merchant pays per scheduled B2B stop; the published all-in carrier cost per stop is about $10.10, so a price below it is not a business', 'local_merchants'),
      f('price_per_unit', 2.5, 4.5, 'ESTIMATE', S.contractor, 'what a regional carrier pays a cargo-van operator per stop (postings pay 1099 drivers $2.00–$4.10)', 'regional_carriers', 'US postings'),
      // Amazon's DSP route rate is not public: deliberately absent (UNKNOWN).
      f('placement_fee', 300, 1_000, 'ASSUMPTION', A, 'what a fleet owner would pay per driver who stays 30 days', 'dsp_operators'),
      // Throughput.
      f('units_per_capacity_day', 20, 40, 'ASSUMPTION', A, 'scheduled B2B stops one van completes in a day for one merchant', 'local_merchants'),
      f('pooled_units_per_capacity_day', 35, 60, 'ASSUMPTION', A, 'B2B stops per van-day when several merchants share one van in a zone', 'local_merchants'),
      f('units_per_capacity_day', 50, 150, 'ESTIMATE', S.ontrac, 'parcel stops per route-day on carrier routes (50–60 NYC; 60–150 reported elsewhere)', 'regional_carriers', 'US postings'),
      f('units_per_capacity_day', 150, 250, 'ASSUMPTION', A, 'Amazon route stops per van-day', 'amazon_dsp'),
      // Supply.
      f('contractor_rate_per_unit', 6, 11, 'ASSUMPTION', A, 'what an owner-operator accepts per B2B stop at merchant density (a $200–$350 day over 20–40 stops)', 'local_merchants'),
      f('contractor_rate_per_unit', 2, 4.1, 'ESTIMATE', S.contractor, 'per-stop pay to 1099 cargo-van operators on carrier routes', 'regional_carriers', 'US postings'),
      f('contractor_day_rate', 220, 350, 'ASSUMPTION', A, 'what an owner-operator with a cargo van accepts for a dedicated day'),
      f('labor_cost_per_day', 200, 340, 'ESTIMATE', S.wagedex, 'a W-2 driver-day: $18–$28/h over 10 hours, plus about 15% payroll burden', null, 'Metro Detroit'),
      f('asset_lease_per_day', 40, 128, 'ESTIMATE', S.vanRental, 'a cargo van per working day: long lease (assumed $40–$70) up to retail weekly rental ($799–$899/week)', null, 'Metro Detroit'),
      f('asset_lease_deposit', 500, 2_500, 'ASSUMPTION', A, 'deposit per leased van'),
      f('asset_purchase_cost', 28_000, 55_000, 'ASSUMPTION', A, 'a used to new cargo van'),
      f('asset_ownership_cost_per_day', 15, 35, 'ASSUMPTION', A, 'maintenance and tyres per owned van-day'),
      f('variable_cost_per_day', 25, 45, 'ASSUMPTION', A, 'fuel for 100–150 miles a day at about 15 mpg'),
      f('insurance_per_capacity_year', 1_200, 7_500, 'ESTIMATE', S.logrock, 'commercial auto per cargo van per year (Insurify $1,200–$6,800; LogRock $1,200–$7,500+)', null, 'US'),
      f('broker_take_rate', 0.1, 0.2, 'ASSUMPTION', A, 'share of the stop price a courier broker keeps'),
      f('placements_per_month', 3, 12, 'ASSUMPTION', A, 'drivers one online recruiting operation places a month'),
      f('recruiting_cost_per_placement', 60, 250, 'ASSUMPTION', A, 'job ads and background checks per placed driver'),
      // Cash cycle.
      f('buyer_payment_days', 7, 30, 'ASSUMPTION', A, 'days for a merchant to pay a weekly invoice', 'local_merchants'),
      f('buyer_payment_days', 14, 45, 'ASSUMPTION', A, 'days for a carrier to pay a route invoice', 'regional_carriers'),
      f('buyer_payment_days', 30, 60, 'ASSUMPTION', A, 'days for a fleet owner to pay a placement invoice', 'dsp_operators'),
      f('buyer_payment_days', 7, 30, 'ASSUMPTION', A, 'days for Amazon to settle partner route invoices (not public)', 'amazon_dsp'),
      f('supplier_payment_days', 7, 14, 'ESTIMATE', S.contractor, 'owner-operators expect weekly or bi-weekly settlement'),
      // Selling.
      f('account_units_per_month', 400, 900, 'ASSUMPTION', A, 'stops one merchant account buys a month (about one van-day each weekday)', 'local_merchants'),
      f('account_units_per_month', 1_500, 3_000, 'ASSUMPTION', A, 'stops on one dedicated carrier route a month', 'regional_carriers'),
      f('account_units_per_month', 3_000, 5_000, 'ASSUMPTION', A, 'stops on one Amazon route a month', 'amazon_dsp'),
      f('account_win_rate', 0.03, 0.12, 'ASSUMPTION', A, 'merchants pitched who sign a trial run', 'local_merchants'),
      f('account_win_rate', 0.05, 0.25, 'ASSUMPTION', A, 'carrier stations pitched who give a route', 'regional_carriers'),
      f('account_win_rate', 0.1, 0.3, 'ASSUMPTION', A, 'fleet owners pitched who take a recruiting trial', 'dsp_operators'),
      f('account_win_rate', 0.05, 0.3, 'ASSUMPTION', A, 'applicants selected into the DSP program', 'amazon_dsp'),
      f('outreach_cost_per_account', 10, 60, 'ASSUMPTION', A, 'tools and lists per account pitched'),
      f('sales_cycle_days', 7, 30, 'ASSUMPTION', A, 'first pitch to first paid run', 'local_merchants'),
      f('sales_cycle_days', 21, 60, 'ASSUMPTION', A, 'first contact to first route', 'regional_carriers'),
      f('sales_cycle_days', 10, 30, 'ASSUMPTION', A, 'first contact to first placement', 'dsp_operators'),
      f('sales_cycle_days', 60, 180, 'ASSUMPTION', A, 'application to first routes', 'amazon_dsp'),
      f('accounts_reachable', 500, 5_000, 'ASSUMPTION', A, 'Metro Detroit businesses that ship locally', 'local_merchants'),
      f('accounts_reachable', 20, 80, 'ASSUMPTION', A, 'DSP and contractor-fleet owners in Metro Detroit', 'dsp_operators'),
      f('supply_available', 50, 500, 'ASSUMPTION', A, 'independent cargo-van operators reachable in Metro Detroit'),
      // Overheads.
      f('overhead_per_month', 300, 1_000, 'ASSUMPTION', A, 'phone, software, accounting and bank fees'),
      f('manager_cost_per_month', 4_500, 6_500, 'ASSUMPTION', A, 'a hired operations manager, so the owner does no physical work'),
      f('platform_cost_per_month', 200, 1_500, 'ASSUMPTION', A, 'routing and dispatch software'),
      f('hiring_days', 14, 30, 'ASSUMPTION', A, 'days to hire and onboard drivers'),
    ],
  };
}

export interface ReferencePack {
  id: string;
  tags: RegExp;
  build: () => IndustryEvidence;
}

export const REFERENCE_PACKS: ReferencePack[] = [
  { id: 'last-mile-delivery', tags: /\b(last[- ]mile|final[- ]mile|courier|parcel|local delivery|delivery (?:business|company|service)|logistics)\b/i, build: lastMileDelivery },
];

/** The pack the operator's words name, if any. */
export function referenceFor(text: string): ReferencePack | null {
  return REFERENCE_PACKS.find((p) => p.tags.test(text)) ?? null;
}
