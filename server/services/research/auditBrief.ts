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
import {
  buildPrimaryPrompt,
  buildAdversarialPrompt,
  buildJudgePrompt,
} from '../audit/prompts.ts';
import { listPasses } from '../../repos/research.ts';
import type { ResearchOrchestration } from '../../domain/types.ts';

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
 */
export async function earlierAuditRole(
  orchestrationId: string,
  role: AuditRole,
): Promise<string | null> {
  const passes = await listPasses(orchestrationId);
  const match = passes
    .filter((pass) => pass.passKey === 'AUDIT' && pass.ordinal === ROLE_PASS_ORDINAL[role])
    .filter((pass) => pass.status === 'COMPLETE')
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

  const context = await buildAuditContext({
    mode: 'SINGLE_DOCUMENT',
    layerId: orchestration.layerId,
    documentId: orchestration.documentId,
    runId: orchestration.runId,
  });

  if (context.artifacts.length === 0) {
    throw new AuditBriefUnavailable('The document under audit could not be read back.');
  }

  let prompt: string;
  const dependsOnRoles: AuditRole[] = [];

  if (role === 'PRIMARY') {
    prompt = buildPrimaryPrompt(context);
  } else if (role === 'ADVERSARIAL') {
    const primary = await earlierAuditRole(orchestration.id, 'PRIMARY');
    if (!primary) {
      throw new AuditBriefUnavailable(
        'The primary audit pass has not been completed, so there is nothing to attack.',
      );
    }
    dependsOnRoles.push('PRIMARY');
    prompt = buildAdversarialPrompt(context, primary);
  } else {
    const primary = await earlierAuditRole(orchestration.id, 'PRIMARY');
    const adversarial = await earlierAuditRole(orchestration.id, 'ADVERSARIAL');
    if (!primary || !adversarial) {
      throw new AuditBriefUnavailable(
        'The judge cannot run until both the primary and adversarial passes have been completed.',
      );
    }
    dependsOnRoles.push('PRIMARY', 'ADVERSARIAL');
    prompt = buildJudgePrompt(context, primary, adversarial);
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
