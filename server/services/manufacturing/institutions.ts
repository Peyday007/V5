/**
 * The institutional machinery a proposed venture needs, derived from its facts
 * and never from a checklist (program fpg_ea512f54…, INST-30).
 *
 * ---------------------------------------------------------------------------
 * What this module is, and what it refuses to be
 * ---------------------------------------------------------------------------
 *
 * A venture may need one contractor agreement, a registered business, several
 * subsidiaries, a licensed partner — or nothing at all. So nothing here starts
 * from "form a company". An element appears only when a **fact** about the
 * venture (an activity, a jurisdiction read from the record, a party, a money
 * flow, a risk exposure) or an **accepted evidence claim** triggers it, and an
 * empty set is a valid answer. No industry, category or example is named in
 * the derivation (R01-A1, invariant 48): the triggers are the shapes of the
 * facts, not what the venture sells.
 *
 * It is pure. It performs no write, creates no entity, opens no account and
 * signs nothing (invariant 38; INST-30 "must not create entities or bind the
 * owner merely because its planning model recommends doing so"). Every element
 * that would form an entity, perform a regulated service, borrow, commit the
 * owner legally or open an account is marked `REQUIRES_APPROVAL` and names the
 * external professional role that genuinely has to act.
 *
 * ---------------------------------------------------------------------------
 * The rules it holds
 * ---------------------------------------------------------------------------
 *
 * - **A cost is withheld whenever any element is unpriced** — the rule
 *   `capital.ts` holds, for its reason: a sum that steps over an unpriced
 *   element is smaller than the truth and reads as a bargain. Nothing converts
 *   a currency.
 * - **A jurisdiction is read from the record** (invariant 34). Not knowing it
 *   is an answer: it opens a question, and the question keeps legal feasibility
 *   and readiness at `UNKNOWN`.
 * - **No unknown is a favourable assumption** (invariant 39): `UNKNOWN` never
 *   makes a structure ready, and ranks exactly like `NOT_MET`.
 * - **A regulatory limitation is never a closed market.** It produces the
 *   compliant alternatives the facts admit: a licensed partner who performs
 *   the restricted activity, an agent arrangement that refers it, and obtaining
 *   the authorisation itself (which is a regulated service and needs approval).
 * - **Four readings, kept apart**: commercial desirability, legal feasibility,
 *   institutional readiness and authorisation to act. A structure can be
 *   desirable and not feasible, feasible and not ready, ready and not
 *   authorised; folding them into one score would hide which one stops it.
 */
import type { MoneyRange } from './capital.ts';
import type { ConditionAnswer } from './readiness.ts';

// ---------------------------------------------------------------------------
// Input: the venture's facts, as rows would state them
// ---------------------------------------------------------------------------

export const PARTY_ROLES = [
  'OWNER',
  'INVESTOR',
  'CUSTOMER',
  'SUPPLIER',
  'CONTRACTOR',
  'DISTRIBUTOR',
  'MANUFACTURER',
  'LICENSOR',
  'LENDER',
  'PARTNER',
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export interface VentureParty {
  id: string;
  role: PartyRole;
  /** Read from the record; null when nobody stated it. */
  jurisdiction: string | null;
  /** A contractor or partner whose work product is intellectual property. */
  createsIp?: boolean;
}

export const FLOW_KINDS = [
  'SALE',
  'PURCHASE',
  'BORROWING',
  'EQUITY_INVESTMENT',
  'ROYALTY_OUT',
  'ROYALTY_IN',
  'CUSTOMER_FUNDS_HELD',
] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export interface FinancialFlow {
  kind: FlowKind;
  /** The party on the other side, when known. */
  partyId: string | null;
}

export interface RiskExposure {
  /** Free vocabulary: the risk is named by whoever recorded it, not by this module. */
  kind: string;
}

export const CLAIM_KINDS = [
  /** A permit is required for an activity in a jurisdiction. */
  'PERMIT_REQUIRED',
  /** A licence (authorisation to perform a regulated service) is required. */
  'LICENSE_REQUIRED',
  /** A tax registration or filing obligation applies. */
  'TAX_OBLIGATION',
  /** Insurance of a kind is mandatory. */
  'INSURANCE_REQUIRED',
  /** The activity may only be performed by a holder of an authorisation. */
  'REGULATORY_LIMITATION',
  /** The activity requires a legal entity (rather than a person acting directly). */
  'ENTITY_REQUIRED',
  /** What an element costs. */
  'COST',
  /** How often an element must be renewed. */
  'RENEWAL',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface EvidenceClaim {
  id: string;
  /** The accepted source the claim resolves to (§10). */
  sourceId: string;
  kind: ClaimKind;
  /** What the claim is about: an activity, a risk kind, or an element key for COST/RENEWAL. */
  subject: string;
  jurisdiction: string | null;
  /** COST only. */
  amountLowMinor?: number | null;
  amountHighMinor?: number | null;
  currency?: string | null;
  recurrence?: 'ONE_TIME' | 'ANNUAL' | 'MONTHLY';
  /** RENEWAL only. */
  intervalMonths?: number | null;
}

export interface VentureFacts {
  ventureId: string;
  /** The activities the venture performs, in the record's own words. */
  activities: string[];
  /** Jurisdictions read from the record. Empty means nobody stated one. */
  jurisdictions: string[];
  parties: VentureParty[];
  flows: FinancialFlow[];
  risks: RiskExposure[];
  /** Intellectual property the venture creates or relies on, by name. */
  ipAssets: string[];
  claims: EvidenceClaim[];
  /** Institutions that already exist, by element key. */
  held: string[];
  /** Approvals a person has recorded, by element key. */
  approvals: string[];
  /**
   * The venture's own economics before institutions, when known. Running cost
   * and revenue are null when no row states them: the capital is still
   * adjusted, and desirability stays UNKNOWN (invariant 39).
   */
  economics: { capitalMinor: number; monthlyRunningMinor: number | null; monthlyRevenueMinor: number | null; currency: string } | null;
  /** The date renewals are computed from (ISO-8601). */
  asOf: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const ELEMENT_KINDS = [
  'LEGAL_ENTITY',
  'OWNERSHIP',
  'BENEFICIAL_INTEREST',
  'ROLE',
  'SIGNING_AUTHORITY',
  'CONTRACT',
  'PERMIT',
  'LICENSE',
  'INSURANCE',
  'PAYMENT_ACCOUNT',
  'TAX_REGISTRATION',
  'ACCOUNTING_BOOKS',
  'IP_OWNERSHIP',
  'INTERCOMPANY',
  'FINANCING_COVENANT',
  'EXTERNAL_PROVIDER',
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const APPROVAL_CLASSES = [
  'FORMATION',
  'REGULATED_SERVICE',
  'MATERIAL_BORROWING',
  'LEGAL_COMMITMENT',
  'ACCOUNT_OPENING',
] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export interface ElementCost {
  oneTime: MoneyRange | null;
  /** Annualised recurring cost. */
  annual: MoneyRange | null;
  claimIds: string[];
}

export interface InstitutionalElement {
  key: string;
  kind: ElementKind;
  subject: string;
  /** REQUIRED when a claim or a legal fact demands it; ADVISABLE when a fact makes it prudent. */
  necessity: 'REQUIRED' | 'ADVISABLE';
  /** What triggered it: fact descriptions and claim ids. Never empty. */
  triggeredBy: string[];
  /** Null means unpriced: no accepted claim states a figure. Never zero by default. */
  cost: ElementCost | null;
  prerequisites: string[];
  obligations: string[];
  /** Next renewal date, when a RENEWAL claim states an interval. */
  renewalDate: string | null;
  enables: string;
  approval: { status: 'REQUIRES_APPROVAL'; class: ApprovalClass; professionalRole: string; approved: boolean } | null;
  held: boolean;
}

export const STRUCTURE_KINDS = ['DIRECT', 'SINGLE_ENTITY', 'MULTI_ENTITY', 'LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export interface EconomicsReading {
  /** Per currency; null when any element is unpriced. */
  setupTotals: MoneyRange[] | null;
  annualTotals: MoneyRange[] | null;
  unpriced: string[];
  /** The venture's economics with institutions added; null when withheld or the currency differs. */
  adjusted: { capitalLowMinor: number; capitalHighMinor: number; monthlyRunningLowMinor: number | null; monthlyRunningHighMinor: number | null; currency: string } | null;
  because: string;
}

export interface StructureReading {
  kind: StructureKind;
  elements: InstitutionalElement[];
  desirability: ConditionAnswer;
  legalFeasibility: ConditionAnswer;
  readiness: ConditionAnswer;
  authorization: ConditionAnswer;
  economics: EconomicsReading;
  /** Why each reading is what it is. */
  because: string[];
}

export interface InstitutionalDerivation {
  ventureId: string;
  /** Every structure the facts admit, best first. Never empty. */
  structures: StructureReading[];
  /** Facts nobody has stated that the answer depends on. */
  openQuestions: string[];
  /** For every regulatory limitation, the compliant alternatives generated for it. */
  limitations: Array<{ claimId: string; activity: string; alternatives: StructureKind[] }>;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const ENABLES: Record<ElementKind, string> = {
  LEGAL_ENTITY: 'contracting, holding assets and accounts, and limiting liability in a name other than the owner\'s',
  OWNERSHIP: 'a recorded owner who can receive distributions and decide for the entity',
  BENEFICIAL_INTEREST: 'beneficial-ownership disclosures banks and registers require before an account or filing',
  ROLE: 'an accountable office-holder the entity can act through',
  SIGNING_AUTHORITY: 'binding the venture to a counterparty, once a person approves the commitment',
  CONTRACT: 'a defined relationship with the counterparty: price, delivery, rights and remedies',
  PERMIT: 'performing the permitted activity lawfully where the permit applies',
  LICENSE: 'performing the regulated service itself rather than through a holder',
  INSURANCE: 'transferring the named risk, and meeting counterparties who require cover',
  PAYMENT_ACCOUNT: 'receiving and paying money in the venture\'s name',
  TAX_REGISTRATION: 'invoicing and filing where the obligation applies',
  ACCOUNTING_BOOKS: 'a measured result, filings and any lender or investor reporting',
  IP_OWNERSHIP: 'exploiting, licensing or selling the work product without a third party\'s consent',
  INTERCOMPANY: 'moving goods, services or money between the venture\'s own entities on recorded terms',
  FINANCING_COVENANT: 'drawing the borrowed money while its conditions hold',
  EXTERNAL_PROVIDER: 'the act only that professional may perform',
};

interface Draft {
  kind: ElementKind;
  subject: string;
  necessity: 'REQUIRED' | 'ADVISABLE';
  triggeredBy: string[];
  prerequisites?: string[];
  obligations?: string[];
  approval?: { class: ApprovalClass; professionalRole: string };
  jurisdiction?: string | null;
}

const keyOf = (kind: ElementKind, subject: string): string => `${kind}:${subject}`;

const COUNTERPARTY_ROLES: ReadonlySet<PartyRole> = new Set(['CUSTOMER', 'SUPPLIER', 'CONTRACTOR', 'DISTRIBUTOR', 'MANUFACTURER', 'LICENSOR', 'LENDER', 'PARTNER']);

function jurisdictionsOf(facts: VentureFacts): string[] {
  const all = new Set<string>(facts.jurisdictions);
  for (const party of facts.parties) if (party.role === 'OWNER' && party.jurisdiction) all.add(party.jurisdiction);
  return [...all].sort();
}

/** The elements the facts trigger whatever the structure. */
function baseDrafts(facts: VentureFacts, holder: string): Draft[] {
  const out: Draft[] = [];
  for (const party of facts.parties) {
    if (!COUNTERPARTY_ROLES.has(party.role)) continue;
    out.push({
      kind: 'CONTRACT',
      subject: `${party.role.toLowerCase()} ${party.id}`,
      necessity: 'ADVISABLE',
      triggeredBy: [`party ${party.id} (${party.role})`],
      prerequisites: [keyOf('SIGNING_AUTHORITY', holder)],
      obligations: ['perform and monitor the agreed terms'],
      approval: { class: 'LEGAL_COMMITMENT', professionalRole: `a lawyer admitted in ${party.jurisdiction ?? 'the governing jurisdiction (not yet stated)'}` },
    });
    if (party.createsIp) {
      out.push({
        kind: 'IP_OWNERSHIP',
        subject: `work product of ${party.id}`,
        necessity: 'REQUIRED',
        triggeredBy: [`party ${party.id} creates intellectual property`],
        prerequisites: [keyOf('CONTRACT', `${party.role.toLowerCase()} ${party.id}`)],
        obligations: ['keep the assignment or licence on record'],
      });
    }
  }
  for (const asset of facts.ipAssets) {
    out.push({ kind: 'IP_OWNERSHIP', subject: asset, necessity: 'ADVISABLE', triggeredBy: [`intellectual property ${asset}`], obligations: ['maintain registrations and record the chain of title'] });
  }
  if (out.some((one) => one.kind === 'CONTRACT')) {
    out.push({ kind: 'SIGNING_AUTHORITY', subject: holder, necessity: 'REQUIRED', triggeredBy: ['the venture has counterparties to contract with'] });
  }
  const moving = facts.flows.length > 0;
  if (moving) {
    out.push({
      kind: 'PAYMENT_ACCOUNT',
      subject: holder,
      necessity: 'ADVISABLE',
      triggeredBy: facts.flows.map((one) => `flow ${one.kind}`),
      prerequisites: holder === 'owner' ? [] : [keyOf('LEGAL_ENTITY', holder), keyOf('BENEFICIAL_INTEREST', holder)],
      approval: { class: 'ACCOUNT_OPENING', professionalRole: 'the bank or payment provider\'s onboarding and compliance review' },
    });
    out.push({ kind: 'ACCOUNTING_BOOKS', subject: holder, necessity: 'ADVISABLE', triggeredBy: ['the venture moves money'], obligations: ['record every transaction', 'close the books each period'] });
  }
  for (const flow of facts.flows) {
    if (flow.kind === 'BORROWING') {
      out.push({
        kind: 'FINANCING_COVENANT',
        subject: `borrowing${flow.partyId ? ` from ${flow.partyId}` : ''}`,
        necessity: 'REQUIRED',
        triggeredBy: ['flow BORROWING'],
        obligations: ['meet repayment and reporting covenants'],
        approval: { class: 'MATERIAL_BORROWING', professionalRole: 'the lender, with counsel reviewing the facility' },
      });
    }
    if (flow.kind === 'CUSTOMER_FUNDS_HELD') {
      out.push({ kind: 'ACCOUNTING_BOOKS', subject: 'segregated customer funds', necessity: 'ADVISABLE', triggeredBy: ['flow CUSTOMER_FUNDS_HELD'], obligations: ['reconcile held funds separately'] });
    }
  }
  for (const risk of facts.risks) {
    out.push({ kind: 'INSURANCE', subject: risk.kind, necessity: 'ADVISABLE', triggeredBy: [`risk ${risk.kind}`], obligations: ['renew cover and report claims'] });
  }
  for (const claim of facts.claims) {
    const where = claim.jurisdiction ?? 'the stated jurisdiction';
    if (claim.kind === 'PERMIT_REQUIRED') {
      out.push({ kind: 'PERMIT', subject: claim.subject, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], obligations: ['keep the permit current'], approval: { class: 'REGULATED_SERVICE', professionalRole: `the permitting authority in ${where}` }, jurisdiction: claim.jurisdiction });
    } else if (claim.kind === 'TAX_OBLIGATION') {
      out.push({ kind: 'TAX_REGISTRATION', subject: claim.subject, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], obligations: ['file and pay on the stated schedule'], jurisdiction: claim.jurisdiction });
    } else if (claim.kind === 'INSURANCE_REQUIRED') {
      out.push({ kind: 'INSURANCE', subject: claim.subject, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], obligations: ['maintain the mandatory cover'] });
    } else if (claim.kind === 'LICENSE_REQUIRED') {
      out.push({ kind: 'LICENSE', subject: claim.subject, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], obligations: ['meet the licence conditions and report to the regulator'], approval: { class: 'REGULATED_SERVICE', professionalRole: `the licensing regulator in ${where}, with compliance counsel` }, jurisdiction: claim.jurisdiction });
    }
  }
  return out;
}

function entityDrafts(facts: VentureFacts, entity: string, jurisdiction: string | null, why: string[]): Draft[] {
  const owners = facts.parties.filter((one) => one.role === 'OWNER' || one.role === 'INVESTOR');
  const out: Draft[] = [
    {
      kind: 'LEGAL_ENTITY',
      subject: entity,
      necessity: why.length > 0 ? 'REQUIRED' : 'ADVISABLE',
      triggeredBy: why.length > 0 ? why : ['separating the venture from the owner'],
      obligations: ['annual filings', 'keep a registered address and records'],
      approval: { class: 'FORMATION', professionalRole: `a formation agent or lawyer in ${jurisdiction ?? 'a jurisdiction not yet stated'}` },
      jurisdiction,
    },
    { kind: 'ROLE', subject: `officer of ${entity}`, necessity: 'REQUIRED', triggeredBy: [`entity ${entity}`], prerequisites: [keyOf('LEGAL_ENTITY', entity)], obligations: ['act within the entity\'s governance'] },
  ];
  for (const owner of owners) {
    out.push({ kind: 'OWNERSHIP', subject: `${owner.id} in ${entity}`, necessity: 'REQUIRED', triggeredBy: [`party ${owner.id} (${owner.role})`], prerequisites: [keyOf('LEGAL_ENTITY', entity)] });
  }
  if (owners.length > 0) {
    out.push({ kind: 'BENEFICIAL_INTEREST', subject: entity, necessity: 'REQUIRED', triggeredBy: owners.map((one) => `party ${one.id} holds an interest`), prerequisites: [keyOf('LEGAL_ENTITY', entity)], obligations: ['keep the beneficial-ownership register current'] });
  }
  return out;
}

function providerDrafts(drafts: Draft[]): Draft[] {
  const roles = new Map<string, string[]>();
  for (const one of drafts) {
    if (!one.approval) continue;
    const list = roles.get(one.approval.professionalRole) ?? [];
    list.push(keyOf(one.kind, one.subject));
    roles.set(one.approval.professionalRole, list);
  }
  return [...roles.entries()].map(([role, keys]) => ({ kind: 'EXTERNAL_PROVIDER' as const, subject: role, necessity: 'REQUIRED' as const, triggeredBy: keys }));
}

function sameMatch(claim: EvidenceClaim, kind: ElementKind, subject: string): boolean {
  return claim.subject === keyOf(kind, subject) || claim.subject === kind;
}

function addMonths(iso: string, months: number): string {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function finish(drafts: Draft[], facts: VentureFacts): InstitutionalElement[] {
  const seen = new Map<string, InstitutionalElement>();
  for (const draft of drafts) {
    const key = keyOf(draft.kind, draft.subject);
    const existing = seen.get(key);
    if (existing) {
      existing.triggeredBy = [...new Set([...existing.triggeredBy, ...draft.triggeredBy])];
      if (draft.necessity === 'REQUIRED') existing.necessity = 'REQUIRED';
      continue;
    }
    const costs = facts.claims.filter((one) => one.kind === 'COST' && sameMatch(one, draft.kind, draft.subject) && one.amountLowMinor != null && one.amountHighMinor != null && one.currency);
    let cost: ElementCost | null = null;
    if (costs.length > 0) {
      const range = (filter: (c: EvidenceClaim) => boolean, factor: (c: EvidenceClaim) => number): MoneyRange | null => {
        const mine = costs.filter(filter);
        if (mine.length === 0) return null;
        const currency = mine[0]!.currency!;
        if (mine.some((one) => one.currency !== currency)) return null;
        return {
          currency,
          lowMinor: mine.reduce((sum, one) => sum + one.amountLowMinor! * factor(one), 0),
          highMinor: mine.reduce((sum, one) => sum + one.amountHighMinor! * factor(one), 0),
        };
      };
      cost = {
        oneTime: range((one) => (one.recurrence ?? 'ONE_TIME') === 'ONE_TIME', () => 1),
        annual: range((one) => one.recurrence === 'ANNUAL' || one.recurrence === 'MONTHLY', (one) => (one.recurrence === 'MONTHLY' ? 12 : 1)),
        claimIds: costs.map((one) => one.id),
      };
    }
    const renewal = facts.claims.find((one) => one.kind === 'RENEWAL' && sameMatch(one, draft.kind, draft.subject) && one.intervalMonths);
    seen.set(key, {
      key,
      kind: draft.kind,
      subject: draft.subject,
      necessity: draft.necessity,
      triggeredBy: draft.triggeredBy,
      cost,
      prerequisites: draft.prerequisites ?? [],
      obligations: draft.obligations ?? [],
      renewalDate: renewal ? addMonths(facts.asOf, renewal.intervalMonths!) : null,
      enables: ENABLES[draft.kind],
      approval: draft.approval ? { status: 'REQUIRES_APPROVAL', ...draft.approval, approved: facts.approvals.includes(key) } : null,
      held: facts.held.includes(key),
    });
  }
  /*
   * A permitting authority is paid through the permit's own fee. When every
   * element an authority acts on is a permit priced by a sourced figure, the
   * authority adds nothing further, and that is a sourced answer (the permit's
   * claims) rather than a blank read as zero. Any other professional — a
   * lawyer, a formation agent, a bank's onboarding — stays unpriced until a
   * row prices it.
   */
  for (const element of seen.values()) {
    if (element.kind !== 'EXTERNAL_PROVIDER' || element.cost !== null) continue;
    const acted = element.triggeredBy.map((key) => seen.get(key));
    if (acted.length === 0 || acted.some((one) => !one || one.kind !== 'PERMIT' || one.cost === null || one.approval?.professionalRole !== element.subject)) continue;
    element.cost = { oneTime: null, annual: null, claimIds: [...new Set(acted.flatMap((one) => one!.cost!.claimIds))] };
  }
  return [...seen.values()];
}

function sumRanges(ranges: MoneyRange[]): MoneyRange[] {
  const by = new Map<string, MoneyRange>();
  for (const one of ranges) {
    const into = by.get(one.currency) ?? { currency: one.currency, lowMinor: 0, highMinor: 0 };
    into.lowMinor += one.lowMinor;
    into.highMinor += one.highMinor;
    by.set(one.currency, into);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Institutional cost added to the venture's own economics, withheld when anything is unpriced. */
export function readEconomics(elements: InstitutionalElement[], economics: VentureFacts['economics']): EconomicsReading {
  // An element already held costs nothing further to set up, but still carries its recurring cost.
  const unpriced = elements.filter((one) => one.cost === null && !one.held).map((one) => one.key).sort();
  if (unpriced.length > 0) {
    return { setupTotals: null, annualTotals: null, unpriced, adjusted: null, because: `Withheld: ${unpriced.length} element(s) have no sourced figure (${unpriced.join(', ')}).` };
  }
  const setupTotals = sumRanges(elements.filter((one) => !one.held).flatMap((one) => (one.cost?.oneTime ? [one.cost.oneTime] : [])));
  const annualTotals = sumRanges(elements.flatMap((one) => (one.cost?.annual ? [one.cost.annual] : [])));
  if (!economics) {
    return { setupTotals, annualTotals, unpriced, adjusted: null, because: 'Institutional costs are priced; the venture\'s own economics are not recorded, so nothing was adjusted.' };
  }
  const currencies = new Set([...setupTotals, ...annualTotals].map((one) => one.currency));
  if ([...currencies].some((one) => one !== economics.currency)) {
    return { setupTotals, annualTotals, unpriced, adjusted: null, because: `Institutional costs are in ${[...currencies].join(', ')} and the venture in ${economics.currency}; no rate is recorded, so nothing was converted.` };
  }
  const setup = setupTotals[0] ?? { currency: economics.currency, lowMinor: 0, highMinor: 0 };
  const annual = annualTotals[0] ?? { currency: economics.currency, lowMinor: 0, highMinor: 0 };
  const adjusted = {
    capitalLowMinor: economics.capitalMinor + setup.lowMinor,
    capitalHighMinor: economics.capitalMinor + setup.highMinor,
    monthlyRunningLowMinor: economics.monthlyRunningMinor === null ? null : economics.monthlyRunningMinor + Math.round(annual.lowMinor / 12),
    monthlyRunningHighMinor: economics.monthlyRunningMinor === null ? null : economics.monthlyRunningMinor + Math.round(annual.highMinor / 12),
    currency: economics.currency,
  };
  return {
    setupTotals,
    annualTotals,
    unpriced,
    adjusted,
    because:
      economics.monthlyRunningMinor === null
        ? 'Institutional setup added to capital; the venture\'s running cost is not recorded, so recurring cost was not added to it.'
        : 'Institutional setup added to capital and recurring cost added to monthly running cost.',
  };
}

function readStructure(kind: StructureKind, drafts: Draft[], facts: VentureFacts, openQuestions: string[], infeasible: string[]): StructureReading {
  const elements = finish([...drafts, ...providerDrafts(drafts)], facts);
  const economics = readEconomics(elements, facts.economics);
  const because: string[] = [];

  let legalFeasibility: ConditionAnswer;
  if (infeasible.length > 0) {
    legalFeasibility = 'NOT_MET';
    because.push(`Not legally feasible: ${infeasible.join('; ')}.`);
  } else if (openQuestions.length > 0) {
    legalFeasibility = 'UNKNOWN';
    because.push(`Legal feasibility unknown until answered: ${openQuestions.join('; ')}.`);
  } else {
    legalFeasibility = 'MET';
    because.push('No accepted claim or stated fact makes this structure unlawful.');
  }

  const missing = elements.filter((one) => !one.held);
  let readiness: ConditionAnswer;
  if (missing.length > 0) {
    readiness = 'NOT_MET';
    because.push(`Not ready: ${missing.length} element(s) do not exist yet.`);
  } else if (openQuestions.length > 0) {
    readiness = 'UNKNOWN';
    because.push('Every derived element exists, but an open question may add more.');
  } else {
    readiness = 'MET';
    because.push(elements.length === 0 ? 'Nothing institutional is required.' : 'Every derived element exists.');
  }

  const unapproved = elements.filter((one) => one.approval && !one.approval.approved);
  const authorization: ConditionAnswer = unapproved.length === 0 ? 'MET' : 'NOT_MET';
  because.push(authorization === 'MET' ? 'No step requires an approval that has not been recorded.' : `Not authorised: ${unapproved.map((one) => one.key).join(', ')} require a person's approval.`);

  let desirability: ConditionAnswer = 'UNKNOWN';
  const adjusted = economics.adjusted;
  if (adjusted && facts.economics && facts.economics.monthlyRevenueMinor !== null && adjusted.monthlyRunningHighMinor !== null) {
    desirability = facts.economics.monthlyRevenueMinor > adjusted.monthlyRunningHighMinor ? 'MET' : 'NOT_MET';
    because.push(desirability === 'MET' ? 'Revenue covers running cost after institutional costs.' : 'Revenue does not cover running cost once institutional costs are added.');
  } else if (adjusted) {
    because.push(`Desirability unknown: the venture's revenue or running cost is not recorded (${economics.because})`);
  } else {
    because.push(`Desirability unknown: ${economics.because}`);
  }

  return { kind, elements, desirability, legalFeasibility, readiness, authorization, economics, because };
}

/** MET counts; UNKNOWN ranks exactly like NOT_MET (invariant 39). */
const score = (answer: ConditionAnswer): number => (answer === 'MET' ? 1 : 0);

function rank(a: StructureReading, b: StructureReading): number {
  const order: Array<keyof Pick<StructureReading, 'legalFeasibility' | 'desirability' | 'readiness' | 'authorization'>> = ['legalFeasibility', 'desirability', 'readiness', 'authorization'];
  for (const field of order) {
    const diff = score(b[field]) - score(a[field]);
    if (diff !== 0) return diff;
  }
  // A fully priced structure ranks above one with a blank; then the one needing less machinery.
  const blanks = Number(a.economics.unpriced.length > 0) - Number(b.economics.unpriced.length > 0);
  if (blanks !== 0) return blanks;
  const missing = a.elements.filter((one) => !one.held).length - b.elements.filter((one) => !one.held).length;
  if (missing !== 0) return missing;
  return STRUCTURE_KINDS.indexOf(a.kind) - STRUCTURE_KINDS.indexOf(b.kind);
}

/**
 * Derive the institutional machinery a venture's facts call for, and every
 * structure they admit. Pure: no row is written and nothing is created.
 */
export function deriveInstitutions(facts: VentureFacts): InstitutionalDerivation {
  const jurisdictions = jurisdictionsOf(facts);
  const openQuestions: string[] = [];
  if (jurisdictions.length === 0) openQuestions.push('no jurisdiction is stated in the record');
  if (jurisdictions.length === 0 && facts.flows.some((one) => one.kind === 'SALE' || one.kind === 'ROYALTY_IN')) {
    openQuestions.push('which tax obligations apply to the venture\'s revenue');
  }

  const owners = facts.parties.filter((one) => one.role === 'OWNER');
  const entityReasons: string[] = [];
  if (owners.length > 1) entityReasons.push(`${owners.length} owners share the venture`);
  if (facts.flows.some((one) => one.kind === 'EQUITY_INVESTMENT')) entityReasons.push('an investor takes equity');
  for (const claim of facts.claims.filter((one) => one.kind === 'ENTITY_REQUIRED')) entityReasons.push(`claim ${claim.id}`);
  const limitations = facts.claims.filter((one) => one.kind === 'REGULATORY_LIMITATION');
  const licensedFor = new Set(facts.claims.filter((one) => one.kind === 'LICENSE_REQUIRED').map((one) => one.subject));

  const home = jurisdictions[0] ?? null;
  const structures: StructureReading[] = [];
  const limitationBlocks = limitations.map((one) => `claim ${one.id}: ${one.subject} may only be performed by an authorisation holder`);

  // DIRECT: the owner acts in their own name.
  structures.push(
    readStructure('DIRECT', baseDrafts(facts, 'owner'), facts, openQuestions, [
      ...(entityReasons.length > 0 ? [`a legal entity is required (${entityReasons.join('; ')})`] : []),
      ...limitationBlocks,
    ]),
  );

  // SINGLE_ENTITY: one new entity holds the venture.
  structures.push(
    readStructure('SINGLE_ENTITY', [...entityDrafts(facts, 'venture entity', home, entityReasons), ...baseDrafts(facts, 'venture entity')], facts, openQuestions, limitationBlocks),
  );

  // MULTI_ENTITY: only where the record states more than one jurisdiction.
  if (jurisdictions.length > 1) {
    const drafts: Draft[] = [...entityDrafts(facts, `entity in ${home}`, home, entityReasons), ...baseDrafts(facts, `entity in ${home}`)];
    for (const other of jurisdictions.slice(1)) {
      drafts.push(...entityDrafts(facts, `subsidiary in ${other}`, other, [`operations stated in ${other}`]));
      drafts.push({ kind: 'INTERCOMPANY', subject: `${home} ↔ ${other}`, necessity: 'REQUIRED', triggeredBy: [`entities in ${home} and ${other}`], prerequisites: [keyOf('LEGAL_ENTITY', `subsidiary in ${other}`)], obligations: ['price and document intercompany dealings'], approval: { class: 'LEGAL_COMMITMENT', professionalRole: `tax counsel covering ${home} and ${other}` } });
    }
    structures.push(readStructure('MULTI_ENTITY', drafts, facts, openQuestions, limitationBlocks));
  }

  // A regulatory limitation produces compliant alternatives, never a closed market.
  const generated: InstitutionalDerivation['limitations'] = [];
  if (limitations.length > 0) {
    const holder = entityReasons.length > 0 ? 'venture entity' : 'owner';
    const prefix = (): Draft[] => (holder === 'owner' ? [] : entityDrafts(facts, holder, home, entityReasons));
    const partner: Draft[] = [...prefix(), ...baseDrafts(facts, holder)];
    const agent: Draft[] = [...prefix(), ...baseDrafts(facts, holder)];
    const own: Draft[] = [...prefix(), ...baseDrafts(facts, holder)];
    for (const claim of limitations) {
      const where = claim.jurisdiction ?? home ?? 'the stated jurisdiction';
      partner.push({ kind: 'CONTRACT', subject: `licensed partner performing ${claim.subject}`, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], prerequisites: [keyOf('SIGNING_AUTHORITY', holder)], obligations: ['monitor the partner\'s authorisation stays current'], approval: { class: 'LEGAL_COMMITMENT', professionalRole: `a lawyer admitted in ${where}` } });
      agent.push({ kind: 'CONTRACT', subject: `agent referral of ${claim.subject} to an authorised provider`, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], prerequisites: [keyOf('SIGNING_AUTHORITY', holder)], obligations: ['stay within the referral the provider\'s authorisation permits'], approval: { class: 'LEGAL_COMMITMENT', professionalRole: `a lawyer admitted in ${where}` } });
      if (!licensedFor.has(claim.subject)) {
        own.push({ kind: 'LICENSE', subject: claim.subject, necessity: 'REQUIRED', triggeredBy: [`claim ${claim.id}`], obligations: ['meet the licence conditions and report to the regulator'], approval: { class: 'REGULATED_SERVICE', professionalRole: `the licensing regulator in ${where}, with compliance counsel` }, jurisdiction: claim.jurisdiction });
      }
    }
    for (const drafts of [partner, agent]) {
      if (!drafts.some((one) => one.kind === 'SIGNING_AUTHORITY')) drafts.push({ kind: 'SIGNING_AUTHORITY', subject: holder, necessity: 'REQUIRED', triggeredBy: ['the venture contracts with an authorised counterparty'] });
    }
    structures.push(readStructure('LICENSED_PARTNER', partner, facts, openQuestions, []));
    structures.push(readStructure('AGENT_REFERRAL', agent, facts, openQuestions, []));
    structures.push(readStructure('OWN_AUTHORISATION', own, facts, openQuestions, []));
    for (const claim of limitations) generated.push({ claimId: claim.id, activity: claim.subject, alternatives: ['LICENSED_PARTNER', 'AGENT_REFERRAL', 'OWN_AUTHORISATION'] });
  }

  structures.sort(rank);
  return { ventureId: facts.ventureId, structures, openQuestions, limitations: generated };
}
