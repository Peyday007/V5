/**
 * Public sources Brain collects by plain code, as data.
 *
 * Each is keyless and free, from a US government publisher that offers it for
 * reuse. Seeding is an idempotent insert into `collect_sources` (by slug) and
 * leaves robots/terms `UNCHECKED`, which the registry never treats as due:
 * a source starts to be pulled only after `recordRobotsChecks` has read the
 * publisher's robots.txt and recorded what it found. Nothing here is assumed
 * allowed, and nothing is fetched at import time.
 *
 * What the mapping names is how the existing collectors read the response
 * (`collectJsonApi`, `collectRss`, `collectPageWatch`); a new source of one of
 * these kinds is a new entry here and no new code.
 */
import { addCollectSource } from '../../../repos/collectSources.ts';
import type { CollectSource, SourceKind } from '../../../domain/collect.ts';
import { SOURCE_ROWS, expandUrl } from '../../feeds/sources.ts';

export interface SeedSource {
  slug: string;
  label: string;
  kind: SourceKind;
  urlTemplate: string;
  /** Names the mapping below that tells the collector how to read the body. */
  parserId: string;
  intervalMs: number;
  hostRatePerMin: number;
  /** What the publisher is, and why a pull of it is permitted: published for reuse, no key. */
  basis: string;
}

const HOUR = 3_600_000;
const DEFAULT_RATE_PER_MIN = 10;
const REGISTRY_KIND: Record<string, SourceKind> = { JSON_API: 'JSON_API', RSS_ATOM: 'RSS_ATOM', CSV: 'CSV_DATASET', PAGE_WATCH: 'PAGE_WATCH', OSM_OVERPASS: 'OVERPASS' };
const KIND_PREFIX: Record<string, string> = { JSON_API: 'json', RSS_ATOM: 'rss', PAGE_WATCH: 'watch', CSV_DATASET: 'csv' };

/**
 * There is one registry definition: `SOURCE_ROWS` in `feeds/sources.ts`, which is
 * what `pullDueFeeds` pulls. These seeds are a projection of its shared rows
 * into `collect_sources`, never a second list that can drift from it.
 */
export const SEED_SOURCES: readonly SeedSource[] = SOURCE_ROWS.filter((r) => r.ownerProjectId === null).map((r) => ({
  slug: r.id,
  label: r.label,
  kind: REGISTRY_KIND[r.kind] ?? 'JSON_API',
  urlTemplate: expandUrl(r),
  parserId: `${KIND_PREFIX[REGISTRY_KIND[r.kind] ?? r.kind] ?? r.kind.toLowerCase()}:${r.parserId ?? 'default'}`,
  intervalMs: r.intervalHours * HOUR,
  hostRatePerMin: r.spacingMs ? Math.max(1, Math.floor(60_000 / r.spacingMs)) : DEFAULT_RATE_PER_MIN,
  basis: r.robots.note,
}));

/** How the collectors read each parserId. Federal Register has a mapping; the rest read by their kind's default. */
export const SEED_MAPPINGS: Record<string, Record<string, string>> = {
  ...Object.fromEntries(SEED_SOURCES.map((s) => [s.parserId, {} as Record<string, string>])),
  'json:federal-register': { items: 'results', id: 'document_number', title: 'title', url: 'html_url', publishedAt: 'publication_date', body: 'abstract' },
};

/** Insert every seed source that is not already there. Safe to run any number of times. */
export async function seedSources(projectId: string | null = null): Promise<CollectSource[]> {
  const out: CollectSource[] = [];
  for (const s of SEED_SOURCES) {
    out.push(await addCollectSource({
      projectId, slug: s.slug, label: s.label, kind: s.kind, urlTemplate: s.urlTemplate,
      parserId: s.parserId, intervalMs: s.intervalMs, hostRatePerMin: s.hostRatePerMin,
    }));
  }
  return out;
}
