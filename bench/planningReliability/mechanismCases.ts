/**
 * Mechanism-validity cases (audit 2026-11-23, docs/audits/2026-11-23-10k-plan-audit.md):
 * the failure classes a real production plan committed while it carried a "98% coverage"
 * headline, each reproduced in the suite's own format, with the controls that must be
 * judged the other way.
 *
 *   mv-01  the audit's own plan: GitHub's $10,000 critical bug-bounty REWARD, paid to
 *          researchers, read as what GitHub pays for Brain's deliverable; one named
 *          company swept as a buyer population; no channel and no fulfiller.
 *   mv-02  a bounty payout read as a price, isolated: every other link is evidenced.
 *   mv-03  one named organisation's one purchase order modelled as repeat deals.
 *   mv-04  the control: a marketplace whose many buyers do repeat — executable.
 *   mv-05  a price spliced from an unrelated claim (another buyer, another product).
 *
 * Each rubric is written from the evidence the case files, never from what the planner
 * answers today; BASELINE.md records which fail on production code and why.
 * The unfamiliar-mechanism pairs (commission, affiliate, contract award, grant, prize,
 * rebate, settlement) are hidden cases: they are not in the repository.
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

/** The audit's leg 1: the reward GitHub pays security researchers, filed as GitHub's price for a spreadsheet. */
const GITHUB: OpeningFixture = {
  key: 'github', title: 'Security programming deliverable for GitHub', mechanism: 'DIAGNOSTIC_OPPORTUNITY', industry: 'software security',
  payer: 'GitHub, Inc.', channel: null, price: 10_000,
  priceEvidence: "GitHub's public bug bounty program pays security researchers $10,000 for a critical vulnerability finding (Tech Times, 2026-07-27).",
  cost: 355, capital: 0, daysToCash: null, hours: 1, performer: 'BRAIN',
};

/** The audit's domain legs: a broker's service fee, no channel, nobody to do it. */
const DOMAIN_FEE: OpeningFixture = {
  key: 'domainFee', title: 'Domain purchase assistance for domain buyers or sellers', mechanism: 'INFORMATION_ASYMMETRY', industry: 'domain brokerage',
  payer: 'Domain buyers or sellers', channel: null, price: 75, priceEvidence: 'Flat-fee domain brokers charge a service fee, often $75 per transaction.',
  cost: 3.88, capital: 0, daysToCash: null, hours: 1, performer: 'NOBODY',
};

/** The audit's template legs: a $9 template, no channel. */
const TEMPLATES: OpeningFixture = {
  key: 'templates', title: 'Spreadsheet templates for small business operators', mechanism: 'PRODUCTIZED_SERVICE', industry: 'small business templates',
  payer: 'Small business operators', channel: null, price: 9, priceEvidence: 'Spreadsheet templates for small businesses sell for $9 on template marketplaces.',
  cost: 0.47, capital: 0, daysToCash: null, hours: 0.1, performer: 'BRAIN',
};

/** A bounty paid TO researchers by projects, filed as what maintainers pay Brain; every other link evidenced. */
const OSS_BOUNTY: OpeningFixture = {
  key: 'ossAudit', title: 'Dependency vulnerability audit workbook for open-source maintainers', mechanism: 'DIAGNOSTIC_OPPORTUNITY', industry: 'open-source software maintenance',
  payer: 'Open-source project maintainers', price: 500,
  priceEvidence: 'The huntr bounty platform pays security researchers $500 for each valid vulnerability report in an open-source project.',
  cost: 5, capital: 0, daysToCash: 5, hours: 1, performer: 'BRAIN',
  volume: '1,500 open-source projects are listed on the bounty registry; each publishes a security contact.', conversion: { paid: 30, of: 300 },
};

/** One named health system's one purchase order: a real price, one payer, nothing says it buys again. */
const MERIDIAN: OpeningFixture = {
  key: 'meridian', title: 'Vendor-credentialing audit workbook for Meridian Regional Health System', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'hospital vendor credentialing',
  payer: 'Meridian Regional Health System', channel: "Meridian's procurement office (published email)", price: 4800,
  priceEvidence: "Meridian Regional Health System's procurement office issued a $4,800 purchase order for a vendor-credentialing audit (award notice, 2026-10-02).",
  cost: 40, capital: 0, daysToCash: 30, hours: 2, performer: 'BRAIN',
};

/** A marketplace listing with many buyers who do buy, counted by the marketplace itself. */
const MARKETPLACE: OpeningFixture = {
  key: 'mealPlanner', title: 'Allergen-labelled weekly meal-plan workbook sold on a digital-download marketplace', mechanism: 'PRODUCTIZED_SERVICE', industry: 'home meal planning',
  payer: 'Marketplace shoppers planning allergen-free meals', channel: 'The marketplace listing and its search', price: 29,
  priceEvidence: 'Comparable allergen meal-plan workbooks sell for $29 on the marketplace (listing prices, 2026-11).',
  cost: 3, capital: 0, daysToCash: 3, hours: 0.1, performer: 'BRAIN',
  volume: 'The marketplace shows 2,300 sales of comparable meal-plan workbooks in the last 12 months across 40 sellers; buyers return each season.',
  conversion: { paid: 60, of: 1500 },
};

/** A price that describes another buyer and another product (the audit's spliced offer text). */
const FLEET: OpeningFixture = {
  key: 'fleet', title: 'Preventive-maintenance scheduling workbook for regional trucking fleets', mechanism: 'PRODUCTIZED_SERVICE', industry: 'regional trucking',
  payer: 'Regional trucking fleet managers', price: 1200,
  priceEvidence: 'Software Advice analyzed data from HVAC contractors: field-service management software for HVAC businesses costs $1,200 a year per technician seat.',
  cost: 10, capital: 0, daysToCash: 7, hours: 1, performer: 'BRAIN',
  volume: '600 regional trucking fleets hold state motor-carrier permits; each schedules preventive maintenance monthly.', conversion: { paid: 24, of: 400 },
};

export const MECHANISM_CASES: PlanningCase[] = [
  {
    id: 'mv-01-github-bounty-audit', heldOut: true,
    description:
      'The audited production plan (gpr_7f5449d0d203428494f9): $10,000 in 16 days on at most $375 of capital. Its "price" is the reward GitHub pays security researchers for a critical finding — money paid the other way, for something else — and GitHub is one company, never 1–200 repeat buyers. Nothing evidences any buyer paying for the deliverable, so no plan; the decisive gap on the GitHub leg is the price.',
    dimensions: dims({ industry: 'software security', mechanism: 'DIAGNOSTIC_OPPORTUNITY', capital: 'small', target: 'medium', missingEvidence: 'OFFER_AND_PRICE', contradictoryEvidence: true }),
    objective: 'Collect $10,000 of settled cash within 16 days with at most $375 of capital.',
    openings: [GITHUB, DOMAIN_FEE, TEMPLATES],
    expect: {
      verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE'], opening: 'github' },
      notAPurchasePrice: ['github'], payerDealsMax: { github: 1 },
    },
  },
  {
    id: 'mv-02-bounty-payout-as-price', heldOut: true,
    description:
      'Every link is evidenced except the one that matters: the $500 is what a bounty platform pays researchers per finding, not what maintainers pay for an audit workbook. At $500, 6 deals would reach $3,000; at no evidenced price, no plan. The decisive gap is the price.',
    dimensions: dims({ industry: 'open-source software maintenance', mechanism: 'DIAGNOSTIC_OPPORTUNITY', missingEvidence: 'OFFER_AND_PRICE', contradictoryEvidence: true }),
    objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.',
    openings: [OSS_BOUNTY],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE'] }, notAPurchasePrice: ['ossAudit'] },
  },
  {
    id: 'mv-03-one-payer-swept-as-population', heldOut: true,
    description:
      'One named health system issued one $4,800 purchase order. Nothing says it buys again, so the most this opening is shown to bring is $4,800 against a $15,000 target; a model that sweeps it as 1–200 repeat buyers invents the rest. No plan; how many deals the market holds is the decisive gap.',
    dimensions: dims({ industry: 'hospital vendor credentialing', mechanism: 'EXPLICIT_PAID_REQUEST', target: 'medium', missingEvidence: 'MARKET_VOLUME' }),
    objective: 'Collect $15,000 of settled cash within 45 days using no up-front capital.',
    openings: [MERIDIAN],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['MARKET_VOLUME'] }, payerDealsMax: { meridian: 1 } },
  },
  {
    id: 'mv-04-marketplace-repeat-buyers', heldOut: true,
    description:
      'The control for mv-03: a marketplace counts 2,300 sales of comparable workbooks a year, and this listing converts a measured 4% of 1,500 visitors at $29 ($26 kept a sale). $1,000 needs about 39 sales in 30 days; many buyers do buy. Executable, with no owner time and nothing tied up.',
    dimensions: dims({ industry: 'home meal planning', mechanism: 'PRODUCTIZED_SERVICE' }),
    objective: 'Collect $1,000 of settled cash within 30 days using no up-front capital.',
    openings: [MARKETPLACE],
    expect: { verdict: 'EXECUTABLE_PLAN', capitalMax: 0 },
  },
  {
    id: 'mv-05-price-from-unrelated-claim', heldOut: true,
    description:
      'The $1,200 comes from a claim about HVAC contractors buying field-service software seats, spliced onto trucking fleets buying a maintenance workbook: it is not evidence of what this buyer pays for this offer. Every other link is evidenced; the decisive gap is the price.',
    dimensions: dims({ industry: 'regional trucking', mechanism: 'PRODUCTIZED_SERVICE', missingEvidence: 'OFFER_AND_PRICE', contradictoryEvidence: true }),
    objective: 'Collect $5,000 of settled cash within 30 days using no up-front capital.',
    openings: [FLEET],
    expect: { verdict: 'NO_PLAN', blocker: { kind: 'MISSING_EVIDENCE', links: ['OFFER_AND_PRICE'] }, notAPurchasePrice: ['fleet'] },
  },
];
