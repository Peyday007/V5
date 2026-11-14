/**
 * PORT-05, finding F5: a person's goals read must not pay goals × openings ×
 * ten queries. One read shares one context: each project's five commercial
 * grants are read once, the capability readings once, and goals are derived a
 * bounded number at a time rather than one after another; a reading that fails
 * says why instead of reading as an empty goal.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => ({ authority: 0, capabilities: 0 }));

vi.mock('../server/services/cash/authority.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/cash/authority.ts')>();
  return {
    ...real,
    checkCommercialAuthority: async (...args: Parameters<typeof real.checkCommercialAuthority>) => {
      counts.authority += 1;
      return real.checkCommercialAuthority(...args);
    },
  };
});
vi.mock('../server/services/cash/capabilities.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/cash/capabilities.ts')>();
  return {
    ...real,
    readAllCapabilities: async (...args: Parameters<typeof real.readAllCapabilities>) => {
      counts.capabilities += 1;
      return real.readAllCapabilities(...args);
    },
  };
});

import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { createWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import { noteGoalStreamsCleared, PORT05_READ_CONCURRENCY, readPort05, readPort05ForGoals } from '../server/services/goals/port05.ts';
import { EXTERNAL_ACTION_LIST } from '../server/services/goals/offerReadiness.ts';

describe('the goals read shares one PORT-05 context', () => {
  let projectId = '';
  let userId = '';
  const goalIds: string[] = [];

  beforeEach(async () => {
    noteGoalStreamsCleared();
    goalIds.length = 0;
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `p5c-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    for (let g = 0; g < 3; g += 1) {
      const goal = await createWorkstream({ projectId, title: `Collect cash ${g}`, intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
      goalIds.push(goal.id);
      for (let o = 0; o < 3; o += 1) {
        const opened = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: `Monthly bookkeeping ${g}-${o}`, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', industry: 'dental', source: `https://example.com/${g}/${o}` });
        if (!opened.ok) throw new Error(opened.reason);
        await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: opened.value.id, relation: 'PURSUES', recordedBy: 'PERSON', recordedByUserId: userId });
      }
    }
  });

  afterAll(async () => {
    await teardown();
  });

  it('reads each project’s commercial grants and the capability readings once per read, not once per goal and opening', async () => {
    counts.authority = 0;
    counts.capabilities = 0;
    const read = await assembleGoals({ projectIds: [projectId] });
    const mine = read.goals.filter((one) => goalIds.includes(one.id));
    expect(mine).toHaveLength(3);
    for (const view of mine) {
      expect(view.port05Unread ?? null).toBeNull();
      expect(view.port05!.offers).toHaveLength(3);
      expect(view.port05!.credits).toHaveLength(3);
    }
    // 3 goals × 3 openings used to cost 45 grant checks and 3 capability reads.
    expect(counts.authority).toBe(EXTERNAL_ACTION_LIST.length);
    expect(counts.capabilities).toBe(1);
  });

  it('gives the same reading as deriving each goal alone', async () => {
    const now = new Date();
    const batched = await readPort05ForGoals(goalIds.map((goalId) => ({ goalId })), now);
    for (const goalId of goalIds) {
      const alone = await readPort05(goalId, now);
      const outcome = batched.get(goalId)!;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.reason);
      expect(outcome.reading).toEqual(alone);
    }
  });

  it('does not re-read grants in a later read: the context lives for one read only', async () => {
    await assembleGoals({ projectIds: [projectId] });
    counts.authority = 0;
    await assembleGoals({ projectIds: [projectId] });
    expect(counts.authority).toBe(EXTERNAL_ACTION_LIST.length);
  });
});

describe('the batch reader', () => {
  it('derives goals concurrently, never more than its bound at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return [];
    };
    const goals = Array.from({ length: 10 }, (_, i) => ({ goalId: `wst_${i}`, opportunityIds: [] }));
    const out = await readPort05ForGoals(goals, new Date(), { deps: { streams: () => null, credits: slow, offers: async () => [] } });
    expect(out.size).toBe(10);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(PORT05_READ_CONCURRENCY);
  });

  it('returns a failed reading with its reason rather than swallowing it to nothing', async () => {
    const out = await readPort05ForGoals([{ goalId: 'wst_ok', opportunityIds: [] }, { goalId: 'wst_bad', opportunityIds: [] }], new Date(), {
      deps: {
        streams: () => null,
        credits: async (goalId) => {
          if (goalId === 'wst_bad') throw new Error('fulfilment rows unreadable');
          return [];
        },
        offers: async () => [],
      },
    });
    expect(out.get('wst_ok')).toMatchObject({ ok: true });
    expect(out.get('wst_bad')).toEqual({ ok: false, reason: 'fulfilment rows unreadable' });
  });

  it('is called once per read from the goal model, which carries a failure’s reason on the view', () => {
    const model = readFileSync('server/services/goals/model.ts', 'utf8');
    expect(model).toMatch(/await readPort05ForGoals\(/);
    expect(model).not.toMatch(/await readPort05\(goal\.id/);
    expect(model).toMatch(/port05Unread/);
    expect(model).not.toMatch(/catch \{\s*\/\/[^\n]*\n\s*port05 = null/);
  });
});
