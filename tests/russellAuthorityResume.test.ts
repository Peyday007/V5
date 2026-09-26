/**
 * A park for missing standing authority resumes on an ordinary project, not
 * only inside Cash Mode.
 *
 * `judgeCandidate` (`server/services/russell/planning.ts`) correctly parks an
 * idea when its project holds no live standing authority covering RESEARCH,
 * with `judgment.blockedBy` naming one of the three exact sentences
 * `standingAuthority()` composes. Until `server/services/russell/resumeParked.ts`
 * existed, nothing reconsidered that park once a person granted the authority:
 * `unjudged()` in `./loop.ts` selects `priority IS NULL`, and a park carries
 * `priority = 'PARKED'` for ever. The only resume that existed was
 * `resumeAuthorityParkedCandidates` in `server/services/cash/discoveryAuthority.ts`,
 * gated on a goal named `'Cash Mode internal discovery'` specifically — so the
 * park had a way back on exactly one kind of project and was permanent on every
 * other one. Recorded as a defect in `docs/STEP-12B-BACKLOG.md`.
 *
 * These tests drive the general mechanism directly, on an ordinary project
 * that never runs Cash Mode — `freshProject()`'s own Deal Dispatch fixture,
 * which holds no `cash_modes` row at all. `tests/cashPipelineRepair.test.ts`
 * already covers `resumeAuthorityParkedCandidates` itself, so it is left
 * untouched here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../server/services/russell/launch.ts';
import {
  resumeParkedAcrossProjects,
  resumeParkedForProject,
} from '../server/services/russell/resumeParked.ts';
import {
  createCandidate,
  getCandidate,
  recordJudgment,
} from '../server/repos/russellCandidates.ts';
import { getCashMode, listCashEvents } from '../server/repos/cashMode.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `authority-resume-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

/**
 * Park a candidate exactly as `judgeCandidate`/`standingAuthority` would: the
 * state and priority that write, and a `judgment.blockedBy` naming the exact
 * missing-authority sentence `checkAuthority` produces when a project has no
 * live grant at all.
 */
async function parkForMissingAuthority(statement: string): Promise<string> {
  const candidate = await createCandidate({
    projectId,
    visibility: 'SHARED',
    title: statement,
    statement,
  });
  await recordJudgment({
    candidateId: candidate.id,
    state: 'PARKED',
    priority: 'PARKED',
    reason: 'this depends on no standing authority exists for this project, which is not ready',
    judgment: { blockedBy: 'no standing authority exists for this project' },
    supporting: [],
    contradicting: [],
  });
  return candidate.id;
}

/** A live standing authority covering RESEARCH on this project, granted by a person. */
async function grantAuthority(): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Research this project directly',
    allowedWork: [RESEARCH_WORK_CLASS],
    maxMissions: 5,
    maxFragments: 20,
    maxConcurrent: 2,
    maxProbes: 5,
  });
}

describe('a park for missing authority resumes on an ordinary project', () => {
  it('is judged again once a person grants standing authority and one tick runs', async () => {
    // No Cash Mode goal exists anywhere on this project: `freshProject()`
    // seeds an ordinary Deal Dispatch project rather than a cash sprint, so
    // the only mechanism reaching this park is the general one.
    expect(await getCashMode(projectId)).toBeNull();

    const candidateId = await parkForMissingAuthority(
      'Who is publicly asking to pay for work right now?',
    );
    const before = await getCandidate(candidateId);
    expect(before!.state).toBe('PARKED');
    expect(before!.priority).toBe('PARKED');

    await grantAuthority();

    // `resumeParkedAcrossProjects` is precisely what `tick()` in loop.ts
    // calls for this step, ahead of `unjudged()` in the same pass — calling
    // it directly exercises the identical mechanism the durable tick runs,
    // without the rest of that pass's unrelated side effects.
    const resumed = await resumeParkedAcrossProjects();
    expect(resumed.map((one) => one.candidateId)).toEqual([candidateId]);
    expect(resumed[0]!.projectId).toBe(projectId);

    const after = await getCandidate(candidateId);
    // Back where `unjudged()` will find it — that selector reads
    // `priority IS NULL` — and it is the same row, not a second one.
    expect(after!.priority).toBeNull();
    expect(after!.state).toBe('CAPTURED');
    expect(after!.id).toBe(candidateId);
  });

  it('leaves a candidate parked for any other reason exactly where it is', async () => {
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'A question this project has already researched',
      statement: 'Something the archive already answered.',
    });
    await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason: 'this project having a layer to file the work under is not ready',
      // Not one of the three exact standing-authority sentences: a different
      // fact, and resuming it would be Brain re-answering a question a
      // person already answered.
      judgment: { blockedBy: 'this project having a layer to file the work under' },
      supporting: [],
      contradicting: [],
    });

    await grantAuthority();

    expect(await resumeParkedAcrossProjects()).toEqual([]);
    expect(await resumeParkedForProject({ projectId })).toEqual([]);

    const after = await getCandidate(candidate.id);
    expect(after!.state).toBe('PARKED');
    expect(after!.priority).toBe('PARKED');
    expect(after!.reason).toBe(
      'this project having a layer to file the work under is not ready',
    );
    expect(after!.judgment['blockedBy']).toBe(
      'this project having a layer to file the work under',
    );
  });

  it('resumes nothing with no grant, and a race resumes exactly once with exactly one recorded event', async () => {
    const candidateId = await parkForMissingAuthority(
      'Which buyers have published a paid request?',
    );

    // With no live grant on the project, neither entrance moves anything.
    expect(await resumeParkedForProject({ projectId })).toEqual([]);
    expect(await resumeParkedAcrossProjects()).toEqual([]);
    expect((await getCandidate(candidateId))!.state).toBe('PARKED');
    expect((await getCandidate(candidateId))!.priority).toBe('PARKED');

    await grantAuthority();

    // Two callers racing for the same row. `resumeRow`'s guarded
    // `UPDATE ... WHERE id = ? AND state = 'PARKED' AND priority = 'PARKED'`
    // is the arbiter: the row's own update is atomic on both backends, so
    // whichever call's statement lands first wins outright and the other's
    // statement then matches nothing, exactly as `tests/cashAuthority.test.ts`
    // races two commitments against one ceiling through a plain
    // `Promise.all` — a losing call is an ordinary empty result, not an error.
    //
    // Raced through `resumeParkedAcrossProjects` rather than the
    // project-scoped core, because `resumeParkedForProject` deliberately
    // records nothing itself (see resumeParked.ts's own header comment) —
    // recording is the tick-wide sweep's job, onto `cash_events`, which is
    // documented there as the nearest already-existing append-only,
    // per-project ledger available inside that change's approved scope.
    const [first, second] = await Promise.all([
      resumeParkedAcrossProjects(),
      resumeParkedAcrossProjects(),
    ]);
    const winners = [...first, ...second];
    expect(winners).toHaveLength(1);
    expect(winners[0]!.candidateId).toBe(candidateId);

    const after = await getCandidate(candidateId);
    expect(after!.priority).toBeNull();
    expect(after!.state).toBe('CAPTURED');

    const authorityEvents = (await listCashEvents(projectId)).filter(
      (event) => event.kind === 'RUSSELL_AUTHORITY_PARK_RESUMED',
    );
    expect(authorityEvents).toHaveLength(1);
    expect((authorityEvents[0]!.detail as { candidateId?: string }).candidateId).toBe(
      candidateId,
    );

    // Idempotent afterwards too: a further pass over an already-resumed
    // candidate produces neither a resumption nor a second event.
    expect(await resumeParkedAcrossProjects()).toEqual([]);
    expect(
      (await listCashEvents(projectId)).filter(
        (event) => event.kind === 'RUSSELL_AUTHORITY_PARK_RESUMED',
      ),
    ).toHaveLength(1);
  });
});
