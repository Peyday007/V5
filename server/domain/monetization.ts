/**
 * The complete monetization possibility space, as a closed vocabulary.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * A discovery arrives, and Brain turns it into **one** thing: a
 * `cash_opportunities` row with one `mechanism` on it, taken from the signal
 * the claim declared. Production's thirty-one records are thirty-one single
 * answers to "how would money come out of this" — and the answer was chosen
 * once, at promotion, by a mapping table, before anybody had established a
 * payer, a price or a route.
 *
 * That is the collapse this file exists to stop. A published request for
 * transcription is a direct sale *and* a subcontracted fulfilment *and* a
 * productized service *and* a lead worth referring *and* a data point about
 * what that buyer pays, and which of those is best is a question about facts
 * nobody has yet. Picking one and discarding the rest destroys the alternatives
 * before the evidence that would have chosen between them exists.
 *
 * ---------------------------------------------------------------------------
 * Enumerated, never invented
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is to ask a model for forty ways to make money
 * from a discovery. That is §8's rule broken at the most expensive altitude:
 * forty plausible sentences, indistinguishable from forty researched ones, each
 * of which would then be ranked and put in front of somebody as work.
 *
 * So the space is **enumerated deterministically from this table**. A method is
 * a shape of transaction, declared here in code somebody reviews, carrying what
 * it structurally needs, what it structurally produces, which side of a
 * transaction it puts you on, and which kinds of evidence it is applicable to
 * at all. Applying that table to a subject's own recorded facts is arithmetic;
 * it reads no prose and forms no view. Whether any of the enumerated paths is
 * any *good* is then a question with an answer or an unknown, which is what the
 * rest of the ledger is for.
 *
 * A worker that reads a source may also declare a path the table could not
 * produce — §20's "are there paths I could not see before" — and that arrives
 * exactly as an `opportunity_signal` does: one declaration from this closed set,
 * validated on submission, refused whole if it is outside it, and carrying the
 * claim that established it.
 *
 * ---------------------------------------------------------------------------
 * The one number this file refuses
 * ---------------------------------------------------------------------------
 *
 * The brief asks every path to carry a *probability of success*. Brain does not
 * produce one, and `probabilityOfSuccess` below is the only attribute in the
 * table that `RECOMMENDATION` may not answer: it is a published base rate with
 * a source, or it is unknown. §29 and `card.ts` both already say why — a
 * 40% close rate nobody measured reads exactly like one somebody did, and the
 * ranking that consumed it would be arithmetic on a fiction. What replaces it
 * is `rank.ts`: a lexicographic order over counted rows, which is also the only
 * shape of ranking that can answer *why is #17 below #4* exactly.
 */
import {
  ENDOWMENTS,
  MONETIZATION_ATTRIBUTES,
  MONETIZATION_EDGE_KINDS,
  MONETIZATION_METHODS,
  MONETIZATION_STATUSES,
  PATH_JUDGMENTS,
  TRANSACTION_ROLES,
} from './types.ts';
import type {
  Endowment,
  FactKind,
  MonetizationAttribute,
  MonetizationEdgeKind,
  MonetizationMethod,
  MonetizationStatus,
  OpportunitySignal,
  PathJudgment,
  TransactionRole,
} from './types.ts';

export {
  ENDOWMENTS,
  MONETIZATION_ATTRIBUTES,
  MONETIZATION_EDGE_KINDS,
  MONETIZATION_METHODS,
  MONETIZATION_STATUSES,
  PATH_JUDGMENTS,
  TRANSACTION_ROLES,
};
export type {
  Endowment,
  FactKind,
  MonetizationAttribute,
  MonetizationEdgeKind,
  MonetizationMethod,
  MonetizationStatus,
  PathJudgment,
  TransactionRole,
};

/* --------------------------------------------------------------------------
 * What a method needs, and what it leaves behind
 * ------------------------------------------------------------------------ */

export interface MethodDeclaration {
  label: string;
  /** What the method is, in one line, for a person reading the ledger. */
  what: string;
  role: TransactionRole;
  /** What has to be true of whoever runs it. Never a claim about this Brain. */
  requires: readonly Endowment[];
  /** What running it leaves behind for something else to use. */
  produces: readonly Endowment[];
  /**
   * The kinds of evidence this method is structurally applicable to.
   *
   * Empty means *any subject*: the method needs no particular kind of opening
   * to be a shape of transaction over it. A subject whose signal nothing
   * recorded gets only those, which is the deny-by-default direction — fewer
   * claims where less is known, rather than the whole table because nothing
   * ruled anything out.
   */
  appliesTo: readonly OpportunitySignal[];
  /**
   * Whether this only works once something else has produced volume, an
   * audience or a recurring base.
   *
   * It is a property of the shape — a marketplace with two participants is not
   * a marketplace — and it is why §21 asks for *viable only at scale of*. It
   * never lowers a rank on its own: what it does is name the path that would
   * have to work first.
   */
  scaleDependent: boolean;
}

/**
 * A method that needs no particular kind of opening to be a shape of
 * transaction over it. Empty is the declaration, and `appliesTo`'s own comment
 * is what reads it.
 */
const ANY_SUBJECT: readonly OpportunitySignal[] = [];

export const METHOD: Readonly<Record<MonetizationMethod, MethodDeclaration>> = Object.freeze({
  DIRECT_SALE: {
    label: 'Direct sale',
    what: 'sell the thing or the work to the buyer yourself, for a price',
    role: 'PRINCIPAL',
    requires: ['BUYER_ACCESS', 'FULFILMENT_CAPACITY'],
    produces: ['RELATIONSHIPS'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  PRODUCTIZED_SERVICE: {
    label: 'Productized service',
    what: 'one fixed scope at one price, delivered the same way every time',
    role: 'PRINCIPAL',
    requires: ['BUYER_ACCESS', 'FULFILMENT_CAPACITY'],
    produces: ['RELATIONSHIPS', 'RECURRING_REVENUE'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'ACTIVE_BUYER_DEMAND', 'PAID_TASK_OR_CONTRACT'],
    scaleDependent: false,
  },
  CONSULTING: {
    label: 'Consulting',
    what: 'sell the judgement rather than the delivery',
    role: 'INFORMATION',
    requires: ['BUYER_ACCESS', 'CREDENTIAL'],
    produces: ['RELATIONSHIPS', 'DATA'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  DONE_WITH_YOU: {
    label: 'Done with you',
    what: 'the buyer does the work and pays for being taken through it',
    role: 'INFORMATION',
    requires: ['BUYER_ACCESS'],
    produces: ['RELATIONSHIPS'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'ACTIVE_BUYER_DEMAND'],
    scaleDependent: false,
  },
  TRAINING: {
    label: 'Training',
    what: 'teach the thing once and charge each person who attends',
    role: 'INFORMATION',
    requires: ['AUDIENCE'],
    produces: ['AUDIENCE', 'BRAND'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: true,
  },
  AUDIT_OR_ASSESSMENT: {
    label: 'Audit or assessment',
    what: 'charge to establish what is actually true, and sell the fix separately',
    role: 'INFORMATION',
    requires: ['BUYER_ACCESS'],
    produces: ['DATA', 'RELATIONSHIPS'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  MANAGED_SERVICE: {
    label: 'Managed service',
    what: 'take the whole function off the buyer and bill for it every month',
    role: 'PRINCIPAL',
    requires: ['BUYER_ACCESS', 'FULFILMENT_CAPACITY', 'RELATIONSHIPS'],
    produces: ['RECURRING_REVENUE', 'DATA'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'ACTIVE_BUYER_DEMAND'],
    scaleDependent: false,
  },
  MAINTENANCE_CONTRACT: {
    label: 'Maintenance contract',
    what: 'sell the keeping-it-working after the thing itself is delivered',
    role: 'PRINCIPAL',
    requires: ['RELATIONSHIPS', 'FULFILMENT_CAPACITY'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['PAID_TASK_OR_CONTRACT', 'RECURRING_OUTSOURCED_WORK'],
    scaleDependent: false,
  },
  SUBCONTRACTED_FULFILMENT: {
    label: 'Subcontracted fulfilment',
    what: 'win the work and have somebody else do it, keeping the difference',
    role: 'INTERMEDIARY',
    requires: ['BUYER_ACCESS', 'SUPPLY_ACCESS'],
    produces: ['RELATIONSHIPS', 'DATA'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  AGENCY_REPRESENTATION: {
    label: 'Agency representation',
    what: 'act for one side and take a share of what they receive',
    role: 'INTERMEDIARY',
    requires: ['RELATIONSHIPS'],
    produces: ['RELATIONSHIPS', 'RECURRING_REVENUE'],
    appliesTo: ['SUPPLY_DEMAND_MISMATCH', 'RECURRING_OUTSOURCED_WORK', 'RESALABLE_ASSET_OPENING'],
    scaleDependent: false,
  },
  BROKERAGE: {
    label: 'Brokerage',
    what: 'put the two sides together and take a fee from the transaction',
    role: 'INTERMEDIARY',
    requires: ['BUYER_ACCESS', 'SUPPLY_ACCESS'],
    produces: ['DATA', 'RELATIONSHIPS'],
    appliesTo: [
      'SUPPLY_DEMAND_MISMATCH',
      'PRICING_OR_INFORMATION_ASYMMETRY',
      'RESALABLE_ASSET_OPENING',
      'ACTIVE_BUYER_DEMAND',
    ],
    scaleDependent: false,
  },
  LEAD_GENERATION: {
    label: 'Lead generation',
    what: 'find the buyer and sell the introduction to whoever wants it',
    role: 'INFORMATION',
    requires: ['DATA'],
    produces: ['RELATIONSHIPS', 'RECURRING_REVENUE'],
    appliesTo: ['ACTIVE_BUYER_DEMAND', 'SUPPLY_DEMAND_MISMATCH', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  REFERRAL_FEE: {
    label: 'Referral fee',
    what: 'send the work to somebody who can do it and take a cut for sending it',
    role: 'INTERMEDIARY',
    requires: ['RELATIONSHIPS'],
    produces: ['RELATIONSHIPS'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  AFFILIATE: {
    label: 'Affiliate',
    what: 'be paid for the sales you send to somebody else, on their published terms',
    role: 'INFORMATION',
    requires: ['AUDIENCE'],
    produces: ['DATA'],
    appliesTo: ['ACTIVE_BUYER_DEMAND', 'PRICING_OR_INFORMATION_ASYMMETRY'],
    scaleDependent: true,
  },
  MARKETPLACE: {
    label: 'Marketplace',
    what: 'run the place both sides meet in and take a share of what they do there',
    role: 'PLATFORM',
    requires: ['BUYER_ACCESS', 'SUPPLY_ACCESS', 'SOFTWARE'],
    produces: ['DATA', 'RECURRING_REVENUE', 'AUDIENCE'],
    appliesTo: ['SUPPLY_DEMAND_MISMATCH', 'RECURRING_OUTSOURCED_WORK'],
    scaleDependent: true,
  },
  PLATFORM_FEE: {
    label: 'Platform fee',
    what: 'charge for access to the machinery rather than for the outcome',
    role: 'PLATFORM',
    requires: ['SOFTWARE', 'AUDIENCE'],
    produces: ['RECURRING_REVENUE', 'DATA'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: true,
  },
  ADVERTISING: {
    label: 'Advertising',
    what: 'sell the attention you have already gathered',
    role: 'PLATFORM',
    requires: ['AUDIENCE'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: true,
  },
  SPONSORSHIP: {
    label: 'Sponsorship',
    what: 'one payer buys association with what you already publish',
    role: 'PLATFORM',
    requires: ['AUDIENCE', 'BRAND'],
    produces: ['RECURRING_REVENUE', 'RELATIONSHIPS'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: true,
  },
  DATA_SUBSCRIPTION: {
    label: 'Recurring data subscription',
    what: 'sell the same observations again every period, to more than one buyer',
    role: 'INFORMATION',
    requires: ['DATA', 'SOFTWARE'],
    produces: ['RECURRING_REVENUE', 'BRAND'],
    appliesTo: ['PRICING_OR_INFORMATION_ASYMMETRY', 'SUPPLY_DEMAND_MISMATCH', 'ACTIVE_BUYER_DEMAND'],
    scaleDependent: true,
  },
  INTELLIGENCE_REPORT: {
    label: 'Intelligence report',
    what: 'sell what the research already established, once, as a document',
    role: 'INFORMATION',
    requires: ['DATA'],
    produces: ['BRAND', 'AUDIENCE'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  API_ACCESS: {
    label: 'API access',
    what: 'let somebody else’s software ask yours, and meter it',
    role: 'PLATFORM',
    requires: ['DATA', 'SOFTWARE'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['PRICING_OR_INFORMATION_ASYMMETRY', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: true,
  },
  SOFTWARE_TOOL: {
    label: 'Software tool',
    what: 'build the thing that does the work and sell the thing',
    role: 'PLATFORM',
    requires: ['SOFTWARE'],
    produces: ['RECURRING_REVENUE', 'DATA'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'PAID_TASK_OR_CONTRACT'],
    scaleDependent: false,
  },
  TEMPLATE_OR_ASSET_SALE: {
    label: 'Template or asset sale',
    what: 'sell the artifact the work produced, again, to somebody else',
    role: 'PRINCIPAL',
    requires: [],
    produces: ['AUDIENCE', 'BRAND'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'PAID_TASK_OR_CONTRACT'],
    scaleDependent: false,
  },
  COMMUNITY_MEMBERSHIP: {
    label: 'Community membership',
    what: 'charge for being inside the room where the answers are',
    role: 'PLATFORM',
    requires: ['AUDIENCE'],
    produces: ['RECURRING_REVENUE', 'RELATIONSHIPS'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: true,
  },
  CERTIFICATION: {
    label: 'Certification',
    what: 'charge to say somebody meets the standard, and to keep saying it',
    role: 'INFORMATION',
    requires: ['BRAND', 'CREDENTIAL'],
    produces: ['RECURRING_REVENUE', 'DATA'],
    appliesTo: ['SUPPLY_DEMAND_MISMATCH', 'RECURRING_OUTSOURCED_WORK'],
    scaleDependent: true,
  },
  EVENTS: {
    label: 'Events',
    what: 'gather the people who would transact and charge for the gathering',
    role: 'PLATFORM',
    requires: ['AUDIENCE', 'RELATIONSHIPS'],
    produces: ['RELATIONSHIPS', 'BRAND', 'AUDIENCE'],
    appliesTo: ['SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: true,
  },
  LICENSING: {
    label: 'Licensing',
    what: 'let somebody else use what you made, on terms, for a fee',
    role: 'INFORMATION',
    requires: ['SOFTWARE'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'PRICING_OR_INFORMATION_ASYMMETRY'],
    scaleDependent: false,
  },
  WHITE_LABEL: {
    label: 'White label',
    what: 'let somebody else sell it as theirs and be paid per unit',
    role: 'INTERMEDIARY',
    requires: ['FULFILMENT_CAPACITY', 'RELATIONSHIPS'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK', 'PAID_TASK_OR_CONTRACT'],
    scaleDependent: false,
  },
  FRANCHISE: {
    label: 'Franchise',
    what: 'sell the whole operating method and take a share of what it earns',
    role: 'INFORMATION',
    requires: ['BRAND', 'RECURRING_REVENUE'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['RECURRING_OUTSOURCED_WORK'],
    scaleDependent: true,
  },
  ARBITRAGE: {
    label: 'Arbitrage',
    what: 'buy where it is cheap and sell where it is dear, keeping the spread',
    role: 'PRINCIPAL',
    requires: ['SUPPLY_ACCESS', 'BUYER_ACCESS', 'CAPITAL'],
    produces: ['DATA'],
    appliesTo: ['PRICING_OR_INFORMATION_ASYMMETRY', 'RESALABLE_ASSET_OPENING'],
    scaleDependent: false,
  },
  RESALE: {
    label: 'Resale',
    what: 'acquire the asset and sell it on',
    role: 'PRINCIPAL',
    requires: ['SUPPLY_ACCESS', 'CAPITAL'],
    produces: ['DATA'],
    appliesTo: ['RESALABLE_ASSET_OPENING', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  DROP_SHIP: {
    label: 'Drop ship',
    what: 'sell it before you hold it, and have the supplier deliver',
    role: 'INTERMEDIARY',
    requires: ['SUPPLY_ACCESS', 'BUYER_ACCESS'],
    produces: ['DATA'],
    appliesTo: ['RESALABLE_ASSET_OPENING', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: false,
  },
  CONSIGNMENT: {
    label: 'Consignment',
    what: 'sell somebody else’s stock and pay them out of the proceeds',
    role: 'INTERMEDIARY',
    requires: ['BUYER_ACCESS', 'RELATIONSHIPS'],
    produces: ['DATA', 'RELATIONSHIPS'],
    appliesTo: ['RESALABLE_ASSET_OPENING', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: false,
  },
  RENTAL: {
    label: 'Rental',
    what: 'keep the asset and charge for its use',
    role: 'CAPITAL',
    requires: ['CAPITAL', 'SUPPLY_ACCESS'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['RESALABLE_ASSET_OPENING', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: false,
  },
  LEASING: {
    label: 'Leasing',
    what: 'fund the asset for whoever needs it and be repaid over a term',
    role: 'CAPITAL',
    requires: ['CAPITAL', 'CREDENTIAL'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ['SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: false,
  },
  AUCTION: {
    label: 'Auction',
    what: 'let the price be discovered by the bidding rather than quoted',
    role: 'PLATFORM',
    requires: ['SUPPLY_ACCESS', 'AUDIENCE'],
    produces: ['DATA'],
    appliesTo: ['RESALABLE_ASSET_OPENING', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  BOUNTY: {
    label: 'Bounty',
    what: 'solve the published problem and collect the published payment',
    role: 'PRINCIPAL',
    requires: ['FULFILMENT_CAPACITY'],
    produces: ['BRAND', 'DATA'],
    appliesTo: ['PAID_TASK_OR_CONTRACT', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  COMPETITION_PRIZE: {
    label: 'Competition prize',
    what: 'enter, win, and be paid for having won',
    role: 'PRINCIPAL',
    requires: ['FULFILMENT_CAPACITY'],
    produces: ['BRAND'],
    appliesTo: ['PAID_TASK_OR_CONTRACT', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  GRANT: {
    label: 'Grant',
    what: 'be funded to do the thing because somebody wants it to exist',
    role: 'CAPITAL',
    requires: ['CREDENTIAL'],
    produces: ['CAPITAL', 'BRAND'],
    appliesTo: ['PAID_TASK_OR_CONTRACT', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  PROCUREMENT_CONTRACT: {
    label: 'Procurement contract',
    what: 'bid for the published requirement and be awarded it',
    role: 'PRINCIPAL',
    requires: ['CREDENTIAL', 'FULFILMENT_CAPACITY'],
    produces: ['RELATIONSHIPS', 'BRAND', 'RECURRING_REVENUE'],
    appliesTo: ['PAID_TASK_OR_CONTRACT', 'ACTIVE_BUYER_DEMAND', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  TENDER_SUPPORT: {
    label: 'Tender support',
    what: 'be paid by the bidders rather than by the buyer',
    role: 'INFORMATION',
    requires: ['DATA', 'RELATIONSHIPS'],
    produces: ['RELATIONSHIPS', 'RECURRING_REVENUE'],
    appliesTo: ['PAID_TASK_OR_CONTRACT', 'EXPIRING_OPENING'],
    scaleDependent: false,
  },
  RECOVERY_OR_CLAIMS: {
    label: 'Recovery or claims',
    what: 'find money somebody is owed and take a share of getting it back',
    role: 'INTERMEDIARY',
    requires: ['DATA', 'CREDENTIAL'],
    produces: ['RELATIONSHIPS'],
    appliesTo: ['PRICING_OR_INFORMATION_ASYMMETRY', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: false,
  },
  COMPLIANCE_SERVICE: {
    label: 'Compliance service',
    what: 'be paid to keep somebody on the right side of a published rule',
    role: 'PRINCIPAL',
    requires: ['CREDENTIAL', 'BUYER_ACCESS'],
    produces: ['RECURRING_REVENUE', 'RELATIONSHIPS'],
    appliesTo: ['ACTIVE_BUYER_DEMAND', 'RECURRING_OUTSOURCED_WORK'],
    scaleDependent: false,
  },
  REVENUE_SHARE: {
    label: 'Revenue share',
    what: 'take nothing up front and a share of what it produces',
    role: 'CAPITAL',
    requires: ['RELATIONSHIPS'],
    produces: ['RECURRING_REVENUE'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  JOINT_VENTURE: {
    label: 'Joint venture',
    what: 'somebody else holds what is missing, and the two of you split it',
    role: 'CAPITAL',
    requires: ['RELATIONSHIPS'],
    produces: ['FULFILMENT_CAPACITY', 'CAPITAL'],
    appliesTo: ANY_SUBJECT,
    scaleDependent: false,
  },
  PURCHASE_ORDER_FINANCE: {
    label: 'Purchase-order finance',
    what: 'fund somebody else’s confirmed order and be repaid from it',
    role: 'CAPITAL',
    requires: ['CAPITAL', 'RELATIONSHIPS'],
    produces: [],
    appliesTo: ['SUPPLY_DEMAND_MISMATCH', 'PAID_TASK_OR_CONTRACT'],
    scaleDependent: false,
  },
  RECEIVABLES_FINANCE: {
    label: 'Receivables finance',
    what: 'buy the invoice at a discount and collect it in full',
    role: 'CAPITAL',
    requires: ['CAPITAL', 'RELATIONSHIPS'],
    produces: [],
    appliesTo: ['PRICING_OR_INFORMATION_ASYMMETRY', 'SUPPLY_DEMAND_MISMATCH'],
    scaleDependent: false,
  },
});

export function isMonetizationMethod(value: unknown): value is MonetizationMethod {
  return (
    typeof value === 'string' && (MONETIZATION_METHODS as readonly string[]).includes(value)
  );
}

/* --------------------------------------------------------------------------
 * What every path has to answer
 * ------------------------------------------------------------------------ */

/**
 * Whose question an attribute is.
 *
 * The same three words `services/cash/card.ts` uses, declared here rather than
 * imported because a domain module reaching up into a service is the wrong
 * direction. They mean exactly what they mean there, and `PERSON_ONLY` is
 * deliberately unused for the same reason it is unused on the evidence card:
 * being allowed to answer something is not a reason to be asked for it, and a
 * blank wrongly marked a person's sits on somebody's screen for ever.
 */
export type AttributeOwner = 'BRAIN_RESEARCH' | 'BRAIN_PROPOSES' | 'PERSON_ONLY';

/** What an answer to this attribute is made of, which decides what may sort on it. */
export type AttributeUnit = 'TEXT' | 'MONEY' | 'DAYS' | 'CHOICE';

export interface AttributeDeclaration {
  label: string;
  /** What it asks, for the ledger. */
  question: string;
  /** What would answer it. A property of the question, never of today's blank. */
  task: string;
  owner: AttributeOwner;
  unit: AttributeUnit;
  /** For CHOICE, the whole of what may be recorded — weakest first. */
  choices?: readonly string[];
  /**
   * Which kinds of answer this attribute admits.
   *
   * Only one attribute narrows it, and that one is the point: a probability of
   * success is a published base rate or it is unknown. Brain may not propose
   * one, because a proposed probability is indistinguishable from a measured
   * one the moment it is rendered, and everything downstream would then be
   * arithmetic over it.
   */
  kinds: readonly FactKind[];
  /**
   * Whether the ledger refuses to call a path *proven* without it.
   *
   * Not a gate on anything: nothing here stops work, refuses a fire or charges
   * an attempt. It decides what `status.ts` calls UNPROVEN and what the surface
   * names as still open.
   */
  loadBearing: boolean;
}

const ANY_KIND: readonly FactKind[] = ['EVIDENCE', 'RECOMMENDATION', 'PERSON'];

export const ATTRIBUTE: Readonly<Record<MonetizationAttribute, AttributeDeclaration>> =
  Object.freeze({
    requiredCapability: {
      label: 'Required capability',
      question: 'What would whoever runs this have to be able to do?',
      task:
        'Name the capability the published delivery requirements actually imply — a tool, a ' +
        'skill, a licence, a piece of software, somebody to do the work.',
      owner: 'BRAIN_RESEARCH',
      unit: 'TEXT',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    requiredRelationships: {
      label: 'Required relationships',
      question: 'Who would have to take the call?',
      task:
        'Name the party this cannot happen without — the supplier, the platform, the buyer, the ' +
        'licence holder — and what is published about getting to them.',
      owner: 'BRAIN_RESEARCH',
      unit: 'TEXT',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    requiredCapital: {
      label: 'Required capital',
      question: 'How much cash goes out before any comes back?',
      task:
        'Find what the published prices, deposits, fees and minimums add up to. A cost nobody ' +
        'publishes is unknown, never zero.',
      owner: 'BRAIN_RESEARCH',
      unit: 'MONEY',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    expectedRevenue: {
      label: 'Expected revenue',
      question: 'What would this actually pay?',
      task:
        'Find what comparable work or comparable assets are published at, with the source and ' +
        'the date. A price is read from a source and never produced.',
      owner: 'BRAIN_RESEARCH',
      unit: 'MONEY',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    directCosts: {
      label: 'Direct costs',
      question: 'What does delivering it cost?',
      task:
        'Find published prices for what this needs: tools, data, subcontracted labour, platform ' +
        'fees, shipping, insurance.',
      owner: 'BRAIN_RESEARCH',
      unit: 'MONEY',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    timeToCash: {
      label: 'Time to cash',
      question: 'When would the money be usable?',
      task:
        'Find the published payment terms, payout schedule, settlement period or decision date, ' +
        'and count from today to when the funds could actually be spent.',
      owner: 'BRAIN_RESEARCH',
      unit: 'DAYS',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    probabilityOfSuccess: {
      label: 'Probability of success',
      question: 'What is published about how often this works?',
      task:
        'Find a published rate about this kind of transaction — award rates for this programme, ' +
        'sell-through for this category, acceptance rates for this platform — with its source ' +
        'and its population. Brain does not produce one, so with nothing published this stays ' +
        'unknown.',
      owner: 'BRAIN_RESEARCH',
      unit: 'TEXT',
      /*
       * The one narrowing in this table, and the whole reason the column exists.
       *
       * A `RECOMMENDATION` here would be Brain writing a number that reads
       * exactly like a measurement — §29's arithmetic on a fiction, at the
       * field the brief most invites it at. A person may still record their own
       * judgement, because a person's decision is theirs and is labelled as
       * one; what may not happen is Brain inventing it and the ranking then
       * consuming it.
       */
      kinds: ['EVIDENCE', 'PERSON'],
      loadBearing: false,
    },
    executionDifficulty: {
      label: 'Execution difficulty',
      question: 'How hard is this to actually do?',
      task:
        'Judge it from the published requirements, the hours comparable work takes and the ' +
        'capabilities this Brain has — and say what the judgement rests on.',
      owner: 'BRAIN_PROPOSES',
      unit: 'CHOICE',
      choices: ['LOW', 'MEDIUM', 'HIGH'],
      kinds: ANY_KIND,
      loadBearing: false,
    },
    legalRequirements: {
      label: 'Legal and compliance',
      question: 'What rule decides whether this is allowed at all?',
      task:
        'Find the published licence, registration, platform term, tax treatment or qualification ' +
        'that governs it. A documented absence of one is a real finding.',
      owner: 'BRAIN_RESEARCH',
      unit: 'TEXT',
      kinds: ANY_KIND,
      loadBearing: true,
    },
    externalDependencies: {
      label: 'External dependencies',
      question: 'What outside this has to hold for it to work?',
      task:
        'Name what this rests on that nobody here controls — a platform, a supplier, a ' +
        'programme, a season, a rule that could change.',
      owner: 'BRAIN_RESEARCH',
      unit: 'TEXT',
      kinds: ANY_KIND,
      loadBearing: false,
    },
    competition: {
      label: 'Competition',
      question: 'Who is already doing this?',
      task:
        'Find who else is published as supplying this, and how many. A documented absence is a ' +
        'finding; an undocumented one is not.',
      owner: 'BRAIN_RESEARCH',
      unit: 'CHOICE',
      choices: ['NONE_FOUND', 'FEW', 'MANY', 'SATURATED'],
      kinds: ANY_KIND,
      loadBearing: false,
    },
    scalability: {
      label: 'Scalability',
      question: 'Does the second one cost less than the first?',
      task:
        'Say whether the same machinery serves the next customer, or whether each one is a job ' +
        'done by hand — from the published delivery requirements rather than from how it sounds.',
      owner: 'BRAIN_PROPOSES',
      unit: 'CHOICE',
      choices: ['NONE', 'LINEAR', 'SUPERLINEAR'],
      kinds: ANY_KIND,
      loadBearing: false,
    },
    repeatability: {
      label: 'Repeatability',
      question: 'Does this happen again?',
      task:
        'Find whether the same opening recurs — the same buyer commissioning again, the same ' +
        'programme reopening, the same spread returning — with dates.',
      owner: 'BRAIN_RESEARCH',
      unit: 'CHOICE',
      choices: ['ONE_OFF', 'REPEATABLE', 'RECURRING'],
      kinds: ANY_KIND,
      loadBearing: false,
    },
  });

/**
 * May an answer of this kind be recorded against this attribute?
 *
 * One attribute narrows it and that narrowing is the point: a probability of
 * success is a published base rate with a source, or a person's own decision,
 * or it is unknown. Brain may not propose one, because a proposed probability
 * is indistinguishable from a measured one the moment it is rendered and
 * everything downstream would then be arithmetic over it.
 *
 * It is a **refusal** rather than a comment. `recordPathFact` asks this before
 * it writes, so there is no path through the ledger that produces one — which
 * is the difference between a rule and a claim about a rule, and this file has
 * corrected that distinction enough times to enforce it here.
 */
export function mayAnswer(attribute: MonetizationAttribute, kind: FactKind): boolean {
  return ATTRIBUTE[attribute].kinds.includes(kind);
}

export function isMonetizationAttribute(value: unknown): value is MonetizationAttribute {
  return (
    typeof value === 'string' && (MONETIZATION_ATTRIBUTES as readonly string[]).includes(value)
  );
}

/* --------------------------------------------------------------------------
 * Where a path stands, and who said so
 * ------------------------------------------------------------------------ */

export function statusRank(status: MonetizationStatus): number {
  return MONETIZATION_STATUSES.indexOf(status);
}

export function isPathJudgment(value: unknown): value is PathJudgment {
  return typeof value === 'string' && (PATH_JUDGMENTS as readonly string[]).includes(value);
}

/* --------------------------------------------------------------------------
 * The graph
 * ------------------------------------------------------------------------ */

export function isMonetizationEdgeKind(value: unknown): value is MonetizationEdgeKind {
  return (
    typeof value === 'string' && (MONETIZATION_EDGE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The edges that follow from the method table alone, for one ordered pair.
 *
 * Pure, and over the declarations rather than over any row: the same pair of
 * methods always produces the same relations. That is what makes the graph
 * answerable without storing it, and what stops two readers drawing two
 * different pictures of one ledger.
 *
 * It is about *methods*, so a caller decides which pairs to ask about — the
 * only pairs worth asking about are paths on one subject, which is where
 * "instead of" and "on the way to" actually mean something.
 */
export function derivedRelations(
  from: MonetizationMethod,
  to: MonetizationMethod,
): MonetizationEdgeKind[] {
  if (from === to) return [];
  const a = METHOD[from];
  const b = METHOD[to];
  const out: MonetizationEdgeKind[] = [];

  const supplies = a.produces.filter((one) => b.requires.includes(one));
  if (supplies.length > 0) {
    out.push('ENABLES');
    if (supplies.includes('DATA')) out.push('PRODUCES_DATA_FOR');
    if (supplies.includes('RELATIONSHIPS')) out.push('PRODUCES_RELATIONSHIPS_FOR');
    /*
     * A stepping stone is an enabler that asks less of you than the thing it
     * enables. Counted rather than judged: fewer endowments required is a
     * property of the two declarations, and it is the honest reading of "do
     * this first" — it says the cheaper one comes first, never that the
     * expensive one is worth reaching.
     */
    if (a.requires.length < b.requires.length) out.push('STEPPING_STONE_TO');
  }

  /*
   * REQUIRES is deliberately **not** decided here.
   *
   * It is stronger than ENABLES — *the second cannot start until the first
   * has* — and that is a fact about the whole subject rather than about a pair:
   * `b` requires `a` only where nothing else on that subject produces what `b`
   * needs. A pairwise function cannot know that, and guessing it would state a
   * hard dependency from a partial view. `graph.ts` resolves it against every
   * path on the subject.
   */
  if (
    b.scaleDependent &&
    (a.produces.includes('AUDIENCE') || a.produces.includes('RECURRING_REVENUE'))
  ) {
    out.push('VIABLE_ONLY_AT_SCALE_OF');
  }

  if (a.role === b.role) out.push('COMPETES_WITH');
  else if (out.length === 0) out.push('COEXISTS_WITH');

  return out;
}
