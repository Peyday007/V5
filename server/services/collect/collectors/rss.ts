import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { attr, recordFrom, run, tagText } from './shared.ts';

/** RSS 2.0 and Atom. Feed-level paging (Atom rel="next") is returned, not followed. */
export function collectRss(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  return run(fetched, options.previous, () => {
    const xml = fetched.body;
    const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    const records = items
      .map((item) => {
        const linkTag = [...item.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => (attr(t, 'rel') ?? 'alternate') === 'alternate');
        const link = linkTag ? (attr(linkTag, 'href') ?? null) : null;
        const plainLink = tagText(item, 'link');
        return recordFrom(
          {
            externalId: tagText(item, 'guid') ?? tagText(item, 'id'),
            url: link ?? (plainLink && !plainLink.includes('<') ? plainLink.trim() : null),
            title: tagText(item, 'title'),
            organization: tagText(item, 'dc:creator') ?? tagText(item, 'author') ?? tagText(item, 'name') ?? tagText(item, 'source'),
            publishedAt: tagText(item, 'pubDate') ?? tagText(item, 'published') ?? tagText(item, 'updated') ?? tagText(item, 'dc:date'),
            location: tagText(item, 'georss:featurename') ?? tagText(item, 'location'),
            body: tagText(item, 'description') ?? tagText(item, 'summary') ?? tagText(item, 'content'),
            amount: tagText(item, 'price') ?? null,
          },
          options.url,
        );
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const outside = xml.replace(/<(item|entry)\b[\s\S]*?<\/\1>/gi, '');
    const next = [...outside.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'rel') === 'next');
    return { records, nextPage: next ? attr(next, 'href') : null };
  }, options.maxRecords);
}
