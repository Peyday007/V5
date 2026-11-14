/**
 * Review finding: promotedHere(), latestReview() and the register's latest()
 * took `.at(-1)` of `listFactoryEvents(..., { limit: 5000 })`, which answers
 * oldest first. Past 5000 rows of a kind the "newest" was frozen at the
 * 5000th-oldest. This pins the newest-first reads on a ledger past that cap.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { CAPABILITY_EVENT_KINDS, productionCapabilityPorts } from '../server/services/goals/capabilityPromotion.ts';
import { REGISTER_EVENT_KINDS, productionRegisterPorts } from '../server/services/goals/openQuestions.ts';
import { newestFactoryEvent, allFactoryEventsOldestFirst } from '../server/services/goals/newestEvents.ts';
import { recordFactoryEvent } from '../server/repos/factoryFleet.ts';
import { freshProject } from './helpers.ts';

const OLD = 5001;

/** `OLD` events of `kind`, all timestamped before anything recordFactoryEvent writes now. */
async function seedOld(kind: string, detail: (i: number) => Record<string, unknown>): Promise<void> {
  const db = getDb();
  const batch = 250;
  for (let start = 0; start < OLD; start += batch) {
    const n = Math.min(batch, OLD - start);
    const values: (string | null)[] = [];
    for (let i = start; i < start + n; i++) {
      const at = new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString();
      values.push(`fev_seed_${kind}_${i}`, kind, 'MEASURED', JSON.stringify(detail(i)), at);
    }
    await db.run(
      `INSERT INTO factory_events (id, kind, evidence_class, detail, at) VALUES ${Array.from({ length: n }, () => '(?, ?, ?, ?, ?)').join(', ')}`,
      values,
    );
  }
}

describe('newest-event reads past the 5000-row cap of listFactoryEvents', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('latestReview reads the newest review, not the 5000th-oldest', async () => {
    await seedOld(CAPABILITY_EVENT_KINDS.reviewed, (i) => ({ programId: 'fpg', fingerprint: `old-${i}` }));
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'fpg', fingerprint: 'newest' } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'other', fingerprint: 'not-mine' } });
    expect(await (await productionCapabilityPorts()).latestReview?.('fpg')).toBe('newest');
  });

  it('promotedHere sees a promotion and its demotion recorded after 5000 older transitions', async () => {
    await seedOld(CAPABILITY_EVENT_KINDS.promoted, (i) => ({ programId: 'fpg', requirement: `r${i % 3}`, evidence: ['x'] }));
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.demoted, evidenceClass: 'MEASURED', detail: { programId: 'fpg', requirement: 'r0' } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.promoted, evidenceClass: 'MEASURED', detail: { programId: 'fpg', requirement: 'late' } });
    const promoted = await (await productionCapabilityPorts()).promotedHere('fpg');
    expect([...promoted].sort()).toEqual(['late', 'r1', 'r2']);
  });

  it("the register's latest() reads the newest outcome", async () => {
    await seedOld(REGISTER_EVENT_KINDS.behind, (i) => ({ fingerprint: `old-${i}` }));
    await recordFactoryEvent({ kind: REGISTER_EVENT_KINDS.current, evidenceClass: 'MEASURED', detail: { fingerprint: 'newest' } });
    expect((await (await productionRegisterPorts()).latest())?.detail.fingerprint).toBe('newest');
  });

  it('pages reach old rows when no newer one matches, and keep oldest-first order', async () => {
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'a', n: 1 } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'b', n: 2 } });
    await recordFactoryEvent({ kind: CAPABILITY_EVENT_KINDS.reviewed, evidenceClass: 'MEASURED', detail: { programId: 'b', n: 3 } });
    expect((await newestFactoryEvent([CAPABILITY_EVENT_KINDS.reviewed], (e) => e.detail.programId === 'a', 1))?.detail.n).toBe(1);
    expect((await allFactoryEventsOldestFirst([CAPABILITY_EVENT_KINDS.reviewed], () => true, 2)).map((e) => e.detail.n)).toEqual([1, 2, 3]);
  });
});
