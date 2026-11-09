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
  BROKER: /\b(?:brokering|broker(?:s)?|arrang(?:e|es|ing) (?:a )?(?:loan|polic(?:y|ies)|sale))\b/i,
  SOLICIT: /\b(?:solicit(?:s|ing|ation)?|cold (?:call|email|text)|advertis(?:e|es|ing)|marketing (?:to|of) consumers)\b/i,
  HOLD_DEPOSITS: /\b(?:deposits?|escrow|hold(?:s|ing)? (?:customer )?funds)\b/i,
  MANUFACTURE: /\b(?:manufactur(?:e|es|ing)|subcontract(?:s|ing|or)?|private[- ]label)\b/i,
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
