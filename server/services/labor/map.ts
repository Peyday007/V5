/**
 * The labor map as Brain can currently read it, and how far it has got with
 * each task.
 *
 * ---------------------------------------------------------------------------
 * Everything interesting is derived, and that is the whole design
 * ---------------------------------------------------------------------------
 *
 * There is no automation percentage, no compression score and no current-layer
 * column on `labor_tasks`. Every one of them is a fact about rows that change
 * underneath it: a capability is connected, a necessity question is answered,
 * an allocation is superseded — and a stored reading is wrong from that instant
 * until something remembers to recompute it. `graph.ts` makes the same argument
 * about a subject's coverage and `tier.ts` made it first about an opportunity.
 *
 * What the schema *does* store is what no derivation could recover: the
 * decisions. Who produces a task, why, and what was believed at the time.
 *
 * ---------------------------------------------------------------------------
 * A snapshot, read once
 * ---------------------------------------------------------------------------
 *
 * `allocate.ts` is a pure function and this is what it is pure over, kept apart
 * for `services/dispatch/router.ts`' reason: *why did Brain research that* has
 * to be answerable from a recorded input rather than from a re-run against a
 * database that has moved on.
 *
 * The fleet reading is taken **once** for the whole project rather than once
 * per task. That is not only a query count: two tasks assessed against two
 * different readings of one fleet would disagree about the same fact inside
 * one snapshot, which is the two-readers defect this repository keeps
 * correcting.
 */
import {
  listAllocations,
  listLaborRounds,
  listMarketOptions,
  listNecessityAnswers,
  listTasks,
  listWorkflows,
} from '../../repos/labor.ts';
import { assessTask, independentVerificationAvailable, type NecessityReading } from './necessity.ts';
import type {
  LaborAllocation,
  LaborMarketOption,
  LaborNecessityAnswer,
  LaborRound,
  LaborRoundPurpose,
  LaborTask,
  LaborWorkflow,
} from '../../domain/types.ts';

export interface TaskCoverage {
  task: LaborTask;
  workflow: LaborWorkflow;
  /** What this task is called, with its workflow in front of it. */
  path: string;
  /** The live allocation, or null where nobody has decided. */
  allocation: LaborAllocation | null;
  /** Every allocation this task has ever had, oldest first. */
  history: LaborAllocation[];
  necessity: NecessityReading;
  options: LaborMarketOption[];
  rounds: LaborRound[];
  purposesAsked: ReadonlySet<LaborRoundPurpose>;
  purposesOpen: ReadonlySet<LaborRoundPurpose>;
  /** How many settled rounds of each purpose, so the next one can be numbered. */
  roundsByPurpose: Readonly<Record<LaborRoundPurpose, number>>;
  /**
   * How many of those actually ran to a conclusion.
   *
   * Kept apart from `roundsByPurpose` because the two answer different
   * questions and only one of them is evidence. A round settles on *any*
   * terminal mission (`expand.ts` says why), so `roundsByPurpose` counts a
   * mission that crashed exactly as it counts one that read the sources and
   * found nothing — which is right for *numbering* the next round, and is a lie
   * as a measure of how hard Brain has looked. §41's own sentence: "it ran and
   * found nothing" and "it never finished" have different remedies.
   */
  harvestedByPurpose: Readonly<Record<LaborRoundPurpose, number>>;
  foundByPurpose: Readonly<Record<LaborRoundPurpose, number>>;
  lastAskedAt: string | null;
  lastSettledAt: string | null;
}

export interface LaborSnapshot {
  projectId: string;
  at: string;
  workflows: LaborWorkflow[];
  tasks: LaborTask[];
  allocations: LaborAllocation[];
  answers: LaborNecessityAnswer[];
  options: LaborMarketOption[];
  rounds: LaborRound[];
  coverage: TaskCoverage[];
  /** The fleet reading behind question 7, taken once. Null is *could not tell*. */
  independentVerification: boolean | null;
}

const EMPTY_COUNTS: Readonly<Record<LaborRoundPurpose, number>> = Object.freeze({
  NECESSITY: 0,
  MARKET: 0,
  PRECEDENT: 0,
});

export async function laborSnapshot(projectId: string, now?: string): Promise<LaborSnapshot> {
  const [workflows, tasks, allocations, answers, options, rounds, independentVerification] =
    await Promise.all([
      listWorkflows(projectId),
      listTasks(projectId),
      listAllocations(projectId),
      listNecessityAnswers(projectId),
      listMarketOptions(projectId),
      listLaborRounds(projectId),
      independentVerificationAvailable(),
    ]);

  const byWorkflow = new Map(workflows.map((one) => [one.id, one]));
  const liveWorkflows = new Set(
    workflows.filter((one) => one.retiredAt === null).map((one) => one.id),
  );

  /*
   * A retired workflow's tasks are out of the reading, and so are retired
   * tasks.
   *
   * Not deleted: `listTasks` still returns them and the snapshot still carries
   * them, so anything asking *what was decided here* gets an answer. What a
   * coverage reading is for is what Brain would work on now.
   */
  const live = tasks.filter((one) => one.retiredAt === null && liveWorkflows.has(one.workflowId));

  const allocationsByTask = new Map<string, LaborAllocation[]>();
  for (const one of allocations) {
    allocationsByTask.set(one.taskId, [...(allocationsByTask.get(one.taskId) ?? []), one]);
  }
  const optionsByTask = new Map<string, LaborMarketOption[]>();
  for (const one of options) {
    optionsByTask.set(one.taskId, [...(optionsByTask.get(one.taskId) ?? []), one]);
  }
  const roundsByTask = new Map<string, LaborRound[]>();
  for (const one of rounds) {
    roundsByTask.set(one.taskId, [...(roundsByTask.get(one.taskId) ?? []), one]);
  }

  const coverage: TaskCoverage[] = [];
  for (const task of live) {
    const workflow = byWorkflow.get(task.workflowId);
    if (!workflow) continue;

    const history = chainOf(allocationsByTask.get(task.id) ?? []);
    const mine = roundsByTask.get(task.id) ?? [];

    const roundsByPurpose: Record<LaborRoundPurpose, number> = { ...EMPTY_COUNTS };
    const harvestedByPurpose: Record<LaborRoundPurpose, number> = { ...EMPTY_COUNTS };
    const foundByPurpose: Record<LaborRoundPurpose, number> = { ...EMPTY_COUNTS };
    const asked = new Set<LaborRoundPurpose>();
    const open = new Set<LaborRoundPurpose>();
    for (const round of mine) {
      asked.add(round.purpose);
      if (round.state === 'OPEN') open.add(round.purpose);
      else {
        roundsByPurpose[round.purpose] += 1;
        if (round.state === 'HARVESTED') harvestedByPurpose[round.purpose] += 1;
      }
      // A round that has not settled contributes nothing — not zero, nothing.
      foundByPurpose[round.purpose] += round.found ?? 0;
    }

    coverage.push({
      task,
      workflow,
      path: `${workflow.name} → ${task.name}`,
      allocation: history.find((one) => one.supersededAt === null) ?? null,
      history,
      necessity: await assessTask({ task, answers, independentVerification }),
      options: optionsByTask.get(task.id) ?? [],
      rounds: mine,
      purposesAsked: asked,
      purposesOpen: open,
      roundsByPurpose,
      harvestedByPurpose,
      foundByPurpose,
      lastAskedAt: latest(mine.map((one) => one.openedAt)),
      lastSettledAt: latest(
        mine.filter((one) => one.harvestedAt !== null).map((one) => one.harvestedAt as string),
      ),
    });
  }

  return {
    projectId,
    at: now ?? new Date().toISOString(),
    workflows,
    tasks,
    allocations,
    answers,
    options,
    rounds,
    coverage,
    independentVerification,
  };
}

/**
 * One task's allocations in the order they were actually decided.
 *
 * Followed along `supersedes_id` rather than sorted by `created_at`, and the
 * first version of this sorted. §33 records the same defect one module along:
 * these timestamps are ISO-8601 to the millisecond, two decisions made in one
 * millisecond compare equal, and the tie then fell through to a *generated
 * id* — deterministic, meaningless, and wrong half the time. `roleCompression`
 * reads this order to decide whether a role was compressed or escalated, so
 * getting it backwards reports that a person was replaced by Brain when the
 * opposite happened. It passed by luck until a test made two decisions fast
 * enough to collide.
 *
 * The chain is exact because the schema makes it exact: `supersedes_id` is
 * UNIQUE where present, so every allocation has at most one successor.
 *
 * Roots are walked oldest first for the one shape that can produce two — a
 * caller that superseded the live row and then inserted with no
 * `expectedCurrentId`, which leaves a second chain rather than a fork. Any row
 * a cycle or a broken link would strand is appended rather than dropped: a
 * history that silently lost an entry would be worse than one out of order.
 */
export function chainOf(allocations: readonly LaborAllocation[]): LaborAllocation[] {
  const bySupersedes = new Map<string, LaborAllocation>();
  for (const one of allocations) {
    if (one.supersedesId) bySupersedes.set(one.supersedesId, one);
  }
  const roots = allocations
    .filter((one) => one.supersedesId === null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const out: LaborAllocation[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let current: LaborAllocation | undefined = root;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      out.push(current);
      current = bySupersedes.get(current.id);
    }
  }
  for (const one of allocations) {
    if (!seen.has(one.id)) out.push(one);
  }
  return out;
}

function latest(values: readonly string[]): string | null {
  let out: string | null = null;
  for (const value of values) {
    if (out === null || value > out) out = value;
  }
  return out;
}
