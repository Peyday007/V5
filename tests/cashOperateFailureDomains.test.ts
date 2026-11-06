/**
 * A cash step that throws does not skip the deep dives after it (§63).
 *
 * Production, 2026-11-06 01:33–04:30Z: eight eligible openings, a free slot,
 * ticks completing, and no deep dive started for six hours. `operate` ran its
 * steps as one chain inside the tick's silent `catch`, so one dropped
 * connection in an early step skipped `runValidations` and nothing said so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/services/cash/answers.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/cash/answers.ts')>();
  return { ...original, applyResearchAnswers: vi.fn(original.applyResearchAnswers) };
});
vi.mock('../server/services/cash/validation.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/cash/validation.ts')>();
  return { ...original, runValidations: vi.fn(original.runValidations) };
});

import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { applyResearchAnswers } from '../server/services/cash/answers.ts';
import { runValidations } from '../server/services/cash/validation.ts';
import { operate } from '../server/services/cash/operate.ts';

let projectId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `domains-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  const outcome = await activate({
    projectId,
    ownerUserId: user.id,
    actorUserId: user.id,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
});
afterEach(async () => {
  vi.mocked(applyResearchAnswers).mockReset();
  await teardown();
});

describe('operate keeps each step in its own failure domain', () => {
  it('still runs the deep dives when an earlier step throws, and returns the failure', async () => {
    vi.mocked(runValidations).mockClear();
    vi.mocked(applyResearchAnswers).mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'));
    const operated = await operate(projectId);
    expect(vi.mocked(runValidations)).toHaveBeenCalledTimes(1);
    expect(operated.failures).toEqual([
      { step: 'applyResearchAnswers', error: 'Connection terminated due to connection timeout' },
    ]);
    expect(operated.research).toEqual({ applied: [], unanswered: [] });
  });

  it('reports no failures on a pass where every step ran', async () => {
    const operated = await operate(projectId);
    expect(operated.failures).toEqual([]);
  });
});
