/**
 * LEARN-15-1, repair F-LEARN-READS-WHOLE-LEDGER: a project's refresh reads its
 * own forecast ledger once. The learning step reads what keepCashLedger already
 * holds, and its own default read is scoped to the project, so a refresh never
 * reads every project's history or routes another project's corrections.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import * as db from '../server/db/database.ts';
import { keepCashLedger, recordExposure, recordOutcome, recordPrediction } from '../server/services/quant/ledger.ts';
import { learnFromCashLedger } from '../server/services/quant/knowledge.ts';
import type { CashForecast } from '../server/services/cash/forecast.ts';

afterEach(() => vi.restoreAllMocks());

const claim = (claimId: string) => ({
  claimId,
  outcome: 'revenue of 1000 USD cents (range 900..1100)',
  horizonDays: 30,
  population: 'qualified',
  data: ['rows'],
  assumptions: ['derived'],
  probability: 0.9,
  comparableKey: 'cash:USD:revenue',
});

/** Ten confident misses on one claim: enough for the model to call it systematic. */
async function missMany(claimId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const p = await recordPrediction({ ...claim(claimId), outcome: `revenue v${i}` });
    await recordExposure(p.id, 100);
    await recordOutcome(p.id, false);
  }
}

const ledgerReads = (spy: { mock: { calls: readonly (readonly unknown[])[] } }): unknown[][] =>
  spy.mock.calls
    .filter((c) => String(c[0]).includes('FROM bin_events') && String(c[0]).includes('event_type IN'))
    .map((c) => (c[1] ?? []) as unknown[]);

describe('learning reads one project’s ledger, once per refresh', () => {
  it('reads only the named project’s rows by default, so another project’s misses are not this project’s', async () => {
    await freshProject();
    await missMany('cash:prjA:USD:revenue');
    await missMany('cash:prjB:USD:revenue');
    const toFactory = vi.fn(async () => undefined);
    const reading = await learnFromCashLedger('prjA', ['USD'], { goals: async () => [], toFactory: toFactory as never });
    const claims = new Set(reading.ledger.map((e) => e.prediction.claimId));
    expect([...claims]).toEqual(['cash:prjA:USD:revenue']);
    for (const correction of reading.corrections) expect(correction.claimIds.every((c) => c.startsWith('cash:prjA:'))).toBe(true);
    for (const call of toFactory.mock.calls as unknown as [{ evidence: { samples: string[] } }][]) {
      expect(call[0].evidence.samples.every((c) => c.startsWith('cash:prjA:'))).toBe(true);
    }
  });

  it('keepCashLedger hands back the ledger it holds, including its own writes, and learning on it reads nothing again', async () => {
    await freshProject();
    await missMany('cash:prjB:USD:revenue');
    const forecast = {
      projectId: 'prjA',
      currency: 'USD',
      considered: 1,
      qualified: 1,
      revenue: { valueCents: 1000, lowCents: 900, highCents: 1100, basis: 'rows', fromRows: 1 },
      contribution: { valueCents: null, lowCents: null, highCents: null, basis: 'none', fromRows: 0 },
      upfrontCash: { valueCents: 50, lowCents: 50, highCents: 50, basis: 'rows', fromRows: 1 },
      timeToFirstDollar: { days: 30 },
    } as unknown as CashForecast;
    const kept = await keepCashLedger('prjA', ['USD'], { forecast: async () => forecast, measured: async () => [] });
    expect(kept.ledger.predictions.map((p) => p.claimId)).toEqual(['cash:prjA:USD:revenue']);
    expect(kept.ledger.exposures).toHaveLength(1);

    const handle = db.getDb();
    const spy = vi.spyOn(handle, 'all');
    vi.spyOn(db, 'getDb').mockReturnValue(handle);
    const reading = await learnFromCashLedger('prjA', ['USD'], { read: async () => kept.ledger, goals: async () => [] });
    expect(ledgerReads(spy)).toEqual([]);
    expect(reading.ledger.map((e) => e.prediction.claimId)).toEqual(['cash:prjA:USD:revenue']);
  });

  it('a default learning read is one project-scoped query, never the whole ledger', async () => {
    await freshProject();
    await missMany('cash:prjB:USD:revenue');
    const handle = db.getDb();
    const spy = vi.spyOn(handle, 'all');
    await learnFromCashLedger('prjA', ['USD'], { goals: async () => [] });
    const reads = ledgerReads(spy);
    expect(reads.length).toBeGreaterThan(0);
    for (const params of reads) expect(params).toContain('prjA');
  });
});
