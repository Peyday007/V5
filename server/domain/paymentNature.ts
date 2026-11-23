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
const RECEIPT = /\b(?:receives?|received|are credited|is credited|credited|is paid|are paid|gets?)\b[^.;]{0,20}?(?:\$|usd)|\b(?:sends?|pays?|paid|gives?)\b[^.;]{0,15}?\b(?:selected|enrolled|admitted|registered|qualifying|eligible|winning|matched|affected|chosen)\b|\b(?:selected|enrolled|admitted|chosen|qualifying|eligible|winning) [\w-]+ (?:receive|get|are paid|are credited)\b/i;
/** Restitution, compensation, damages or a penalty: owed, never bought. */
const COMPENSATION = /\b(?:restitution|compensation for|damages|penalt(?:y|ies)|indemnit(?:y|ies)|honorari(?:um|a)|matching contributions?|jackpots?|cash[- ]?back|credited back)\b/i;
/** Pay to an employee: the employer is buying a job, not a supplier's deliverable. */
const EMPLOYMENT = /\b(?:salar(?:y|ies)|wages?|annual pay|base pay|per year in pay|hourly wage)\b/i;
/** Words that make the money a price somebody is charged. */
const PURCHASE = /\b(?:charges?|charged|priced|pricing|price|fees?|costs?|invoices?|invoiced|retainers?|subscriptions?|commissions?|quotes?|quoted|per (?:hour|project|order|month|unit|item|page|word|seat|user|license|licence)|buys?|bought|purchases?|purchased|sells?|sold|hires?|hired|rates?|a (?:year|month)|annually|monthly|platform)\b/i;

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
