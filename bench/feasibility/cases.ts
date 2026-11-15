/**
 * The public feasibility cases. Each states its input, the real judgement it is
 * put through, and the CORRECT verdict — written from the invariants and the
 * production defects they cite, never from what the code happens to answer
 * today. A case the code fails is a finding (BASELINE.md), not a case to edit.
 *
 * The goal is the $10K goal's shape: $10,000 to raise, 24 days left, $3,000 in
 * all, $375 one arrangement may tie up before proof.
 */
import type { OpeningSpec } from '../spec.ts';
import type { FeasibilityCase } from './case.ts';

/** A found opening every link of which is established: a buyer who asked, a channel, an offer Brain writes, a price, timely cash. */
const REPORT: OpeningSpec = {
  id: 'cop_report',
  title: 'Quarterly market report for Lakeside Credit Union',
  payer: 'Lakeside Credit Union',
  reachableChannel: 'procurement email published on its website',
  buyingSignal: 'posted a request for a quarterly market report',
  signalObservedAt: '2026-11-10T00:00:00Z',
  offerScope: 'one written quarterly market report',
  price: 2500,
  directCost: 50,
  capital: 0,
  daysToCash: 7,
  close: [0.1, 0.4],
  respond: [0.2, 0.6],
};
const found = (over: Partial<OpeningSpec>): OpeningSpec => ({ ...REPORT, ...over });

/** A modest repeatable line, so a combination exists beside the subject. */
const LISTS: OpeningSpec = {
  id: 'cop_lists',
  title: 'Weekly permit lead lists for regional roofing contractors',
  payer: 'Regional roofing contractors',
  reachableChannel: 'published business email',
  buyingSignal: 'contractors buy permit lead lists weekly',
  offerScope: 'a weekly permit lead list (spreadsheet)',
  repeatable: true,
  price: { assumed: 199 },
  directCost: 0,
  capital: 0,
  daysToCash: [3, 10],
  volume: [20, 200],
};

/** The production arrangement of 2026-11-15: priced by reconstruction (p50 ≈ $2.77M), an $881,310 direct cost, one deal. */
const BUREAUS: OpeningSpec = {
  id: 'arr_bureaus',
  title: 'Constructed: state technical utility services bureaus',
  constructed: true,
  price: { inferred: [1_200_000, 2_765_302, 4_500_000] },
  directCost: { assumed: 881_310 },
  capital: [0, 881_310],
  daysToCash: [3, 60],
  volume: { assumed: 1 },
};

/** The reconstruction tests' held openings (tests/prepaidFulfilmentEvidence.test.ts shape). */
const HELD: OpeningSpec[] = [
  { id: 'held_lists', title: 'held_lists', repeatable: true, price: 300, capital: 0, hours: 1, daysToCash: 6, close: [0.05, 0.25], respond: [0.005, 0.03], directCost: 0, volume: 200 },
  { id: 'held_audits', title: 'held_audits', repeatable: true, price: 900, capital: 0, hours: 1, daysToCash: 6, close: [0.03, 0.15], respond: [0.005, 0.03], directCost: 0, volume: 60 },
];

/** A supply deal: a wholesaler's goods resold, so a real direct cost has to be paid to the supplier. */
const SUPPLY: OpeningSpec = {
  id: 'cop_supply',
  title: 'Office furniture supply for Northgate Clinic',
  payer: 'Northgate Clinic',
  reachableChannel: 'facilities manager email',
  buyingSignal: 'asked for quotes on office furniture',
  offerScope: 'supply and deliver office furniture',
  fulfillmentOwner: 'Metro Office Supply (wholesaler)',
  price: { assumed: 6000 },
  directCost: 4200,
  capital: [0, 4200],
  daysToCash: [5, 20],
};

/** A repeatable drop-ship line the reconstruction keeps movable (one-offs outside every combination are not moved). */
const GIFTS: OpeningSpec = {
  id: 'cop_gifts',
  title: 'Corporate year-end gifts, supplier drop-ships',
  repeatable: true,
  price: [690, 3450],
  directCost: [550, 3000],
  capital: [0, 300],
  daysToCash: [5, 15],
  close: [0.05, 0.25],
  respond: [0.005, 0.03],
  volume: [20, 400],
};

/** An installation nobody named can do. */
const HVAC: OpeningSpec = {
  id: 'cop_hvac',
  title: 'Commercial HVAC installation for Riverside Mall',
  payer: 'Riverside Mall management',
  reachableChannel: 'facilities email',
  buyingSignal: 'asked for quotes to install rooftop HVAC units',
  offerScope: 'install four rooftop HVAC units',
  fulfillmentOwner: null,
  price: { assumed: 9000 },
  directCost: [0, 2000],
  capital: [0, 375],
  daysToCash: 14,
  close: [0.1, 0.4],
  respond: [0.2, 0.6],
};

const RFP: OpeningSpec = {
  id: 'cop_rfp',
  title: 'RFP: county records digitisation services',
  source: 'sam.gov',
  payer: 'Clark County Records Office',
  reachableChannel: 'the solicitation portal',
  buyingSignal: 'published a solicitation for records digitisation',
  offerScope: 'digitise 40,000 county records',
  fulfillmentOwner: 'ScanWorks LLC (subcontractor quote)',
  competitiveAward: true,
  price: { assumed: 15_000 },
  directCost: { assumed: 6000 },
  capital: [0, 375],
  daysToCash: [3, 60],
};

const POOL: OpeningSpec = {
  id: 'arr_pool',
  title: 'Constructed: pool several buyers’ purchases with one supplier',
  constructed: true,
  repeatable: true,
  price: { inferred: [300, 1170, 3000] },
  directCost: [0, 300],
  volume: [1, 200],
};

export const PUBLIC_CASES: FeasibilityCase[] = [
  /* ---------------- UNFUNDED_DEAL ---------------- */
  {
    id: 'unfunded-01-bureaus-lead', class: 'UNFUNDED_DEAL',
    description: 'R-PORTFOLIO-COST: an $881,310 direct cost on a reconstructed price against a $3,000 ceiling may not lead the portfolio.',
    subject: BUREAUS, others: [LISTS], judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'unfunded-02-unknown-cost-centre', class: 'UNFUNDED_DEAL',
    description: 'A $0–$60,000 cost nobody established centres at $30,000: ten times the money behind the plan, on an assumed price. Not a leader.',
    subject: found({ id: 'cop_kitchen', title: 'Turnkey commercial kitchen fit-out for Harbor Bistro Group', payer: 'Harbor Bistro Group', offerScope: 'design and fit-out of one commercial kitchen', fulfillmentOwner: 'Coastal Fitouts LLC (subcontractor quoted)', price: { assumed: 40_000 }, directCost: [0, 60_000], capital: [0, 375], daysToCash: 10 }),
    others: [LISTS], judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'unfunded-03-proven-price-unfunded-cost', class: 'UNFUNDED_DEAL',
    description: 'A proven $45,000 price does not fund a $38,000 supplier cost on a $3,000 ceiling: with no terms showing the buyer pays first, the owner would have to front it.',
    subject: found({ id: 'cop_forklifts', title: 'Twelve refurbished forklifts for Midstate Logistics', payer: 'Midstate Logistics', buyingSignal: 'posted a request for quotes on 12 refurbished forklifts', offerScope: 'twelve refurbished forklifts delivered', fulfillmentOwner: 'Allied Equipment Resale (supplier quote on file)', price: 45_000, directCost: 38_000, capital: [0, 38_000], daysToCash: 10, paymentTerms: null }),
    others: [LISTS], judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'unfunded-04-control-prepaid-supply', class: 'UNFUNDED_DEAL',
    description: 'Negative control: the same deal with the buyer paying in full at order and nothing tied up is funded by the buyer and may lead.',
    subject: found({ id: 'cop_forklifts', title: 'Twelve refurbished forklifts for Midstate Logistics', payer: 'Midstate Logistics', buyingSignal: 'posted a request for quotes on 12 refurbished forklifts', offerScope: 'twelve refurbished forklifts delivered', fulfillmentOwner: 'Allied Equipment Resale (supplier quote on file)', price: 45_000, directCost: 38_000, capital: 0, daysToCash: 10, paymentTerms: 'paid in full up front at order, before the supplier is paid' }),
    others: [LISTS], judgement: { kind: 'portfolio.leading' }, expect: 'ACCEPT',
  },
  {
    id: 'unfunded-05-price-answer-cannot-fund', class: 'UNFUNDED_DEAL',
    description: 'Research on the price of an unfunded deal cannot bring it into the plan: only its cost can.',
    subject: BUREAUS, others: [LISTS], judgement: { kind: 'information.changesPlan', variable: 'price' }, expect: 'REFUSE',
  },
  {
    id: 'unfunded-06-control-cost-answer-can-fund', class: 'UNFUNDED_DEAL',
    description: 'Negative control: an unknown $0–$8,000 cost leaves the deal unfunded at its centre, but an answer at the low end would fund it, so its cost is worth asking.',
    subject: found({ id: 'cop_move', title: 'Office move for Granite Law Partners', payer: 'Granite Law Partners', offerScope: 'move one 20-desk office over a weekend', buyingSignal: 'asked for quotes on an office move', fulfillmentOwner: 'Swift Movers (subcontractor)', price: { assumed: 6000 }, directCost: [0, 8000], capital: [0, 375], daysToCash: 10 }),
    judgement: { kind: 'information.changesPlan', variable: 'directCost' }, expect: 'ACCEPT',
  },
  {
    id: 'unfunded-07-engine-own-capital', class: 'UNFUNDED_DEAL',
    description: 'The engine refuses an opening whose own evidence ties up $5,000 at its start against $375 one arrangement may.',
    subject: found({ capital: 5000 }), judgement: { kind: 'engine.admitted' }, expect: 'REFUSE',
  },
  {
    id: 'unfunded-08-control-engine-small-capital', class: 'UNFUNDED_DEAL',
    description: 'Negative control: $200 tied up is inside the $375 limit and is admitted.',
    subject: found({ capital: 200 }), judgement: { kind: 'engine.admitted' }, expect: 'ACCEPT',
  },
  {
    id: 'unfunded-09-control-assumed-price-small-cost', class: 'UNFUNDED_DEAL',
    description: 'Negative control: an assumed price is not a reason to exclude a deal whose $300 cost the owner can fund.',
    subject: found({ id: 'cop_website', title: 'Website rebuild for Pinecrest Veterinary', payer: 'Pinecrest Veterinary', buyingSignal: 'posted a request for website quotes', offerScope: 'a five-page website rebuild', price: { assumed: 1500 }, directCost: 300 }),
    judgement: { kind: 'portfolio.leading' }, expect: 'ACCEPT',
  },
  {
    id: 'unfunded-10-combination-over-ceiling', class: 'UNFUNDED_DEAL',
    description: 'Two arrangements tying up $2,000 each cannot both be in a combination under a $3,000 ceiling; the weaker one is left out.',
    context: { beforeProof: 2500 },
    subject: found({ id: 'cop_weaker', title: 'Inventory audit for Hilltop Hardware', payer: 'Hilltop Hardware', offerScope: 'one inventory audit report', price: { assumed: 4000 }, directCost: 100, capital: 2000 }),
    others: [found({ id: 'cop_stronger', title: 'Market entry report for Bayview Foods', payer: 'Bayview Foods', offerScope: 'one market entry report', price: { assumed: 8000 }, directCost: 100, capital: 2000 })],
    judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },

  /* ---------------- PREPAYMENT_UNEVIDENCED ---------------- */
  {
    id: 'prepay-01-no-terms', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Terms nobody stated are a question for research, never a prepayment (invariant 39).',
    subject: SUPPLY, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-02-net-30', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Net 30 after acceptance is arrears.',
    subject: { ...SUPPLY, paymentTerms: 'Invoices are net 30 after acceptance' }, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-03-rfp-award', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'An award is paid after it is won and delivered.',
    subject: RFP, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-04-vague-terms', class: 'PREPAYMENT_UNEVIDENCED',
    description: '"Pay promptly" states no payment before delivery.',
    subject: { ...SUPPLY, paymentTerms: 'Clients usually pay promptly' }, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-05-negated-deposit', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Terms that say no deposit and invoice on delivery are arrears; the word "deposit" is not a deposit.',
    subject: { ...SUPPLY, paymentTerms: 'No deposit is required; the full amount is invoiced on delivery' }, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-06-negated-advance', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Terms that refuse payment in advance and state net 15 from delivery are arrears.',
    subject: { ...SUPPLY, paymentTerms: 'Payment in advance is not accepted; net 15 from delivery' }, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-07-inherited-arrears', class: 'PREPAYMENT_UNEVIDENCED',
    description: "A constructed arrangement inherits its buyers' evidenced arrears.",
    subject: { ...BUREAUS, paymentTerms: "paid in arrears, after delivery, as these buyers' evidence states" }, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-08-control-deposit', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Negative control: a 50% deposit at signing is money before delivery.',
    subject: { ...SUPPLY, paymentTerms: '50% deposit at signing, balance on delivery' }, judgement: { kind: 'prepayment' }, expect: 'ACCEPT',
  },
  {
    id: 'prepay-09-control-checkout', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Negative control: paid in full at checkout before the supplier ships.',
    subject: { ...SUPPLY, paymentTerms: 'Paid in full at checkout before the supplier ships' }, judgement: { kind: 'prepayment' }, expect: 'ACCEPT',
  },
  {
    id: 'prepay-10-lever-not-tried', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'The reconstruction does not try prepaid fulfilment on a buyer whose terms nobody stated.',
    subject: GIFTS, others: HELD, judgement: { kind: 'reconstruction.prepaidLever' }, expect: 'REFUSE',
  },
  {
    id: 'prepay-11-control-lever-tried', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Negative control: with prepayment stated, the lever is tried.',
    subject: { ...GIFTS, paymentTerms: 'paid in full at checkout before the supplier ships' }, others: HELD, judgement: { kind: 'reconstruction.prepaidLever' }, expect: 'ACCEPT',
  },
  {
    id: 'prepay-12-control-on-booking', class: 'PREPAYMENT_UNEVIDENCED',
    description: 'Negative control: the buyer pays on booking, before the work.',
    subject: { ...SUPPLY, paymentTerms: 'The buyer pays on booking' }, judgement: { kind: 'prepayment' }, expect: 'ACCEPT',
  },

  /* ---------------- CAPABILITY_NOT_HELD ---------------- */
  {
    id: 'capability-01-nobody-installs', class: 'CAPABILITY_NOT_HELD',
    description: 'An installation nobody is named to do, and Brain cannot do, is not executable.',
    subject: HVAC, judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'capability-02-buyer-as-fulfiller', class: 'CAPABILITY_NOT_HELD',
    description: 'A card naming the buyer itself as who does the work names nobody.',
    subject: found({ id: 'cop_dental', title: 'Patient newsletter for Brightwater Dental Group', payer: 'Brightwater Dental Group', offerScope: 'a monthly patient newsletter', fulfillmentOwner: 'Brightwater Dental Group staff' }),
    context: { capabilities: null }, judgement: { kind: 'pathway.gap', gap: 'NO_SUPPLIER' }, expect: 'REFUSE',
  },
  {
    id: 'capability-03-variant-puzzle', class: 'CAPABILITY_NOT_HELD',
    description: "Brain's generator makes classic sudoku; a variant-sudoku order is not something it holds.",
    subject: { id: 'cop_sudoku', title: 'Artisanal Sudoku pays $50 per variant-sudoku puzzle submission', payer: 'Artisanal Sudoku, editor', reachableChannel: 'email with a link to the puzzle', buyingSignal: 'its submission page says contributors are paid $50', offerScope: 'one original variant-sudoku puzzle', price: { assumed: 50 }, directCost: [0, 10], capital: 0, daysToCash: [1, 30] },
    judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'capability-04-transcription', class: 'CAPABILITY_NOT_HELD',
    description: 'Transcribing audio is not a capability Brain has proved, even when the deliverable mentions reports.',
    subject: found({ id: 'cop_transcribe', title: 'Interview transcription and summary reports for Elm Street Research', payer: 'Elm Street Research', offerScope: 'transcribe 40 hours of audio interviews and write summary reports', buyingSignal: 'posted a request for interview transcription' }),
    judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'capability-05-capacity-unnamed', class: 'CAPABILITY_NOT_HELD',
    description: 'With nobody to fulfil it, no delivery capacity is established.',
    subject: HVAC, judgement: { kind: 'pathway.established', fact: 'capacity' }, expect: 'REFUSE',
  },
  {
    id: 'capability-06-capacity-named-unmeasured', class: 'CAPABILITY_NOT_HELD',
    description: 'Naming a fulfiller does not measure the volume it can deliver.',
    subject: found({ id: 'cop_cleaning', title: 'Office cleaning contract for Westfield Accounting', payer: 'Westfield Accounting', offerScope: 'weekly office cleaning for one month', price: 1800, directCost: 1100, fulfilledBy: { value: 'Northside Cleaning LLC (signed subcontract)' } }),
    judgement: { kind: 'pathway.established', fact: 'capacity' }, expect: 'REFUSE',
  },
  {
    id: 'capability-07-unfulfillable-leads', class: 'CAPABILITY_NOT_HELD',
    description: 'A sale nobody can fulfil may not lead the portfolio: its contribution rests on a capability nobody holds.',
    subject: HVAC, judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'capability-08-control-brain-writes', class: 'CAPABILITY_NOT_HELD',
    description: 'Negative control: blog posts are a business document Brain produces; with every link established the pathway is executable.',
    subject: found({ id: 'cop_blog', title: 'Four blog posts a month for Tallgrass Software', payer: 'Tallgrass Software', buyingSignal: 'posted a request for a freelance blog writer', offerScope: 'four 1,200-word blog posts', price: 1200, directCost: 20, daysToCash: 10 }),
    judgement: { kind: 'pathway.executable' }, expect: 'ACCEPT',
  },
  {
    id: 'capability-09-control-named-subcontractor', class: 'CAPABILITY_NOT_HELD',
    description: 'Negative control: a subcontractor named on evidence fulfils as well as Brain does.',
    subject: found({ id: 'cop_cleaning', title: 'Office cleaning contract for Westfield Accounting', payer: 'Westfield Accounting', offerScope: 'weekly office cleaning for one month', price: 1800, directCost: 1100, daysToCash: 10, fulfilledBy: { value: 'Northside Cleaning LLC (signed subcontract)' } }),
    judgement: { kind: 'pathway.executable' }, expect: 'ACCEPT',
  },
  {
    id: 'capability-10-brain-named-for-electrical', class: 'CAPABILITY_NOT_HELD',
    description: 'A card that writes "Brain" as the fulfiller of licensed electrical work names a capability Brain does not hold.',
    subject: found({ id: 'cop_electrical', title: 'EV charger installation for Oakridge Apartments', payer: 'Oakridge Apartments', offerScope: 'install six EV chargers in the car park', buyingSignal: 'asked for quotes on EV charger installation', fulfillmentOwner: 'Brain', requiredCapabilities: ['LICENSED_ELECTRICIAN'], price: { assumed: 7000 }, directCost: [0, 2000] }),
    judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'capability-11-not-in-frame', class: 'CAPABILITY_NOT_HELD',
    description: 'Graphic design is not in this capability frame, so Brain is not its fulfiller.',
    context: { capabilities: { delivers: ['business document'], puzzleFormats: [] } },
    subject: found({ id: 'cop_logo', title: 'Logo design for Sunrise Bakery', payer: 'Sunrise Bakery', offerScope: 'a new logo and two banner graphics', buyingSignal: 'posted a request for a logo designer', price: 1500, directCost: 0 }),
    judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },

  /* ---------------- UNKNOWN_AS_FAVOURABLE ---------------- */
  {
    id: 'unknown-01-net-no-value', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'OPP-04: an unknown price states no net value, whatever the swept midpoint.',
    subject: { id: 'cop_c385', title: 'Equipment for a regional contractor', payer: 'Regional contractors', reachableChannel: 'published business email', buyingSignal: 'posted asking for it', offerScope: 'one delivery', fulfillmentOwner: 'A named supplier', price: [10, 100], directCost: 27_263, capital: 0, daysToCash: 9 },
    judgement: { kind: 'pathway.established', fact: 'net' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-02-cash-timing', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'Cash timing nobody established is a gap, not the fast end of the sweep.',
    subject: found({ daysToCash: [3, 60] }), judgement: { kind: 'pathway.gap', gap: 'SLOW_OR_UNKNOWN_CASH' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-03-conversion', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'A conversion nobody measured states no value.',
    subject: found({}), judgement: { kind: 'pathway.established', fact: 'conversion' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-04-small-ticket-volume', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'A $49 product with an unestablished buyer count is a volume question, not a thousand sales.',
    subject: found({ id: 'cop_planner', title: 'Printable meal-planner templates for a parenting newsletter', payer: 'Little Sprouts newsletter readers', offerScope: 'a printable meal-planner template pack', repeatable: true, price: 49, directCost: 0, volume: [1, 500] }),
    judgement: { kind: 'pathway.gap', gap: 'SMALL_TICKET_VOLUME_UNKNOWN' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-05-no-channel', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'A buyer with no known route to them is not executable.',
    subject: found({ reachableChannel: null }), judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-06-rank-unknown-timing', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'Otherwise identical, an opening whose cash timing is unknown ranks below one that settles in seven days.',
    subject: found({ daysToCash: [3, 60] }), others: [found({ id: 'cop_report2', title: 'Quarterly market report for Hillcrest Credit Union', payer: 'Hillcrest Credit Union' })],
    judgement: { kind: 'rank.collectibility', comparator: 'cop_report2' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-07-engine-capital-unestablished', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'Money tied up nobody established stays unestablished in the engine, not read at the low end.',
    subject: found({ capital: [0, 5000] }), judgement: { kind: 'engine.established', input: 'money tied up' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-08-engine-coverage', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'A plan resting on an unknown price is coverage, never a probability.',
    subject: found({ price: [500, 3000] }), judgement: { kind: 'engine.probability' }, expect: 'REFUSE',
  },
  {
    id: 'unknown-09-control-unestablished-not-refused', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'Negative control (production 2026-11-06): an unestablished outlay that could fit the limit is not refused outright — that was a size bias, not a limit.',
    subject: found({ capital: [0, 5000] }), judgement: { kind: 'engine.admitted' }, expect: 'ACCEPT',
  },
  {
    id: 'unknown-10-control-all-evidence', class: 'UNKNOWN_AS_FAVOURABLE',
    description: 'Negative control: when every input of the plan is evidence, its reach is a probability.',
    subject: found({ respond: 0.4, close: 0.3, hours: 2, volume: 1, capital: 0 }), judgement: { kind: 'engine.probability' }, expect: 'ACCEPT',
  },

  /* ---------------- CONSTRAINT_RELAXED ---------------- */
  {
    id: 'constraint-01-settles-after-deadline', class: 'CONSTRAINT_RELAXED',
    description: 'Cash in 45 days against 24 days left is not executable.',
    subject: found({ daysToCash: 45 }), judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-02-settles-on-the-edge', class: 'CONSTRAINT_RELAXED',
    description: 'Cash in 23 days leaves no room for the two-day sales cycle before a 24-day deadline.',
    subject: found({ daysToCash: 23 }), judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-03-late-leads', class: 'CONSTRAINT_RELAXED',
    description: 'A $9,000 sale that settles in 60 days contributes nothing inside the window and may not lead.',
    subject: found({ price: { assumed: 9000 }, daysToCash: 60 }), judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-04-over-capital-gap', class: 'CONSTRAINT_RELAXED',
    description: 'An established $1,200 outlay breaks the $375 per-arrangement limit.',
    subject: found({ capital: 1200 }), judgement: { kind: 'pathway.gap', gap: 'OVER_CAPITAL' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-05-closed-leads', class: 'CONSTRAINT_RELAXED',
    description: 'An opening that closed on 1 November may not lead.',
    subject: found({ expiresAt: '2026-11-01T00:00:00Z' }), judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-06-engine-late-cash', class: 'CONSTRAINT_RELAXED',
    description: 'The engine settles no cash inside the window for an opening paid in 40 days.',
    subject: found({ daysToCash: 40 }), judgement: { kind: 'engine.cash' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-07-control-timely', class: 'CONSTRAINT_RELAXED',
    description: 'Negative control: cash in 10 days is inside the window and the pathway is executable.',
    subject: found({ daysToCash: 10 }), judgement: { kind: 'pathway.executable' }, expect: 'ACCEPT',
  },
  {
    id: 'constraint-08-control-inferred-capital', class: 'CONSTRAINT_RELAXED',
    description: 'Negative control (F6): capital inferred from other openings is not this opening\'s outlay and does not refuse it.',
    subject: found({ capital: { inferred: [500, 14_985, 30_000] } }), judgement: { kind: 'engine.admitted' }, expect: 'ACCEPT',
  },
  {
    id: 'constraint-09-direct-inferred-capital', class: 'CONSTRAINT_RELAXED',
    description: 'Capital inferred on direct, justified evidence about this opening ($5,000) is its own outlay, over the $375 limit.',
    subject: found({ capital: { inferred: [4000, 5000, 6000], justified: true, tier: 'DIRECT' } }), judgement: { kind: 'engine.admitted' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-10-over-capital-leads', class: 'CONSTRAINT_RELAXED',
    description: 'An arrangement that ties up $1,200 against the $375 one arrangement may is not in the leading combination merely because the $3,000 total has room.',
    subject: found({ capital: 1200 }), judgement: { kind: 'portfolio.leading' }, expect: 'REFUSE',
  },
  {
    id: 'constraint-11-control-leads', class: 'CONSTRAINT_RELAXED',
    description: 'Negative control: a fully established, timely, funded opening leads.',
    subject: found({}), judgement: { kind: 'portfolio.leading' }, expect: 'ACCEPT',
  },
  {
    id: 'constraint-12-control-permission', class: 'CONSTRAINT_RELAXED',
    description: 'Negative control: a missing send permission blocks only the send; the pathway itself stays executable.',
    context: { permissionsMissing: ['CONTACT_BUYER'] }, subject: found({}), judgement: { kind: 'pathway.executable' }, expect: 'ACCEPT',
  },
  {
    id: 'constraint-13-control-engine-timely-cash', class: 'CONSTRAINT_RELAXED',
    description: 'Negative control: an opening paid in 10 days settles cash inside the window.',
    subject: found({ daysToCash: 10 }), judgement: { kind: 'engine.cash' }, expect: 'ACCEPT',
  },

  /* ---------------- AWARD_AS_REPEATABLE ---------------- */
  {
    id: 'award-01-one-off', class: 'AWARD_AS_REPEATABLE',
    description: 'A solicitation pays once.',
    subject: RFP, judgement: { kind: 'pathway.repeats' }, expect: 'REFUSE',
  },
  {
    id: 'award-02-estimated-repeat', class: 'AWARD_AS_REPEATABLE',
    description: 'An estimate that "similar counties issue similar RFPs" does not make one award a repeating sale: each is a separate competition.',
    subject: { ...RFP, repeatable: true, volume: [1, 5] }, judgement: { kind: 'pathway.repeats' }, expect: 'REFUSE',
  },
  {
    id: 'award-03-engine-repeat', class: 'AWARD_AS_REPEATABLE',
    description: 'The engine counts at most the one award it might win.',
    subject: { ...RFP, repeatable: true, volume: [1, 5] }, judgement: { kind: 'engine.repeats' }, expect: 'REFUSE',
  },
  {
    id: 'award-04-reach-unknown-timing', class: 'AWARD_AS_REPEATABLE',
    description: 'An award nobody has shown pays inside the window is credited no reach.',
    subject: RFP, judgement: { kind: 'scenario.bestCaseReach' }, expect: 'REFUSE',
  },
  {
    id: 'award-05-control-reach-evidenced-timing', class: 'AWARD_AS_REPEATABLE',
    description: 'Negative control: an award whose evidence shows payment in 10 days is credited its one deal.',
    subject: { ...RFP, daysToCash: 10 }, judgement: { kind: 'scenario.bestCaseReach' }, expect: 'ACCEPT',
  },
  {
    id: 'award-06-grant-prepayment', class: 'AWARD_AS_REPEATABLE',
    description: 'A grant is paid on its terms after award, never prepaid.',
    subject: { ...SUPPLY, id: 'cop_grant', title: 'Notice of funding opportunity: rural broadband planning grant', competitiveAward: true }, judgement: { kind: 'prepayment' }, expect: 'REFUSE',
  },

  /* ---------------- ESTIMATE_AS_EXECUTABLE ---------------- */
  {
    id: 'estimate-01-constructed-pathway', class: 'ESTIMATE_AS_EXECUTABLE',
    description: 'A constructed design has found no buyer yet: not executable.',
    subject: POOL, judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'estimate-02-constructed-with-fulfiller', class: 'ESTIMATE_AS_EXECUTABLE',
    description: 'Naming a supplier and a channel does not turn a constructed estimate into a found buyer.',
    subject: { ...POOL, payer: 'Independent cafés in Portland', reachableChannel: 'partner email list', offerScope: 'pooled coffee-bean purchasing', fulfilledBy: { value: 'Roastery Co-op (wholesale terms)' } },
    judgement: { kind: 'pathway.executable' }, expect: 'REFUSE',
  },
  {
    id: 'estimate-03-portfolio-executable', class: 'ESTIMATE_AS_EXECUTABLE',
    description: 'The living portfolio does not list a constructed estimate as executable.',
    subject: POOL, judgement: { kind: 'portfolio.executable' }, expect: 'REFUSE',
  },
  {
    id: 'estimate-04-engine-coverage', class: 'ESTIMATE_AS_EXECUTABLE',
    description: 'A plan containing a constructed estimate is coverage, not a probability.',
    subject: POOL, judgement: { kind: 'engine.probability' }, expect: 'REFUSE',
  },
  {
    id: 'estimate-05-reconstruction-best', class: 'ESTIMATE_AS_EXECUTABLE',
    description: 'The reconstruction never concludes on the $2.77M constructed bureaus deal (SCALE critic).',
    subject: BUREAUS, others: HELD, judgement: { kind: 'reconstruction.best' }, expect: 'REFUSE',
  },
];
