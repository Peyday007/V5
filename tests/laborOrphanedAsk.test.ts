/**
 * A candidate with no round is a question Brain pays for and cannot hear the
 * answer to.
 *
 * ---------------------------------------------------------------------------
 * The claim that was wrong
 * ---------------------------------------------------------------------------
 *
 * `openAsks` writes two rows: a Russell candidate, then the `labor_rounds` row
 * that points at it. The comment above it used to say that a tick dying between
 * the two was "harmless, because the next tick's insert collides on the same
 * key and **the orphan is never asked anything**".
 *
 * Nothing in Russell supports the second half. `createCandidate` writes state
 * `CAPTURED` with priority `NULL`, and `unjudged()` in
 * `services/russell/loop.ts` selects every candidate with `priority IS NULL AND
 * state <> 'MERGED' AND project_id IS NOT NULL`. There is no clause on that
 * path — none — asking whether a labor round points at the row. So an orphan is
 * judged, compiled (these questions specify perfectly well, which is the
 * problem), queued, and launched as a mission that spends a real fleet
 * activation and the project's allowance.
 *
 * Its answer is then discarded: `absorb` resolves a claim's orchestration
 * through the mission to the candidate to the round, finds no round, and files
 * nothing. The next tick asks the identical question on a second candidate.
 * **One question, paid for twice, answered into nothing once** — with every row
 * involved reading as healthy and the map simply staying empty.
 *
 * ---------------------------------------------------------------------------
 * What this pins, and why it is two cases rather than one
 * ---------------------------------------------------------------------------
 *
 * The invariant is one sentence: **every candidate `openAsks` creates has a
 * round pointing at it, or neither row exists.** Two different things can
 * break it, they arrive by different routes, and only one of them was in the
 * original reasoning.
 *
 *   1. The write fails partway — the crash the comment did consider.
 *   2. Another instance opened the identical ask first — which the comment did
 *      not, and which is the *more likely* of the two, because the tick runs on
 *      every instance and `allocate` is a pure function over a snapshot, so two
 *      instances compute the same ask and both reach `createCandidate`.
 *
 * Both are driven here through `openAsks` itself rather than through a helper,
 * because the defect was in the pairing rather than in either write.
 *
 * Every assertion below was run against the pre-transaction implementation and
 * fails there: the candidate survives in both cases. A regression test nobody
 * has seen fail is a claim rather than a reading.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import {
  createTask,
  createWorkflow,
  listLaborRounds,
  openLaborRound,
} from '../server/repos/labor.ts';
import { laborSnapshot, type LaborSnapshot } from '../server/services/labor/map.ts';
import { openAsks } from '../server/services/labor/expand.ts';
import type { Ask } from '../server/services/labor/allocate.ts';
import type { LaborTask } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `orphan-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

/** One declared workflow and one task under it, the way a person names work. */
async function seededTask(): Promise<LaborTask> {
  const workflow = await createWorkflow({
    projectId,
    name: `A workflow ${Math.random().toString(36).slice(2, 8)}`,
    origin: 'SEED',
    declaredByRef: userId,
  });
  const task = await createTask({
    projectId,
    workflowId: workflow.workflow.id,
    name: 'Write the summary',
    output: 'A one-page summary of what the buyer asked for.',
    origin: 'SEED',
    capabilityId: null,
    declaredByRef: userId,
  });
  return task.task;
}

function askFor(task: LaborTask): Ask {
  return {
    taskId: task.id,
    purpose: 'NECESSITY',
    round: 1,
    subject: task.name,
    since: task.createdAt,
    rank: 0,
    why: 'Nobody has decided who produces this.',
  };
}

describe('a candidate and its round are written together or not at all', () => {
  it('leaves no candidate when another instance opened the identical ask first', async () => {
    const task = await seededTask();
    const snapshot = await laborSnapshot(projectId);

    /*
     * The other instance, exactly as it would arrive: its own candidate, and
     * the round that wins the unique index on (project, task, purpose, round).
     * Nothing about this is synthetic — it is the pair `openAsks` itself
     * writes, one moment earlier.
     */
    const winner = await createCandidate({
      projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: 'The other instance got here first',
      statement: 'What published rule requires a person for work of this kind?',
    });
    const first = await openLaborRound({
      projectId,
      taskId: task.id,
      purpose: 'NECESSITY',
      round: 1,
      candidateId: winner.id,
    });
    expect(first.created).toBe(true);

    const before = await listCandidates({ projectId, limit: 500 });

    const opened = await openAsks({ projectId, asks: [askFor(task)], snapshot });

    // The loser reports nothing opened, which is an ordinary outcome.
    expect(opened).toEqual([]);

    // And leaves nothing behind. This is the assertion that fails against the
    // pre-transaction implementation: there, a second candidate survives.
    const after = await listCandidates({ projectId, limit: 500 });
    expect(after.map((one) => one.id).sort()).toEqual(before.map((one) => one.id).sort());

    // The winner's round is untouched, and there is exactly one.
    const rounds = await listLaborRounds(projectId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.candidateId).toBe(winner.id);
  });

  it('leaves no candidate when the round cannot be written', async () => {
    const task = await seededTask();
    const real = await laborSnapshot(projectId);

    /*
     * The write failing partway, injected from rows rather than from a stub.
     *
     * `labor_rounds.task_id` is `REFERENCES labor_tasks(id)`, so a snapshot
     * naming a task that is not there makes the *second* of the two writes fail
     * in both dialects — which is the shape of the original crash window,
     * reached deterministically. A stubbed `openLaborRound` would have proved
     * only that the stub threw.
     */
    const phantom: LaborSnapshot = {
      ...real,
      coverage: real.coverage.map((one) => ({
        ...one,
        task: { ...one.task, id: 'ltk_this_row_does_not_exist' },
      })),
    };
    const ask: Ask = { ...askFor(task), taskId: 'ltk_this_row_does_not_exist' };

    const before = await listCandidates({ projectId, limit: 500 });

    await expect(openAsks({ projectId, asks: [ask], snapshot: phantom })).rejects.toThrow();

    const after = await listCandidates({ projectId, limit: 500 });
    expect(after.map((one) => one.id).sort()).toEqual(before.map((one) => one.id).sort());
    expect(await listLaborRounds(projectId)).toEqual([]);
  });

  it('opens the pair and reports it, when nothing is in the way', async () => {
    /*
     * The success path, asserted here as well, because a rollback that rolled
     * back everything would pass both tests above and do nothing at all. §41
     * records what a vacuous guard costs: it reads as coverage.
     */
    const task = await seededTask();
    const snapshot = await laborSnapshot(projectId);

    const opened = await openAsks({ projectId, asks: [askFor(task)], snapshot });
    expect(opened).toHaveLength(1);

    const rounds = await listLaborRounds(projectId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.candidateId).toBe(opened[0]?.candidateId);

    const candidates = await listCandidates({ projectId, limit: 500 });
    expect(candidates.map((one) => one.id)).toContain(opened[0]?.candidateId);
  });
});

describe('why an orphan was never harmless', () => {
  it('is indistinguishable from an ordinary idea, in the three columns Russell selects on', async () => {
    /*
     * The reachability half, from the row rather than from an argument. A
     * candidate this kernel creates carries a null priority, state `CAPTURED`
     * and a project — which is the whole of `unjudged()`'s predicate.
     */
    const orphan = await createCandidate({
      projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: 'What published rule requires a person for work of this kind?',
      statement: 'A labor question, with no round pointing at it.',
    });

    expect(orphan.priority).toBeNull();
    expect(orphan.state).toBe('CAPTURED');
    expect(orphan.projectId).toBe(projectId);
  });

  it('is not excluded by anything on the judging path, which is why the window had to close', () => {
    /*
     * An absence, so it is read from the source. Behaviour cannot see a missing
     * clause — a test that launched an orphan would prove the defect by
     * committing it, and the remedy is that no orphan can exist to launch.
     *
     * Narrow deliberately: this asserts only that the selection Russell judges
     * from does not consult `labor_rounds`. If somebody ever adds such a clause
     * this fails, and that is the right moment to read this file again, because
     * the argument above would have changed.
     */
    const loop = readFileSync('server/services/russell/loop.ts', 'utf8');
    const unjudged = loop.slice(loop.indexOf('async function unjudged('));
    // To the closing brace at column nought, so the slice is the whole function
    // rather than whichever brace came first inside its return type.
    const query = unjudged.slice(0, unjudged.indexOf('\n}'));
    expect(query).toContain('russell_candidates');
    expect(query).not.toContain('labor_round');

    /*
     * And the pairing is what closes it: both writes go through one
     * transaction, so there is no instant at which the first exists without the
     * second.
     */
    const expand = readFileSync('server/services/labor/expand.ts', 'utf8');
    expect(expand).toContain('getDb().transaction(');
  });
});
