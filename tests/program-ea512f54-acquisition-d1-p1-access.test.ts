import { describe, expect, it } from 'vitest';
import { conditionalFetcher, conditionalHeaders, contentHashOf, resolveAccess, type Transport, type TransportResponse } from '../server/services/feeds/access.ts';

const LISTING_URL = 'https://catalog.data.gov/api/3/action/package_show?id=example-dataset';

const ckan = {
  success: true,
  result: {
    title: 'Example dataset',
    license_title: 'Creative Commons CCZero',
    accrualPeriodicity: 'R/P1D',
    resources: [
      { url: 'https://catalog.data.gov/dataset/example-dataset', format: 'HTML', name: 'Catalog page' },
      { url: 'https://api.example.gov/v1/records?page=1&limit=100', format: 'API', name: 'Records API', description: 'REST endpoint, paginated' },
      { url: 'https://data.example.gov/exports/records-full.zip', format: 'ZIP', name: 'Full bulk download' },
      { url: 'https://data.example.gov/exports/records.csv', format: 'CSV', name: 'Records CSV' },
      { url: 'https://catalog.data.gov/api/3/action/package_show?id=example-dataset', format: 'JSON', name: 'Metadata' },
    ],
  },
};

describe('resolveAccess', () => {
  it('resolves a CKAN listing to its resource URLs and formats, never to the listing itself', () => {
    const r = resolveAccess(ckan, LISTING_URL);
    const urls = r.resources.map((x) => x.url);
    expect(urls).not.toContain(LISTING_URL);
    expect(urls).not.toContain('https://catalog.data.gov/dataset/example-dataset');
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://data.example.gov/exports/records-full.zip',
        'https://data.example.gov/exports/records.csv',
        'https://api.example.gov/v1/records?page=1&limit=100',
      ]),
    );
    expect(r.resources.find((x) => x.url.endsWith('.zip'))?.format).toBe('ZIP');
    expect(r.resources.find((x) => x.url.endsWith('.csv'))?.format).toBe('CSV');
    expect(r.setAside.map((s) => s.url)).toEqual(expect.arrayContaining([LISTING_URL, 'https://catalog.data.gov/dataset/example-dataset']));
    expect(r.licence).toBe('Creative Commons CCZero');
    expect(r.statedFrequency).toBe('R/P1D');
  });

  it('also reads an unwrapped package and a DCAT distribution, inferring format from the URL', () => {
    const r = resolveAccess({ title: 'D', distribution: [{ downloadURL: 'https://x.example.org/d/data.parquet' }] });
    expect(r.preferred?.format).toBe('PARQUET');
    expect(r.preferred?.kind).toBe('BULK');
  });

  it('prefers a bulk or dump link over paged API polling when both exist', () => {
    const r = resolveAccess(ckan, LISTING_URL);
    expect(r.preferred?.url).toBe('https://data.example.gov/exports/records-full.zip');
    expect(r.preferred?.updateMechanism).toBe('BULK_SNAPSHOT');
    const api = r.resources.find((x) => x.kind === 'API')!;
    expect(api.updateMechanism).toBe('PAGED_API');
    expect(r.resources.indexOf(api)).toBeGreaterThan(r.resources.indexOf(r.preferred!));
  });

  it('prefers an event subscription over polling', () => {
    const r = resolveAccess({
      resources: [
        { url: 'https://api.example.com/v2/items?page=1', format: 'API' },
        { url: 'https://api.example.com/hooks', format: 'WEBHOOK', name: 'Subscribe to changes' },
      ],
    });
    expect(r.preferred?.updateMechanism).toBe('EVENT_SUBSCRIPTION');
  });

  it('reports authentication and usage constraints and does not bypass them', () => {
    const r = resolveAccess({
      license_title: 'Licence Not Specified',
      resources: [
        { url: 'https://secure.example.com/export.zip', format: 'ZIP', description: 'API key required. Terms of use apply.' },
        { url: 'https://secure.example.com/data.csv', format: 'CSV', access_level: 'restricted public' },
      ],
    });
    expect(r.preferred).toBeNull();
    expect(r.handoff).toMatch(/authorized account|licence/);
    for (const res of r.resources) {
      expect(res.automatable).toBe(false);
      expect(res.authentication).toBe('REQUIRED');
      expect(res.constraints.length).toBeGreaterThan(0);
    }
    expect(r.resources.flatMap((x) => x.constraints).join(' ')).toMatch(/terms of use/i);
    expect(r.constraints.join(' ')).toMatch(/Licence Not Specified/);
  });

  it('a constrained bulk link loses to an open document rather than being read around', () => {
    const r = resolveAccess({
      resources: [
        { url: 'https://x.example.com/all.zip', format: 'ZIP', requires_auth: true },
        { url: 'https://x.example.com/open.csv', format: 'CSV' },
      ],
    });
    expect(r.preferred?.url).toBe('https://x.example.com/open.csv');
  });

  it('a private dataset is not automatable whatever its resources say', () => {
    const r = resolveAccess({ private: true, resources: [{ url: 'https://x.example.com/all.zip', format: 'ZIP' }] });
    expect(r.preferred).toBeNull();
    expect(r.resources[0]!.authentication).toBe('REQUIRED');
  });

  it('privileges no subject: two listings differing only in topic resolve identically', () => {
    const a = resolveAccess({ title: 'Freight rates', resources: [{ url: 'https://a.example/x.zip' }, { url: 'https://a.example/api?page=1', format: 'API' }] });
    const b = resolveAccess({ title: 'Dental clinics', resources: [{ url: 'https://a.example/x.zip' }, { url: 'https://a.example/api?page=1', format: 'API' }] });
    expect(a.resources).toEqual(b.resources);
  });
});

function stub(responses: TransportResponse[]): { transport: Transport; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const transport: Transport = async (url, headers) => {
    calls.push({ url, headers });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next;
  };
  return { transport, calls };
}

describe('conditionalFetcher', () => {
  it('passes the stored ETag and Last-Modified validators and returns NOT_MODIFIED on a 304', async () => {
    const { transport, calls } = stub([{ status: 304, headers: {}, body: '' }]);
    const read = conditionalFetcher(transport);
    const prior = { etag: '"abc"', lastModified: 'Tue, 10 Nov 2026 00:00:00 GMT', contentHash: 'h1' };
    const out = await read('https://data.example.gov/exports/records.csv', prior);
    expect(calls[0]!.headers['If-None-Match']).toBe('"abc"');
    expect(calls[0]!.headers['If-Modified-Since']).toBe('Tue, 10 Nov 2026 00:00:00 GMT');
    expect(out.status).toBe('NOT_MODIFIED');
    expect(out.validators).toEqual(prior);
    expect('body' in out).toBe(false);
  });

  it('returns MODIFIED with new validators and a content hash on a 200', async () => {
    const { transport, calls } = stub([{ status: 200, headers: { ETag: '"v2"', 'Last-Modified': 'Wed, 11 Nov 2026 00:00:00 GMT' }, body: 'a,b\n1,2\n' }]);
    const out = await conditionalFetcher(transport)('https://x.example/d.csv');
    expect(calls[0]!.headers).toEqual({});
    expect(out.status).toBe('MODIFIED');
    if (out.status !== 'MODIFIED') throw new Error('unreachable');
    expect(out.body).toBe('a,b\n1,2\n');
    expect(out.contentHash).toBe(contentHashOf('a,b\n1,2\n'));
    expect(out.validators).toEqual({ etag: '"v2"', lastModified: 'Wed, 11 Nov 2026 00:00:00 GMT', contentHash: out.contentHash });
  });

  it('a 200 with an unchanged content hash is NOT_MODIFIED, so nothing is re-ingested', async () => {
    const body = '{"x":1}';
    const { transport } = stub([{ status: 200, headers: {}, body }]);
    const out = await conditionalFetcher(transport)('https://x.example/d.json', { contentHash: contentHashOf(body) });
    expect(out.status).toBe('NOT_MODIFIED');
  });

  it('a refusal is an error, never read as unchanged', async () => {
    const { transport } = stub([{ status: 403, headers: {}, body: 'forbidden' }]);
    await expect(conditionalFetcher(transport)('https://x.example/d.json', { etag: '"a"' })).rejects.toThrow('HTTP 403');
  });

  it('conditionalHeaders sends nothing without prior validators', () => {
    expect(conditionalHeaders(null)).toEqual({});
    expect(conditionalHeaders({ etag: 'W/"1"' })).toEqual({ 'If-None-Match': 'W/"1"' });
  });
});
