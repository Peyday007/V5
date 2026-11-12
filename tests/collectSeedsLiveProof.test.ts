import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { getCollectSourceBySlug } from '../server/repos/collectSources.ts';
import { httpRobotsFetcher, type RobotsFetcher } from '../server/services/collect/seeds/robots.ts';
import { pullDueFeeds, pullFailureCause, robotsReaderFor } from '../server/services/feeds/run.ts';
import {
  SOURCE_ROWS, UnparseableBody, parseCsv, parseFindATender, parseGleif, parseOverpassElements, sourceFromRow, type FeedSource,
} from '../server/services/feeds/sources.ts';

beforeEach(async () => { await freshProject(); });

const row = (id: string) => {
  const found = SOURCE_ROWS.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

const FTS = {
  releases: [
    { ocid: 'ocds-h6vhtk-04a1b2', id: '012345-2026', date: '2026-11-10T09:00:00Z', buyer: { name: 'Leeds City Council' },
      tender: { title: 'Grounds maintenance', description: 'Three-year contract.', value: { amount: 120000, currency: 'GBP' }, tenderPeriod: { endDate: '2026-12-01T12:00:00Z' } } },
    { ocid: 'ocds-h6vhtk-04a1b3', id: '012346-2026', tender: {} },
  ],
};
const GLEIF = {
  data: [
    { type: 'lei-records', id: '5493001KJTIIGC8Y1R12', attributes: { lei: '5493001KJTIIGC8Y1R12',
      entity: { legalName: { name: 'Acme Fabrication LLC' }, legalAddress: { city: 'Houston', country: 'US' }, status: 'ACTIVE', category: 'GENERAL' },
      registration: { initialRegistrationDate: '2026-11-09T14:00:00Z' } } },
    { type: 'lei-records', id: 'X', attributes: {} },
  ],
};
const OVERPASS = {
  elements: [
    { type: 'way', id: 123, tags: { name: 'Bayou Steel Works', man_made: 'works', product: 'steel', 'addr:city': 'Houston' } },
    { type: 'node', id: 9, tags: { man_made: 'works' } },
  ],
};
const CANADABUYS_HEADER = '﻿"title-titre-eng","referenceNumber-numeroReference","publicationDate-datePublication","noticeURL-URLavis-eng","contractingEntityName-nomEntitContractante-eng","tenderDescription-descriptionAppelOffres-eng"';
const CANADABUYS = `${CANADABUYS_HEADER}\n"Snow removal, Ottawa","PW-26-01234","2026-11-10","https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/pw-26-01234","Public Services and Procurement Canada","Winter 2026-27."\n`;

describe('the sources the finding said were missing are data, and each kind is read by code', () => {
  it('registers a procurement feed, a CSV dataset, a business register and an OSM category, each buildable', () => {
    const tenders = row('find-a-tender-ocds');
    const csv = row('canadabuys-new-tenders-csv');
    const register = row('gleif-new-lei-registrations');
    const osm = row('osm-houston-factories');
    expect(csv.kind).toBe('CSV');
    expect(osm.kind).toBe('OSM_OVERPASS');
    for (const r of [tenders, csv, register, osm]) {
      expect(r.ownerProjectId).toBeNull();
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.url).not.toMatch(/api[_-]?key|token|secret/i);
      expect(() => sourceFromRow(r)).not.toThrow();
    }
    // The broken-site sweep is still run by sites.ts, not pulled as a feed.
    expect(() => sourceFromRow({ ...osm, parserId: undefined })).toThrow(/sites\.ts/);
  });

  it('reads a Find a Tender release package into notices with buyer, value and deadline', () => {
    const items = parseFindATender(FTS);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      externalId: 'ocds-h6vhtk-04a1b2', url: 'https://www.find-tender.service.gov.uk/Notice/012345-2026',
      title: 'Grounds maintenance', organization: 'Leeds City Council', publishedAt: '2026-11-10T09:00:00.000Z',
    });
    expect(items[0]?.body).toContain('Value 120000 GBP.');
    expect(items[0]?.body).toContain('Tenders due 2026-12-01T12:00:00Z.');
  });

  it('reads a GLEIF page into new entities addressed by a URL canonicalisation keeps distinct', () => {
    const items = parseGleif(GLEIF);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: '5493001KJTIIGC8Y1R12', organization: 'Acme Fabrication LLC', url: 'https://api.gleif.org/api/v1/lei-records/5493001KJTIIGC8Y1R12' });
    expect(items[0]?.body).toContain('Houston, US');
  });

  it('reads an Overpass category into named features, inventing no date', () => {
    const items = parseOverpassElements(OVERPASS);
    expect(items).toEqual([expect.objectContaining({ externalId: 'way/123', url: 'https://www.openstreetmap.org/way/123', title: 'Bayou Steel Works', publishedAt: null })]);
  });

  it('reads the CanadaBuys CSV through its registry mapping, BOM and all', () => {
    const items = sourceFromRow(row('canadabuys-new-tenders-csv')).parse(CANADABUYS);
    expect(items).toEqual([expect.objectContaining({ externalId: 'PW-26-01234', title: 'Snow removal, Ottawa', organization: 'Public Services and Procurement Canada', publishedAt: '2026-11-10T00:00:00.000Z' })]);
  });

  it('calls a changed format UNPARSEABLE instead of an empty pull', () => {
    expect(() => parseFindATender({ error: 'x' })).toThrow(UnparseableBody);
    expect(() => parseGleif([])).toThrow(/UNPARSEABLE/);
    expect(() => parseOverpassElements('<html/>')).toThrow(/UNPARSEABLE/);
    expect(() => parseCsv('a,b\n1,2\n', { title: 'title', url: 'url' })).toThrow(/no column "title"/);
    expect(pullFailureCause(new UnparseableBody('x'), 'UNKNOWN')).toBe('UNPARSEABLE');
    expect(pullFailureCause(new Error('HTTP 403'), 'FORBIDDEN')).toBe('REFUSED');
    expect(pullFailureCause(new Error('HTTP 429'), 'RATE_LIMITED')).toBe('RATE_LIMITED');
  });
});

const RSS = '<rss><channel><item><title>One</title><link>https://pub.example/one</link><guid>1</guid></item></channel></rss>';
const feed = (id: string, url = `https://pub.example/feeds/${id}.xml`): FeedSource => ({
  id, label: id, url, intervalMs: 3_600_000, format: 'text',
  parse: (b) => (typeof b === 'string' && b.includes('<item>') ? [{ externalId: `${id}-1`, url: `https://pub.example/${id}/1`, title: 'One', body: null, organization: null, publishedAt: null }] : []),
});
const pulls = async (source: string) =>
  getDb().all<{ ok: number; failure_cause: string | null; error: string | null; memory_bytes: number | null; bytes: number | null }>(
    'SELECT ok, failure_cause, error, memory_bytes, bytes FROM feed_pulls WHERE source = ? ORDER BY created_at', [source],
  );

describe('the pull reads robots.txt itself and records the answer before it asks', () => {
  const now = new Date('2026-11-12T00:00:00Z');

  it('production always reads the real robots.txt; only a caller faking the fetcher may leave it out', () => {
    expect(robotsReaderFor({})).toBe(httpRobotsFetcher);
    expect(robotsReaderFor({ fetcher: async () => [] })).toBeNull();
    const fake: RobotsFetcher = async () => ({ status: 404, body: '' });
    expect(robotsReaderFor({ fetcher: async () => [], robots: fake })).toBe(fake);
  });

  it('records ALLOWED with the time, pulls, and does not read robots.txt again within the week', async () => {
    const asked: string[] = [];
    const robots: RobotsFetcher = async (url) => { asked.push(url); return { status: 200, body: 'User-agent: *\nDisallow: /private/\n' }; };
    const out = await pullDueFeeds({ now, sources: [feed('allowed-src')], fetcher: async () => RSS, robots });
    expect(out[0]).toMatchObject({ inserted: 1, error: null });
    expect(asked).toEqual(['https://pub.example/robots.txt']);
    const reg = await getCollectSourceBySlug('allowed-src');
    expect(reg?.robotsStatus).toBe('ALLOWED');
    expect(reg?.robotsCheckedAt).toBeTruthy();
    expect(reg?.robotsNote).toContain('/feeds/allowed-src.xml');
    const [first] = await pulls('allowed-src');
    expect(first).toMatchObject({ ok: 1, failure_cause: null, bytes: RSS.length });
    expect(first?.memory_bytes).toBeGreaterThan(0);
    await pullDueFeeds({ now: new Date(now.getTime() + 2 * 3_600_000), sources: [feed('allowed-src')], fetcher: async () => RSS, robots });
    expect(asked).toHaveLength(1);
  });

  it('never asks a source its robots.txt disallows, and records the refusal as REFUSED', async () => {
    let fetched = 0;
    const robots: RobotsFetcher = async () => ({ status: 200, body: 'User-agent: brain-feed\nDisallow: /feeds/\n' });
    const out = await pullDueFeeds({ now, sources: [feed('blocked-src')], fetcher: async () => { fetched += 1; return RSS; }, robots });
    expect(fetched).toBe(0);
    expect(out[0]?.error).toMatch(/^DISALLOWED: robots\.txt disallows/);
    expect((await getCollectSourceBySlug('blocked-src'))?.robotsStatus).toBe('DISALLOWED');
    expect((await pulls('blocked-src'))[0]).toMatchObject({ ok: 0, failure_cause: 'REFUSED' });
  });

  it('treats an unreadable robots.txt as not established: UNCHECKED, not asked, and retried rather than held', async () => {
    let fetched = 0;
    const robots: RobotsFetcher = async () => { throw new Error('fetch failed (ECONNRESET)'); };
    await pullDueFeeds({ now, sources: [feed('unread-src')], fetcher: async () => { fetched += 1; return RSS; }, robots });
    expect(fetched).toBe(0);
    expect((await getCollectSourceBySlug('unread-src'))?.robotsStatus).toBe('UNCHECKED');
    const [p] = await pulls('unread-src');
    expect(p).toMatchObject({ ok: 0, failure_cause: 'SOURCE_UNREACHABLE' });
    expect(p?.error).not.toMatch(/robots/i);
    // Backoff, not the source's interval: readable an hour later, the source is asked.
    const ok: RobotsFetcher = async () => ({ status: 404, body: '' });
    const later = await pullDueFeeds({ now: new Date(now.getTime() + 21 * 60_000), sources: [feed('unread-src')], fetcher: async () => { fetched += 1; return RSS; }, robots: ok });
    expect(later[0]).toMatchObject({ inserted: 1 });
    expect((await getCollectSourceBySlug('unread-src'))?.robotsNote).toMatch(/no robots\.txt \(HTTP 404\)/);
  });

  it('records an unparseable body with that cause through the live path', async () => {
    const src = sourceFromRow(row('gleif-new-lei-registrations'));
    const out = await pullDueFeeds({ now, sources: [src], fetcher: async () => ({ errors: [{ title: 'changed' }] }), robots: async () => ({ status: 404, body: '' }) });
    expect(out[0]?.error).toMatch(/^UNPARSEABLE/);
    expect((await pulls('gleif-new-lei-registrations'))[0]).toMatchObject({ ok: 0, failure_cause: 'UNPARSEABLE' });
    expect((await getCollectSourceBySlug('gleif-new-lei-registrations'))?.kind).toBe('JSON_API');
  });
});
