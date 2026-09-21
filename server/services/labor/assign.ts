/**
 * Recording who produces a task, and the two things Brain may decide alone.
 *
 * ---------------------------------------------------------------------------
 * The asymmetry is the whole module
 * ---------------------------------------------------------------------------
 *
 * A person may record any allocation, including one Brain would refuse to make
 * for itself, because a person is entitled to say *we are doing it this way
 * for now* and have that be true. Brain may record exactly two, and both are
 * safe in the same direction:
 *
 *   BRAIN, when the necessity test comes back `BRAIN_DEFENSIBLE` — every
 *   question that could stop it answered in the direction that permits it,
 *   from a recorded answer rather than from an absence.
 *
 *   a human layer, when the test comes back `HUMAN_REQUIRED` — a published
 *   source established one of the three reasons a source can establish, so
 *   there is a reason to name and the CHECK is satisfiable honestly.
 *
 * On `NOT_ESTABLISHED` Brain writes nothing at all. That is most tasks on the
 * day the kernel first sees them, and it is the honest state: neither case is
 * made, so nobody should read a row saying one of them is.
 *
 * ---------------------------------------------------------------------------
 * The default is not an assumption, here least of all
 * ---------------------------------------------------------------------------
 *
 * The brief says Brain is the default production layer. Writing `BRAIN` on an
 * unassessed task would be reading that as a licence to assume, and the cost
 * of being wrong is not symmetrical: a task wrongly given to a person costs
 * money, and a task wrongly taken from one is an output nobody produces, or
 * one produced without the licence, signature or presence somebody is legally
 * owed. So the burden sits where the brief actually puts it — on justifying
 * the human — and an unanswered question justifies neither.
 */
import { liveAllocationFor, recordAllocation } from '../../repos/labor.ts';
import { recordEvent } from '../../repos/events.ts';
import { layerIsHuman } from '../../domain/labor.ts';
import type { NecessityReading } from './necessity.ts';
import type {
  HumanNecessityReason,
  LaborAllocation,
  LaborTask,
  ProductionLayer,
} from '../../domain/types.ts';

const DECIDED = 'LABOR_ALLOCATION_DECIDED';

export type AssignOutcome =
  | { ok: true; allocation: LaborAllocation; changed: boolean }
  | { ok: false; reason: string };

/**
 * A person's decision, which is not second-guessed.
 *
 * The one thing refused is a human layer with no reason, and that is the
 * schema's CHECK rather than a policy: the six classes exist so that every
 * human role can say which one it is, and a role that cannot is the habit this
 * kernel exists to stop inheriting. The refusal names the six.
 */
export async function assignByPerson(input: {
  projectId: string;
  task: LaborTask;
  productionLayer: ProductionLayer;
  necessityReason: HumanNecessityReason | null;
  rationale: string;
  actorRef: string;
}): Promise<AssignOutcome> {
  const human = layerIsHuman(input.productionLayer);
  if (human && !input.necessityReason) {
    return {
      ok: false,
      reason:
        'A person producing this has to say which of the six reasons makes that necessary: ' +
        'the interaction itself creating value, judgement beyond what Brain can verify, a ' +
        'licence or signature somebody must hold, physical presence, handling only what ' +
        'exceeds Brain’s thresholds, or independent oversight. There is deliberately no ' +
        'reason meaning "this is how it has always been done".',
    };
  }
  if (!human && input.necessityReason) {
    return {
      ok: false,
      reason: `${input.productionLayer} is not a person, so it carries no necessity reason.`,
    };
  }
  return write({
    projectId: input.projectId,
    task: input.task,
    productionLayer: input.productionLayer,
    necessityReason: human ? input.necessityReason : null,
    decidedBy: 'PERSON',
    decidedByRef: input.actorRef,
    rationale: input.rationale,
  });
}

/**
 * What Brain may decide for itself, from a reading it did not choose.
 *
 * `reading` is passed rather than recomputed, so the rationale recorded on the
 * row and the verdict that permitted it are the same reading rather than two
 * taken moments apart. `services/dispatch/router.ts` draws the same line for
 * the same reason.
 */
export async function assignByBrain(input: {
  projectId: string;
  task: LaborTask;
  reading: NecessityReading;
}): Promise<AssignOutcome> {
  const { reading } = input;

  if (reading.verdict === 'NOT_ESTABLISHED') {
    return {
      ok: false,
      reason:
        'Neither case is established, so there is nothing honest to record. ' +
        (reading.blockers[0]?.statement ?? 'Nothing has been asked.'),
    };
  }

  if (reading.verdict === 'HUMAN_REQUIRED') {
    if (!reading.reason) {
      // Unreachable by construction — `HUMAN_REQUIRED` is produced only by a
      // reason being established — and refused rather than defaulted, because
      // a default here would write a habit into the column the six classes
      // exist to keep habits out of.
      return { ok: false, reason: 'A human role was established with no reason named.' };
    }
    /*
     * Which *kind* of person is not Brain's to decide, and this is where that
     * shows. The reason decides the narrowest layer that can honour it: a
     * licence means a specialist professional, physical presence means an
     * operator. Everything else is `DOMESTIC_HUMAN` as a placeholder a person
     * corrects — and §4's whole point is that the placeholder is usually
     * wrong, which is why the MARKET round is the very next thing the
     * allocator asks for.
     */
    const layer = layerForReason(reading.reason);
    return write({
      projectId: input.projectId,
      task: input.task,
      productionLayer: layer,
      necessityReason: reading.reason,
      decidedBy: 'BRAIN',
      decidedByRef: null,
      rationale: reading.summary,
    });
  }

  return write({
    projectId: input.projectId,
    task: input.task,
    productionLayer: 'BRAIN',
    necessityReason: null,
    decidedBy: 'BRAIN',
    decidedByRef: null,
    rationale: reading.summary,
  });
}

/**
 * The narrowest layer that can honour a reason.
 *
 * A `Record` over the whole union, so a reason added later is a compile error
 * until somebody says what kind of person it implies. Three of its six entries
 * are unreachable from here today and are present for that totality rather
 * than as dead code: `assignByBrain` only ever sees `HUMAN_REQUIRED`, and only
 * the three reasons a published source can establish produce it. A person
 * recording one of the other three names their own layer.
 */
const LAYER_FOR: Readonly<Record<HumanNecessityReason, ProductionLayer>> = Object.freeze({
  ACCOUNTABILITY_LICENSING: 'SPECIALIST_PROFESSIONAL',
  PHYSICAL_EXECUTION: 'PHYSICAL_OPERATOR',
  EXPERT_JUDGMENT: 'SPECIALIST_PROFESSIONAL',
  HUMAN_INTERFACE: 'DOMESTIC_HUMAN',
  EXCEPTION_HANDLING: 'DOMESTIC_HUMAN',
  OVERSIGHT_VERIFICATION: 'DOMESTIC_HUMAN',
});

function layerForReason(reason: HumanNecessityReason): ProductionLayer {
  return LAYER_FOR[reason];
}

/**
 * Write it, unless it says exactly what the live row already says.
 *
 * A no-op supersede would put a second row on the history saying nothing
 * changed, and §7's role-compression reading walks that history: an allocation
 * chain full of identical entries is one nobody can read a change out of. So
 * an unchanged decision returns the row that is already there, with `changed`
 * false.
 */
async function write(input: {
  projectId: string;
  task: LaborTask;
  productionLayer: ProductionLayer;
  necessityReason: HumanNecessityReason | null;
  decidedBy: 'BRAIN' | 'PERSON';
  decidedByRef: string | null;
  rationale: string;
}): Promise<AssignOutcome> {
  const current = await liveAllocationFor(input.task.id);
  if (
    current &&
    current.productionLayer === input.productionLayer &&
    current.necessityReason === input.necessityReason
  ) {
    return { ok: true, allocation: current, changed: false };
  }

  const allocation = await recordAllocation({
    projectId: input.projectId,
    taskId: input.task.id,
    productionLayer: input.productionLayer,
    necessityReason: input.necessityReason,
    decidedBy: input.decidedBy,
    decidedByRef: input.decidedByRef,
    rationale: input.rationale,
    expectedCurrentId: current?.id ?? null,
  });
  if (!allocation) {
    /*
     * Somebody else decided this between the read and the write.
     *
     * An ordinary outcome rather than an error — the compare-and-swap did its
     * job. A caller that retried blindly would be overwriting a decision it
     * has not seen, so the refusal says so and the decision stands.
     */
    return {
      ok: false,
      reason: 'This task was allocated by somebody else while this decision was being made.',
    };
  }

  await recordEvent({
    projectId: input.projectId,
    entityType: 'labor_task',
    entityId: input.task.id,
    eventType: DECIDED,
    payload: {
      allocationId: allocation.id,
      decidedBy: input.decidedBy,
      decidedByRef: input.decidedByRef,
      // Both ends, because §7's compression reading is about the move rather
      // than about the destination — and an event naming only the new value
      // would say a role had changed without saying what it changed from.
      from: current ? { layer: current.productionLayer, reason: current.necessityReason } : null,
      to: { layer: input.productionLayer, reason: input.necessityReason },
      rationale: input.rationale,
    },
  });

  return { ok: true, allocation, changed: true };
}
