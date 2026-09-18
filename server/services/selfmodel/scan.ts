/**
 * Taking a reading, and noticing that one changed.
 *
 * ---------------------------------------------------------------------------
 * Why a derived model is stored at all
 * ---------------------------------------------------------------------------
 *
 * Every value `observeSystem` produces is re-derivable from the process, the
 * filesystem and the rows, so storing it looks like exactly the second-copy
 * mistake this codebase keeps correcting. It is stored for the two things a
 * pure derivation cannot do, which is the argument §29 already makes for the
 * frontier: remember that a component **stopped** being connected, and give
 * drift somewhere to be noticed.
 *
 * Deleting every row returns Brain exactly to what it did before.
 *
 * ---------------------------------------------------------------------------
 * Only changes are events
 * ---------------------------------------------------------------------------
 *
 * A row per scan would be a log of the scanner rather than a history of the
 * system, and at six hundred components a daily scan would bury the one thing
 * anybody ever wants from it. So `system_component_events` is written only when
 * a level actually moves, and `system_scans.drift` is the one number that says
 * whether a scan was worth reading.
 *
 * ---------------------------------------------------------------------------
 * A scan never decides anything
 * ---------------------------------------------------------------------------
 *
 * Nothing here queues work, promotes a faculty, fires a surface or moves any
 * state outside these three tables. That is deliberate: a self-model that acted
 * on what it saw would be a control loop whose input is its own output, and the
 * first wrong reading would become a decision. What reads this and decides is
 * the realization packet, which a person approves.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, toJson, parseJson } from '../../repos/util.ts';
import { BRAIN_REVISION } from '../../env.ts';
import { observeSystem } from './observe.ts';
import {
  componentKey,
  EVIDENCE_LEVELS,
  type Answer,
  type ComponentKind,
  type ComponentObservation,
  type EvidenceLevel,
  type Reading,
} from './levels.ts';

export const SCAN_REASONS = [
  'BOOT',
  'MIGRATION_APPLIED',
  'DEPLOYMENT',
  'SCHEDULED',
  'CAPABILITY_PROMOTED',
  'FACTORY_INTEGRATION',
  'REQUESTED',
] as const;
export type ScanReason = (typeof SCAN_REASONS)[number];

/** The column each level is stored in. One map, so no reader invents a name. */
const LEVEL_COLUMN: Record<EvidenceLevel, string> = {
  DOCUMENTED: 'documented',
  IN_SOURCE: 'in_source',
  CONNECTED: 'connected',
  DEPLOYED: 'deployed',
  OBSERVED_ACTIVE: 'observed_active',
  EVALUATED: 'evaluated',
  PRODUCTION_PROVEN: 'production_proven',
};

export interface SystemComponent {
  id: string;
  componentKey: string;
  kind: ComponentKind;
  name: string;
  detail: string | null;
  answers: Record<EvidenceLevel, Answer>;
  evidence: Partial<Record<EvidenceLevel, string>>;
  revision: string | null;
  observedAt: string;
}

export interface ComponentDrift {
  componentKey: string;
  level: EvidenceLevel;
  from: Answer;
  to: Answer;
  evidence: string;
}

export interface ScanReport {
  scanId: string;
  reason: ScanReason;
  revision: string | null;
  components: number;
  drift: ComponentDrift[];
  /** What the pass could not read. Named rather than omitted. */
  unreadable: string[];
  startedAt: string;
  finishedAt: string;
}

type Row = Record<string, unknown>;

function answersOf(observation: ComponentObservation): Record<EvidenceLevel, Answer> {
  const out = {} as Record<EvidenceLevel, Answer>;
  for (const level of EVIDENCE_LEVELS) {
    // A level no observer answered is `UNKNOWN`, never absent and never false.
    // Absent-as-false is the encoding mistake the three-answer column exists to
    // make unrepresentable, and it would creep back in here if this defaulted.
    out[level] = observation.readings[level]?.answer ?? 'UNKNOWN';
  }
  return out;
}

function evidenceOf(observation: ComponentObservation): Partial<Record<EvidenceLevel, string>> {
  const out: Partial<Record<EvidenceLevel, string>> = {};
  for (const level of EVIDENCE_LEVELS) {
    const reading: Reading | undefined = observation.readings[level];
    if (reading) out[level] = reading.evidence;
  }
  return out;
}

/**
 * Take one reading of the whole system and record what moved.
 *
 * Idempotent in the way that matters: running it twice in a row produces one
 * set of current rows and a second scan whose drift is zero. It is *not*
 * idempotent in the sense of doing nothing the second time — the scan row is
 * written either way, because "we looked and nothing had changed" is a fact
 * worth having and is the answer most of the time.
 */
export async function scanSystem(reason: ScanReason): Promise<ScanReport> {
  const startedAt = nowIso();
  const pass = await observeSystem();
  const db = getDb();

  const existing = await db.all<Row>(`SELECT * FROM system_components`);
  const byKey = new Map(existing.map((row) => [String(row['component_key']), row]));

  const drift: ComponentDrift[] = [];
  const at = nowIso();

  for (const observation of pass.components) {
    const key = componentKey(observation.kind, observation.name);
    const answers = answersOf(observation);
    const evidence = evidenceOf(observation);
    const prior = byKey.get(key);

    if (!prior) {
      await db.run(
        `INSERT INTO system_components
           (id, component_key, kind, name, detail, documented, in_source, connected, deployed,
            observed_active, evaluated, production_proven, evidence, revision, observed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('sys'),
          key,
          observation.kind,
          observation.name,
          observation.detail,
          answers.DOCUMENTED,
          answers.IN_SOURCE,
          answers.CONNECTED,
          answers.DEPLOYED,
          answers.OBSERVED_ACTIVE,
          answers.EVALUATED,
          answers.PRODUCTION_PROVEN,
          toJson(evidence),
          BRAIN_REVISION,
          at,
          at,
          at,
        ] as never[],
      );
      // A component Brain has never seen is not drift. It is the first reading,
      // and counting it as movement would make every new deployment look like
      // the system had changed under itself.
      continue;
    }

    const moved: ComponentDrift[] = [];
    for (const level of EVIDENCE_LEVELS) {
      const before = String(prior[LEVEL_COLUMN[level]] ?? 'UNKNOWN') as Answer;
      const after = answers[level];
      if (before === after) continue;
      moved.push({
        componentKey: key,
        level,
        from: before,
        to: after,
        evidence: evidence[level] ?? 'no evidence was recorded for this level',
      });
    }

    await db.run(
      `UPDATE system_components
          SET detail = ?, documented = ?, in_source = ?, connected = ?, deployed = ?,
              observed_active = ?, evaluated = ?, production_proven = ?, evidence = ?,
              revision = ?, observed_at = ?, updated_at = ?
        WHERE component_key = ?`,
      [
        observation.detail,
        answers.DOCUMENTED,
        answers.IN_SOURCE,
        answers.CONNECTED,
        answers.DEPLOYED,
        answers.OBSERVED_ACTIVE,
        answers.EVALUATED,
        answers.PRODUCTION_PROVEN,
        toJson(evidence),
        BRAIN_REVISION,
        at,
        at,
        key,
      ] as never[],
    );

    for (const move of moved) {
      await db.run(
        `INSERT INTO system_component_events
           (id, component_key, level, from_answer, to_answer, evidence, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('sce'),
          move.componentKey,
          move.level,
          move.from,
          move.to,
          move.evidence,
          BRAIN_REVISION,
          at,
        ] as never[],
      );
    }
    drift.push(...moved);
  }

  /*
   * A component that was there and is not any more.
   *
   * Its row stays and its levels are re-read as `NO` with the reason, rather
   * than being deleted — §29's rule for a resolved frontier item, and the same
   * reasoning: a delete makes a disappearance look like progress. A migration
   * that vanished from the image is exactly the thing somebody needs to see.
   */
  const seen = new Set(
    pass.components.map((observation) => componentKey(observation.kind, observation.name)),
  );
  for (const [key, row] of byKey) {
    if (seen.has(key)) continue;
    const before = String(row['in_source'] ?? 'UNKNOWN') as Answer;
    if (before === 'NO') continue;
    const gone =
      'This component was observed before and is not in this reading. The row is kept rather ' +
      'than deleted: a disappearance that left no trace would look like progress.';
    await db.run(
      `UPDATE system_components SET in_source = 'NO', connected = 'NO', evidence = ?,
              revision = ?, observed_at = ?, updated_at = ? WHERE component_key = ?`,
      [toJson({ IN_SOURCE: gone, CONNECTED: gone }), BRAIN_REVISION, at, at, key] as never[],
    );
    await db.run(
      `INSERT INTO system_component_events
         (id, component_key, level, from_answer, to_answer, evidence, revision, created_at)
       VALUES (?, ?, 'IN_SOURCE', ?, 'NO', ?, ?, ?)`,
      [newId('sce'), key, before, gone, BRAIN_REVISION, at] as never[],
    );
    drift.push({ componentKey: key, level: 'IN_SOURCE', from: before, to: 'NO', evidence: gone });
  }

  const scanId = newId('scn');
  const finishedAt = nowIso();
  await db.run(
    `INSERT INTO system_scans
       (id, reason, revision, components, drift, unreadable, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scanId,
      reason,
      BRAIN_REVISION,
      pass.components.length,
      drift.length,
      toJson(pass.unreadable),
      startedAt,
      finishedAt,
    ] as never[],
  );

  return {
    scanId,
    reason,
    revision: BRAIN_REVISION,
    components: pass.components.length,
    drift,
    unreadable: pass.unreadable,
    startedAt,
    finishedAt,
  };
}

/* ------------------------------------------------------------------------- */
/* Reading it back                                                            */
/* ------------------------------------------------------------------------- */

function mapComponent(row: Row): SystemComponent {
  const answers = {} as Record<EvidenceLevel, Answer>;
  for (const level of EVIDENCE_LEVELS) {
    answers[level] = String(row[LEVEL_COLUMN[level]] ?? 'UNKNOWN') as Answer;
  }
  return {
    id: String(row['id'] ?? ''),
    componentKey: String(row['component_key'] ?? ''),
    kind: String(row['kind'] ?? '') as ComponentKind,
    name: String(row['name'] ?? ''),
    detail: row['detail'] === null || row['detail'] === undefined ? null : String(row['detail']),
    answers,
    evidence: parseJson<Partial<Record<EvidenceLevel, string>>>(
      row['evidence'] === null || row['evidence'] === undefined ? null : String(row['evidence']),
      {},
    ),
    revision:
      row['revision'] === null || row['revision'] === undefined ? null : String(row['revision']),
    observedAt: String(row['observed_at'] ?? ''),
  };
}

export async function listComponents(
  filter: { kind?: ComponentKind; level?: EvidenceLevel; answer?: Answer } = {},
): Promise<SystemComponent[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.level && filter.answer) {
    where.push(`${LEVEL_COLUMN[filter.level]} = ?`);
    params.push(filter.answer);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM system_components
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY kind, name`,
    params as never[],
  );
  return rows.map(mapComponent);
}

export async function getComponent(key: string): Promise<SystemComponent | null> {
  const row = await getDb().get<Row>(
    `SELECT * FROM system_components WHERE component_key = ?`,
    [key] as never[],
  );
  return row ? mapComponent(row) : null;
}

export async function latestScan(): Promise<ScanReport | null> {
  const row = await getDb().get<Row>(
    // Ordered by a column both dialects have. §27: a tiebreak on `rowid` is the
    // easiest way to write an ORDER BY that is true in one dialect only.
    `SELECT * FROM system_scans ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    scanId: String(row['id'] ?? ''),
    reason: String(row['reason'] ?? '') as ScanReason,
    revision:
      row['revision'] === null || row['revision'] === undefined ? null : String(row['revision']),
    components: Number(row['components'] ?? 0),
    drift: [],
    unreadable: parseJson<string[]>(
      row['unreadable'] === null || row['unreadable'] === undefined
        ? null
        : String(row['unreadable']),
      [],
    ),
    startedAt: String(row['started_at'] ?? ''),
    finishedAt: String(row['finished_at'] ?? ''),
  };
}

/** Every recorded change to one component, oldest first. */
export async function componentHistory(key: string): Promise<ComponentDrift[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM system_component_events WHERE component_key = ? ORDER BY created_at, id`,
    [key] as never[],
  );
  return rows.map((row) => ({
    componentKey: String(row['component_key'] ?? ''),
    level: String(row['level'] ?? '') as EvidenceLevel,
    from: String(row['from_answer'] ?? '') as Answer,
    to: String(row['to_answer'] ?? '') as Answer,
    evidence: String(row['evidence'] ?? ''),
  }));
}
