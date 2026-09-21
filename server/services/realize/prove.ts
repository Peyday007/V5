/**
 * What makes a capability exist, as opposed to having been built.
 *
 * ---------------------------------------------------------------------------
 * The sentence this module is the implementation of
 * ---------------------------------------------------------------------------
 *
 * *Installing a tool is not automatically acquiring a capability.* Amendment 001
 * adds the half that matters here: **building software is not automatically
 * acquiring one either.** A merged pull request moves no dimension in the
 * registry. Something that can be evaluated has to say the capability exists.
 *
 * Without this module the registry can never leave `ABSENT` / `UNTESTED`, and
 * the obvious way to let it — move `implementation_state` when a campaign
 * merges — is exactly the lie the six dimensions exist to prevent. So every
 * move here is derived from a *different* source than the build:
 *
 *   PARTIAL / CONNECTED   the gaps' own integration state, from Factory rows
 *   LIVE                  the self-model having **observed** the components
 *   PASSING               a recorded evaluation, never a passing typecheck
 *   PRODUCTION_PROVEN     rows in a project that is somebody's work
 *
 * `availability_state` is absent from that list and from this module. Switching
 * a faculty on is a person's decision, and a realization that could switch on
 * what it built would be granting itself the one thing §27 reserves.
 *
 * ---------------------------------------------------------------------------
 * Why it refuses rather than waits
 * ---------------------------------------------------------------------------
 *
 * Each move states the evidence it needs and reports when that evidence is
 * absent, rather than moving to the nearest state it can justify. A dimension
 * that crept forward on partial evidence would be indistinguishable, a month
 * later, from one that earned it.
 */
import { getFaculty, moveDimension, type Faculty } from '../../repos/faculties.ts';
import { getDb } from '../../db/database.ts';
import { listComponents } from '../selfmodel/scan.ts';
import { getPacket, listGaps, type PacketGap, type RealizationPacket } from './packet.ts';
import { lowers } from './realized.ts';
import { BUILDABLE } from './compile.ts';
import type {
  EvaluationState,
  FacultyDimension,
  ImplementationState,
} from '../../domain/faculties.ts';

export interface ProposedMove {
  dimension: FacultyDimension;
  from: string;
  to: string;
  reason: string;
  evidenceRef: string | null;
}

export interface ProofReading {
  packetId: string;
  facultyId: string;
  /** What the evidence supports. Empty when nothing has changed. */
  moves: ProposedMove[];
  /** Why a dimension did **not** move, named rather than left silent. */
  withheld: Array<{ dimension: FacultyDimension; needs: string }>;
}

/* ------------------------------------------------------------------------- */
/* Implementation                                                             */
/* ------------------------------------------------------------------------- */

/**
 * How far the build has got, from the gaps rather than from the campaign.
 *
 * The campaign's own state says whether the Factory finished; the gaps say
 * whether what it finished is what this capability needed. Those come apart
 * exactly when a campaign succeeds at something narrower than the packet asked
 * for, which is the case a reader most wants to see and a campaign-state check
 * would hide.
 */
function implementationFrom(gaps: readonly PacketGap[]): {
  state: ImplementationState;
  detail: string;
} {
  const buildable = gaps.filter((gap) => BUILDABLE.includes(gap.kind));
  if (buildable.length === 0) {
    return {
      state: 'ABSENT',
      detail: 'no gap on this packet was ever classified as needing to be built',
    };
  }
  const closed = buildable.filter((gap) => gap.state === 'CLOSED');
  if (closed.length === 0) {
    return { state: 'ABSENT', detail: `0 of ${buildable.length} buildable gap(s) are closed` };
  }
  if (closed.length < buildable.length) {
    return {
      state: 'PARTIAL',
      detail: `${closed.length} of ${buildable.length} buildable gap(s) are closed`,
    };
  }
  return {
    state: 'CONNECTED',
    detail: `all ${buildable.length} buildable gap(s) are closed`,
  };
}

/**
 * `LIVE` is the self-model's answer and nothing else's.
 *
 * A capability is live when the components its gaps named read CONNECTED=YES
 * and OBSERVED_ACTIVE=YES — which means something in the running process
 * reaches them and rows show they have run. Neither is a fact a build produces,
 * and that is the whole reason this clause is separate from the one above.
 *
 * A gap whose component the self-model cannot speak for (`UNKNOWN`) holds the
 * faculty at `CONNECTED`. Unknown is not a reading, so it cannot be the
 * evidence for the strongest implementation state there is.
 */
async function isLive(gaps: readonly PacketGap[]): Promise<{ live: boolean; detail: string }> {
  const keys = gaps
    .filter((gap) => gap.componentKey !== null)
    .map((gap) => gap.componentKey as string);
  if (keys.length === 0) {
    return {
      live: false,
      detail: 'no gap on this packet names a component the self-model could observe',
    };
  }
  const components = await listComponents();
  const byKey = new Map(components.map((component) => [component.componentKey, component]));
  const unread: string[] = [];
  const inactive: string[] = [];
  for (const key of new Set(keys)) {
    const component = byKey.get(key);
    if (!component) {
      unread.push(`${key} (not in the reading)`);
      continue;
    }
    if (component.answers.CONNECTED !== 'YES' || component.answers.OBSERVED_ACTIVE !== 'YES') {
      if (component.answers.CONNECTED === 'UNKNOWN' || component.answers.OBSERVED_ACTIVE === 'UNKNOWN') {
        unread.push(`${key} (the self-model cannot say)`);
      } else {
        inactive.push(key);
      }
    }
  }
  if (unread.length > 0 || inactive.length > 0) {
    return {
      live: false,
      detail:
        `${inactive.length} component(s) are not both connected and active` +
        (unread.length > 0 ? `, and ${unread.length} could not be read: ${unread.slice(0, 3).join(', ')}` : ''),
    };
  }
  return { live: true, detail: `every component this packet named reads connected and active` };
}

/* ------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * What an evaluation is, here.
 *
 * Deliberately narrow, and deliberately not "the suite passed". A faculty's
 * evaluation requirements are its own — *a decision reached that could not
 * reliably be reached before* is the one Research Intelligence declares — and
 * a green test suite is evidence about the code rather than about the power.
 *
 * So `PASSING` requires every `evaluationRequirements` gap to be closed, which
 * is a claim somebody made about the requirement rather than about a run. There
 * is no path here that reads a test result, because reading one would let a
 * typecheck move a dimension that is supposed to mean the capability works.
 */
function evaluationFrom(
  faculty: Faculty,
  gaps: readonly PacketGap[],
): { state: EvaluationState; detail: string } {
  const declared = faculty.definition.evaluationRequirements ?? [];
  if (declared.length === 0) {
    return {
      state: 'UNTESTED',
      detail:
        'the definition declares no evaluation requirements, so there is no standard to pass. ' +
        'A faculty with no stated test cannot be evaluated, and calling that PASSING would be ' +
        'passing an exam nobody set.',
    };
  }
  const evaluation = gaps.filter((gap) => gap.aspect === 'evaluationRequirements');
  if (evaluation.length === 0) {
    return { state: 'UNTESTED', detail: 'no gap tracks this faculty’s evaluation requirements' };
  }
  const closed = evaluation.filter((gap) => gap.state === 'CLOSED');
  if (closed.length < evaluation.length) {
    return {
      state: 'UNTESTED',
      detail: `${closed.length} of ${evaluation.length} evaluation requirement(s) are closed`,
    };
  }
  return { state: 'PASSING', detail: `all ${evaluation.length} evaluation requirement(s) are closed` };
}

/**
 * `PRODUCTION_PROVEN` asks for rows in somebody's work.
 *
 * The machinery proving itself is real and is not evidence that a faculty does
 * its job for anybody — which is exactly the distinction `projects.purpose` was
 * added to make, and the same question `observeWorkTypes` asks one level down.
 */
async function isProductionProven(packet: RealizationPacket): Promise<{
  proven: boolean;
  detail: string;
}> {
  if (packet.campaignId === null) {
    return { proven: false, detail: 'this packet has run no campaign, so nothing was released' };
  }
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM bins b
       JOIN projects p ON p.id = b.project_id
      WHERE b.factory_campaign_id = ? AND b.state = 'COMPLETE' AND p.purpose = 'PROJECT'`,
    [packet.campaignId] as never[],
  );
  const n = Number(row?.n ?? 0);
  return n > 0
    ? { proven: true, detail: `${n} bin(s) of this campaign completed in a project that is work` }
    : {
        proven: false,
        detail:
          'no bin of this campaign completed outside a TECHNICAL scope, so the machinery ' +
          'proving itself is all there is',
      };
}

/* ------------------------------------------------------------------------- */

/**
 * Read what the evidence supports, and change nothing.
 *
 * Separate from applying it on purpose. A reading somebody can look at before
 * anything moves is what makes the difference between a registry that advanced
 * because the evidence said so and one that advanced because a tick ran.
 */
export async function readProof(packetId: string): Promise<ProofReading> {
  const packet = await getPacket(packetId);
  if (!packet) throw new Error(`No such packet: ${packetId}`);
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) throw new Error(`Packet ${packetId} names a faculty that does not exist.`);

  const gaps = await listGaps(packetId);
  const moves: ProposedMove[] = [];
  const withheld: ProofReading['withheld'] = [];

  const implementation = implementationFrom(gaps);
  let target: ImplementationState = implementation.state;
  let detail = implementation.detail;
  if (implementation.state === 'CONNECTED') {
    const live = await isLive(gaps);
    if (live.live) {
      target = 'LIVE';
      detail = live.detail;
    } else {
      withheld.push({ dimension: 'IMPLEMENTATION', needs: `LIVE needs: ${live.detail}` });
    }
  }
  /*
   * It may raise this dimension and it may never lower it, which is the rule
   * `realized.ts` already applies and this did not.
   *
   * The two read the same column and answer different questions.
   * `implementationFrom` counts **buildable** gaps closed — how much of what
   * this packet set out to build has been built. `realized.ts` counts every
   * requirement served, closed or waived — how much of the faculty exists.
   * Both are right about their own question, and for a long time whichever
   * ran last decided what the registry said.
   *
   * Production made it visible on the first packet that had both. Research
   * Intelligence has sixteen requirements, fifteen served by live code and one
   * late-found gap classified `MUST_BE_BUILT`. `realized` read `PARTIAL` —
   * *15 of 16 served* — and the durable tick applied it. `prove` read `ABSENT`
   * — *0 of 1 buildable gap closed* — and `--apply` would have put a faculty
   * §40 actually built back to having no implementation at all.
   *
   * Lowering is the half that is wrong, and it is wrong the same way in every
   * case: this reading is built from a **narrower** set of gaps, so a state it
   * cannot see is not a state it may contradict. A new build gap opening does
   * not unbuild what is already there. So the ladder is the shared one, the
   * withholding is reported rather than silent, and raising is untouched —
   * `CONNECTED` and `LIVE` still move on this module's own evidence.
   */
  if (target !== faculty.implementationState) {
    if (lowers('IMPLEMENTATION', faculty.implementationState, target)) {
      withheld.push({
        dimension: 'IMPLEMENTATION',
        needs:
          `this reading is ${target} and the faculty is recorded as ` +
          `${faculty.implementationState}. It counts only the gaps this packet set out to ` +
          'build, so it may raise that state and never lower one a broader reading established.',
      });
    } else {
      moves.push({
        dimension: 'IMPLEMENTATION',
        from: faculty.implementationState,
        to: target,
        reason: detail,
        evidenceRef: packet.campaignId ?? packet.scanId,
      });
    }
  }

  const evaluation = evaluationFrom(faculty, gaps);
  let evaluationTarget: EvaluationState = evaluation.state;
  let evaluationDetail = evaluation.detail;
  if (evaluation.state === 'PASSING') {
    const proven = await isProductionProven(packet);
    if (proven.proven) {
      evaluationTarget = 'PRODUCTION_PROVEN';
      evaluationDetail = proven.detail;
    } else {
      withheld.push({
        dimension: 'EVALUATION',
        needs: `PRODUCTION_PROVEN needs: ${proven.detail}`,
      });
    }
  }
  if (evaluationTarget !== faculty.evaluationState) {
    moves.push({
      dimension: 'EVALUATION',
      from: faculty.evaluationState,
      to: evaluationTarget,
      reason: evaluationDetail,
      evidenceRef: packet.campaignId,
    });
  }

  /*
   * Availability is named as withheld rather than omitted.
   *
   * A reader scanning this output must be able to see that Brain considered
   * switching the faculty on and will not — an absent line reads as "nothing to
   * say about it", and the honest answer is "this is not mine to say".
   */
  withheld.push({
    dimension: 'AVAILABILITY',
    needs:
      'a person switching it on. Nothing here may move it: a realization that could enable ' +
      'what it built would be granting itself the decision §27 reserves.',
  });

  return { packetId, facultyId: packet.facultyId, moves, withheld };
}

/**
 * Apply a reading, and record what moved and on what.
 *
 * Every move goes through `moveDimension`, which writes the append-only event
 * in the same breath as the column — so a registry that advanced has, by
 * construction, a row saying why. `viaIngestion` is deliberately not set: these
 * are exactly the dimensions an ingestion may not move, and this is the path
 * that is allowed to.
 */
export async function applyProof(input: {
  packetId: string;
  actorType: string;
  actorId?: string | null;
}): Promise<ProofReading & { applied: number }> {
  const reading = await readProof(input.packetId);
  let applied = 0;
  for (const move of reading.moves) {
    const moved = await moveDimension({
      facultyId: reading.facultyId,
      dimension: move.dimension,
      to: move.to,
      reason: move.reason,
      evidenceRef: move.evidenceRef,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
    });
    if (moved) applied += 1;
  }
  return { ...reading, applied };
}
