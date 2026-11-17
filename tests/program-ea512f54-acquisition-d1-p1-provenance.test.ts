/**
 * ACQ-21-4 item 5 (program fpg_ea512f54974d4ff39a84): fine-grained provenance
 * on every extracted fact. Original location, publication and retrieval time,
 * source version, format, licence, extractor code version, an exact evidence
 * span, entities and units — an unknown is null, never invented — and an
 * epistemic class that extraction never sets to a verified commercial fact.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTRACTOR_VERSION,
  extractItem,
  extractItems,
  type ExtractableItem,
  type ExtractedFact,
  type ItemField,
} from '../server/services/feeds/extract.ts';

const NOW = new Date('2026-11-16T00:00:00.000Z');
let seq = 0;
function item(over: Partial<ExtractableItem>): ExtractableItem {
  seq += 1;
  return {
    id: `fi_prov_${seq}`,
    source: 'county-bids',
    url: `https://example.test/prov/${seq}`,
    title: 'Request for quotes: barn roof replacement',
    body: null,
    organization: 'Lancaster County Farms LLC',
    publishedAt: '2026-11-10T00:00:00.000Z',
    fetchedAt: '2026-11-10T01:00:00.000Z',
    ...over,
  };
}

const PROVENANCE_KEYS = [
  'location',
  'itemId',
  'source',
  'field',
  'publishedAt',
  'retrievedAt',
  'sourceVersion',
  'format',
  'license',
  'extractor',
  'span',
  'entities',
  'units',
].sort();

function fieldText(source: ExtractableItem, field: ItemField): string {
  return field === 'title' ? source.title : field === 'body' ? source.body ?? '' : field === 'organization' ? source.organization ?? '' : source.publishedAt ?? '';
}

const RICH_BODY =
  'Seeking quotes for 120 bales of hay, delivered in Lancaster, PA by December 15, 2026. Budget $4,800. Due 2026-12-20.';

describe('every extracted fact carries every provenance field', () => {
  it('has all fields, the record location and times, the extractor version and no model', () => {
    const src = item({ body: RICH_BODY, sourceVersion: 'etag-"abc"', format: 'application/json', license: 'CC-BY-4.0' });
    const facts = extractItem(src);
    expect(facts.length).toBeGreaterThan(5);
    for (const f of facts) {
      expect(Object.keys(f.provenance).sort()).toEqual(PROVENANCE_KEYS);
      expect(f.provenance.location).toBe(src.url);
      expect(f.provenance.itemId).toBe(src.id);
      expect(f.provenance.source).toBe(src.source);
      expect(f.provenance.field).toBe(f.evidence.field);
      expect(f.provenance.publishedAt).toBe(src.publishedAt);
      expect(f.provenance.retrievedAt).toBe(src.fetchedAt);
      expect(f.provenance.sourceVersion).toBe('etag-"abc"');
      expect(f.provenance.format).toBe('application/json');
      expect(f.provenance.license).toBe('CC-BY-4.0');
      expect(f.provenance.extractor).toEqual({ code: EXTRACTOR_VERSION, model: null });
      expect(f.provenance.entities).toEqual(f.entityKey ? [f.entityKey] : []);
      expect(f.provenance.units).toEqual({ unit: f.unit, currency: f.currency });
    }
    const price = facts.find((f) => f.field === 'price')!;
    expect(price.provenance.units.currency).toBe('USD');
    const quantity = facts.find((f) => f.field === 'quantity')!;
    expect(quantity.provenance.units.unit).toBe(quantity.unit);
  });

  it('reports what the item does not state as null, never an invented value', () => {
    const src = item({ body: 'Budget $900.', organization: null, publishedAt: null });
    const facts = extractItem(src);
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.provenance.publishedAt).toBeNull();
      expect(f.provenance.sourceVersion).toBeNull();
      expect(f.provenance.format).toBeNull();
      expect(f.provenance.license).toBeNull();
      expect(f.provenance.entities).toEqual([]);
      expect(f.provenance.retrievedAt).toBe(src.fetchedAt);
    }
  });
});

describe('evidence spans index the exact text in the source field', () => {
  it('every span slices its field to exactly the span text and the evidence text', () => {
    const src = item({ body: RICH_BODY, title: 'Request for quotes: hay delivery in Lancaster, PA' });
    const facts = extractItem(src);
    for (const f of facts) {
      const span = f.provenance.span;
      expect(span, `${f.key} has a span`).not.toBeNull();
      const text = fieldText(src, f.evidence.field);
      expect(text.slice(span!.start, span!.end)).toBe(span!.text);
      expect(span!.end - span!.start).toBe(span!.text.length);
    }
    // Where the evidence text is verbatim, the span is that text.
    for (const f of facts.filter((x) => x.field !== 'location')) expect(f.provenance.span!.text).toBe(f.evidence.text);
  });

  it('the same text stated twice gives two spans, each at its own occurrence', () => {
    const body = 'First delivery 2026-12-20 at the north barn; second delivery 2026-12-20 at the south barn.';
    const src = item({ body });
    const dates = extractItem(src).filter((f) => f.field === 'date' && f.evidence.field === 'body');
    expect(dates).toHaveLength(2);
    const starts = dates.map((d) => d.provenance.span!.start);
    expect(starts).toEqual([body.indexOf('2026-12-20'), body.lastIndexOf('2026-12-20')]);
    for (const d of dates) expect(body.slice(d.provenance.span!.start, d.provenance.span!.end)).toBe('2026-12-20');
  });

  it('a place written without a space after its comma still slices exactly', () => {
    const src = item({ body: 'Work located in Boise,ID next week. Budget $1,000.' });
    const loc = extractItem(src).find((f) => f.field === 'location')!;
    expect(loc.provenance.span!.text).toBe('Boise,ID');
    expect(src.body!.slice(loc.provenance.span!.start, loc.provenance.span!.end)).toBe('Boise,ID');
  });
});

describe('epistemic class', () => {
  it('extraction yields only OBSERVED or DERIVED, never a verified commercial fact, model estimate or counterfactual', () => {
    const sources: ExtractableItem[] = [
      item({ body: RICH_BODY }),
      item({ source: 'remoteok', title: 'Senior Data Engineer', body: 'We are hiring. Salary $150,000. Remote.', organization: 'Acme Corp' }),
      item({ source: 'hn-seeking-work', title: 'Freelance designer', body: 'Available for hire, $80/hr, Austin, TX.', organization: 'Jane Studio' }),
    ];
    const facts = sources.flatMap((s) => extractItem(s));
    for (const f of facts) expect(['OBSERVED', 'DERIVED']).toContain(f.epistemicClass);
    expect(facts.some((f) => f.epistemicClass === 'VERIFIED_COMMERCIAL')).toBe(false);
    // A role is inferred from the record kind; a figure is read off the record.
    expect(facts.find((f) => f.field === 'buyer')!.epistemicClass).toBe('DERIVED');
    expect(facts.find((f) => f.field === 'employer')!.epistemicClass).toBe('DERIVED');
    expect(facts.find((f) => f.field === 'provider')!.epistemicClass).toBe('DERIVED');
    expect(facts.find((f) => f.field === 'price')!.epistemicClass).toBe('OBSERVED');
  });
});

describe('reconciled facts keep every contributor’s provenance', () => {
  it('a fact observed by several items lists each observation with its own item, location, times and span', () => {
    const a = item({ title: 'Hay delivery', body: 'Need 120 bales delivered in Lancaster, PA. Budget $4,800.', organization: 'Lancaster County Farms LLC', publishedAt: '2026-11-08T00:00:00.000Z', format: 'text/html' });
    const b = item({ title: 'Hay delivery', body: 'Budget is $5,200 for the job in Lancaster, PA.', organization: 'Lancaster County Farms LLC', publishedAt: '2026-11-09T00:00:00.000Z', license: 'public-domain' });
    const run = extractItems([a, b], NOW);
    const location = run.reconciled.find((r) => r.key.startsWith('location:') && r.observations.length === 2)!;
    expect(location).toBeDefined();
    const price = run.reconciled.find((r) => r.key.startsWith('price:') && r.observations.length === 2)!;
    expect(price.status).toBe('CONTESTED');
    for (const rec of [location, price]) {
      const byItem = new Map<string, ExtractedFact>(rec.observations.map((o) => [o.provenance.itemId, o]));
      expect([...byItem.keys()].sort()).toEqual([a.id, b.id].sort());
      expect(byItem.get(a.id)!.provenance).toMatchObject({ location: a.url, publishedAt: a.publishedAt, retrievedAt: a.fetchedAt, format: 'text/html', license: null });
      expect(byItem.get(b.id)!.provenance).toMatchObject({ location: b.url, publishedAt: b.publishedAt, retrievedAt: b.fetchedAt, format: null, license: 'public-domain' });
      for (const [id, o] of byItem) {
        const src = id === a.id ? a : b;
        expect(fieldText(src, o.evidence.field).slice(o.provenance.span!.start, o.provenance.span!.end)).toBe(o.provenance.span!.text);
      }
    }
  });
});
