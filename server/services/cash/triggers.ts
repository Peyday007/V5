/**
 * Triggers: jobs nobody posted.
 *
 * Most businesses never ask for help in public, but something happens to them
 * that means they need it soon — a job ad nobody could fill, a platform they
 * depend on shutting down, the same complaint in every review. A trigger is a
 * discovery bucket that asks for *specific named businesses* where one such
 * event happened recently, what job it implies, and a published business
 * contact. Every answer is still a published, dated artefact through the same
 * evidence gate: a trigger asks where to look, never what to conclude.
 *
 * Off until the free-model lane is connected (`triggersEnabled`). Which
 * triggers pay is read from rows on the scoreboard; a
 * trigger that never produces a candidate is visible as such.
 */
import type { SearchBucket } from './discovery.ts';
import { getDb } from '../../db/database.ts';

/**
 * On once the free-model lane is connected, because the lane is what sorts
 * the volume triggers produce (the owner, 2026-10-23: "make it start when I
 * add the free APIs"). `BRAIN_TRIGGERS=on` forces it on, `off` holds it off.
 */
export function triggersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env['BRAIN_TRIGGERS']?.trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  // The lane is on with either address: OmniRoute, or the RunPod GPU in primary mode (`cheap/runpod.ts`).
  if (env['BRAIN_CHEAP_LLM_URL']?.trim()) return true;
  return Boolean(env['BRAIN_RUNPOD_URL']?.trim()) && env['BRAIN_RUNPOD_MODE']?.trim().toLowerCase() === 'primary';
}

const ASK =
  'Name each specific business, the date of the event and the source that shows it, the exact ' +
  'job it now needs done, why it needs it soon, and a business email or contact page the ' +
  'business itself publishes. Only events from the last 30 days, and only work deliverable by ' +
  'email as documents, spreadsheets, data, simple websites or graphics?';

export const TRIGGER_BUCKETS: readonly SearchBucket[] = Object.freeze([
  {
    id: 'trigger-stale-job-post',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DATASET',
    title: 'Small businesses with a job ad nobody has filled',
    question:
      'Which small businesses have had the same job posting open for 45 days or more for work ' +
      'that is really a bounded task (data entry, spreadsheets, reports, listings, simple web ' +
      `updates), so they would likely pay to have the task done instead? ${ASK}`,
  },
  {
    id: 'trigger-platform-sunset',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DATASET',
    title: 'Businesses stuck on a tool that is shutting down',
    question:
      'Which specific businesses publicly use a software product, plugin, website builder or ' +
      'marketplace that has announced it is shutting down, removing a feature or forcing a ' +
      `migration by a stated date, so they must move their data or rebuild a page? ${ASK}`,
  },
  {
    id: 'trigger-review-complaint',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'WEBSITE',
    title: 'Businesses whose reviews keep naming the same fixable problem',
    question:
      'Which specific small businesses have several recent public reviews naming the same ' +
      'fixable problem — wrong hours, no online booking, no price list, an unusable website, ' +
      `slow replies to quote requests — that a document, page or simple tool would fix? ${ASK}`,
  },
  {
    id: 'trigger-new-location',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'WEBSITE',
    title: 'Businesses that just opened or announced a new location',
    question:
      'Which specific businesses have just filed, announced or opened a new location, licence ' +
      'or permit, and do not yet have a page, listing, menu, price sheet or forms for it? ' +
      ASK,
  },
  {
    id: 'trigger-new-rule',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DOCUMENT',
    title: 'Named businesses a new rule hits before a deadline',
    question:
      'Which specific businesses, by name, fall under a newly published rule, standard or ' +
      'platform policy that requires a document, notice, policy page or data file by a stated ' +
      `date, and have not yet published one? ${ASK}`,
  },
  {
    id: 'trigger-funded-hiring-sales',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DATASET',
    title: 'Small companies that just raised money and are hiring salespeople',
    question:
      'Which specific small companies have recently announced funding and are hiring sales or ' +
      'business-development staff, so they need lead lists, prospect research or outreach ' +
      `material now? ${ASK}`,
  },
  {
    id: 'trigger-leadership-change',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'SPREADSHEET',
    title: 'Small companies with a new owner or new operations lead',
    question:
      'Which specific small companies have publicly announced a new owner, CEO, operations or ' +
      'finance lead in the last 30 days — the period when a new leader buys reports, trackers ' +
      `and process documents? ${ASK}`,
  },
  {
    id: 'trigger-competitor-move',
    mechanism: 'PAIN_TRIGGERED_IMPLEMENTATION',
    deliverable: 'DOCUMENT',
    title: 'Businesses whose direct competitor just changed the game',
    question:
      'Which specific small businesses have a direct local or niche competitor that just ' +
      'launched online booking, a new price list, a new site or a new offer, leaving them ' +
      `visibly behind on the same page or listing? ${ASK}`,
  },
]);

// ---------------------------------------------------------------------------
// Code-composed trigger searches
// ---------------------------------------------------------------------------

/**
 * One stored observation a trigger's search can name: the business, the
 * event, its date and the published source that shows it — all already held
 * in Brain's feed rows, so nobody has to be asked to find them.
 */
export interface TriggerSubject {
  name: string;
  event: string;
  date: string;
  url: string;
}

export interface TriggerQuery {
  bucketId: string;
  /** CODE: composed from stored rows, no model-written prompt. PROMPT: no stored signal, the bucket's own question. */
  origin: 'CODE' | 'PROMPT';
  subjects: TriggerSubject[];
  question: string;
}

const DAY = 86_400_000;
/** At most this many named subjects in one search: enough to work, small enough to verify each one. */
export const TRIGGER_MAX_SUBJECTS = 12;

type SignalReader = (now: Date) => Promise<TriggerSubject[]>;

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** One subject per business: the first (most recent) row for a name wins. */
function distinctByName(subjects: TriggerSubject[]): TriggerSubject[] {
  const seen = new Set<string>();
  return subjects.filter((one) => {
    const key = one.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, TRIGGER_MAX_SUBJECTS);
}

/**
 * Which stored rows a trigger reads. A bucket absent here has no source Brain
 * already parses deterministically, and keeps its own question.
 */
const SIGNAL_READERS: Readonly<Record<string, SignalReader>> = {
  // A posting first seen 45–120 days ago. Still open is not known from the row; the search asks it.
  'trigger-stale-job-post': async (now) => {
    const rows = await getDb().all<{ organization: string; title: string; published_at: string; url: string }>(
      `SELECT organization, title, published_at, url FROM feed_items
        WHERE source IN ('remoteok', 'remotive') AND organization IS NOT NULL AND organization <> ''
          AND published_at IS NOT NULL AND published_at <= ? AND published_at >= ?
        ORDER BY published_at DESC LIMIT 200`,
      [iso(now.getTime() - 45 * DAY), iso(now.getTime() - 120 * DAY)],
    );
    return distinctByName(rows.map((row) => ({ name: row.organization, event: `posted "${row.title}"`, date: row.published_at.slice(0, 10), url: row.url })));
  },
  // A code detection of concentrated sales hiring by one named employer.
  'trigger-funded-hiring-sales': async (now) => {
    const rows = await getDb().all<{ label: string; entity_key: string; window_to: string; source_urls: string; member_ids: string }>(
      `SELECT label, entity_key, window_to, source_urls, member_ids FROM feed_detections
        WHERE category = 'SALES' AND entity_key IS NOT NULL AND window_to >= ?
        ORDER BY window_to DESC LIMIT 100`,
      [iso(now.getTime() - 30 * DAY)],
    );
    const out: TriggerSubject[] = [];
    for (const row of rows) {
      const first = (JSON.parse(row.member_ids) as string[])[0];
      const named = first
        ? await getDb().get<{ organization: string | null }>('SELECT organization FROM feed_items WHERE id = ?', [first])
        : undefined;
      const url = (JSON.parse(row.source_urls) as string[])[0];
      if (!url) continue;
      out.push({ name: named?.organization?.trim() || row.entity_key, event: row.label, date: row.window_to.slice(0, 10), url });
    }
    return distinctByName(out);
  },
  // A final rule whose stated effective date is within the next 60 days, named by its agency.
  'trigger-new-rule': async (now) => {
    const rows = await getDb().all<{ organization: string | null; title: string; body: string | null; url: string }>(
      `SELECT organization, title, body, url FROM feed_items
        WHERE source = 'federal-register-rules' AND body LIKE '%Effective %' AND fetched_at >= ?
        ORDER BY fetched_at DESC LIMIT 300`,
      [iso(now.getTime() - 90 * DAY)],
    );
    const out: TriggerSubject[] = [];
    for (const row of rows) {
      const effective = /Effective (\d{4}-\d{2}-\d{2})\./.exec(row.body ?? '')?.[1];
      if (!effective) continue;
      const at = Date.parse(`${effective}T00:00:00.000Z`);
      if (!Number.isFinite(at) || at < now.getTime() - DAY || at > now.getTime() + 60 * DAY) continue;
      out.push({ name: row.title, event: `final rule from ${row.organization?.trim() || 'a federal agency'} taking effect`, date: effective, url: row.url });
    }
    // A rule is the subject here, not a business: distinct by title.
    return distinctByName(out);
  },
};

/** The buckets whose search code can compose from stored rows. */
export const CODE_COMPOSED_TRIGGERS: readonly string[] = Object.freeze(Object.keys(SIGNAL_READERS));

const VERIFY =
  'For each one, confirm from a published, dated source that the event is real and current, name the ' +
  'exact job it now implies, and give a business email or contact page the business itself publishes. ' +
  'Say plainly where a listed item does not hold up. Only work deliverable by email as documents, ' +
  'spreadsheets, data, simple websites or graphics.';

/** The search text for stored subjects. Pure: the same rows always give the same words. */
export function composeTriggerQuestion(bucket: SearchBucket, subjects: readonly TriggerSubject[]): string {
  const lead =
    bucket.id === 'trigger-new-rule'
      ? 'Brain holds these newly published rules with a stated effective date. Which specific businesses, by name, each one requires to publish a document, notice, policy page or data file by that date, and which have not yet?'
      : `Brain already holds these observations for "${bucket.title}".`;
  const lines = subjects.map((one) => `\n- ${one.name}: ${one.event} (${one.date}) — ${one.url}`).join('');
  return `${lead}${lines}\n${VERIFY}`;
}

/**
 * A trigger's search for this pass. With stored signals it is composed by code
 * from them — no model-written prompt; without any it is the bucket's own
 * question, exactly as before. A failed read is the fallback, never an error:
 * a trigger keeps working when the feed tables cannot answer.
 */
export async function triggerQuery(bucket: SearchBucket, now: Date = new Date()): Promise<TriggerQuery> {
  const reader = SIGNAL_READERS[bucket.id];
  const subjects = reader ? await reader(now).catch(() => [] as TriggerSubject[]) : [];
  if (subjects.length === 0) return { bucketId: bucket.id, origin: 'PROMPT', subjects: [], question: bucket.question };
  return { bucketId: bucket.id, origin: 'CODE', subjects, question: composeTriggerQuestion(bucket, subjects) };
}

/**
 * The trigger buckets for one discovery pass, each carrying the question
 * `triggerQuery` chose. Same ids, mechanisms and deliverables as
 * `TRIGGER_BUCKETS`, so rounds, the scoreboard and the evidence gate read
 * them unchanged; nothing is scheduled or stored by this.
 */
export async function triggerBucketsFor(now: Date = new Date()): Promise<SearchBucket[]> {
  const out: SearchBucket[] = [];
  for (const bucket of TRIGGER_BUCKETS) out.push({ ...bucket, question: (await triggerQuery(bucket, now)).question });
  return out;
}
