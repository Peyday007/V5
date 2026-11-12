/**
 * One Cash tick asked every live goal's limits once per opening per pass, and
 * each answer listed every workstream and summed the ledger: in production
 * that starved the process (2026-10-31). Inside a memo scope the answer is read
 * once per (project, minute); outside one it is read every time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { liveGoalLimits, withGoalLimitsMemo } from '../server/services/cash/worthResearching.ts';

let projectId = '';
const now = new Date().toISOString();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  const userId = (await createUser({ email: `gl-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, capitalCeilingCents: 50_000, now: new Date(Date.now() - 60_000) });
  expect(set.ok).toBe(true);
});

describe('goal limits inside one pass', () => {
  it('are read once per project and minute inside a memo scope', async () => {
    await withGoalLimitsMemo(async () => {
      const a = await liveGoalLimits(projectId, now);
      const b = await liveGoalLimits(projectId, now);
      expect(a).toHaveLength(1);
      expect(b).toBe(a);
    });
  });

  it('are read afresh outside any scope', async () => {
    const a = await liveGoalLimits(projectId, now);
    const b = await liveGoalLimits(projectId, now);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
  });

  it('the production tick and both cash page reads run inside a scope', () => {
    expect(readFileSync('server/services/russell/loop.ts', 'utf8')).toMatch(/withGoalLimitsMemo\(\(\) => operate\(project\.id\)\)/);
    expect(readFileSync('server/services/cash/view.ts', 'utf8')).toMatch(/withGoalLimitsMemo\(\(\) => cashViewUnmemoized\(input\)\)/);
    expect(readFileSync('server/services/cash/shared.ts', 'utf8')).toMatch(/withGoalLimitsMemo\(\(\) => sharedFrontierUnmemoized\(input\)\)/);
  });
});
