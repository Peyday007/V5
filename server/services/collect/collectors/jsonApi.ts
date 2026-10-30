import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { recordFrom, run } from './shared.ts';

/** Dotted path lookup, e.g. "company.name". */
export function pick(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * JSON API. mapping: { items?: path to the array, title, organization, publishedAt,
 * location, amount, url, id, body, next?: path to the next-page URL or cursor }.
 * Pagination is only what the response itself offers (a next URL); the caller
 * decides whether to follow it within its rate limit.
 */
export function collectJsonApi(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  const map = options.mapping ?? {};
  return run(fetched, options.previous, () => {
    const data: unknown = JSON.parse(fetched.body);
    const list = map.items ? pick(data, map.items) : data;
    const rows = Array.isArray(list) ? list : [];
    const records = rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
      .map((row) =>
        recordFrom(
          {
            externalId: pick(row, map.id ?? 'id') as string | null,
            url: pick(row, map.url ?? 'url'),
            title: pick(row, map.title ?? 'title'),
            organization: pick(row, map.organization ?? 'organization'),
            publishedAt: pick(row, map.publishedAt ?? 'publishedAt'),
            location: pick(row, map.location ?? 'location'),
            amount: pick(row, map.amount ?? 'amount'),
            body: pick(row, map.body ?? 'description'),
          },
          options.url,
        ),
      )
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const next = map.next ? pick(data, map.next) : undefined;
    return { records, nextPage: typeof next === 'string' && next ? next : null };
  }, options.maxRecords);
}
