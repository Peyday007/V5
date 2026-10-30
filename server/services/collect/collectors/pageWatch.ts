import { contentHash, plainText } from '../normalize/index.ts';
import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { recordFrom, refusalFor, unchanged } from './shared.ts';

/**
 * Page-change watch: the page is one record whose content hash is taken over
 * the visible text, so markup churn, scripts and whitespace do not count as a
 * change. First sight (no previous hash) returns the record; an identical hash
 * is UNCHANGED; a different hash returns the record again for the diff layer.
 */
export function collectPageWatch(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  const refusal = refusalFor(fetched.status, fetched.body);
  if (refusal) return { kind: 'REFUSED', refusal };
  const visible = (plainText(fetched.body.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' '), 1_000_000) ?? '');
  const hash = contentHash(visible);
  const skip = unchanged(fetched, options.previous, hash);
  if (skip) return skip;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(fetched.body)?.[1] ?? null;
  const record = recordFrom({ externalId: options.url, url: options.url, title: title ?? options.url, body: visible.slice(0, 2000) }, options.url);
  if (!record || visible.length === 0)
    return { kind: 'NO_MATCHING_RECORDS', contentHash: hash, etag: fetched.etag ?? null, lastModified: fetched.lastModified ?? null };
  return {
    kind: 'RECORDS',
    records: [{ ...record, contentHash: hash }],
    contentHash: hash,
    etag: fetched.etag ?? null,
    lastModified: fetched.lastModified ?? null,
    nextPage: null,
  };
}
