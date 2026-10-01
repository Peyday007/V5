/**
 * The launch window holds only ideas that could launch.
 *
 * `nextLaunchable` used to `LIMIT` every QUEUED candidate in the Brain and drop
 * the ones it could not act on afterwards. A launched idea stays QUEUED by
 * design, and an idea with no compiled specification is skipped without a
 * word, so once enough of either sat at the front of the order nothing behind
 * them was ever looked at. Production, 2026-10-01: a hundred QUEUED ideas, and
 * thirty-two deep dives closed by the stall backstop with `passes 0/0`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createCandidate, recordJudgment } from '../server/repos/russellCandidates.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { nextLaunchable } from '../server/services/russell/loop.ts';

let projectId: string;

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

async function queued(title: string, priority: 'MUST_DO' | 'WORTH_DOING', spec: boolean) {
  const candidate = await createCandidate({ projectId, title, statement: `${title} statement` });
  await recordJudgment({
    candidateId: candidate.id,
    state: 'QUEUED',
    priority,
    reason: 'test',
    judgment: spec ? { missionSpec: { projectId, objective: title } } : {},
  });
  return candidate;
}

async function missionFor(candidateId: string, key: string) {
  return (
    await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: key,
      whyNow: 'test',
      idempotencyKey: key,
      candidateId,
    })
  ).mission;
}

describe('the launch window', () => {
  it('is not filled by ideas that already have a mission, or have no specification', async () => {
    // Ahead of it in the order: more than the window of launched ideas and
    // unspecified ones, every one a higher priority than the idea behind them.
    for (let i = 0; i < 6; i += 1) {
      const live = await queued(`live ${i}`, 'MUST_DO', true);
      await missionFor(live.id, `live-${i}`);
      await queued(`unspecified ${i}`, 'MUST_DO', false);
    }
    const done = await queued('done', 'MUST_DO', true);
    const finished = await missionFor(done.id, 'done');
    await transitionMission({ missionId: finished.id, from: 'PLANNED', to: 'RUNNING' });
    await transitionMission({ missionId: finished.id, from: 'RUNNING', to: 'DONE' });

    const failed = await queued('failed', 'MUST_DO', true);
    const lost = await missionFor(failed.id, 'failed');
    await transitionMission({ missionId: lost.id, from: 'PLANNED', to: 'FAILED', terminalReason: 'x' });

    const behind = await queued('behind', 'WORTH_DOING', true);

    const ids = (await nextLaunchable(5)).map((entry) => entry.candidateId);
    // A window of five, smaller than the twelve unlaunchable rows ahead of it.
    expect(ids).toContain(behind.id);
    // A FAILED mission leaves the idea eligible: a new specification may launch.
    expect(ids).toContain(failed.id);
    expect(ids).not.toContain(done.id);
    expect(ids).toHaveLength(2);
  });
});
