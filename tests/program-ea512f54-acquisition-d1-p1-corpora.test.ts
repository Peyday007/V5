/**
 * ACQ-21-3: large existing corpora are judged per need — scope, freshness,
 * permitted use, quality, contribution — before any crawler, each decision is
 * APPLIED or SKIPPED with a reason and recorded on the existing event writer,
 * and the named examples are not a whitelist.
 */
import { describe, expect, it } from 'vitest';
import {
  CORPORA,
  CORPUS_EVALUATION_EVENT,
  evaluateCorpora,
  recordCorporaEvaluation,
  type CorpusDescriptor,
} from '../server/services/feeds/corpora.ts';

const byId = (id: string): CorpusDescriptor => {
  const c = CORPORA.find((one) => one.id === id);
  if (!c) throw new Error(`missing corpus ${id}`);
  return c;
};

describe('the named corpora carry the spec caveats', () => {
  it('every corpus has scope, freshness, permitted-use, quality and caveat fields', () => {
    for (const c of CORPORA) {
      expect(c.scope.length).toBeGreaterThan(0);
      expect(c.freshness).toBeTruthy();
      expect(c.freshnessNote.length).toBeGreaterThan(0);
      expect(c.permittedUse.length).toBeGreaterThan(0);
      expect(c.quality).toBeGreaterThan(0);
      expect(c.quality).toBeLessThanOrEqual(1);
      expect(c.caveats.length).toBeGreaterThan(0);
    }
    for (const id of ['common-crawl', 'sec-edgar', 'data-gov', 'gdelt', 'wikidata']) expect(byId(id).kind).toBe('NAMED');
  });

  it('states each caveat the specification names', () => {
    expect(byId('common-crawl').caveats.join(' ')).toMatch(/not evidence that a listed buyer currently needs a service/);
    expect(byId('common-crawl').caveats.join(' ')).toMatch(/not necessarily current/);
    expect(byId('data-gov').caveats.join(' ')).toMatch(/metadata and links, not the underlying dataset/);
    expect(byId('data-gov').caveats.join(' ')).toMatch(/does not imply pursuing prohibited government contracts/);
    expect(byId('gdelt').caveats.join(' ')).toMatch(/not proof of transaction demand without corroboration/);
    expect(byId('wikidata').caveats.join(' ')).toMatch(/bulk dumps rather than overloading the public query endpoint/);
    expect(byId('sec-edgar').caveats.join(' ')).toMatch(/fair-access/);
  });

  it('names the open domain-source classes', () => {
    const classes = CORPORA.filter((c) => c.kind === 'DOMAIN_CLASS').map((c) => c.id);
    for (const id of [
      'industry-associations', 'trade-catalogs', 'rate-sheets', 'permitted-marketplaces', 'procurement-directories',
      'business-filings', 'regulatory-records', 'archives', 'inventory-feeds', 'transport-economic', 'academic-repositories',
    ]) expect(classes).toContain(`domain:${id}`);
  });
});

describe('evaluateCorpora', () => {
  it('returns APPLIED or SKIPPED with a reason for every candidate', () => {
    const ev = evaluateCorpora({ purpose: 'public company financial condition', factKinds: ['financials'] });
    expect(ev.decisions).toHaveLength(CORPORA.length);
    for (const d of ev.decisions) {
      expect(['APPLIED', 'SKIPPED']).toContain(d.outcome);
      expect(d.reason.length).toBeGreaterThan(10);
    }
    expect(ev.applied).toContain('sec-edgar');
    expect(ev.applied.length + ev.skipped.length).toBe(CORPORA.length);
  });

  it('two unrelated needs apply different sets', () => {
    const finance = evaluateCorpora({ purpose: 'supplier financial condition', factKinds: ['financials', 'company-filing'] });
    const freight = evaluateCorpora({ purpose: 'regional freight capacity and published rates', factKinds: ['transport', 'rate'] });
    expect(finance.applied).toContain('sec-edgar');
    expect(freight.applied).not.toContain('sec-edgar');
    expect(freight.applied).toEqual(expect.arrayContaining(['domain:transport-economic', 'domain:rate-sheets']));
    expect(new Set(finance.applied)).not.toEqual(new Set(freight.applied));
  });

  it('a domain class with no named corpus is still evaluated and can be applied', () => {
    const ev = evaluateCorpora({ purpose: 'who supplies industrial fasteners', factKinds: ['product-catalog', 'supplier'] });
    expect(ev.applied).toContain('domain:trade-catalogs');
    expect(ev.applied.every((id) => id.startsWith('domain:'))).toBe(true);
  });

  it('ease of connection does not rank a source higher', () => {
    const need = { purpose: 'company relationships', factKinds: ['entity', 'industry-relationship'] };
    const plain = evaluateCorpora(need);
    const connected = evaluateCorpora({ ...need, connected: ['wikidata', 'domain:industry-associations'] });
    expect(connected.decisions.map((d) => [d.corpusId, d.score, d.outcome])).toEqual(plain.decisions.map((d) => [d.corpusId, d.score, d.outcome]));
  });

  it('Common Crawl and GDELT are skipped as proof of current demand', () => {
    const ev = evaluateCorpora({ purpose: 'who is asking to buy this service now', factKinds: ['buyer-request'] });
    const cc = ev.decisions.find((d) => d.corpusId === 'common-crawl')!;
    const gd = ev.decisions.find((d) => d.corpusId === 'gdelt')!;
    expect(cc.outcome).toBe('SKIPPED');
    expect(cc.reason).toMatch(/not evidence of buyer-request/);
    expect(gd.outcome).toBe('SKIPPED');
    expect(ev.applied).toContain('domain:permitted-marketplaces');
  });

  it('GDELT applied for triggers still marks demand as needing corroboration', () => {
    const ev = evaluateCorpora({ purpose: 'market shifts that create demand', factKinds: ['event-trigger', 'transaction-demand'] });
    const gd = ev.decisions.find((d) => d.corpusId === 'gdelt')!;
    expect(gd.outcome).toBe('APPLIED');
    expect(gd.needsCorroboration).toContain('transaction-demand');
    expect(gd.reason).toMatch(/needs corroboration/);
  });

  it('freshness skips a stale corpus with the reason, and a large job takes the bulk route', () => {
    const fresh = evaluateCorpora({ purpose: 'pages from this week', factKinds: ['domain-discovery'], maxAgeDays: 7 });
    expect(fresh.decisions.find((d) => d.corpusId === 'common-crawl')!.reason).toMatch(/not fresh enough/);
    const big = evaluateCorpora({ purpose: 'every company identifier', factKinds: ['identifier'], largeJob: true });
    expect(big.decisions.find((d) => d.corpusId === 'wikidata')!.route).toMatch(/dump/);
    const small = evaluateCorpora({ purpose: 'one company identifier', factKinds: ['identifier'] });
    expect(small.decisions.find((d) => d.corpusId === 'wikidata')!.route).toMatch(/SPARQL/);
  });

  it('carries EDGAR pacing on the decision', () => {
    const ev = evaluateCorpora({ purpose: 'filings', factKinds: ['company-filing'] });
    expect(ev.decisions.find((d) => d.corpusId === 'sec-edgar')!.pacing).toMatch(/10 requests a second/);
  });
});

describe('recordCorporaEvaluation', () => {
  it('records one MEASURED CORPUS_EVALUATION row through the existing writer', async () => {
    const rows: unknown[] = [];
    const ev = await recordCorporaEvaluation(
      { purpose: 'supplier financial condition', factKinds: ['financials'], connected: ['gdelt'] },
      { record: async (input) => void rows.push(input) },
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { eventType: string; evidenceClass: string; outcome: string; measures: { decisions: { corpus: string; outcome: string; reason: string }[]; connectionRanked: boolean } };
    expect(row.eventType).toBe(CORPUS_EVALUATION_EVENT);
    expect(row.evidenceClass).toBe('MEASURED');
    expect(row.outcome).toBe('APPLIED');
    expect(row.measures.connectionRanked).toBe(false);
    expect(row.measures.decisions).toHaveLength(CORPORA.length);
    expect(row.measures.decisions.find((d) => d.corpus === 'sec-edgar')!.outcome).toBe('APPLIED');
    expect(ev.applied).toContain('sec-edgar');
  });
});
