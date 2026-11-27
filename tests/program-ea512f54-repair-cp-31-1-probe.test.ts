/*
 * CP-31 repair, episode 1: probe r01.cp-31 failed on 2026-11-27 with "The
 * database pool had no free connection within 10000ms" — not a judgement of
 * the counterparty model at all. The probe read every project's counterparties
 * through `opportunityCounterpartyProbe` and then read every project again
 * through `projectCounterparties`, each a chain of sequential per-opportunity
 * queries, beside every other probe on an 8-connection pool.
 *
 * These pin the repair: the probe's second half reuses the pass's readings
 * instead of re-querying them, one reading reads each reservation ledger once,
 * and an unreachable database is UNKNOWN (§26, §39), never a FAIL — while a
 * real breach is still a FAIL and a contracted primary still counts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  projects: [] as string[],
  opportunities: new Map<string, Array<{ id: string; projectId: string; title: string; state: string; fulfillmentOwner: string | null }>>(),
  readings: new Map<string, unknown>(),
  fail: null as Error | null,
  calls: { listOpportunities: 0, readOpportunityTransaction: 0, recordedReservationEvents: [] as string[][] },
}));

vi.mock('../server/repos/projects.ts', () => ({
  listProjects: async () => state.projects.map((id) => ({ id })),
}));
vi.mock('../server/repos/cashPortfolio.ts', () => ({
  listOpportunities: async ({ projectId }: { projectId: string }) => {
    state.calls.listOpportunities += 1;
    if (state.fail) throw state.fail;
    return state.opportunities.get(projectId) ?? [];
  },
}));
vi.mock('../server/repos/cashFulfillment.ts', () => ({ listFulfillments: async () => [] }));
vi.mock('../server/services/labor/counterparties/reservations.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/labor/counterparties/reservations.ts')>();
  return {
    ...real,
    recordedReservationEvents: async (ids: readonly string[]) => {
      state.calls.recordedReservationEvents.push([...ids]);
      return [];
    },
  };
});
vi.mock('../server/services/labor/counterparties/transaction.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/labor/counterparties/transaction.ts')>();
  return {
    ...real,
    readOpportunityTransaction: async ({ opportunityId }: { opportunityId: string }) => {
      state.calls.readOpportunityTransaction += 1;
      return state.readings.get(opportunityId);
    },
    sourcedCandidate: async (f: { counterpartyId: string }, kind: string) => ({ id: f.counterpartyId, kind, geography: null, facts: [] }),
  };
});

const ops = await import('../server/services/labor/counterparties/operations.ts');

const POOL = 'The database pool had no free connection within 10000ms: 8/8 connection(s) in use, 0 idle, 15 caller(s) waiting, ceiling 8.';

function reading(stage: string, over: Record<string, unknown> = {}) {
  return {
    commitmentId: 'c', source: null, comparison: {}, primary: { counterpartyId: 'fulfiller:a', stage }, alternative: { counterpartyId: 'fulfiller:b' },
    facts: [], compared: [], reserve: { permitted: false, reason: 'no grant' }, transfer: { applicable: false },
    deliverability: { deliverable: stage === 'CONTRACTED' || stage === 'PERFORMED', stage, reason: 'read' },
    doubleCommitted: [], needsHumanOperator: false, authority: { held: false, action: 'ENGAGE_CONTRACTOR' },
    ...over,
  };
}

function opportunity(projectId: string, id: string, stage: string, over: Record<string, unknown> = {}) {
  const list = state.opportunities.get(projectId) ?? [];
  list.push({ id, projectId, title: id, state: 'EXECUTING', fulfillmentOwner: 'Crew A' });
  state.opportunities.set(projectId, list);
  state.readings.set(id, {
    opportunityId: id, businessId: projectId,
    fulfillers: [
      { counterpartyId: 'fulfiller:a', name: 'A', sources: [`opportunity:${id}:fulfillmentOwner`], facts: [], priceCurrency: null },
      { counterpartyId: 'fulfiller:b', name: 'B', sources: ['fulfillment:f1'], facts: [], priceCurrency: null },
    ],
    reading: reading(stage, over), negotiations: [], detail: 'read',
  });
}

beforeEach(() => {
  ops.clearProbePass();
  state.projects = [];
  state.opportunities.clear();
  state.readings.clear();
  state.fail = null;
  state.calls = { listOpportunities: 0, readOpportunityTransaction: 0, recordedReservationEvents: [] };
});

describe('CP-31 repair: the probe is one bounded reading pass', () => {
  it('the second half of r01.cp-31 reuses the pass and issues no further reads', async () => {
    state.projects = ['p1', 'p2'];
    opportunity('p1', 'o1', 'CONTRACTED');
    opportunity('p2', 'o2', 'QUOTE');
    const first = await ops.opportunityCounterpartyProbe({});
    expect(first.ok).toBe(true);
    const reads = { ...state.calls, recordedReservationEvents: state.calls.recordedReservationEvents.length };

    let reached = 0;
    for (const p of state.projects) {
      for (const o of (await ops.projectCounterparties(p)).opportunities) {
        if (o.transaction.reading?.primary?.stage === 'CONTRACTED') reached += 1;
      }
    }
    expect(reached).toBe(1);
    expect(state.calls.listOpportunities).toBe(reads.listOpportunities);
    expect(state.calls.readOpportunityTransaction).toBe(reads.readOpportunityTransaction);
    expect(state.calls.recordedReservationEvents.length).toBe(reads.recordedReservationEvents);
  });

  it('one reading reads each reservation ledger once', async () => {
    state.projects = ['p1'];
    opportunity('p1', 'o1', 'QUOTE');
    opportunity('p1', 'o2', 'QUOTE');
    await ops.opportunityCounterpartyProbe({});
    const asked = state.calls.recordedReservationEvents.flat();
    expect(asked.sort()).toEqual(['fulfiller:a', 'fulfiller:b']);
  });

  it('a reading with explicit options never uses the pass', async () => {
    state.projects = ['p1'];
    opportunity('p1', 'o1', 'QUOTE');
    await ops.opportunityCounterpartyProbe({});
    const before = state.calls.listOpportunities;
    await ops.projectCounterparties('p1', { at: '2031-02-11T00:00:00.000Z' });
    expect(state.calls.listOpportunities).toBe(before + 1);
  });

  it('a pass reading expires', async () => {
    state.projects = ['p1'];
    opportunity('p1', 'o1', 'QUOTE');
    await ops.opportunityCounterpartyProbe({});
    const before = state.calls.listOpportunities;
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + ops.PROBE_PASS_TTL_MS + 1);
    try {
      await ops.projectCounterparties('p1');
    } finally {
      spy.mockRestore();
    }
    expect(state.calls.listOpportunities).toBe(before + 1);
  });
});

describe('CP-31 repair: an unreachable database is UNKNOWN, a breach is still FAIL', () => {
  it('pool exhaustion yields ok:null with the reason, never ok:false and never a throw', async () => {
    state.projects = ['p1'];
    opportunity('p1', 'o1', 'CONTRACTED');
    state.fail = new Error(POOL);
    const r = await ops.opportunityCounterpartyProbe({});
    expect(r.ok).toBeNull();
    expect(r.detail).toMatch(/database unavailable/);
    expect(r.detail).toMatch(/no free connection/);
    // The probe was a victim of the saturation, not its cause, and the record says so.
    expect(r.detail).toMatch(/held by other callers/);
    expect(r.detail).toContain(`at most ${ops.PROBE_PASS_PEAK_CONNECTIONS} pooled connection`);
    expect(r.detail).not.toMatch(/probe (held|exhausted)/i);
  });

  it('the pool\'s other refusal (below its ceiling) is UNKNOWN too, and is not blamed on this pass', async () => {
    state.projects = ['p1'];
    state.fail = new Error('The database would not give this pool a connection within 10000ms: 3/3 connection(s) in use, 0 idle, 2 caller(s) waiting, ceiling 8.');
    const r = await ops.opportunityCounterpartyProbe({});
    expect(r.ok).toBeNull();
    expect(r.detail).toMatch(/not this pass/);
    expect(r.detail).toMatch(/database or the network/);
  });

  it('any other error still propagates', async () => {
    state.projects = ['p1'];
    opportunity('p1', 'o1', 'CONTRACTED');
    state.fail = new Error('column "x" does not exist');
    await expect(ops.opportunityCounterpartyProbe({})).rejects.toThrow(/does not exist/);
  });

  it('a recorded breach of the model is still ok:false', async () => {
    state.projects = ['p1'];
    opportunity('p1', 'o1', 'QUOTE', { doubleCommitted: ['opportunity:o1'] });
    const r = await ops.opportunityCounterpartyProbe({});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/double-committed/);
  });

  it('r01.cp-31 reads the pass: UNKNOWN on pool exhaustion, PASS when a primary is contracted', async () => {
    const { getProbe } = await import('../server/services/factory/program/probes.ts');
    const probe = getProbe('r01.cp-31');
    expect(probe).not.toBeNull();

    state.projects = ['p1'];
    opportunity('p1', 'o1', 'CONTRACTED');
    state.fail = new Error(POOL);
    expect((await probe!({})).ok).toBeNull();

    state.fail = null;
    const passed = await probe!({});
    expect(passed.ok).toBe(true);
    expect(passed.detail).toMatch(/1 opportunity counterparties contracted or performed/);
  });
});
