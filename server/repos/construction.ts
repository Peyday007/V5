/**
 * Facts an industry construction is priced from (§92). Append-only: there is
 * no update and no delete, because a fact that replaced another is resolved at
 * read time and the one it replaced stays history (invariant 17).
 *
 * Two writers. A person records a fact against one goal
 * (`recordConstructionFact`); the industry kernel files a gated research claim
 * that states an amount as a project-level fact (`recordClaimFact`, W-5),
 * carrying the claim as its lineage and the map subject it was asked under.
 * Every fact is dated (W-10): when it was observed, and when it stops being
 * current — the key's freshness class unless the fact declares its own.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { isFactKey, validUntilFor, type Fact, type FactKey, type FactSource, type FactStatus } from '../domain/construction.ts';
import type { ConstructionFactRow } from '../domain/types.ts';

export interface RecordedFact extends Fact {
  id: string;
  /** Null for a project-level fact absorbed from research. */
  workstreamId: string | null;
  projectId: string | null;
  sourceClaimId: string | null;
  /** The fact this one supersedes, or null for an original (migration 158). */
  supersedesFactId: string | null;
  recordedBy: string;
  createdAt: string;
}

function sourceKindOf(row: ConstructionFactRow): FactSource['kind'] {
  const k = row.source_kind;
  if (k === 'PRIMARY' || k === 'SECONDARY' || k === 'OPERATOR' || k === 'OUTCOME') return k;
  return row.status === 'OBSERVED' ? 'OUTCOME' : 'OPERATOR';
}

export function mapConstructionFact(row: ConstructionFactRow): RecordedFact | null {
  if (!isFactKey(row.fact_key)) return null;
  return {
    id: row.id,
    workstreamId: row.workstream_id,
    projectId: row.project_id,
    sourceClaimId: row.source_claim_id ?? null,
    supersedesFactId: row.supersedes_fact_id ?? null,
    key: row.fact_key,
    segment: row.segment,
    low: Number(row.low),
    high: Number(row.high),
    status: row.status as FactStatus,
    measures: row.measures,
    source: { title: row.source_title, url: row.source_url, kind: sourceKindOf(row), claimId: row.source_claim_id ?? null },
    geography: null,
    observedAt: row.observed_at ?? row.created_at,
    validUntil: row.valid_until ?? null,
    roleId: row.role_id ?? null,
    occupant: row.occupant ?? null,
    nodeId: row.node_id ?? null,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  };
}

async function insert(row: ConstructionFactRow): Promise<void> {
  await getDb().run(
    `INSERT INTO construction_facts
       (id, project_id, workstream_id, fact_key, segment, low, high, status, measures, source_title, source_url, recorded_by, created_at,
        node_id, source_claim_id, source_kind, role_id, occupant, observed_at, valid_until, supersedes_fact_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      row.id, row.project_id, row.workstream_id, row.fact_key, row.segment, row.low, row.high, row.status, row.measures, row.source_title, row.source_url, row.recorded_by, row.created_at,
      row.node_id, row.source_claim_id, row.source_kind, row.role_id, row.occupant, row.observed_at, row.valid_until, row.supersedes_fact_id ?? null,
    ],
  );
}

export async function recordConstructionFact(input: {
  projectId: string | null;
  workstreamId: string;
  fact: Omit<Fact, 'source' | 'geography'> & { sourceTitle: string; sourceUrl: string | null };
  recordedBy: string;
}): Promise<RecordedFact> {
  const at = nowIso();
  const observedAt = input.fact.observedAt ?? at;
  const row: ConstructionFactRow = {
    id: newId('cfa'),
    project_id: input.projectId,
    workstream_id: input.workstreamId,
    fact_key: input.fact.key,
    segment: input.fact.segment,
    low: Math.min(input.fact.low, input.fact.high),
    high: Math.max(input.fact.low, input.fact.high),
    status: input.fact.status,
    measures: input.fact.measures,
    source_title: input.fact.sourceTitle,
    source_url: input.fact.sourceUrl,
    recorded_by: input.recordedBy,
    created_at: at,
    node_id: null,
    source_claim_id: null,
    source_kind: input.fact.status === 'OBSERVED' ? 'OUTCOME' : 'OPERATOR',
    role_id: input.fact.roleId ?? null,
    occupant: input.fact.occupant ?? null,
    observed_at: observedAt,
    valid_until: input.fact.validUntil ?? validUntilFor(input.fact.key, observedAt),
  };
  await insert(row);
  return mapConstructionFact(row)!;
}

/**
 * File one research claim as a project-level fact (W-5). Idempotent by claim:
 * the claim id is unique, so a pass that files the same claim again writes
 * nothing and returns null. The status is decided by the caller from the
 * claim — never VERIFIED, which only a person attests.
 *
 * With `supersedesFactId` the fact is a re-derivation of that claim's current
 * fact (migration 158): a NEW row naming the fact it replaces, which stays
 * untouched as history. Idempotent by the superseded fact: a fact is
 * superseded at most once, so a replay writes nothing and returns null, and a
 * fact that is no longer current (or is not this claim's) is never superseded.
 */
export async function recordClaimFact(input: {
  projectId: string;
  nodeId: string | null;
  claimId: string;
  key: FactKey;
  segment: string | null;
  low: number;
  high: number;
  status: Exclude<FactStatus, 'VERIFIED'>;
  measures: string;
  sourceTitle: string;
  sourceUrl: string | null;
  sourceKind: 'PRIMARY' | 'SECONDARY';
  roleId?: string | null;
  occupant?: string | null;
  observedAt: string;
  validUntil?: string | null;
  supersedesFactId?: string | null;
}): Promise<RecordedFact | null> {
  const supersedes = input.supersedesFactId ?? null;
  const row: ConstructionFactRow = {
    id: newId('cfa'),
    project_id: input.projectId,
    workstream_id: null,
    fact_key: input.key,
    segment: input.segment,
    low: Math.min(input.low, input.high),
    high: Math.max(input.low, input.high),
    status: input.status,
    measures: input.measures,
    source_title: input.sourceTitle,
    source_url: input.sourceUrl,
    recorded_by: 'BRAIN',
    created_at: nowIso(),
    node_id: input.nodeId,
    source_claim_id: input.claimId,
    source_kind: input.sourceKind,
    role_id: input.roleId ?? null,
    occupant: input.occupant ?? null,
    observed_at: input.observedAt,
    valid_until: input.validUntil ?? validUntilFor(input.key, input.observedAt),
    supersedes_fact_id: supersedes,
  };
  if (supersedes) {
    const current = (await listCurrentClaimFacts(input.claimId)).some((one) => one.id === supersedes);
    if (!current) return null;
    await insert(row);
    const written = await getDb().all<ConstructionFactRow>('SELECT * FROM construction_facts WHERE supersedes_fact_id = ?', [supersedes]);
    return written[0] && written[0].id === row.id ? mapConstructionFact(written[0]) : null;
  }
  const existing = await getDb().all<ConstructionFactRow>('SELECT * FROM construction_facts WHERE source_claim_id = ?', [input.claimId]);
  if (existing.length > 0) return null;
  await insert(row);
  const written = await getDb().all<ConstructionFactRow>('SELECT * FROM construction_facts WHERE source_claim_id = ?', [input.claimId]);
  return written[0] && written[0].id === row.id ? mapConstructionFact(written[0]) : null;
}

/** A fact is current unless another row supersedes it (migration 158); the superseded row is history. */
const CURRENT = 'NOT EXISTS (SELECT 1 FROM construction_facts s WHERE s.supersedes_fact_id = f.id)';

/** A claim's current fact(s): its original, or the newest re-derivation of it. */
export async function listCurrentClaimFacts(claimId: string): Promise<RecordedFact[]> {
  const rows = await getDb().all<ConstructionFactRow>(`SELECT f.* FROM construction_facts f WHERE f.source_claim_id = ? AND ${CURRENT} ORDER BY f.created_at ASC, f.id ASC`, [claimId]);
  return rows.map(mapConstructionFact).filter((f): f is RecordedFact => f !== null);
}

/**
 * A goal's facts, and — when its project is given — the project-level facts
 * research established, oldest first. The caller decides which project facts
 * bear on the goal (its industry's subtree); this only reads.
 */
export async function listConstructionFacts(workstreamId: string, projectId: string | null = null): Promise<RecordedFact[]> {
  const rows = projectId
    ? await getDb().all<ConstructionFactRow>(
        `SELECT f.* FROM construction_facts f
          WHERE (f.workstream_id = ? OR (f.workstream_id IS NULL AND f.project_id = ?)) AND ${CURRENT}
          ORDER BY f.created_at ASC, f.id ASC`,
        [workstreamId, projectId],
      )
    : await getDb().all<ConstructionFactRow>(`SELECT f.* FROM construction_facts f WHERE f.workstream_id = ? AND ${CURRENT} ORDER BY f.created_at ASC, f.id ASC`, [workstreamId]);
  return rows.map(mapConstructionFact).filter((f): f is RecordedFact => f !== null);
}

/** The project-level facts research established and that are current (none superseded), oldest first. */
export async function listProjectConstructionFacts(projectId: string): Promise<RecordedFact[]> {
  const rows = await getDb().all<ConstructionFactRow>(
    `SELECT f.* FROM construction_facts f WHERE f.workstream_id IS NULL AND f.project_id = ? AND ${CURRENT} ORDER BY f.created_at ASC, f.id ASC`,
    [projectId],
  );
  return rows.map(mapConstructionFact).filter((f): f is RecordedFact => f !== null);
}

/**
 * The same read under a name the industry kernel may import: its sources are
 * checked for written-down industry names (tests/industryKernel.test.ts), and
 * this module's own name is one of them.
 */
export const listProjectFacts = listProjectConstructionFacts;
