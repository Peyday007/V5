/**
 * Where the manufacturing kernel's readings become rows, and where they are
 * read back from.
 *
 * The kernel re-derives every reading on every pass and stores nothing. The
 * Russell tick hands each pass here, and each reading that changed since the
 * newest one recorded for its subject is written to the append-only
 * `bin_events` ledger with the whole reading in `measures`:
 *
 *  - `MANUFACTURING_VENTURE_READ`: a category's venture (VENT-24-2). This is the
 *    dependency-ordered stage graph, where every node carries its decision,
 *    resource, artifact, actor, budget, evidence and completion condition. It
 *    also carries the verdict that challenges the graph against deployable
 *    capital and held capabilities, the materially different feasible
 *    alternatives with their own graphs and verdicts, and the per-category
 *    resource reading beside it;
 *  - `MANUFACTURING_COMPETITIVE_READ`: a category's competitive system (VENT-24-1);
 *  - `MANUFACTURING_INSTITUTIONS_READ`: its institutional machinery (INST-30).
 *
 * `recordedManufacturingReadings` reads the newest of each back, so a person,
 * a probe, the programme view or a later pass reads what was derived from the
 * rows, never a pass's memory. Nothing here decides, forms, signs, spends or
 * commits anything.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import type { VentureReconsideration } from './kernel.ts';
import type { CompetitiveSystem } from './competitiveSystem.ts';
import type { CategoryInstitutions } from './institutionReading.ts';
import type { Challenge, Feasibility, Money, VenturePath, VentureVerdict } from './venturePath.ts';

/** The event a category's venture is recorded under (on bin_events), once per change. */
export const VENTURE_READ_EVENT = 'MANUFACTURING_VENTURE_READ';
/** The event a category's competitive system is recorded under (VENT-24-1), once per change. */
export const COMPETITIVE_READ_EVENT = 'MANUFACTURING_COMPETITIVE_READ';
/** The event a category's institutional machinery is recorded under (INST-30), once per change. */
export const INSTITUTIONS_READ_EVENT = 'MANUFACTURING_INSTITUTIONS_READ';

/** A reading's identity: the same content always yields the same fingerprint. */
function readingFingerprint(value: unknown, ignore: readonly string[] = []): string {
  const skip = new Set(ignore);
  return createHash('sha256')
    .update(JSON.stringify(value, (key, inner: unknown) => (skip.has(key) ? undefined : inner)))
    .digest('hex')
    .slice(0, 32);
}

/* ------------------------------------------------------------------------- */
/* Ventures (VENT-24-2)                                                       */
/* ------------------------------------------------------------------------- */

/** One recorded alternative: what differs, its own graph and its own verdict. */
export interface RecordedVentureAlternative {
  kind: 'SUBSTITUTED' | 'VALIDATE_FIRST';
  differs: string[];
  total: Money | null;
  graph: Extract<VenturePath, { ok: true }>;
  verdict: VentureVerdict;
}

/** A category's venture as it is written to, and read back from, bin_events. */
export interface RecordedVenture {
  categoryId: string;
  path: string[];
  /**
   * The venture's feasibility: the stage graph's own verdict. This is the graph
   * challenged against deployable capital, held capabilities, unpriced stages
   * and unknowns. A graph that could not be built (a cycle, an unknown or
   * duplicate stage) is UNDETERMINED, because an unknown never reads as
   * feasible (invariant 39).
   */
  feasibility: Feasibility;
  /** The dependency-ordered stage graph, every node with its seven fields, or the refusal. */
  graph: VenturePath;
  /** The challenges the graph was judged by; null when the graph was refused. */
  verdict: VentureVerdict | null;
  /** Materially different feasible alternatives, each with its own graph and verdict. */
  alternatives: RecordedVentureAlternative[];
  /** The per-category resource reading beside the graph: the cheapest fully priced entry against capital. */
  reading: { feasibility: Feasibility; challenges: Challenge[]; cost: Money | null; available: Money | null };
  newestInput: VentureReconsideration['newestInput'];
}

/** The venture a pass derived, in the shape it is recorded. Pure. */
export function ventureRecord(venture: VentureReconsideration): RecordedVenture {
  const { path, verdict, alternatives } = venture.venture;
  return {
    categoryId: venture.categoryId,
    path: venture.path,
    feasibility: path.ok && verdict ? verdict.feasibility : 'UNDETERMINED',
    graph: path,
    verdict,
    alternatives: alternatives.map((one) => ({ kind: one.kind, differs: one.differs, total: one.total, graph: one.path, verdict: one.verdict })),
    reading: { feasibility: venture.feasibility, challenges: venture.challenges, cost: venture.cost, available: venture.available },
    newestInput: venture.newestInput,
  };
}

/** The newest recorded venture of each category for a project, with the fingerprint it was recorded under. */
async function recordedVentureState(projectId: string): Promise<Map<string, { feasibility: string; fingerprint: string | null }>> {
  const rows = await getDb().all<{ measures: string | null }>(
    'SELECT measures FROM bin_events WHERE event_type = ? AND project_id = ? ORDER BY at ASC, id ASC',
    [VENTURE_READ_EVENT, projectId],
  );
  const latest = new Map<string, { feasibility: string; fingerprint: string | null }>();
  for (const row of rows) {
    try {
      const one = JSON.parse(row.measures ?? '{}') as { categoryId?: unknown; feasibility?: unknown; fingerprint?: unknown };
      if (typeof one.categoryId !== 'string' || typeof one.feasibility !== 'string') continue;
      // A row written before the graph was recorded has no fingerprint, so the next pass records the whole graph once.
      latest.set(one.categoryId, { feasibility: one.feasibility, fingerprint: typeof one.fingerprint === 'string' ? one.fingerprint : null });
    } catch {
      /* a row that does not parse is no reading */
    }
  }
  return latest;
}

/** What a recorded change of a venture's feasibility tells the project's live goals, if anything. */
function goalNotice(from: string | null, to: Feasibility): { kind: string; summary: string } | null {
  if (from === null || from === to) return null;
  if (to === 'FEASIBLE') return { kind: 'VENTURE_BECAME_FEASIBLE', summary: `is now feasible (was ${from})` };
  // Its blockers cleared. What remains is unknown, so it is closer, and it is still not ready (invariant 39).
  if (from === 'INFEASIBLE' && to === 'UNDETERMINED') {
    return { kind: 'VENTURE_UNBLOCKED', summary: 'is no longer blocked by capital or a capability; what remains is unknown, not settled' };
  }
  return null;
}

/**
 * Record each category's venture that changed since its last recorded reading,
 * and tell the project's live goals when one became reachable. VENT-24-2:
 * earlier ventures are revisited automatically as capital and capabilities
 * change, through the same goal system.
 *
 * The record is the whole venture (`ventureRecord`). Its feasibility is the
 * stage graph's verdict, not the per-category resource reading. A change
 * anywhere in the graph, its challenges or its alternatives writes a new row.
 * An unchanged venture writes nothing. One that moves back and forth is
 * recorded each time it moves. A goal is told only when the verdict moves to
 * FEASIBLE, or from INFEASIBLE to UNDETERMINED (its blockers cleared). It says
 * what turned the venture, and its owner acts through the existing paths.
 * Nothing here spends or commits.
 *
 * Returns each recorded change. `from` and `to` are equal when the graph
 * changed and its feasibility did not.
 */
export async function recordVentureTransitions(
  projectId: string,
  ventures: readonly VentureReconsideration[],
): Promise<{ categoryId: string; from: string | null; to: string }[]> {
  const out: { categoryId: string; from: string | null; to: string }[] = [];
  if (ventures.length === 0) return out;
  const held = await recordedVentureState(projectId);
  const { recordBinEvent } = await import('../../repos/bins.ts');
  for (const venture of ventures) {
    const record = ventureRecord(venture);
    const fingerprint = readingFingerprint(record);
    const previous = held.get(venture.categoryId) ?? null;
    if (previous?.fingerprint === fingerprint) continue;
    const from = previous?.feasibility ?? null;
    const to = record.feasibility;
    await recordBinEvent({
      eventType: VENTURE_READ_EVENT,
      projectId,
      workloadClass: 'manufacturing-kernel',
      outcome: to,
      reason: `${venture.path.join(' → ')}: ${from ?? 'first reading'} → ${to}`.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: { subjectKey: venture.categoryId, fingerprint, previous: from, previousFingerprint: previous?.fingerprint ?? null, ...record },
    });
    out.push({ categoryId: venture.categoryId, from, to });
    const notice = goalNotice(from, to);
    if (!notice) continue;
    const { listWorkstreams, recordWorkstreamEvent } = await import('../../repos/register.ts');
    for (const goal of await listWorkstreams({ projectIds: [projectId] })) {
      if (goal.cancelledAt || goal.archivedAt) continue;
      await recordWorkstreamEvent({
        workstreamId: goal.id,
        kind: notice.kind,
        summary: `Venture ${venture.path.join(' → ')} ${notice.summary}`.slice(0, 300),
        detail: {
          categoryId: venture.categoryId,
          from,
          to,
          total: record.graph.ok ? record.graph.total : null,
          available: record.reading.available,
          challenges: (record.verdict?.challenges ?? []).map((one) => one.kind),
          newestInput: record.newestInput,
        },
        actorRef: 'brain:manufacturing-kernel',
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Competitive systems (VENT-24-1) and institutional machinery (INST-30)      */
/* ------------------------------------------------------------------------- */

/** The newest recorded fingerprint of each subject's reading under one event type, from bin_events. */
async function recordedFingerprints(projectId: string, eventType: string): Promise<Map<string, string>> {
  const rows = await getDb().all<{ measures: string | null }>(
    'SELECT measures FROM bin_events WHERE event_type = ? AND project_id = ? ORDER BY at ASC, id ASC',
    [eventType, projectId],
  );
  const latest = new Map<string, string>();
  for (const row of rows) {
    try {
      const one = JSON.parse(row.measures ?? '{}') as { subjectKey?: unknown; fingerprint?: unknown };
      if (typeof one.subjectKey === 'string' && typeof one.fingerprint === 'string') latest.set(one.subjectKey, one.fingerprint);
    } catch {
      /* a row that does not parse is no reading */
    }
  }
  return latest;
}

/**
 * Record each manufacturing reading that changed since its last recorded
 * version: the competitive system of every live category (VENT-24-1) and its
 * institutional machinery (INST-30).
 *
 * Each reading is written to the append-only bin_events ledger with the whole
 * reading in `measures`. It is compared by fingerprint with the newest one
 * recorded for the subject. An unchanged reading writes nothing, and every
 * change is recorded.
 */
export async function recordManufacturingReadings(
  projectId: string,
  readings: { competitive: readonly CompetitiveSystem[]; institutions: readonly CategoryInstitutions[] },
): Promise<{ competitive: string[]; institutions: string[] }> {
  const out = { competitive: [] as string[], institutions: [] as string[] };
  if (readings.competitive.length === 0 && readings.institutions.length === 0) return out;
  const { recordBinEvent } = await import('../../repos/bins.ts');
  // The kernel names a competitive system by its category's name; carry the id when the ladder states it.
  const categoryIdByName = new Map(readings.institutions.map((one) => [one.name, one.categoryId]));

  const competitiveHeld = readings.competitive.length > 0 ? await recordedFingerprints(projectId, COMPETITIVE_READ_EVENT) : new Map<string, string>();
  for (const system of readings.competitive) {
    const categoryId = categoryIdByName.get(system.subject) ?? null;
    const subjectKey = categoryId ?? `subject:${system.subject}`;
    const fingerprint = readingFingerprint(system);
    if (competitiveHeld.get(subjectKey) === fingerprint) continue;
    await recordBinEvent({
      eventType: COMPETITIVE_READ_EVENT,
      projectId,
      workloadClass: 'manufacturing-kernel',
      outcome: `${system.mechanisms.length} mechanism(s), ${system.openQuestions.length} open question(s)`,
      reason: `${system.subject}: ${system.mechanisms.length} evidenced mechanism(s), ${system.profitPools.length} profit pool(s), ${system.activities.length} activity classification(s)`.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: { subjectKey, categoryId, fingerprint, previous: competitiveHeld.get(subjectKey) ?? null, system },
    });
    out.competitive.push(subjectKey);
  }

  const institutionsHeld = readings.institutions.length > 0 ? await recordedFingerprints(projectId, INSTITUTIONS_READ_EVENT) : new Map<string, string>();
  for (const one of readings.institutions) {
    const subjectKey = one.categoryId;
    // A renewal date is counted from the pass's own clock, so it moves every tick; the date is
    // recorded with the reading, but only a change in what the rows imply makes a new one.
    const fingerprint = readingFingerprint(one.derivation, ['renewalDate']);
    if (institutionsHeld.get(subjectKey) === fingerprint) continue;
    const best = one.derivation.structures[0];
    await recordBinEvent({
      eventType: INSTITUTIONS_READ_EVENT,
      projectId,
      workloadClass: 'manufacturing-kernel',
      outcome: best ? `${best.kind}: legal ${best.legalFeasibility}, readiness ${best.readiness}, authorization ${best.authorization}` : 'NO_STRUCTURE',
      reason: `${one.name}: ${one.derivation.structures.length} structure(s), ${one.derivation.openQuestions.length} open question(s), ${one.derivation.limitations.length} limitation(s)`.slice(0, 480),
      evidenceClass: 'MEASURED',
      measures: { subjectKey, categoryId: one.categoryId, name: one.name, fingerprint, previous: institutionsHeld.get(subjectKey) ?? null, derivation: one.derivation },
    });
    out.institutions.push(subjectKey);
  }
  return out;
}

export interface RecordedReadings {
  competitive: { subjectKey: string; categoryId: string | null; fingerprint: string; at: string; system: CompetitiveSystem }[];
  institutions: { subjectKey: string; categoryId: string; name: string; fingerprint: string; at: string; derivation: CategoryInstitutions['derivation'] }[];
  /** The newest recorded venture per category, stage graph and all. Rows written before the graph was recorded are skipped. */
  ventures: (RecordedVenture & { fingerprint: string; at: string })[];
}

/**
 * The manufacturing readings as recorded: the newest venture (VENT-24-2),
 * competitive system (VENT-24-1) and institutional machinery (INST-30) per
 * category, read back from the append-only events written above.
 */
export async function recordedManufacturingReadings(projectId: string): Promise<RecordedReadings> {
  const rows = await getDb().all<{ event_type: string; at: string; measures: string | null }>(
    'SELECT event_type, at, measures FROM bin_events WHERE project_id = ? AND event_type IN (?, ?, ?) ORDER BY at ASC, id ASC',
    [projectId, COMPETITIVE_READ_EVENT, INSTITUTIONS_READ_EVENT, VENTURE_READ_EVENT],
  );
  const competitive = new Map<string, RecordedReadings['competitive'][number]>();
  const institutions = new Map<string, RecordedReadings['institutions'][number]>();
  const ventures = new Map<string, RecordedReadings['ventures'][number]>();
  for (const row of rows) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(row.measures ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof m['subjectKey'] !== 'string' || typeof m['fingerprint'] !== 'string') continue;
    const subjectKey = m['subjectKey'];
    const fingerprint = m['fingerprint'];
    if (row.event_type === COMPETITIVE_READ_EVENT && m['system']) {
      competitive.set(subjectKey, { subjectKey, categoryId: typeof m['categoryId'] === 'string' ? m['categoryId'] : null, fingerprint, at: row.at, system: m['system'] as CompetitiveSystem });
    } else if (row.event_type === INSTITUTIONS_READ_EVENT && m['derivation'] && typeof m['categoryId'] === 'string') {
      institutions.set(subjectKey, { subjectKey, categoryId: m['categoryId'], name: typeof m['name'] === 'string' ? m['name'] : '', fingerprint, at: row.at, derivation: m['derivation'] as CategoryInstitutions['derivation'] });
    } else if (row.event_type === VENTURE_READ_EVENT && m['graph'] && typeof m['categoryId'] === 'string') {
      const { subjectKey: _subject, previous: _previous, previousFingerprint: _prior, fingerprint: _fp, ...venture } = m;
      ventures.set(subjectKey, { ...(venture as unknown as RecordedVenture), fingerprint, at: row.at });
    }
  }
  return { competitive: [...competitive.values()], institutions: [...institutions.values()], ventures: [...ventures.values()] };
}
