import { getDb } from '../db/database.ts';
import type {
  Audit,
  AuditFinding,
  AuditFindingRow,
  AuditFindingType,
  AuditGap,
  AuditGapRow,
  AuditMode,
  AuditPass,
  AuditPassKey,
  AuditPassRow,
  AuditRow,
  AuditVerdict,
  GapClassification,
  StructuredAuditResult,
} from '../domain/types.ts';
import { fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

function mapFinding(row: AuditFindingRow): AuditFinding {
  return {
    id: row.id,
    auditId: row.audit_id,
    findingType: row.finding_type as AuditFindingType,
    ordinal: Number(row.ordinal),
    content: row.content,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: row.created_at,
  };
}

function mapGap(row: AuditGapRow): AuditGap {
  return {
    id: row.id,
    auditId: row.audit_id,
    ordinal: Number(row.ordinal),
    classification: row.classification as GapClassification,
    title: row.title,
    detail: row.detail,
    owningLayerId: row.owning_layer_id,
    owningLayerName: row.owning_layer_name,
    justification: row.justification,
    researchQuestion: row.research_question,
    expectedContribution: row.expected_contribution,
    sourcePass: row.source_pass as AuditPassKey,
    createdAt: row.created_at,
  };
}

export function mapAuditPass(row: AuditPassRow): AuditPass {
  return {
    id: row.id,
    auditId: row.audit_id,
    pipelineId: row.pipeline_id,
    projectId: row.project_id,
    layerId: row.layer_id,
    passKey: row.pass_key as AuditPassKey,
    ordinal: Number(row.ordinal),
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    rawResponse: row.raw_response,
    parsed: parseJson<unknown>(row.parsed, null),
    ok: toBool(row.ok),
    error: row.error,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    createdAt: row.created_at,
  };
}

async function loadGaps(auditId: string): Promise<AuditGap[]> {
  return (await getDb().all<AuditGapRow>('SELECT * FROM audit_gaps WHERE audit_id = ? ORDER BY ordinal, rowid', [auditId]))
    .map(mapGap);
}

async function mapAudit(row: AuditRow, findings: AuditFinding[]): Promise<Audit> {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    runId: row.run_id,
    auditedDocumentId: row.audited_document_id,
    verdict: row.verdict as AuditVerdict,
    summary: row.summary,
    confidence: row.confidence === null ? null : Number(row.confidence),
    synthesisRequired: toBool(row.synthesis_required),
    freezeEligible: toBool(row.freeze_eligible),
    nextVersion: row.next_version,
    nextAction: row.next_action,
    source: row.source,
    raw: parseJson<Record<string, unknown>>(row.raw, {}),
    createdAt: row.created_at,
    findings,
    mode: (row.mode as AuditMode | undefined) ?? 'SINGLE_DOCUMENT',
    profileId: row.profile_id ?? null,
    foundationalGapCount: Number(row.foundational_gap_count ?? 0),
    targetedResearchRunsRequired: Number(row.targeted_research_runs_required ?? 0),
    auditedDocumentIds: parseJson<string[]>(row.audited_document_ids, []),
    provider: row.provider ?? null,
    model: row.model ?? null,
    gaps: await loadGaps(row.id),
    evidenceManifest: parseJson<Record<string, unknown>>(row.evidence_manifest, {}),
  };
}

async function loadFindings(auditId: string): Promise<AuditFinding[]> {
  return (await getDb().all<AuditFindingRow>(
      'SELECT * FROM audit_findings WHERE audit_id = ? ORDER BY finding_type, ordinal',
      [auditId],
    ))
    .map(mapFinding);
}

/** A classified issue, as the judge reported it. */
export interface CreateAuditGapInput {
  classification: GapClassification;
  title: string;
  detail?: string;
  owningLayerId?: string | null;
  owningLayerName?: string | null;
  justification?: string;
  researchQuestion?: string | null;
  expectedContribution?: string | null;
  sourcePass?: AuditPassKey;
}

export interface CreateAuditInput {
  projectId: string;
  layerId: string | null;
  runId?: string | null;
  auditedDocumentId?: string | null;
  result: StructuredAuditResult;
  source?: string;
  mode?: AuditMode;
  profileId?: string | null;
  auditedDocumentIds?: string[];
  provider?: string | null;
  model?: string | null;
  gaps?: CreateAuditGapInput[];
  /** Findings that are neither failures nor requirements: handoffs, attacks. */
  extraFindings?: { findingType: AuditFindingType; content: string; payload?: Record<string, unknown> }[];
  /** Pipeline whose recorded passes should be attached to this audit. */
  pipelineId?: string | null;
  evidenceManifest?: unknown;
}

/**
 * Persist an audit together with its structured children. Invariant 11: an
 * audit is never stored as prose alone.
 */
export async function createAudit(input: CreateAuditInput): Promise<Audit> {
  const db = getDb();
  const ts = nowIso();
  const id = newId('aud');
  const r = input.result;

  return await db.transaction(async () => {
    const gaps = input.gaps ?? [];
    const foundationalGapCount = gaps.filter((gap) => gap.classification === 'FOUNDATIONAL_GAP').length;
    const targetedResearchRuns = gaps.filter(
      (gap) => gap.classification === 'TARGETED_RESEARCH_GAP',
    ).length;

    await db.run(
      `INSERT INTO audits (id, project_id, layer_id, run_id, audited_document_id, verdict, summary,
         confidence, synthesis_required, freeze_eligible, next_version, next_action, source, raw, created_at,
         mode, profile_id, foundational_gap_count, targeted_research_runs_required,
         audited_document_ids, provider, model, evidence_manifest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.layerId, input.runId ?? null, input.auditedDocumentId ?? null,
        r.verdict, r.summary, r.confidence ?? null, fromBool(r.synthesisRequired),
        fromBool(r.freezeEligible), r.nextVersion ?? null, r.nextAction ?? null,
        input.source ?? 'MANUAL', toJson(r), ts,
        input.mode ?? 'SINGLE_DOCUMENT', input.profileId ?? null,
        foundationalGapCount, targetedResearchRuns,
        toJson(input.auditedDocumentIds ?? (input.auditedDocumentId ? [input.auditedDocumentId] : [])),
        input.provider ?? null, input.model ?? null, toJson(input.evidenceManifest ?? {})],
    );

    gaps.forEach(async (gap, ordinal) => {
      await db.run(
        `INSERT INTO audit_gaps (id, audit_id, ordinal, classification, title, detail,
           owning_layer_id, owning_layer_name, justification, research_question,
           expected_contribution, source_pass, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('gap'), id, ordinal, gap.classification, gap.title, gap.detail ?? '',
          gap.owningLayerId ?? null, gap.owningLayerName ?? null, gap.justification ?? '',
          gap.researchQuestion ?? null, gap.expectedContribution ?? null,
          gap.sourcePass ?? 'JUDGE', ts],
      );
    });

    // Passes are written before the verdict exists, so they are adopted here.
    if (input.pipelineId) {
      await db.run('UPDATE audit_passes SET audit_id = ? WHERE pipeline_id = ?', [id, input.pipelineId]);
    }

    const groups: [AuditFindingType, string[]][] = [
      ['FAILURE', r.failures ?? []],
      ['MISSING_DOCUMENT', r.missingDocuments ?? []],
      ['REQUIRED_RESEARCH_RUN', r.requiredResearchRuns ?? []],
      ['REQUIRED_PATCH', r.requiredPatches ?? []],
      ['NEXT_ACTION', r.nextAction ? [r.nextAction] : []],
    ];
    for (const extra of input.extraFindings ?? []) {
      await db.run(
        `INSERT INTO audit_findings (id, audit_id, finding_type, ordinal, content, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId('afd'), id, extra.findingType, 0, extra.content, toJson(extra.payload ?? {}), ts],
      );
    }

    for (const [findingType, items] of groups) {
      items.forEach(async (content, ordinal) => {
        await db.run(
          `INSERT INTO audit_findings (id, audit_id, finding_type, ordinal, content, payload, created_at)
           VALUES (?, ?, ?, ?, ?, '{}', ?)`,
          [newId('afd'), id, findingType, ordinal, content, ts],
        );
      });
    }
    return (await getAudit(id))!;
  });
}

export async function getAudit(id: string): Promise<Audit | null> {
  const row = await getDb().get<AuditRow>('SELECT * FROM audits WHERE id = ?', [id]);
  return row ? await mapAudit(row, await loadFindings(id)) : null;
}

export async function listAuditsByLayer(layerId: string): Promise<Audit[]> {
  const rows = await getDb().all<AuditRow>(
    'SELECT * FROM audits WHERE layer_id = ? ORDER BY created_at DESC',
    [layerId],
  );
  return await Promise.all(rows.map(async (row) => mapAudit(row, await loadFindings(row.id))));
}

export async function listAuditsByProject(projectId: string): Promise<Audit[]> {
  const rows = await getDb().all<AuditRow>(
    'SELECT * FROM audits WHERE project_id = ? ORDER BY created_at DESC',
    [projectId],
  );
  return await Promise.all(rows.map(async (row) => mapAudit(row, await loadFindings(row.id))));
}

export async function getLatestAuditForLayer(layerId: string): Promise<Audit | null> {
  const row = await getDb().get<AuditRow>(
    'SELECT * FROM audits WHERE layer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [layerId],
  );
  return row ? await mapAudit(row, await loadFindings(row.id)) : null;
}

export async function getLatestAuditForDocument(documentId: string): Promise<Audit | null> {
  const row = await getDb().get<AuditRow>(
    'SELECT * FROM audits WHERE audited_document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [documentId],
  );
  return row ? await mapAudit(row, await loadFindings(row.id)) : null;
}

export async function getLatestAuditForRun(runId: string): Promise<Audit | null> {
  const row = await getDb().get<AuditRow>(
    'SELECT * FROM audits WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [runId],
  );
  return row ? await mapAudit(row, await loadFindings(row.id)) : null;
}

// ---------------------------------------------------------------------------
// Audit passes
// ---------------------------------------------------------------------------

export interface RecordAuditPassInput {
  pipelineId: string;
  projectId: string;
  layerId: string | null;
  passKey: AuditPassKey;
  ordinal: number;
  provider?: string | null;
  model?: string | null;
  prompt: string;
  rawResponse?: string | null;
  parsed?: unknown;
  ok: boolean;
  error?: string | null;
  durationMs?: number | null;
}

/**
 * Every model call is recorded, including the ones that failed. A verdict that
 * cannot be traced back to what the model actually said is not auditable, and a
 * failed audit still has to leave evidence of why it failed.
 */
export async function recordAuditPass(input: RecordAuditPassInput): Promise<AuditPass> {
  const id = newId('aps');
  await getDb().run(
    `INSERT INTO audit_passes (id, audit_id, pipeline_id, project_id, layer_id, pass_key, ordinal,
       provider, model, prompt, raw_response, parsed, ok, error, duration_ms, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.pipelineId, input.projectId, input.layerId, input.passKey, input.ordinal,
      input.provider ?? null, input.model ?? null, input.prompt, input.rawResponse ?? null,
      toJson(input.parsed ?? null), fromBool(input.ok), input.error ?? null,
      input.durationMs ?? null, nowIso()],
  );
  return (await getDb().all<AuditPassRow>('SELECT * FROM audit_passes WHERE id = ?', [id]))
    .map(mapAuditPass)[0]!;
}

export async function listAuditPasses(auditId: string): Promise<AuditPass[]> {
  return (await getDb().all<AuditPassRow>('SELECT * FROM audit_passes WHERE audit_id = ? ORDER BY ordinal, rowid', [
      auditId,
    ]))
    .map(mapAuditPass);
}

export async function listPipelinePasses(pipelineId: string): Promise<AuditPass[]> {
  return (await getDb().all<AuditPassRow>('SELECT * FROM audit_passes WHERE pipeline_id = ? ORDER BY ordinal, rowid', [
      pipelineId,
    ]))
    .map(mapAuditPass);
}

/** Gaps across a layer's audit history, newest audit first. */
export async function listGapsByLayer(layerId: string, limit = 200): Promise<AuditGap[]> {
  return (await getDb().all<AuditGapRow>(
      `SELECT g.* FROM audit_gaps g
       JOIN audits a ON a.id = g.audit_id
       WHERE a.layer_id = ?
       ORDER BY a.created_at DESC, g.ordinal
       LIMIT ?`,
      [layerId, limit],
    ))
    .map(mapGap);
}
