/**
 * One pass over the capability packets, on the tick that already runs.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * The kernel had every transition and no schedule. `advanceSources` reached the
 * tick — a registered blueprint became a reading, an audit, a promotion, with
 * nobody typing anything — and then it stopped at the registry. Everything
 * *after* a canonical definition was reachable only from `npm run capability`:
 * derive the gaps, read them, ask the world, move the dimensions, compile the
 * contract, hand it off. A person had to run six commands in order, and a
 * packet whose gap was answered on Tuesday sat exactly where it was until
 * somebody remembered to type the next one.
 *
 * That is the same defect one altitude up from the one this kernel keeps
 * correcting. A mechanism whose only caller is an operator's memory is not a
 * mechanism; it is a runbook.
 *
 * ---------------------------------------------------------------------------
 * There is no second orchestrator here, and that is structural
 * ---------------------------------------------------------------------------
 *
 * **Every transition below is the identical function `scripts/capability.ts`
 * calls.** `derivePacket`, `readiness`, `askTheWorld`, `applyRealization`,
 * `handOff`, `answerAuthorityGap` — not reimplemented, not wrapped in a second
 * policy, not given a looser variant for the unattended path. So the CLI and
 * the tick cannot drift into disagreeing about what a packet may do, and the
 * CLI stays what §26 says a terminal is for: the surface you need when
 * something has to be inspected or repaired by hand.
 *
 * The one thing this module owns is *ordering*: which transition is next for a
 * packet in a given state, and when to stop. It is a pure walk over rows.
 *
 * ---------------------------------------------------------------------------
 * What it will not do
 * ---------------------------------------------------------------------------
 *
 * **It approves nothing.** `handOff` records an unapproved change request and
 * stops; approving the objective and approving the release stay person-only on
 * the Build surface, and this module does not import either.
 *
 * **It answers no question a person owns.** A `REQUIRES_PERSON_AUTHORITY` gap
 * becomes a card on Needs You — the decision surface that already exists — and
 * the packet waits. It never derives the answer, never assumes a default, and
 * never treats an unanswered authority as granted.
 *
 * **It spends nothing.** `askTheWorld` captures ideas; whether one becomes a
 * mission is the standing authority's decision on the path every other idea
 * takes.
 *
 * **It fails soft.** A packet that throws is left exactly as it was and the
 * next one is tried. A kernel that could not advance must never stop Russell
 * writing back a mission — it is a reading about Brain, never a precondition of
 * Brain.
 */
import { getFaculty } from '../../repos/faculties.ts';
import { askHuman } from '../../repos/russellMissions.ts';
import { ARCHITECTURE_LAYER, ensureArchitectureScope } from '../capability/ingest.ts';
import { listLayers } from '../../repos/layers.ts';
import { gapsAwaitingAPerson } from './authority.ts';
import { handOff } from './handoff.ts';
import { askTheWorld } from './askTheWorld.ts';
import { applyRealization } from './realized.ts';
import {
  derivePacket,
  getPacket,
  listGaps,
  listPackets,
  readiness,
} from './packet.ts';
import type { RealizationPacket } from './packet.ts';

/**
 * The one answer a capability authority card offers, and its consequence.
 *
 * Two keys rather than one, because a refusal is a different fact from a grant
 * and `answerAuthorityGap` records it differently — `WAIVED` with the refusal
 * on the row, so the packet correctly stays short of whatever that requirement
 * was load-bearing for. A card offering only "yes" is not a decision.
 */
export const CAPABILITY_AUTHORITY_CHOICES = [
  {
    key: 'GRANT_AUTHORITY',
    label: 'Grant this, and let the packet continue',
    consequence:
      'The gap closes as answered by you. Nothing is granted to Brain beyond the sentence you ' +
      'record: the approval envelope, the standing authority and every access decision are ' +
      'untouched, and approving the objective is still a separate decision on Build.',
  },
  {
    key: 'REFUSE_AUTHORITY',
    label: 'Refuse this',
    consequence:
      'The gap is waived with your refusal recorded. The packet stays short of whatever that ' +
      'requirement was load-bearing for, which is the honest outcome rather than a quiet one.',
  },
] as const;

/** The resume key a capability authority card is idempotent by. */
export function authorityResumeKey(gapId: string): string {
  return `capability-authority:${gapId}`;
}

export interface PacketAdvance {
  packetId: string;
  facultySlug: string;
  /** What this pass did, in the order the walk considers them. */
  derived: number;
  asked: number;
  questionsRaised: number;
  dimensionsMoved: string[];
  changeRequestId: string | null;
  /** Why the walk stopped here. Always set, whichever way it went. */
  stoppedBecause: string;
}

export interface AdvanceReport {
  considered: number;
  advances: PacketAdvance[];
  /** Packets a pass threw on, left exactly as they were. */
  failed: Array<{ packetId: string; reason: string }>;
}

/** The states a packet can still be walked from. */
const LIVE: RealizationPacket['state'][] = ['DRAFT', 'RESEARCHING', 'READY'];

/**
 * Walk every live capability packet one step.
 *
 * Bounded by `limit` for the reason every other reconciliation on this tick is:
 * a pass that could grow without bound is one that eventually costs more than
 * the tick has.
 */
export async function advanceCapabilityPackets(limit = 5): Promise<AdvanceReport> {
  const report: AdvanceReport = { considered: 0, advances: [], failed: [] };

  const live = (await listPackets(LIVE)).slice(0, limit);
  for (const packet of live) {
    report.considered += 1;
    try {
      const advance = await advanceOnePacket(packet);
      if (advance) report.advances.push(advance);
    } catch (error) {
      report.failed.push({
        packetId: packet.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

async function advanceOnePacket(packet: RealizationPacket): Promise<PacketAdvance | null> {
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) return null;

  const advance: PacketAdvance = {
    packetId: packet.id,
    facultySlug: faculty.slug,
    derived: 0,
    asked: 0,
    questionsRaised: 0,
    dimensionsMoved: [],
    changeRequestId: packet.changeRequestId,
    stoppedBecause: '',
  };

  /*
   * 1. Gaps, if this packet has none.
   *
   * Only when there are none at all. Re-deriving on every tick would replace a
   * reader's classifications with `NEEDS_A_READING` on a loop, which is the one
   * thing that would make the whole chain unfinishable — `replaceGaps` is how a
   * derivation lands, and a judgement is not something to overwrite on a timer.
   */
  const existing = await listGaps(packet.id);
  if (existing.length === 0) {
    const derivation = await derivePacket(packet.id);
    advance.derived = derivation.gaps;
  }

  /*
   * 2. Anything waiting on a person becomes a card, before anything else.
   *
   * First because it is the slowest thing in the chain and the only one Brain
   * cannot shorten: a card raised now is answered while the rest of the walk
   * carries on, rather than after it. Idempotent by `resume_key`, so a restart
   * mid-pass raises one card rather than a queue of identical ones.
   */
  const scope = await ensureArchitectureScope();
  for (const gap of await gapsAwaitingAPerson(packet.id)) {
    const asked = await askHuman({
      projectId: scope.id,
      authorityNeeded: gap.requirement,
      whyNotRussell:
        `This is ${faculty.definition.canonicalName}'s "${gap.aspect}" requirement, and it names ` +
        'permission, authority, approval, consent, a credential or spending. No amount of ' +
        'building closes one, so Brain routes it to a person whatever machinery matched it. ' +
        `Brain's own reading: ${gap.evidence}`,
      recommendation:
        `Packet ${packet.id} stops here, on gap ${gap.id}: its readiness check refuses while ` +
        'any requirement is waiting on a person, so nothing downstream of this can be ' +
        'compiled. Answering here is the same transition `npm run capability -- packet answer ' +
        '<gapId>` performs, so a person with a browser and a person with a terminal reach one ' +
        'guard rather than two.',
      choices: [...CAPABILITY_AUTHORITY_CHOICES],
      urgency: 'BLOCKING',
      resumeKey: authorityResumeKey(gap.id),
    });
    if (asked.created) advance.questionsRaised += 1;
  }

  /*
   * 3. What the rows say about the faculty's own dimensions.
   *
   * Before the readiness check rather than after, because it is a *reading*
   * and refuses far more often than it answers: an unclassified packet yields
   * no implementation state at all, and a waived requirement is not an
   * implemented one. It moves nothing the gaps do not already support.
   */
  const realized = await applyRealization({
    packetId: packet.id,
    actorType: 'TICK',
    actorId: null,
  });
  advance.dimensionsMoved = realized.moved.map((row) => `${row.dimension}=${row.to}`);

  /*
   * 4. Ask the world about anything that is a question about the world.
   *
   * `askTheWorld` runs the director, which asks the archive first and closes
   * what it already answers — §13's default outcome and the cheapest one. What
   * survives becomes an idea, which spends nothing.
   */
  /*
   * The layer is chosen **by name**, never by position. `ARCHITECTURE_LAYER` is
   * what `ensureArchitectureScope` creates, so it is the one this work files
   * under; `layers[0]` is the same answer today and stops being the same answer
   * the moment somebody adds a second layer to this project. This file already
   * has three recorded instances of an ordering that was true by accident
   * (`binForOrchestration`, `linkFiledWork`, `workerSessionForBin`), and a
   * fourth is not worth saving two lines for.
   *
   * With no such layer the pass stops and says so rather than passing an empty
   * id down: §30 records exactly this — a project with no layer can open work
   * and launch nothing, for ever, with every row reading healthy.
   */
  const layers = await listLayers(scope.id);
  const architectureLayer = layers.find((layer) => layer.name === ARCHITECTURE_LAYER);
  if (!architectureLayer) {
    advance.stoppedBecause =
      `the architecture scope has no "${ARCHITECTURE_LAYER}" layer for the work to file under`;
    return advance;
  }

  const asked = await askTheWorld({
    packetId: packet.id,
    projectId: scope.id,
    layerId: architectureLayer.id,
  });
  advance.asked = asked.asked.length;

  /*
   * 5. Readiness, and the hand-off it permits.
   *
   * `readiness` is the blueprint's own stopping condition made checkable, and
   * it is asked rather than reimplemented. A packet that is not ready stops
   * with the first condition that does not hold, so the report says which
   * transition the next tick is waiting on rather than that nothing happened.
   */
  const verdict = await readiness(packet.id);
  if (!verdict.ready) {
    const blocking = verdict.conditions.find((condition) => !condition.holds);
    advance.stoppedBecause = blocking
      ? `${blocking.condition}: ${blocking.detail}`
      : 'the readiness check refused without naming a condition';
    return advance;
  }

  if (packet.changeRequestId) {
    advance.stoppedBecause =
      `A change request (${packet.changeRequestId}) is already recorded for this packet, and ` +
      'approving it is a person’s decision on Build.';
    return advance;
  }

  const handed = await handOff({ packetId: packet.id, projectId: scope.id });
  if (!handed.ok) {
    advance.stoppedBecause = handed.reason;
    return advance;
  }
  advance.changeRequestId = handed.changeRequest.id;
  advance.stoppedBecause =
    `Compiled and recorded as change request ${handed.changeRequest.id}. Nothing has started: ` +
    'approving the objective is a person’s decision on Build.';

  const after = await getPacket(packet.id);
  if (after) advance.facultySlug = faculty.slug;
  return advance;
}
