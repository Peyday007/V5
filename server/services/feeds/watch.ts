/**
 * World Watch: re-reading the pages something waits on, and turning a change
 * into a reason to look again — never into a fact (§65).
 *
 * The owner named changedetection.io. Brain does not run it. Every piece a
 * changedetection.io instance would add is already here: the conditional
 * re-fetch (`conditionalFetcher`: ETag / Last-Modified / content hash →
 * NOT_MODIFIED), the destination guard every read goes through
 * (`checkDestination`), the per-key change ledger and fan-out
 * (`cash/reconsider.ts`), and the research pipeline and claim gate a re-read
 * goes through. A second service would add a Fly app, a webhook, a shared
 * secret and a second record of what changed, to say what one table here
 * says (CLAUDE.md rule 6). What changedetection.io does that this does not —
 * a JavaScript render, visual selectors — is `readSource`'s BROWSER route
 * when a watched page ever needs it.
 *
 * One read of one source:
 *
 *   304, or the same body hash      → validators and schedule refreshed, no row
 *   first read                      → the baseline is stored, no row
 *   same normalised text            → as unchanged, no row
 *   different normalised text       → in one transaction: the source moves
 *                                     forward (guarded), one `source_changes`
 *                                     row, one re-read idea for the research
 *                                     pipeline, one project event
 *
 * The guard (`applyRead`) is the source's own position and the hash the read
 * started from, in the statement that moves it: a late, older read and the
 * same read delivered twice both land nothing (invariant 32).
 *
 * Nothing here writes a claim, a card fact or a construction fact. The idea it
 * creates asks a worker to read the page and submit what it now states, cited,
 * through the gate; the gate decides. Where the watch names a blocker key, the
 * reconsideration pass reads the change row as that key's change
 * (`detectWatchedSources` in `cash/reconsider.ts`) and reconsiders whoever
 * waits on it, which is a reason to evaluate again and never readiness.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import {
  applyRead,
  applyUnchangedRead,
  dueWatchedSources,
  insertSourceChange,
  recordReadFailure,
} from '../../repos/watchedSources.ts';
import type { SourceChange, WatchedSource } from '../../domain/types.ts';
import { conditionalFetcher, type ConditionalResult, type Transport, type TransportResponse, type Validators } from './access.ts';
import { checkDestination, systemResolver, type Resolver } from '../sources/fetchForWorker.ts';

/** The most text kept per source to diff the next read against. */
export const WATCH_TEXT_MAX = 200_000;
/** The most a change row's excerpt carries. */
export const DIFF_EXCERPT_MAX = 800;
/** Sources read per project per pass: a watch is bounded work, never a crawl. */
export const WATCH_CHECKS_PER_PASS = 10;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * The text a change is measured on: tags, scripts and styles out, block
 * boundaries as lines, whitespace collapsed. A page whose markup churns (a
 * nonce, a reordered attribute) without its words changing is unchanged. Pure.
 */
export function normaliseWatchedText(body: string): string {
  const html = /<[a-z!/][^>]*>/i.test(body);
  let text = body;
  if (html) {
    text = text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/?(p|div|li|ul|ol|tr|td|th|table|section|article|header|footer|h[1-6]|main|nav|aside|blockquote|pre|dd|dt)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
        if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16) || 32);
        if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10) || 32);
        return ENTITIES[name.toLowerCase()] ?? whole;
      });
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .slice(0, WATCH_TEXT_MAX);
}

export const textHashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A short excerpt of what changed: lines the new text has that the old did
 * not (`+`), then lines it lost (`-`), bounded. An excerpt is a pointer for
 * the re-read, not a record of what the page says. Pure.
 */
export function diffExcerpt(oldText: string, newText: string, max: number = DIFF_EXCERPT_MAX): string {
  const before = oldText.split('\n');
  const after = newText.split('\n');
  const had = new Set(before);
  const has = new Set(after);
  const lines = [
    ...after.filter((line) => !had.has(line)).map((line) => `+ ${line}`),
    ...before.filter((line) => !has.has(line)).map((line) => `- ${line}`),
  ].map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
  if (lines.length === 0) return '(the same lines, in a different order)';
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > max) {
      out += out ? '\n…' : `${line.slice(0, max - 1)}…`;
      break;
    }
    out += out ? `\n${line}` : line;
  }
  return out;
}

export type WatchOutcome =
  | { kind: 'BASELINE'; sourceId: string }
  | { kind: 'UNCHANGED'; sourceId: string; reason: string }
  | { kind: 'CHANGED'; sourceId: string; change: SourceChange }
  /** The read was older than the source's position, or started from a hash it no longer holds. */
  | { kind: 'STALE'; sourceId: string }
  | { kind: 'FAILED'; sourceId: string; error: string };

/** One read's result, as `applyObservation` takes it. */
export type Observation = ConditionalResult & { fetchedAt: string };

function nextCheck(source: WatchedSource, at: string): string {
  return new Date(Date.parse(at) + source.checkIntervalMinutes * 60_000).toISOString();
}

class Lost extends Error {}

/** The question the re-read idea asks. Names the page and says the change is not evidence. */
function rereadStatement(source: WatchedSource, excerpt: string): string {
  return (
    `Re-read ${source.url}: this watched page changed (watched because: ${source.reason}` +
    `${source.blockerKey ? `; it bears on ${source.blockerKey}` : ''}). ` +
    'Report only what the page now states that bears on that, each claim citing the page itself, ' +
    'and say what no longer appears. That the page changed is not evidence of anything by itself. ' +
    `What changed, as a pointer only:\n${excerpt}`
  ).slice(0, 4000);
}

/**
 * Apply one read to one source, as the caller read the source. Writes at most
 * one change row, and only in the transaction whose guarded move landed.
 */
export async function applyObservation(source: WatchedSource, observation: Observation): Promise<WatchOutcome> {
  const { fetchedAt } = observation;
  const nextCheckAt = nextCheck(source, fetchedAt);
  const validators: Validators = observation.validators;
  if (observation.status === 'NOT_MODIFIED') {
    await applyUnchangedRead(source.id, {
      etag: validators.etag ?? null,
      lastModified: validators.lastModified ?? null,
      bodyHash: validators.contentHash ?? null,
      fetchedAt,
      nextCheckAt,
    });
    return { kind: 'UNCHANGED', sourceId: source.id, reason: observation.reason };
  }
  const text = normaliseWatchedText(observation.body);
  const textHash = textHashOf(text);
  const read = {
    etag: validators.etag ?? null,
    lastModified: validators.lastModified ?? null,
    bodyHash: observation.contentHash,
    textHash,
    text,
    fetchedAt,
    nextCheckAt,
  };
  if (source.textHash === null) {
    return (await applyRead(source.id, null, read)) ? { kind: 'BASELINE', sourceId: source.id } : { kind: 'STALE', sourceId: source.id };
  }
  if (source.textHash === textHash) {
    await applyUnchangedRead(source.id, read);
    return { kind: 'UNCHANGED', sourceId: source.id, reason: 'the normalised text hash equals the stored one' };
  }
  const previousFetchedAt = source.fetchedAt ?? source.createdAt;
  const excerpt = diffExcerpt(source.lastText ?? '', text);
  try {
    const change = await getDb().transaction(async () => {
      if (!(await applyRead(source.id, source.textHash, read))) throw new Lost();
      const idea = await createCandidate({
        projectId: source.projectId,
        visibility: 'SHARED',
        title: `Re-read changed source: ${source.url}`.slice(0, 200),
        statement: rereadStatement(source, excerpt),
      });
      const written = await insertSourceChange({
        projectId: source.projectId,
        watchedSourceId: source.id,
        url: source.url,
        blockerKey: source.blockerKey,
        oldHash: source.textHash!,
        newHash: textHash,
        previousFetchedAt,
        fetchedAt,
        diffExcerpt: excerpt,
        rereadCandidateId: idea.id,
        at: fetchedAt,
      });
      if (!written) throw new Lost();
      await recordEvent({
        projectId: source.projectId,
        entityType: 'watched_source',
        entityId: source.id,
        eventType: 'WATCHED_SOURCE_CHANGED',
        payload: {
          url: source.url,
          blockerKey: source.blockerKey,
          changeId: written.id,
          oldHash: written.oldHash,
          newHash: written.newHash,
          rereadCandidateId: idea.id,
        },
      });
      return written;
    });
    return { kind: 'CHANGED', sourceId: source.id, change };
  } catch (error) {
    if (error instanceof Lost) return { kind: 'STALE', sourceId: source.id };
    throw error;
  }
}

/** A conditional read: `conditionalFetcher` over a guarded transport. */
export type WatchReader = (url: string, prior: Validators | null) => Promise<ConditionalResult>;

const MAX_REDIRECTS = 3;

/**
 * A transport that refuses what `checkDestination` refuses — private
 * addresses, credentials, odd ports and schemes — on the first URL and on
 * every redirect, so a watched page cannot be pointed at Brain's own network.
 */
export function guardedTransport(resolver: Resolver = systemResolver): Transport {
  return async (raw, headers, timeoutMs = 20_000): Promise<TransportResponse> => {
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const allowed = await checkDestination(url, resolver);
      if (!allowed.ok) throw new Error(`refused destination: ${allowed.reason}`);
      const response = await fetch(allowed.url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && response.status !== 304 && location) {
        url = new URL(location, allowed.url).toString();
        continue;
      }
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        out[key] = value;
      });
      return { status: response.status, headers: out, body: response.status === 304 ? '' : await response.text() };
    }
    throw new Error('too many redirects');
  };
}

const productionReader: WatchReader = (url, prior) => conditionalFetcher(guardedTransport())(url, prior);

/**
 * The watched-source tick for one project: read each due source once, apply
 * the read, and leave a failure as a failure (never as "unchanged").
 */
export async function checkDueWatchedSources(
  projectId: string,
  deps: { read?: WatchReader; now?: () => string; limit?: number } = {},
): Promise<WatchOutcome[]> {
  const now = deps.now ?? (() => new Date().toISOString());
  const read = deps.read ?? productionReader;
  const due = await dueWatchedSources(projectId, now(), deps.limit ?? WATCH_CHECKS_PER_PASS);
  const outcomes: WatchOutcome[] = [];
  for (const source of due) {
    let result: ConditionalResult;
    try {
      result = await read(source.url, { etag: source.etag, lastModified: source.lastModified, contentHash: source.bodyHash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const at = now();
      await recordReadFailure(source.id, message, nextCheck(source, at), at);
      outcomes.push({ kind: 'FAILED', sourceId: source.id, error: message.slice(0, 300) });
      continue;
    }
    outcomes.push(await applyObservation(source, { ...result, fetchedAt: now() }));
  }
  return outcomes;
}
