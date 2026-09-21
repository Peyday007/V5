/**
 * The step between a compiled contract and a Factory that was waiting for one.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `compile()` composes a complete `ObjectiveSubmission` out of a decision-ready
 * packet — the objective, the expected outcome, the non-goals, and one
 * acceptance condition per buildable gap, each carrying the gap, the
 * requirement and the aspect it came from. Its only caller printed it and
 * stopped. So the two halves of the self-expansion loop — a packet that knows
 * what has to be built, and a Factory that builds what somebody approved — had
 * nothing between them but a person retyping.
 *
 * This repository has written the same sentence five times about five different
 * modules: **a mechanism nothing calls is not a mechanism.** A compiled
 * contract that reaches no row is the sixth.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * **It does not approve, and it cannot.** `submitObjective` records a change
 * request in its own pre-approval state; `approveAndStartCampaign` is a
 * separate, guarded, person-only transition and is not imported here. §27 is
 * explicit that approving the objective and approving the release are the two
 * decisions the factory has no path around, and a self-expansion loop that
 * could approve its own work would be the one failure mode declining a pull
 * request does not contain. The whole effect of this module is an unapproved
 * row and a pointer to it.
 *
 * **It does not choose the repository or the project.** Both come from the
 * caller and are passed through `compile`, which says why in its own header:
 * which repository a project may change is an authorization in rows a person
 * wrote, and a compiler that picked one would be choosing the reach of its own
 * work. Nothing here widens that — `mutationScope` is passed through and
 * `submitObjective` holds it against the project's declared boundary, which may
 * only narrow.
 *
 * **It does not resubmit.** The packet's `change_request_id` is written by a
 * guarded `UPDATE` naming the state the packet was in and requiring the column
 * to still be null, so two ticks reading one ready packet produce one
 * submission and the loser is an ordinary outcome. The sixth time this codebase
 * has needed a compare-and-swap on a value the claimant does not supply, and
 * the same shape §25 uses for a delivery's version and §19 for a lease.
 */
import { getDb } from '../../db/database.ts';
import { nowIso } from '../../repos/util.ts';
import { ContractError, submitObjective } from '../factory/contract.ts';
import type { FactoryChangeRequest } from '../../domain/types.ts';
import { compile } from './compile.ts';
import type { CompiledRequest } from './compile.ts';
import { getPacket } from './packet.ts';
import type { RealizationPacket } from './packet.ts';

export type HandOffOutcome =
  | {
      ok: true;
      /** The change request now recorded on the packet. */
      changeRequest: FactoryChangeRequest;
      /** False when the packet already carried this submission. */
      created: boolean;
      compiled: CompiledRequest;
      packet: RealizationPacket;
    }
  | { ok: false; reason: string; unresolved: string[] };

/**
 * Compile this packet and record the ask, once.
 *
 * Every refusal `compile` can make is returned unchanged rather than
 * reinterpreted: a packet that is one open question short and one that has
 * nothing to build are different outcomes with different next steps, and a
 * caller that got "could not hand off" for both would go looking in the wrong
 * place.
 */
export async function handOff(input: {
  packetId: string;
  projectId: string;
  repositoryRemote?: string;
  baseBranch?: string;
  mutationScope?: string[];
}): Promise<HandOffOutcome> {
  const existing = await getPacket(input.packetId);
  if (!existing) {
    return { ok: false, reason: `No such packet: ${input.packetId}`, unresolved: [] };
  }

  const outcome = await compile({
    packetId: input.packetId,
    projectId: input.projectId,
    repositoryRemote: input.repositoryRemote,
    baseBranch: input.baseBranch,
    mutationScope: input.mutationScope,
  });
  if (!outcome.ok) return outcome;

  let result;
  try {
    result = await submitObjective(outcome.compiled.submission);
  } catch (error) {
    if (error instanceof ContractError) {
      return {
        ok: false,
        reason:
          `The Factory refused the compiled contract: ${error.message} The packet is unchanged, ` +
          'so whatever is wrong can be corrected and handed off again.',
        unresolved: [],
      };
    }
    throw error;
  }

  /*
   * Claim the packet for this submission.
   *
   * Guarded on the column still being null rather than on the packet's state:
   * the state is the thing another transition may legitimately be moving at the
   * same moment, and the null is the one value that means nobody has submitted
   * yet and is never what a winner leaves behind — §34's correction at the
   * probe claim, where a guard satisfied by the state it was claiming into
   * turned out to be no guard at all on the second backend.
   */
  const claimed = await getDb().run(
    `UPDATE realization_packets
        SET change_request_id = ?, updated_at = ?
      WHERE id = ? AND change_request_id IS NULL`,
    [result.changeRequest.id, nowIso(), input.packetId] as never[],
  );

  if ((claimed.changes ?? 0) === 0) {
    const current = await getPacket(input.packetId);
    if (current?.changeRequestId === result.changeRequest.id) {
      // The same ask, recorded by whoever got there first. `submitObjective` is
      // idempotent by submission key, so this is the ordinary repeat rather
      // than a second contract — the effect is present after either call, which
      // is what idempotent means here.
      return {
        ok: true,
        changeRequest: result.changeRequest,
        created: false,
        compiled: outcome.compiled,
        packet: current,
      };
    }
    return {
      ok: false,
      reason:
        `This packet already carries change request ${current?.changeRequestId ?? 'unknown'}, ` +
        `and the contract compiled now is ${result.changeRequest.id}. Two asks for one packet ` +
        'would put two decisions in front of a person for one question, so nothing was linked. ' +
        'The compiled contract still exists and can be approved on its own terms.',
      unresolved: [],
    };
  }

  const packet = await getPacket(input.packetId);
  return {
    ok: true,
    changeRequest: result.changeRequest,
    created: result.created,
    compiled: outcome.compiled,
    packet: packet ?? existing,
  };
}
