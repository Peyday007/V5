/**
 * KNOW-25-1, decision-ready facts (`server/services/feeds/extract.ts`): every
 * normalized fact carries its original source and exact evidence span, the
 * observation date, the jurisdiction/scope its record states (or says it does
 * not), units, the parser version, a confidence basis and a contradiction
 * status — and an advertised price is never a paid price, a market size is
 * never reachable leads, and published capacity is never contracted
 * fulfilment.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTRACTOR_VERSION,
  extractItem,
  extractItems,
  priceMeasure,
  quantityMeasure,
  reconcile,
  scopeOf,
  type ExtractableItem,
} from '../server/services/feeds/extract.ts';

const NOW = new Date('2026-11-17T00:00:00.000Z');

function item(over: Partial<ExtractableItem> = {}): ExtractableItem {
  return {
    id: 'itm_1',
    source: 'feed-x',
    url: 'https://example.test/1',
    title: 'Industrial cleaning',
    body: null,
    organization: 'Acme Services LLC',
    publishedAt: '2026-11-10T00:00:00.000Z',
    fetchedAt: '2026-11-11T00:00:00.000Z',
    ...over,
  };
}

describe('every fact is decision-ready', () => {
  it('carries source, evidence span, observation date, scope, units, parser version, confidence basis and contradiction status', () => {
    const run = extractItems([item({ body: 'Located in Austin, TX. Paid $1,200 for 30 hours on 2026-11-05.' })], NOW);
    expect(run.facts.length).toBeGreaterThan(3);
    for (const f of run.facts) {
      expect(f.provenance.location).toBe('https://example.test/1');
      expect(f.provenance.source).toBe('feed-x');
      expect(f.evidence.itemId).toBe('itm_1');
      expect(typeof f.observedAt).toBe('string');
      expect(f.scope.jurisdiction).toBe('TX');
      expect(f.scope.basis).toMatch(/stated in record/);
      expect(f.provenance.units).toEqual({ unit: f.unit, currency: f.currency });
      expect(f.parserVersion).toBe(EXTRACTOR_VERSION);
      expect(f.provenance.extractor.code).toBe(EXTRACTOR_VERSION);
      expect(f.confidenceBasis.rule).toBeTruthy();
      expect(['VERBATIM_SPAN', 'SPAN_NOT_LOCATED']).toContain(f.confidenceBasis.evidence);
      expect(f.confidenceBasis.detail).toContain(EXTRACTOR_VERSION);
      expect(['OBSERVED', 'CONTESTED', 'STALE']).toContain(f.contradictionStatus);
    }
    const located = run.facts.filter((f) => f.provenance.span);
    for (const f of located) expect(f.confidenceBasis.evidence).toBe('VERBATIM_SPAN');
  });

  it('says scope is not stated rather than assuming one', () => {
    expect(scopeOf({ title: 'Bookkeeping', body: 'Monthly reconciliation for a small firm.' })).toEqual({ jurisdiction: null, basis: 'not stated' });
    for (const f of extractItem(item({ body: 'Monthly reconciliation, $400 per month.' }))) {
      expect(f.scope).toEqual({ jurisdiction: null, basis: 'not stated' });
      expect(f.contradictionStatus).toBe('UNRECONCILED');
    }
    expect(scopeOf({ title: 'Remote role', body: null }).jurisdiction).toBe('remote');
  });

  it('bumps the extractor version so a change in reading is visible in the rows', () => {
    expect(EXTRACTOR_VERSION).toBe('feeds-extract/3');
  });
});

describe('figures that must not be merged stay distinct', () => {
  it('an advert or listing price is advertised, never paid, however it is worded', () => {
    const ad = extractItem(item({ source: 'hn-seeking-work', body: 'We offer audits. Clients paid $2,000 for the last one.' }));
    const prices = ad.filter((f) => f.field === 'price');
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) expect(p.measureKind).toBe('ADVERTISED_PRICE');
    expect(priceMeasure('PLATFORM_PRICE', 'sold for $50')).toBe('ADVERTISED_PRICE');
    expect(priceMeasure('SUPPLIER_AD', 'awarded contract value $9,000')).toBe('ADVERTISED_PRICE');
  });

  it('a public record that states a payment is a paid price; a request states a budget; a posting offers a wage', () => {
    expect(priceMeasure('PUBLIC_RECORD', 'the county paid $48,000 to the vendor')).toBe('PAID_PRICE');
    expect(priceMeasure('PUBLIC_RECORD', 'estimated at $48,000')).toBe('STATED_PRICE');
    expect(priceMeasure('STATED_REQUEST', 'budget $5,000')).toBe('REQUESTED_BUDGET');
    expect(priceMeasure('JOB_POSTING', 'salary $80,000')).toBe('OFFERED_WAGE');
  });

  it('a market size is not reachable leads, and published capacity is not contracted fulfilment', () => {
    expect(quantityMeasure('NEWS', 'the market size is 40,000 units a year')).toBe('MARKET_SIZE');
    expect(quantityMeasure('UNKNOWN', 'a list of 2,000 leads')).toBe('REACHABLE_LEADS');
    expect(quantityMeasure('SUPPLIER_AD', 'capacity up to 500 units per month')).toBe('PUBLISHED_CAPACITY');
    expect(quantityMeasure('SUPPLIER_AD', '500 units of guaranteed capacity')).toBe('PUBLISHED_CAPACITY');
    expect(quantityMeasure('PUBLIC_RECORD', '500 units contracted capacity')).toBe('CONTRACTED_CAPACITY');
    expect(quantityMeasure('UNKNOWN', 'we shipped 12 boxes')).toBeNull();
  });

  it('two facts of different measure kinds never reconcile into one key', () => {
    const paid = item({ id: 'a', source: 'public-awards', organization: 'Acme Services LLC', title: 'Industrial cleaning', body: 'The county paid $1,000 for it.' });
    const ad = item({ id: 'b', source: 'hn-seeking-work', organization: 'Acme Services LLC', title: 'Industrial cleaning', body: 'We offer it for $1,500.' });
    const run = extractItems([paid, ad], NOW);
    const prices = run.facts.filter((f) => f.field === 'price');
    const kinds = new Set(prices.map((p) => p.measureKind));
    expect(kinds.has('ADVERTISED_PRICE')).toBe(true);
    for (const r of run.reconciled.filter((r) => r.key.startsWith('price:'))) {
      expect(new Set(r.observations.map((o) => o.measureKind)).size).toBe(1);
    }
    expect(new Set(prices.map((p) => p.key)).size).toBe(prices.length);
  });
});

describe('contradiction status is on each fact', () => {
  const a = item({ id: 'a', body: 'Austin, TX job: $1,000 total.' });
  const b = item({ id: 'b', body: 'Austin, TX job: $1,400 total.' });

  it('disagreeing observations of one key are CONTESTED on every fact of that key', () => {
    const run = extractItems([a, b], NOW);
    const contested = run.reconciled.find((r) => r.key.startsWith('price:') && r.observations.length === 2)!;
    expect(contested.status).toBe('CONTESTED');
    for (const o of contested.observations) expect(o.contradictionStatus).toBe('CONTESTED');
    for (const f of run.facts.filter((f) => f.key === contested.key)) expect(f.contradictionStatus).toBe('CONTESTED');
    // Agreeing locations stay OBSERVED.
    const loc = run.facts.filter((f) => f.field === 'location');
    expect(loc.every((f) => f.contradictionStatus === 'OBSERVED')).toBe(true);
  });

  it('old observations are STALE', () => {
    const old = item({ id: 'old', publishedAt: '2025-01-01T00:00:00.000Z', fetchedAt: '2025-01-01T00:00:00.000Z', body: 'Austin, TX job: $1,000 total.' });
    const run = extractItems([old], NOW);
    expect(run.facts.length).toBeGreaterThan(0);
    expect(run.facts.every((f) => f.contradictionStatus === 'STALE')).toBe(true);
    expect(reconcile(extractItem(old), NOW).every((r) => r.observations.every((o) => o.contradictionStatus === 'STALE'))).toBe(true);
  });
});
