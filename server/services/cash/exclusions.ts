/**
 * What a goal's owner said to leave out, read from their own words (§82).
 *
 * "Avoid government contracts" is an instruction about which openings a goal
 * may rely on, and it was written in exactly two places a person writes: the
 * goal's own text and the sprint's operator additions. Neither is a list, so
 * the instruction is read the way the conversation gate already reads one:
 * a class is excluded only when one of its trigger words sits in a clause a
 * negator governs ("avoid", "without", "do not", "leave out", "exclude",
 * "no …"). Mentioning a class is not excluding it — *"subcontract work that
 * government buyers pay for"* excludes nothing.
 *
 * The vocabulary is closed and small on purpose. A class is added when a person
 * has asked to leave something out and the existing words cannot say it; each
 * says what text it recognises in an opening, so an exclusion applies to rows
 * by matching, never by a model deciding what a person meant.
 */
import { clauseBefore, NEGATORS } from '../russell/negation.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { getDb } from '../../db/database.ts';
import { listCapitalFor, listCapitalForProject, listConstraintsForProject } from '../../repos/industry.ts';
import type { CapitalStructure, OpportunityConstraint } from '../../domain/types.ts';
// Registers the production probe r01.com-13-5 wherever the role reader is loaded; the probe imports this module back, which is safe because it only uses it at call time.
import './regulatedRoleProbe.ts';

export const EXCLUSION_CLASSES = {
  GOVERNMENT_CONTRACTING: {
    label: 'government and public-sector contracts',
    triggers: /\b(?:government|federal|public[- ]sector|public procurement|state agenc(?:y|ies)|municipal)\b/i,
    /*
     * A place name is not a public buyer. "City of", "department of", "bureau
     * of" and a bare "procurement" matched consumer and business openings that
     * merely named a city or a corporate procurement team (2026-11-07), so they
     * count only beside a public body or a public buying word.
     */
    /*
     * A county or city department is a public buyer even with no buying word
     * beside it. Production, 2026-11-07: the industry map held "county
     * forestry/parks department (standing-timber purchaser via sealed bid)" as a
     * buyer type, construction paired it with Brain's deliverables, and a
     * research round was queued to confirm that county parks departments buy
     * spreadsheets — for a goal that excludes public-sector work.
     */
    matches: /\b(?:government|federal|sam\.gov|public[- ]sector|public procurement|government procurement|solicitation|rfp|rfq|rfi|tender|state agenc(?:y|ies)|municipal|county (?:commission|board|government)|county[a-z ,&/'-]{0,40}\b(?:department|dept|office|agency|commission|board)|(?:forest(?:ry)?|parks?|recreation|public works|sheriff'?s?|assessor'?s?|treasurer'?s?)(?: ?(?:and|&|\/) ?(?:forest(?:ry)?|parks?|recreation))? (?:department|dept|office|division)|department of (?:parks|forestry|public works|natural resources)|city council|public works|city of [a-z .'-]{2,30}(?:council|contracts?|bids?|purchasing|procurement)|department of (?:agriculture|defen[cs]e|education|transportation|health|labor|commerce|energy|the interior|justice|state|the treasury|veterans|homeland|housing|environmental|natural resources|corrections)|commonwealth of (?:pennsylvania|massachusetts|virginia|kentucky)|navy|army|air force|veterans affairs|bureau of (?:land|indian|reclamation|prisons|abandoned|labor|the census)|school district|public school|rfpmart|publicsurplus|govdeals|bidnet|[a-z0-9-]+\.gov|[a-z0-9-]+\.mil)\b/i,
  },
  WEBSITE_REPAIR: {
    label: 'broken-website and website-repair plays',
    triggers: /\b(?:broken[- ]website|website[- ](?:repair|fix)|broken site)/i,
    matches: /\b(?:broken (?:web)?site|website (?:repair|fix|rebuild|redesign)|fix(?:ing)? (?:their|the|a) (?:web)?site|dead links?|site (?:is )?down|outdated website)\b/i,
  },
  /*
   * Added 2026-11-02: the owner's $10K assignment says "no high-priced domain
   * speculation", and the first market tests the ladder named were domain resales
   * (dujo.com, vjn.com listed on Afternic, appraised by Appraise.net).
   */
  DOMAIN_SPECULATION: {
    label: 'domain-name speculation and resale',
    triggers: /\b(?:domain(?:[- ]name)?s? ?(?:speculation|flipping|flips?|investing|investments?|resale|trading)|high[- ]priced domains?)\b/i,
    matches: /\b(?:afternic|sedo|dan\.com|namejet|godaddy auctions?|appraise\.net|domain[- ]name aftermarket|domain aftermarket|domain (?:name )?(?:for sale|appraisal|brokerage|broker|resale|flip(?:ping)?)|[a-z0-9-]+\.(?:com|net|org|io|ai|co) (?:is )?(?:listed|for sale|valued|appraised))\b/i,
  },
} as const satisfies Record<string, { label: string; triggers: RegExp; matches: RegExp }>;
export type ExclusionClass = keyof typeof EXCLUSION_CLASSES;
export const EXCLUSION_KEYS = Object.keys(EXCLUSION_CLASSES) as ExclusionClass[];

/** Negators this reader adds to the shared ones: an exclusion only ever removes, so a wider net costs a narrower search, never a wrong action. */
const EXCLUDING = /\b(?:exclude|excluding|leave out|leaving out|no|not|skip|steer clear of|stay away from|other than)\b/i;

/** The classes a person's text excludes. */
export function exclusionsIn(text: string | null | undefined): ExclusionClass[] {
  if (!text) return [];
  const out = new Set<ExclusionClass>();
  for (const key of EXCLUSION_KEYS) {
    const pattern = new RegExp(EXCLUSION_CLASSES[key].triggers.source, 'gi');
    for (const hit of text.matchAll(pattern)) {
      const clause = clauseBefore(text, hit.index ?? 0);
      if (NEGATORS.test(clause) || EXCLUDING.test(clause)) out.add(key);
    }
  }
  return EXCLUSION_KEYS.filter((key) => out.has(key));
}

/** The first excluded class some text falls in, or null. */
export function excludedBy(text: string | null | undefined, classes: readonly ExclusionClass[]): ExclusionClass | null {
  if (!text) return null;
  return classes.find((key) => EXCLUSION_CLASSES[key].matches.test(text)) ?? null;
}

/** The classes any live goal in a project excludes, for project-wide discovery questions. */
export function unionOf(goals: ReadonlyArray<{ exclusions: readonly ExclusionClass[] }>): ExclusionClass[] {
  const all = new Set(goals.flatMap((one) => one.exclusions));
  return EXCLUSION_KEYS.filter((key) => all.has(key));
}

/** A sentence for a research question, naming what to leave out. */
export function exclusionSentence(classes: readonly ExclusionClass[]): string {
  if (classes.length === 0) return '';
  return ` Leave out ${classes.map((key) => EXCLUSION_CLASSES[key].label).join(' and ')}: the goal's owner excluded them.`;
}

/**
 * The classes a goal excludes: its own words, and the sprint's operator
 * additions for the project its ledger counts in. Both are text a person wrote.
 */
export async function goalExclusions(goal: { title: string; intent: string; outcome: string | null; target: { projectId: string; resources?: string | null } | null }): Promise<ExclusionClass[]> {
  const parts = [goal.title, goal.intent, goal.outcome ?? '', goal.target?.resources ?? ''];
  if (goal.target?.projectId) {
    // A goal read of a project is where its openings' economics are about to be weighed: every regulated
    // role held back for want of a position is sent to find one first (S-0106), and a failure to raise it
    // never changes what the goal excludes.
    await seekCompliantPositionsAtMostEvery(goal.target.projectId).catch(() => undefined);
    const mode = await getCashMode(goal.target.projectId);
    // The whole stored objective: the canonical mandate excludes nothing, and the operator's additions follow it.
    if (mode) parts.push(mode.objective);
  }
  return exclusionsIn(parts.filter(Boolean).join('\n'));
}

/*
 * Regulated roles (COM-13-5, S-0106).
 *
 * A regulated industry is never an exclusion class: mortgage, insurance,
 * manufacturing, subcontracting, deposits, consumer protection and advertising
 * are not in EXCLUSION_CLASSES and no word here removes one by name. What is
 * regulated is a *role* — an activity somebody performs — and a role is judged by
 * what it must hold: product, location, licensing and contract. Economics for a
 * role are counted only once a compliant position exists, which may be an
 * authorized licensed partner's. A fact the record does not hold is "unknown",
 * never assumed either way (§34, §39).
 */

/** The rights a regulated activity can require. Open to extension; no industry is a whitelist or a blacklist. */
export const ROLE_REQUIREMENTS = ['product', 'location', 'licensing', 'contract'] as const;
export type RoleRequirement = (typeof ROLE_REQUIREMENTS)[number];

/** Activities whose legality depends on rights and obligations. Matched against what is done, never against the label a role is given. */
export const REGULATED_ACTIVITIES = {
  EARN_COMMISSION: /\b(?:commissions?|finder'?s fees?|referral (?:fees?|payments?)|revenue share)\b/i,
  ORIGINATE: /\b(?:originat(?:e|es|ing|ion)|underwrit(?:e|es|ing)|issue (?:a )?polic(?:y|ies)|lend(?:ing)?)\b/i,
  ADVISE: /\b(?:advis(?:e|es|ing)|recommend(?:s|ing)? (?:a )?(?:product|policy|loan|plan)|suitability)\b/i,
  // A broker of something regulated, not the bare word: "data broker" or "stock broker photo" says nothing about rights held.
  BROKER: /\b(?:(?:insurance|mortgage|loan|real[- ]estate|securities|investment|freight|customs|ticket) brok(?:er|ers|ering|erage)|brok(?:er|ers|ering) (?:a |an |the )?(?:[a-z-]+ ){0,2}(?:loans?|polic(?:y|ies)|insurance|mortgages?|sale of|deals?)|arrang(?:e|es|ing) (?:a |the )?(?:loan|polic(?:y|ies)|sale))\b/i,
  // Advertising is regulated by what is advertised and to whom, so it counts beside a consumer or a regulated product, not on its own.
  SOLICIT: /\b(?:solicit(?:s|ing|ation)?|cold (?:call|email|text)s?|marketing (?:to|of) consumers|(?:advertis(?:e|es|ing)|market(?:s|ing)?) (?:[a-z-]+ ){0,3}(?:to (?:consumers|the public|retail (?:customers|buyers))|(?:insurance|loans?|mortgages?|investments?|securities|credit|supplements?|medical|health) ))/i,
  // Money held for someone, not the word: "mineral deposits" and "sediment deposits" hold nothing for anybody.
  HOLD_DEPOSITS: /\b(?:(?:customer|client|buyer|security|earnest[- ]money|down|advance|prepaid|refundable|booking) deposits?|(?:takes?|taking|collects?|collecting|holds?|holding|accepts?|accepting) (?:a |the |an )?(?:[a-z-]+ ){0,2}deposits?|escrow|hold(?:s|ing)? (?:customer )?funds)\b/i,
  // Making or subcontracting the making of goods for sale, not any mention of a manufacturer or of a subcontractor doing other work.
  MANUFACTURE: /\b(?:manufactur(?:e|es|ing) (?:and sell(?:s|ing)?|for (?:sale|consumers|retail)|(?:a |the |our |its |own )?(?:products?|goods|devices?|supplements?|foods?|cosmetics?|toys?))|subcontract(?:s|ing)? (?:the )?(?:manufactur(?:e|ing)|production|fabrication|assembly)|private[- ]label)\b/i,
  CONSUMER_FACING: /\b(?:consumer protection|consumer (?:sales|credit|lending)|retail customers?)\b/i,
  /* Selling or placing a financial or insurance product, and sending borrowers or policyholders to someone who does. */
  SELL_PRODUCT: /\b(?:sell(?:s|ing)?|offer(?:s|ing)?|plac(?:e|es|ing)|writ(?:e|es|ing)) (?:[a-z-]+ ){0,3}(?:insurance|polic(?:y|ies)|mortgages?|loans?|annuit(?:y|ies)|securities|investments?|warrant(?:y|ies))\b/i,
  REFER: /\brefer(?:s|ring|ral|rals)?\b[^.]{0,60}\b(?:borrowers?|clients?|customers?|policyholders?|leads?|patients?|homeowners?)\b|\b(?:borrowers?|clients?|customers?|policyholders?|leads?|patients?|homeowners?)\b[^.]{0,40}\brefer(?:red|rals?)\b/i,
} as const satisfies Record<string, RegExp>;
export type RegulatedActivity = keyof typeof REGULATED_ACTIVITIES;

/** What a role is known to hold. Absent keys are unknown, which is different from false. */
export interface RoleRecord {
  /** What the role actually does, in the words of the row — the role's label is not read. */
  performs: string;
  /** The label it was given; kept only so a relabel can be seen to change nothing. */
  label?: string | null;
  /** requirement -> held (true), lacking (false); absent = unknown, read from the record. */
  holds?: Partial<Record<RoleRequirement, boolean>>;
  /** An authorized licensed partner who holds what the role lacks, with the contract that lets Brain rely on it. */
  partner?: { holdsLicensing: boolean; contractInPlace: boolean } | null;
  /**
   * A finding, with its basis, that the role performs nothing regulated. The word lists above are
   * not exhaustive, so "nothing matched" is not that finding: only this is.
   */
  notRegulated?: { basis: string } | null;
}

export type RolePosition = 'COMPLIANT' | 'COMPLIANT_VIA_PARTNER' | 'NEEDS_POSITION' | 'UNKNOWN';

export interface RoleAssessment {
  activities: RegulatedActivity[];
  /** A regulated activity was recognised, or a finding says none is performed. False with position UNKNOWN means the text was not understood. */
  regulated: boolean;
  position: RolePosition;
  /** Requirements the record says are lacking. */
  missing: RoleRequirement[];
  /** Requirements the record does not state; recorded as unknown, not assumed. */
  unknown: RoleRequirement[];
  /** Whether the role's economics may enter a figure. False until a compliant position is established. */
  countEconomics: boolean;
  /** Never true: a regulated role is assessed, not excluded by category. */
  excluded: false;
  reason: string;
}

/** The regulated activities a text performs. */
export function regulatedActivitiesIn(text: string | null | undefined): RegulatedActivity[] {
  if (!text) return [];
  return (Object.keys(REGULATED_ACTIVITIES) as RegulatedActivity[]).filter((key) => REGULATED_ACTIVITIES[key].test(text));
}

/**
 * Assess one role by its rights and obligations. The decision reads `performs`
 * only, so renaming a role (a "referral" that is really brokering) is judged
 * against the rule for what it does.
 */
export function assessRole(role: RoleRecord): RoleAssessment {
  const activities = regulatedActivitiesIn(role.performs);
  if (activities.length === 0) {
    // The lists recognise phrasings; they do not define what is regulated. Text that matches none of them is
    // unknown until a finding with a basis says otherwise (§39): counting it would let a rewording evade the check.
    if (role.notRegulated && role.notRegulated.basis.trim().length > 0) {
      return { activities, regulated: false, position: 'COMPLIANT', missing: [], unknown: [], countEconomics: true, excluded: false, reason: `Found not regulated, on this basis: ${role.notRegulated.basis.trim().slice(0, 200)}` };
    }
    return {
      activities,
      regulated: false,
      position: 'UNKNOWN',
      missing: [],
      unknown: [...ROLE_REQUIREMENTS],
      countEconomics: false,
      excluded: false,
      reason: 'What the role performs names no activity this reader recognises, and no finding says it is unregulated. Recorded as unknown, not assumed compliant; its economics are not counted.',
    };
  }
  const holds = role.holds ?? {};
  const missing = ROLE_REQUIREMENTS.filter((req) => holds[req] === false);
  const unknown = ROLE_REQUIREMENTS.filter((req) => holds[req] === undefined);
  const partnerOk = !!role.partner && role.partner.holdsLicensing && role.partner.contractInPlace;

  let position: RolePosition;
  let reason: string;
  if (missing.length === 0 && unknown.length === 0) {
    position = 'COMPLIANT';
    reason = 'The record shows every requirement held.';
  } else if (partnerOk && missing.every((req) => req === 'licensing' || req === 'contract') && missing.length > 0 && unknown.length === 0) {
    position = 'COMPLIANT_VIA_PARTNER';
    reason = 'An authorized licensed partner holds what the role lacks, under a contract.';
  } else if (missing.length > 0) {
    position = 'NEEDS_POSITION';
    reason = `Lacking ${missing.join(', ')}: find a compliant position (an authorized licensed partner) before counting economics.`;
  } else {
    position = 'UNKNOWN';
    reason = `Not stated in the record: ${unknown.join(', ')}. Recorded as unknown, not assumed.`;
  }
  return { activities, regulated: true, position, missing, unknown, countEconomics: position === 'COMPLIANT' || position === 'COMPLIANT_VIA_PARTNER', excluded: false, reason };
}

/** A role and the money it is expected to bring, as a row a figure is built from. */
export interface RoleEconomics {
  id: string;
  role: RoleRecord;
  /** Cents the role is expected to bring; null when no row states it. */
  valueCents: number | null;
}

/** One role's assessment kept beside the id, so a record can show it was made. */
export interface RoleAssessmentRecord {
  id: string;
  assessment: RoleAssessment;
  /** Cents this role contributed to the figure: its value when countable, otherwise 0. */
  countedCents: number;
}

export interface CountedEconomics {
  totalCents: number;
  /** Every role, counted or not, with the reason; this is what a production record shows. */
  assessments: RoleAssessmentRecord[];
  /** Roles whose economics were held back, each with the missing position. Held back is not excluded. */
  heldBack: string[];
}

/**
 * The single place a regulated role's economics enter a figure. Every role is
 * assessed first; only a role with a compliant position (its own, or an
 * authorized licensed partner's) adds its value. A role that is not yet
 * compliant is held back with its reason and may be counted on a later call once
 * its record says it holds what it lacked. Nothing here is excluded by category.
 */
export function countRoleEconomics(rows: readonly RoleEconomics[]): CountedEconomics {
  const assessments = rows.map((row): RoleAssessmentRecord => {
    const assessment = assessRole(row.role);
    const value = typeof row.valueCents === 'number' && Number.isFinite(row.valueCents) && row.valueCents > 0 ? row.valueCents : 0;
    return { id: row.id, assessment, countedCents: assessment.countEconomics ? value : 0 };
  });
  return {
    totalCents: assessments.reduce((sum, a) => sum + a.countedCents, 0),
    assessments,
    heldBack: assessments.filter((a) => !a.assessment.countEconomics).map((a) => a.id),
  };
}

/*
 * Reading a role from rows. What a role performs is read from the opening's own cash_opportunities
 * row and its capital / constraint statements; holds / partner come from what Brain has recorded about
 * an opening (capital_structures, opportunity_constraints), never from a literal a caller types in.
 *
 *  - a LICENSING / COMPLIANCE / INSURANCE requirement, or a CREDENTIAL_REQUIRED / REGULATORY_CAPITAL
 *    constraint, says a licence is needed and not held: licensing = false;
 *  - a RESTRUCTURING row answering that requirement through an agency, brokerage, licence-in,
 *    revenue-share or management-contract mechanism names an authorized licensed partner who holds it;
 *  - a SUBCONTRACTING_PROHIBITED or PLATFORM_TERMS constraint says the contract the role needs is lacking;
 *  - a published practice is not an executed contract, so contractInPlace and the facts no row carries
 *    (product, location) come only from `attested` — a person's recorded statement — else they stay unknown.
 */
const PARTNER_MECHANISMS = new Set(['AGENCY', 'BROKERAGE', 'LICENSE_IN', 'REVENUE_SHARE', 'MANAGEMENT_CONTRACT']);
const LICENCE_REQUIREMENTS = new Set(['LICENSING', 'COMPLIANCE', 'INSURANCE']);
const LICENCE_CONSTRAINTS = new Set(['CREDENTIAL_REQUIRED', 'REGULATORY_CAPITAL']);
const CONTRACT_CONSTRAINTS = new Set(['SUBCONTRACTING_PROHIBITED', 'PLATFORM_TERMS']);

export interface RoleAttestation {
  /** Facts a person attested to that no row carries. */
  holds?: Partial<Record<RoleRequirement, boolean>>;
  /** A signed contract with the partner exists. */
  partnerContractInPlace?: boolean;
}

/**
 * What an opening performs, in the words of its own cash_opportunities row: its title, its mechanism,
 * its industry and source, and its evidence card. Production records every opening here and populates
 * capital_structures only for the few a research claim declared a capital requirement for, so a reader
 * that looked only at capital rows saw no role at all on real openings (r01.com-13-5, 2026-11-10).
 * This text says what is done; it never says what is held — holds and partner come only from rows and
 * attestations below.
 */
export interface OpeningRoleText {
  title: string;
  mechanism?: string | null;
  industry?: string | null;
  source?: string | null;
  payer?: string | null;
  offerScope?: string | null;
  buyingSignal?: string | null;
  acceptanceCondition?: string | null;
  paymentTerms?: string | null;
  fulfillmentOwner?: string | null;
  deliveryMethod?: string | null;
  requiredInputs?: string | null;
  economicsNote?: string | null;
}

/** The text of an opening row that says what it performs, one field per line, blanks left out. */
export function openingPerforms(opening: OpeningRoleText | null | undefined): string {
  if (!opening) return '';
  const mechanism = opening.mechanism ? opening.mechanism.toLowerCase().replace(/_/g, ' ') : null;
  return [
    opening.title,
    mechanism,
    opening.industry,
    opening.source,
    opening.payer,
    opening.offerScope,
    opening.buyingSignal,
    opening.acceptanceCondition,
    opening.paymentTerms,
    opening.fulfillmentOwner,
    opening.deliveryMethod,
    opening.requiredInputs,
    opening.economicsNote,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
}

export function roleRecordFromRows(
  capital: readonly CapitalStructure[],
  constraints: readonly OpportunityConstraint[],
  attested: RoleAttestation = {},
  opening: OpeningRoleText | null = null,
): RoleRecord {
  const performs = [openingPerforms(opening), ...capital.map((c) => c.statement), ...constraints.map((c) => c.statement)]
    .filter((part) => part.length > 0)
    .join('\n');
  const holds: Partial<Record<RoleRequirement, boolean>> = { ...(attested.holds ?? {}) };
  const licenceNeeds = capital.filter((c) => c.entryKind === 'REQUIREMENT' && c.requirement && LICENCE_REQUIREMENTS.has(c.requirement));
  const licenceConstrained = constraints.some((c) => LICENCE_CONSTRAINTS.has(c.kind));
  if (licenceNeeds.length > 0 || licenceConstrained) holds.licensing = attested.holds?.licensing ?? false;
  if (constraints.some((c) => CONTRACT_CONSTRAINTS.has(c.kind))) holds.contract = attested.holds?.contract ?? false;
  const needIds = new Set(licenceNeeds.map((c) => c.id));
  const partnered = capital.some(
    (c) => c.entryKind === 'RESTRUCTURING' && c.mechanism !== null && PARTNER_MECHANISMS.has(c.mechanism) && c.answersId !== null && needIds.has(c.answersId),
  );
  const partner = partnered ? { holdsLicensing: true, contractInPlace: attested.partnerContractInPlace === true } : null;
  return { performs, holds, partner };
}

/** The columns of cash_opportunities the role reader uses, as stored. */
export interface OpeningRoleRow {
  id: string;
  project_id: string;
  title: string;
  mechanism: string | null;
  industry: string | null;
  source: string | null;
  payer: string | null;
  offer_scope: string | null;
  buying_signal: string | null;
  acceptance_condition: string | null;
  payment_terms: string | null;
  fulfillment_owner: string | null;
  delivery_method: string | null;
  required_inputs: string | null;
  economics_note: string | null;
}

export const OPENING_ROLE_COLUMNS =
  'id, project_id, title, mechanism, industry, source, payer, offer_scope, buying_signal, acceptance_condition, payment_terms, fulfillment_owner, delivery_method, required_inputs, economics_note';

export function openingRoleText(row: OpeningRoleRow): OpeningRoleText {
  return {
    title: row.title,
    mechanism: row.mechanism,
    industry: row.industry,
    source: row.source,
    payer: row.payer,
    offerScope: row.offer_scope,
    buyingSignal: row.buying_signal,
    acceptanceCondition: row.acceptance_condition,
    paymentTerms: row.payment_terms,
    fulfillmentOwner: row.fulfillment_owner,
    deliveryMethod: row.delivery_method,
    requiredInputs: row.required_inputs,
    economicsNote: row.economics_note,
  };
}

/** One opening's row, bounded to its project in the query. */
async function openingRow(projectId: string, opportunityId: string): Promise<OpeningRoleRow | null> {
  const rows = await getDb().all<OpeningRoleRow>(
    `SELECT ${OPENING_ROLE_COLUMNS} FROM cash_opportunities WHERE id = ? AND project_id = ?`,
    [opportunityId, projectId],
  );
  return rows[0] ?? null;
}

/**
 * One opening's regulated role, assessed from the rows Brain holds for it: what its own
 * cash_opportunities row says it does, and what its capital_structures and opportunity_constraints
 * rows say it needs and holds. An opening with no capital rows is still assessed.
 */
export async function assessOpportunityRole(input: {
  projectId: string;
  opportunityId: string;
  attested?: RoleAttestation;
}): Promise<RoleAssessment> {
  const [row, capital, constraints] = await Promise.all([
    openingRow(input.projectId, input.opportunityId),
    listCapitalFor(input.opportunityId),
    listConstraintsForProject(input.projectId),
  ]);
  const own = constraints.filter((c) => c.opportunityId === input.opportunityId);
  const ownCapital = capital.filter((c) => c.projectId === input.projectId);
  return assessRole(roleRecordFromRows(ownCapital, own, input.attested, row ? openingRoleText(row) : null));
}

/*
 * Finding a compliant position (S-0106: "Brain should find compliant positions (including authorized
 * licensed partners) before counting their economics").
 *
 * A held-back assessment is not an end state. Every regulated opening whose position is NEEDS_POSITION
 * or UNKNOWN becomes one cash need (services/cash/needs.ts, the existing owner of "a missing capability
 * with somewhere to go"), keyed per opening so a loop raises it once: what the role performs, what it
 * lacks or what nobody stated, the way forward through an authorized licensed partner, and the record
 * that settles it — the same rows `roleRecordFromRows` reads, so the answer is what lets the economics
 * count. It never excludes anything and never counts anything itself.
 */

/** The request key of the need that seeks one opening's compliant position. */
export const positionNeedKey = (opportunityId: string): string => `regulated-position:${opportunityId}`;

export interface PositionSought {
  opportunityId: string;
  position: RolePosition;
  needId: string | null;
  /** Why no need could be raised, when one could not. */
  refused: string | null;
}

function positionNeed(title: string, a: RoleAssessment): { whyItMatters: string; recommendedPath: string; nextStep: string } {
  const performs = a.activities.map((one) => one.toLowerCase().replace(/_/g, ' ')).join(', ');
  const lacking = a.missing.length > 0 ? a.missing.join(', ') : null;
  const unstated = a.unknown.length > 0 ? a.unknown.join(', ') : null;
  return {
    whyItMatters:
      `"${title.slice(0, 120)}" performs a regulated activity (${performs}). Its economics are not counted until a ` +
      `compliant position exists${lacking ? `; the record says it lacks ${lacking}` : ''}${unstated ? `; nobody has stated ${unstated}` : ''}.`,
    recommendedPath:
      'Establish what this role needs for its product and location, then hold it directly or operate through an ' +
      'authorized licensed partner under a written contract. Changing the role\'s label is not a position: it is ' +
      'judged by what it performs.',
    nextStep: unstated
      ? `Research the ${unstated} requirements for this activity where the buyer is, and name licensed partners authorized to perform it.`
      : `Name an authorized licensed partner who holds ${lacking ?? 'what the role lacks'} and agree a contract with them.`,
  };
}

/**
 * Send every regulated opening of a project whose economics are held back to find a compliant position.
 * One need per opening (idempotent by key); an opening that already has a compliant position, or that
 * performs nothing regulated, raises none.
 */
export async function seekCompliantPositions(projectId: string): Promise<PositionSought[]> {
  const db = getDb();
  const [rows, withStatements] = await Promise.all([
    db.all<OpeningRoleRow>(`SELECT ${OPENING_ROLE_COLUMNS} FROM cash_opportunities WHERE project_id = ?`, [projectId]),
    db.all<{ opportunity_id: string }>(
      `SELECT opportunity_id FROM capital_structures WHERE project_id = ?
       UNION
       SELECT opportunity_id FROM opportunity_constraints WHERE project_id = ? AND opportunity_id IS NOT NULL`,
      [projectId, projectId],
    ),
  ]);
  const out: PositionSought[] = [];
  // A candidate is an opening whose own row names a regulated activity, or one with capital or constraint
  // statements that may; the rest perform nothing this reader recognises and have no position to find.
  const stated = new Set(withStatements.map((one) => one.opportunity_id));
  const candidates = rows.filter((row) => stated.has(row.id) || regulatedActivitiesIn(openingPerforms(openingRoleText(row))).length > 0);
  if (candidates.length === 0) return out;
  const [capital, constraints] = stated.size > 0
    ? await Promise.all([listCapitalForProject(projectId), listConstraintsForProject(projectId)])
    : [[], []];
  // Loaded only when there is something to raise: needs.ts sits above this module in the cash graph.
  const { raiseNeed } = await import('./needs.ts');
  for (const row of candidates) {
    const a = assessRole(
      roleRecordFromRows(
        capital.filter((c) => c.opportunityId === row.id),
        constraints.filter((c) => c.opportunityId === row.id),
        {},
        openingRoleText(row),
      ),
    );
    if (!a.regulated || a.countEconomics) continue;
    const text = positionNeed(row.title, a);
    const raised = await raiseNeed({
      projectId,
      opportunityId: row.id,
      actorRef: 'brain:regulated-role',
      blockedAction: `count the economics of "${row.title.slice(0, 120)}"`,
      whyItMatters: text.whyItMatters,
      recommendedPath: text.recommendedPath,
      setupEffort: 'research into the activity\'s requirements, then an agreement with a licensed partner',
      nextStep: text.nextStep,
      completionCondition:
        'The opening\'s record shows a compliant position: every requirement held, or a RESTRUCTURING capital row ' +
        'whose partner mechanism answers its licence requirement with the partner contract in place.',
      requestKey: positionNeedKey(row.id),
    });
    out.push({ opportunityId: row.id, position: a.position, needId: raised.ok ? raised.value.id : null, refused: raised.ok ? null : raised.reason });
  }
  return out;
}

/**
 * How often a goal read may search one project for positions. A goal read happens many times a tick and a
 * held-back role's need is raised once by key, so searching on every read only repeats statements a
 * remote database pays for (a goal read is held to a bounded statement count); a role recorded since the
 * last search is found on the next one.
 */
export const POSITION_SEARCH_INTERVAL_MS = 10 * 60_000;
const lastSearch = new Map<string, number>();

/** `seekCompliantPositions`, skipped when the same project was searched within the interval. */
export async function seekCompliantPositionsAtMostEvery(projectId: string, now: number = Date.now()): Promise<PositionSought[] | null> {
  const last = lastSearch.get(projectId);
  if (last !== undefined && now - last < POSITION_SEARCH_INTERVAL_MS) return null;
  lastSearch.set(projectId, now);
  return seekCompliantPositions(projectId);
}
