import { type CollectOptions, type CollectOutcome, type FetchedBody } from './types.ts';
import { recordFrom, run } from './shared.ts';

interface Element {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
}

/** OpenStreetMap Overpass JSON: one record per named element; coordinates become the location. */
export function collectOverpass(fetched: FetchedBody, options: CollectOptions): CollectOutcome {
  return run(fetched, options.previous, () => {
    const data = JSON.parse(fetched.body) as { elements?: Element[] };
    const records = (Array.isArray(data.elements) ? data.elements : [])
      .map((el) => {
        const tags = el.tags ?? {};
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        const street = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(' ');
        return recordFrom(
          {
            externalId: el.type && el.id !== undefined ? `osm:${el.type}/${el.id}` : null,
            url: tags.website ?? tags['contact:website'] ?? (el.type && el.id !== undefined ? `https://www.openstreetmap.org/${el.type}/${el.id}` : null),
            title: tags.name,
            organization: tags.operator ?? tags.brand ?? tags.name,
            location: street || (typeof lat === 'number' && typeof lon === 'number' ? `${lat},${lon}` : null),
            body: Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('; '),
          },
          'https://www.openstreetmap.org/',
        );
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.title !== null);
    return { records };
  }, options.maxRecords);
}
