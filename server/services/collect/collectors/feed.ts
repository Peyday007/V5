/** RSS 2.0, RSS 1.0 and Atom to records. */
import { buildRecord } from './record.ts';
import { child, childText, find, parseXml, type XmlNode } from './xml.ts';
import type { CollectedRecord } from './types.ts';

function linkOf(entry: XmlNode): string | null {
  const links = entry.children.filter((c) => c.name === 'link');
  const alt = links.find((l) => l.attrs['href'] && (!l.attrs['rel'] || l.attrs['rel'] === 'alternate')) ?? links.find((l) => l.attrs['href']);
  return alt?.attrs['href'] ?? childText(entry, 'link') ?? null;
}

export function parseFeed(body: string, baseUrl?: string): CollectedRecord[] {
  const root = parseXml(body);
  const entries = [...find(root, 'item'), ...find(root, 'entry')];
  const out: CollectedRecord[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const link = linkOf(e);
    const author = child(e, 'author');
    const record = buildRecord({
      externalId: childText(e, 'guid', 'id') ?? link,
      url: link ?? childText(e, 'guid'),
      title: childText(e, 'title'),
      body: childText(e, 'content:encoded', 'content', 'description', 'summary'),
      organization: (author && (childText(author, 'name') ?? author.text.trim())) || childText(e, 'dc:creator', 'dc:publisher', 'author'),
      publishedAt: childText(e, 'pubdate', 'published', 'updated', 'dc:date'),
      location: childText(e, 'georss:featurename', 'location'),
      amount: null,
    }, baseUrl);
    if (record && !seen.has(record.externalId)) { seen.add(record.externalId); out.push(record); }
  }
  return out;
}
