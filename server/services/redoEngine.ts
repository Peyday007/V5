/**
 * Redo engine (section 13).
 *
 * Invariant 5: a redo never destroys the history of the attempt that failed.
 * The failed run keeps its prompt, its result text, its attempt number and its
 * audit; the redo is a *new* run that points back at it. That is what makes
 * "why did this take four attempts?" answerable months later.
 *
 * Automatic redos are capped. Past the cap the platform stops looping and says
 * so, because an AI that keeps redoing its own work unattended is exactly the
 * failure mode this project exists to prevent.
 */
import type { Project, ResearchRun } from '../domain/types.ts';
import { DEFAULT_VERSION_POLICY } from '../domain/types.ts';
import { buildCanonicalName } from '../domain/naming.ts';
import { getDb } from '../db/database.ts';
import { getAudit, getLatestAuditForRun } from '../repos/audits.ts';
import { listDependenciesForRun } from '../repos/dependencies.ts';
import { recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { countRedoAttempts, createRun, getRun, updateRun } from '../repos/runs.ts';
import { checkRunDependencies, setRunDependencies } from './dependencies.ts';
import { compilePrompt, defaultRequiredDocuments, defaultTargetVersion } from './promptCompiler.ts';
import { recomputeProject } from './stateEngine.ts';

/** The redo cap: an explicit project setting wins, otherwise the version policy. */
function maxAutoRedosFor(project: Project): number {
  const override = Number(project.settings['maxAutoRedos']);
  if (Number.isFinite(override) && override >= 0) return Math.floor(override);
  const policy = Number(project.versionPolicy.maxAutoRedos);
  if (Number.isFinite(policy) && policy >= 0) return Math.floor(policy);
  return DEFAULT_VERSION_POLICY.maxAutoRedos;
}

async function describeRun(run: ResearchRun): Promise<string> {
  const layer = run.layerId ? await getLayer(run.layerId) : null;
  if (layer && run.targetVersion) return buildCanonicalName(layer.name, run.targetVersion);
  if (layer) return layer.name;
  return `run ${run.id}`;
}

/**
 * May the platform redo this run by itself, or does a human have to look?
 * Counts every prior attempt in the lineage, not just direct children, so a
 * chain of redos cannot reset the counter by re-parenting.
 */
export async function canAutoRedo(
  parentRunId: string,
  maxAutoRedos: number,
): Promise<{ allowed: boolean; attempts: number; reason: string }> {
  const parent = await getRun(parentRunId);
  if (!parent) {
    return {
      allowed: false,
      attempts: 0,
      reason: `Run ${parentRunId} does not exist, so there is nothing to redo; a human review is now required.`,
    };
  }
  const limit = Number.isFinite(maxAutoRedos) && maxAutoRedos >= 0
    ? Math.floor(maxAutoRedos)
    : DEFAULT_VERSION_POLICY.maxAutoRedos;
  const attempts = await countRedoAttempts(parentRunId);
  const target = await describeRun(parent);

  if (attempts >= limit) {
    return {
      allowed: false,
      attempts,
      reason:
        `${attempts} automatic redo${attempts === 1 ? '' : 's'} of ${target} ` +
        `already happened and the limit is ${limit}; a human review is now required before another attempt.`,
    };
  }
  return {
    allowed: true,
    attempts,
    reason: `${attempts} of ${limit} automatic redos used for ${target}; an automatic redo is allowed.`,
  };
}

export interface CreateRedoInput {
  parentRunId: string;
  auditId?: string | null;
  reason: string;
  automatic?: boolean;
}

/**
 * Create the corrected attempt. The failed run and its result are read but
 * never written: the new run carries `parent_run_id`, the next attempt number,
 * the redo reason, a copy of the source packet, and a freshly compiled prompt
 * that includes the audit findings and the previous attempt.
 */
export async function createRedoRun(input: CreateRedoInput): Promise<ResearchRun> {
  const parent = await getRun(input.parentRunId);
  if (!parent) throw new Error(`Cannot create a redo: unknown run ${input.parentRunId}`);
  const layerId = parent.layerId;
  if (!layerId) throw new Error(`Cannot create a redo: run ${parent.id} is not attached to a layer`);
  const layer = await getLayer(layerId);
  if (!layer) throw new Error(`Cannot create a redo: unknown layer ${layerId}`);
  const project = await getProject(parent.projectId);
  if (!project) throw new Error(`Cannot create a redo: unknown project ${parent.projectId}`);

  const reason = input.reason.trim() || `Redo of ${await describeRun(parent)} requested.`;
  const audit =
    (input.auditId ? await getAudit(input.auditId) : null) ?? await getLatestAuditForRun(parent.id) ?? null;

  // The redo targets the same artifact as the attempt it replaces.
  const targetVersion =
    parent.targetVersion ?? await defaultTargetVersion(parent.projectId, layerId, 'REDO');

  // Same source packet: a redo is a corrected attempt at the same work, not a
  // different question with different inputs.
  const inheritedPacket = (await listDependenciesForRun(parent.id)).map(
    (dependency) => dependency.requiredCanonicalName,
  );
  const requiredDocuments =
    inheritedPacket.length > 0
      ? inheritedPacket
      : parent.requiredAttachments.length > 0
        ? parent.requiredAttachments
        : await defaultRequiredDocuments(parent.projectId, layerId, 'REDO');

  const compiled = await compilePrompt({
    projectId: parent.projectId,
    layerId,
    runType: 'REDO',
    targetVersion,
    requiredDocuments,
    auditId: audit?.id ?? null,
    previousRunId: parent.id,
  });

  const db = getDb();
  const redo = await db.transaction(async () => {
    const created = await createRun({
      projectId: parent.projectId,
      layerId,
      targetDocumentId: parent.targetDocumentId,
      targetVersion: compiled.targetVersion,
      runType: 'REDO',
      attemptNumber: parent.attemptNumber + 1,
      status: 'READY',
      provider: parent.provider,
      model: parent.model,
      prompt: compiled.prompt,
      promptSections: compiled.sections,
      requiredAttachments: compiled.requiredAttachments,
      expectedConversationTitle: compiled.expectedConversationTitle,
      expectedFilename: compiled.expectedFilename,
      parentRunId: parent.id,
      redoReason: reason,
      conversationId: parent.conversationId,
    });

    await setRunDependencies(created.id, requiredDocuments);
    const packet = await checkRunDependencies(created.id);
    if (!packet.ready) await updateRun(created.id, { status: 'BLOCKED' });

    await recordEvent({
      projectId: parent.projectId,
      layerId,
      entityType: 'RUN',
      entityId: created.id,
      eventType: 'RUN_CREATED',
      payload: {
        runType: 'REDO',
        parentRunId: parent.id,
        attemptNumber: created.attemptNumber,
        targetVersion: compiled.targetVersion,
        auditId: audit?.id ?? null,
        reason,
        automatic: input.automatic === true,
        dependencies: packet.summary,
      },
    });
    await recordEvent({
      projectId: parent.projectId,
      layerId,
      entityType: 'RUN',
      entityId: created.id,
      eventType: 'RUN_PROMPT_COMPILED',
      payload: {
        runType: 'REDO',
        targetVersion: compiled.targetVersion,
        requiredAttachments: compiled.requiredAttachments,
        expectedFilename: compiled.expectedFilename,
        includesAuditFindings: audit !== null,
      },
    });
    if (input.automatic === true) {
      await recordEvent({
        projectId: parent.projectId,
        layerId,
        entityType: 'RUN',
        entityId: created.id,
        eventType: 'AUTO_REDO_CREATED',
        payload: {
          parentRunId: parent.id,
          attemptNumber: created.attemptNumber,
          maxAutoRedos: maxAutoRedosFor(project),
          reason,
        },
      });
    }

    return created;
  });

  await recomputeProject(parent.projectId);
  return await getRun(redo.id) ?? redo;
}
