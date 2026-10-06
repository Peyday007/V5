/**
 * One pass that fails must not freeze every pass after it.
 *
 * Production: the shared-findings promotion — the first pass of the Russell
 * tick — hit a statement timeout on a busy database, the single `try` around
 * the whole tick ended there, and because the next tick began at the same
 * pass, the research-goal continuation and everything below it never ran
 * again. This makes that first pass throw on purpose and asserts the goal pass
 * still starts the goal's packet, the failure is recorded on the report and on
 * the cycle row, and the next healthy tick clears it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failing = vi.hoisted(() => ({ on: false }));
vi.mock('../server/repos/sharedFindings.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/sharedFindings.ts')>();
  return {
    ...actual,
    promoteEligibleClaims: async (...args: Parameters<typeof actual.promoteEligibleClaims>) => {
      if (failing.on) throw new Error('canceling statement due to statement timeout');
      return actual.promoteEligibleClaims(...args);
    },
  };
});

const renewal = vi.hoisted(() => ({ fail: false }));
vi.mock('../server/repos/russellMissions.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/russellMissions.ts')>();
  return {
    ...actual,
    renewLiveMissionReservations: async (
      ...args: Parameters<typeof actual.renewLiveMissionReservations>
    ) => {
      if (renewal.fail) throw new Error('renewal failed');
      return actual.renewLiveMissionReservations(...args);
    },
  };
});

import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { tick } from '../server/services/russell/loop.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
  failing.on = false;
});
afterEach(async () => {
  failing.on = false;
  await teardown();
});

describe('a failed pass is its own failure domain', () => {
  it('records the failure, and the research-goal pass after it still runs', async () => {
    const layer = await fixture.layerByName('Monetization Logic');
    const user = await createUser({
      email: `iso-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const goal = await createResearchGoal({
      projectId: fixture.project.id,
      ownerUserId: user.id,
      createdByUserId: user.id,
      name: 'Isolation',
      maxPackets: 2,
      maxFragments: 10,
      deadline: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      researchAssignment: 'How many people work in outsourced telemarketing, and where.',
      researchLayerId: layer.id,
    });

    failing.on = true;
    const broken = await tick('isolation');
    expect(broken.ran).toBe(true);
    expect(broken.passFailures.map((f) => f.pass)).toContain('shared-findings');
    expect(broken.passFailures[0]!.error).toMatch(/statement timeout/);
    // Everything after it still had its turn.
    expect(broken.researchGoals?.started).toHaveLength(1);
    const packets = await getDb().all<{ id: string }>(
      'SELECT id FROM research_orchestrations WHERE goal_id = ?',
      [goal.id],
    );
    expect(packets).toHaveLength(1);
    const bins = await getDb().all<{ id: string }>(
      "SELECT id FROM bins WHERE orchestration_id = ? AND state = 'READY'",
      [packets[0]!.id],
    );
    expect(bins).toHaveLength(1);
    const cycle = await getDb().get<{ last_error: string | null; lease_owner: string | null }>(
      'SELECT last_error, lease_owner FROM russell_cycle',
    );
    expect(cycle?.last_error).toMatch(/shared-findings/);
    // The lease was released, so the next tick is not locked out.
    expect(cycle?.lease_owner).toBeNull();

    // The failed pass is simply asked again next tick, and a healthy tick
    // clears the recorded error. Nothing was duplicated by the retry.
    failing.on = false;
    const healthy = await tick('isolation');
    expect(healthy.passFailures).toEqual([]);
    const after = await getDb().get<{ last_error: string | null }>('SELECT last_error FROM russell_cycle');
    expect(after?.last_error).toBeNull();
    expect(
      await getDb().all('SELECT id FROM research_orchestrations WHERE goal_id = ?', [goal.id]),
    ).toHaveLength(1);
  });
});

describe('what a member is shown about a pass that failed', () => {
  it('does not degrade every project for a pass the next tick retries, and still does for a failed tick', async () => {
    const { stateOf } = await import('../server/services/russell/home.ts');
    const base = { cycleState: 'RUNNING' as const, power: 'READY' as const, working: 1, decisionsWaiting: 0 };
    expect(stateOf({ ...base, cycleError: 'passes: design-kernel: boom' }).state).toBe('LIVE');
    expect(stateOf({ ...base, cycleError: 'the tick failed' }).state).toBe('DEGRADED');
  });
});

describe('a pass that guards the launch', () => {
  it('skips the launch when the reservation renewal failed, and records why', async () => {
    renewal.fail = true;
    try {
      const report = await tick('isolation');
      const launch = report.passFailures.find((one) => one.pass === 'launch');
      expect(report.passFailures.map((one) => one.pass)).toContain('renew-reservations');
      expect(launch?.error).toMatch(/skipped/);
      expect(report.launched).toEqual([]);
    } finally {
      renewal.fail = false;
    }
  });
});
