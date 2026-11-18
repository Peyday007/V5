/**
 * B1h, production 2026-11-18: PR #1072 filed claim clm_9cf1f15cc99846198399
 * ("Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total
 * $4,675") as fact cfa_b20e6370575347e8881a, price_per_unit 0.47. PR #1076
 * changed the filer to read the deal-level total, but a fact is filed once per
 * claim, so production kept 0.47 and arrangement 2821cce3c372 scored 0 cents.
 *
 * The back-fill now re-derives a fact filed under the older rule: a NEW fact
 * names the one it supersedes (migration 158), the old row is never written,
 * and every reader resolves the current fact — so the plan reads $4,675.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { listConstructionFacts, listProjectConstructionFacts, recordClaimFact } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { backfillClaimFacts, rederivedAmount } from '../server/services/industry/expand.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
import type { ConstructionFactRow } from '../server/domain/types.ts';

const OPPIZI = 'Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total $4,675';

let projectId = '';
let buyerId = '';
let orchestrationId = '';
let fragmentId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const layer = await fixture.layerByName('Monetization Logic');
  const sector = await seedSubject({ projectId, name: 'Local marketing', actorRef: 'BRAIN' });
  const buyer = await seedSubject({ projectId, name: 'Local service businesses', kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' });
  buyerId = buyer.node.id;
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'mx' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Confirm or refute', assignment: 'mx', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'goal-mechanism',
      question: 'Do such buyers pay for this, and at what price?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['a published price list'], excludedSourceTypes: [], completionCriteria: ['A price.'],
      dependsOn: [], minIndependentSources: 1, status: 'RUNNING',
    },
  ]);
  orchestrationId = orchestration.id;
  fragmentId = fragment!.id;
});

async function claim(text: string, i: number): Promise<string> {
  const [row] = await insertClaims([
    {
      orchestrationId, fragmentId, passId: null, passKey: 'TARGETED' as const,
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/eddm-${i}`, sourceTitle: 'EDDM pricing',
      sourcePublisher: 'A printer', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'pricing', evidenceLane: 'economics',
      retrievedAt: '2026-11-17T20:40:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `b1h:${i}:${text}`,
    },
  ]);
  return row!.id;
}

/** A fact as the pre-#1076 filer wrote it: the per-unit figure, read as one deal. */
async function filedUnderOldRule(claimId: string, amount: number) {
  const fact = await recordClaimFact({
    projectId, nodeId: buyerId, claimId, key: 'price_per_unit', segment: `map_${buyerId}`, low: amount, high: amount, status: 'OBSERVED',
    measures: 'what these buyers are published paying per unit', sourceTitle: 'EDDM pricing', sourceUrl: 'https://example.org/eddm', sourceKind: 'SECONDARY',
    observedAt: '2026-11-01T00:00:00.000Z',
  });
  if (!fact) throw new Error('could not file the old fact');
  return fact;
}

describe('B1h: a claim fact filed under an older figure rule is superseded, never rewritten', () => {
  it('supersedes the 0.47 Oppizi fact with a 4675 fact, and constructionObservations reads 4675', async () => {
    const claimId = await claim(OPPIZI, 0);
    const old = await filedUnderOldRule(claimId, 0.47);
    expect((await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 })).priced[0]!.value).toEqual({ kind: 'POINT', value: 0.47 });

    const pass = await backfillClaimFacts(projectId);
    expect(pass.filed).toEqual([]);
    expect(pass.refiled).toHaveLength(1);
    expect(pass.refiled[0]).toMatchObject({ key: 'price_per_unit', segment: `map_${buyerId}`, low: 4675, high: 4675, status: 'OBSERVED', sourceClaimId: claimId, supersedesFactId: old.id, nodeId: buyerId });

    // History: the old row is untouched, and still in the table.
    const rows = await getDb().all<ConstructionFactRow>('SELECT * FROM construction_facts WHERE source_claim_id = ? ORDER BY created_at ASC, id ASC', [claimId]);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((one) => one.id === old.id)!;
    expect(Number(oldRow.low)).toBe(0.47);
    expect(Number(oldRow.high)).toBe(0.47);
    expect(oldRow.supersedes_fact_id ?? null).toBeNull();

    // Every reader resolves the current fact.
    expect((await listProjectConstructionFacts(projectId)).map((one) => [one.id, one.low])).toEqual([[pass.refiled[0]!.id, 4675]]);
    expect((await listConstructionFacts('wst_none', projectId)).map((one) => one.low)).toEqual([4675]);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.priced).toHaveLength(1);
    expect(read.priced[0]!.value).toEqual({ kind: 'POINT', value: 4675 });
    expect(read.priced[0]!.lineage).toEqual([`claim:${claimId}`]);

    // Idempotent: a replay supersedes nothing, and the same fact cannot be superseded twice.
    expect((await backfillClaimFacts(projectId)).refiled).toEqual([]);
    expect(
      await recordClaimFact({
        projectId, nodeId: buyerId, claimId, key: 'price_per_unit', segment: `map_${buyerId}`, low: 1, high: 1, status: 'OBSERVED',
        measures: 'x', sourceTitle: 'x', sourceUrl: null, sourceKind: 'SECONDARY', observedAt: '2026-11-01T00:00:00.000Z', supersedesFactId: old.id,
      }),
    ).toBeNull();
    expect(await getDb().all('SELECT id FROM construction_facts WHERE source_claim_id = ?', [claimId])).toHaveLength(2);
  });

  it('leaves a fact alone when the claim states rates only, or the fact already holds the current figure', async () => {
    const ratesOnly = await claim('A printer charges $0.26 per postcard piece.', 1);
    const kept = await filedUnderOldRule(ratesOnly, 0.26);
    const total = await claim(OPPIZI, 2);
    const current = await filedUnderOldRule(total, 4675);
    expect((await backfillClaimFacts(projectId)).refiled).toEqual([]);
    expect((await listProjectConstructionFacts(projectId)).map((one) => one.id).sort()).toEqual([kept.id, current.id].sort());
  });

  it('re-derives only a per-unit figure the claim states beside a total', () => {
    expect(rederivedAmount({ key: 'price_per_unit', low: 0.47, high: 0.47 }, OPPIZI)).toBe(4675);
    expect(rederivedAmount({ key: 'price_per_unit', low: 4675, high: 4675 }, OPPIZI)).toBeNull();
    expect(rederivedAmount({ key: 'price_per_unit', low: 0.26, high: 0.26 }, 'A printer charges $0.26 per postcard piece.')).toBeNull();
    // A declared figure the prose never states is not the filer's reading, so it is not re-derived.
    expect(rederivedAmount({ key: 'price_per_unit', low: 0.5, high: 0.5 }, OPPIZI)).toBeNull();
    expect(rederivedAmount({ key: 'take_rate' as never, low: 0.47, high: 0.47 }, OPPIZI)).toBeNull();
  });
});
