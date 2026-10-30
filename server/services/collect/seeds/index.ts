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

const HOUR = 3_600_000;

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

const FR =
  'https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest&conditions%5Btype%5D%5B%5D=';
const FR_FIELDS =
  '&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=html_url&fields%5B%5D=publication_date';

export const SEED_SOURCES: readonly SeedSource[] = [
  {
    slug: 'fr-proposed-rules', label: 'Federal Register: proposed rules open for comment', kind: 'JSON_API',
    urlTemplate: `${FR}PRORULE${FR_FIELDS}`, parserId: 'json:federal-register', intervalMs: 12 * HOUR, hostRatePerMin: 10,
    basis: 'US government public API, no key (federalregister.gov/developers)',
  },
  {
    slug: 'fr-notices', label: 'Federal Register: new agency notices', kind: 'JSON_API',
    urlTemplate: `${FR}NOTICE${FR_FIELDS}`, parserId: 'json:federal-register', intervalMs: 12 * HOUR, hostRatePerMin: 10,
    basis: 'US government public API, no key (federalregister.gov/developers)',
  },
  {
    slug: 'fda-recalls-rss', label: 'FDA recalls and safety alerts', kind: 'RSS_ATOM',
    urlTemplate: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml', parserId: 'rss:default',
    intervalMs: 6 * HOUR, hostRatePerMin: 6, basis: 'US government public RSS feed',
  },
  {
    slug: 'cisa-advisories-rss', label: 'CISA cybersecurity advisories', kind: 'RSS_ATOM',
    urlTemplate: 'https://www.cisa.gov/cybersecurity-advisories/all.xml', parserId: 'rss:default',
    intervalMs: 6 * HOUR, hostRatePerMin: 6, basis: 'US government public RSS feed',
  },
  {
    slug: 'grants-gov-new-opportunities', label: 'Grants.gov: newly posted funding opportunities', kind: 'RSS_ATOM',
    urlTemplate: 'https://www.grants.gov/rss/GG_NewOppByCategory.xml', parserId: 'rss:default',
    intervalMs: 12 * HOUR, hostRatePerMin: 6, basis: 'US government public RSS feed (funding, not procurement)',
  },
  {
    slug: 'watch-dol-state-minimum-wage', label: 'US DOL: state minimum wage laws page', kind: 'PAGE_WATCH',
    urlTemplate: 'https://www.dol.gov/agencies/whd/minimum-wage/state', parserId: 'watch:default',
    intervalMs: 24 * HOUR, hostRatePerMin: 2, basis: 'Public US government page; one read a day, change recorded by content hash',
  },
];

/** How the collectors read each parserId. */
export const SEED_MAPPINGS: Record<string, Record<string, string>> = {
  'json:federal-register': { items: 'results', id: 'document_number', title: 'title', url: 'html_url', publishedAt: 'publication_date', body: 'abstract' },
  'rss:default': {},
  'watch:default': {},
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
