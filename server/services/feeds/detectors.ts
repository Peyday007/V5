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
import { learnedDetectorsFor } from './learned.ts';
import { runSearchMaintenance } from './searchMaintenance.ts';
import { newId } from '../../repos/util.ts';
import { insertFeedItems } from '../../repos/feeds.ts';
import { DELIVERABLE_LABEL, type DeliverableKind } from '../cash/deliverables/spec.ts';

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

/** Every installed rule. Adding one is a new entry here and its tests — nothing else. */
export const DETECTORS: readonly Detector[] = [CONCENTRATED_HIRING];

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
  records: number;
  signals: number;
  created: number;
  extended: number;
  covered: number;
  filed: number;
}

/** Run every installed rule once over the stored items it reads. Idempotent. */
export async function runDetectors(input: { now?: Date; detectors?: readonly Detector[] } = {}): Promise<DetectorRunReport[]> {
  const now = input.now ?? new Date();
  const db = getDb();
  const reports: DetectorRunReport[] = [];
  let installed: readonly Detector[] | undefined = input.detectors;
  if (!installed) {
    // What was learned is judged first (failing methods paused, detectors
    // promoted or demoted on measured precision), then the GENERAL detectors
    // run beside the code ones. Feed items are shared, so a private detector
    // never fires on them. A failure here must not stop the code detectors.
    try {
      await runSearchMaintenance(now);
    } catch {
      /* the code detectors below still run */
    }
    let learned: Detector[] = [];
    try {
      learned = await learnedDetectorsFor({ projectIds: [], userId: null });
    } catch {
      /* none */
    }
    installed = [...DETECTORS, ...learned];
  }
  for (const detector of installed) {
    const since = new Date(now.getTime() - detector.lookbackMs - DAY).toISOString();
    const rows = await db.all<{ id: string; source: string; url: string; title: string; organization: string | null; published_at: string | null; fetched_at: string }>(
      `SELECT id, source, url, title, organization, published_at, fetched_at FROM feed_items
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
    }));
    const signals = detector.detect(records, now);
    const report: DetectorRunReport = { rule: `${detector.id}@${detector.version}`, records: records.length, signals: signals.length, created: 0, extended: 0, covered: 0, filed: 0 };
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
            detector.mode,
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
      if (detector.mode !== 'ACTIVE') continue;
      for (const itemId of signal.memberIds) {
        const covered = await db.run(
          'INSERT INTO feed_item_coverage (item_id, detection_id, covered_at) VALUES (?, ?, ?) ON CONFLICT (item_id, detection_id) DO NOTHING',
          [itemId, detectionId, at],
        );
        report.covered += covered.changes ?? 0;
      }
      if (signal.deliverable && (await fileDetectionLead(detectionId, signal))) report.filed += 1;
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
