/**
 * Authorizing one packet to record unresolved gaps.
 *
 * Narrowing a goal because research failed is a decision about a single packet.
 * Left to the runner it would mean a Brain that can always declare its way to
 * "complete" whenever evidence runs out, which is the failure invariant 20
 * exists to prevent. So it is an authorization: someone decides, it is written
 * against that packet with their identity and the time, and `advancePacket`
 * refuses to convert anything without it.
 *
 * The permanent service is here rather than in a script or a screen. Step 12
 * will call it from wherever the Brain's own controls end up; today the caller
 * is `scripts/authorize-gap-policy.ts` and `startPacket`.
 */
import { getOrchestration, updateOrchestration } from '../../repos/research.ts';
import { recordEvent } from '../../repos/events.ts';
import type { ResearchOrchestration } from '../../domain/types.ts';

export class GapPolicyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GapPolicyRefused';
  }
}

export type AuthorizeResult =
  | { status: 'AUTHORIZED'; orchestration: ResearchOrchestration }
  | { status: 'ALREADY_AUTHORIZED'; orchestration: ResearchOrchestration };

/**
 * Idempotent by the packet's own state, not by a key.
 *
 * Running it twice is the ordinary case — a release step re-runs, a person
 * repeats a command — and the second run must not rewrite the first
 * authorization's author or timestamp. Who decided, and when, is the whole
 * content of the record.
 */
export async function authorizeUnresolvedGaps(input: {
  orchestrationId: string;
  authorizedBy: { id: string; email: string };
}): Promise<AuthorizeResult> {
  const orchestration = await getOrchestration(input.orchestrationId);
  if (!orchestration) throw new GapPolicyRefused('No such orchestration.');

  if (orchestration.unresolvedGapPolicy === 'RECORD_GAPS') {
    return { status: 'ALREADY_AUTHORIZED', orchestration };
  }

  const at = new Date().toISOString();
  const updated = await updateOrchestration(orchestration.id, {
    unresolvedGapPolicy: 'RECORD_GAPS',
    unresolvedGapAuthorizedBy: input.authorizedBy.id,
    unresolvedGapAuthorizedAt: at,
  });
  if (!updated) throw new GapPolicyRefused('The orchestration disappeared mid-authorization.');

  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_PLAN_REVIEWED',
    payload: {
      orchestrationId: orchestration.id,
      decision: 'UNRESOLVED_GAP_POLICY_AUTHORIZED',
      policy: 'RECORD_GAPS',
      // The person, by id and address. An authorization whose actor is "a
      // script" answers nothing a year later.
      authorizedByUserId: input.authorizedBy.id,
      authorizedByEmail: input.authorizedBy.email,
      authorizedAt: at,
      scope: 'THIS ORCHESTRATION ONLY',
    },
  });

  return { status: 'AUTHORIZED', orchestration: updated };
}
