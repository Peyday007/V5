/**
 * The audit, when the auditor pulls work instead of answering a prompt.
 *
 * `runDynamicAudit` runs three passes in one loop, calling `provider.run` each
 * time. A Claude Max worker is not a provider — it claims a work item, does
 * something, and reports back — so the three passes arrive as three work items,
 * minutes or hours apart, possibly to different attempts.
 *
 * What this module does is give each of those work items the same prompt the
 * in-process pipeline would have used, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * Why a Brain-composed prompt is not "run this"
 * ---------------------------------------------------------------------------
 *
 * The work-type registry forbids a work type meaning "run this command", and
 * the reasoning transfers to prompts: a payload a caller can write free text
 * into, which then becomes a model's instruction, is a way to make a borrowed
 * account say anything.
 *
 * The audit brief is not that, and the difference is structural rather than a
 * matter of degree. **Nothing the caller sends becomes the prompt.** The brief
 * is composed here, at read time, by `buildPrimaryPrompt` and its siblings,
 * from the project's audit profile, the layer's criteria and the extracted text
 * of the document under audit. There is no field — not in the work item, not in
 * the payload, not in the tool arguments — that a person or a compromised
 * enqueuer can put words into that reach the model as an instruction.
 *
 * The assignment a human wrote does appear inside it, because auditing a
 * research packet against its assignment is the job. It appears as *quoted
 * material inside a Brain-authored frame*, in the same position the document's
 * own text does — and the document was written by a worker, so untrusted
 * content was always going to be in there. That is what §11's rule about
 * imported text is for: it is data, and nothing found inside it may move
 * project state.
 *
 * ---------------------------------------------------------------------------
 * One account playing three roles
 * ---------------------------------------------------------------------------
 *
 * With one connected worker, the primary auditor, the adversarial critic and
 * the judge are three passes on the same account. That is weaker than three
 * independent readers and it is worth saying out loud rather than letting the
 * three rows imply otherwise. Making them independent needs a second worker,
 * which is Step 11.
 */
import type { AuditRole } from '../queue/workTypes.ts';
import { buildAuditContext, type AuditContext } from '../audit/context.ts';
import { listDocumentsByLayer } from '../../repos/documents.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { prefetchExistence, storageKeyOf, withExistenceMemo } from '../storage.ts';

/** A brief this slow is recorded. Well inside the 60 seconds a Cowork client waits. */
const SLOW_BRIEF_MS = 15_000;
import {
  buildPrimaryPrompt,
  buildAdversarialPrompt,
  buildJudgePrompt,
} from '../audit/prompts.ts';
import { listPasses } from '../../repos/research.ts';
import { auditRoundFor, type AuditRound } from './auditRound.ts';
import type { ResearchOrchestration } from '../../domain/types.ts';

/*
 * Re-exported rather than moved silently: `packetRunner` and the Russell loop
 * already read the round boundary from this module, and a rename that left them
 * importing nothing is exactly the failure mode §24 calls "a mechanism nothing
 * calls". The rule itself lives in `auditRound.ts`, with its four readers.
 */
export { auditRoundStartedAt, auditRoundFor, type AuditRound } from './auditRound.ts';

export class AuditBriefUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditBriefUnavailable';
  }
}

/** The pass key each role writes, so a brief resolves to a stored pass. */
export const ROLE_PASS_ORDINAL: Record<AuditRole, number> = {
  PRIMARY: 5,
  ADVERSARIAL: 6,
  JUDGE: 7,
};

export interface AuditBrief {
  role: AuditRole;
  /** The exact text this role is to work from. */
  prompt: string;
  /** What the earlier roles said, when this role depends on them. */
  dependsOnRoles: AuditRole[];
  documentId: string;
  layerName: string;
  /** Proof of exactly what the auditor is reading. */
  manifest: unknown;
}

/**
 * The raw output an earlier audit role already submitted, or null.
 *
 * Read from `research_passes` rather than held in memory, which is what lets
 * the judge run in a different process, hours later, after a restart — the
 * property the in-process pipeline gets for free and this one has to earn.
 *
 * `since` scopes the answer to the current audit round. A pass completed before
 * the packet's document was handed to another layer is not this round's, so it
 * does not satisfy the role — see `auditRoundStartedAt`.
 */
export async function earlierAuditRole(
  orchestrationId: string,
  role: AuditRole,
  round?: AuditRound | null,
): Promise<string | null> {
  const passes = await listPasses(orchestrationId);
  const since = round?.since ?? null;
  /*
   * A carried role satisfies the round without having run again.
   *
   * An integrity reopen may decide that a role whose session authored nothing,
   * and which depends on no role being rerun, does not have to be argued a
   * second time. Its pass is untouched and still belongs to the previous round
   * by the clock — so the boundary has to stop disqualifying it here too, or
   * the runner would enqueue a role the reopen said to keep. Third reader of
   * one rule; the rule itself is `auditRoundFor`.
   */
  const carried = round?.carried?.has(ROLE_PASS_ORDINAL[role]) === true;
  const match = passes
    .filter((pass) => pass.passKey === 'AUDIT' && pass.ordinal === ROLE_PASS_ORDINAL[role])
    .filter((pass) => pass.status === 'COMPLETE')
    .filter((pass) => carried || !since || (pass.completedAt ?? pass.startedAt) > since)
    .at(-1);
  return match?.rawResponse ?? null;
}

/**
 * Build the brief for one role of one orchestration's audit.
 *
 * Refuses rather than improvises when an earlier role has not run. An
 * adversarial pass with no primary findings to attack, or a judge with nothing
 * to weigh, would produce something that looked like an audit and was not one.
 */
export async function auditBriefFor(input: {
  orchestration: ResearchOrchestration;
  role: AuditRole;
}): Promise<{ brief: AuditBrief; context: AuditContext }> {
  const { orchestration, role } = input;

  if (!orchestration.documentId) {
    throw new AuditBriefUnavailable(
      'This packet has no filed document yet, so there is nothing to audit.',
    );
  }

  /*
   * One existence memo for the whole brief, primed with every document in the
   * layer, a bounded number at a time.
   *
   * `buildAuditContext` asks the store about every document in the layer twice:
   * `computeLayerState` checks each one's presence (unbounded, outside any
   * memo) and the sibling listing asks again inside its own. On Cash Mode 1's
   * opportunity layer that is 68 documents, so about 135 bucket requests per
   * brief, repeated on every retry of a role. Asked once here, the second
   * pass is answered from memory. Nothing in a brief writes an object, so no
   * answer can go stale inside it — §27's reasoning for the submission memo.
   */
  const started = Date.now();
  const layerDocuments = await listDocumentsByLayer(orchestration.layerId);
  let prefetchMs = 0;
  const context = await withExistenceMemo(async () => {
    const prefetchStarted = Date.now();
    await prefetchExistence(layerDocuments.map((document) => storageKeyOf(document)));
    prefetchMs = Date.now() - prefetchStarted;
    return await buildAuditContext({
      mode: 'SINGLE_DOCUMENT',
      layerId: orchestration.layerId,
      documentId: orchestration.documentId,
      runId: orchestration.runId,
    });
  });
  const contextMs = Date.now() - started;

  if (context.artifacts.length === 0) {
    throw new AuditBriefUnavailable('The document under audit could not be read back.');
  }

  let prompt: string;
  const dependsOnRoles: AuditRole[] = [];
  /*
   * Scoped to the round, so a re-audit after a handoff attacks and judges *this*
   * round's arguments. Reading the previous round's primary pass here would
   * hand the adversarial role findings about a layer the document has left.
   */
  const round = await auditRoundFor(orchestration.id);

  if (role === 'PRIMARY') {
    prompt = buildPrimaryPrompt(context);
  } else if (role === 'ADVERSARIAL') {
    const primary = await earlierAuditRole(orchestration.id, 'PRIMARY', round);
    if (!primary) {
      throw new AuditBriefUnavailable(
        'The primary audit pass has not been completed, so there is nothing to attack.',
      );
    }
    dependsOnRoles.push('PRIMARY');
    prompt = buildAdversarialPrompt(context, primary);
  } else {
    const primary = await earlierAuditRole(orchestration.id, 'PRIMARY', round);
    const adversarial = await earlierAuditRole(orchestration.id, 'ADVERSARIAL', round);
    if (!primary || !adversarial) {
      throw new AuditBriefUnavailable(
        'The judge cannot run until both the primary and adversarial passes have been completed.',
      );
    }
    dependsOnRoles.push('PRIMARY', 'ADVERSARIAL');
    prompt = buildJudgePrompt(context, primary, adversarial);
  }

  /*
   * A slow brief is written down, measured, where it can be read afterwards.
   *
   * Production, 2026-10-11: `brain_get_audit_brief` for the JUDGE item
   * `wki_684c8d09f8694d449ff6` on `orc_ddd52ffa586642d98929` timed out at the
   * worker's 60 seconds, twice from one worker and repeatedly from another,
   * and the item retired with nothing recorded. Brain logged nothing about
   * it and the host's log buffer no longer held the window by the time
   * anybody looked, so how long the brief took, and in which half, was not
   * established. Measured the same evening through a connector, building the
   * brief took about 40s (JUDGE, orc_ddd52) and 32s (PRIMARY, orc_b818) on a
   * 68-document layer — server-side, before any client overhead. This row is
   * the breakdown that measurement could not give: the elapsed time, how much
   * was the context, how much of that was the store, and the layer's size.
   */
  const totalMs = Date.now() - started;
  if (totalMs >= SLOW_BRIEF_MS) {
    await recordBinEvent({
      eventType: 'AUDIT_BRIEF_SLOW',
      projectId: orchestration.projectId,
      orchestrationId: orchestration.id,
      outcome: role,
      durationMs: totalMs,
      measures: { totalMs, contextMs, prefetchMs, layerDocuments: layerDocuments.length },
      reason:
        `The ${role} brief for ${orchestration.id} took ${totalMs}ms ` +
        `(${contextMs}ms building the context, ${prefetchMs}ms of it asking the store about ` +
        `${layerDocuments.length} document(s) in the layer).`,
      evidenceClass: 'MEASURED',
    });
  }

  return {
    brief: {
      role,
      prompt,
      dependsOnRoles,
      documentId: orchestration.documentId,
      layerName: context.layer.name,
      manifest: context.manifest,
    },
    context,
  };
}
