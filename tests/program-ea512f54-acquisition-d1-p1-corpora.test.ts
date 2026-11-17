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
  CORPUS_PROPOSAL_MIN_SCORE,
  corpusProposalKey,
  corpusToAdd,
  evaluateCorpora,
  factKindsIn,
  needFromUnknown,
  recordCorporaEvaluation,
  type CorpusDescriptor,
} from '../server/services/feeds/corpora.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listCandidates } from '../server/repos/improvement.ts';
import { connectedCorpora, corpusConnectorWeakness, discoverCorporaForUnknowns } from '../server/services/feeds/run.ts';
import { FEED_SOURCES } from '../server/services/feeds/sources.ts';
import type { Weakness } from '../server/domain/improvement.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { resetEventGraph } from '../server/services/industry/eventGraph.ts';
import { openFeedShortlist, pendingLoopQuestions } from '../server/services/feeds/run.ts';
import { runFeedLoopCycle } from '../server/services/russell/loop.ts';

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

/*
 * Finding repair-R1-1: corpus discovery was circular. The only production evaluation built its need from an
 * already-connected source's own declaration, so it always applied that source's corpus, never discovered the
 * best source for a real unknown, and nothing proposed connecting an unconnected corpus that pays.
 */

const filings = {
  key: 'q-filings',
  question: 'Does the target company filing show its financial condition and recent company activity?',
  condition: 'the counterparty can carry the risk',
};
const news = {
  key: 'q-news',
  question: 'Did a news event trigger a market change for this buyer?',
  condition: 'a trigger exists',
};

describe('a need comes from the unknown, not from a connected source', () => {
  it('reads the fact kinds a research unknown asks for from its own words', () => {
    expect(factKindsIn(`${filings.question} ${filings.condition}`)).toEqual(['company-activity', 'company-filing', 'financial-condition', 'financials']);
    expect(factKindsIn('Is the sky blue today?')).toEqual([]);
  });

  it('the connected corpora are what the feed sources are instances of, and none of them is SEC EDGAR', () => {
    const connected = connectedCorpora();
    expect(connected.size).toBeGreaterThan(0);
    for (const source of FEED_SOURCES) if (source.acquisition) expect(connected.has(source.acquisition.corpus)).toBe(true);
    expect(connected.has('sec-edgar')).toBe(false);
  });

  it('ranks an unconnected corpus first when it answers the unknown best, and proposes it', () => {
    const connected = connectedCorpora();
    const need = needFromUnknown(filings, [...connected]);
    const evaluation = evaluateCorpora(need);
    expect(evaluation.decisions[0]!.corpusId).toBe('sec-edgar');
    const add = corpusToAdd(evaluation, connected);
    expect(add?.corpusId).toBe('sec-edgar');
    expect(add!.score).toBeGreaterThanOrEqual(CORPUS_PROPOSAL_MIN_SCORE);
  });

  it('proposes nothing when a connected source already answers the unknown at least as well', () => {
    const connected = connectedCorpora();
    expect(connected.has('gdelt')).toBe(true);
    const evaluation = evaluateCorpora(needFromUnknown(news, [...connected]));
    expect(evaluation.decisions[0]!.corpusId).toBe('gdelt');
    expect(corpusToAdd(evaluation, connected)).toBeNull();
  });

  it('proposes nothing that answers too little to pay for a connector, or for an unknown no corpus answers', () => {
    const connected = new Set<string>();
    const thin = evaluateCorpora({ purpose: 'thin', factKinds: ['web-page', 'a', 'b', 'c', 'd'], connected: [] });
    expect(thin.decisions[0]!.score).toBeLessThan(CORPUS_PROPOSAL_MIN_SCORE);
    expect(corpusToAdd(thin, connected)).toBeNull();
    expect(corpusToAdd(evaluateCorpora(needFromUnknown({ key: 'none', question: 'Is the sky blue?', condition: '' }, [])), connected)).toBeNull();
  });

  it('the weakness asks for the connector in the owner of feed sources, keyed once per corpus', () => {
    const connected = connectedCorpora();
    const need = needFromUnknown(filings, [...connected]);
    const add = corpusToAdd(evaluateCorpora(need), connected)!;
    const weakness = corpusConnectorWeakness(add, need, filings.key);
    expect(weakness.key).toBe(corpusProposalKey('sec-edgar'));
    expect(weakness.ownerComponent).toBe('server/services/feeds/sources.ts');
    expect(weakness.problem).toContain('company-filing');
    expect(weakness.problem).toContain(filings.key);
    // A domain class is asked to be discovered, not assumed to be one source.
    const domain = CORPORA.find((c) => c.kind === 'DOMAIN_CLASS')!;
    const classWeakness = corpusConnectorWeakness({ ...add, corpusId: domain.id, label: domain.label, kind: 'DOMAIN_CLASS' }, need, filings.key);
    expect(classWeakness.problem).toMatch(/^.*Discover the specific/s);
  });
});

describe('discovery runs on real unknowns and reaches the improvement loop', () => {
  it('records each unknown’s evaluation and registers only the corpus that pays', async () => {
    await freshProject();
    const registered: Weakness[] = [];
    const out = await discoverCorporaForUnknowns({
      projectId: 'prj_discovery',
      unknowns: [filings, news],
      now: new Date('2026-11-17T09:00:00.000Z'),
      register: async (w) => {
        registered.push(w);
      },
    });
    expect(out).toEqual([
      expect.objectContaining({ questionKey: 'q-filings', proposed: 'sec-edgar' }),
      expect.objectContaining({ questionKey: 'q-news', proposed: null }),
    ]);
    expect(registered.map((w) => w.key)).toEqual([corpusProposalKey('sec-edgar')]);
    const rows = await getDb().all<{ measures: string }>(`SELECT measures FROM bin_events WHERE event_type = ? ORDER BY at, id`, [CORPUS_EVALUATION_EVENT]);
    const purposes = rows.map((row) => (JSON.parse(row.measures) as { purpose: string }).purpose);
    expect(purposes.some((p) => p.startsWith('missing link q-filings'))).toBe(true);
    expect(purposes.some((p) => p.startsWith('missing link q-news'))).toBe(true);
  });

  it('turns the proposal into an improvement candidate through the real loop, once per corpus', async () => {
    await freshProject();
    const now = new Date('2026-11-17T09:00:00.000Z');
    await discoverCorporaForUnknowns({ projectId: 'prj_discovery', unknowns: [filings], now });
    await discoverCorporaForUnknowns({ projectId: 'prj_discovery', unknowns: [{ ...filings, key: 'q-filings-2' }], now });
    const candidates = (await listCandidates()).filter((one) => one.weaknessKey === corpusProposalKey('sec-edgar'));
    expect(candidates).toHaveLength(1);
  });
});

describe('the production entry point weighs the corpora for every unknown it asks', () => {
  it('openFeedShortlist records a corpus evaluation per pending missing-link question, in the question’s own words', async () => {
    const projectId = (await freshProject()).project.id;
    const owner = await createUser({ email: `corpora-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const now = new Date();
    const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
    const due = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    await insertFeedItems('rfq-board', [
      { externalId: 'corp-rfq', url: 'https://board.test/corp-rfq', title: 'Request for quotes: gutter cleaning', body: `Seeking quotes from a supplier in Tulsa, OK by ${due}. Budget $300.`, organization: 'Maple HOA', publishedAt: hoursAgo(5) },
      { externalId: 'corp-ad', url: 'https://board.test/corp-ad', title: 'Gutter cleaning now booking', body: 'We offer gutter cleaning in Tulsa, OK for $150.', organization: 'Clear Gutters', publishedAt: hoursAgo(4) },
    ]);
    await runFeedLoopCycle(projectId, { pulled: [], detectors: [], now });
    const pending = await pendingLoopQuestions(projectId, now);
    expect(pending.length).toBeGreaterThan(0);

    await openFeedShortlist({ projectId, now });
    const rows = await getDb().all<{ measures: string; project_id: string | null }>(
      `SELECT measures, project_id FROM bin_events WHERE event_type = ? AND workload_class = 'feeds-discovery'`,
      [CORPUS_EVALUATION_EVENT],
    );
    const purposes = rows.map((row) => (JSON.parse(row.measures) as { purpose: string }).purpose);
    for (const q of pending) expect(purposes.some((p) => p.startsWith(`missing link ${q.key}`))).toBe(true);
    for (const row of rows) expect(row.project_id).toBe(projectId);
    // Not a connected source confirming itself: the need's fact kinds are read from the question, never declared by a source.
    for (const row of rows) {
      const measures = JSON.parse(row.measures) as { factKinds: string[]; connected: string[] };
      expect(measures.connected.length).toBeGreaterThan(0);
    }
    resetEventGraph();
  });
});
