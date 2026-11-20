/**
 * EXTRACTION_UNREADABLE:news-event-rush (and news-new-location, news-shutdown,
 * sec-edgar-8k). GDELT stores a headline as space-separated tokens with no
 * body, so `1 , 000 families` read as nothing and every such news item went to
 * a model; an 8-K had no record kind, so it was always UNKNOWN. The titles
 * below are the recorded failures, verbatim.
 */
import { describe, expect, it } from 'vitest';
import { extractItem, extractItems, readable, untokenise, type ExtractableItem, type ItemField } from '../server/services/feeds/extract.ts';
import { parseRemoteOk } from '../server/services/feeds/sources.ts';

function news(id: string, title: string, url: string, source = 'news-event-rush'): ExtractableItem {
  return {
    id,
    source,
    url,
    title,
    body: null,
    organization: new URL(url).hostname.replace(/^www\./, ''),
    publishedAt: '2026-11-12T10:00:00.000Z',
    fetchedAt: '2026-11-12T10:05:00.000Z',
  };
}

const RECORDED = {
  fold: news('n1', 'Fold ( FLD ) Q3 2026 Earnings Call Transcript', 'https://www.aol.com/articles/fold-fld-q3-2026-earnings-031911000.html'),
  mall: news('n2', 'Mall Of America Named America Best Mall For A Full Day Out', 'https://squatchrocks.com/ixp/150/p/mall-of-america-best-day-out/'),
  travel: news('n3', 'Traveling for the holidays ? Here how to save', 'https://keyt.com/lifestyle/travel/stacker-travel/2026/11/10/traveling-for-the-holidays-heres-how-to-save/'),
  bellmead: news('n4', 'Bellmead woman sets out to feed 1 , 000 families with free Thanksgiving meal', 'https://www.kwtx.com/2026/11/11/bellmead-woman-sets-out-feed-1000-families-with-free-thanksgiving-meal/'),
  tocaya: news('n5', 'Tocaya Brings Back Holiday Tamales , Including New Chicken Verde Addition', 'https://www.restaurantnewsrelease.com/tocaya-brings-back-holiday-tamales-including-new-chicken-verde-addition/'),
};

const EDGAR: ExtractableItem = {
  id: 'e1',
  source: 'sec-edgar-8k',
  url: 'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/form8k.htm',
  title: '8-K (Current report): ACME CORP',
  body: 'Items 2.01, 9.01. Business location: Austin, TX.',
  organization: 'ACME CORP',
  publishedAt: '2026-11-10',
  fetchedAt: '2026-11-11T00:00:00.000Z',
};

const raw = (item: ExtractableItem, field: ItemField): string =>
  field === 'title' ? item.title : field === 'body' ? item.body ?? '' : field === 'organization' ? item.organization ?? '' : item.publishedAt ?? '';

describe('tokenised news titles and unmapped feed sources are read by code', () => {
  it('reads the recorded failures that state a count or a place', () => {
    for (const item of [RECORDED.bellmead, EDGAR]) {
      expect(readable(item, extractItem(item)), item.title).toBe(true);
    }
  });

  it('does not let an occasion alone stand in for a reading, because nothing consumes it', () => {
    // Fold (Q3 2026), the holidays and Holiday Tamales name only an occasion: the fact is kept, but the item still goes to the model.
    for (const item of [RECORDED.fold, RECORDED.travel, RECORDED.tocaya]) {
      const facts = extractItem(item);
      expect(facts.some((f) => f.field === 'occasion'), item.title).toBe(true);
      expect(readable(item, facts), item.title).toBe(false);
    }
  });

  it('reads `1 , 000 families` as a count of 1000 whose span is the raw tokenised text', () => {
    const count = extractItem(RECORDED.bellmead).find((f) => f.field === 'quantity');
    expect(count).toMatchObject({ value: 1000, unit: 'family', demand: 'NOT_DEMAND', epistemicClass: 'OBSERVED' });
    expect(count!.evidence.text).toBe('1 , 000 families');
    const span = count!.provenance.span!;
    expect(RECORDED.bellmead.title.slice(span.start, span.end)).toBe('1 , 000 families');
    const occasion = extractItem(RECORDED.bellmead).find((f) => f.field === 'occasion');
    expect(occasion).toMatchObject({ value: 'thanksgiving', evidence: { text: 'Thanksgiving' } });
  });

  it('reads a fiscal quarter as an occasion, never as a date or a count', () => {
    const facts = extractItem(RECORDED.fold);
    expect(facts.find((f) => f.field === 'occasion')).toMatchObject({ value: '2026-Q3', evidence: { text: 'Q3 2026' } });
    expect(facts.some((f) => f.field === 'quantity')).toBe(false);
    expect(facts.filter((f) => f.field === 'date').every((f) => f.evidence.field === 'publishedAt')).toBe(true);
  });

  it('keeps every fact linked to the exact raw characters, as NOT_DEMAND, and never established', () => {
    for (const item of [...Object.values(RECORDED), EDGAR]) {
      for (const fact of extractItem(item)) {
        const source = raw(item, fact.evidence.field);
        const span = fact.provenance.span;
        expect(span, `${item.id} ${fact.key}`).not.toBeNull();
        expect(source.slice(span!.start, span!.end)).toBe(span!.text);
        expect(source.includes(fact.evidence.text)).toBe(true);
        expect(fact.demand).toBe('NOT_DEMAND');
        expect(['OBSERVED', 'DERIVED']).toContain(fact.epistemicClass);
        expect(fact.provenance.extractor.model).toBeNull();
      }
    }
    const run = extractItems([...Object.values(RECORDED), EDGAR], new Date('2026-11-12T12:00:00.000Z'));
    for (const r of run.reconciled) expect(['OBSERVED', 'CONTESTED', 'STALE']).toContain(r.status);
  });

  it('classes an 8-K as a public record and reads its stated business location', () => {
    const facts = extractItem(EDGAR);
    expect(facts[0]!.recordKind).toBe('PUBLIC_RECORD');
    expect(facts.find((f) => f.field === 'location')).toMatchObject({ value: 'austin, tx' });
  });

  it('still sends a headline that states nothing it can read to the model, rather than guessing', () => {
    expect(readable(RECORDED.mall, extractItem(RECORDED.mall))).toBe(false);
    const run = extractItems(Object.values(RECORDED), new Date('2026-11-12T12:00:00.000Z'));
    expect(run.needsModel.flat().map((i) => i.id).sort()).toEqual(['n1', 'n2', 'n3', 'n5']);
  });

  it('leaves a job posting or an advert NOT_DEMAND, and does not read occasions out of them', () => {
    const posting: ExtractableItem = { ...RECORDED.bellmead, id: 'j1', source: 'remoteok', title: 'Seasonal support lead for the holiday season , 1 , 000 tickets' };
    const advert: ExtractableItem = { ...RECORDED.travel, id: 'a1', source: 'hn-seeking-work', title: 'Available for hire for the holidays ? $ 90 / hour' };
    for (const item of [posting, advert]) {
      const facts = extractItem(item);
      expect(facts.every((f) => f.demand === 'NOT_DEMAND')).toBe(true);
      expect(facts.some((f) => f.field === 'occasion')).toBe(false);
    }
  });

  it('only ever drops spaces when it untokenises, so every index maps back', () => {
    const rawTitle = RECORDED.fold.title;
    const { text, toRaw } = untokenise(rawTitle);
    expect(text).toBe('Fold (FLD) Q3 2026 Earnings Call Transcript');
    for (let i = 0; i < text.length; i++) expect(rawTitle[toRaw[i]!]).toBe(text[i]);
    expect(untokenise('Plain prose, already readable.').text).toBe('Plain prose, already readable.');
  });
});

/**
 * EXTRACTION_UNREADABLE:remoteok. RemoteOK states pay in thousands shorthand
 * (`$120k - $160k`) inside an HTML description, and `readMoneyFigures` refuses
 * shorthand, so a posting whose only figures were its salary and a labelled
 * country read as nothing and went to a model. The rows below are in the
 * public API's shape (a legal notice first) and go through the feed's own
 * parser, so the test reads exactly what the feed loop stores.
 */
const REMOTEOK_API = [
  { legal: 'API Terms of Service: Please link back to the URL on Remote OK and mention Remote OK as a source.' },
  {
    id: '1130001',
    epoch: 1794470400,
    company: 'Acme Payments',
    position: 'Senior Backend Engineer',
    description: '<p><strong>About Acme</strong></p><p>We build payments infrastructure.</p><ul><li>Own our Go services</li></ul><p><b>Benefits</b>: $120k - $160k base, equity, health insurance.</p>',
    url: 'https://remoteok.com/remote-jobs/1130001',
  },
  {
    id: '1130002',
    epoch: 1794470400,
    company: 'Northwind',
    position: 'Staff Data Engineer',
    description: '<p>Location: United States. You will lead our data platform.</p><p>Salary: $140K-$175K/year</p>',
    url: 'https://remoteok.com/remote-jobs/1130002',
  },
  {
    id: '1130003',
    epoch: 1794470400,
    company: 'Globex',
    position: 'Product Designer',
    description: '<p>Compensation 80k-100k EUR. Location: Germany or Portugal time zones.</p>',
    url: 'https://remoteok.com/remote-jobs/1130003',
  },
  {
    id: '1130004',
    epoch: 1794470400,
    company: 'Initech',
    position: 'Support Engineer',
    description: '<p>Join a small team that ships often and talks to customers every week.</p>',
    url: 'https://remoteok.com/remote-jobs/1130004',
  },
];

function remoteOk(): ExtractableItem[] {
  return parseRemoteOk(REMOTEOK_API).map((row) => ({
    id: `remoteok:${row.externalId}`,
    source: 'remoteok',
    url: row.url,
    title: row.title,
    body: row.body,
    organization: row.organization,
    publishedAt: row.publishedAt,
    fetchedAt: '2026-11-12T10:05:00.000Z',
  }));
}

describe('RemoteOK postings are read by code', () => {
  it('reads shorthand salaries and labelled places, as offered wages that stay NOT_DEMAND', () => {
    const [acme, northwind, globex] = remoteOk();
    const wages = (item: ExtractableItem) => extractItem(item).filter((f) => f.field === 'price');

    expect(wages(acme!).map((f) => [f.value, f.currency, f.evidence.text])).toEqual([
      [12_000_000, 'USD', '$120k - $160k'],
      [16_000_000, 'USD', '$120k - $160k'],
    ]);
    expect(wages(northwind!).map((f) => [f.value, f.unit])).toEqual([
      [14_000_000, 'per-unit'],
      [17_500_000, 'per-unit'],
    ]);
    expect(wages(globex!).map((f) => [f.value, f.currency])).toEqual([
      [8_000_000, 'EUR'],
      [10_000_000, 'EUR'],
    ]);
    expect(extractItem(northwind!).find((f) => f.field === 'location')).toMatchObject({ value: 'united states', evidence: { text: 'United States' } });
    expect(extractItem(globex!).filter((f) => f.field === 'location').map((f) => f.value)).toEqual(['germany']);

    for (const item of [acme!, northwind!, globex!]) {
      const facts = extractItem(item);
      expect(readable(item, facts), item.title).toBe(true);
      for (const fact of facts) {
        expect(fact.recordKind).toBe('JOB_POSTING');
        expect(fact.demand).toBe('NOT_DEMAND');
        expect(fact.field).not.toBe('occasion');
        expect(fact.provenance.extractor.model).toBeNull();
        if (fact.field === 'price') expect(fact.measureKind).toBe('OFFERED_WAGE');
        const span = fact.provenance.span!;
        expect(raw(item, fact.evidence.field).slice(span.start, span.end)).toBe(span.text);
      }
    }
  });

  it('still sends a posting that states no pay or place to the model', () => {
    const items = remoteOk();
    const run = extractItems(items, new Date('2026-11-12T12:00:00.000Z'));
    expect(run.needsModel.flat().map((i) => i.id)).toEqual(['remoteok:1130004']);
    for (const r of run.reconciled) expect(['OBSERVED', 'CONTESTED', 'STALE']).toContain(r.status);
  });

  it('reads shorthand only in a posting, only with a currency marker, and never a glued foreign dollar as USD', () => {
    const base = remoteOk()[3]!;
    const priced = (body: string, source = 'remoteok') => extractItem({ ...base, source, body }).filter((f) => f.field === 'price').map((f) => [f.value, f.currency]);
    expect(priced('Pay 120k plus a 401k match')).toEqual([]);
    expect(priced('Pay C$120k')).toEqual([[12_000_000, 'CAD']]);
    expect(priced('Startup raised $120k', 'news-event-rush')).toEqual([]);
  });
});
