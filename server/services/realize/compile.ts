/**
 * Turning a decision-ready packet into a bounded change request.
 *
 * ---------------------------------------------------------------------------
 * Research must not terminate in prose
 * ---------------------------------------------------------------------------
 *
 * A realization that ends in a report is a realization that ends. What the
 * Factory can act on is a contract: an objective, an expected outcome, non-goals
 * and acceptance conditions that each name how they are verified. This composes
 * one from rows the packet already holds, and composes **nothing** from rows it
 * does not.
 *
 * ---------------------------------------------------------------------------
 * Every compiled clause traces to a gap
 * ---------------------------------------------------------------------------
 *
 * One acceptance condition per buildable gap, carrying that gap's id. So the
 * contract a person approves can be read back to the requirement it came from,
 * the requirement to the faculty's definition, the definition to the candidate,
 * the candidate to the quote, and the quote to a block in the source document.
 * That chain is the whole point of the kernel: *every action traces upward,
 * every conclusion traces downward.*
 *
 * A clause with no gap behind it would break that chain at its first link, so
 * there is no path here that invents one.
 *
 * ---------------------------------------------------------------------------
 * What it refuses, and why each refusal is the safe direction
 * ---------------------------------------------------------------------------
 *
 * It refuses a packet that is not decision-ready, because a contract compiled
 * over open questions asks for work nobody has established is the right work.
 * It refuses a packet with nothing to build, because a change request that asks
 * for nothing is worse than none — somebody approves it and a campaign runs.
 * And it refuses to *approve*: `compile` produces a submission, and starting it
 * is a person's decision through the same `approveAndStartCampaign` every other
 * entrance uses. §27 gives two decisions to a person and this adds no third
 * path around either.
 */
import { getFaculty } from '../../repos/faculties.ts';
import type { ObjectiveSubmission } from '../factory/contract.ts';
import { decisionReadiness } from './director.ts';
import { currentSections, getPacket, listGaps, type PacketGap } from './packet.ts';

/** The gap kinds that are a change to code. Nothing else compiles into one. */
export const BUILDABLE: readonly PacketGap['kind'][] = ['MUST_BE_BUILT', 'MUST_BE_REPLACED'];

export interface CompiledRequest {
  /** Ready to hand to `submitObjective`. */
  submission: ObjectiveSubmission;
  /** One per acceptance condition, in the same order, naming the gap behind it. */
  provenance: Array<{ condition: string; gapId: string; requirement: string; aspect: string }>;
  facultySlug: string;
  packetId: string;
}

export type CompileOutcome =
  | { ok: true; compiled: CompiledRequest }
  | { ok: false; reason: string; unresolved: string[] };

/**
 * Compose the change request a decision-ready packet implies.
 *
 * `projectId` and the repository come from the caller rather than from the
 * packet, and deliberately: which repository a project may change is an
 * authorization in rows a person wrote (§27), and a compiler that chose one
 * would be picking the reach of its own work. The packet decides *what* to ask
 * for; somebody else decides *where*.
 */
export async function compile(input: {
  packetId: string;
  projectId: string;
  repositoryRemote?: string;
  baseBranch?: string;
  /** Narrow the reach below what the grant allows. Never widens it. */
  mutationScope?: string[];
}): Promise<CompileOutcome> {
  const packet = await getPacket(input.packetId);
  if (!packet) return { ok: false, reason: `No such packet: ${input.packetId}`, unresolved: [] };
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) {
    return {
      ok: false,
      reason: `Packet ${input.packetId} names a faculty that does not exist.`,
      unresolved: [],
    };
  }

  const readiness = await decisionReadiness(input.packetId);
  if (!readiness.decisionReady) {
    return {
      ok: false,
      reason:
        `${readiness.reason} A contract compiled over open questions asks for work nobody has ` +
        'established is the right work.',
      unresolved: readiness.unresolved,
    };
  }

  const gaps = (await listGaps(input.packetId, { states: ['OPEN', 'ASSIGNED'] })).filter((gap) =>
    BUILDABLE.includes(gap.kind),
  );
  if (gaps.length === 0) {
    // Unreachable through `decisionReadiness`, which already requires one — and
    // kept anyway, because the two could drift and a change request that asks
    // for nothing is the outcome nobody would notice until a campaign had run.
    return {
      ok: false,
      reason:
        'Nothing on this packet is classified as needing to be built, so there is nothing to ' +
        'ask for. A change request that asks for nothing is worse than none: somebody approves ' +
        'it and a campaign runs.',
      unresolved: [],
    };
  }

  const sections = await currentSections(input.packetId);
  const contract = sections.find((row) => row.section === 'COGNITIVE_CONTRACT');
  const topology = sections.find((row) => row.section === 'TARGET_TOPOLOGY');

  const provenance = gaps.map((gap) => ({
    condition: conditionFor(gap),
    gapId: gap.id,
    requirement: gap.requirement,
    aspect: gap.aspect,
  }));

  const submission: ObjectiveSubmission = {
    projectId: input.projectId,
    objective:
      `Implement the ${gaps.length} missing part(s) of ${faculty.canonicalName} that Brain's own ` +
      `reading of itself found: ${gaps.map((gap) => shortLabel(gap)).join('; ')}.`,
    expectedOutcome: faculty.definition.promisedPower,
    /*
     * Non-goals come from the faculty's own declared boundaries, plus the two
     * this kernel adds. Both of the added ones are refusals of things a
     * campaign could plausibly do that would make the result look finished
     * without being it — which is exactly what `fakeCompletionConditions` is
     * for, said where a builder will read it.
     */
    nonGoals: [
      ...faculty.definition.boundaries,
      'Moving any dimension on the faculty registry. A dimension moves because code ran and was ' +
        'evaluated, never because an implementation was merged.',
      'Adding a second orchestration path beside the ones this Brain already has. Every new ' +
        'mechanism is an entrance to existing machinery, not a parallel universe for it.',
    ],
    acceptanceConditions: provenance.map((entry) => ({
      statement: entry.condition,
      verification:
        'A test that fails against the current tree and passes against the change, exercising ' +
        'the path a caller actually takes rather than a fixture that arranges its own starting ' +
        'state.',
      mandatory: true,
    })),
    repositoryRemote: input.repositoryRemote,
    baseBranch: input.baseBranch,
    mutationScope: input.mutationScope,
  };

  /*
   * A cognitive contract and a target topology are designs a reader wrote, and
   * they are carried into the objective rather than summarised — a compiler
   * paraphrasing somebody's design would be answering the question they were
   * asked to answer. They are optional here because `decisionReadiness` already
   * requires the *gaps* to be settled and not the designs; a packet can be
   * decision-ready with either still absent, and saying so is better than
   * refusing on a condition nobody stated.
   */
  const carried: string[] = [];
  if (topology) carried.push(`Target topology (version ${topology.version}).`);
  if (contract) carried.push(`Cognitive contract (version ${contract.version}).`);
  if (carried.length > 0) {
    submission.objective += ` Designs this packet carries: ${carried.join(' ')}`;
  }

  return {
    ok: true,
    compiled: {
      submission,
      provenance,
      facultySlug: faculty.slug,
      packetId: input.packetId,
    },
  };
}

/**
 * One acceptance condition, from one gap.
 *
 * The requirement is quoted rather than paraphrased, and the gap id travels in
 * the sentence. That is what makes the chain readable in the direction a
 * reviewer walks it: from a condition in the contract back to the requirement,
 * the definition, the candidate and the quoted passage in the source.
 */
function conditionFor(gap: PacketGap): string {
  const verb = gap.kind === 'MUST_BE_REPLACED' ? 'replaces what currently serves' : 'serves';
  return (
    `The change ${verb} this requirement, stated by the blueprint under "${gap.aspect}": ` +
    `"${gap.requirement}". [gap ${gap.id}]`
  );
}

function shortLabel(gap: PacketGap): string {
  const trimmed = gap.requirement.replace(/\s+/g, ' ').trim();
  return trimmed.length > 90 ? `${trimmed.slice(0, 87)}…` : trimmed;
}

/**
 * Whether a compiled request's every clause still traces to a live gap.
 *
 * Checked separately from compilation because the interesting moment is *later*:
 * a contract approved a week ago against gaps that have since been waived is a
 * campaign building something nobody wants any more. §24's `linkFiledWork`
 * correction is the same shape — a link is a fact about now, and non-null is not
 * the same fact as current.
 */
export async function provenanceStillHolds(
  compiled: CompiledRequest,
): Promise<{ ok: boolean; stale: string[] }> {
  const live = new Map(
    (await listGaps(compiled.packetId)).map((gap) => [gap.id, gap] as const),
  );
  const stale: string[] = [];
  for (const entry of compiled.provenance) {
    const gap = live.get(entry.gapId);
    if (!gap) {
      stale.push(`${entry.gapId} no longer exists on this packet.`);
      continue;
    }
    if (gap.state === 'CLOSED' || gap.state === 'WAIVED') {
      stale.push(`${entry.gapId} is ${gap.state}: ${gap.stateReason ?? 'no reason recorded'}.`);
      continue;
    }
    if (!BUILDABLE.includes(gap.kind)) {
      stale.push(`${entry.gapId} has been reclassified as ${gap.kind}, which is not a build.`);
    }
  }
  return { ok: stale.length === 0, stale };
}
