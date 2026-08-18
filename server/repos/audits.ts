import { getDb } from '../db/database.ts';
import type {
  Audit,
  AuditFinding,
  AuditFindingRow,
  AuditFindingType,
  AuditRow,
  AuditVerdict,
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

function mapAudit(row: AuditRow, findings: AuditFinding[]): Audit {
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
  };
}

function loadFindings(auditId: string): AuditFinding[] {
  return getDb()
    .all<AuditFindingRow>(
      'SELECT * FROM audit_findings WHERE audit_id = ? ORDER BY finding_type, ordinal',
      [auditId],
    )
    .map(mapFinding);
}

export interface CreateAuditInput {
  projectId: string;
  layerId: string | null;
  runId?: string | null;
  auditedDocumentId?: string | null;
  result: StructuredAuditResult;
  source?: string;
}

/**
 * Persist an audit together with its structured children. Invariant 11: an
 * audit is never stored as prose alone.
 */
export function createAudit(input: CreateAuditInput): Audit {
  const db = getDb();
  const ts = nowIso();
  const id = newId('aud');
  const r = input.result;

  return db.transaction(() => {
    db.run(
      `INSERT INTO audits (id, project_id, layer_id, run_id, audited_document_id, verdict, summary,
         confidence, synthesis_required, freeze_eligible, next_version, next_action, source, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.layerId, input.runId ?? null, input.auditedDocumentId ?? null,
        r.verdict, r.summary, r.confidence ?? null, fromBool(r.synthesisRequired),
        fromBool(r.freezeEligible), r.nextVersion ?? null, r.nextAction ?? null,
        input.source ?? 'MANUAL', toJson(r), ts],
    );

    const groups: [AuditFindingType, string[]][] = [
      ['FAILURE', r.failures ?? []],
      ['MISSING_DOCUMENT', r.missingDocuments ?? []],
      ['REQUIRED_RESEARCH_RUN', r.requiredResearchRuns ?? []],
      ['REQUIRED_PATCH', r.requiredPatches ?? []],
      ['NEXT_ACTION', r.nextAction ? [r.nextAction] : []],
    ];
    for (const [findingType, items] of groups) {
      items.forEach((content, ordinal) => {
        db.run(
          `INSERT INTO audit_findings (id, audit_id, finding_type, ordinal, content, payload, created_at)
           VALUES (?, ?, ?, ?, ?, '{}', ?)`,
          [newId('afd'), id, findingType, ordinal, content, ts],
        );
      });
    }
    return getAudit(id)!;
  });
}

export function getAudit(id: string): Audit | null {
  const row = getDb().get<AuditRow>('SELECT * FROM audits WHERE id = ?', [id]);
  return row ? mapAudit(row, loadFindings(id)) : null;
}

export function listAuditsByLayer(layerId: string): Audit[] {
  return getDb()
    .all<AuditRow>('SELECT * FROM audits WHERE layer_id = ? ORDER BY created_at DESC', [layerId])
    .map((row) => mapAudit(row, loadFindings(row.id)));
}

export function listAuditsByProject(projectId: string): Audit[] {
  return getDb()
    .all<AuditRow>('SELECT * FROM audits WHERE project_id = ? ORDER BY created_at DESC', [projectId])
    .map((row) => mapAudit(row, loadFindings(row.id)));
}

export function getLatestAuditForLayer(layerId: string): Audit | null {
  const row = getDb().get<AuditRow>(
    'SELECT * FROM audits WHERE layer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [layerId],
  );
  return row ? mapAudit(row, loadFindings(row.id)) : null;
}

export function getLatestAuditForDocument(documentId: string): Audit | null {
  const row = getDb().get<AuditRow>(
    'SELECT * FROM audits WHERE audited_document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [documentId],
  );
  return row ? mapAudit(row, loadFindings(row.id)) : null;
}

export function getLatestAuditForRun(runId: string): Audit | null {
  const row = getDb().get<AuditRow>(
    'SELECT * FROM audits WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [runId],
  );
  return row ? mapAudit(row, loadFindings(row.id)) : null;
}
