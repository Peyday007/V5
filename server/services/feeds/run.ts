/**
 * The volume half of discovery: code pulls, free models sort, Brain's rules
 * check, and Claude sees only a short daily list.
 *
 *   1. pull    — every source whose interval has passed is fetched by plain
 *                code and its new items stored (`feed_items`).
 *   2. screen  — each recent item goes to the cheap lane's SCREEN_LEAD task:
 *                two free models, which must agree to keep it.
 *   3. rules   — a kept lead must be recent, name a deliverable Brain proves,
 *                state a need, and not already be an opening Brain holds.
 *   4. shortlist — once a day the best few go to Claude as one discovery
 *                round. Claude verifies each against its page, through the
 *                evidence gate, and only what it verifies becomes an opening.
 *
 * Nothing here is evidence and nothing here contacts anybody. Off entirely
 * until the cheap lane is configured, because without the free models the
 * volume has nowhere to go but Claude.
 */
import { getDb } from '../../db/database.ts';
import { insertFeedItems, lastPullAt, markShortlisted, recordFeedPull, unlistedFeedItems, type StoredFeedItem } from '../../repos/feeds.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { openingsWithSourceUrl } from '../../repos/cashPortfolio.ts';
import { listRounds, openRound } from '../../repos/cashDiscovery.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { laneConfig, screenLead, type Completer, type LaneConfig, type LeadOutput } from '../cheap/lane.ts';
import { executionFrame, executionFrameSentence } from '../cash/discovery.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { openingSourceKey } from '../cash/duplicates.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { DELIVERABLE_LABEL } from '../cash/deliverables/spec.ts';
import { FEED_SOURCES, type FeedSource } from './sources.ts';
import { FEED_SHORTLIST_BUCKET } from './bucket.ts';

export type Fetcher = (url: string, headers: Record<string, string>) => Promise<unknown>;

export const httpFetcher: Fetcher = async (url, headers) => {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/** How far back a lead may have been published and still be worth asking about. */
export const LEAD_MAX_AGE_MS = 21 * 86_400_000;
/** Leads screened per pass, so one tick never spends the day. */
export const SCREENS_PER_PASS = 60;
/** Leads handed to Claude per shortlist round. */
export const SHORTLIST_SIZE = 10;
/** One shortlist round a day at most. */
export const SHORTLIST_INTERVAL_MS = 20 * 3_600_000;

export async function pullDueFeeds(input: {
  now?: Date;
  fetcher?: Fetcher;
  sources?: readonly FeedSource[];
} = {}): Promise<{ source: string; inserted: number; error: string | null }[]> {
  const now = input.now ?? new Date();
  const out: { source: string; inserted: number; error: string | null }[] = [];
  for (const source of input.sources ?? FEED_SOURCES) {
    const last = await lastPullAt(source.id);
    if (last && now.getTime() - Date.parse(last) < source.intervalMs) continue;
    if (source.spacingMs && out.length > 0 && !input.fetcher) {
      await new Promise((resolve) => setTimeout(resolve, source.spacingMs));
    }
    try {
      const body = await (input.fetcher ?? httpFetcher)(source.url, source.headers ?? {});
      const items = source.parse(body);
      const inserted = await insertFeedItems(source.id, items);
      await recordFeedPull({ source: source.id, ok: true, fetched: items.length, inserted, error: null, at: now.toISOString() });
      out.push({ source: source.id, inserted, error: null });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await recordFeedPull({ source: source.id, ok: false, fetched: 0, inserted: 0, error: message, at: now.toISOString() });
      out.push({ source: source.id, inserted: 0, error: message });
    }
  }
  return out;
}

/** The latest SCREEN_LEAD answers, per item, already combined. */
async function screenedLeads(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb().all<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM cheap_results
      WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${ids.map(() => '?').join(',')})`,
    [...ids],
  );
  return new Set(rows.map((row) => row.subject_id));
}

/** The rules a free model's KEEP must also pass. Pure, so it can be argued with. */
export function leadPassesRules(item: StoredFeedItem, screen: LeadOutput | null, now: Date): boolean {
  if (!screen || screen.verdict !== 'KEEP') return false;
  if (screen.deliverable === 'NONE') return false;
  if (screen.need.length < 4) return false;
  const published = Date.parse(item.publishedAt ?? item.fetchedAt);
  if (!Number.isFinite(published) || now.getTime() - published > LEAD_MAX_AGE_MS) return false;
  return true;
}

/** Screen recent, unscreened leads with the free models. Bounded per pass. */
export async function screenFeedLeads(input: {
  now?: Date;
  config?: LaneConfig | null;
  completer?: Completer;
} = {}): Promise<number> {
  const now = input.now ?? new Date();
  const config = input.config === undefined ? laneConfig() : input.config;
  if (!config) return 0;
  const since = new Date(now.getTime() - LEAD_MAX_AGE_MS).toISOString();
  const recent = await unlistedFeedItems({ since, limit: 2_000 });
  const done = await screenedLeads(recent.map((one) => one.id));
  let screened = 0;
  for (const item of recent) {
    if (screened >= SCREENS_PER_PASS) break;
    if (done.has(item.id)) continue;
    const published = Date.parse(item.publishedAt ?? item.fetchedAt);
    if (Number.isFinite(published) && now.getTime() - published > LEAD_MAX_AGE_MS) continue;
    await screenLead(
      item.id,
      {
        source: item.source,
        title: item.title,
        organization: item.organization,
        publishedAt: item.publishedAt,
        body: item.body,
        url: item.url,
      },
      { config, completer: input.completer, now },
    );
    screened += 1;
  }
  return screened;
}

/** Combined screen answers for these items, read back from rows. */
async function leadScreens(items: readonly StoredFeedItem[]): Promise<Map<string, LeadOutput>> {
  const out = new Map<string, LeadOutput>();
  if (items.length === 0) return out;
  const { parseLead, combineLeads } = await import('../cheap/lane.ts');
  const rows = await getDb().all<{ subject_id: string; model: string; ok: number; output: string | null }>(
    `SELECT subject_id, model, ok, output FROM cheap_results
      WHERE kind = 'SCREEN_LEAD' AND subject_id IN (${items.map(() => '?').join(',')})
      ORDER BY created_at DESC`,
    items.map((one) => one.id),
  );
  const by = new Map<string, (LeadOutput | null)[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.subject_id}\n${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    by.set(row.subject_id, [...(by.get(row.subject_id) ?? []), row.ok && row.output ? parseLead(row.output) : null]);
  }
  for (const [id, answers] of by) {
    const merged = combineLeads(answers);
    if (merged) out.set(id, merged);
  }
  return out;
}

/**
 * Whether a line can go into the question as written. A post's own words are
 * untrusted: a title naming a state would narrow the round's jurisdiction
 * (§25), and one an envelope reads as Brain's own action would get the whole
 * round refused. Checked in the form it is rendered in.
 */
export function safeLeadLine(line: string): boolean {
  const rendered = `- lead: ${line}`;
  if (statesNamedIn(rendered).length > 0) return false;
  return Object.values(APPROVAL_ENVELOPES).every((envelope) => !describesOwnAction(rendered, envelope.forbiddenActions));
}

/** One line of the shortlist question, or null when it cannot be said safely. */
function shortlistLine(item: StoredFeedItem, screen: LeadOutput): string | null {
  const clean = (value: string, max: number) => value.replace(/[.,;:!?—–\n"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const line =
    `"${clean(item.title, 90)}" at ${item.url} — the need as read: ${clean(screen.need, 80)}; ` +
    `the work it could take: ${DELIVERABLE_LABEL[screen.deliverable as keyof typeof DELIVERABLE_LABEL] ?? screen.deliverable}`;
  if (safeLeadLine(line)) return line;
  const bare = `${item.url} — the work it could take: ${screen.deliverable}`;
  return safeLeadLine(bare) ? bare : null;
}

/**
 * Open today's shortlist round for one project, when it is due.
 *
 * It is the one Claude discovery round that `BRAIN_CLAUDE_DISCOVERY=off` does
 * not stop, because it is not bulk finding: it is a strong model verifying a
 * short list the free models and the rules already narrowed.
 */
export async function openFeedShortlist(input: { projectId: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed || !gate.mode) return null;
  const mode = gate.mode;
  const history = (await listRounds(input.projectId)).filter((one) => one.bucketId === FEED_SHORTLIST_BUCKET.id);
  if (history.some((one) => one.state === 'OPEN')) return null;
  const latest = history.reduce<string | null>((max, one) => (!max || one.openedAt > max ? one.openedAt : max), null);
  if (latest && now.getTime() - Date.parse(latest) < SHORTLIST_INTERVAL_MS) return null;

  const since = new Date(now.getTime() - LEAD_MAX_AGE_MS).toISOString();
  const pool = await unlistedFeedItems({ since, limit: 2_000 });
  const screens = await leadScreens(pool);
  const held = new Set(
    (await openingsWithSourceUrl(input.projectId))
      .map(({ sourceUrl }) => openingSourceKey(sourceUrl))
      .filter((key): key is string => !!key),
  );
  const ranked = pool
    .filter((item) => leadPassesRules(item, screens.get(item.id) ?? null, now))
    .filter((item) => {
      const key = openingSourceKey(item.url);
      return !key || !held.has(key);
    })
    .sort((a, b) => {
      const wa = screens.get(a.id)?.window === 'SHORT' ? 0 : 1;
      const wb = screens.get(b.id)?.window === 'SHORT' ? 0 : 1;
      if (wa !== wb) return wa - wb;
      return (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt);
    });
  const chosen: { item: StoredFeedItem; line: string }[] = [];
  for (const item of ranked) {
    if (chosen.length >= SHORTLIST_SIZE) break;
    const line = shortlistLine(item, screens.get(item.id)!);
    if (line) chosen.push({ item, line });
  }
  if (chosen.length === 0) return null;

  const frame = await executionFrame(input.projectId, mode.currency);
  const statement = [
    FEED_SHORTLIST_BUCKET.question,
    `This is for a short cash sprint whose goal is: ${mode.objective}`,
    frame ? executionFrameSentence(frame) : '',
    'Free models read these public posts and kept them; nothing about them is established yet. ' +
      'Open each page. Report as an opening only what the page itself shows, quoting it, and say ' +
      'plainly for each one that does not hold up.',
    ...chosen.map(({ line }) => `\n- lead: ${line}`),
  ]
    .filter(Boolean)
    .join(' ');

  const roundNo = history.reduce((max, one) => Math.max(max, one.round), 0) + 1;
  const round = await getDb().transaction(async () => {
    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: roundNo === 1 ? FEED_SHORTLIST_BUCKET.title : `${FEED_SHORTLIST_BUCKET.title} (round ${roundNo})`,
      statement,
    });
    const result = await openRound({
      projectId: input.projectId,
      cashModeId: mode.id,
      bucketId: FEED_SHORTLIST_BUCKET.id,
      mechanism: FEED_SHORTLIST_BUCKET.mechanism,
      round: roundNo,
      candidateId: candidate.id,
    });
    if (!result.created) throw new ShortlistLost();
    return result.round;
  }).catch((error: unknown) => {
    if (error instanceof ShortlistLost) return null;
    throw error;
  });
  if (!round) return null;
  await markShortlisted(chosen.map(({ item }) => item.id), round.id);
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'CASH_DISCOVERY_OPENED',
    actorRef: 'BRAIN',
    summary: `Feed shortlist opened: ${chosen.length} lead(s) for Claude to verify (round ${roundNo}).`,
    detail: {
      bucketId: FEED_SHORTLIST_BUCKET.id,
      candidateId: round.candidateId,
      cashModeId: mode.id,
      round: roundNo,
      leads: chosen.map(({ item }) => item.id),
    },
  });
  return round.id;
}

class ShortlistLost extends Error {}

/** The project feeds shortlist into: the oldest active sprint. */
export async function shortlistProject(projectIds: readonly string[]): Promise<string | null> {
  for (const id of projectIds) {
    const mode = await getCashMode(id);
    if (mode && mode.state === 'ACTIVE') return id;
  }
  return null;
}
