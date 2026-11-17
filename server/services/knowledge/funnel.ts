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
  /**
   * Fingerprints an earlier reading already counted, per stage: a record carrying one is a
   * DUPLICATE here too, so a re-import across passes is not new understanding.
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
  const seen = new Set<string>(options.seen?.[stage] ?? []);
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

// ---------------------------------------------------------------------------
// The ledger: what earlier readings already counted, carried from pass to pass.
// A pass's gain is measured against the reading before it, never against an
// empty one, so "gain" is what this pass added that Brain did not already hold.
// ---------------------------------------------------------------------------

/** Fingerprints and record ids remembered per stage; the oldest are forgotten first. */
export const FUNNEL_MEMORY_PER_STAGE = 5000;

export interface FunnelLedger {
  schema: 1;
  /** Every pass so far, summed: the reading the next pass's gain is measured against. */
  cumulative: FunnelReading;
  /** The previous pass's own reading, so a pass is also compared with the one before it. */
  lastPass: FunnelReading | null;
  /** Per stage: fingerprints already counted as usable or excluded (bounded). */
  seen: Record<FunnelStage, string[]>;
  /** Per stage: record ids already counted, so a row read again by a later pass is not intake twice (bounded). */
  counted: Record<FunnelStage, string[]>;
}

export interface FunnelGain {
  raw: number;
  usableIntelligence: number;
  falseSpeed: boolean;
}

export interface FunnelAdvance {
  /** This pass's own reading, with duplicates judged against every earlier pass. */
  reading: FunnelReading;
  /** Every pass so far including this one. */
  cumulative: FunnelReading;
  /** What this pass added to the cumulative reading. */
  gain: FunnelGain;
  /** This pass against the previous pass: raw intake that sped up while usable intelligence did not is false speed. */
  versusPrevious: FunnelGain;
  /** The ledger the next pass reads. */
  ledger: FunnelLedger;
}

function stageMap<T>(make: () => T): Record<FunnelStage, T> {
  return Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, make()])) as Record<FunnelStage, T>;
}

/** A reading of nothing. */
export function emptyFunnelReading(): FunnelReading {
  return readFunnel({});
}

export function emptyFunnelLedger(): FunnelLedger {
  return { schema: 1, cumulative: emptyFunnelReading(), lastPass: null, seen: stageMap(() => []), counted: stageMap(() => []) };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** A carried reading, re-validated; anything malformed reads as nothing rather than as a favourable number. */
function readCarriedReading(raw: unknown): FunnelReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const stagesRaw = (raw as { stages?: unknown }).stages;
  if (!Array.isArray(stagesRaw)) return null;
  const stages: StageReading[] = FUNNEL_STAGES.map((stage) => {
    const one = stagesRaw.find((s) => (s as { stage?: unknown })?.stage === stage) as Partial<StageReading> | undefined;
    const excluded = emptyExclusions();
    for (const reason of EXCLUSION_REASONS) excluded[reason] = count(one?.excluded?.[reason]);
    return { stage, raw: count(one?.raw), usable: count(one?.usable), excluded };
  });
  return sumReadings([{ stages, raw: 0, usableIntelligence: 0, excluded: emptyExclusions() }]);
}

/** The ledger an earlier pass carried, or an empty one when it is absent or malformed. */
export function readFunnelLedger(raw: unknown): FunnelLedger {
  const empty = emptyFunnelLedger();
  if (!raw || typeof raw !== 'object' || (raw as { schema?: unknown }).schema !== 1) return empty;
  const r = raw as { cumulative?: unknown; lastPass?: unknown; seen?: unknown; counted?: unknown };
  const strings = (bag: unknown, stage: FunnelStage): string[] => {
    const list = (bag as Record<string, unknown> | undefined)?.[stage];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  };
  return {
    schema: 1,
    cumulative: readCarriedReading(r.cumulative) ?? empty.cumulative,
    lastPass: readCarriedReading(r.lastPass),
    seen: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, strings(r.seen, s)])) as Record<FunnelStage, string[]>,
    counted: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, strings(r.counted, s)])) as Record<FunnelStage, string[]>,
  };
}

/** Stage-by-stage sum of readings, with the totals recomputed from the stages. */
export function sumReadings(readings: readonly FunnelReading[]): FunnelReading {
  const stages: StageReading[] = FUNNEL_STAGES.map((stage) => {
    const excluded = emptyExclusions();
    let raw = 0;
    let usable = 0;
    for (const reading of readings) {
      const one = reading.stages.find((s) => s.stage === stage);
      if (!one) continue;
      raw += one.raw;
      usable += one.usable;
      for (const reason of EXCLUSION_REASONS) excluded[reason] += one.excluded[reason];
    }
    return { stage, raw, usable, excluded };
  });
  const excluded = emptyExclusions();
  let raw = 0;
  let usableIntelligence = 0;
  for (const one of stages) {
    raw += one.raw;
    if (one.stage !== 'RAW_INTAKE') usableIntelligence += one.usable;
    for (const reason of EXCLUSION_REASONS) excluded[reason] += one.excluded[reason];
  }
  return { stages, raw, usableIntelligence, excluded };
}

const remember = (held: readonly string[], added: readonly string[]): string[] => {
  const newest = new Set(added);
  const out = [...held.filter((x) => !newest.has(x)), ...newest];
  return out.length > FUNNEL_MEMORY_PER_STAGE ? out.slice(out.length - FUNNEL_MEMORY_PER_STAGE) : out;
};

/**
 * Read one pass against everything the ledger already holds. A record whose id an earlier pass counted
 * is not intake again and is left out; a record whose fingerprint an earlier pass counted is a DUPLICATE.
 * The gain is the cumulative reading after this pass minus the one before it, and the pass is also
 * compared with the previous pass, so intake that grows while understanding does not is false speed
 * whether or not this pass happened to yield something.
 */
export function advanceFunnel(ledger: FunnelLedger, input: FunnelInput, options: Omit<FunnelOptions, 'seen'> = {}): FunnelAdvance {
  const counted = stageMap(() => new Set<string>());
  for (const stage of FUNNEL_STAGES) for (const id of ledger.counted[stage]) counted[stage].add(id);
  const fresh: FunnelInput = {};
  for (const stage of FUNNEL_STAGES) fresh[stage] = (input[stage] ?? []).filter((r) => !counted[stage].has(r.id));
  const reading = readFunnel(fresh, { ...options, seen: ledger.seen });
  const cumulative = sumReadings([ledger.cumulative, reading]);
  const gain = funnelGain(ledger.cumulative, cumulative);
  const previous = ledger.lastPass ? funnelGain(ledger.lastPass, reading) : { ...gain };
  // Faster intake than the previous pass with less understanding than it is false speed too.
  const versusPrevious: FunnelGain = { ...previous, falseSpeed: previous.raw > 0 && previous.usableIntelligence < 0 };
  const next: FunnelLedger = {
    schema: 1,
    cumulative,
    lastPass: reading,
    seen: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, remember(ledger.seen[s], (fresh[s] ?? []).map((r) => r.fingerprint))])) as Record<FunnelStage, string[]>,
    counted: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, remember(ledger.counted[s], (fresh[s] ?? []).map((r) => r.id))])) as Record<FunnelStage, string[]>,
  };
  return { reading, cumulative, gain: { ...gain, falseSpeed: gain.falseSpeed || versusPrevious.falseSpeed }, versusPrevious, ledger: next };
}
