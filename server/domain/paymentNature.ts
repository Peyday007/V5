/**
 * What a payment figure is paid *for*: the purchase of a good or service, or
 * money that moves for some other reason.
 *
 * Audit of goal wst_7b4fcbb5f2384f31b6c3, 2026-11-23
 * (docs/audits/2026-11-23-10k-plan-audit.md). GitHub's $10,000 public reward
 * for a critical vulnerability (clm_5e038810b7a945728e2f: "GitHub Inc pays
 * $10,000 per slot for a critical finding in its public bug bounty program")
 * was filed as the price GitHub pays per unit of work. A constructed
 * arrangement then sold GitHub a spreadsheet at $10,000, and that one figure
 * carried 98% of the plan's coverage. The direction check
 * (`claimPaysPopulation`) let it through, because GitHub *is* the one paying.
 * What it did not ask is what the money is paid for: a bounty is paid to
 * whoever first reports a valid finding, judged after the fact. No buyer pays
 * it to a supplier for a deliverable, so it is no evidence of what any buyer
 * pays for one.
 *
 * The same is true of a grant, prize, stipend, scholarship, rebate, refund,
 * reimbursement, settlement, donation or wage. Each may be real money, and
 * some are a goal's route on their own terms: a competitive award is modelled
 * as one (`isCompetitiveAward`). None is a price.
 *
 * A closed set of cues, read from the claim's own words and never from a
 * model's paraphrase (§8). A cue counts only where it is the payment itself:
 * "grant writers charge $2,000 per application" is a purchase *of* grant
 * writing, and stays one. Pure.
 */

export type PaymentNature = 'PURCHASE' | 'CONTINGENT_REWARD' | 'GRANT' | 'TRANSFER' | 'EMPLOYMENT';

export interface PaymentNatureReading {
  nature: PaymentNature;
  /** The words that decided it, or null for a purchase (the default when no cue is read). */
  cue: string | null;
}

/** Money paid to whoever wins, finds or submits first: judged after the work, never bought. */
const REWARD_PROGRAM = /\b(?:bug[- ]?bount(?:y|ies)|bount(?:y|ies)(?: program(?:me)?s?| payouts?| rewards?| awards?)?|vulnerability (?:disclosure|reward)s?(?: program(?:me)?s?)?|hackathons?|sweepstakes|giveaways?|raffles?|drawn at random|prize (?:money|pool|purse)s?|purses?|cash prizes?|grand prizes?|winnings)\b/i;
/** A reward described by what it is paid for: a finding, a report, a submission, a win. */
const REWARD_FOR = /\b(?:rewards?|awards?|prizes?|pays?(?: out)?|paid(?: out)?)\b[^.;]{0,60}?\bfor (?:(?:a|an|each|every|the|one|any) )?(?:(?:valid|eligible|accepted|qualifying|critical|high|medium|low|severe|winning|first|top)[- ](?:severity )?)*(?:findings?|vulnerabilit(?:y|ies)|bugs?|exploits?|reports?|submissions?|entr(?:y|ies)|wins?|winners?|places?)\b/i;
/** The award is the payment's own noun: "$5,000 grant", "a grant of $5,000". */
const GRANT_MONEY = /(?:\$|usd\s?)[\d,.]+\s*[km]?\b(?:\s+[\w-]+){0,2}?\s+(?:grants?|scholarships?|fellowships?|stipends?|subsid(?:y|ies)|donations?|endowments?|bursar(?:y|ies)|funding)\b(?!\s+(?:applications?|proposals?|writ\w*|submissions?|reports?|packages?|consult\w*|services?))|\b(?:grants?|scholarships?|fellowships?|stipends?|subsid(?:y|ies)|donations?|bursar(?:y|ies))\s+(?:of|worth|totall?ing|up to|ranging from|between|from|averaging)\s+(?:up to\s+|about\s+|approximately\s+)?(?:\$|usd)/i;
/** A grant body paying out, or a grant reimbursing an applicant. */
const GRANT_ACT = /\bgrants?\b[^.;]{0,40}?\b(?:reimburses?|covers?|funds?|awards?|provides?|pays?)\b|\b(?:awarded|receives?|received|won)\s+(?:an?\s+)?(?:[\w-]+\s+){0,2}?grants?\b/i;
/** Money returned or compensated, not exchanged for a deliverable. */
const TRANSFER = /(?:\$|usd\s?)[\d,.]+\s*[km]?\b(?:\s+[\w-]+){0,2}?\s+(?:rebates?|refunds?|reimbursements?|settlements?|cash ?back|damages|royalt(?:y|ies)|claim payouts?)\b(?!\s+(?:applications?|filings?|forms?|claims? (?:filed|prepared)|processing|services?|paperwork|packets?))|\b(?:rebates?|refunds?|reimbursements?|settlements?|cash ?back|damages)\s+(?:of|worth|totall?ing|up to)\s+(?:up to\s+)?(?:\$|usd)|\breimburses?\b/i;
/** Money paid out per approved claim: an insurer's or a program's claim payout, not a sale. */
const CLAIM_PAYOUT = /\bper (?:approved |eligible |paid |accepted )?(?:[\w-]+ ){0,2}claims?\b|\b(?:distributed|paid out)\b[^.;]{0,60}?\broyalt(?:y|ies)\b/i;
/** A settlement, rebate or refund being paid out to the people it is owed to. */
const TRANSFER_ACT = /\b(?:settlement|class[- ]action|rebate|refund|reimbursement|claims?) (?:administrator|program|fund|payouts?|payments?)\b|\bpays? (?:each |every )?(?:eligible )?(?:claimants?|class members?|policyholders?|homeowners? a)\b/i;
/** A prize for the best entry: paid to a winner, never bought. */
const PRIZE = /\b(?:(?:first|second|third|top|grand|cash|1st|2nd|3rd) )?prizes?\b(?!-)|\bawards? (?:an? )?(?:\$|usd)[^.;]{0,40}?\bto (?:the )?(?:single |top |best[\w-]* |winning |first[\w-]* )+(?:entr(?:y|ies)|submissions?|teams?|winners?|applicants?)\b/i;
/** The source denies that anything is bought or exchanged. */
const NO_EXCHANGE = /\b(?:not|no|nothing|never)\b[^.;]{0,30}?\b(?:purchased|bought|commissioned|sold|exchanged|is bought|are bought)\b|\bno (?:goods or services|consideration)\b/i;
/** A supplier's price document, or a payment to a supplier per unit of a deliverable. */
const SUPPLIER_PRICE_FRAME = /\b(?:rate cards?|price (?:lists?|sheets?)|fee (?:schedules?|sheets?)|pricing pages?|quotes? from|invoiced?)\b|\bcharges?\b[^.;]{0,40}?(?:\$|usd)|\bpa(?:y|ys|id)\s+(?:[\w&'-]+\s+){0,3}?(?:suppliers?|vendors?|providers?|contractors?|freelancers?|agenc(?:y|ies)|studios?|writers?|recruiters?|consultants?|firms?|services?|developers?|designers?|translators?|editors?|specialists?|brokers?)\b/i;
/** The money is received by someone selected, enrolled, admitted, qualifying or matched, or credited back to them. */
const RECEIPT = /\b(?:are credited|is credited|credited)\b[^.;]{0,20}?(?:\$|usd)|\b(?:sends?|pays?|paid|gives?)\b[^.;]{0,15}?\b(?:selected|enrolled|admitted|registered|qualifying|eligible|winning|matched|affected|chosen)\b|\b(?:selected|enrolled|admitted|chosen|qualifying|eligible|winning) [\w-]+ (?:receive|get|are paid|are credited)\b/i;
/** Restitution, compensation, damages or a penalty: owed, never bought. */
const COMPENSATION = /\b(?:restitution|compensation for|damages|penalt(?:y|ies)|indemnit(?:y|ies)|honorari(?:um|a)|matching contributions?|jackpots?|cash[- ]?back|credited back)\b/i;
/** Pay to an employee: the employer is buying a job, not a supplier's deliverable. */
const EMPLOYMENT = /\b(?:salar(?:y|ies)|wages?|annual pay|base pay|per year in pay|hourly wage)\b/i;
/** Words that make the money a price somebody is charged. */
/*
 * A rate per unit of work is what the work is bought at, with up to two words
 * qualifying the unit (decisive-10, 2026-11-25): "$165 per crew hour" from a
 * moving platform to its fleet partners and "$121.28 per qualified lead" from
 * a pay-per-call network to its publishers are what those payers pay suppliers.
 * Before, only a bare "per hour" counted, so both read as no exchange shown and
 * the plan modelled them at no price at all.
 */
const PURCHASE = /\b(?:charges?|charged|priced|pricing|price|fees?|costs?|invoices?|invoiced|retainers?|subscriptions?|commissions?|quotes?|quoted|per (?:[a-z-]+ ){0,2}?(?:hour|project|order|month|unit|item|page|word|seat|user|license|licence|lead|call|job|move|delivery|load|booking|task|visit|appointment|transaction|shift)s?|buys?|bought|purchases?|purchased|sells?|sold|hires?|hired|rates?|a (?:year|month)|annually|monthly|platform)\b/i;

/**
 * What a figure's claim says the money is paid for. Non-purchase cues are
 * read before purchase ones only where they name the payment itself; a claim
 * with both a purchase word and a mere mention of a grant ("charges $2,000 to
 * write a grant") stays a purchase. Pure.
 */
export function paymentNatureOf(text: string | null | undefined): PaymentNatureReading {
  // "No purchase necessary" is a sweepstakes' disclaimer, not a purchase.
  const t = (text ?? '').replace(/\s+/g, ' ').replace(/\bno purchase (?:is )?(?:necessary|required)\b/gi, ' ');
  if (!t) return { nature: 'PURCHASE', cue: null };
  const hit = (re: RegExp): string | null => t.match(re)?.[0] ?? null;
  // The source says outright that nothing is bought: an exchange is denied, whatever else the sentence names.
  const denied = hit(NO_EXCHANGE);
  if (denied) return { nature: 'TRANSFER', cue: denied };
  // A supplier's price document, or a buyer paying a supplier per deliverable, is a purchase even where its subject is a sweepstakes, a scholarship or a claim.
  const supplierPrice = hit(SUPPLIER_PRICE_FRAME);
  if (supplierPrice && !hit(RECEIPT)) return { nature: 'PURCHASE', cue: null };
  // Money that arrives at someone selected, enrolled, admitted or matched, or that a court orders paid, is not their purchase of anything.
  const received = hit(RECEIPT) ?? hit(COMPENSATION);
  if (received) return { nature: 'TRANSFER', cue: received };
  const rewardFor = hit(REWARD_FOR);
  // "pays $500 for each accepted puzzle" is a purchase; "rewards … for a valid finding" is not. Only reward words, or a payment for a finding or a win, count.
  if (rewardFor && (/\b(?:rewards?|awards?|prizes?)\b/i.test(rewardFor) || /\b(?:findings?|vulnerabilit(?:y|ies)|bugs?|exploits?|wins?|winners?|places?)\b/i.test(rewardFor))) return { nature: 'CONTINGENT_REWARD', cue: rewardFor };
  // A program named beside a purchase is the buyer's context, not the payment: "companies running bug bounty programs pay HackerOne $20,000 a year" buy a platform.
  const prize = PURCHASE.test(t) ? null : hit(PRIZE);
  if (prize) return { nature: 'CONTINGENT_REWARD', cue: prize };
  const program = hit(REWARD_PROGRAM);
  if (program && !PURCHASE.test(t)) return { nature: 'CONTINGENT_REWARD', cue: program };
  const grant = hit(GRANT_MONEY) ?? (PURCHASE.test(t) ? null : hit(GRANT_ACT));
  if (grant) return { nature: 'GRANT', cue: grant };
  const transfer = hit(TRANSFER) ?? hit(CLAIM_PAYOUT) ?? (PURCHASE.test(t) ? null : hit(TRANSFER_ACT));
  if (transfer) return { nature: 'TRANSFER', cue: transfer };
  const employment = PURCHASE.test(t) ? null : hit(EMPLOYMENT);
  if (employment) return { nature: 'EMPLOYMENT', cue: employment };
  return { nature: 'PURCHASE', cue: null };
}

/** Whether a figure's claim states money paid for something other than a purchase: never a price a buyer pays for a deliverable. Pure. */
export function isNonPurchasePayment(text: string | null | undefined): boolean {
  return paymentNatureOf(text).nature !== 'PURCHASE';
}

/** The sentence a refusal records: what the money is, in the claim's own words. Pure. */
export function nonPurchaseSentence(reading: PaymentNatureReading): string {
  const what: Record<Exclude<PaymentNature, 'PURCHASE'>, string> = {
    CONTINGENT_REWARD: 'a reward paid to whoever wins, finds or submits first, judged after the work',
    GRANT: 'a grant or award of funds',
    TRANSFER: 'money returned or compensated (a rebate, refund, reimbursement or settlement)',
    EMPLOYMENT: "an employee's pay",
  };
  return reading.nature === 'PURCHASE' ? 'a purchase' : `${what[reading.nature]} ("${reading.cue}"), not a price a buyer pays a supplier for a deliverable`;
}

/** Goal words that ask for a non-commercial route by name: a goal to win a prize or a grant may pursue one. */
const REQUESTED: ReadonlyArray<[Exclude<PaymentNature, 'PURCHASE'>, RegExp]> = [
  ['CONTINGENT_REWARD', /\b(?:bug[- ]?bount(?:y|ies)|bount(?:y|ies)|prizes?|contests?|competitions?|hackathons?|sweepstakes|vulnerability research)\b/i],
  ['GRANT', /\b(?:grants?|scholarships?|fellowships?|stipends?|subsid(?:y|ies)|non-?dilutive funding)\b/i],
  ['TRANSFER', /\b(?:rebates?|refunds?|reimbursements?|settlements?|claims?)\b/i],
  ['EMPLOYMENT', /\b(?:jobs?|employment|salar(?:y|ies)|wages?)\b/i],
];

/**
 * The non-commercial routes a goal's own words ask for. Everything else is a
 * revenue goal, and a reward, grant, rebate or wage is not one of its
 * strategies (owner, 2026-11-23: "Exclude those categories from ordinary
 * revenue-generation strategies unless explicitly requested"). Pure.
 */
export function requestedNonCommercial(goalText: string | null | undefined): ReadonlySet<PaymentNature> {
  const t = goalText ?? '';
  return new Set(REQUESTED.filter(([, re]) => re.test(t)).map(([nature]) => nature));
}

/** Why an opening is left out of an ordinary revenue goal, or null when it is a sale or the goal asked for its kind. Pure. */
export function nonCommercialExclusion(openingText: string, goalText: string | null | undefined): string | null {
  // A funding programme (a notice of funding, a cooperative agreement) is a grant whatever figure it states, unless the text shows a supplier being paid.
  const funding = FUNDING_PROGRAM.exec(openingText)?.[0] ?? null;
  if (funding && !requestedNonCommercial(goalText).has('GRANT') && !evidencesSupplierPayment(openingText)) {
    return `not a sale: ${nonPurchaseSentence({ nature: 'GRANT', cue: funding })}; a revenue goal's strategies are commercial purchases unless the goal asks for this kind of payout`;
  }
  // A topic is not a payment: "sweepstakes rules review" names what a brand buys. Only money the text states is read.
  if (!/(?:\$|usd\s?)\s?\d/i.test(openingText)) return null;
  const reading = paymentNatureOf(openingText);
  if (reading.nature === 'PURCHASE' || requestedNonCommercial(goalText).has(reading.nature)) return null;
  return `not a sale: ${nonPurchaseSentence(reading)}; a revenue goal's strategies are commercial purchases unless the goal asks for this kind of payout`;
}

const STOP = new Set(['this', 'that', 'these', 'those', 'with', 'from', 'each', 'every', 'their', 'there', 'about', 'which', 'would', 'could', 'other', 'than', 'they', 'them', 'have', 'been', 'were', 'will', 'into', 'over', 'under', 'year', 'month', 'week', 'per', 'cost', 'costs', 'price', 'prices', 'priced', 'pays', 'paid', 'charge', 'charges', 'sell', 'sells', 'sold', 'average', 'typical', 'typically', 'around', 'about', 'business', 'businesses', 'company', 'companies', 'customer', 'customers', 'buyer', 'buyers', 'client', 'clients', 'service', 'services', 'comparable', 'published', 'source', 'data', 'analyzed', 'analysed', 'report', 'listing', 'listings', 'manager', 'managers', 'management', 'owner', 'owners', 'operator', 'operators', 'software', 'tool', 'tools', 'team', 'teams', 'staff', 'small', 'large', 'local', 'state', 'national', 'professional', 'professionals', 'firm', 'firms', 'office', 'offices']);
const stems = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [])
      .flatMap((w) => w.split('-'))
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );

/**
 * Whether a price's own evidence is about these buyers or this deliverable at
 * all (audit 2026-11-23: an HVAC-software sentence, "Software Advice analyzed
 * data from 4,415 field service management buyers", became the GitHub leg's
 * offer, and planningReliability mv-05 files a trucking workbook's price from
 * HVAC software seats). Evidence that names things, none of which is the
 * buyer, the deliverable or its industry, is about another market. A bare
 * figure ("$250") names nothing and is not judged here. Pure.
 */
export function evidenceIsAbout(evidence: string | null | undefined, subject: string): boolean {
  const said = stems((evidence ?? '').replace(/(?:\$|usd)\s?[\d,.]+[km]?/gi, ' '));
  if (said.size < 3) return true;
  const about = stems(subject);
  for (const one of said) if (about.has(one)) return true;
  return false;
}

/** Somebody paying a supplier: a role that supplies work, a fee or rate, a price, a sale or a subscription. */
const SUPPLIER_ROLE = String.raw`(?:suppliers?|vendors?|providers?|contractors?|subcontractors?|freelancers?|agenc(?:y|ies)|studios?|writers?|recruiters?|consultants?|partners?|affiliates?|brokers?|services?|developers?|designers?|translators?|firms?|specialists?|professionals?|experts?|shops?|sellers?|stores?|platforms?|companies|businesses|bookkeepers?|accountants?|marketers?|analysts?|auditors?|preparers?|filers?|engineers?|technicians?|installers?|printers?|manufacturers?|wholesalers?|distributors?|lead providers?|outsourcers?)`;
const PAYS_SUPPLIER = new RegExp(String.raw`\bpa(?:y|ys|id|ying)\s+(?:[\w&'-]+\s+){0,3}?` + SUPPLIER_ROLE + String.raw`\b`, 'i');
const PAY_PER = /\bpa(?:y|ys|id|ying)\b[^.;]{0,50}?\b(?:per|for)\s+(?:a |an |each |every |one |the )?[\w-]+/i;
/** A buyer's procurement document or contract states what it will pay for a deliverable. */
const PROCUREMENT = /\b(?:requests? for (?:quotation|quote|proposal)s?|rfq|rfp|tender|purchase orders?|contracts?|budget(?:s|ed)? (?:of |up to )?(?:\$|usd)|not-to-exceed|payable net|net \d{1,3}\b|statement of work)/i;

/**
 * Whether worded price evidence shows what a purchase looks like: somebody
 * paying a supplier, a fee, rate or price charged, something sold or bought,
 * or a payment per unit of a deliverable (owner, 2026-11-23: "Require evidence
 * that identifiable customers actually buy it"). A reward, grant or transfer
 * is never one. A bare figure ("$250") states no mechanism and is left to the
 * rest of the evidence. Pure.
 */
export function evidencesPurchase(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').replace(/\bno purchase (?:is )?(?:necessary|required)\b/gi, ' ');
  if (paymentNatureOf(t).nature !== 'PURCHASE') return false;
  const words = t.replace(/(?:\$|usd)\s?[\d,.]+[km]?/gi, ' ').match(/[a-z]{4,}/gi) ?? [];
  if (words.length < 3) return true;
  return PURCHASE.test(t) || PAYS_SUPPLIER.test(t) || PAY_PER.test(t) || PROCUREMENT.test(t);
}

/** A public funding programme: what an applicant wins, never what a buyer pays a supplier. A grant *proposal* or *application* is the deliverable a grant writer sells. */
const FUNDING_PROGRAM = /\b(?:notices? of funding(?: opportunity)?|nofos?|funding opportunit(?:y|ies)|cooperative agreements?|grant programs?|grant programmes?|federal grants?|planning grants?|matching funds?)\b(?!\s+(?:proposals?|applications?|writ\w*|prep\w*|consult\w*|services?|support|readiness|management))/i;

/** Whether the text itself shows someone paying a supplier for work (a fee, a rate card, pay per deliverable, a procurement). Pure. */
export function evidencesSupplierPayment(text: string): boolean {
  const t = text.replace(/\s+/g, ' ');
  return SUPPLIER_PRICE_FRAME.test(t) || PAYS_SUPPLIER.test(t) || /\bpa(?:y|ys|id)\b[^.;]{0,50}?\bper\b/i.test(t);
}

/**
 * Whether an opening's payer, as its source describes them, is paying out a
 * reward, grant, rebate, settlement or wage ("GitHub, Inc. operates the bug
 * bounty program and pays rewards"; "the Farm Vitality Planning Grant
 * reimburses …"). Read on the payer's own description, never a topic. Pure.
 */
export function payerPaysOut(payer: string | null | undefined): boolean {
  if (!payer) return false;
  const nature = paymentNatureOf(payer).nature;
  return nature !== 'PURCHASE' || FUNDING_PROGRAM.test(payer) || /\b(?:operates|runs) (?:the |a |its )?[\w-]*\s*(?:bug[- ]?)?bounty\b|\bpays? rewards?\b/i.test(payer);
}

/*
 * The transaction a price figure describes (Task E, 2026-11-24).
 *
 * The cue lists above read what a payment *is called*. A figure can be a real
 * purchase and still not be this arrangement's price, because the money moves
 * the wrong way or for the wrong thing. An independent audit of a live plan
 * found three such figures: a public-procurement "price" that was the fee a
 * bidder pays for the bid documents, a domain broker's minimum upfront fee
 * filed as what a buyer pays for a different deliverable, and funding
 * programmes whose payer pays out rather than buys.
 *
 * So the evidence is read as a transaction, beside the fields the opening
 * already carries: who pays (the sentence's payer, against the opening's
 * payer), whom (the sentence's payee, against the deliverable Brain offers),
 * and in exchange for what. Relative to Brain, which sells the offer, the
 * figure is its price only when money flows from the opening's kind of buyer
 * to a supplier in Brain's position for that deliverable. A comparable buyer's
 * price for the same deliverable is still that: nothing here refuses evidence
 * for being an estimate, a range or about a neighbouring buyer.
 */

/** Where a price figure's money goes, relative to Brain as the seller of the offer. */
export type PriceDirection =
  /** A buyer pays a supplier in Brain's position for this deliverable. */
  | 'SALE'
  /** Money paid out to a recipient (a grant, prize, payout, wage or donation): no deliverable is bought. */
  | 'PAYOUT'
  /** A fee the seller, bidder or applicant pays a buyer or platform: Brain's cost of reaching the sale. */
  | 'PAID_BY_SELLER'
  /** What a supplier pays its own supplier: Brain's input cost, never its buyer's price. */
  | 'SUPPLIER_COST'
  /** Another supplier's price for another deliverable (a broker's or a recruiter's fee) quoted beside this buyer. */
  | 'ANOTHER_DELIVERABLE'
  /** The evidence names another market altogether. */
  | 'OFF_MARKET'
  /** Worded evidence that shows no buyer paying a supplier for anything. */
  | 'NO_EXCHANGE_SHOWN';

export interface PriceReading {
  direction: PriceDirection;
  counts: boolean;
  /** The words that decided it, or null for a sale. */
  cue: string | null;
  /** The sentence a note records, or null for a sale. */
  why: string | null;
}

/** The fields an opening or constructed arrangement already carries. Every one is optional: a rule that needs a missing field does not run. */
export interface ArrangementFields {
  title?: string | null;
  payer?: string | null;
  offerScope?: string | null;
  buyingSignal?: string | null;
  source?: string | null;
  industry?: string | null;
}

/** A role named for the service it sells: its fee is the price of that service and of nothing else. */
const SERVICE_ROLE = String.raw`(?:brokers?|agents?|recruiters?|headhunters?|copywriters?|ghostwriters?|writers?|translators?|interpreters?|designers?|illustrators?|developers?|programmers?|photographers?|videographers?|bookkeepers?|accountants?|cpas|lawyers?|attorneys?|paralegals?|appraisers?|inspectors?|tutors?|coaches?|editors?|proofreaders?|printers?|print shops?|manufacturers?|installers?|auctioneers?|notaries|movers?|landscapers?|plumbers?|electricians?|architects?|marketers?|auditors?|tax preparers?|transcribers?|caterers?|florists?|planners?)`;
/** A party on the selling side of a market: what it pays to take part is a cost of selling. */
const SELLER_SIDE = String.raw`(?:bidders?|offerors?|proposers?|respondents?|applicants?|entrants?|contestants?|exhibitors?|sellers?|merchants?|freelancers?|creators?|hosts?|vendors?|suppliers?|artists?|listers?|participants?)`;
const MODIFIERS = String.raw`(?:[\w&'-]+\s+){0,2}?`;
const ADVERB = String.raw`(?:typically\s+|often\s+|usually\s+|generally\s+|commonly\s+|normally\s+|also\s+)?`;
const QUALIFIER = String.raw`(?:\s+(?:on|at|in|from|across|via)\s+[\w&'-]+(?:\s+[\w&'-]+)?)?`;

/** "<role> charge/quote/require …": the role is paid. */
const ROLE_IS_PAID = new RegExp(String.raw`\b(${SERVICE_ROLE})${QUALIFIER}\s+${ADVERB}(?:charge|charges|charged|bill|bills|quote|quotes|quoted|require|requires|collect|collects|take|takes|keep|keeps|earn|earns|ask|asks|sell|sells|get|gets|receive|receives)\b`, 'i');
/** "… pay/retain <role>": the role is paid. */
const PAYS_ROLE = new RegExp(String.raw`\b(?:pa(?:y|ys|id|ying)|retain(?:s|ed)?|hire[sd]?|engage[sd]?)\s+${MODIFIERS}(${SERVICE_ROLE})\b`, 'i');
/** "<role> pay …" or "charges <role> …": a supplier is the one paying. */
const ROLE_PAYS = new RegExp(String.raw`\b(${SERVICE_ROLE})\s+${ADVERB}(?:pay|pays|paid|buy|buys|bought)\b|\b(?:charges?|charged|bills?|sells? to)\s+${MODIFIERS}(${SERVICE_ROLE})\b`, 'i');
/** "<seller-side party> must pay …" or "charges <seller-side party> …": the selling side pays. */
const SELLER_PAYS = new RegExp(String.raw`\b(${SELLER_SIDE})\s+(?:[\w-]+\s+){0,2}?(?:must\s+|shall\s+|are required to\s+|have to\s+|need to\s+)?(?:pay|pays|paid|purchase|purchases|buy|remit|remits)\s+(?:a\s+|an\s+|the\s+|up to\s+|about\s+|\$|usd|\d|fees?\b|for\b|to\b)|\b(?:charges?|charged|bills?|collects?(?: from)?)\s+${MODIFIERS}(${SELLER_SIDE})\b|\bof every (?:order|sale) (?:a |the )?(${SELLER_SIDE})\b`, 'i');
/** A fee paid to take part in a market or a solicitation, never for a deliverable. Only kinds only the selling side pays: a registration, membership or filing fee is often a buyer's purchase, and is read by who pays it instead. */
const GATE_FEE = /\b(?:bid(?:ding)?|tender|solicitation|jury|booth|listing|prequalification|insertion|exhibitor|vendor)\s+(?:document\s+|package\s+|set\s+)?(?:fees?|deposits?|dues|charges?)\b|\b(?:bid|tender|solicitation|plan|contract) (?:documents?|packages?|sets?|specs?)\b[^.;]{0,60}?(?:\$|usd|\bfee\b|\bdeposit\b)|\b(?:purchase|buy|obtain)s? (?:a |the )?(?:plan|bid|spec\w*) (?:sets?|documents?|packages?)\b|\bper (?:bid|plan|tender|solicitation) (?:package|set|document)s?\b|\bnon-?refundable\b[^.;]{0,30}?\b(?:fee|deposit)\b/i;
/** A platform or intermediary keeping a share of a seller's sale. */
const KEEPS_CUT = /\b([\w&'-]+)\s+(?:keeps?|takes?|retains?|deducts?|withholds?)\s+(?:a\s+)?(?:\d+(?:\.\d+)?\s?%|\w+ percent)(?:\s+(?:commission|cut|fee))?\s+(?:of|from)\s+(?:every |each |the |a |an |their |its )?(?:[\w-]+\s+)?(?:orders?|sales?|transactions?|bookings?|payouts?|earnings|sellers?|freelancers?|creators?|hosts?|vendors?)\b/i;
/** Money that arrives at a named recipient. */
const RECEIVES = /\b((?:[\w-]+\s+){0,4}?)(?:will\s+)?(?:each\s+)?(?:receives?|gets?|earns?|wins?|is awarded|are awarded|will be awarded)\s+(?:an?\s+|each\s+)?(?:estimated\s+|average\s+|up to\s+|about\s+|approximately\s+|roughly\s+)?(?:\$|usd)/i;
/** A recipient that is paid as a supplier for work, not as a winner, a claimant or a beneficiary. */
const SUPPLIER_RECIPIENT = new RegExp(String.raw`\b(?:${SERVICE_ROLE}|${SELLER_SIDE}|contractors?|agenc(?:y|ies)|consultants?|providers?|studios?|firms?)\b`, 'i');
/** A pool that pays out, or a gift. */
const PAYS_OUT = /\bfunds?\b[^.;]{0,15}\bpays?\b|\b(?:donate|donates|donated|pledge|pledges|pledged)\b/i;
/** A job: an employer paying an employee. */
const EMPLOYMENT_FRAME = /\bW-?2\b|\b\d+\s+hours (?:a|per) week\b|\b(?:with|plus|and) (?:full |health )?benefits\b|\bhealth benefits\b|\b(?:job|career) (?:postings?|boards?|listings?|openings?)\b|\bcareers? pages?\b|\bpaid time off\b|\b(?:part|full)[- ]time\b|\bhiring (?:seasonal |temporary |full-time |part-time )?(?:staff|employees|workers|associates)\b/i;
/** A body whose role is to pay out: a funder, a fund, a programme, a donor. */
const FUNDER_BODY = /\b(?:foundations?|endowments?|grantmakers?|funds?|arts councils?|development councils?|institutes?|institute of|programs?|programmes?|donors?|supporters?)\b/i;
/** Text that shows somebody being paid as a supplier, or buying through procurement or a sale. */
const SUPPLIER_SIGNAL = (t: string): boolean =>
  SUPPLIER_PRICE_FRAME.test(t) || PAYS_SUPPLIER.test(t) || PROCUREMENT.test(t) || /\b(?:sells?|sold|hires?|hired|retains?|retained|subscriptions?)\b/i.test(t);

const SUFFIX = /(?:ations?|ments?|ings?|ers?|ors?|ists?|ants?|ages?|als?|ions?|ies|es|s|y|e)$/;
/** A word's root for comparing a role with the service it sells ("brokers" / "brokerage", "translators" / "translation"). */
function root(word: string): string {
  let w = word.toLowerCase();
  for (let i = 0; i < 2; i += 1) {
    const cut = w.replace(SUFFIX, '');
    if (cut.length < 4 || cut === w) break;
    w = cut;
  }
  return w;
}
const roots = (text: string | null | undefined): string[] => (text ?? '').toLowerCase().match(/[a-z]{3,}/g)?.map(root) ?? [];
const sameRoot = (a: string, b: string): boolean => (a.length >= 5 && b.length >= 5 ? a.slice(0, 5) === b.slice(0, 5) : a === b);
/** Whether any word of a role phrase shares a root with the text. */
function named(role: string, text: string | null | undefined): boolean {
  const said = roots(text);
  return roots(role).some((one) => said.some((other) => sameRoot(one, other)));
}

/**
 * The transaction a price figure's evidence describes, read against the
 * arrangement it is offered as the price of. Pure.
 */
export function readPriceEvidence(evidence: string | null | undefined, arrangement: ArrangementFields = {}): PriceReading {
  return readTransaction(evidence, arrangement, true);
}

/**
 * Where only a buyer population is known (a price filed for a mapped buyer
 * type, before any offer is chosen): the rules that need no offer, so a fee
 * the selling side pays, a supplier's input cost or a payout is never filed as
 * what the population pays. Null when the figure runs the right way. Pure.
 */
export function wrongWayPrice(evidence: string | null | undefined, payer: string | null | undefined): PriceReading | null {
  const reading = readTransaction(evidence, { payer }, false);
  return reading.direction === 'PAYOUT' || reading.direction === 'PAID_BY_SELLER' || reading.direction === 'SUPPLIER_COST' ? reading : null;
}

function readTransaction(evidence: string | null | undefined, arrangement: ArrangementFields, opening: boolean): PriceReading {
  const t = (evidence ?? '').replace(/\s+/g, ' ').trim();
  const sale: PriceReading = { direction: 'SALE', counts: true, cue: null, why: null };
  if (!t) return sale;
  const offer = [arrangement.offerScope, arrangement.title].filter(Boolean).join(' ');
  const not = (direction: Exclude<PriceDirection, 'SALE'>, cue: string, why: string): PriceReading => ({ direction, counts: false, cue, why });

  // 1. What the money is called: a reward, grant, rebate, settlement or wage.
  const nature = paymentNatureOf(t);
  if (nature.nature !== 'PURCHASE') return not('PAYOUT', nature.cue ?? nature.nature, nonPurchaseSentence(nature));

  // 2. The selling side pays: a bid, application, listing or entry fee, or a platform's cut of a seller's sale. Brain would pay it, never be paid it.
  const gate = t.match(GATE_FEE)?.[0];
  if (gate) return not('PAID_BY_SELLER', gate, `a fee the seller, bidder or applicant pays to take part ("${gate}"), not a price a buyer pays for the deliverable`);
  const sellerPays = t.match(SELLER_PAYS);
  const sellerRole = sellerPays ? (sellerPays[1] ?? sellerPays[2] ?? sellerPays[3] ?? '') : '';
  // The opening's own buyer may be a seller of something else ("Etsy sellers pay $20 for product photos"): then they are the buyer.
  if (sellerPays && !named(sellerRole, arrangement.payer)) return not('PAID_BY_SELLER', sellerPays[0], `paid by ${sellerRole.toLowerCase()} ("${sellerPays[0]}"), the selling side, not by these buyers`);
  const cut = t.match(KEEPS_CUT);
  if (cut && !named(cut[1] ?? '', offer)) return not('PAID_BY_SELLER', cut[0], `a share an intermediary keeps of a seller's sale ("${cut[0]}"), not a price a buyer pays for the deliverable`);

  // 3. A supplier is the one paying: a trade or input price, Brain's cost.
  const supplierPays = t.match(ROLE_PAYS);
  const payingRole = supplierPays ? (supplierPays[1] ?? supplierPays[2] ?? '') : '';
  if (supplierPays && !named(payingRole, arrangement.payer)) return not('SUPPLIER_COST', supplierPays[0], `what ${payingRole.toLowerCase()} pay their own supplier ("${supplierPays[0]}"), an input cost, not these buyers' price`);

  // 4. The payee sells a named service that is not this offer: a broker's or a recruiter's fee is the price of brokering or recruiting.
  // What the money is for, where the sentence says ("for a small booking website", "per entry filed"), decides before the role's name does.
  const paid = t.match(ROLE_IS_PAID) ?? t.match(PAYS_ROLE);
  const payee = paid?.[1] ?? '';
  const paidFor = [...t.matchAll(/\b(?:for|per)\s+(?:a |an |each |every |one |the )?([\w\s-]{3,60}?)(?=[.,;:(]|$| on | at | in | from | to | with | after | before )/gi)].map((one) => one[1] ?? '').join(' ').replace(/\b(?:custom|small|large|full|single|basic|standard|typical|one-time|new|hour|month|year|week|day|minute|page|word|unit|project)\w*\b/gi, ' ');
  if (paid && offer && !named(payee, offer) && !named(paidFor, offer)) return not('ANOTHER_DELIVERABLE', paid[0], `the price of what ${payee.toLowerCase()} sell ("${paid[0]}"), another deliverable than this offer`);

  // 5. Money paid out to a recipient who is not a supplier, by a fund, a donor or an employer.
  const received = t.match(RECEIVES);
  if (received && !SUPPLIER_RECIPIENT.test(received[1] ?? '')) return not('PAYOUT', received[0], `money a recipient receives ("${received[0]}"), not a price paid for a deliverable`);
  const out = t.match(PAYS_OUT)?.[0];
  if (out) return not('PAYOUT', out, `money paid out or given ("${out}"), not a price paid for a deliverable`);
  const job = SUPPLIER_SIGNAL(t) ? undefined : (t.match(EMPLOYMENT_FRAME)?.[0] ?? [arrangement.buyingSignal, arrangement.source].filter(Boolean).join(' ').match(EMPLOYMENT_FRAME)?.[0]);
  if (job) return not('PAYOUT', job, `an employee's pay ("${job}"), not a price a buyer pays a supplier`);
  // An opening's payer is one body with a role; a population's name ("community foundations") is a kind of buyer, and buys.
  const funder = opening ? arrangement.payer?.match(FUNDER_BODY)?.[0] : undefined;
  if (funder && !SUPPLIER_SIGNAL(t)) return not('PAYOUT', funder, `its payer is a ${funder.toLowerCase()} paying out, and the evidence shows no supplier being paid`);

  // 6. The evidence is about another market, or shows no purchase at all.
  const subject = [arrangement.payer, arrangement.title, arrangement.offerScope, arrangement.industry].filter(Boolean).join(' ');
  if (subject && !evidenceIsAbout(t, subject)) return not('OFF_MARKET', t.slice(0, 100), `the evidence ("${t.slice(0, 100)}") is about another market`);
  if (!evidencesPurchase(t)) return not('NO_EXCHANGE_SHOWN', t.slice(0, 100), `the evidence ("${t.slice(0, 100)}") shows no buyer paying a supplier for a deliverable`);
  return sale;
}

/**
 * Why a whole opening is not a sale for a revenue goal, read from every field
 * it carries: a non-commercial payout its text states, or a payer whose role
 * is to pay out (a funder, a fund, a programme) with nothing in the opening
 * showing a supplier being paid or procured. Null when it is a sale or the
 * goal asked for its kind. Pure.
 */
export function arrangementExclusion(arrangement: ArrangementFields, goalText: string | null | undefined): string | null {
  const text = [arrangement.title, arrangement.offerScope, arrangement.buyingSignal, arrangement.source, arrangement.payer].filter(Boolean).join('. ');
  const stated = nonCommercialExclusion(text, goalText);
  if (stated) return stated;
  const asked = requestedNonCommercial(goalText);
  if (asked.size > 0) return null;
  if (payerPaysOut(arrangement.payer) && nonCommercialExclusion(`${arrangement.payer} $1`, goalText) !== null) return `not a sale: its payer pays out rather than buys ("${(arrangement.payer ?? '').slice(0, 80)}"); a revenue goal's strategies are commercial purchases`;
  const funder = arrangement.payer?.match(FUNDER_BODY)?.[0];
  if (funder && !SUPPLIER_SIGNAL(text)) return `not a sale: its payer is a ${funder.toLowerCase()} ("${(arrangement.payer ?? '').slice(0, 80)}") and nothing in the opening shows it paying a supplier for a deliverable; a revenue goal's strategies are commercial purchases`;
  return null;
}
