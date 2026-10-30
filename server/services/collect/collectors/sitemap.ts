/** A sitemap, or a sitemap index. Index entries come back as `next` pages to follow, within the caller's limit. */
import { buildRecord } from './record.ts';
import { childText, find, parseXml } from './xml.ts';
import type { CollectedRecord } from './types.ts';

export function parseSitemap(body: string): { records: CollectedRecord[]; sitemaps: string[] } {
  const root = parseXml(body);
  const sitemaps = find(root, 'sitemap').map((n) => childText(n, 'loc')).filter((v): v is string => !!v);
  const records: CollectedRecord[] = [];
  for (const u of find(root, 'url')) {
    const loc = childText(u, 'loc');
    if (!loc) continue;
    const slug = decodeURIComponent(loc.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '').split('/').pop() ?? '') || loc;
    const record = buildRecord({ externalId: loc, url: loc, title: slug.replace(/[-_]+/g, ' '), publishedAt: childText(u, 'lastmod') });
    if (record) records.push(record);
  }
  return { records, sitemaps };
}
