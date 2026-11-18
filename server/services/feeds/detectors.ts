/**
 * Code-first recognition: versioned, pure detectors over stored feed items.
 *
 * A detector reads records that are already stored, recognises one repeating
 * pattern by ordinary code, and says exactly what it saw — never more. Its
 * output is a *signal*, not a buyer: a cluster of job posts shows an employer
 * hiring, and does not show that employer would pay anybody outside for
 * anything. That limit travels with every detection as `qualifiers` and a
 * `hypothesis` labelled as one.
 *
 * Three things are what make this cheaper than asking a model about every
 * record, and honest while doing it:
 *
 *   * **One pass, many rules.** A record is fetched and stored once; each
 *     installed rule reads the stored copy. Nothing is re-fetched per rule.
 *   * **Covered records skip the free screen.** An ACTIVE rule's member items
 *     are marked covered, and `screenFeedLeads` does not send them to a model
 *     one by one. The detection itself reaches Claude as one shortlist lead,
 *     on the same evidence gate as every other lead. Records no rule covers
 *     are screened exactly as before — nothing unrecognised is dropped.
 *   * **SHADOW before ACTIVE.** A new rule records what it would have found
 *     and changes nothing else until its readings have been checked.
 *
 * Detection rows are idempotent by `(rule, version, group)`: a restart or a
 * second tick finds the same row and only ever adds members to it.
 */
import { getDb } from '../../db/database.ts';
import { newId } from '../../repos/util.ts';
import { insertFeedItems } from '../../repos/feeds.ts';
import { DELIVERABLE_LABEL, type DeliverableKind } from '../cash/deliverables/spec.ts';
import type { Weakness } from '../../domain/improvement.ts';
import type { Completer, LaneConfig } from '../cheap/lane.ts';

/** The source a detection's own lead item is filed under. */
export const CODE_SIGNAL_SOURCE = 'code-signal';

export interface DetectorRecord {
  id: string;
  source: string;
  url: string;
  title: string;
  organization: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  /** The item's own text, when a rule reads it (a rule's effective date). */
  body?: string | null;
}

export interface DetectedSignal {
  groupKey: string;
  label: string;
  entityKey: string | null;
  /** The display name the source itself printed, for the lead line. */
  entityName: string | null;
  category: string | null;
  windowFrom: string;
  windowTo: string;
  memberIds: string[];
  memberTitles: string[];
  sourceUrls: string[];
  /** What this does not establish, and which fields were weak or missing. */
  qualifiers: string[];
  /** Why it *could* matter commercially. Explicitly not evidence of a buyer. */
  hypothesis: string | null;
  /** The deliverable the hypothesis is about, or null when there is none Brain sells. */
  deliverable: DeliverableKind | null;
}

export type DetectorMode = 'ACTIVE' | 'SHADOW';

export interface Detector {
  id: string;
  version: number;
  label: string;
  mode: DetectorMode;
  /** Feed sources whose stored items this rule reads. */
  sources: readonly string[];
  /** How far back the rule looks. */
  lookbackMs: number;
  /**
   * The entity key this rule groups an item's organization under. A rule that
   * keys entities differently from `employerKey(organization)` declares it here,
   * so `ruleReading` relates non-member items to the rule's entities exactly as
   * the rule itself would; a reading keyed another way cannot see the rule's misses.
   */
  entityKeyOf?(organization: string | null): string | null;
  /**
   * How recently an item must have been published (its fetch time when it
   * states none) for this rule to be able to keep it, when that is narrower
   * than `lookbackMs`. A rule may read further back than it keeps — to hold
   * the record a recent item refers to — and an item it could never keep is
   * not a miss (`ruleReading`). Unset: every item the rule reads can be kept.
   */
  memberWindowMs?: number;
  detect(records: readonly DetectorRecord[], now: Date): DetectedSignal[];
}

// ---------------------------------------------------------------------------
// Normalisation — strict, so two different companies are never merged.
// ---------------------------------------------------------------------------

const EMPLOYER_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'plc', 'sa', 'bv', 'ag', 'pty', 'llp', 'lp',
]);

/** A conservative identity for an employer name, or null when there is too little to go on. */
export function employerKey(name: string | null): string | null {
  if (!name) return null;
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && EMPLOYER_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  const key = words.join(' ');
  return key.length >= 2 ? key : null;
}

const SENIORITY = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'i', 'ii', 'iii', 'iv', 'mid', 'level', 'entry']);

/** A job title with seniority, parentheticals and punctuation removed, so a repost or mirror is one title. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(remote|hybrid|onsite|on-site|contract|full[- ]time|part[- ]time|freelance)\b/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !SENIORITY.has(word))
    .join(' ');
}

/** Job families a title can be read as, in order: the first that matches wins. */
export const JOB_FAMILIES: readonly { key: string; words: RegExp; deliverable: DeliverableKind | null }[] = [
  { key: 'DATA', words: /\b(data|analytics?|analyst|bi|business intelligence|etl|machine learning|ml|statistic)/, deliverable: 'DATASET' },
  { key: 'DESIGN', words: /\b(design(er)?|ux|ui|graphic|illustrat|brand|creative|motion)/, deliverable: 'GRAPHIC' },
  { key: 'WRITING', words: /\b(writer|writing|copywrit|content|editor|technical writ|documentation)/, deliverable: 'DOCUMENT' },
  { key: 'MARKETING', words: /\b(marketing|seo|growth|social media|campaign|demand gen|marketer)/, deliverable: 'DOCUMENT' },
  { key: 'FINANCE', words: /\b(account(ant|ing)|bookkeep|finance|financial|payroll|controller|fp&a|tax)/, deliverable: 'SPREADSHEET' },
  { key: 'OPERATIONS', words: /\b(operations|ops coordinator|administrat|assistant|coordinator|project manager|program manager)/, deliverable: 'SPREADSHEET' },
  { key: 'ENGINEERING', words: /\b(engineer|developer|programmer|software|frontend|front end|backend|back end|full ?stack|devops|sre|mobile|ios|android|web)/, deliverable: 'CODE' },
  { key: 'SALES', words: /\b(sales|account executive|business development|bdr|sdr)/, deliverable: null },
  { key: 'SUPPORT', words: /\b(support|customer success|customer service|help ?desk)/, deliverable: null },
];

export function jobFamily(title: string): (typeof JOB_FAMILIES)[number] | null {
  const lower = title.toLowerCase();
  return JOB_FAMILIES.find((family) => family.words.test(lower)) ?? null;
}

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Rule 1: concentrated hiring
// ---------------------------------------------------------------------------

/** A candidate heuristic, not an industry fact: at least this many distinct titles… */
export const HIRING_MIN_TITLES = 3;
/** …in one family, from one employer, inside this window. */
export const HIRING_WINDOW_MS = 14 * DAY;

export const CONCENTRATED_HIRING: Detector = {
  id: 'CONCENTRATED_HIRING',
  version: 1,
  label: 'Concentrated hiring: several distinct job titles in one family from one employer',
  mode: 'ACTIVE',
  sources: ['remoteok', 'remotive'],
  lookbackMs: HIRING_WINDOW_MS,
  detect(records, now) {
    const from = now.getTime() - HIRING_WINDOW_MS;
    const groups = new Map<string, { name: string; family: (typeof JOB_FAMILIES)[number]; byTitle: Map<string, DetectorRecord[]> }>();
    for (const record of records) {
      if (!this.sources.includes(record.source)) continue;
      const entity = employerKey(record.organization);
      if (!entity) continue; // an unnamed employer is never grouped
      const at = record.publishedAt ? Date.parse(record.publishedAt) : NaN;
      if (!Number.isFinite(at) || at < from || at > now.getTime() + DAY) continue; // undated or stale
      const family = jobFamily(record.title);
      if (!family) continue;
      const title = titleKey(record.title);
      if (!title) continue;
      const key = `${entity}|${family.key}`;
      const group = groups.get(key) ?? { name: record.organization!.trim(), family, byTitle: new Map() };
      // The display name is the spelling most members use, then the alphabetically
      // first — never whichever row the database happened to return first.
      const names = [...[...group.byTitle.values()].flat(), record].map((one) => one.organization!.trim());
      const counts = new Map<string, number>();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      group.name = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
      const same = group.byTitle.get(title) ?? [];
      same.push(record);
      group.byTitle.set(title, same);
      groups.set(key, group);
    }
    const out: DetectedSignal[] = [];
    for (const [key, group] of groups) {
      if (group.byTitle.size < HIRING_MIN_TITLES) continue;
      const members = [...group.byTitle.values()].flat();
      const dates = members.map((one) => Date.parse(one.publishedAt!)).sort((a, b) => a - b);
      const sources = new Set(members.map((one) => one.source));
      const mirrors = members.length - group.byTitle.size;
      const qualifiers = [
        'counts distinct job titles, not vacancies — the source publishes titles, not headcount',
        'a job post shows hiring; it does not show the employer would pay for outside work',
      ];
      if (mirrors > 0) qualifiers.push(`${mirrors} repost(s) or mirror(s) of a title already counted were not counted again`);
      if (sources.size > 1) qualifiers.push(`seen on ${sources.size} job boards; the same title across boards counts once`);
      const deliverable = group.family.deliverable;
      out.push({
        groupKey: key,
        label: `${group.byTitle.size} distinct ${group.family.key.toLowerCase()} job titles from one employer within ${Math.max(1, Math.ceil((dates[dates.length - 1]! - dates[0]!) / DAY))} day(s)`,
        entityKey: key.split('|')[0]!,
        entityName: group.name,
        category: group.family.key,
        windowFrom: new Date(dates[0]!).toISOString(),
        windowTo: new Date(dates[dates.length - 1]!).toISOString(),
        memberIds: members.map((one) => one.id),
        memberTitles: [...group.byTitle.values()].map((same) => same[0]!.title),
        sourceUrls: [...new Set(members.map((one) => one.url))],
        qualifiers,
        hypothesis: deliverable
          ? `A team adding ${group.family.key.toLowerCase()} roles this quickly may buy bounded ${DELIVERABLE_LABEL[deliverable]} work while it hires. Not established.`
          : null,
        deliverable,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Rule 2: repeated demand for one kind of work across employers
// ---------------------------------------------------------------------------

/** Distinct employers posting the same family of work inside the window. A candidate heuristic. */
export const REPEATED_DEMAND_MIN_EMPLOYERS = 3;
export const REPEATED_DEMAND_WINDOW_MS = 14 * DAY;

/**
 * The same kind of work asked for by several unrelated employers. It reads
 * every job family, including ones with no deliverable Brain sells (sales,
 * support): a family with no deliverable is still a signal, filed with none,
 * never dropped — no family or industry is excluded.
 */
export const REPEATED_DEMAND: Detector = {
  id: 'REPEATED_DEMAND',
  version: 1,
  label: 'Repeated demand: one family of work asked for by several distinct employers',
  mode: 'SHADOW',
  sources: ['remoteok', 'remotive'],
  lookbackMs: REPEATED_DEMAND_WINDOW_MS,
  detect(records, now) {
    const from = now.getTime() - REPEATED_DEMAND_WINDOW_MS;
    const groups = new Map<string, { family: (typeof JOB_FAMILIES)[number]; byEmployer: Map<string, DetectorRecord[]> }>();
    for (const record of records) {
      if (!this.sources.includes(record.source)) continue;
      const entity = employerKey(record.organization);
      if (!entity) continue;
      const at = record.publishedAt ? Date.parse(record.publishedAt) : NaN;
      if (!Number.isFinite(at) || at < from || at > now.getTime() + DAY) continue;
      const family = jobFamily(record.title);
      if (!family) continue;
      const group = groups.get(family.key) ?? { family, byEmployer: new Map() };
      group.byEmployer.set(entity, [...(group.byEmployer.get(entity) ?? []), record]);
      groups.set(family.key, group);
    }
    const out: DetectedSignal[] = [];
    for (const [key, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (group.byEmployer.size < REPEATED_DEMAND_MIN_EMPLOYERS) continue;
      const members = [...group.byEmployer.values()].flat();
      const dates = members.map((one) => Date.parse(one.publishedAt!)).sort((a, b) => a - b);
      const deliverable = group.family.deliverable;
      out.push({
        groupKey: `family:${key}`,
        label: `${group.byEmployer.size} distinct employers asking for ${key.toLowerCase()} work within ${Math.max(1, Math.ceil((dates[dates.length - 1]! - dates[0]!) / DAY))} day(s)`,
        entityKey: null,
        entityName: null,
        category: key,
        windowFrom: new Date(dates[0]!).toISOString(),
        windowTo: new Date(dates[dates.length - 1]!).toISOString(),
        memberIds: members.map((one) => one.id),
        memberTitles: members.map((one) => one.title).slice(0, 20),
        sourceUrls: [...new Set(members.map((one) => one.url))],
        qualifiers: [
          'counts employers posting the family, not buyers of outside work',
          'a job post shows hiring; it does not show any employer would pay for outside work',
        ],
        hypothesis: deliverable
          ? `Several employers need ${key.toLowerCase()} work at once; some may buy bounded ${DELIVERABLE_LABEL[deliverable]} work instead of hiring. Not established.`
          : null,
        deliverable,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Rule 3: a federal rule taking effect soon
// ---------------------------------------------------------------------------

/**
 * Whether an item is inside a rule's membership window: published (or, with no
 * date, fetched) no earlier than `memberWindowMs` before now and not after now.
 * A rule with no `memberWindowMs` can keep anything it reads. Pure.
 */
export function withinMemberWindow(detector: Pick<Detector, 'memberWindowMs'>, publishedAt: string | null, fetchedAt: string, now: Date): boolean {
  if (detector.memberWindowMs === undefined) return true;
  const at = Date.parse(publishedAt ?? fetchedAt);
  return Number.isFinite(at) && at >= now.getTime() - detector.memberWindowMs && at <= now.getTime();
}

/** A rule whose stated effective date falls inside this many days of now. */
export const RULE_EFFECTIVE_SOON_DAYS = 45;

/** The effective date the Federal Register parser writes into an item's body ("Effective 2026-11-22."). Pure. */
export function effectiveDateOf(body: string | null | undefined): string | null {
  const m = /Effective (\d{4}-\d{2}-\d{2})\./.exec(body ?? '');
  return m ? m[1]! : null;
}

export const RULE_EFFECTIVE_SOON: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 1,
  label: 'Rules taking effect soon: final rules from one agency effective within weeks',
  mode: 'SHADOW',
  sources: ['federal-register-rules'],
  lookbackMs: 30 * DAY,
  detect(records, now) {
    const until = now.getTime() + RULE_EFFECTIVE_SOON_DAYS * DAY;
    const groups = new Map<string, { name: string; members: { record: DetectorRecord; effective: string }[] }>();
    for (const record of records) {
      if (!this.sources.includes(record.source)) continue;
      const agency = employerKey(record.organization);
      const effective = effectiveDateOf(record.body);
      if (!agency || !effective) continue;
      const at = Date.parse(`${effective}T00:00:00.000Z`);
      if (!Number.isFinite(at) || at < now.getTime() - DAY || at > until) continue;
      const group = groups.get(agency) ?? { name: record.organization!.trim(), members: [] };
      group.members.push({ record, effective });
      groups.set(agency, group);
    }
    const out: DetectedSignal[] = [];
    for (const [agency, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dates = group.members.map((one) => one.effective).sort();
      out.push({
        groupKey: `agency:${agency}`,
        label: `${group.members.length} final rule(s) from one agency taking effect by ${dates[dates.length - 1]}`,
        entityKey: agency,
        entityName: group.name,
        category: 'REGULATION',
        windowFrom: `${dates[0]}T00:00:00.000Z`,
        windowTo: `${dates[dates.length - 1]}T00:00:00.000Z`,
        memberIds: group.members.map((one) => one.record.id),
        memberTitles: group.members.map((one) => one.record.title),
        sourceUrls: [...new Set(group.members.map((one) => one.record.url))],
        qualifiers: [
          'a rule taking effect names who is regulated, not who will pay for help complying',
          'the effective date is the one the Federal Register states; a delay or stay is not read',
        ],
        hypothesis: `Businesses this agency regulates must comply by ${dates[0]}; some may buy a plain compliance summary or checklist. Not established.`,
        deliverable: 'DOCUMENT',
      });
    }
    return out;
  },
};

/** How recently a rule must have been published for v2 to count it as news. */
export const RULE_EFFECTIVE_SOON_PUBLISHED_DAYS = 30;

/**
 * v2's "soon": a rule takes effect no later than this many days (eight weeks)
 * after its own publication. Measured from publication, not from the run, so a
 * verdict does not depend on which day the detector happens to run.
 */
export const RULE_EFFECTIVE_SOON_V2_LEAD_DAYS = 56;

/** The document a Federal Register correction corrects, as its record body states it ("Corrects 2026-21030."). Pure. */
export function correctedDocumentOf(body: string | null | undefined): string | null {
  const m = /Corrects ([A-Za-z0-9-]+)\./.exec(body ?? '');
  return m ? m[1]! : null;
}

/**
 * The most specific agency a record names. The Federal Register lists a
 * document's agencies parent first ("Transportation Department, Federal
 * Aviation Administration"), so the last one is the office that issued it.
 */
export function issuingAgencyOf(organization: string | null): string | null {
  const parts = (organization ?? '').split(',').map((one) => one.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/**
 * RULE_EFFECTIVE_SOON, version 2 (SHADOW). Three causes of v1's recorded misses
 * (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@1), each fixed without lowering a bar:
 *
 *  1. The window is measured from the rule's own publication. A final rule
 *     published in the last 30 days counts when it takes effect on or after its
 *     publication date and no later than RULE_EFFECTIVE_SOON_V2_LEAD_DAYS (eight
 *     weeks) after it. v1 measured both bounds from the run, so a rule
 *     effective on its own publication day (FAA 2026-23073, FCC 2026-23041)
 *     dropped out days later, and a correction effective 46 days after its
 *     publication (C1-2026-21030) was missed on the day it was published and
 *     kept only from the next. The upper bound now comes from the record.
 *     A rule effective before it was published is still never kept, and
 *     neither is one already in force: the lower bound is the later of its
 *     publication day and one day before the run (v1's bar), so a rule that
 *     took effect weeks ago is not "taking effect soon" and no signal asserts
 *     a past compliance date. The upper bound alone comes from publication.
 *  2. A correction inherits the effective date of the rule it corrects
 *     ("Corrects <document_number>."), read from that stored record, and is
 *     judged against the correction's own publication date (C1-2026-21030).
 *     When the corrected record is not stored, nothing is inferred.
 *  3. Members are grouped by the issuing agency, the last one listed, not by
 *     the parent department the Federal Register lists first.
 *
 * Free-text dates are not parsed: picking the operative date out of prose is
 * the known failure mode, so a notice whose only date is in its text (Coast
 * Guard 2026-23047, enforced before it was published) stays out.
 */
export const RULE_EFFECTIVE_SOON_V2: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 2,
  label: RULE_EFFECTIVE_SOON.label,
  mode: 'SHADOW',
  sources: RULE_EFFECTIVE_SOON.sources,
  // Long enough to hold the rule a recent correction corrects; membership stays at 30 days,
  // and only an item inside it can be a miss (`memberWindowMs`, read by `ruleReading`).
  lookbackMs: 90 * DAY,
  entityKeyOf(organization) {
    return employerKey(issuingAgencyOf(organization));
  },
  memberWindowMs: RULE_EFFECTIVE_SOON_PUBLISHED_DAYS * DAY,
  detect(records, now) {
    const ours = records.filter((record) => this.sources.includes(record.source));
    const effectiveOfDocument = (documentNumber: string): string | null => {
      const corrected = ours.find((record) => record.url.includes(`/${documentNumber}/`));
      return corrected ? effectiveDateOf(corrected.body) : null;
    };
    const groups = new Map<string, { name: string; members: { record: DetectorRecord; effective: string }[] }>();
    for (const record of ours) {
      const name = issuingAgencyOf(record.organization);
      const agency = this.entityKeyOf!(record.organization);
      if (!agency || !name) continue;
      if (!withinMemberWindow(this, record.publishedAt, record.fetchedAt, now)) continue;
      const published = Date.parse(record.publishedAt ?? record.fetchedAt);
      const corrects = correctedDocumentOf(record.body);
      const effective = effectiveDateOf(record.body) ?? (corrects ? effectiveOfDocument(corrects) : null);
      if (!effective) continue;
      const at = Date.parse(`${effective}T00:00:00.000Z`);
      const publishedDay = Date.parse(`${new Date(published).toISOString().slice(0, 10)}T00:00:00.000Z`);
      // Lower bound: not before its own publication, and — v1's bar, kept — not already in force
      // for more than a day when the rule runs. Upper bound: eight weeks after publication.
      const from = Math.max(publishedDay, now.getTime() - DAY);
      if (!Number.isFinite(at) || at < from || at > publishedDay + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY) continue;
      const group = groups.get(agency) ?? { name, members: [] };
      group.members.push({ record, effective });
      groups.set(agency, group);
    }
    const out: DetectedSignal[] = [];
    for (const [agency, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dates = group.members.map((one) => one.effective).sort();
      out.push({
        groupKey: `agency:${agency}`,
        label: `${group.members.length} final rule(s) from one agency taking effect by ${dates[dates.length - 1]}`,
        entityKey: agency,
        entityName: group.name,
        category: 'REGULATION',
        windowFrom: `${dates[0]}T00:00:00.000Z`,
        windowTo: `${dates[dates.length - 1]}T00:00:00.000Z`,
        memberIds: group.members.map((one) => one.record.id),
        memberTitles: group.members.map((one) => one.record.title),
        sourceUrls: [...new Set(group.members.map((one) => one.record.url))],
        qualifiers: [
          'a rule taking effect names who is regulated, not who will pay for help complying',
          'the effective date is the one the Federal Register states; a delay or stay is not read',
          'a correction carries the effective date of the rule it corrects, read from that stored record',
        ],
        hypothesis: `Businesses this agency regulates must comply by ${dates[0]}; some may buy a plain compliance summary or checklist. Not established.`,
        deliverable: 'DOCUMENT',
      });
    }
    return out;
  },
};

/** The corrected rule's effective date the Federal Register connector writes on a correction ("Corrected rule effective 2026-12-28."). Pure. */
export function correctedEffectiveDateOf(body: string | null | undefined): string | null {
  const m = /Corrected rule effective (\d{4}-\d{2}-\d{2})\./.exec(body ?? '');
  return m ? m[1]! : null;
}

/** Midnight UTC of the day an ISO instant falls on, in ms. Pure. */
const utcDay = (ms: number): number => Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`);

/**
 * v3's label and hypothesis, worded against the day the rule runs. v3 keeps a
 * member while its effective date is at or after the day Brain first held it,
 * so on a later run a date may already be past; a signal then says the rule
 * took effect on that date and never asserts "must comply by" a date that has
 * gone. `dates` is sorted ascending. Pure.
 */
export function ruleEffectiveSoonWording(dates: readonly string[], now: Date): { label: string; hypothesis: string } {
  const today = new Date(now.getTime()).toISOString().slice(0, 10);
  const past = dates.filter((one) => one < today);
  const upcoming = dates.filter((one) => one >= today);
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  if (past.length === 0) {
    return {
      label: `${dates.length} final rule(s) from one agency taking effect by ${last}`,
      hypothesis: `Businesses this agency regulates must comply by ${first}; some may buy a plain compliance summary or checklist. Not established.`,
    };
  }
  if (upcoming.length === 0) {
    return {
      label: `${dates.length} final rule(s) from one agency that took effect by ${last}`,
      hypothesis:
        `These rules took effect between ${first} and ${last}, before ${today}; businesses this agency regulates have had to comply since ${first}, ` +
        'and some may buy a plain compliance summary or checklist after the fact. Not established.',
    };
  }
  return {
    label: `${dates.length} final rule(s) from one agency, ${past.length} in force since ${first} and ${upcoming.length} taking effect by ${last}`,
    hypothesis:
      `${past.length} of these rules took effect on or after ${first}, before ${today}; businesses this agency regulates must comply with the rest by ${upcoming[0]}; ` +
      'some may buy a plain compliance summary or checklist. Not established.',
  };
}

/**
 * RULE_EFFECTIVE_SOON, version 3 (SHADOW). Two causes of v2's recorded misses
 * (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@2), each fixed without lowering a bar:
 *
 *  1. The not-already-in-force bar is anchored to the record, not the run.
 *     v2's lower bound was the later of publication and one day before *now*,
 *     so a final rule effective on its own publication day (FAA 2026-23073 and
 *     2026-23072, FCC 2026-23041) left detection a day after publication while
 *     it stayed a member for 30 days, and was counted a miss. v3 measures it
 *     from the day Brain first held the record (its fetch day, less v1's one
 *     day of grace), bounded below by publication, so a verdict does not
 *     depend on which day the detector runs. A rule effective before its
 *     publication is still never kept, a rule already in force when Brain
 *     first read it is still not "taking effect soon", and the eight-week
 *     upper bound from publication is unchanged.
 *  2. A correction (C1-2026-21030) reads the corrected rule's effective date
 *     the connector recorded from the Federal Register API's own effective_on
 *     ("Corrected rule effective YYYY-MM-DD."), and only then falls back to
 *     v2's lookup of the stored corrected record, so a correction whose rule
 *     was published before the lookback is no longer silently dropped.
 *
 * Because membership is anchored to the record, a later run can keep a rule
 * whose date has passed; its label and hypothesis are worded against the run
 * day (`ruleEffectiveSoonWording`), so no signal claims a business "must comply
 * by" a date already gone.
 *
 * Grouping stays by issuing agency (the last listed). Free-text dates are still
 * not parsed: Coast Guard 2026-23047, enforced before it was published and
 * dated only in prose, stays out.
 */
export const RULE_EFFECTIVE_SOON_V3: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 3,
  label: RULE_EFFECTIVE_SOON.label,
  mode: 'SHADOW',
  sources: RULE_EFFECTIVE_SOON.sources,
  lookbackMs: RULE_EFFECTIVE_SOON_V2.lookbackMs,
  entityKeyOf(organization) {
    return employerKey(issuingAgencyOf(organization));
  },
  memberWindowMs: RULE_EFFECTIVE_SOON_PUBLISHED_DAYS * DAY,
  detect(records, now) {
    const ours = records.filter((record) => this.sources.includes(record.source));
    const effectiveOfDocument = (documentNumber: string): string | null => {
      const corrected = ours.find((record) => record.url.includes(`/${documentNumber}/`));
      return corrected ? effectiveDateOf(corrected.body) : null;
    };
    const groups = new Map<string, { name: string; members: { record: DetectorRecord; effective: string }[] }>();
    for (const record of ours) {
      const name = issuingAgencyOf(record.organization);
      const agency = this.entityKeyOf!(record.organization);
      if (!agency || !name) continue;
      if (!withinMemberWindow(this, record.publishedAt, record.fetchedAt, now)) continue;
      const published = Date.parse(record.publishedAt ?? record.fetchedAt);
      const fetched = Date.parse(record.fetchedAt);
      if (!Number.isFinite(published) || !Number.isFinite(fetched)) continue;
      const corrects = correctedDocumentOf(record.body);
      const effective =
        effectiveDateOf(record.body) ?? (corrects ? correctedEffectiveDateOf(record.body) ?? effectiveOfDocument(corrects) : null);
      if (!effective) continue;
      const at = Date.parse(`${effective}T00:00:00.000Z`);
      const publishedDay = utcDay(published);
      // Lower bound: not before its own publication, and not in force for more than a day when
      // Brain first held the record. Upper bound: eight weeks after publication.
      const from = Math.max(publishedDay, utcDay(fetched) - DAY);
      if (!Number.isFinite(at) || at < from || at > publishedDay + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY) continue;
      const group = groups.get(agency) ?? { name, members: [] };
      group.members.push({ record, effective });
      groups.set(agency, group);
    }
    const out: DetectedSignal[] = [];
    for (const [agency, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dates = group.members.map((one) => one.effective).sort();
      const wording = ruleEffectiveSoonWording(dates, now);
      out.push({
        groupKey: `agency:${agency}`,
        label: wording.label,
        entityKey: agency,
        entityName: group.name,
        category: 'REGULATION',
        windowFrom: `${dates[0]}T00:00:00.000Z`,
        windowTo: `${dates[dates.length - 1]}T00:00:00.000Z`,
        memberIds: group.members.map((one) => one.record.id),
        memberTitles: group.members.map((one) => one.record.title),
        sourceUrls: [...new Set(group.members.map((one) => one.record.url))],
        qualifiers: [
          'a rule taking effect names who is regulated, not who will pay for help complying',
          'the effective date is the one the Federal Register states; a delay or stay is not read',
          'a correction carries the effective date of the rule it corrects, as the Federal Register API states it for that rule',
          'kept against the day Brain first held the record; the wording says which effective dates had passed on the day it ran',
        ],
        hypothesis: wording.hypothesis,
        deliverable: 'DOCUMENT',
      });
    }
    return out;
  },
};

/**
 * The Federal Register document number a stored record is, read from the
 * html_url the connector stores (".../documents/2026/11/12/C1-2026-21030/slug").
 * Exact, so "2026-21030" never matches the correction "C1-2026-21030". Pure.
 */
export function federalRegisterDocumentOf(url: string): string | null {
  const m = /\/documents\/\d{4}\/\d{2}\/\d{2}\/([A-Za-z0-9-]+)(?:[/?#]|$)/.exec(url);
  return m ? m[1]! : null;
}

/**
 * RULE_EFFECTIVE_SOON, version 4 (SHADOW). Two causes of v3's recorded misses
 * (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@3), each fixed without lowering a bar:
 *
 *  1. One document, many stored copies. The connector stores each edit of a
 *     record as a new feed item ("<id>#v<n>", a later fetched_at), and a
 *     correction is completed — "Corrected rule effective YYYY-MM-DD." — only
 *     on the copy the completion wrote. v3 read each copy's date from that
 *     copy alone, so the copy stored as bare "Corrects 2026-21030."
 *     (C1-2026-21030) stayed out while its completed copy was kept, and looked
 *     the corrected rule up by URL substring. v4 resolves a document's dates
 *     from every stored copy of it, matched by document number
 *     (`federalRegisterDocumentOf`): its own "Effective" sentence, else the
 *     corrected rule's date recorded on any copy of the correction, else the
 *     "Effective" sentence of any stored copy of the corrected document.
 *  2. "When Brain first held the record" is the document's first stored copy,
 *     not this copy. v3's lower bound was the later of publication and the
 *     copy's own fetch day less one day, so an edit of a rule (a new version
 *     "<id>#v<n>" carries a new fetched_at) or a completed copy of a correction
 *     was dropped once it was stored a day or more after the rule took effect,
 *     although Brain had held the document since before then. v4 keeps v3's
 *     bar unchanged — not before publication, and not already in force for
 *     more than a day when Brain first held the document — but measures "first
 *     held" from the earliest fetched_at of any stored copy with the same
 *     document number. A rule Brain first stored after it was already in force
 *     (a late backfill) is still not "taking effect soon". The eight-week upper
 *     bound and the 30-day membership window from publication are unchanged,
 *     and the wording (`ruleEffectiveSoonWording`) still says a passed date
 *     took effect rather than "must comply by".
 *
 * Grouping stays by issuing agency (the last listed). Free-text dates are still
 * not parsed: Coast Guard 2026-23047, enforced the day before it was published
 * and dated only in prose, stays out — a correct exclusion, not a miss. A rule
 * effective before its publication (a temporary rule enforced on actual notice)
 * also stays out.
 */
export const RULE_EFFECTIVE_SOON_V4: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 4,
  label: RULE_EFFECTIVE_SOON.label,
  mode: 'SHADOW',
  sources: RULE_EFFECTIVE_SOON.sources,
  lookbackMs: RULE_EFFECTIVE_SOON_V3.lookbackMs,
  entityKeyOf(organization) {
    return employerKey(issuingAgencyOf(organization));
  },
  memberWindowMs: RULE_EFFECTIVE_SOON_PUBLISHED_DAYS * DAY,
  detect(records, now) {
    const ours = records.filter((record) => this.sources.includes(record.source));
    // Every stored copy of a document, by document number: the earliest stated date wins only if
    // copies disagree, which the Federal Register's own fields do not; sorting keeps it deterministic.
    const own = new Map<string, string>();
    const correctedRule = new Map<string, string>();
    const firstHeld = new Map<string, number>();
    for (const record of ours) {
      const documentNumber = federalRegisterDocumentOf(record.url);
      if (!documentNumber) continue;
      const fetched = Date.parse(record.fetchedAt);
      if (Number.isFinite(fetched) && (!firstHeld.has(documentNumber) || fetched < firstHeld.get(documentNumber)!)) firstHeld.set(documentNumber, fetched);
      const stated = effectiveDateOf(record.body);
      if (stated && (!own.has(documentNumber) || stated < own.get(documentNumber)!)) own.set(documentNumber, stated);
      const marker = correctedEffectiveDateOf(record.body);
      if (marker && (!correctedRule.has(documentNumber) || marker < correctedRule.get(documentNumber)!)) correctedRule.set(documentNumber, marker);
    }
    const effectiveOf = (record: DetectorRecord): string | null => {
      const documentNumber = federalRegisterDocumentOf(record.url);
      const stated = effectiveDateOf(record.body) ?? (documentNumber ? own.get(documentNumber) ?? null : null);
      if (stated) return stated;
      const corrects = correctedDocumentOf(record.body);
      if (!corrects) return null;
      return correctedEffectiveDateOf(record.body) ?? (documentNumber ? correctedRule.get(documentNumber) ?? null : null) ?? own.get(corrects) ?? null;
    };
    const groups = new Map<string, { name: string; members: { record: DetectorRecord; effective: string }[] }>();
    for (const record of ours) {
      const name = issuingAgencyOf(record.organization);
      const agency = this.entityKeyOf!(record.organization);
      if (!agency || !name) continue;
      if (!withinMemberWindow(this, record.publishedAt, record.fetchedAt, now)) continue;
      const published = Date.parse(record.publishedAt ?? record.fetchedAt);
      const documentNumber = federalRegisterDocumentOf(record.url);
      const fetched = (documentNumber ? firstHeld.get(documentNumber) : undefined) ?? Date.parse(record.fetchedAt);
      if (!Number.isFinite(published) || !Number.isFinite(fetched)) continue;
      const effective = effectiveOf(record);
      if (!effective) continue;
      const at = Date.parse(`${effective}T00:00:00.000Z`);
      const publishedDay = utcDay(published);
      // v3's bar, unchanged: not before its own publication, and not in force for more than a day when
      // Brain first held the document (its earliest stored copy). Upper bound: eight weeks after publication.
      const from = Math.max(publishedDay, utcDay(fetched) - DAY);
      if (!Number.isFinite(at) || at < from || at > publishedDay + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY) continue;
      const group = groups.get(agency) ?? { name, members: [] };
      group.members.push({ record, effective });
      groups.set(agency, group);
    }
    const out: DetectedSignal[] = [];
    for (const [agency, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dates = group.members.map((one) => one.effective).sort();
      // Every stored copy is a member (each is a feed item the screen would otherwise read), but the
      // wording counts rules: one date per document, so a correction's bare and completed copies, or a
      // rule and its edit, are one rule taking effect, not two.
      const perDocument = new Map<string, string>();
      for (const one of group.members) {
        const key = federalRegisterDocumentOf(one.record.url) ?? one.record.id;
        const held = perDocument.get(key);
        if (!held || one.effective < held) perDocument.set(key, one.effective);
      }
      const wording = ruleEffectiveSoonWording([...perDocument.values()].sort(), now);
      out.push({
        groupKey: `agency:${agency}`,
        label: wording.label,
        entityKey: agency,
        entityName: group.name,
        category: 'REGULATION',
        windowFrom: `${dates[0]}T00:00:00.000Z`,
        windowTo: `${dates[dates.length - 1]}T00:00:00.000Z`,
        memberIds: group.members.map((one) => one.record.id),
        memberTitles: group.members.map((one) => one.record.title),
        sourceUrls: [...new Set(group.members.map((one) => one.record.url))],
        qualifiers: [
          'a rule taking effect names who is regulated, not who will pay for help complying',
          'the effective date is the one the Federal Register states; a delay or stay is not read',
          'a correction carries the effective date of the rule it corrects, as the Federal Register API states it for that rule',
          'every stored copy of a document is read for its stated dates, matched by document number',
          'kept against the day Brain first held the document (its earliest stored copy); the wording says which effective dates had passed on the day it ran',
        ],
        hypothesis: wording.hypothesis,
        deliverable: 'DOCUMENT',
      });
    }
    return out;
  },
};

/** A Federal Register document number: "2026-21030", or a correction's "C1-2026-21030". */
const FEDERAL_REGISTER_DOCUMENT_NUMBER = /^(?:C\d+-)?\d{4}-\d+$/;

/**
 * The publication day the Federal Register itself states for a stored record:
 * the date in its html_url (".../documents/2026/11/12/<number>/slug"). A
 * structured field of the source, not prose. Null when the URL carries none. Pure.
 */
export function federalRegisterPublishedDayOf(url: string): string | null {
  const m = /\/documents\/(\d{4})\/(\d{2})\/(\d{2})\/[A-Za-z0-9-]+(?:[/?#]|$)/.exec(url);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The rule a Federal Register document number corrects, by the Register's own
 * numbering: a correction is numbered "C<n>-" before the document it corrects
 * (C1-2026-21030 corrects 2026-21030). Null for a document that is not one. Pure.
 */
export function correctedDocumentOfNumber(documentNumber: string | null | undefined): string | null {
  const m = /^C\d+-(\d{4}-\d+)$/.exec(documentNumber ?? '');
  return m ? m[1]! : null;
}

/**
 * RULE_EFFECTIVE_SOON, version 5 (SHADOW). Four causes of v4's recorded misses
 * (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@4), each fixed without lowering a bar:
 *
 *  1. A correction is known by its own number, not only by its body. v4 read
 *     "Corrects N." from the copy at hand and gave up when that copy did not
 *     carry it — a copy stored bare, before the connector read correction_of,
 *     or one whose correction_of named something other than a document number
 *     — although another copy of the same correction, or its own number
 *     (C1-2026-21030 corrects 2026-21030), names the rule. v5 collects every
 *     corrected document any copy names (a "C<n>-" prefix on that name is
 *     dropped, so a target that differs from the correction's number only by
 *     the prefix still resolves) together with the one its own number names,
 *     and takes the date from: the "Effective" sentence of any copy, else the
 *     corrected rule's date recorded on any copy of the correction, else the
 *     "Effective" sentence of any stored copy of a corrected document. Every
 *     date is still a field the Federal Register API states; nothing is inferred.
 *  2. The publication day is the one the Federal Register states for the
 *     document — the date in its html_url — before the stored publishedAt, and
 *     publishedAt is read as the calendar day it states, not shifted by its
 *     offset. v4 fell back to the fetch time when publishedAt was missing, so
 *     a rule effective on its publication day (lead 0: FAA 2026-23073 and
 *     2026-23072, FCC 2026-23041) and stored the next day measured both bounds
 *     from the wrong day and dropped out; an offset east of UTC moved the day
 *     back and cut a day off the eight-week bound.
 *  3. One document, one agency. v4 grouped each stored copy by the agencies
 *     that copy listed, so a copy listing only the parent department
 *     (Transportation Department) and an edit listing it with the issuing
 *     office (Federal Aviation Administration) landed in two groups. v5 groups
 *     every copy of a document under the issuing (last-listed) agency of the
 *     copy that lists the most agencies — the most specific the source stated.
 *
 *  4. The lower bound is the source's, not Brain's. v3 and v4 measured "not
 *     already in force" from the day Brain first held the document, less a
 *     day, so a rule effective on (or soon after) its publication that Brain
 *     stored two or more days late — a pull that failed, a source paused, a
 *     cursor that caught up — was dropped, although the free screen, reading
 *     the same record, kept it. That is how FCC 2026-23040, Coast Guard
 *     2026-23027 and ACF 2026-23279 (each "Effective <publication day>.")
 *     became misses: the verdict depended on when Brain's pull happened to
 *     run, the very dependence v3 removed for the detector's own run day. v5
 *     measures it from the publication day the Federal Register states, so a
 *     verdict is a property of the record alone. What the bound stands for is
 *     kept: a rule effective before its publication (a temporary rule enforced
 *     on actual notice) is still never kept, the 30-day membership window from
 *     publication still retires an old rule however late Brain stored it, and
 *     the wording (`ruleEffectiveSoonWording`) still says a passed date took
 *     effect rather than "must comply by".
 *
 * Kept unchanged: no free-text date parsing (Coast Guard 2026-23047, enforced
 * the day before publication and dated only in prose, stays out — a correct
 * exclusion), the eight-week upper bound from publication
 * (RULE_EFFECTIVE_SOON_V2_LEAD_DAYS), the 30-day membership window, the bar
 * that a rule is never effective before its own publication, and the wording.
 */
export const RULE_EFFECTIVE_SOON_V5: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 5,
  label: RULE_EFFECTIVE_SOON.label,
  mode: 'SHADOW',
  sources: RULE_EFFECTIVE_SOON.sources,
  lookbackMs: RULE_EFFECTIVE_SOON_V4.lookbackMs,
  entityKeyOf(organization) {
    return employerKey(issuingAgencyOf(organization));
  },
  memberWindowMs: RULE_EFFECTIVE_SOON_PUBLISHED_DAYS * DAY,
  detect(records, now) {
    return detectRuleEffectiveSoonV5(this, records, now, { readStatedEffective: false, extraQualifiers: [] });
  },
};

/**
 * The date the Federal Register connector recorded from a document's own DATES
 * field when its effective_on is null ("Stated effective 2026-12-13."), written
 * by `parseFederalRegister` only for a record that is not a correction. Read
 * as a marker, exactly like "Effective": the detector parses no prose. Pure.
 */
export function statedEffectiveDateOf(body: string | null | undefined): string | null {
  const m = /Stated effective (\d{4}-\d{2}-\d{2})\./.exec(body ?? '');
  return m ? m[1]! : null;
}

/**
 * RULE_EFFECTIVE_SOON v5's detection, shared with v6 and v7. With `readStatedEffective`
 * off it is v5 exactly; v6 turns it on (see RULE_EFFECTIVE_SOON_V6); v7 also turns on
 * `readCorrectedStated` (see RULE_EFFECTIVE_SOON_V7). Pure.
 */
function detectRuleEffectiveSoonV5(
  detector: Detector,
  records: readonly DetectorRecord[],
  now: Date,
  options: { readStatedEffective: boolean; readCorrectedStated?: boolean; extraQualifiers: readonly string[] },
): DetectedSignal[] {
    const ours = records.filter((record) => detector.sources.includes(record.source));
    const keep = (map: Map<string, string>, key: string, value: string | null): void => {
      if (value && (!map.has(key) || value < map.get(key)!)) map.set(key, value);
    };
    // Every stored copy of a document, by document number.
    const own = new Map<string, string>();
    const correctedRule = new Map<string, string>();
    const corrects = new Map<string, Set<string>>();
    const agencies = new Map<string, string[]>();
    const statedOwn = new Map<string, string>();
    for (const record of ours) {
      const documentNumber = federalRegisterDocumentOf(record.url);
      if (!documentNumber) continue;
      keep(own, documentNumber, effectiveDateOf(record.body));
      if (options.readStatedEffective) keep(statedOwn, documentNumber, statedEffectiveDateOf(record.body));
      keep(correctedRule, documentNumber, correctedEffectiveDateOf(record.body));
      const targets = corrects.get(documentNumber) ?? new Set<string>();
      const stated = correctedDocumentOf(record.body);
      if (stated && FEDERAL_REGISTER_DOCUMENT_NUMBER.test(stated)) targets.add(correctedDocumentOfNumber(stated) ?? stated);
      const byNumber = correctedDocumentOfNumber(documentNumber);
      if (byNumber) targets.add(byNumber);
      targets.delete(documentNumber);
      corrects.set(documentNumber, targets);
      const listed = (record.organization ?? '').split(',').map((one) => one.trim()).filter(Boolean);
      const held = agencies.get(documentNumber);
      if (listed.length > 0 && (!held || listed.length > held.length || (listed.length === held.length && listed.join(', ') < held.join(', ')))) {
        agencies.set(documentNumber, listed);
      }
    }
    const effectiveOf = (record: DetectorRecord, documentNumber: string | null): string | null => {
      const stated = effectiveDateOf(record.body) ?? (documentNumber ? own.get(documentNumber) ?? null : null);
      if (stated) return stated;
      const targets = new Set<string>(documentNumber ? corrects.get(documentNumber) ?? [] : []);
      const fromBody = correctedDocumentOf(record.body);
      if (fromBody && FEDERAL_REGISTER_DOCUMENT_NUMBER.test(fromBody)) targets.add(correctedDocumentOfNumber(fromBody) ?? fromBody);
      if (targets.size === 0) {
        // v6: no "Effective" sentence on any copy and not a correction — the date the Federal
        // Register's own DATES field states, as the connector recorded it on any copy.
        if (!options.readStatedEffective) return null;
        return statedEffectiveDateOf(record.body) ?? (documentNumber ? statedOwn.get(documentNumber) ?? null : null);
      }
      const marker = correctedEffectiveDateOf(record.body) ?? (documentNumber ? correctedRule.get(documentNumber) ?? null : null);
      if (marker) return marker;
      const dates = [...targets].map((one) => own.get(one)).filter((one): one is string => !!one).sort();
      if (dates[0]) return dates[0];
      // v7: the corrected rule states its date only in its own DATES field (effective_on null) — the
      // date the connector recorded on any stored copy of that rule, exactly as v6 reads it for the rule itself.
      if (!options.readStatedEffective || !options.readCorrectedStated) return null;
      const statedDates = [...targets].map((one) => statedOwn.get(one)).filter((one): one is string => !!one).sort();
      return statedDates[0] ?? null;
    };
    const publishedDayOf = (record: DetectorRecord): number => {
      const stated = federalRegisterPublishedDayOf(record.url) ?? /^(\d{4}-\d{2}-\d{2})/.exec(record.publishedAt ?? '')?.[1] ?? null;
      return stated ? Date.parse(`${stated}T00:00:00.000Z`) : utcDay(Date.parse(record.fetchedAt));
    };
    const groups = new Map<string, { name: string; members: { record: DetectorRecord; effective: string }[] }>();
    for (const record of ours) {
      const documentNumber = federalRegisterDocumentOf(record.url);
      const listed = documentNumber ? agencies.get(documentNumber) : undefined;
      const name = listed ? listed[listed.length - 1]! : issuingAgencyOf(record.organization);
      const agency = employerKey(name);
      if (!agency || !name) continue;
      if (!withinMemberWindow(detector, record.publishedAt, record.fetchedAt, now)) continue;
      const publishedDay = publishedDayOf(record);
      if (!Number.isFinite(publishedDay)) continue;
      const effective = effectiveOf(record, documentNumber);
      if (!effective) continue;
      const at = Date.parse(`${effective}T00:00:00.000Z`);
      // Not before its own publication, and no later than eight weeks after it: both bounds are the
      // Federal Register's own dates, never the day Brain happened to fetch the document (cause 4).
      if (!Number.isFinite(at) || at < publishedDay || at > publishedDay + RULE_EFFECTIVE_SOON_V2_LEAD_DAYS * DAY) continue;
      const group = groups.get(agency) ?? { name, members: [] };
      group.members.push({ record, effective });
      groups.set(agency, group);
    }
    const out: DetectedSignal[] = [];
    for (const [agency, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dates = group.members.map((one) => one.effective).sort();
      const perDocument = new Map<string, string>();
      for (const one of group.members) {
        const key = federalRegisterDocumentOf(one.record.url) ?? one.record.id;
        const held = perDocument.get(key);
        if (!held || one.effective < held) perDocument.set(key, one.effective);
      }
      const wording = ruleEffectiveSoonWording([...perDocument.values()].sort(), now);
      out.push({
        groupKey: `agency:${agency}`,
        label: wording.label,
        entityKey: agency,
        entityName: group.name,
        category: 'REGULATION',
        windowFrom: `${dates[0]}T00:00:00.000Z`,
        windowTo: `${dates[dates.length - 1]}T00:00:00.000Z`,
        memberIds: group.members.map((one) => one.record.id),
        memberTitles: group.members.map((one) => one.record.title),
        sourceUrls: [...new Set(group.members.map((one) => one.record.url))],
        qualifiers: [
          'a rule taking effect names who is regulated, not who will pay for help complying',
          'the effective date is the one the Federal Register states; a delay or stay is not read',
          'a correction carries the effective date of the rule it corrects, as the Federal Register API states it for that rule',
          'every stored copy of a document is read for its stated dates and agencies, matched by document number',
          'the publication day is the one the Federal Register states in the document URL',
          'kept against the publication day the Federal Register states, not the day Brain fetched it; the wording says which effective dates had passed on the day it ran',
          ...options.extraQualifiers,
        ],
        hypothesis: wording.hypothesis,
        deliverable: 'DOCUMENT',
      });
    }
    return out;
}

/**
 * RULE_EFFECTIVE_SOON, version 6 (SHADOW). One cause of v5's recorded misses
 * (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@5), fixed without lowering a bar:
 *
 *  1. A final rule whose effective_on is null states its date only in the
 *     Federal Register's own DATES field. Since 41d72ad the connector records
 *     that date as "Stated effective YYYY-MM-DD." — deliberately not an
 *     "Effective" sentence, which stays effective_on's alone — and v5 read only
 *     "Effective", so every such record had no date and dropped out, though
 *     the free screen, reading the same record, kept it. The established
 *     instance of that shape is the Coast Guard's notification of enforcement
 *     (2026-23047: action "Notification of enforcement of regulation",
 *     effective_on null, its date only in DATES); 2026-23230, a recorded miss
 *     of the same kind of document, is modelled on it. No shape is asserted
 *     here for FCC 2026-23040, Coast Guard 2026-23027 or ACF 2026-23279: the
 *     record states them only as "Effective <publication day>." stored late
 *     (v5's cause 4), and v6 keeps them in that shape and in this one alike. v6 reads that marker, from any stored copy of the document, when no
 *     copy states an "Effective" sentence and the document is not a
 *     correction. "Effective" still wins wherever any copy carries it, and a
 *     correction still takes the corrected rule's date exactly as in v5.
 *
 * Everything else is v5's, shared code (`detectRuleEffectiveSoonV5`): copies
 * read together by document number, grouping by the issuing agency of the copy
 * that lists the most agencies, the publication day the Federal Register states
 * in the URL. Kept unchanged: the bar that a rule is never effective before its
 * own publication (Coast Guard 2026-23047, enforced 2026-11-11 and published
 * 2026-11-12, now carries "Stated effective 2026-11-11." and still stays out —
 * a correct exclusion), the eight-week upper bound
 * (RULE_EFFECTIVE_SOON_V2_LEAD_DAYS), the 30-day membership window, the
 * wording, and no free-text date parsing in the detector: the date is the one
 * the connector read from an official field.
 */
export const RULE_EFFECTIVE_SOON_V6: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 6,
  label: RULE_EFFECTIVE_SOON.label,
  mode: 'SHADOW',
  sources: RULE_EFFECTIVE_SOON.sources,
  lookbackMs: RULE_EFFECTIVE_SOON_V5.lookbackMs,
  entityKeyOf(organization) {
    return employerKey(issuingAgencyOf(organization));
  },
  memberWindowMs: RULE_EFFECTIVE_SOON_PUBLISHED_DAYS * DAY,
  detect(records, now) {
    return detectRuleEffectiveSoonV5(this, records, now, {
      readStatedEffective: true,
      extraQualifiers: ["with no effective_on, the date the Federal Register's own DATES field states, as the connector recorded it"],
    });
  },
};

/**
 * RULE_EFFECTIVE_SOON, version 7 (SHADOW). Two causes of v6's recorded misses
 * (DETECTOR_MISSES:RULE_EFFECTIVE_SOON@6), each fixed without lowering a bar:
 *
 *  1. A correction of a rule dated only in its DATES field. v6 gave a
 *     correction the corrected rule's "Effective" date (or the connector's
 *     "Corrected rule effective" marker, which is that rule's effective_on) and
 *     nothing else, so a correction of a rule whose effective_on is null — its
 *     date recorded on the rule's own copy as "Stated effective" — had no date
 *     and dropped out, although v6 keeps the rule itself on that very marker.
 *     v7 reads it for the correction too, from any stored copy of a corrected
 *     document, after every date v6 reads. A correction's own "Stated
 *     effective" marker is still never read: the date is the corrected rule's.
 *  2. (In the connector, `completeFederalRegisterCorrections`.) A stored
 *     correction whose copy carries no "Corrects N." sentence (C1-2026-21030
 *     stored bare: effective_on, dates and action all null) was never
 *     completed, because the completer found its target only in the body; so
 *     when the corrected rule's own copy was not among the records (published
 *     before the lookback, or never stored), no copy stated any date. The
 *     completer now also reads the target from the Register's own numbering
 *     ("C<n>-" before the corrected document's number) and writes the
 *     corrected rule's effective_on as "Corrected rule effective", which v5..v7
 *     already read.
 *
 * Everything else is v6's, shared code (`detectRuleEffectiveSoonV5`): lead-0
 * rules kept (the lower bound is the publication day, inclusive), copies
 * grouped under the issuing agency of the copy that lists the most agencies
 * (FAA, never Transportation Department), the publication day the URL states.
 * Kept unchanged: never effective before publication (Coast Guard 2026-23047,
 * enforced 2026-11-11 and published 2026-11-12, stays out), the eight-week
 * upper bound (RULE_EFFECTIVE_SOON_V2_LEAD_DAYS), the 30-day membership
 * window, the wording, and no free-text date parsing in the detector.
 */
export const RULE_EFFECTIVE_SOON_V7: Detector = {
  id: 'RULE_EFFECTIVE_SOON',
  version: 7,
  label: RULE_EFFECTIVE_SOON.label,
  mode: 'SHADOW',
  sources: RULE_EFFECTIVE_SOON.sources,
  lookbackMs: RULE_EFFECTIVE_SOON_V6.lookbackMs,
  entityKeyOf(organization) {
    return employerKey(issuingAgencyOf(organization));
  },
  memberWindowMs: RULE_EFFECTIVE_SOON_PUBLISHED_DAYS * DAY,
  detect(records, now) {
    return detectRuleEffectiveSoonV5(this, records, now, {
      readStatedEffective: true,
      readCorrectedStated: true,
      extraQualifiers: [
        "with no effective_on, the date the Federal Register's own DATES field states, as the connector recorded it",
        "a correction of a rule with no effective_on carries the date that rule's own DATES field states",
      ],
    });
  },
};

/**
 * Every installed rule. Adding one is a new entry here and its tests — nothing else.
 * RULE_EFFECTIVE_SOON v1..v6 stay exported so their recorded rows and readings keep their keys (@1..@6).
 * A model may propose a rule only as a Factory objective (reviewed code, starting
 * in SHADOW); no model output installs, edits or promotes a rule at run time.
 * `proposeRuleRepair` is how a rule's repeated misses become that objective.
 */
export const DETECTORS: readonly Detector[] = [CONCENTRATED_HIRING, REPEATED_DEMAND, RULE_EFFECTIVE_SOON_V7];

// ---------------------------------------------------------------------------
// SHADOW before ACTIVE: readings, promotion and rollback, from rows
// ---------------------------------------------------------------------------

/**
 * What one rule version's detections have shown, read from rows (§45).
 *
 * A SHADOW rule covers nothing, so its members still go to the free screen one
 * by one: that screen is an independent check the rule never saw. A member
 * the screen KEEPs confirms it, one it DROPs is a false join, and an item the
 * screen KEPT from the same entity or family that the rule left out is a miss.
 * Evidence quality is the share of members with the fields a lead needs (a
 * named organisation and a publication date).
 *
 * An ACTIVE rule's members are covered and skip the per-record screen, so its
 * pre-promotion sample would freeze its precision. `auditActiveRule` keeps an
 * audit sample flowing instead: one covered member in `ACTIVE_AUDIT_EVERY` is
 * still screened after it was covered, newest first. The members screened
 * after their coverage are the rule's audit, and their precision
 * (`auditPrecision`) is what an ACTIVE rule is judged on once the audit is
 * large enough, so a rule that degrades returns to SHADOW on new evidence.
 */
export interface RuleReading {
  rule: string;
  detections: number;
  members: number;
  screenedMembers: number;
  confirmed: number;
  falseJoins: number;
  misses: number;
  /** Up to five missed items, `title — url`, verbatim from the rows: what a proposal is about. */
  missedSamples: string[];
  /** Confirmed over screened members; null below the sample a judgment needs. */
  precision: number | null;
  /** Share of members with an organisation and a publication date; null with no members. */
  evidenceQuality: number | null;
  /** Covered members screened after they were covered: the ACTIVE rule's audit sample. */
  auditedMembers?: number;
  /** Confirmed over audited members with a verdict; null below the sample a judgment needs. */
  auditPrecision?: number | null;
}

/** Screened members needed before a rule's precision is read at all. */
export const PROMOTION_MIN_SCREENED = 10;
/** A SHADOW rule is promoted only at or above this precision and evidence quality. */
export const PROMOTION_MIN_PRECISION = 0.8;
export const PROMOTION_MIN_EVIDENCE = 0.8;
/** An ACTIVE rule falling below this precision is returned to SHADOW. */
export const DEMOTION_PRECISION = 0.6;
/** One covered member in this many is still screened, as the ACTIVE rule's audit. */
export const ACTIVE_AUDIT_EVERY = 10;
/** At most this many audit screens per rule per pass, so an audit never floods the free lane. */
export const AUDIT_PER_PASS = 3;

/** Each covered member of a rule version: when it was covered, and when (if ever) it was screened after that. */
async function coverageAudit(detector: Pick<Detector, 'id' | 'version'>): Promise<{ itemId: string; coveredAt: string; auditedAt: string | null }[]> {
  const db = getDb();
  const covered = await db.all<{ item_id: string; covered_at: string }>(
    `SELECT c.item_id, MIN(c.covered_at) AS covered_at FROM feed_item_coverage c
       JOIN feed_detections d ON d.id = c.detection_id
      WHERE d.rule_id = ? AND d.rule_version = ?
      GROUP BY c.item_id`,
    [detector.id, detector.version],
  );
  const screenedAt = new Map<string, string>();
  for (let at = 0; at < covered.length; at += 500) {
    const slice = covered.slice(at, at + 500).map((one) => one.item_id);
    const rows = await db.all<{ subject_id: string; latest: string }>(
      `SELECT subject_id, MAX(created_at) AS latest FROM cheap_results
        WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${slice.map(() => '?').join(',')}) GROUP BY subject_id`,
      slice,
    );
    for (const row of rows) screenedAt.set(row.subject_id, row.latest);
  }
  return covered.map((one) => {
    const latest = screenedAt.get(one.item_id) ?? null;
    return { itemId: one.item_id, coveredAt: one.covered_at, auditedAt: latest && latest > one.covered_at ? latest : null };
  });
}

/** How many more covered members an audit needs to keep one in `every` screened after coverage. Pure. */
export function auditShortfall(covered: number, audited: number, every: number = ACTIVE_AUDIT_EVERY): number {
  return Math.max(0, Math.ceil(covered / Math.max(1, every)) - audited);
}

/**
 * Screen a bounded sample of an ACTIVE rule's covered members with the free
 * models, as an independent audit of the rule (F6). Picks the newest covered
 * members nobody screened since coverage, up to the shortfall against one in
 * `ACTIVE_AUDIT_EVERY` and `AUDIT_PER_PASS`. Returns how many it screened.
 * Nothing runs without a configured lane, so the audit never invents a verdict.
 */
export async function auditActiveRule(
  detector: Pick<Detector, 'id' | 'version'>,
  input: { now?: Date; config?: LaneConfig | null; completer?: Completer; perPass?: number } = {},
): Promise<number> {
  const lane = await import('../cheap/lane.ts');
  const config = input.config === undefined ? lane.laneConfig() : input.config;
  if (!config) return 0;
  const now = input.now ?? new Date();
  const rows = await coverageAudit(detector);
  const audited = rows.filter((one) => one.auditedAt !== null).length;
  const want = Math.min(input.perPass ?? AUDIT_PER_PASS, auditShortfall(rows.length, audited));
  if (want <= 0) return 0;
  const pending = new Set(rows.filter((one) => one.auditedAt === null).map((one) => one.itemId));
  if (pending.size === 0) return 0;
  const ids = [...pending];
  const items: { id: string; source: string; url: string; title: string; organization: string | null; published_at: string | null; fetched_at: string; body: string | null }[] = [];
  for (let at = 0; at < ids.length; at += 500) {
    const slice = ids.slice(at, at + 500);
    items.push(...(await getDb().all<(typeof items)[number]>(
      `SELECT id, source, url, title, organization, published_at, fetched_at, body FROM feed_items WHERE id IN (${slice.map(() => '?').join(',')})`,
      slice,
    )));
  }
  items.sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : a.fetched_at > b.fetched_at ? -1 : a.id.localeCompare(b.id)));
  const health = await lane.modelHealth('SCREEN_LEAD', now);
  let screened = 0;
  for (const item of items.slice(0, want)) {
    await lane.screenLead(
      item.id,
      { source: item.source, title: item.title, organization: item.organization, publishedAt: item.published_at, body: item.body, url: item.url },
      { config, completer: input.completer, now, health },
    );
    screened += 1;
  }
  return screened;
}

async function screenVerdicts(ids: readonly string[]): Promise<Map<string, 'KEEP' | 'DROP'>> {
  const out = new Map<string, 'KEEP' | 'DROP'>();
  if (ids.length === 0) return out;
  const { parseLead, combineLeads } = await import('../cheap/lane.ts');
  const by = new Map<string, Map<string, string | null>>();
  for (let at = 0; at < ids.length; at += 500) {
    const slice = ids.slice(at, at + 500);
    const rows = await getDb().all<{ subject_id: string; model: string; ok: number; output: string | null }>(
      `SELECT subject_id, model, ok, output FROM cheap_results
        WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${slice.map(() => '?').join(',')}) ORDER BY created_at DESC`,
      [...slice],
    );
    for (const row of rows) {
      const models = by.get(row.subject_id) ?? new Map<string, string | null>();
      if (!models.has(row.model)) models.set(row.model, row.ok ? row.output : null);
      by.set(row.subject_id, models);
    }
  }
  for (const [id, models] of by) {
    const merged = combineLeads([...models.values()].map((text) => (text ? parseLead(text) : null)));
    // UNSURE (the models disagreed) is no verdict: it neither confirms nor refutes a member.
    if (merged && (merged.verdict === 'KEEP' || merged.verdict === 'DROP')) out.set(id, merged.verdict);
  }
  return out;
}

/** Read one rule version's detections back against the independent screen. */
export async function ruleReading(detector: Detector, now: Date = new Date()): Promise<RuleReading> {
  const db = getDb();
  const rows = await db.all<{ member_ids: string; entity_key: string | null; category: string | null }>(
    'SELECT member_ids, entity_key, category FROM feed_detections WHERE rule_id = ? AND rule_version = ?',
    [detector.id, detector.version],
  );
  const memberIds = [...new Set(rows.flatMap((row) => JSON.parse(row.member_ids) as string[]))];
  const since = new Date(now.getTime() - detector.lookbackMs - DAY).toISOString();
  const items = await db.all<{ id: string; title: string; url: string; organization: string | null; published_at: string | null; fetched_at: string }>(
    `SELECT id, title, url, organization, published_at, fetched_at FROM feed_items
      WHERE source IN (${detector.sources.map(() => '?').join(',')}) AND fetched_at >= ? LIMIT 5000`,
    [...detector.sources, since],
  );
  const members = new Set(memberIds);
  // Related items are keyed the way the rule keys its own entities, or its misses are invisible.
  const entityKeyOf = (organization: string | null): string | null =>
    detector.entityKeyOf ? detector.entityKeyOf(organization) : employerKey(organization);
  const memberRows = await (async () => {
    if (memberIds.length === 0) return [] as { id: string; organization: string | null; published_at: string | null }[];
    const out: { id: string; organization: string | null; published_at: string | null }[] = [];
    for (let at = 0; at < memberIds.length; at += 500) {
      const slice = memberIds.slice(at, at + 500);
      out.push(...(await db.all<{ id: string; organization: string | null; published_at: string | null }>(
        `SELECT id, organization, published_at FROM feed_items WHERE id IN (${slice.map(() => '?').join(',')})`,
        [...slice],
      )));
    }
    return out;
  })();
  const entities = new Set(rows.map((row) => row.entity_key).filter((one): one is string => !!one));
  const categories = new Set(rows.filter((row) => !row.entity_key).map((row) => row.category).filter((one): one is string => !!one));
  // A miss is an item the rule could have kept: one it reads only as context
  // (outside its membership window) is never a miss, however far back it reads.
  const related = items.filter((item) => !members.has(item.id) && withinMemberWindow(detector, item.published_at, item.fetched_at, now) && (
    entities.has(entityKeyOf(item.organization) ?? '') || categories.has(jobFamily(item.title)?.key ?? '')
  ));
  const verdicts = await screenVerdicts([...memberIds, ...related.map((one) => one.id)]);
  const screened = memberIds.filter((id) => verdicts.has(id));
  const confirmed = screened.filter((id) => verdicts.get(id) === 'KEEP').length;
  const complete = memberRows.filter((row) => row.organization && row.published_at).length;
  const missed = related.filter((one) => verdicts.get(one.id) === 'KEEP');
  // The audit: covered members screened after their coverage, read with the same verdicts.
  const auditedIds = (await coverageAudit(detector)).filter((one) => one.auditedAt !== null).map((one) => one.itemId);
  // Every covered item is a member of this rule's detections, so `verdicts` already holds its screen.
  const auditJudged = auditedIds.filter((id) => verdicts.has(id));
  const auditConfirmed = auditJudged.filter((id) => verdicts.get(id) === 'KEEP').length;
  return {
    rule: `${detector.id}@${detector.version}`,
    detections: rows.length,
    members: memberIds.length,
    screenedMembers: screened.length,
    confirmed,
    falseJoins: screened.length - confirmed,
    misses: missed.length,
    missedSamples: missed.slice(0, 5).map((one) => `${one.title} — ${one.url}`),
    precision: screened.length >= PROMOTION_MIN_SCREENED ? confirmed / screened.length : null,
    evidenceQuality: memberRows.length > 0 ? complete / memberRows.length : null,
    auditedMembers: auditedIds.length,
    auditPrecision: auditJudged.length >= PROMOTION_MIN_SCREENED ? auditConfirmed / auditJudged.length : null,
  };
}

/**
 * The mode a rule runs in this pass, decided from its readings. Pure.
 *
 * The code states where a rule starts; its verified output moves it. A SHADOW
 * rule is promoted only on a sized sample at or above the precision and
 * evidence bars; an ACTIVE rule that falls below the demotion bar returns to
 * SHADOW. Too little screened evidence keeps the stated mode — time alone
 * never promotes. Earlier versions keep their rows (detections are keyed by
 * version), so a demotion or a version change is a rollback with its
 * provenance intact.
 */
export function modeDecision(
  declared: DetectorMode,
  reading: Pick<RuleReading, 'precision' | 'evidenceQuality' | 'screenedMembers' | 'auditPrecision' | 'auditedMembers'>,
): { mode: DetectorMode; reason: string } {
  /*
   * A rule with an audit ran ACTIVE (only ACTIVE covers members), so once the
   * audit is large enough it is judged on what it detects now, not on its
   * pre-promotion sample — whatever mode its code declares. A version demoted
   * this way stays SHADOW: its audit does not grow again, and the correction
   * is a new version, read from zero with this one's rows kept.
   */
  if (reading.auditPrecision !== undefined && reading.auditPrecision !== null) {
    if (reading.auditPrecision < DEMOTION_PRECISION) {
      return { mode: 'SHADOW', reason: `demoted to SHADOW: audit precision ${reading.auditPrecision.toFixed(2)} over ${reading.auditedMembers ?? 0} audited member(s) fell below ${DEMOTION_PRECISION}` };
    }
    return { mode: 'ACTIVE', reason: `ACTIVE: audit precision ${reading.auditPrecision.toFixed(2)} over ${reading.auditedMembers ?? 0} audited member(s)` };
  }
  if (reading.precision === null) return { mode: declared, reason: `${reading.screenedMembers} screened member(s), under the ${PROMOTION_MIN_SCREENED} a judgment needs; ${declared} as stated` };
  if (declared === 'SHADOW') {
    if (reading.precision >= PROMOTION_MIN_PRECISION && (reading.evidenceQuality ?? 0) >= PROMOTION_MIN_EVIDENCE) {
      return { mode: 'ACTIVE', reason: `promoted: precision ${reading.precision.toFixed(2)} and evidence quality ${(reading.evidenceQuality ?? 0).toFixed(2)} meet the bars` };
    }
    return { mode: 'SHADOW', reason: `held in SHADOW: precision ${reading.precision.toFixed(2)}, evidence quality ${(reading.evidenceQuality ?? 0).toFixed(2)}` };
  }
  if (reading.precision < DEMOTION_PRECISION) return { mode: 'SHADOW', reason: `demoted to SHADOW: precision ${reading.precision.toFixed(2)} fell below ${DEMOTION_PRECISION}` };
  return { mode: 'ACTIVE', reason: `ACTIVE: precision ${reading.precision.toFixed(2)}` };
}

// ---------------------------------------------------------------------------
// Repeated misses become a Factory objective, through the one improvement loop
// ---------------------------------------------------------------------------

/**
 * Misses a rule version must show before a new version is proposed. A miss is
 * an item the independent screen KEPT, from an entity or family the rule
 * already recognises, that the rule left out — so this many is a pattern in
 * what the rule cannot see, not one odd record.
 */
export const RULE_MISS_PROPOSAL_MIN = 5;

/** The weakness key a rule version's misses are registered under; a new version is a new family. */
export function ruleMissKey(detector: Pick<Detector, 'id' | 'version'>): string {
  return `DETECTOR_MISSES:${detector.id}@${detector.version}`;
}

/**
 * The weakness a rule's repeated misses are, or null when they are not repeated. Pure.
 *
 * The objective it carries asks Factory — a model writing reviewed code — to
 * propose the connector, extraction or detector change that would have caught
 * the missed items, as a new rule version that starts in SHADOW. Nothing here
 * installs, edits or promotes a rule: the proposal lands as code, is read
 * against the screen like every other rule, and earns ACTIVE only from its own
 * verified output. The earlier version keeps its rows, so the change is a
 * rollback away. No category is a whitelist: the misses decide what to cover.
 */
export function ruleMissWeakness(detector: Pick<Detector, 'id' | 'version' | 'label'>, reading: RuleReading): Weakness | null {
  if (reading.misses < RULE_MISS_PROPOSAL_MIN) return null;
  const rule = `${detector.id}@${detector.version}`;
  const seen = reading.confirmed + reading.misses;
  return {
    key: ruleMissKey(detector),
    kind: 'DETECTOR_MISSES',
    title: `Rule ${rule} (${detector.label}) misses items the independent screen kept`,
    problem:
      `The code rule ${rule} left out ${reading.misses} item(s) the free screen KEPT from entities or families it already recognises ` +
      `(${reading.confirmed} confirmed member(s), ${reading.falseJoins} false join(s)), so those records still go to a model one by one. ` +
      'Propose the connector, extraction schema, normaliser or detector change that would have caught them, as a new version of this rule ' +
      'in server/services/feeds/detectors.ts that starts in SHADOW, with a test built from the missed items below. Do not promote it, ' +
      'lower a bar, or narrow which industries the rule may see: its own readings decide its mode, and the current version keeps its rows.',
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'server/services/feeds/detectors.ts',
    mutationScope: ['server/services/feeds/**', 'tests/**'],
    frequency: reading.misses,
    denominator: Math.max(seen, 1),
    scope: 'LOCAL',
    severity: reading.misses > reading.confirmed ? 'HIGH' : 'MEDIUM',
    researchQuestion: `Which records does code rule ${detector.label} miss, and what extraction or grouping would recognise them?`,
    samples: reading.missedSamples.slice(0, 5),
    knownCause: null,
  };
}

/**
 * Register a rule's repeated misses with the improvement loop (§87), which owns
 * turning a weakness into a Factory objective. Idempotent: the same rule
 * version refreshes its one candidate. Returns the candidate's key, or null
 * when the misses are not repeated.
 */
export async function proposeRuleRepair(detector: Pick<Detector, 'id' | 'version' | 'label'>, reading: RuleReading, now: Date = new Date()): Promise<string | null> {
  const weakness = ruleMissWeakness(detector, reading);
  if (!weakness) return null;
  const { registerDirected } = await import('../improvement/loop.ts');
  const { candidate } = await registerDirected(weakness, now, {
    evidence: { detectorProposal: { rule: reading.rule, misses: reading.misses, confirmed: reading.confirmed, falseJoins: reading.falseJoins } },
  });
  return candidate.weaknessKey;
}

// ---------------------------------------------------------------------------
// Running the rules over what is stored
// ---------------------------------------------------------------------------

interface DetectionRow {
  id: string;
  rule_id: string;
  rule_version: number | string;
  group_key: string;
  member_ids: string;
  source_urls: string;
  window_from: string;
  window_to: string;
  lead_item_id: string | null;
  mode: string;
}

/** A detection older than this is closed; a later cluster for the same group is a new detection. */
export const DETECTION_REOPEN_MS = 30 * DAY;

export interface DetectorRunReport {
  rule: string;
  /** The mode this pass ran the rule in, and why (`modeDecision`). */
  mode: DetectorMode;
  modeReason: string;
  records: number;
  signals: number;
  created: number;
  extended: number;
  covered: number;
  filed: number;
  /** The improvement candidate this rule's repeated misses were registered as, or null. */
  proposed: string | null;
  /** Covered members screened this pass as the ACTIVE rule's audit (`auditActiveRule`). */
  audited: number;
}

/** Run every installed rule once over the stored items it reads. Idempotent. */
export async function runDetectors(input: {
  now?: Date;
  detectors?: readonly Detector[];
  rules?: readonly string[];
  /** The free lane the ACTIVE-rule audit screens with; default the configured one, null for none. */
  audit?: { config?: LaneConfig | null; completer?: Completer };
} = {}): Promise<DetectorRunReport[]> {
  const now = input.now ?? new Date();
  const db = getDb();
  const reports: DetectorRunReport[] = [];
  // `rules` narrows a pass to the rules whose version or data changed: nothing else is recomputed.
  const chosen = (input.detectors ?? DETECTORS).filter((one) => !input.rules || input.rules.includes(one.id));
  for (const detector of chosen) {
    const reading = await ruleReading(detector, now);
    const decision = modeDecision(detector.mode, reading);
    // A proposal is a record for the improvement loop; failing to file one never stops detection.
    const proposed = await proposeRuleRepair(detector, reading, now).catch((error: unknown) => {
      console.warn(`rule proposal for ${reading.rule} not registered: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      return null;
    });
    const since = new Date(now.getTime() - detector.lookbackMs - DAY).toISOString();
    const rows = await db.all<{ id: string; source: string; url: string; title: string; organization: string | null; published_at: string | null; fetched_at: string; body: string | null }>(
      `SELECT id, source, url, title, organization, published_at, fetched_at, body FROM feed_items
        WHERE source IN (${detector.sources.map(() => '?').join(',')}) AND fetched_at >= ?
        ORDER BY fetched_at DESC, id LIMIT 5000`,
      [...detector.sources, since],
    );
    const records: DetectorRecord[] = rows.map((row) => ({
      id: row.id,
      source: row.source,
      url: row.url,
      title: row.title,
      organization: row.organization,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      body: row.body,
    }));
    const signals = detector.detect(records, now);
    const report: DetectorRunReport = { rule: `${detector.id}@${detector.version}`, mode: decision.mode, modeReason: decision.reason, records: records.length, signals: signals.length, created: 0, extended: 0, covered: 0, filed: 0, proposed, audited: 0 };
    for (const signal of signals) {
      const at = now.toISOString();
      const open = await db.get<DetectionRow>(
        `SELECT * FROM feed_detections WHERE rule_id = ? AND rule_version = ? AND group_key LIKE ? AND window_to >= ?
          ORDER BY detected_at DESC LIMIT 1`,
        [detector.id, detector.version, `${signal.groupKey}|%`, new Date(now.getTime() - DETECTION_REOPEN_MS).toISOString()],
      );
      let detectionId: string;
      if (open) {
        const members = [...new Set([...JSON.parse(open.member_ids) as string[], ...signal.memberIds])];
        const urls = [...new Set([...JSON.parse(open.source_urls) as string[], ...signal.sourceUrls])];
        const grew = members.length > (JSON.parse(open.member_ids) as string[]).length;
        if (grew) {
          await db.run(
            `UPDATE feed_detections SET member_ids = ?, source_urls = ?, label = ?, qualifiers = ?, window_from = ?, window_to = ?, updated_at = ? WHERE id = ?`,
            [
              JSON.stringify(members),
              JSON.stringify(urls),
              signal.label,
              JSON.stringify(signal.qualifiers),
              open.window_from < signal.windowFrom ? open.window_from : signal.windowFrom,
              open.window_to > signal.windowTo ? open.window_to : signal.windowTo,
              at,
              open.id,
            ],
          );
          report.extended += 1;
        }
        // A promotion or a rollback carries the open detection with it, so its mode is the rule's current one.
        if (open.mode !== decision.mode) {
          await db.run('UPDATE feed_detections SET mode = ?, updated_at = ? WHERE id = ?', [decision.mode, at, open.id]);
        }
        detectionId = open.id;
      } else {
        detectionId = newId('fdt');
        const result = await db.run(
          `INSERT INTO feed_detections
             (id, rule_id, rule_version, group_key, label, entity_key, category, window_from, window_to,
              member_ids, source_urls, qualifiers, hypothesis, mode, detected_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (rule_id, rule_version, group_key) DO NOTHING`,
          [
            detectionId,
            detector.id,
            detector.version,
            `${signal.groupKey}|${signal.windowFrom.slice(0, 10)}`,
            signal.label,
            signal.entityKey,
            signal.category,
            signal.windowFrom,
            signal.windowTo,
            JSON.stringify(signal.memberIds),
            JSON.stringify(signal.sourceUrls),
            JSON.stringify(signal.qualifiers),
            signal.hypothesis,
            decision.mode,
            at,
            at,
          ],
        );
        if (!(result.changes ?? 0)) {
          // Another tick won; use its row.
          const won = await db.get<{ id: string }>(
            'SELECT id FROM feed_detections WHERE rule_id = ? AND rule_version = ? AND group_key = ?',
            [detector.id, detector.version, `${signal.groupKey}|${signal.windowFrom.slice(0, 10)}`],
          );
          if (!won) continue;
          detectionId = won.id;
        } else {
          report.created += 1;
        }
      }
      if (decision.mode !== 'ACTIVE') continue;
      for (const itemId of signal.memberIds) {
        const covered = await db.run(
          'INSERT INTO feed_item_coverage (item_id, detection_id, covered_at) VALUES (?, ?, ?) ON CONFLICT (item_id, detection_id) DO NOTHING',
          [itemId, detectionId, at],
        );
        report.covered += covered.changes ?? 0;
      }
      if (signal.deliverable && (await fileDetectionLead(detectionId, signal))) report.filed += 1;
    }
    // An ACTIVE rule's covered members keep an audit sample screened, so its precision can still move (F6).
    if (decision.mode === 'ACTIVE') {
      report.audited = await auditActiveRule(detector, { now, config: input.audit?.config, completer: input.audit?.completer }).catch(() => 0);
    }
    reports.push(report);
  }
  return reports;
}

async function fileDetectionLead(detectionId: string, signal: DetectedSignal): Promise<boolean> {
  const db = getDb();
  const row = await db.get<{ lead_item_id: string | null }>('SELECT lead_item_id FROM feed_detections WHERE id = ?', [detectionId]);
  if (!row || row.lead_item_id) return false;
  await insertFeedItems(CODE_SIGNAL_SOURCE, [
    {
      externalId: detectionId,
      url: signal.sourceUrls[0]!,
      title: `${signal.entityName ?? 'An employer'}: ${signal.label}`,
      body:
        `Recognised by code (rule ${signal.category ?? ''}). Titles: ${signal.memberTitles.join('; ')}. ` +
        `Sources: ${signal.sourceUrls.slice(0, 5).join(' ')}. ` +
        `Hypothesis, not established: ${signal.hypothesis ?? 'none'}. ` +
        `Limits: ${signal.qualifiers.join('; ')}.`,
      organization: signal.entityName,
      publishedAt: signal.windowTo,
    },
  ]);
  const item = await db.get<{ id: string }>('SELECT id FROM feed_items WHERE source = ? AND external_id = ?', [CODE_SIGNAL_SOURCE, detectionId]);
  if (!item) return false;
  await db.run('UPDATE feed_detections SET lead_item_id = ? WHERE id = ? AND lead_item_id IS NULL', [item.id, detectionId]);
  return true;
}

/** The detection behind each code-signal lead item, for the shortlist. */
export async function detectionsForLeads(itemIds: readonly string[]): Promise<Map<string, { label: string; category: string | null; deliverable: DeliverableKind | null; organization: string | null }>> {
  const out = new Map<string, { label: string; category: string | null; deliverable: DeliverableKind | null; organization: string | null }>();
  if (itemIds.length === 0) return out;
  const rows = await getDb().all<{ lead_item_id: string; label: string; category: string | null }>(
    `SELECT lead_item_id, label, category FROM feed_detections WHERE lead_item_id IN (${itemIds.map(() => '?').join(',')})`,
    [...itemIds],
  );
  for (const row of rows) {
    const family = JOB_FAMILIES.find((one) => one.key === row.category) ?? null;
    out.set(row.lead_item_id, { label: row.label, category: row.category, deliverable: family?.deliverable ?? null, organization: null });
  }
  return out;
}

/** Items a detection accounts for, among these. */
export async function coveredItems(itemIds: readonly string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await getDb().all<{ item_id: string }>(
    `SELECT DISTINCT item_id FROM feed_item_coverage WHERE item_id IN (${itemIds.map(() => '?').join(',')})`,
    [...itemIds],
  );
  return new Set(rows.map((row) => row.item_id));
}

export interface DetectionReading {
  byRule: { rule: string; mode: string; detections: number; leads: number }[];
  /** Raw items a detection covers. */
  covered: number;
  /** Of those, how many no free model was ever asked about: the calls actually avoided. */
  coveredUnscreened: number;
}

export async function detectionReading(): Promise<DetectionReading> {
  const db = getDb();
  const rules = await db.all<{ rule: string; mode: string; n: number | string; leads: number | string }>(
    `SELECT rule_id || '@' || rule_version AS rule, mode, COUNT(*) AS n, COUNT(lead_item_id) AS leads
       FROM feed_detections GROUP BY rule_id, rule_version, mode ORDER BY rule_id`,
  );
  const covered = await db.get<{ n: number | string }>('SELECT COUNT(DISTINCT item_id) AS n FROM feed_item_coverage');
  const unscreened = await db.get<{ n: number | string }>(
    `SELECT COUNT(DISTINCT c.item_id) AS n FROM feed_item_coverage c
      WHERE NOT EXISTS (SELECT 1 FROM cheap_results r WHERE r.kind = 'SCREEN_LEAD' AND r.subject_id = c.item_id)`,
  );
  return {
    byRule: rules.map((row) => ({ rule: row.rule, mode: row.mode, detections: Number(row.n), leads: Number(row.leads) })),
    covered: Number(covered?.n ?? 0),
    coveredUnscreened: Number(unscreened?.n ?? 0),
  };
}
