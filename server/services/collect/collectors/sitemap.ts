import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { recordFrom, run, tagText } from './shared.ts';

/** sitemap.xml: one record per <url>. A sitemap index is returned as records of child sitemaps. */
export function collectSitemap(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  return run(fetched, options.previous, () => {
    const entries = [...fetched.body.matchAll(/<(url|sitemap)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    const records = entries
      .map((entry) => {
        const loc = tagText(entry, 'loc')?.trim() ?? null;
        return recordFrom({ url: loc, title: loc, publishedAt: tagText(entry, 'lastmod') }, options.url);
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    return { records };
  }, options.maxRecords);
}
