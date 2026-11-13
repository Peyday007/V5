/**
 * Production probe for CAP-16-3: research capacity measured per stage (S-0170,
 * S-0171). The running Brain separates source fetching / ingestion, parsing and
 * indexing, graph / detection / quant computation, model-based interpretation,
 * evidence verification and human / authorized commercial execution, and for
 * each one records queue size, oldest useful item, items processed per hour,
 * unique usable facts, dropped / duplicate records, model calls avoided,
 * model / provider failures, CPU / RAM / DB / network use, elapsed time and
 * incremental dollar cost, and attributes productive work across purposes.
 *
 * It reads rows only: the `bin_events` rows of kind `FREE_LANE_STAGE_CAPACITY`
 * the free lane's background loop appends once an hour (`outcome` MEASURED with
 * the whole reading in `measures`, or NOT_MEASURED with the reason the
 * measurement failed). Nothing here imports the code that writes them: a probe
 * that called the measurement would be the measurement marking its own work.
 *
 * A measure is honest in one of two forms, and only these:
 * `{ measured: true, value }`, or `{ measured: false, reason }` with the reason
 * written down — a stage that has no queue, or a table that records no duration,
 * says so rather than reporting a zero. A measure missing altogether, a label
 * with no reason, or a negative count is a malformed reading. The two stages
 * the requirement restores first — model interpretation and evidence
 * verification, the lane's own — must carry real numbers for their queue,
 * oldest item, throughput, usable facts, drops, provider failures and elapsed
 * time; every stage must carry a real items-processed rate.
 *
 * Three answers, each meaning one thing:
 *  - UNKNOWN (`ok: null`): no reading has been recorded, only one recent reading
 *    exists (recurrence not yet shown), or no productive job has yet been
 *    attributed to a purpose.
 *  - FAIL: a reading contradicts the requirement — a required stage missing or
 *    merged with another, a measure absent or unlabelled, a negative count,
 *    purposes that do not sum to the productive total, the measurement failing
 *    on its last two passes, or the hourly measurement having stopped.
 *  - PASS: at least two recent readings, every one well-formed, with productive
 *    work attributed across purposes.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';

const HOUR = 3_600_000;
/** The event the free lane records each stage-capacity measurement under. */
export const STAGE_CAPACITY_EVENT = 'FREE_LANE_STAGE_CAPACITY';
/** Readings judged: those in the last six hours (six passes of an hourly measurement). */
export const READING_WINDOW_MS = 6 * HOUR;
/** The newest reading older than this means the hourly measurement has stopped (three missed passes). */
export const STOPPED_AFTER_MS = 3 * HOUR;
/** Two readings closer than this are one pass seen twice (a restart), not recurrence. */
const RECURRENCE_SPAN_MS = 30 * 60_000;

/**
 * The six stages S-0170 separates, matched on the reading's own stage id or
 * label. Each must be matched by exactly one stage of the reading, and no stage
 * may stand for two, so the stages are separate rather than merged.
 */
export const REQUIRED_STAGES: readonly { key: string; label: string; match: RegExp }[] = [
  { key: 'ingestion', label: 'source fetching / ingestion', match: /fetch|ingest/i },
  { key: 'parsing', label: 'parsing and indexing', match: /pars|index/i },
  { key: 'computation', label: 'graph / detection / quant computation', match: /graph|detect|quant/i },
  { key: 'interpretation', label: 'model-based interpretation', match: /interpret/i },
  { key: 'verification', label: 'evidence verification', match: /verif/i },
  { key: 'commercial', label: 'human / authorized commercial execution', match: /commercial/i },
];

/** Every measure S-0171 asks of each stage, as the reading names it. */
export const STAGE_MEASURES = [
  'queueSize',
  'oldestUsefulItemMinutes',
  'itemsProcessedPerHour',
  'uniqueUsableFacts',
  'droppedOrDuplicate',
  'modelCallsAvoided',
  'providerFailures',
  'resources',
  'elapsedMs',
  'incrementalDollars',
] as const;

/** Measures that must be real numbers on the stages restored first (model interpretation, evidence verification). */
const LANE_REAL = ['queueSize', 'oldestUsefulItemMinutes', 'itemsProcessedPerHour', 'uniqueUsableFacts', 'droppedOrDuplicate', 'providerFailures', 'elapsedMs'] as const;
const LANE_STAGES = new Set(['interpretation', 'verification']);

type Json = Record<string, unknown>;

function parse(value: unknown): Json | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json;
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Every numeric leaf of a measured value must be finite and not negative. Returns the offending path, or null. */
function negativeIn(value: unknown, path: string): string | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? null : path;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Json)) {
      const bad = negativeIn(v, `${path}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

interface ReadingCheck {
  /** Null when the reading is well-formed. */
  defect: string | null;
  labelled: number;
  measured: number;
  productiveJobs: number;
  purposes: string[];
}

/** Judges one MEASURED reading's `measures`. Pure; exported for tests. */
export function checkReading(measures: Json): ReadingCheck {
  const result: ReadingCheck = { defect: null, labelled: 0, measured: 0, productiveJobs: 0, purposes: [] };
  const fail = (defect: string): ReadingCheck => ({ ...result, defect });
  const stages = measures['stages'];
  if (!Array.isArray(stages) || stages.length === 0) return fail('carries no per-stage readings');

  const byRequired = new Map<string, Json>();
  const claimed = new Map<number, string>();
  for (const required of REQUIRED_STAGES) {
    const matches = stages
      .map((s, i) => ({ s: parse(s), i }))
      .filter(({ s }) => s !== null && (required.match.test(String(s['stage'] ?? '')) || required.match.test(String(s['label'] ?? ''))));
    if (matches.length === 0) return fail(`does not separate ${required.label}: no stage of the reading is that stage`);
    if (matches.length > 1) return fail(`measures ${required.label} as ${matches.length} stages (${matches.map(({ s }) => String(s!['stage'])).join(', ')}), so it is not one separated stage`);
    const { s, i } = matches[0]!;
    const other = claimed.get(i);
    if (other) return fail(`stage ${String(s!['stage'])} stands for both ${other} and ${required.label}, so the two are not separated`);
    claimed.set(i, required.label);
    byRequired.set(required.key, s!);
  }

  for (const required of REQUIRED_STAGES) {
    const stage = byRequired.get(required.key)!;
    const name = String(stage['stage'] ?? required.key);
    for (const key of STAGE_MEASURES) {
      const m = parse(stage[key]);
      if (!m || typeof m['measured'] !== 'boolean') return fail(`stage ${name} carries no ${key} at all — neither a value nor a reason it was not measured`);
      if (m['measured'] === false) {
        if (!filled(m['reason'])) return fail(`stage ${name} labels ${key} not measured without saying why`);
        if (LANE_STAGES.has(required.key) && (LANE_REAL as readonly string[]).includes(key)) {
          return fail(`stage ${name} (${required.label}) reports ${key} as not measured (${String(m['reason'])}); the stage restored first must measure it`);
        }
        if (key === 'itemsProcessedPerHour') return fail(`stage ${name} reports no items-processed rate (${String(m['reason'])})`);
        result.labelled += 1;
        continue;
      }
      if (!('value' in m)) return fail(`stage ${name} marks ${key} measured but records no value`);
      const value = m['value'];
      if (key === 'oldestUsefulItemMinutes' ? value !== null && !isCount(value) : key === 'resources' ? !parse(value) : !isCount(value)) {
        return fail(`stage ${name} records ${key} as ${JSON.stringify(value)}, which is not a measurement`);
      }
      const negative = negativeIn(value, key);
      if (negative) return fail(`stage ${name} records a negative or non-finite ${negative}`);
      if (LANE_STAGES.has(required.key) && key === 'oldestUsefulItemMinutes' && value === null && isCount(parse(stage['queueSize'])?.['value']) && (parse(stage['queueSize'])!['value'] as number) > 0) {
        return fail(`stage ${name} has queued work but no oldest-item age`);
      }
      result.measured += 1;
    }
  }

  const purposes = measures['purposes'];
  if (!Array.isArray(purposes)) return fail('attributes no productive work to purposes');
  const total = measures['totalProductiveJobs'];
  if (!isCount(total) || total < 0) return fail(`records the productive total as ${JSON.stringify(total)}`);
  let sum = 0;
  for (const raw of purposes) {
    const p = parse(raw);
    if (!p || !filled(p['purpose']) || !isCount(p['productiveJobs']) || (p['productiveJobs'] as number) < 0) {
      return fail(`carries a malformed purpose attribution ${JSON.stringify(raw)}`);
    }
    sum += p['productiveJobs'] as number;
    if ((p['productiveJobs'] as number) > 0) result.purposes.push(String(p['purpose']));
  }
  if (sum !== total || measures['purposesSumToTotal'] === false) {
    return fail(`attributes ${sum} productive job(s) across purposes but counts ${total}: a job is unattributed or counted twice`);
  }
  if (measures['attributionSumsToTotal'] === false) return fail('attributes productive jobs across its categories in a way that does not sum to the productive total');
  result.productiveJobs = total;
  return result;
}

interface CapacityRow {
  id: string;
  at: string;
  outcome: string | null;
  reason: string | null;
  measures: unknown;
}

/** CAP-16-3: stage-level research capacity measured on production, per stage and per purpose, and recurring. */
export async function stageCapacityHoldsOnRows(args: Record<string, string | number | boolean> = {}): Promise<ProbeResult> {
  const now = typeof args.now === 'number' ? args.now : Date.now();
  const rows = await getDb().all<CapacityRow>(
    'SELECT id, at, outcome, reason, measures FROM bin_events WHERE event_type = ? ORDER BY at DESC, id DESC LIMIT 48',
    [STAGE_CAPACITY_EVENT],
  );
  if (rows.length === 0) {
    return { ok: null, detail: `no ${STAGE_CAPACITY_EVENT} row: stage-level capacity has not yet been measured on production` };
  }
  const latest = rows[0]!;
  const latestAge = now - Date.parse(latest.at);
  if (!(latestAge <= STOPPED_AFTER_MS)) {
    return { ok: false, detail: `the newest ${STAGE_CAPACITY_EVENT} row is ${Math.round(latestAge / 60_000)} minute(s) old (${latest.at}): the hourly measurement has stopped` };
  }
  if (latest.outcome !== 'MEASURED' && rows[1] && rows[1].outcome !== 'MEASURED') {
    return { ok: false, detail: `the last two stage-capacity passes both failed to measure (${latest.at}: ${latest.reason ?? 'no reason'}; ${rows[1].at}: ${rows[1].reason ?? 'no reason'})` };
  }

  const since = now - READING_WINDOW_MS;
  const readings = rows.filter((r) => r.outcome === 'MEASURED' && Date.parse(r.at) >= since);
  if (readings.length === 0) {
    return { ok: null, detail: `no MEASURED stage-capacity reading in the last ${READING_WINDOW_MS / HOUR} hours (newest row ${latest.at}: ${latest.outcome ?? 'no outcome'})` };
  }
  let productiveJobs = 0;
  let latestJobs: number | null = null;
  let labelled = 0;
  let measured = 0;
  const purposes = new Set<string>();
  for (const row of readings) {
    const measures = parse(row.measures);
    if (!measures) return { ok: false, detail: `reading ${row.id} at ${row.at} is MEASURED but its measures cannot be read` };
    const check = checkReading(measures);
    if (check.defect) return { ok: false, detail: `reading ${row.id} at ${row.at} ${check.defect}` };
    productiveJobs += check.productiveJobs;
    latestJobs ??= check.productiveJobs;
    labelled += check.labelled;
    measured += check.measured;
    for (const p of check.purposes) purposes.add(p);
  }

  const span = Date.parse(readings[0]!.at) - Date.parse(readings[readings.length - 1]!.at);
  if (readings.length < 2 || span < RECURRENCE_SPAN_MS) {
    return { ok: null, detail: `${readings.length} well-formed reading(s) in the last ${READING_WINDOW_MS / HOUR} hours spanning ${Math.round(span / 60_000)} minute(s): the measurement is not yet shown to recur` };
  }
  if (productiveJobs === 0) {
    return { ok: null, detail: `${readings.length} well-formed reading(s) separate all six stages, but none attributes a productive job to a purpose yet` };
  }
  return {
    ok: true,
    detail:
      `${readings.length} stage-capacity reading(s) over ${Math.round(span / 60_000)} minute(s), newest ${Math.round(latestAge / 60_000)} minute(s) old, ` +
      `each separating all six stages with every measure present (${measured} measured, ${labelled} labelled not-measured with a reason; ` +
      `model interpretation and evidence verification measured in full); productive work attributed across ` +
      `${purposes.size} purpose(s), ${latestJobs ?? 0} job(s) in the newest reading's window (${[...purposes].sort().join(', ')})`,
  };
}
