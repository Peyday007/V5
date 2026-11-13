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
 *
 * **An industry is never an exclusion class (owner's order, 2026-11-12, §105).**
 * "Government contracts, federal opportunities, and other industries are NOT
 * permanently excluded": an opening is judged on its economics, its time to
 * revenue and whether Brain can do it, and a government buyer that pays
 * tomorrow is as eligible as any other. Long award cycles already rank lower
 * by their own timing (`isCompetitiveAward`, the goal's window). The
 * government class that the $10K goal's words switched on is gone, so those
 * words now exclude nothing. What remains is a goal's own instruction about a
 * play, and it binds that goal only: never another goal, never the project's
 * shared discovery while another live goal may use it, and never once its goal
 * or its sprint has ended.
 */
import { clauseBefore, NEGATORS } from '../russell/negation.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { listCapitalFor, listConstraintsForProject } from '../../repos/industry.ts';
import type { CapitalStructure, OpportunityConstraint } from '../../domain/types.ts';

export const EXCLUSION_CLASSES = {
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

/**
 * The classes every live goal in a project excludes, for project-wide discovery
 * questions. An intersection, not a union: discovery is shared, and an opening
 * one live goal may use is worth finding even when another goal's owner left
 * it out (the same rule `notWorthResearching` applies to a dive). One goal's
 * constraint never narrows what the project as a whole searches.
 */
export function commonTo(goals: ReadonlyArray<{ exclusions: readonly ExclusionClass[] }>): ExclusionClass[] {
  if (goals.length === 0) return [];
  return EXCLUSION_KEYS.filter((key) => goals.every((one) => one.exclusions.includes(key)));
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
    const mode = await getCashMode(goal.target.projectId);
    // The whole stored objective: the canonical mandate excludes nothing, and the operator's additions follow it.
    // A sprint's additions are temporary: they bind only while that sprint runs, never after it winds down.
    if (mode && mode.state === 'ACTIVE') parts.push(mode.objective);
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
 * Reading a role from rows. holds / partner come from what Brain has recorded about an opening
 * (capital_structures, opportunity_constraints), never from a literal a caller types in.
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

export function roleRecordFromRows(
  capital: readonly CapitalStructure[],
  constraints: readonly OpportunityConstraint[],
  attested: RoleAttestation = {},
): RoleRecord {
  const performs = [...capital.map((c) => c.statement), ...constraints.map((c) => c.statement)].join('\n');
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

/** One opening's regulated role, assessed from the rows Brain holds for it. */
export async function assessOpportunityRole(input: {
  projectId: string;
  opportunityId: string;
  attested?: RoleAttestation;
}): Promise<RoleAssessment> {
  const [capital, constraints] = await Promise.all([listCapitalFor(input.opportunityId), listConstraintsForProject(input.projectId)]);
  const own = constraints.filter((c) => c.opportunityId === input.opportunityId);
  return assessRole(roleRecordFromRows(capital, own, input.attested));
}
