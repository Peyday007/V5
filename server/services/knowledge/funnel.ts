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
 */

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

/** Why a record is excluded, or null when it is usable. The first reason that applies is the one counted. */
function exclusionOf(record: FunnelRecord, seen: Set<string>, options: FunnelOptions): ExclusionReason | null {
  if (seen.has(record.fingerprint)) return 'DUPLICATE';
  seen.add(record.fingerprint);
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
  let usable = 0;
  for (const record of records) {
    const reason = exclusionOf(record, seen, options);
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

/**
 * Two readings added stage by stage: the previous pass's cumulative reading
 * plus this pass's. Counts are carried, not records, so a record two passes
 * both read is kept apart by the delta (an unchanged record is not read again),
 * never by this sum.
 */
export function addFunnelReadings(a: FunnelReading, b: FunnelReading): FunnelReading {
  const stages = FUNNEL_STAGES.map((stage): StageReading => {
    const x = a.stages.find((s) => s.stage === stage);
    const y = b.stages.find((s) => s.stage === stage);
    const excluded = emptyExclusions();
    for (const reason of EXCLUSION_REASONS) excluded[reason] = (x?.excluded[reason] ?? 0) + (y?.excluded[reason] ?? 0);
    return { stage, raw: (x?.raw ?? 0) + (y?.raw ?? 0), usable: (x?.usable ?? 0) + (y?.usable ?? 0), excluded };
  });
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

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** A reading as a stored row carries it, re-derived from its stage counts; null when the value is not a reading. */
export function readStoredFunnel(value: unknown): FunnelReading | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { stages?: unknown }).stages)) return null;
  const stored = (value as { stages: unknown[] }).stages;
  const stages = FUNNEL_STAGES.map((stage): StageReading => {
    const one = stored.find((s) => !!s && typeof s === 'object' && (s as { stage?: unknown }).stage === stage) as
      | { raw?: unknown; usable?: unknown; excluded?: Record<string, unknown> }
      | undefined;
    const excluded = emptyExclusions();
    for (const reason of EXCLUSION_REASONS) excluded[reason] = count(one?.excluded?.[reason]);
    return { stage, raw: count(one?.raw), usable: count(one?.usable), excluded };
  });
  return addFunnelReadings({ stages: [], raw: 0, usableIntelligence: 0, excluded: emptyExclusions() }, { stages, raw: 0, usableIntelligence: 0, excluded: emptyExclusions() });
}
