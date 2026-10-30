/** OpenStreetMap Overpass elements to records: a mapped, named place with its tags. */
import { buildRecord } from './record.ts';
import { at } from './json.ts';
import type { CollectedRecord } from './types.ts';

export function parseOverpassRecords(body: unknown): CollectedRecord[] {
  const elements = at(body, 'elements');
  if (!Array.isArray(elements)) return [];
  const out: CollectedRecord[] = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const e = el as Record<string, unknown>;
    const tags = e['tags'] && typeof e['tags'] === 'object' ? (e['tags'] as Record<string, unknown>) : {};
    const name = typeof tags['name'] === 'string' ? tags['name'] : null;
    const id = `${typeof e['type'] === 'string' ? e['type'] : 'node'}/${String(e['id'] ?? '')}`;
    if (!name || !e['id']) continue;
    const website = typeof tags['website'] === 'string' ? tags['website'].trim().split(/[;\s]/)[0] : null;
    const url = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : `https://www.openstreetmap.org/${id}`;
    const category = ['shop', 'craft', 'amenity', 'office', 'leisure'].map((k) => (typeof tags[k] === 'string' ? tags[k] : null)).find(Boolean) ?? null;
    const place = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter((v) => typeof v === 'string').join(' ');
    const r = buildRecord({ externalId: id, url, title: name, body: category ? `${name} (${category})` : null, organization: name, location: place || null });
    if (r) out.push(r);
  }
  return out;
}
