/**
 * The dynamic audit pipeline (sections 18-21).
 *
 *   context  ->  PRIMARY  ->  ADVERSARIAL  ->  JUDGE  ->  recordAudit
 *
 * Every pass is a separate model call with a separate role, and every call is
 * persisted with its exact prompt and raw response. Only the judge's validated,
 * structured output is allowed to reach project state; anything else — an
 * invalid response, a provider error, a timeout, an unreadable artifact — is an
 * audit FAILURE that changes nothing.
 */
import { randomUUID } from 'node:crypto';
import type {
  Audit,
  AuditMode,
  AuditPass,
  AuditPassKey,
  LayerStateSnapshot,
  ResearchRun,
  StructuredAuditResult,
} from '../../domain/types.ts';
import type { AIProvider } from '../../providers/types.ts';
import { getProvider } from '../../providers/index.ts';
import { recordAuditPass, type CreateAuditGapInput } from '../../repos/audits.ts';
import { listLayers } from '../../repos/layers.ts';
import { recordEvent } from '../../repos/events.ts';
import { recordAudit, type AuditOutcome } from '../auditEngine.ts';
import { buildAuditContext, unreadableArtifacts, type AuditContext } from './context.ts';
import { recordAuditEvidence } from './evidence.ts';
import {
  buildAdversarialPrompt,
  buildExtractionPrompt,
  buildJudgePrompt,
  buildPrimaryPrompt,
} from './prompts.ts';
import {
  parseAdversarialPass,
  parseJudgePass,
  parsePrimaryPass,
  type AdversarialPassOutput,
  type JudgePassOutput,
  type ParsedGap,
  type PrimaryPassOutput,
} from './schema.ts';

/** Default ceiling for a single provider call. A hung call is a failed audit. */
export const DEFAULT_PASS_TIMEOUT_MS = 180_000;

/**
 * An audit that could not be completed. The project is untouched: no verdict was
 * recorded, no state moved. The recorded passes explain why.
 */
export class AuditFailure extends Error {
  readonly passKey: AuditPassKey | 'CONTEXT';
  readonly pipelineId: string;
  readonly rawResponse: string | null;

  constructor(
    passKey: AuditPassKey | 'CONTEXT',
    pipelineId: string,
    message: string,
    rawResponse: string | null = null,
  ) {
    super(message);
    this.name = 'AuditFailure';
    this.passKey = passKey;
    this.pipelineId = pipelineId;
    this.rawResponse = rawResponse;
  }
}

export interface RunDynamicAuditInput {
  mode: AuditMode;
  layerId: string;
  documentId?: string | null;
  runId?: string | null;
  /** Injectable so tests can drive exact scenarios; defaults to the configured provider. */
  provider?: AIProvider;
  providerName?: string | null;
  model?: string | null;
  timeoutMs?: number;
  /** Called as each pass starts, so the UI can show "Pass 1/3". */
  onProgress?: (progress: AuditProgress) => void;
}

export interface AuditProgress {
  passKey: AuditPassKey;
  index: number;
  total: number;
  label: string;
}

export interface DynamicAuditOutcome extends AuditOutcome {
  pipelineId: string;
  passes: AuditPass[];
  judge: JudgePassOutput;
  primary: PrimaryPassOutput;
  adversarial: AdversarialPassOutput;
  /** Bounded research runs the audit says are justified. Not created automatically. */
  researchCandidates: ResearchCandidate[];
  context: AuditContext;
}

/** A research run the audit justifies. The user still approves it. */
export interface ResearchCandidate {
  layerId: string;
  layerName: string;
  title: string;
  researchQuestion: string;
  expectedContribution: string | null;
  classification: string;
}

const PASS_LABELS: Record<AuditPassKey, string> = {
  EXTRACTION: 'Reading the packet',
  PRIMARY: 'Primary audit',
  ADVERSARIAL: 'Adversarial critique',
  JUDGE: 'Final judge',
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PassRunResult {
  raw: string;
  durationMs: number;
}

/**
 * Run one pass and record it whatever happens. A failed pass is still evidence,
 * so it is written before the failure propagates.
 */
async function runPass(
  context: AuditContext,
  pipelineId: string,
  passKey: AuditPassKey,
  ordinal: number,
  prompt: string,
  provider: AIProvider,
  model: string | null,
  timeoutMs: number,
): Promise<PassRunResult> {
  const startedAt = Date.now();
  try {
    const response = await withTimeout(
      provider.audit({ prompt, model }),
      timeoutMs,
      PASS_LABELS[passKey],
    );
    const durationMs = Date.now() - startedAt;
    recordAuditPass({
      pipelineId,
      projectId: context.project.id,
      layerId: context.layer.id,
      passKey,
      ordinal,
      provider: provider.name,
      model,
      prompt,
      rawResponse: response.text,
      parsed: null,
      ok: true,
      durationMs,
    });
    return { raw: response.text, durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAuditPass({
      pipelineId,
      projectId: context.project.id,
      layerId: context.layer.id,
      passKey,
      ordinal,
      provider: provider.name,
      model,
      prompt,
      rawResponse: null,
      parsed: null,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    throw new AuditFailure(passKey, pipelineId, `${PASS_LABELS[passKey]} failed: ${message}`);
  }
}

/** Mark a recorded pass as parsed, or fail the audit with the raw text preserved. */
function parseOrFail<T>(
  context: AuditContext,
  pipelineId: string,
  passKey: AuditPassKey,
  raw: string,
  parse: (text: string) => { ok: true; value: T } | { ok: false; error: string },
): T {
  const parsed = parse(raw);
  if (!parsed.ok) {
    recordAuditPass({
      pipelineId,
      projectId: context.project.id,
      layerId: context.layer.id,
      passKey,
      ordinal: 90,
      prompt: `[validation of ${passKey}]`,
      rawResponse: raw,
      parsed: null,
      ok: false,
      error: parsed.error,
    });
    throw new AuditFailure(
      passKey,
      pipelineId,
      `${PASS_LABELS[passKey]} returned output the platform will not act on: ${parsed.error}`,
      raw,
    );
  }
  return parsed.value;
}

function toGapInputs(gaps: ParsedGap[], projectId: string): CreateAuditGapInput[] {
  const layers = listLayers(projectId);
  return gaps.map((gap) => {
    const owner = gap.owningLayerName
      ? layers.find((layer) => layer.name.toLowerCase() === gap.owningLayerName!.trim().toLowerCase())
      : undefined;
    return {
      classification: gap.classification,
      title: gap.title,
      detail: gap.detail,
      owningLayerId: owner?.id ?? null,
      owningLayerName: gap.owningLayerName,
      justification: gap.justification,
      researchQuestion: gap.researchQuestion,
      expectedContribution: gap.expectedContribution,
      sourcePass: 'JUDGE' as AuditPassKey,
    };
  });
}

/**
 * Bounded research the audit actually justifies. Only gaps the profile says may
 * keep a layer open become candidates, and each must carry its own question —
 * which is what stops an audit spawning a dozen speculative runs.
 */
function toResearchCandidates(judge: JudgePassOutput, context: AuditContext): ResearchCandidate[] {
  return judge.gapClassifications
    .filter(
      (gap) =>
        gap.classification === 'FOUNDATIONAL_GAP' || gap.classification === 'TARGETED_RESEARCH_GAP',
    )
    .filter((gap) => Boolean(gap.researchQuestion ?? gap.detail))
    .map((gap) => ({
      layerId: context.layer.id,
      layerName: context.layer.name,
      title: gap.title,
      researchQuestion: gap.researchQuestion ?? gap.detail,
      expectedContribution: gap.expectedContribution,
      classification: gap.classification,
    }));
}

/** Translate the judge's decision into the structured result the engine records. */
function toStructuredResult(judge: JudgePassOutput, primary: PrimaryPassOutput): StructuredAuditResult {
  const failures = [
    ...primary.requirementFindings,
    ...primary.structuralFindings,
    ...primary.consistencyFindings
      .filter((finding) => finding.relation === 'CONTRADICTION')
      .map((finding) => finding.detail),
  ];
  const requiredResearchRuns = judge.gapClassifications
    .filter(
      (gap) =>
        gap.classification === 'FOUNDATIONAL_GAP' || gap.classification === 'TARGETED_RESEARCH_GAP',
    )
    .map((gap) => gap.researchQuestion ?? gap.title);

  return {
    verdict: judge.verdict,
    summary: judge.summary,
    failures,
    missingDocuments: judge.blockingDependencies,
    requiredResearchRuns,
    requiredPatches: judge.requiredPatches,
    synthesisRequired: judge.synthesisReady,
    freezeEligible: judge.freezeReady,
    nextVersion: null,
    nextAction: judge.nextAction,
    confidence: judge.confidence,
  };
}

/**
 * The one-click audit. Builds context, runs the passes, validates the judge, and
 * only then records a verdict and lets the state engine move.
 */
export async function runDynamicAudit(input: RunDynamicAuditInput): Promise<DynamicAuditOutcome> {
  const pipelineId = `pipe_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const context = buildAuditContext({
    mode: input.mode,
    layerId: input.layerId,
    documentId: input.documentId ?? null,
    runId: input.runId ?? null,
  });

  if (context.artifacts.length === 0) {
    throw new AuditFailure(
      'CONTEXT',
      pipelineId,
      `${context.layer.name} has no completed research to audit.`,
    );
  }

  // Section 16: no readable content is BLOCKED, never a verdict. For a packet
  // (section 14) even ONE unreadable member blocks it — a layer verdict that
  // quietly skipped a document is exactly the false confidence this engine exists
  // to prevent.
  const unreadable = unreadableArtifacts(context);
  if (unreadable.length > 0) {
    const blocksEverything =
      input.mode === 'LAYER_PACKET' || unreadable.length === context.artifacts.length;
    if (blocksEverything) {
      const detail = unreadable
        .map((artifact) => `${artifact.canonicalName} (${artifact.unavailableReason})`)
        .join('; ');
      throw new AuditFailure(
        'CONTEXT',
        pipelineId,
        input.mode === 'LAYER_PACKET'
          ? `The ${context.layer.name} packet cannot be audited: ${unreadable.length} of ` +
            `${context.artifacts.length} document(s) could not be read — ${detail}. ` +
            'Reprocess or replace them, then audit the packet again.'
          : `The audit cannot read the artifact it was asked to judge: ${detail}`,
      );
    }
  }

  const provider = input.provider ?? getProvider(input.providerName);
  const model = input.model ?? null;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PASS_TIMEOUT_MS;
  const total = 3;

  input.onProgress?.({ passKey: 'PRIMARY', index: 1, total, label: PASS_LABELS.PRIMARY });
  const primaryRaw = await runPass(
    context,
    pipelineId,
    'PRIMARY',
    1,
    buildPrimaryPrompt(context),
    provider,
    model,
    timeoutMs,
  );
  const primary = parseOrFail(context, pipelineId, 'PRIMARY', primaryRaw.raw, parsePrimaryPass);

  input.onProgress?.({ passKey: 'ADVERSARIAL', index: 2, total, label: PASS_LABELS.ADVERSARIAL });
  const adversarialRaw = await runPass(
    context,
    pipelineId,
    'ADVERSARIAL',
    2,
    buildAdversarialPrompt(context, primaryRaw.raw),
    provider,
    model,
    timeoutMs,
  );
  const adversarial = parseOrFail(
    context,
    pipelineId,
    'ADVERSARIAL',
    adversarialRaw.raw,
    parseAdversarialPass,
  );

  input.onProgress?.({ passKey: 'JUDGE', index: 3, total, label: PASS_LABELS.JUDGE });
  const judgeRaw = await runPass(
    context,
    pipelineId,
    'JUDGE',
    3,
    buildJudgePrompt(context, primaryRaw.raw, adversarialRaw.raw),
    provider,
    model,
    timeoutMs,
  );
  const judge = parseOrFail(context, pipelineId, 'JUDGE', judgeRaw.raw, parseJudgePass);

  // Only now does anything change.
  const auditedDocumentIds = context.artifacts
    .map((artifact) => artifact.documentId)
    .filter((id): id is string => Boolean(id));

  const outcome = recordAudit({
    projectId: context.project.id,
    layerId: context.layer.id,
    runId: input.runId ?? context.run?.id ?? null,
    auditedDocumentId: input.mode === 'SINGLE_DOCUMENT' ? (auditedDocumentIds[0] ?? null) : null,
    result: toStructuredResult(judge, primary),
    source: `DYNAMIC_AUDIT:${provider.name}`,
    mode: input.mode,
    profileId: context.profile?.id ?? null,
    auditedDocumentIds,
    provider: provider.name,
    model,
    pipelineId,
    evidenceManifest: context.manifest,
    gaps: toGapInputs(judge.gapClassifications, context.project.id),
    extraFindings: [
      ...judge.otherLayerHandoffs.map((content) => ({
        findingType: 'OTHER_LAYER_HANDOFF' as const,
        content,
      })),
      ...adversarial.attacks.map((attack) => ({
        findingType: 'ADVERSARIAL_FINDING' as const,
        content: attack.attack,
        payload: { material: attack.material, reasoning: attack.reasoning },
      })),
    ],
  });

  // Attach the passages the verdict can be checked against. Annotation only:
  // it never changes the verdict, and a failure to find a passage is not a
  // failure of the audit.
  let citations = 0;
  try {
    citations = recordAuditEvidence({
      audit: outcome.audit,
      documentIds: auditedDocumentIds,
      verdictQuery: [judge.summary, judge.nextAction].join(' '),
    });
  } catch (error) {
    console.error('[brain] could not record audit evidence:', error);
  }

  recordEvent({
    projectId: context.project.id,
    layerId: context.layer.id,
    entityType: 'AUDIT',
    entityId: outcome.audit.id,
    eventType: 'AUDIT_COMPLETED',
    payload: {
      mode: input.mode,
      verdict: judge.verdict,
      provider: provider.name,
      foundationalGaps: judge.foundationalGapCount,
      targetedResearchRuns: judge.targetedResearchRunsRequired,
      pipelineId,
      citations,
    },
  });

  return {
    ...outcome,
    pipelineId,
    passes: [],
    judge,
    primary,
    adversarial,
    researchCandidates: toResearchCandidates(judge, context),
    context,
  };
}

export type { LayerStateSnapshot, Audit, ResearchRun };
