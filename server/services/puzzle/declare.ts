/**
 * The decisions a person makes, and the ones Brain may never make for them.
 *
 * ---------------------------------------------------------------------------
 * `SEED` is the origin Brain cannot write
 * ---------------------------------------------------------------------------
 *
 * A machine that could name its own puzzle formats would be deciding what the
 * universe is, and everything else this kernel reads hangs off that table. So
 * a format arrives either from a gated claim — `expand.ts`, `DISCOVERED` — or
 * from a person here, and the schema's CHECK makes that structural rather than
 * a convention. §22's split at the table every other reading depends on.
 *
 * The same rule at the ledger: Brain may *discover* a route from evidence, and
 * only a person may say a route is watch-listed, blocked, archived or
 * rejected. The directive is explicit that the slow and the long-term paths
 * stay, and a machine that could archive them would be deleting the ledger one
 * row at a time.
 *
 * ---------------------------------------------------------------------------
 * Four decisions here have real consequences and none of them is automatic
 * ---------------------------------------------------------------------------
 *
 * Reviewing a master, compiling an output, releasing one, and recording that a
 * person actually playtested something. The directive requires the first of
 * every new generator or template; the fourth is the one form of evidence no
 * validator can produce, because *ambiguity, readability, enjoyment and
 * cultural fit* are not properties a program can check.
 *
 * Nothing in this module publishes, sells, prices, contacts anybody or spends
 * anything. Releasing an output records that a person decided it is ready; it
 * is pursued through the `cash_opportunities` machinery that already exists,
 * behind the standing commercial authority a person granted separately.
 */
import {
  addOutputMember,
  createFormat,
  createMaster,
  createOutput,
  createRoute,
  getMaster,
  getOutput,
  listOutputMembers,
  recordMasterReview,
  recordObservation,
  releaseOutput as releaseOutputRow,
  retireFormat,
  retireMaster,
  retireOutput,
  setRouteDisposition,
} from '../../repos/puzzle.ts';
import { engineById, enginesForFormat } from './engines/index.ts';
import { currentValidation } from '../../repos/puzzle.ts';
import { isEvidence, puzzleSnapshot } from './graph.ts';
import { readOutput } from './maturity.ts';
import { outputsOf } from './graph.ts';
import type {
  DifferentiatorAxis,
  ProductionClass,
  PuzzleFormat,
  PuzzleMaster,
  PuzzleObservationKind,
  PuzzleOutput,
  PuzzleRoute,
  RouteClass,
  RouteDisposition,
} from '../../domain/types.ts';

export type Refusal = { ok: false; reason: string };
export type Done<T> = { ok: true; value: T };
export type Result<T> = Done<T> | Refusal;

/* --------------------------------------------------------------------------
 * The universe
 * ------------------------------------------------------------------------ */

export async function declareFormat(input: {
  projectId: string;
  name: string;
  audience?: string | null;
  note?: string | null;
}): Promise<Result<PuzzleFormat>> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'A format must have a name.' };
  const { format } = await createFormat({
    projectId: input.projectId,
    name,
    audience: input.audience ?? null,
    note: input.note ?? null,
    origin: 'SEED',
  });
  return { ok: true, value: format };
}

export async function retireFormatByPerson(input: {
  id: string;
  reason: string;
}): Promise<Result<PuzzleFormat>> {
  const reason = input.reason.trim();
  if (!reason) {
    return {
      ok: false,
      reason:
        'Retiring a format must say why. Without a reason the same format arrives again on the ' +
        'next round as a fresh discovery, and the allowance is spent learning what somebody ' +
        'already decided.',
    };
  }
  const format = await retireFormat({ id: input.id, reason });
  if (!format) return { ok: false, reason: 'No such format.' };
  return { ok: true, value: format };
}

/* --------------------------------------------------------------------------
 * The ledger
 * ------------------------------------------------------------------------ */

export async function declareRoute(input: {
  projectId: string;
  name: string;
  routeClass: RouteClass;
  note?: string | null;
}): Promise<Result<PuzzleRoute>> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'A route must have a name.' };
  const { route } = await createRoute({
    projectId: input.projectId,
    name,
    routeClass: input.routeClass,
    note: input.note ?? null,
    origin: 'SEED',
  });
  return { ok: true, value: route };
}

export async function decideRoute(input: {
  id: string;
  disposition: RouteDisposition;
  reason: string;
  byId: string;
}): Promise<Result<PuzzleRoute>> {
  if (input.disposition !== 'ACTIVE' && !input.reason.trim()) {
    return {
      ok: false,
      reason:
        'A disposition that is not ACTIVE must say why. A ledger entry that went quiet with no ' +
        'reason on it answers nothing later, and this ledger is never pruned — so the reason ' +
        'is the only thing that distinguishes a considered decision from a forgotten row.',
    };
  }
  const route = await setRouteDisposition(input);
  if (!route) return { ok: false, reason: 'No such route.' };
  return { ok: true, value: route };
}

/* --------------------------------------------------------------------------
 * Masters
 * ------------------------------------------------------------------------ */

export async function declareMaster(input: {
  projectId: string;
  formatKey: string;
  name: string;
  engineId: string;
  params: Record<string, unknown>;
  corpusRef?: string | null;
  rightsBasis: string;
}): Promise<Result<PuzzleMaster>> {
  const engine = engineById(input.engineId);
  if (!engine) {
    const available = enginesForFormat(input.formatKey);
    return {
      ok: false,
      reason:
        `No engine with id "${input.engineId}" is registered. ` +
        (available.length > 0
          ? `For this format there ${available.length === 1 ? 'is' : 'are'}: ` +
            `${available.map((one) => one.id).join(', ')}.`
          : 'Nothing here generates that format, so it is RESEARCHED rather than GENERATABLE ' +
            'and no master can produce from it.'),
    };
  }
  if (!input.rightsBasis.trim()) {
    return {
      ok: false,
      reason:
        'A master must state the basis on which its source material may be sold. The directive ' +
        'is explicit that scraped or lightly-rewritten material is the one thing this business ' +
        'may not be built on, and a generator whose corpus nobody has accounted for is exactly ' +
        'that with a layer of indirection.',
    };
  }
  const { master } = await createMaster({
    projectId: input.projectId,
    formatKey: input.formatKey,
    name: input.name,
    engineId: engine.id,
    engineVersion: engine.version,
    params: input.params,
    corpusRef: input.corpusRef ?? null,
    rightsBasis: input.rightsBasis,
  });
  return { ok: true, value: master };
}

/**
 * A person's editorial review.
 *
 * Single-shot by the guard in the repository, so a second review does not
 * quietly overwrite the first reviewer's name. Nothing automatic can reach it,
 * and `maturity.ts` refuses GENERATABLE without it: the directive requires a
 * person to review every new generator or template before it produces, and a
 * review Brain could record itself would not be one.
 */
export async function reviewMaster(input: {
  id: string;
  reviewedById: string;
  note: string;
}): Promise<Result<PuzzleMaster>> {
  const note = input.note.trim();
  if (!note) {
    return {
      ok: false,
      reason:
        'An editorial review must say what was reviewed and what was found. A review with no ' +
        'note is a timestamp claiming somebody looked.',
    };
  }
  const existing = await getMaster(input.id);
  if (!existing) return { ok: false, reason: 'No such master.' };
  if (existing.reviewedAt) {
    return {
      ok: false,
      reason:
        'That master has already been reviewed, and a second review would overwrite the first ' +
        "reviewer's name. Retire it and make a new one if the generator has changed.",
    };
  }
  const master = await recordMasterReview({
    id: input.id,
    reviewedById: input.reviewedById,
    note,
  });
  if (!master) return { ok: false, reason: 'No such master.' };
  return { ok: true, value: master };
}

export async function retireMasterByPerson(input: {
  id: string;
  reason: string;
}): Promise<Result<PuzzleMaster>> {
  if (!input.reason.trim()) return { ok: false, reason: 'Retiring a master must say why.' };
  const master = await retireMaster({ id: input.id, reason: input.reason.trim() });
  if (!master) return { ok: false, reason: 'No such master.' };
  return { ok: true, value: master };
}

/* --------------------------------------------------------------------------
 * Outputs
 * ------------------------------------------------------------------------ */

/**
 * Compile an output from validated instances.
 *
 * Every member must have a **current PASSED validation** at the moment it is
 * added. An instance whose validation failed, or whose validator could not
 * answer, or which nothing has validated at all, is something this kernel does
 * not have — §9's rule, and the whole reason this compilation refuses rather
 * than filtering: quietly dropping the ones that fail would produce a shorter
 * book than the person asked for, with nothing saying so.
 */
export async function compileOutput(input: {
  projectId: string;
  masterId: string;
  title: string;
  productionClass: ProductionClass;
  differentiators: DifferentiatorAxis[];
  instanceIds: readonly string[];
  targetBuyer?: string | null;
  routeId?: string | null;
}): Promise<Result<{ output: PuzzleOutput; members: number }>> {
  const master = await getMaster(input.masterId);
  if (!master) return { ok: false, reason: 'No such master.' };
  if (!master.reviewedAt) {
    return {
      ok: false,
      reason:
        'That master has not been editorially reviewed, so nothing compiled from it is fit to ' +
        'sell. The directive requires a person to review every new generator or template.',
    };
  }
  if (input.instanceIds.length === 0) {
    return { ok: false, reason: 'An output has to contain something.' };
  }

  const unvalidated: string[] = [];
  for (const instanceId of input.instanceIds) {
    const run = await currentValidation(instanceId);
    if (run?.verdict !== 'PASSED') {
      unvalidated.push(
        `${instanceId} (${run ? run.verdict.toLowerCase() : 'never validated'})`,
      );
    }
  }
  if (unvalidated.length > 0) {
    return {
      ok: false,
      reason:
        `${unvalidated.length} of the ${input.instanceIds.length} puzzles given do not have a ` +
        `passing validation: ${unvalidated.slice(0, 5).join(', ')}` +
        `${unvalidated.length > 5 ? ', …' : ''}. They are refused rather than skipped, ` +
        'because a shorter book than the one somebody asked for, with nothing saying so, is ' +
        'the failure this refusal exists to prevent.',
    };
  }

  const { output } = await createOutput({
    projectId: input.projectId,
    masterId: input.masterId,
    title: input.title,
    productionClass: input.productionClass,
    differentiators: input.differentiators,
    targetBuyer: input.targetBuyer ?? null,
    routeId: input.routeId ?? null,
  });

  let position = (await listOutputMembers(output.id)).length;
  for (const instanceId of input.instanceIds) {
    position += 1;
    await addOutputMember({ outputId: output.id, instanceId, position });
  }
  const members = (await listOutputMembers(output.id)).length;
  return { ok: true, value: { output, members } };
}

/**
 * A person's release decision.
 *
 * It refuses an output the reading does not call sellable, and the refusal
 * carries the reading's own sentence. That is not a second gate: it is the
 * same gate, said out loud at the moment somebody would otherwise be
 * surprised by it — §35's rule that a control which cannot succeed should not
 * be offered, and when it is reached anyway the refusal must name the remedy.
 */
export async function releaseOutput(input: {
  id: string;
  byId: string;
}): Promise<Result<PuzzleOutput>> {
  const existing = await getOutput(input.id);
  if (!existing) return { ok: false, reason: 'No such output.' };
  if (existing.releasedAt) {
    return { ok: false, reason: 'That output has already been released.' };
  }

  const snapshot = await puzzleSnapshot(existing.projectId);
  const reading = readOutput(snapshot, existing, outputsOf(snapshot, existing.masterId));
  if (reading.qualification !== 'SELLABLE' && reading.qualification !== 'REVENUE_PROVEN') {
    return {
      ok: false,
      reason:
        `That output reads ${reading.qualification}: ${reading.why}` +
        (reading.nextQuestion ? ` ${reading.nextQuestion}` : ''),
    };
  }

  const released = await releaseOutputRow(input);
  if (!released) return { ok: false, reason: 'No such output.' };
  return { ok: true, value: released };
}

export async function retireOutputByPerson(input: {
  id: string;
  reason: string;
}): Promise<Result<PuzzleOutput>> {
  if (!input.reason.trim()) return { ok: false, reason: 'Retiring an output must say why.' };
  const output = await retireOutput({ id: input.id, reason: input.reason.trim() });
  if (!output) return { ok: false, reason: 'No such output.' };
  return { ok: true, value: output };
}

/* --------------------------------------------------------------------------
 * What a person observed
 * ------------------------------------------------------------------------ */

/**
 * A person's observation, including the one no validator can produce.
 *
 * The directive asks for a stratified sample of algorithmic output to be
 * human-playtested for *ambiguity, readability, enjoyment, cultural fit and
 * actual difficulty*. Not one of those is a property a program can check, so
 * `PLAYTEST_RESULT` has no automatic writer and `leverage.ts` reports the
 * count plainly rather than implying the sample was taken.
 */
export async function recordPersonObservation(input: {
  projectId: string;
  kind: PuzzleObservationKind;
  subjectKey?: string | null;
  statement: string;
  observerId: string;
  masterId?: string | null;
  outputId?: string | null;
}): Promise<Result<{ id: string }>> {
  const statement = input.statement.trim();
  if (!statement) {
    return { ok: false, reason: 'An observation has to say what was observed.' };
  }
  const observation = await recordObservation({
    projectId: input.projectId,
    kind: input.kind,
    subjectKey: input.subjectKey ?? null,
    statement,
    observer: 'PERSON',
    observerId: input.observerId,
    masterId: input.masterId ?? null,
    outputId: input.outputId ?? null,
  });
  return { ok: true, value: { id: observation.id } };
}

/** Instances of one master that are actually usable, for a person choosing what to compile. */
export async function usableInstances(input: {
  projectId: string;
  masterId: string;
}): Promise<{ instanceId: string; difficulty: string | null }[]> {
  const snapshot = await puzzleSnapshot(input.projectId);
  return snapshot.instances
    .filter((one) => one.masterId === input.masterId && isEvidence(snapshot, one.id))
    .map((one) => ({ instanceId: one.id, difficulty: one.difficulty }));
}
