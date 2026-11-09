/**
 * What money can buy a plan that is short of buyers (§99): sending capacity,
 * inbound demand, a marketplace's buyers. Owner, 2026-11-09: "evaluate scaling
 * outreach to 10,000 emails per day rather than assuming current sending
 * capacity is permanent. Calculate actual costs, setup time, deliverability,
 * conversion requirements, and feasibility."
 *
 * A lever is evidence about a mechanism, not a business: what one unit costs,
 * what it yields a day, how long before it yields, each with a range and the
 * source it was read from. Every figure is ESTIMATE-tier (published by
 * someone else, about other operators), so a plan that buys a lever stays
 * coverage until this Brain measures its own yield. Adding a lever is adding a
 * row; nothing in the reconstruction loop knows any lever by name.
 *
 * The money limits bind the purchase exactly as they bind any arrangement:
 * before anything has paid, one commitment may be at most the goal's
 * before-proof limit; the per-week limit and the ceiling only open once cash
 * has come in, so a larger purchase is modelled as starting after first cash.
 */

export interface Sourced {
  low: number;
  high: number;
  source: string;
}

export interface AcquisitionLever {
  key: string;
  label: string;
  kind: 'SENDING_CAPACITY' | 'PAID_INBOUND' | 'MARKETPLACE';
  /** SENDING_CAPACITY: one sending mailbox. */
  sendsPerUnitDay?: Sourced;
  unitsPerDomain?: Sourced;
  domainCost?: Sourced;
  unitMonthlyCost?: Sourced;
  /** Setup before a unit yields (warm-up for mailboxes, approval and learning for ads). */
  setupDays: Sourced;
  /** Tooling that scales with volume, per month: the sending platform's plan. */
  platformMonthly?: Sourced;
  /** Per contact: list data plus verification. */
  perContactCost?: Sourced;
  /** PAID_INBOUND / MARKETPLACE: what one lead costs, and the share who are real buyers. */
  costPerLead?: Sourced;
  qualifiedShare?: Sourced;
  /** Deliverability or platform limits that bind regardless of money. */
  constraints: string[];
}

/**
 * Figures read 2026-11-09. Sources are named on each figure; the research
 * behind them is recorded in docs/CASH-10K-PLAN-2026-11-09.md §8.
 */
export const ACQUISITION_LEVERS: readonly AcquisitionLever[] = [
  {
    key: 'cold-email-new-mailboxes',
    label: 'new cold-email mailboxes (warmed by us)',
    kind: 'SENDING_CAPACITY',
    sendsPerUnitDay: { low: 20, high: 30, source: 'help.instantly.ai "When your email account is ready for campaigns": at most 30 campaign sends per account a day; Smartlead help center 15–25' },
    unitsPerDomain: { low: 2, high: 3, source: 'mailforge.ai/pricing 2–3 per domain; Smartlead pre-warmed 3 (helpcenter.smartlead.ai/429)' },
    domainCost: { low: 10.46, high: 15, source: '.com: Cloudflare at cost $10.46–11.17, Porkbun $11.81, cold-email vendors $14–15 (read 2026-11-09)' },
    unitMonthlyCost: { low: 0.75, high: 8.4, source: 'maildoso.ai/pricing $0.75 at 300 boxes; Mailforge $2.40–3.00; Zapmail $2.99–3.90; Google Workspace Business Starter $7.00–8.40' },
    setupDays: { low: 14, high: 21, source: 'help.instantly.ai/en/articles/5975329: warm up 14–21 days before campaigns' },
    platformMonthly: { low: 97, high: 358, source: 'help.instantly.ai/en/articles/10273259: Hypergrowth $97–107 (125k emails/mo), Light Speed $358 (500k/mo)' },
    perContactCost: { low: 0.009, high: 0.1, source: 'help.instantly.ai/en/articles/11381241: 1–2 SuperSearch credits a verified lead at $0.0085–0.06 a credit; MillionVerifier $0.00045–0.0018, ZeroBounce $0.0099–0.0195 an address' },
    constraints: [
      'bounce under 2%, Instantly auto-pauses a campaign at 5% (help.instantly.ai/en/articles/16034903)',
      'spam complaints under 0.3% for Gmail and Yahoo, DMARC and one-click unsubscribe over 5,000 a day to Gmail (support.google.com/a/answer/81126)',
    ],
  },
  {
    key: 'cold-email-prewarmed',
    label: 'pre-warmed cold-email accounts',
    kind: 'SENDING_CAPACITY',
    sendsPerUnitDay: { low: 5, high: 25, source: 'help.instantly.ai/en/articles/9969215: pre-warmed accounts start at 5 a day and ramp to 20–25' },
    unitsPerDomain: { low: 5, high: 5, source: 'help.instantly.ai/en/articles/9969215: sold in batches of 5 on one domain' },
    domainCost: { low: 15, high: 15, source: 'Instantly pre-warmed domain $15 a year' },
    unitMonthlyCost: { low: 10, high: 10, source: 'help.instantly.ai/en/articles/9969215: $10 per account a month' },
    setupDays: { low: 0, high: 3, source: 'usable on day one; DNS and ramp a few days' },
    platformMonthly: { low: 0, high: 97, source: 'the owner\'s existing Instantly plan; Hypergrowth $97 if the volume outgrows it' },
    perContactCost: { low: 0.009, high: 0.1, source: 'as above: SuperSearch credits plus verification' },
    constraints: ['the same bounce and complaint limits as any sender', 'reputation is the vendor\'s pool until our own sends build it'],
  },
  {
    key: 'paid-search-inbound',
    label: 'paid search (Google Ads)',
    kind: 'PAID_INBOUND',
    costPerLead: { low: 66.69, high: 103.54, source: 'WordStream/LocaliQ benchmarks via theedigital.com and fibbler.co (2025–2026): all industries $66.69–70.11, business services $93.69–103.54, home improvement $90.92 a lead' },
    qualifiedShare: { low: 0.15, high: 0.4, source: 'no published lead-to-sale rate by channel; First Page Sage B2B opportunity-to-close 32–40% (via prospeo.io) is the upper anchor; an assumption until measured' },
    setupDays: { low: 2, high: 7, source: 'Google Ads policy review and learning period' },
    constraints: ['a landing page and a way to take the call or form', 'ad policy review'],
  },
  {
    key: 'paid-social-inbound',
    label: 'paid social lead forms (Meta)',
    kind: 'PAID_INBOUND',
    costPerLead: { low: 18.17, high: 41.26, source: 'WordStream Facebook benchmarks 2025 via theedigital.com: all industries $27.66, home services $30.57, home improvement $41.26, legal $18.17 a lead' },
    qualifiedShare: { low: 0.08, high: 0.3, source: 'lead-form leads convert below search leads; no published rate by channel; an assumption until measured' },
    setupDays: { low: 2, high: 5, source: 'Meta ad review and learning phase' },
    constraints: ['ad account in good standing', 'a lead form and follow-up within minutes'],
  },
  {
    key: 'marketplace-leads',
    label: 'pay-per-lead marketplace requests',
    kind: 'MARKETPLACE',
    costPerLead: { low: 25, high: 75, source: 'Thumbtack typical $25–75 a lead (superdupr.com, subger.com); Angi $15–120 shared with 3–8 pros' },
    qualifiedShare: { low: 0.05, high: 0.25, source: 'community.thumbtack.com reports 5–7% hired; 25% top of reported range' },
    setupDays: { low: 1, high: 5, source: 'profile approval' },
    constraints: ['the category must allow a broker or agency', 'freelance-marketplace operation is retired (§76): only a category Brain can deliver'],
  },
];

export interface MoneyLimits {
  beforeProof: number;
  perWeek: number;
  ceiling: number;
}

/** What the goal allows to be committed, in major units. */
export function budgetsAllowed(limits: { beforeProof: number | null; perWeek: number | null; capitalCeiling: number | null }): MoneyLimits {
  const ceiling = limits.capitalCeiling ?? limits.perWeek ?? limits.beforeProof ?? 0;
  const perWeek = Math.min(limits.perWeek ?? ceiling, ceiling);
  const beforeProof = Math.min(limits.beforeProof ?? perWeek, perWeek);
  return { beforeProof, perWeek, ceiling };
}

/** Days before money can be spent past the before-proof limit: first cash has to arrive. */
export const DAYS_TO_FIRST_PROOF: Sourced = { low: 7, high: 14, source: 'the plan\'s own fastest openings settle in about a week; a convention, not evidence' };

export interface CapacityPurchase {
  units: number;
  domains: number;
  cost: number;
  addedPerDay: { low: number; high: number };
  /** Averaged over the whole window, after setup: what the plan can count on per day. */
  effectivePerDay: { low: number; high: number };
  startDay: { low: number; high: number };
  sentence: string;
}

/**
 * The most sending capacity a budget buys, and what it yields inside the window.
 * Null when it buys none or yields nothing before the deadline.
 */
export function purchaseCapacity(lever: AcquisitionLever, budget: number, daysLeft: number, afterProof = false): CapacityPurchase | null {
  if (lever.kind !== 'SENDING_CAPACITY' || budget <= 0) return null;
  const unitsPerDomain = lever.unitsPerDomain!.low;
  const domainShare = lever.domainCost!.high / unitsPerDomain;
  const unitCost = domainShare + lever.unitMonthlyCost!.high;
  const start = { low: lever.setupDays.low + (afterProof ? DAYS_TO_FIRST_PROOF.low : 0), high: lever.setupDays.high + (afterProof ? DAYS_TO_FIRST_PROOF.high : 0) };
  const sendDays = { low: Math.max(0, daysLeft - start.high), high: Math.max(0, daysLeft - start.low) };
  if (sendDays.high <= 0) return null;
  // Contacts must be bought too: a unit's sends over the window need lists.
  const perUnitContacts = lever.sendsPerUnitDay!.high * sendDays.high;
  const perUnitAll = unitCost + perUnitContacts * lever.perContactCost!.low;
  const units = Math.floor(budget / perUnitAll);
  if (units <= 0) return null;
  const domains = Math.ceil(units / unitsPerDomain);
  const cost = domains * lever.domainCost!.high + units * lever.unitMonthlyCost!.high + units * perUnitContacts * lever.perContactCost!.low;
  const added = { low: units * lever.sendsPerUnitDay!.low, high: units * lever.sendsPerUnitDay!.high };
  const effective = { low: (added.low * sendDays.low) / Math.max(1, daysLeft), high: (added.high * sendDays.high) / Math.max(1, daysLeft) };
  return {
    units,
    domains,
    cost: Math.round(cost),
    addedPerDay: added,
    effectivePerDay: effective,
    startDay: start,
    sentence: `${units} new mailbox(es) on ${domains} domain(s) for ${'$'}${Math.round(cost)}${afterProof ? ' once first cash arrives' : ''}: +${added.low}–${added.high} sends a day from day ${start.low}–${start.high}, ${Math.round(effective.low)}–${Math.round(effective.high)} a day averaged over the ${daysLeft} days`,
  };
}

export interface InboundPurchase {
  cost: number;
  leadsPerDay: { low: number; high: number };
  qualified: { low: number; high: number };
  sentence: string;
}

export function buyInbound(lever: AcquisitionLever, budget: number, daysLeft: number, afterProof = false): InboundPurchase | null {
  if ((lever.kind !== 'PAID_INBOUND' && lever.kind !== 'MARKETPLACE') || budget <= 0) return null;
  const start = lever.setupDays.high + (afterProof ? DAYS_TO_FIRST_PROOF.high : 0);
  const days = Math.max(0, daysLeft - start);
  if (days <= 0) return null;
  const leads = { low: budget / lever.costPerLead!.high, high: budget / lever.costPerLead!.low };
  return {
    cost: Math.round(budget),
    // Averaged over the window so it composes with the engine's selling days.
    leadsPerDay: { low: leads.low / daysLeft, high: leads.high / daysLeft },
    qualified: { low: lever.qualifiedShare!.low, high: lever.qualifiedShare!.high },
    sentence: `${'$'}${Math.round(budget)} of ${lever.label}${afterProof ? ' once first cash arrives' : ''}: ${Math.round(leads.low)}–${Math.round(leads.high)} leads at ${'$'}${lever.costPerLead!.low}–${lever.costPerLead!.high} each, ${Math.round(lever.qualifiedShare!.low * 100)}–${Math.round(lever.qualifiedShare!.high * 100)}% real buyers`,
  };
}

export interface VolumePlan {
  perDay: number;
  units: { low: number; high: number };
  domains: { low: number; high: number };
  costInWindow: { low: number; high: number };
  setupDays: { low: number; high: number };
  sendingDays: { low: number; high: number };
  contacts: { low: number; high: number };
  feasible: boolean;
  reasons: string[];
  sentence: string;
}

/**
 * What a daily cold-email volume would take: units, domains, money inside the
 * window, setup, the days left to send, and whether the goal's limits and the
 * deliverability rules allow it. Neither "possible" nor "impossible" is assumed.
 */
export function dailyVolumePlan(lever: AcquisitionLever, perDay: number, daysLeft: number, limits: { beforeProof: number | null; perWeek: number | null; capitalCeiling: number | null }): VolumePlan {
  const allowed = budgetsAllowed(limits);
  const units = { low: Math.ceil(perDay / lever.sendsPerUnitDay!.high), high: Math.ceil(perDay / lever.sendsPerUnitDay!.low) };
  const domains = { low: Math.ceil(units.low / lever.unitsPerDomain!.high), high: Math.ceil(units.high / lever.unitsPerDomain!.low) };
  const setup = { low: lever.setupDays.low, high: lever.setupDays.high };
  const sendingDays = { low: Math.max(0, daysLeft - setup.high), high: Math.max(0, daysLeft - setup.low) };
  const contacts = { low: perDay * sendingDays.low, high: perDay * sendingDays.high };
  const months = Math.max(1, Math.ceil(daysLeft / 30));
  const cost = {
    low: domains.low * lever.domainCost!.low + units.low * lever.unitMonthlyCost!.low * months + lever.platformMonthly!.low * months + contacts.low * lever.perContactCost!.low,
    high: domains.high * lever.domainCost!.high + units.high * lever.unitMonthlyCost!.high * months + lever.platformMonthly!.high * months + contacts.high * lever.perContactCost!.high,
  };
  const upfront = domains.low * lever.domainCost!.low + units.low * lever.unitMonthlyCost!.low;
  const reasons: string[] = [];
  if (upfront > allowed.beforeProof) reasons.push(`its first purchase (${'$'}${Math.round(upfront)}) is over the ${'$'}${Math.round(allowed.beforeProof)} one commitment may tie up before proof`);
  if (cost.low > allowed.ceiling) reasons.push(`even at the low end it costs ${'$'}${Math.round(cost.low)} inside the window, over the ${'$'}${Math.round(allowed.ceiling)} ceiling`);
  if (sendingDays.low < 7) reasons.push(`warm-up leaves ${sendingDays.low}–${sendingDays.high} days to send, before replies, closes and payment`);
  reasons.push(...lever.constraints);
  const feasible = upfront <= allowed.beforeProof && cost.low <= allowed.ceiling && sendingDays.low >= 7;
  const r = (n: number) => Math.round(n).toLocaleString('en-US');
  return {
    perDay,
    units,
    domains,
    costInWindow: { low: Math.round(cost.low), high: Math.round(cost.high) },
    setupDays: setup,
    sendingDays,
    contacts,
    feasible,
    reasons,
    sentence:
      `${r(perDay)}/day needs ${units.low}–${units.high} mailboxes on ${domains.low}–${domains.high} domains, ${setup.low}–${setup.high} days of warm-up (leaving ${sendingDays.low}–${sendingDays.high} sending days), ` +
      `${r(contacts.low)}–${r(contacts.high)} verified contacts, and ${'$'}${r(cost.low)}–${'$'}${r(cost.high)} inside the window: ${feasible ? 'feasible under the limits' : `not feasible — ${reasons.slice(0, 3).join('; ')}`}`,
  };
}
