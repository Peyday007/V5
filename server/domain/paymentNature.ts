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
const REWARD_PROGRAM = /\b(?:bug[- ]?bount(?:y|ies)|bount(?:y|ies)(?: program(?:me)?s?| payouts?| rewards?| awards?)?|vulnerability (?:disclosure|reward)s?(?: program(?:me)?s?)?|hackathons?|sweepstakes|prize (?:money|pool|purse)s?|cash prizes?|grand prizes?|winnings)\b/i;
/** A reward described by what it is paid for: a finding, a report, a submission, a win. */
const REWARD_FOR = /\b(?:rewards?|awards?|prizes?|pays?(?: out)?|paid(?: out)?)\b[^.;]{0,60}?\bfor (?:(?:a|an|each|every|the|one|any) )?(?:(?:valid|eligible|accepted|qualifying|critical|high|medium|low|severe|winning|first|top)[- ](?:severity )?)*(?:findings?|vulnerabilit(?:y|ies)|bugs?|exploits?|reports?|submissions?|entr(?:y|ies)|wins?|winners?|places?)\b/i;
/** The award is the payment's own noun: "$5,000 grant", "a grant of $5,000". */
const GRANT_MONEY = /(?:\$|usd\s?)[\d,.]+\s*[km]?\b(?:\s+[\w-]+){0,2}?\s+(?:grants?|scholarships?|fellowships?|stipends?|subsid(?:y|ies)|donations?|endowments?|bursar(?:y|ies))\b|\b(?:grants?|scholarships?|fellowships?|stipends?|subsid(?:y|ies)|donations?|bursar(?:y|ies))\s+(?:of|worth|totall?ing|up to|ranging from|between|from|averaging)\s+(?:up to\s+|about\s+|approximately\s+)?(?:\$|usd)/i;
/** A grant body paying out, or a grant reimbursing an applicant. */
const GRANT_ACT = /\bgrants?\b[^.;]{0,40}?\b(?:reimburses?|covers?|funds?|awards?|provides?|pays?)\b|\b(?:awarded|receives?|received|won)\s+(?:an?\s+)?(?:[\w-]+\s+){0,2}?grants?\b/i;
/** Money returned or compensated, not exchanged for a deliverable. */
const TRANSFER = /(?:\$|usd\s?)[\d,.]+\s*[km]?\b(?:\s+[\w-]+){0,2}?\s+(?:rebates?|refunds?|reimbursements?|settlements?|cash ?back|damages)\b|\b(?:rebates?|refunds?|reimbursements?|settlements?|cash ?back|damages)\s+(?:of|worth|totall?ing|up to)\s+(?:up to\s+)?(?:\$|usd)|\breimburses?\b/i;
/** Pay to an employee: the employer is buying a job, not a supplier's deliverable. */
const EMPLOYMENT = /\b(?:salar(?:y|ies)|wages?|annual pay|base pay|per year in pay|hourly wage)\b/i;
/** Words that make the money a price somebody is charged. */
const PURCHASE = /\b(?:charges?|charged|priced|pricing|price|fees?|costs?|invoices?|invoiced|retainers?|subscriptions?|commissions?|quotes?|quoted|per (?:hour|project|order|month|unit|item|page|word|seat|user|license|licence)|buys?|bought|purchases?|purchased|sells?|sold|hires?|hired|rates?)\b/i;

/**
 * What a figure's claim says the money is paid for. Non-purchase cues are
 * read before purchase ones only where they name the payment itself; a claim
 * with both a purchase word and a mere mention of a grant ("charges $2,000 to
 * write a grant") stays a purchase. Pure.
 */
export function paymentNatureOf(text: string | null | undefined): PaymentNatureReading {
  const t = (text ?? '').replace(/\s+/g, ' ');
  if (!t) return { nature: 'PURCHASE', cue: null };
  const hit = (re: RegExp): string | null => t.match(re)?.[0] ?? null;
  const program = hit(REWARD_PROGRAM);
  if (program) return { nature: 'CONTINGENT_REWARD', cue: program };
  const rewardFor = hit(REWARD_FOR);
  // "pays $500 for each accepted puzzle" is a purchase; "rewards … for a valid finding" is not. Only reward words, or a payment for a finding or a win, count.
  if (rewardFor && (/\b(?:rewards?|awards?|prizes?)\b/i.test(rewardFor) || /\b(?:findings?|vulnerabilit|bugs?|exploits?|wins?|winners?|places?)\b/i.test(rewardFor))) return { nature: 'CONTINGENT_REWARD', cue: rewardFor };
  const grant = hit(GRANT_MONEY) ?? (PURCHASE.test(t) ? null : hit(GRANT_ACT));
  if (grant) return { nature: 'GRANT', cue: grant };
  const transfer = hit(TRANSFER);
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
  const reading = paymentNatureOf(openingText);
  if (reading.nature === 'PURCHASE' || requestedNonCommercial(goalText).has(reading.nature)) return null;
  return `not a sale: ${nonPurchaseSentence(reading)}; a revenue goal's strategies are commercial purchases unless the goal asks for this kind of payout`;
}
