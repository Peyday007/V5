/**
 * What an operator may type when they mean a worker.
 *
 * `workers list` prints two identifiers on every row — the neutral label
 * migration 074 assigns (`worker-05`) and the id every other operator surface
 * uses (`wkr_…`) — and `admin.ts`'s resolver accepted neither. It called
 * `getWorkerByName`, which matches only `workers.name`: a lookup handle that
 * is printed nowhere, and that 074's own header describes as a thing which
 * "participates in nothing". So an operator read a row, copied the only two
 * strings on it, and was told **No such worker** by both — and the refusal
 * then listed candidates by `name` again, which is a third spelling the
 * listing never showed them.
 *
 * That is not a missing feature. A listing and the command that consumes it
 * disagreeing about what a thing is called is the same defect this repository
 * records at a column, a status line and a review card: two readers of one
 * fact, and the quieter one is the one nobody notices is wrong.
 *
 * So there is one resolver, and it is the only thing any operator surface
 * calls. Three properties decide its shape.
 *
 * **It widens a lookup and changes no identity.** `workers.name` is still
 * resolved, first and unchanged, so every command anybody has ever run
 * resolves to exactly the worker it always did. The id and the label are
 * additional ways to *reach* a row, never a new way to *be* one: nothing here
 * writes, renames, or decides authorization, and `services/identity/policy.ts`
 * is as untouched by this as it is by `workerIdentity`.
 *
 * **Disagreement is refused, never resolved.** `workers.label` and
 * `workers.id` each carry a unique index, so neither can name two rows — but
 * nothing stops somebody naming a worker `worker-05` while a *different* row
 * carries that label, and then one string means two workers. Picking either
 * would be the Westbrook defect at an operator surface: a confident answer to
 * the wrong question, with every row healthy. `§27`'s `softwareTarget.ts`
 * settled the identical question the identical way, and so does this.
 *
 * **Not knowing is an answer.** A reference that matches nothing comes back
 * as nothing, and the caller reports it with the identifiers the listing
 * actually prints rather than with a spelling of its own.
 */
import type { Worker } from '../../domain/types.ts';
import { getWorker, getWorkerByLabel, getWorkerByName } from '../../repos/identity.ts';

export type WorkerRefResult =
  | { kind: 'FOUND'; worker: Worker }
  | { kind: 'NONE' }
  /** One string, two rows. Named rather than chosen between. */
  | { kind: 'AMBIGUOUS'; matches: Worker[] };

/**
 * Every worker the given reference could mean.
 *
 * Name first, because that is the lookup that already existed and an existing
 * invocation must keep resolving to the row it always resolved to. The other
 * two only ever add a match that previously failed outright.
 */
export async function resolveWorkerRef(ref: string): Promise<WorkerRefResult> {
  const trimmed = ref.trim();
  if (!trimmed) return { kind: 'NONE' };

  const candidates = [
    await getWorkerByName(trimmed),
    await getWorker(trimmed),
    await getWorkerByLabel(trimmed),
  ];

  const byId = new Map<string, Worker>();
  for (const candidate of candidates) {
    if (candidate) byId.set(candidate.id, candidate);
  }

  const matches = [...byId.values()];
  const only = matches[0];
  if (!only) return { kind: 'NONE' };
  return matches.length === 1 ? { kind: 'FOUND', worker: only } : { kind: 'AMBIGUOUS', matches };
}
