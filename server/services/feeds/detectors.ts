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

/**
 * Every installed rule. Adding one is a new entry here and its tests — nothing else.
 * A model may propose a rule only as a Factory objective (reviewed code, starting
 * in SHADOW); no model output installs, edits or promotes a rule at run time.
 * `proposeRuleRepair` is how a rule's repeated misses become that objective.
 */
export const DETECTORS: readonly Detector[] = [CONCENTRATED_HIRING, REPEATED_DEMAND, RULE_EFFECTIVE_SOON];

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
  const items = await db.all<{ id: string; title: string; url: string; organization: string | null; published_at: string | null }>(
    `SELECT id, title, url, organization, published_at FROM feed_items
      WHERE source IN (${detector.sources.map(() => '?').join(',')}) AND fetched_at >= ? LIMIT 5000`,
    [...detector.sources, since],
  );
  const members = new Set(memberIds);
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
  const related = items.filter((item) => !members.has(item.id) && (
    entities.has(employerKey(item.organization) ?? '') || categories.has(jobFamily(item.title)?.key ?? '')
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
