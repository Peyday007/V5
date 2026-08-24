/**
 * Synthesis engine (section 14).
 *
 * Invariant 4: a synthesis never starts on a hole. The whole source packet is
 * validated *before* anything is written, and an incomplete packet throws a
 * `DependencyError` carrying the exact `6 / 7 READY` breakdown so the caller can
 * show the user which document is missing instead of a generic failure.
 *
 * A human may still override — this is their project — but the override is
 * recorded on the run and in the event log, never silently swallowed.
 */
import type {
  CompiledPrompt,
  DependencyCheckResult,
  Document,
  ResearchRun,
  RunStatus,
  VersionPolicy,
} from '../domain/types.ts';
import { DEFAULT_VERSION_POLICY } from '../domain/types.ts';
import { synthesisVersion, versionSortKey } from '../domain/version.ts';
import { getDb } from '../db/database.ts';
import { createDocument, findDocumentByCanonicalName, updateDocument } from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { createRun, getRun, updateRun } from '../repos/runs.ts';
import { checkCanonicalNames, setRunDependencies } from './dependencies.ts';
import { compilePrompt, defaultRequiredDocuments, defaultTargetVersion } from './promptCompiler.ts';
import { recomputeProject } from './stateEngine.ts';

/**
 * Thrown when a synthesis is attempted on an incomplete source packet. Carries
 * the full check result so the UI can list exactly what is missing.
 */
export class DependencyError extends Error {
  readonly result: DependencyCheckResult;

  constructor(result: DependencyCheckResult) {
    const missing = result.missing.length > 0 ? result.missing.join(', ') : 'none';
    const inconsistent =
      result.inconsistent.length > 0
        ? ` Files missing from disk: ${result.inconsistent.join(', ')}.`
        : '';
    super(
      `Source packet is incomplete (${result.summary}). Missing: ${missing}.${inconsistent} ` +
        'Import the missing documents, or override explicitly with a reason.',
    );
    this.name = 'DependencyError';
    this.result = result;
  }
}

export interface PrepareSynthesisInput {
  layerId: string;
  override?: boolean;
  overrideReason?: string | null;
}

export interface SynthesisPreparation {
  run: ResearchRun;
  document: Document;
  dependencies: DependencyCheckResult;
  compiled: CompiledPrompt;
}

/**
 * Validate the packet, then create everything a synthesis needs in one atomic
 * step: the expected synthesis document, the run, its dependency rows and its
 * compiled prompt (invariant 10). Ends by recomputing project state so the
 * layer immediately reads SYNTHESIS_READY / BLOCKED without a second call.
 */
export async function prepareSynthesis(input: PrepareSynthesisInput): Promise<SynthesisPreparation> {
  const layer = await getLayer(input.layerId);
  if (!layer) throw new Error(`Cannot prepare a synthesis: unknown layer ${input.layerId}`);
  const project = await getProject(layer.projectId);
  if (!project) throw new Error(`Cannot prepare a synthesis: unknown project ${layer.projectId}`);
  const policy: VersionPolicy = project.versionPolicy ?? DEFAULT_VERSION_POLICY;
  const override = input.override === true;

  // 1. Validate the whole packet first — nothing is written until it passes.
  const requiredDocuments = await defaultRequiredDocuments(project.id, layer.id, 'SYNTHESIS');
  const dependencies = await checkCanonicalNames(project.id, requiredDocuments);
  // An empty packet reports "0 / 0 READY", which is technically ready and
  // completely meaningless: there is nothing to consolidate. Refuse outright,
  // because no override can conjure source material that does not exist.
  if (requiredDocuments.length === 0) {
    throw new Error(
      `Cannot synthesise ${layer.name}: the layer has no completed research to consolidate. ` +
        `Import or produce its foundation and expansion documents first.`,
    );
  }
  if (!dependencies.ready && !override) throw new DependencyError(dependencies);

  const targetVersion =
    await defaultTargetVersion(project.id, layer.id, 'SYNTHESIS') || synthesisVersion(policy);
  const compiled = await compilePrompt({
    projectId: project.id,
    layerId: layer.id,
    runType: 'SYNTHESIS',
    targetVersion,
    requiredDocuments,
  });

  const overrideReason = override
    ? (input.overrideReason ?? '').trim() || 'Overridden by the user without a stated reason.'
    : null;

  const db = getDb();
  const prepared = await db.transaction(async (): Promise<{ run: ResearchRun; document: Document }> => {
    // 2. The synthesis document exists as an expectation before it exists as a
    //    file: that is what makes "Qualification Logic v3.1 is missing" sayable.
    const existing = await findDocumentByCanonicalName(project.id, compiled.targetCanonicalName);
    let document: Document;
    if (existing) {
      document =
        existing.status === 'MISSING' || existing.status === 'FAILED'
          ? (await updateDocument(existing.id, { status: 'EXPECTED' }) ?? existing)
          : existing;
    } else {
      document = await createDocument({
        projectId: project.id,
        layerId: layer.id,
        canonicalName: compiled.targetCanonicalName,
        version: compiled.targetVersion,
        versionSort: versionSortKey(compiled.targetVersion),
        wave: policy.synthesisWave,
        documentType: 'SYNTHESIS',
        status: 'EXPECTED',
        conversationTitle: compiled.expectedConversationTitle,
        notes: `Expected synthesis of ${requiredDocuments.length} source document${
          requiredDocuments.length === 1 ? '' : 's'
        }.`,
      });
      await recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'DOCUMENT',
        entityId: document.id,
        eventType: 'DOCUMENT_CREATED',
        payload: {
          canonicalName: document.canonicalName,
          version: document.version,
          documentType: 'SYNTHESIS',
          status: 'EXPECTED',
        },
      });
    }

    // 3. The run carries the exact prompt and the exact attachment list.
    const status: RunStatus = dependencies.ready || override ? 'READY' : 'BLOCKED';
    const run = await createRun({
      projectId: project.id,
      layerId: layer.id,
      targetDocumentId: document.id,
      targetVersion: compiled.targetVersion,
      runType: 'SYNTHESIS',
      status,
      prompt: compiled.prompt,
      promptSections: compiled.sections,
      requiredAttachments: compiled.requiredAttachments,
      expectedConversationTitle: compiled.expectedConversationTitle,
      expectedFilename: compiled.expectedFilename,
    });
    await setRunDependencies(run.id, requiredDocuments);

    if (override) {
      await updateRun(run.id, {
        dependencyOverride: true,
        dependencyOverrideReason: overrideReason,
      });
      await recordEvent({
        projectId: project.id,
        layerId: layer.id,
        entityType: 'RUN',
        entityId: run.id,
        eventType: 'DEPENDENCY_OVERRIDDEN',
        payload: {
          reason: overrideReason,
          missing: dependencies.missing,
          inconsistent: dependencies.inconsistent,
          summary: dependencies.summary,
          targetVersion: compiled.targetVersion,
        },
      });
    }

    await recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_CREATED',
      payload: {
        runType: 'SYNTHESIS',
        targetVersion: compiled.targetVersion,
        status,
        dependencies: dependencies.summary,
      },
    });
    await recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_PROMPT_COMPILED',
      payload: {
        runType: 'SYNTHESIS',
        targetVersion: compiled.targetVersion,
        requiredAttachments: compiled.requiredAttachments,
        expectedConversationTitle: compiled.expectedConversationTitle,
        expectedFilename: compiled.expectedFilename,
      },
    });
    await recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'SYNTHESIS_CREATED',
      payload: {
        runId: run.id,
        documentId: document.id,
        canonicalName: document.canonicalName,
        targetVersion: compiled.targetVersion,
        sourcePacket: requiredDocuments,
        dependencies: dependencies.summary,
        override,
        overrideReason,
      },
    });

    return { run, document };
  });

  // Recomputing here is what lets the caller simply refresh the layer instead
  // of deriving state themselves.
  await recomputeProject(project.id);

  return {
    run: await getRun(prepared.run.id) ?? prepared.run,
    document: prepared.document,
    dependencies,
    compiled,
  };
}
