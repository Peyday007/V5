/**
 * ALGO-16-1 item 2 (program fpg_ea512f54974d4ff39a84): deterministic
 * extraction and reconciliation. Every fact links to its raw item and field;
 * disagreement reads contested and age reads stale; a job post or supplier
 * advert is never buyer demand; only unreadable records go to the model, in
 * batches.
 */
import { describe, expect, it } from 'vitest';
import {
  extractItem,
  extractItems,
  MODEL_BATCH_SIZE,
  readDays,
  readPlaces,
  reconcile,
  recordKindOf,
  type ExtractableItem,
} from '../server/services/feeds/extract.ts';
import { readQuantities, readVolume } from '../server/services/cash/volume.ts';

const NOW = new Date('2026-11-16T00:00:00.000Z');
let seq = 0;
function item(over: Partial<ExtractableItem>): ExtractableItem {
  seq += 1;
  return {
    id: `fi_${seq}`,
    source: 'county-bids',
    url: `https://example.test/${seq}`,
    title: 'Request for quotes: barn roof replacement',
    body: null,
    organization: 'Lancaster County Farms LLC',
    publishedAt: '2026-11-10T00:00:00.000Z',
    fetchedAt: '2026-11-10T01:00:00.000Z',
    ...over,
  };
}

describe('every extracted fact carries its raw item id and field', () => {
  it('reads price, quantity, date, place, deliverable and identity, each linked to the item and field it came from', () => {
    const it1 = item({ body: 'Seeking quotes for 120 bales of hay, delivered in Lancaster, PA by December 15, 2026. Budget $4,800.' });
    const facts = extractItem(it1);
    const fields = new Set(facts.map((f) => f.field));
    for (const field of ['price', 'quantity', 'date', 'location', 'deliverable', 'buyer']) expect(fields).toContain(field);
    for (const f of facts) {
      expect(f.evidence.itemId).toBe(it1.id);
      expect(['title', 'body', 'organization', 'publishedAt']).toContain(f.evidence.field);
      expect(f.evidence.text.length).toBeGreaterThan(0);
      expect(f.evidence.url).toBe(it1.url);
    }
    const price = facts.find((f) => f.field === 'price')!;
    expect(price).toMatchObject({ value: 480000, currency: 'USD', evidence: { field: 'body', text: expect.stringContaining('4,800') } });
    expect(facts.find((f) => f.field === 'quantity')).toMatchObject({ value: 120, unit: 'bale' });
    expect(facts.find((f) => f.field === 'date' && f.evidence.field === 'body')!.value).toBe('2026-12-15');
    expect(facts.find((f) => f.field === 'location')!.value).toBe('lancaster, pa');
    expect(facts.find((f) => f.field === 'buyer')!.value).toBe('lancaster county farms');
  });

  it('normalizes units, currencies and dates', () => {
    expect(readQuantities('2 tonnes of feed and 500 lbs of seed')).toEqual([
      { value: 2, unit: 'tonnes', normalizedValue: 2000, normalizedUnit: 'kg', text: '2 tonnes' },
      { value: 500, unit: 'lbs', normalizedValue: 226.796, normalizedUnit: 'kg', text: '500 lbs' },
    ]);
    expect(readQuantities('40 gallons')[0]).toMatchObject({ normalizedUnit: 'l', normalizedValue: 151.416 });
    // A bare number, a money figure and a percentage are not quantities.
    expect(readQuantities('call 555 1234, $300, 20% off')).toEqual([]);
    expect(readDays('due 2026-02-30 or Feb 3rd, 2027')).toEqual([{ day: '2027-02-03', text: 'Feb 3rd, 2027' }]);
    expect(readPlaces('Based in York, PA; also remote')).toEqual([
      { place: 'york, pa', text: 'York, PA' },
      { place: 'remote', text: 'remote' },
    ]);
    const eur = extractItem(item({ body: 'Prix: €1.200' }));
    expect(eur.every((f) => f.field !== 'price' || f.currency === 'EUR')).toBe(true);
  });

  it('leaves readVolume unchanged', () => {
    expect(readVolume('about 40 orders a month', 30)?.deals).toBe(40);
  });
});

describe('disagreeing observations read contested; old ones read stale', () => {
  it('two items stating different prices for the same entity and deliverable are CONTESTED, every observation kept', () => {
    const a = item({ body: 'Budget $4,800.' });
    const b = item({ body: 'Budget $5,200.', publishedAt: '2026-11-12T00:00:00.000Z' });
    const run = extractItems([a, b], NOW);
    const price = run.reconciled.find((r) => r.key.startsWith('price:'))!;
    expect(price.status).toBe('CONTESTED');
    expect(price.value).toBeNull();
    expect(price.observations.map((o) => o.evidence.itemId)).toEqual([a.id, b.id]);
  });

  it('agreeing observations are OBSERVED, never "established"', () => {
    const run = extractItems([item({ body: 'Budget $4,800.' }), item({ body: 'Budget $4,800.' })], NOW);
    const price = run.reconciled.find((r) => r.key.startsWith('price:'))!;
    expect(price.status).toBe('OBSERVED');
    expect(price.value).toBe(480000);
    expect(run.reconciled.map((r) => r.status as string)).not.toContain('ESTABLISHED');
  });

  it('an observation older than the stale window reads STALE, even when it is the only one', () => {
    const old = item({ body: 'Budget $4,800.', publishedAt: '2026-05-01T00:00:00.000Z' });
    const [price] = reconcile(extractItem(old).filter((f) => f.field === 'price'), NOW);
    expect(price!.status).toBe('STALE');
  });
});

describe('a job post or supplier advert is never typed as buyer demand', () => {
  it('a job posting is an employer hiring, NOT_DEMAND, with no buyer fact', () => {
    const post = item({ source: 'remoteok', title: 'Senior Bookkeeper (Remote)', organization: 'Acme Farms Inc', body: 'Salary $60,000 a year. Remote.' });
    expect(recordKindOf(post)).toBe('JOB_POSTING');
    const facts = extractItem(post);
    expect(facts.every((f) => f.demand === 'NOT_DEMAND' && f.recordKind === 'JOB_POSTING')).toBe(true);
    expect(facts.some((f) => f.field === 'buyer')).toBe(false);
    expect(facts.find((f) => f.field === 'employer')!.value).toBe('acme farms');
    expect(facts.find((f) => f.field === 'deliverable')!.value).toBe('bookkeeper');
  });

  it('a supplier advert and a platform listing are providers, NOT_DEMAND', () => {
    const ad = item({ source: 'classifieds', title: 'Roofing — free estimates', body: 'We offer barn roofing in York, PA from $3,000.', organization: 'Ridge Roofing' });
    const listing = item({ source: 'market', title: 'Round bales', body: 'Listed at $45 per bale.', organization: 'Hay Market' });
    for (const one of [ad, listing]) {
      const facts = extractItem(one);
      expect(['SUPPLIER_AD', 'PLATFORM_PRICE']).toContain(facts[0]!.recordKind);
      expect(facts.every((f) => f.demand === 'NOT_DEMAND')).toBe(true);
      expect(facts.some((f) => f.field === 'buyer')).toBe(false);
      expect(facts.some((f) => f.field === 'provider')).toBe(true);
    }
  });

  it('only a record that itself states a request carries STATED_REQUEST — and nothing is ever "confirmed"', () => {
    const facts = extractItem(item({ body: 'Seeking quotes, budget $4,800.' }));
    expect(facts.every((f) => f.demand === 'STATED_REQUEST')).toBe(true);
    expect(JSON.stringify(facts)).not.toMatch(/CONFIRMED/i);
  });
});

describe('unparseable records are listed for batched model assistance, parseable ones never are', () => {
  it('a record of unknown kind, or one with nothing but a name and a title, goes to the model; a readable one does not', () => {
    const readableOne = item({ body: 'Seeking quotes for 120 bales, budget $4,800.' });
    const unknownKind = item({ source: 'misc', title: 'Interesting update', body: 'Things are happening at 40 units.' });
    const nothingToRead = item({ source: 'remoteok', title: 'Bookkeeper', body: 'Join our team.' });
    const run = extractItems([readableOne, unknownKind, nothingToRead], NOW);
    const sent = run.needsModel.flat().map((i) => i.id);
    expect(sent).toEqual([unknownKind.id, nothingToRead.id]);
    expect(sent).not.toContain(readableOne.id);
  });

  it(`batches them ${MODEL_BATCH_SIZE} at a time`, () => {
    const many = Array.from({ length: MODEL_BATCH_SIZE * 2 + 3 }, () => item({ source: 'misc', title: 'Hello', body: null, organization: null }));
    const run = extractItems(many, NOW);
    expect(run.needsModel.map((b) => b.length)).toEqual([MODEL_BATCH_SIZE, MODEL_BATCH_SIZE, 3]);
  });

  it('is deterministic: the same items give the same facts', () => {
    const one = item({ body: 'Seeking quotes for 2 tons of feed in York, PA by 2026-12-01, $900.' });
    expect(extractItem(one)).toEqual(extractItem({ ...one }));
  });
});
