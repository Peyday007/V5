/**
 * The intelligence funnel: the difference between how much came in and how
 * much Brain actually understands (KNOW-25-1, "No false speed").
 *
 * Six stages are counted, each from its own records and never inferred from
 * another: raw intake, successfully parsed records, normalized facts, evidence
 * accepted, economic relationships updated and goal-impacting decisions. A
 * stage's record is usable only when it is not a duplicate (a fingerprint the
 * stage already counted), not stale, not contested and not unverified; every
 * exclusion is counted under its reason rather than silently dropped.
 *
 * Usable intelligence is the sum of the usable records past raw intake: intake
 * is bytes, not understanding. So a faster import that only adds duplicates or
 * stale records raises `raw` and leaves `usableIntelligence` where it was.
 *
 * Pure: it reads records the caller already loaded (feed items, the extraction
 * pass's facts and their `ReconciledStatus`, accepted claims, graph updates,
 * decisions) and writes nothing. It is a reading, not a store or a scheduler.
 *
 * Across readings: a caller that reads the funnel pass after pass carries the
 * previous cumulative reading and the fingerprints earlier readings counted
 * (`rememberFingerprints`). A record whose fingerprint an earlier reading
 * already counted is a DUPLICATE now, and the gain is measured against the
 * previous cumulative reading (`addReadings`), never against an empty one — so
 * re-importing what was already understood raises raw intake and nothing else.
 */
import { createHash } from 'node:crypto';

export const FUNNEL_STAGES = [
  'RAW_INTAKE',
  'PARSED',
  'NORMALIZED_FACTS',
  'EVIDENCE_ACCEPTED',
  'RELATIONSHIPS_UPDATED',
  'GOAL_DECISIONS',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const EXCLUSION_REASONS = ['DUPLICATE', 'STALE', 'CONTESTED', 'UNVERIFIED'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** One record at one stage, as its own row says it. */
export interface FunnelRecord {
  id: string;
  /** Content fingerprint: two records with the same one at a stage are one record. */
  fingerprint: string;
  /** When what the record says was observed (ISO-8601). Absent means not known, never fresh by assumption. */
  observedAt?: string | null;
  /** Reconciliation status where the stage has one (`ReconciledStatus` in feeds/extract.ts). */
  status?: 'OBSERVED' | 'CONTESTED' | 'STALE' | null;
  /** Whether the record was verified. Only an explicit false excludes it; absent means the stage does not verify. */
  verified?: boolean | null;
}

export type FunnelInput = Partial<Record<FunnelStage, readonly FunnelRecord[]>>;

export interface FunnelOptions {
  now?: Date;
  /** A record observed longer ago than this is stale. Absent: only an explicit STALE status is stale. */
  staleAfterMs?: number;
  /**
   * Fingerprint keys (`fingerprintKey`) an earlier reading already counted, per stage. A record
   * matching one is a DUPLICATE: understood before, so not new intelligence now.
   */
  seen?: Partial<Record<FunnelStage, Iterable<string>>>;
}

export interface StageReading {
  stage: FunnelStage;
  /** Every record the stage holds, duplicates included. */
  raw: number;
  /** Records that survived every exclusion. */
  usable: number;
  /** Excluded records by reason; each excluded record is counted under exactly one reason. */
  excluded: Record<ExclusionReason, number>;
}

export interface FunnelReading {
  stages: StageReading[];
  /** Sum of every stage's raw count. */
  raw: number;
  /** Usable records past raw intake. */
  usableIntelligence: number;
  /** Exclusions across all stages, by reason. */
  excluded: Record<ExclusionReason, number>;
}

function emptyExclusions(): Record<ExclusionReason, number> {
  return { DUPLICATE: 0, STALE: 0, CONTESTED: 0, UNVERIFIED: 0 };
}

/** The short, stable key a fingerprint is remembered under across readings. */
export function fingerprintKey(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}

/** Why a record is excluded, or null when it is usable. The first reason that applies is the one counted. */
function exclusionOf(record: FunnelRecord, seen: Set<string>, earlier: ReadonlySet<string>, options: FunnelOptions): ExclusionReason | null {
  if (seen.has(record.fingerprint)) return 'DUPLICATE';
  seen.add(record.fingerprint);
  if (earlier.size > 0 && earlier.has(fingerprintKey(record.fingerprint))) return 'DUPLICATE';
  if (record.status === 'STALE') return 'STALE';
  if (options.staleAfterMs !== undefined && record.observedAt) {
    const at = Date.parse(record.observedAt);
    const now = (options.now ?? new Date()).getTime();
    if (Number.isFinite(at) && now - at > options.staleAfterMs) return 'STALE';
  }
  if (record.status === 'CONTESTED') return 'CONTESTED';
  if (record.verified === false) return 'UNVERIFIED';
  return null;
}

/** Read one stage from its own records. */
export function readStage(stage: FunnelStage, records: readonly FunnelRecord[], options: FunnelOptions = {}): StageReading {
  const excluded = emptyExclusions();
  const seen = new Set<string>();
  const earlier = new Set(options.seen?.[stage] ?? []);
  let usable = 0;
  for (const record of records) {
    const reason = exclusionOf(record, seen, earlier, options);
    if (reason) excluded[reason] += 1;
    else usable += 1;
  }
  return { stage, raw: records.length, usable, excluded };
}

/** Read the whole funnel. A stage with no records reads zero; it is never filled from a neighbour. */
export function readFunnel(input: FunnelInput, options: FunnelOptions = {}): FunnelReading {
  const stages = FUNNEL_STAGES.map((stage) => readStage(stage, input[stage] ?? [], options));
  const excluded = emptyExclusions();
  let raw = 0;
  let usableIntelligence = 0;
  for (const reading of stages) {
    raw += reading.raw;
    if (reading.stage !== 'RAW_INTAKE') usableIntelligence += reading.usable;
    for (const reason of EXCLUSION_REASONS) excluded[reason] += reading.excluded[reason];
  }
  return { stages, raw, usableIntelligence, excluded };
}

/** What one reading gained over another: raw growth is reported beside usable growth, never in place of it. */
export function funnelGain(before: FunnelReading, after: FunnelReading): { raw: number; usableIntelligence: number; falseSpeed: boolean } {
  const raw = after.raw - before.raw;
  const usableIntelligence = after.usableIntelligence - before.usableIntelligence;
  return { raw, usableIntelligence, falseSpeed: raw > 0 && usableIntelligence <= 0 };
}

/** Two readings added stage by stage: the cumulative reading after `next` was read on top of `base`. */
export function addReadings(base: FunnelReading, next: FunnelReading): FunnelReading {
  const stages = FUNNEL_STAGES.map((stage) => {
    const a = base.stages.find((s) => s.stage === stage);
    const b = next.stages.find((s) => s.stage === stage);
    const excluded = emptyExclusions();
    for (const reason of EXCLUSION_REASONS) excluded[reason] = (a?.excluded[reason] ?? 0) + (b?.excluded[reason] ?? 0);
    return { stage, raw: (a?.raw ?? 0) + (b?.raw ?? 0), usable: (a?.usable ?? 0) + (b?.usable ?? 0), excluded };
  });
  const excluded = emptyExclusions();
  for (const reason of EXCLUSION_REASONS) excluded[reason] = base.excluded[reason] + next.excluded[reason];
  return { stages, raw: base.raw + next.raw, usableIntelligence: base.usableIntelligence + next.usableIntelligence, excluded };
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** A stored reading read back, or null when it is not one: an unreadable earlier reading is absent, never zero by assumption. */
export function parseFunnelReading(value: unknown): FunnelReading | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { stages?: unknown };
  if (!Array.isArray(v.stages)) return null;
  const stages: StageReading[] = [];
  for (const stage of FUNNEL_STAGES) {
    const found = (v.stages as unknown[]).find((s) => !!s && typeof s === 'object' && (s as { stage?: unknown }).stage === stage) as
      | { raw?: unknown; usable?: unknown; excluded?: Record<string, unknown> }
      | undefined;
    if (!found) return null;
    const raw = count(found.raw);
    const usable = count(found.usable);
    if (raw === null || usable === null) return null;
    const excluded = emptyExclusions();
    for (const reason of EXCLUSION_REASONS) {
      const n = count(found.excluded?.[reason] ?? 0);
      if (n === null) return null;
      excluded[reason] = n;
    }
    stages.push({ stage, raw, usable, excluded });
  }
  const total = emptyExclusions();
  let raw = 0;
  let usableIntelligence = 0;
  for (const s of stages) {
    raw += s.raw;
    if (s.stage !== 'RAW_INTAKE') usableIntelligence += s.usable;
    for (const reason of EXCLUSION_REASONS) total[reason] += s.excluded[reason];
  }
  return { stages, raw, usableIntelligence, excluded: total };
}

/** Fingerprint keys a stored memory holds, per stage; anything unreadable is dropped. */
export function parseFingerprintMemory(value: unknown): Partial<Record<FunnelStage, string[]>> {
  const out: Partial<Record<FunnelStage, string[]>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const stage of FUNNEL_STAGES) {
    const keys = (value as Record<string, unknown>)[stage];
    if (Array.isArray(keys)) out[stage] = keys.filter((k): k is string => typeof k === 'string');
  }
  return out;
}

/**
 * The fingerprint keys to carry to the next reading: what earlier readings counted plus what
 * this one did, most recent last, bounded per stage so one stored row stays a readable size.
 */
export function rememberFingerprints(
  prior: Partial<Record<FunnelStage, readonly string[]>>,
  input: FunnelInput,
  maxPerStage: number,
): Record<FunnelStage, string[]> {
  const out = {} as Record<FunnelStage, string[]>;
  for (const stage of FUNNEL_STAGES) {
    const keys = new Set(prior[stage] ?? []);
    for (const record of input[stage] ?? []) {
      const key = fingerprintKey(record.fingerprint);
      keys.delete(key);
      keys.add(key);
    }
    out[stage] = [...keys].slice(Math.max(0, keys.size - maxPerStage));
  }
  return out;
}
