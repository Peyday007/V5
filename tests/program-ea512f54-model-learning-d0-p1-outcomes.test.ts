import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  claimedRange,
  readLedger,
  realizedDealsFrom,
  recordCashOutcomes,
} from '../server/services/quant/ledger.ts';
import type { CashOutcome } from '../server/domain/cashJourney.ts';
import type { ExposureRow, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';

/*
 * F-NO-OUTCOME-PRODUCER: the outcome ledger has a production producer. A deal
 * that ends writes its realized figures to `cash_outcomes` (journey tick →
 * recordOutcomes); the next knowledge refresh (`loadCashKnowledge` →
 * `keepCashLedger`) records them against the cash-forecast version that was
 * exposed when the deal ended, so a contradicted forecast is diagnosed from
 * production rows rather than from outcomes a test wrote by hand.
 */

const outcome = (over: Partial<CashOutcome> & Pick<CashOutcome, 'id' | 'kind' | 'opportunityId' | 'createdAt' | 'requestKey'>): CashOutcome => ({
  projectId: 'p',
  mechanism: null,
  channel: null,
  valueCents: null,
  valueMs: null,
  valueText: null,
  currency: 'USD',
  basis: 'b',
  ...over,
});

const prediction = (id: string, claimId: string, madeAt: string, outcomeText: string): PredictionRow => ({
  id,
  claimId,
  version: Number(id.split('@v')[1]),
  outcome: outcomeText,
  horizonDays: 10,
  population: 'pop',
  data: ['prices'],
  assumptions: ['derived from 4 opportunity row(s)'],
  probability: null,
  comparableKey: 'cash:USD:contribution',
  madeAt,
});

describe('realized deals are read from cash_outcomes rows', () => {
  it('takes the first end per deal, and revenue only when the cost at that end is on record', () => {
    const rows = [
      outcome({ id: 'r1', kind: 'REALIZED_CONTRIBUTION', opportunityId: 'o1', valueCents: 700, createdAt: '2026-01-02T00:00:00Z', requestKey: 'outcome:o1:REALIZED_CONTRIBUTION:COLLECTED' }),
      outcome({ id: 'c1', kind: 'ACTUAL_COST', opportunityId: 'o1', valueCents: 200, createdAt: '2026-01-02T00:00:00Z', requestKey: 'outcome:o1:ACTUAL_COST:COLLECTED' }),
      // A refund landing later is history, not a second end.
      outcome({ id: 'r1b', kind: 'REALIZED_CONTRIBUTION', opportunityId: 'o1', valueCents: 100, createdAt: '2026-01-05T00:00:00Z', requestKey: 'outcome:o1:REALIZED_CONTRIBUTION:after-x' }),
      outcome({ id: 'r2', kind: 'REALIZED_CONTRIBUTION', opportunityId: 'o2', valueCents: -50, createdAt: '2026-01-03T00:00:00Z', requestKey: 'outcome:o2:REALIZED_CONTRIBUTION:DECLINED' }),
      outcome({ id: 'x', kind: 'ACCEPTED_PRICE', opportunityId: 'o3', valueCents: 999, createdAt: '2026-01-01T00:00:00Z', requestKey: 'outcome:o3:ACCEPTED_PRICE:a' }),
    ];
    const deals = realizedDealsFrom(rows);
    expect(deals.map((d) => [d.opportunityId, d.contributionCents, d.revenueCents])).toEqual([
      ['o1', 700, 900],
      ['o2', -50, null],
    ]);
    expect(deals[0]!.evidence.contribution).toBe('cash_outcomes:r1');
  });

  it('reads the range a cash claim states, and nothing from a claim that states none', () => {
    expect(claimedRange({ outcome: 'revenue of 900 USD cents (range 100..800)' })).toEqual({ low: 100, high: 800 });
    expect(claimedRange({ outcome: 'sale closes' })).toBeNull();
  });
});

describe('recordCashOutcomes judges each deal against the version exposed when it ended', () => {
  const claimId = 'cash:p:USD:contribution';
  const ledger = () => {
    const predictions = [
      prediction(`${claimId}@v1`, claimId, '2026-01-01T00:00:00Z', 'contribution of 2000 USD cents (range 100..800)'),
      prediction(`${claimId}@v2`, claimId, '2026-01-10T00:00:00Z', 'contribution of 4000 USD cents (range 500..1500)'),
    ];
    const exposures: ExposureRow[] = predictions.map((p) => ({ predictionId: p.id, exposedAt: p.madeAt, atRiskCents: null }));
    const outcomes: OutcomeRow[] = [];
    const written: { measures: Record<string, unknown> }[] = [];
    return {
      predictions,
      exposures,
      outcomes,
      written,
      deps: {
        projectId: 'p',
        read: async () => ({ predictions, exposures, outcomes }),
        record: async (event: { measures?: Record<string, unknown> | null }) => {
          written.push({ measures: event.measures ?? {} });
        },
      },
    };
  };
  const ended = (id: string, opp: string, cents: number, at: string) =>
    outcome({ id, kind: 'REALIZED_CONTRIBUTION', opportunityId: opp, valueCents: cents, createdAt: at, requestKey: `outcome:${opp}:REALIZED_CONTRIBUTION:COLLECTED` });

  it('records whether the realized figure landed in that version’s range, once per version, with the timing it measured', async () => {
    const l = ledger();
    const rows = [
      ended('a', 'o1', 900, '2026-01-20T00:00:00Z'), // v1 is current? no: v2 was made 01-10, so v2 judges it — inside 500..1500
      ended('b', 'o2', 50, '2026-01-05T00:00:00Z'), // v1 current; outside 100..800
      ended('c', 'o3', 600, '2026-01-25T00:00:00Z'), // v2 already resolved: predicts nothing further
      ended('z', 'o0', 600, '2025-12-01T00:00:00Z'), // before any version was exposed
    ];
    const out = await recordCashOutcomes('p', rows, l.deps as never);
    expect(out.map((o) => [o.predictionId, o.occurred, o.realized, o.evidence])).toEqual([
      [`${claimId}@v1`, false, 50, 'cash_outcomes:b#contribution'],
      [`${claimId}@v2`, true, 900, 'cash_outcomes:a#contribution'],
    ]);
    // v2 was made 01-10 with a 10-day horizon; the deal ended 01-20: on time. v1's ended inside its horizon too.
    expect(out.every((o) => !o.observedCauses?.includes('TIMING'))).toBe(true);
    expect(out[0]!.observedAt).toBe('2026-01-05T00:00:00Z');
    expect(l.written.map((w) => w.measures.ledger)).toEqual(['OUTCOME', 'OUTCOME']);
  });

  it('a deal that ended past the version’s horizon is a measured timing overrun', async () => {
    const l = ledger();
    const out = await recordCashOutcomes('p', [ended('late', 'o9', 50, '2026-01-09T12:00:00Z')], l.deps as never);
    // v1: made 01-01, horizon 10 days → 01-11; ended 01-09: not late.
    expect(out[0]!.observedCauses ?? []).not.toContain('TIMING');
    const l2 = ledger();
    l2.predictions.splice(1, 1);
    const late = await recordCashOutcomes('p', [ended('late2', 'o9', 50, '2026-01-20T00:00:00Z')], l2.deps as never);
    expect(late[0]!.observedCauses).toContain('TIMING');
  });

  it('a version never exposed, or a deal already used, resolves nothing', async () => {
    const l = ledger();
    l.exposures.length = 0;
    expect(await recordCashOutcomes('p', [ended('a', 'o1', 900, '2026-01-20T00:00:00Z')], l.deps as never)).toEqual([]);
    const l2 = ledger();
    l2.outcomes.push({ predictionId: 'other@v1', observedAt: 't', occurred: true, evidence: 'cash_outcomes:a#contribution' });
    expect(await recordCashOutcomes('p', [ended('a', 'o1', 900, '2026-01-20T00:00:00Z')], l2.deps as never)).toEqual([]);
  });
});

describe('the production path: an ended deal reaches the outcome ledger through loadCashKnowledge', () => {
  it('records the outcome against the exposed version, and the knowledge reading judges it', async () => {
    const { createUser } = await import('../server/repos/identity.ts');
    const { activate } = await import('../server/services/cash/lifecycle.ts');
    const { createOpportunity, transitionOpportunity, updateOpportunity } = await import('../server/repos/cashPortfolio.ts');
    const { insertOutcome } = await import('../server/repos/cashJourney.ts');
    const { forgetKnowledge, loadCashKnowledge } = await import('../server/services/quant/knowledge.ts');
    const { getCashMode } = await import('../server/repos/cashMode.ts');
    const { project } = await freshProject();
    const user = await createUser({ email: `outcome-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId: project.id, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash.' })).ok).toBe(true);
    const cashModeId = (await getCashMode(project.id))!.id;
    const open = async (title: string, price: number, peak: number) => {
      const o = await createOpportunity({ projectId: project.id, cashModeId, ownerUserId: user.id, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
      await transitionOpportunity({ id: o.id, from: ['DISCOVERED'], to: 'EVIDENCE_CARD' });
      await updateOpportunity(o.id, { price_cents: price, peak_funding_cents: peak });
      return o;
    };
    const a = await open('A priced opening', 90_000, 20_000);
    await open('Another priced opening', 50_000, 10_000);

    // The forecast is recorded and exposed: revenue range 50000..90000, contribution 40000..70000.
    forgetKnowledge();
    await loadCashKnowledge(project.id);
    let ledger = await readLedger(project.id);
    expect(ledger.outcomes).toHaveLength(0);

    // The deal ends: the journey writes its realized figures (payments − refunds − costs − owed, and the cost).
    await insertOutcome({ projectId: project.id, opportunityId: a.id, kind: 'ACTUAL_COST', valueCents: 5_000, currency: 'USD', basis: 'ledger', requestKey: `outcome:${a.id}:ACTUAL_COST:COLLECTED` });
    await insertOutcome({ projectId: project.id, opportunityId: a.id, kind: 'REALIZED_CONTRIBUTION', valueCents: 10_000, currency: 'USD', basis: 'money.ts', requestKey: `outcome:${a.id}:REALIZED_CONTRIBUTION:COLLECTED` });

    forgetKnowledge();
    const knowledge = await loadCashKnowledge(project.id);
    ledger = await readLedger(project.id);
    const byClaim = new Map(ledger.outcomes.map((o) => [o.predictionId.split('@')[0], o]));
    // Realized revenue 15000 and contribution 10000 both landed outside the ranges the forecast stated.
    expect(byClaim.get(`cash:${project.id}:USD:revenue`)).toMatchObject({ occurred: false, realized: 15_000 });
    expect(byClaim.get(`cash:${project.id}:USD:contribution`)).toMatchObject({ occurred: false, realized: 10_000 });
    const rows = await getDb().all<{ project_id: string }>(`SELECT project_id FROM bin_events WHERE event_type = 'FORECAST_OUTCOME'`);
    expect(rows.map((r) => r.project_id)).toEqual([project.id, project.id]);
    // The reading the knowledge carries is judged on that production outcome, not on a hand-written one.
    const judged = knowledge.learning!.ledger.filter((e) => e.outcome !== null);
    expect(judged.map((e) => e.prediction.claimId).sort()).toEqual([`cash:${project.id}:USD:contribution`, `cash:${project.id}:USD:revenue`]);

    // A further refresh records nothing twice.
    forgetKnowledge();
    await loadCashKnowledge(project.id);
    expect((await readLedger(project.id)).outcomes).toHaveLength(2);
  });
});
