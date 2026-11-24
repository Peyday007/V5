/**
 * The rows behind commercial knowledge (§121). Facts are append-only: a
 * changed figure is a new row naming the one it supersedes, and the old row
 * stays as history (invariant 17). Acquisitions and applications are
 * append-only. A source's retry position is guarded by its attempt count in
 * the statement that moves it, so two passes never both apply one read.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  KnowledgeAcquisitionRow,
  KnowledgeApplicationRow,
  KnowledgeContradictionRow,
  KnowledgeFactRow,
  KnowledgeIndustryRow,
  KnowledgeLinkRow,
  KnowledgeSourceRow,
} from '../domain/types.ts';

/* ------------------------------------------------------------------ sources */

export interface SourceDefinition {
  sourceKey: string;
  family: string;
  title: string;
  publisher: string;
  url: string;
  period: string;
  format: string;
  origin: 'CATALOG' | 'DISCOVERED';
  discoveredFrom: string | null;
  valueReason: string;
  status?: 'ACTIVE' | 'CANDIDATE';
}

/** Register a dataset once; an existing row is left exactly as it is. Returns whether it was new. */
export async function registerSource(def: SourceDefinition, now = nowIso()): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO knowledge_sources
       (id, source_key, family, title, publisher, url, period, format, origin, discovered_from, value_reason, status,
        attempts, consecutive_failures, next_due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [newId('ksr'), def.sourceKey, def.family, def.title, def.publisher, def.url, def.period, def.format, def.origin, def.discoveredFrom, def.valueReason, def.status ?? 'ACTIVE', now, now, now],
  );
  return (result.changes ?? 0) > 0;
}

export async function listSources(): Promise<KnowledgeSourceRow[]> {
  return getDb().all<KnowledgeSourceRow>('SELECT * FROM knowledge_sources ORDER BY family ASC, period DESC, source_key ASC');
}

export async function getSource(id: string): Promise<KnowledgeSourceRow | undefined> {
  return getDb().get<KnowledgeSourceRow>('SELECT * FROM knowledge_sources WHERE id = ?', [id]);
}

/** Sources due for a read: active or failing, due now, oldest due first. */
export async function listDueSources(now: string, limit: number): Promise<KnowledgeSourceRow[]> {
  return getDb().all<KnowledgeSourceRow>(
    `SELECT * FROM knowledge_sources WHERE status IN ('ACTIVE', 'FAILING') AND next_due_at <= ? ORDER BY next_due_at ASC, source_key ASC LIMIT ?`,
    [now, limit],
  );
}

/** An older vintage another one replaced. Its facts stay; it is simply not read again. */
export async function supersedeSourcesOf(family: string, keepKey: string, now = nowIso()): Promise<number> {
  const result = await getDb().run(
    `UPDATE knowledge_sources SET status = 'SUPERSEDED', updated_at = ? WHERE family = ? AND source_key <> ? AND status IN ('ACTIVE', 'FAILING')`,
    [now, family, keepKey],
  );
  return result.changes ?? 0;
}

/**
 * Apply one read's outcome to the source's position, only if nobody applied
 * another since it was read (the attempt count it started from). Returns
 * whether this read's outcome landed.
 */
export async function recordSourceRead(input: {
  source: Pick<KnowledgeSourceRow, 'id' | 'attempts' | 'consecutive_failures'>;
  ok: boolean;
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
  error?: string | null;
  nextDueAt: string;
  now?: string;
}): Promise<boolean> {
  const now = input.now ?? nowIso();
  const result = input.ok
    ? await getDb().run(
        `UPDATE knowledge_sources
            SET status = 'ACTIVE', etag = ?, last_modified = ?, content_hash = COALESCE(?, content_hash), attempts = attempts + 1,
                consecutive_failures = 0, last_error = NULL, last_attempt_at = ?, last_success_at = ?, next_due_at = ?, updated_at = ?
          WHERE id = ? AND attempts = ?`,
        [input.etag ?? null, input.lastModified ?? null, input.contentHash ?? null, now, now, input.nextDueAt, now, input.source.id, input.source.attempts],
      )
    : await getDb().run(
        `UPDATE knowledge_sources
            SET status = 'FAILING', attempts = attempts + 1, consecutive_failures = consecutive_failures + 1, last_error = ?,
                last_attempt_at = ?, next_due_at = ?, updated_at = ?
          WHERE id = ? AND attempts = ?`,
        [(input.error ?? 'unknown failure').slice(0, 500), now, input.nextDueAt, now, input.source.id, input.source.attempts],
      );
  return (result.changes ?? 0) > 0;
}

export async function recordAcquisition(row: Omit<KnowledgeAcquisitionRow, 'id'>): Promise<string> {
  const id = newId('kaq');
  await getDb().run(
    `INSERT INTO knowledge_acquisitions (id, source_id, started_at, finished_at, outcome, http_status, content_hash, bytes, rows_read, facts_written, facts_unchanged, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, row.source_id, row.started_at, row.finished_at, row.outcome, row.http_status, row.content_hash, row.bytes, row.rows_read, row.facts_written, row.facts_unchanged, row.error],
  );
  return id;
}

export async function listRecentAcquisitions(limit = 30): Promise<(KnowledgeAcquisitionRow & { source_key: string; title: string })[]> {
  return getDb().all(
    `SELECT a.*, s.source_key, s.title FROM knowledge_acquisitions a JOIN knowledge_sources s ON s.id = a.source_id
      ORDER BY a.started_at DESC, a.id DESC LIMIT ?`,
    [limit],
  );
}

/* -------------------------------------------------------------------- facts */

export type NewFact = Omit<KnowledgeFactRow, 'id' | 'created_at' | 'supersedes_id'>;

const FACT_COLUMNS =
  'id, subject_key, metric, value, unit, metric_class, epistemic, naics, naics_level, industry_label, geo_code, geo_label, size_class, period, basis, inputs, source_id, acquisition_id, source_title, source_url, quality, observed_at, valid_until, supersedes_id, created_at';
const FACT_WIDTH = 25;

/** A fact is current unless another row supersedes it. */
const CURRENT = 'NOT EXISTS (SELECT 1 FROM knowledge_facts s WHERE s.supersedes_id = f.id)';

/** The current value of every subject key in a set, read in bounded batches. */
export async function currentFactsByKey(keys: readonly string[]): Promise<Map<string, { id: string; value: number }>> {
  const out = new Map<string, { id: string; value: number }>();
  for (let i = 0; i < keys.length; i += 500) {
    const batch = keys.slice(i, i + 500);
    const rows = await getDb().all<{ id: string; subject_key: string; value: number }>(
      `SELECT f.id, f.subject_key, f.value FROM knowledge_facts f WHERE f.subject_key IN (${batch.map(() => '?').join(',')}) AND ${CURRENT}`,
      batch,
    );
    for (const row of rows) out.set(row.subject_key, { id: row.id, value: Number(row.value) });
  }
  return out;
}

/**
 * Write a batch of facts: a subject never seen is an original; a subject
 * whose current value differs is a new row superseding it; an unchanged value
 * writes nothing. Idempotent: replaying the same batch writes nothing.
 */
export async function writeFacts(facts: readonly NewFact[], now = nowIso()): Promise<{ written: number; superseded: number; unchanged: number; ids: Map<string, string> }> {
  const current = await currentFactsByKey(facts.map((f) => f.subject_key));
  const rows: KnowledgeFactRow[] = [];
  const ids = new Map<string, string>();
  let unchanged = 0;
  let superseded = 0;
  const seen = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.subject_key)) continue;
    seen.add(fact.subject_key);
    const prior = current.get(fact.subject_key);
    if (prior && Math.abs(prior.value - fact.value) <= Math.abs(prior.value) * 1e-9) {
      unchanged++;
      ids.set(fact.subject_key, prior.id);
      continue;
    }
    const id = newId('kfa');
    ids.set(fact.subject_key, id);
    if (prior) superseded++;
    rows.push({ ...fact, id, created_at: now, supersedes_id: prior?.id ?? null });
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const batch = rows.slice(i, i + 400);
    const params = batch.flatMap((r) => [
      r.id, r.subject_key, r.metric, r.value, r.unit, r.metric_class, r.epistemic, r.naics, r.naics_level, r.industry_label, r.geo_code, r.geo_label, r.size_class,
      r.period, r.basis, r.inputs, r.source_id, r.acquisition_id, r.source_title, r.source_url, r.quality, r.observed_at, r.valid_until, r.supersedes_id, r.created_at,
    ]);
    const placeholders = batch.map(() => `(${new Array(FACT_WIDTH).fill('?').join(',')})`).join(',');
    const result = await getDb().run(`INSERT INTO knowledge_facts (${FACT_COLUMNS}) VALUES ${placeholders} ON CONFLICT DO NOTHING`, params);
    written += result.changes ?? 0;
  }
  return { written, superseded, unchanged, ids };
}

/** Current facts for these industries in one geography (and the nation), any metric. */
export async function currentFactsFor(naics: readonly string[], geoCodes: readonly string[] = ['US']): Promise<KnowledgeFactRow[]> {
  if (naics.length === 0) return [];
  return getDb().all<KnowledgeFactRow>(
    `SELECT f.* FROM knowledge_facts f
      WHERE f.naics IN (${naics.map(() => '?').join(',')}) AND f.geo_code IN (${geoCodes.map(() => '?').join(',')}) AND ${CURRENT}
      ORDER BY f.naics ASC, f.metric ASC, f.period DESC`,
    [...naics, ...geoCodes],
  );
}

/** Every current published fact for the nation, for the derivation pass. */
export async function currentNationalFacts(): Promise<KnowledgeFactRow[]> {
  return getDb().all<KnowledgeFactRow>(`SELECT f.* FROM knowledge_facts f WHERE f.geo_code = 'US' AND f.epistemic = 'FACT' AND ${CURRENT}`);
}

/** The industry titles the datasets themselves printed, one per code (newest label wins). */
export async function industryTitles(): Promise<{ naics: string; label: string }[]> {
  return getDb().all<{ naics: string; label: string }>(
    `SELECT naics, label FROM knowledge_industries ORDER BY naics ASC`,
  );
}

export async function getFact(id: string): Promise<KnowledgeFactRow | undefined> {
  return getDb().get<KnowledgeFactRow>('SELECT * FROM knowledge_facts WHERE id = ?', [id]);
}

export async function factCounts(): Promise<{ epistemic: string; metric_class: string; n: number }[]> {
  const rows = await getDb().all<{ epistemic: string; metric_class: string; n: number | string }>(
    `SELECT f.epistemic, f.metric_class, COUNT(*) AS n FROM knowledge_facts f WHERE ${CURRENT} GROUP BY f.epistemic, f.metric_class`,
  );
  return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

export async function recentFacts(sinceIso: string, limit = 25): Promise<KnowledgeFactRow[]> {
  return getDb().all<KnowledgeFactRow>(
    `SELECT f.* FROM knowledge_facts f WHERE f.created_at >= ? AND f.epistemic <> 'FACT' ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    [sinceIso, limit],
  );
}

export async function factsAddedSince(sinceIso: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM knowledge_facts WHERE created_at >= ?', [sinceIso]);
  return Number(row?.n ?? 0);
}

/** Facts whose validity has run out and whose source has not been re-read since: what is stale. */
export async function staleFactCount(now: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM knowledge_facts f WHERE f.valid_until < ? AND ${CURRENT}`, [now]);
  return Number(row?.n ?? 0);
}

/* --------------------------------------------------------------- industries */

/** Record an industry's title and deterministic reading; a MODEL reading already held is never overwritten by it. */
export async function upsertIndustries(
  rows: readonly { naics: string; label: string; level: number; sector: string; activity: string; customer: string; mechanisms: string }[],
  now = nowIso(),
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 300) {
    const batch = rows.slice(i, i + 300);
    const params = batch.flatMap((r) => [r.naics, r.label, r.level, r.sector, r.activity, r.customer, r.mechanisms, 'DETERMINISTIC', now, now]);
    const result = await getDb().run(
      `INSERT INTO knowledge_industries (naics, label, naics_level, sector, activity, customer_category, mechanisms, classified_by, created_at, updated_at)
       VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}
       ON CONFLICT (naics) DO NOTHING`,
      params,
    );
    n += result.changes ?? 0;
  }
  return n;
}

export async function getIndustry(naics: string): Promise<KnowledgeIndustryRow | undefined> {
  return getDb().get<KnowledgeIndustryRow>('SELECT * FROM knowledge_industries WHERE naics = ?', [naics]);
}

export async function listIndustries(naics: readonly string[]): Promise<KnowledgeIndustryRow[]> {
  if (naics.length === 0) return [];
  return getDb().all<KnowledgeIndustryRow>(`SELECT * FROM knowledge_industries WHERE naics IN (${naics.map(() => '?').join(',')})`, [...naics]);
}

/** Record the GPU's reading of an industry. Only an unread industry, or one read before `staleBefore`, is written. */
export async function recordInterpretation(input: {
  naics: string;
  customer: string;
  mechanisms: string;
  interpretation: string;
  principles: string;
  requirements: string;
  unknowns: string;
  model: string;
  servedBy: string;
  staleBefore: string;
  now?: string;
}): Promise<boolean> {
  const now = input.now ?? nowIso();
  const result = await getDb().run(
    `UPDATE knowledge_industries
        SET customer_category = ?, mechanisms = ?, classified_by = 'MODEL', interpretation = ?, principles = ?, requirements = ?, unknowns = ?,
            interpreted_model = ?, interpreted_served_by = ?, interpreted_at = ?, updated_at = ?
      WHERE naics = ? AND (interpreted_at IS NULL OR interpreted_at < ?)`,
    [input.customer, input.mechanisms, input.interpretation, input.principles, input.requirements, input.unknowns, input.model, input.servedBy, now, now, input.naics, input.staleBefore],
  );
  return (result.changes ?? 0) > 0;
}

export async function industryCounts(): Promise<{ total: number; interpreted: number; byCustomer: Record<string, number> }> {
  const rows = await getDb().all<{ customer_category: string; interpreted: number | string; n: number | string }>(
    `SELECT customer_category, CASE WHEN interpreted_at IS NULL THEN 0 ELSE 1 END AS interpreted, COUNT(*) AS n FROM knowledge_industries GROUP BY customer_category, CASE WHEN interpreted_at IS NULL THEN 0 ELSE 1 END`,
  );
  const byCustomer: Record<string, number> = {};
  let total = 0;
  let interpreted = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (Number(r.interpreted) === 1) interpreted += n;
    byCustomer[r.customer_category] = (byCustomer[r.customer_category] ?? 0) + n;
  }
  return { total, interpreted, byCustomer };
}

export async function recentlyInterpreted(limit = 12): Promise<KnowledgeIndustryRow[]> {
  return getDb().all<KnowledgeIndustryRow>('SELECT * FROM knowledge_industries WHERE interpreted_at IS NOT NULL ORDER BY interpreted_at DESC LIMIT ?', [limit]);
}

/* -------------------------------------------------------------------- links */

export async function getLink(projectId: string, nodeId: string): Promise<KnowledgeLinkRow | undefined> {
  return getDb().get<KnowledgeLinkRow>('SELECT * FROM knowledge_links WHERE project_id = ? AND node_id = ?', [projectId, nodeId]);
}

export async function listLinks(projectId?: string): Promise<KnowledgeLinkRow[]> {
  return projectId
    ? getDb().all<KnowledgeLinkRow>('SELECT * FROM knowledge_links WHERE project_id = ? ORDER BY created_at DESC', [projectId])
    : getDb().all<KnowledgeLinkRow>('SELECT * FROM knowledge_links ORDER BY created_at DESC LIMIT 500');
}

/** A node's classification, once. A later, better reading is a person's or a re-derivation's job, not an overwrite. */
export async function insertLink(row: Omit<KnowledgeLinkRow, 'id' | 'created_at'>, now = nowIso()): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO knowledge_links (id, project_id, node_id, node_name, naics, method, score, size_class, geo_code, rationale, served_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('kln'), row.project_id, row.node_id, row.node_name, row.naics, row.method, row.score, row.size_class, row.geo_code, row.rationale, row.served_by, now],
  );
  return (result.changes ?? 0) > 0;
}

/** A link that matched nothing may be retried by the model once the lane can take it. */
export async function upgradeUnmatchedLink(projectId: string, nodeId: string, row: Pick<KnowledgeLinkRow, 'naics' | 'method' | 'score' | 'rationale' | 'served_by'>): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE knowledge_links SET naics = ?, method = ?, score = ?, rationale = ?, served_by = ? WHERE project_id = ? AND node_id = ? AND method = 'NONE'`,
    [row.naics, row.method, row.score, row.rationale, row.served_by, projectId, nodeId],
  );
  return (result.changes ?? 0) > 0;
}

/* ----------------------------------------------------------- contradictions */

export async function recordContradiction(row: Omit<KnowledgeContradictionRow, 'id' | 'created_at'>, now = nowIso()): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO knowledge_contradictions (id, subject, fact_a_ref, fact_b_ref, a_value, b_value, relative_gap, resolution, reason, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('kcn'), row.subject, row.fact_a_ref, row.fact_b_ref, row.a_value, row.b_value, row.relative_gap, row.resolution, row.reason, row.project_id, now],
  );
  return (result.changes ?? 0) > 0;
}

export async function contradictionCounts(): Promise<Record<string, number>> {
  const rows = await getDb().all<{ resolution: string; n: number | string }>('SELECT resolution, COUNT(*) AS n FROM knowledge_contradictions GROUP BY resolution');
  return Object.fromEntries(rows.map((r) => [r.resolution, Number(r.n)]));
}

export async function recentContradictions(limit = 10): Promise<KnowledgeContradictionRow[]> {
  return getDb().all<KnowledgeContradictionRow>(`SELECT * FROM knowledge_contradictions WHERE resolution <> 'RECONCILED' ORDER BY created_at DESC LIMIT ?`, [limit]);
}

/* ------------------------------------------------------------- applications */

export async function recordApplication(row: Omit<KnowledgeApplicationRow, 'id' | 'created_at'>, now = nowIso()): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO knowledge_applications (id, kind, project_id, node_id, knowledge_fact_id, target_ref, detail, before_text, after_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('kap'), row.kind, row.project_id, row.node_id, row.knowledge_fact_id, row.target_ref, row.detail, row.before_text, row.after_text, now],
  );
  return (result.changes ?? 0) > 0;
}

export async function listApplications(limit = 40, projectId?: string): Promise<KnowledgeApplicationRow[]> {
  return projectId
    ? getDb().all<KnowledgeApplicationRow>('SELECT * FROM knowledge_applications WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [projectId, limit])
    : getDb().all<KnowledgeApplicationRow>('SELECT * FROM knowledge_applications ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
}

export async function applicationCounts(): Promise<Record<string, number>> {
  const rows = await getDb().all<{ kind: string; n: number | string }>('SELECT kind, COUNT(*) AS n FROM knowledge_applications GROUP BY kind');
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}
