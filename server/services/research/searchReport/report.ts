/**
 * What Brain's search has actually done, read from rows.
 *
 * Nothing here is estimated: every number is a count or sum of recorded facts,
 * and a figure no row can state is null, never zero. The classification keeps
 * apart things that are easy to run together:
 *
 *  - KNOWN         every method not retired
 *  - STILL LEARNING a known method whose trust has not settled (not yet judged
 *                   enough results, or still PROPOSED/TESTING/DEMOTED)
 *  - PROVEN        stored PROVEN *and* its judged results still support it;
 *                  everything else known is UNPROVEN. These two are disjoint.
 *  - AUTOMATIC     runs on code or the cheap lane: it has recorded runs and
 *                  none by Claude, or a learned detector in ACTIVE mode
 *
 * Automatic is a separate axis from proven: a method can run without Claude and
 * still be unproven.
 */
import {
  listLearnedDetectors,
  listLearnedSubjects,
  listMethodRuns,
} from '../../../repos/searchMethods.ts';
import type { LearnedDetector, SearchMethod, SearchReader } from '../../../domain/searchIntelligence.ts';
import { DEMOTE_PRECISION } from '../searchMethods/lifecycle.ts';
import { readMethodMetrics, type MethodReading } from '../searchMetrics/read.ts';

export interface MethodLine {
  methodId: string;
  methodKey: string;
  version: number;
  finds: string;
  sources: string[];
  trustState: SearchMethod['trustState'];
  runs: number;
  /** Surfaced candidates. Volume only. */
  relevant: number;
  verified: number;
  falsePositives: number;
  /** confirmed / judged, or null until enough was judged. */
  precision: number | null;
  aiJobsConsumed: number;
  aiJobsAvoided: number;
  outcomes: Record<string, number>;
  detectors: { key: string; mode: LearnedDetector['mode'] }[];
  proven: boolean;
  stillLearning: boolean;
  automatic: boolean;
  improved: boolean;
  abandoned: boolean;
  newSinceWindow: boolean;
}

export interface SearchReport {
  generatedAt: string;
  /** Start of the window "new" is measured against; null means no window was asked for. */
  since: string | null;
  methods: MethodLine[];
  subjects: { learned: number; retired: number };
  counts: {
    known: number;
    stillLearning: number;
    automatic: number;
    proven: number;
    unproven: number;
    retired: number;
  };
  /** Methods first recorded inside the window; null when no window was asked for. */
  newMethodsResearched: string[] | null;
  /** Every distinct source across known methods. */
  sources: string[];
  /** Methods with a learned detector, by detector mode. */
  turnedIntoCode: { methodKey: string; detectorKey: string; mode: LearnedDetector['mode'] }[];
  results: { relevant: number; verified: number; falsePositives: number };
  /** Runs done without a Claude activation, against those that used one. */
  aiUsage: { avoided: number; consumed: number };
  improved: string[];
  abandoned: string[];
  /** Opportunities that went on to qualify, where a downstream reading exists; null otherwise. */
  newOpportunities: number | null;
}

function line(
  reading: MethodReading,
  runs: { executor: string }[],
  detectors: LearnedDetector[],
  since: string | null,
): MethodLine {
  const { method, metrics, trust } = reading;
  const retired = method.trustState === 'RETIRED';
  const proven =
    method.trustState === 'PROVEN' && trust.sufficient && trust.precision !== null && trust.precision >= DEMOTE_PRECISION;
  const active = detectors.some((d) => d.mode === 'ACTIVE');
  const noClaude = runs.length > 0 && runs.every((r) => r.executor !== 'CLAUDE');
  return {
    methodId: method.id,
    methodKey: method.methodKey,
    version: method.version,
    finds: method.finds,
    sources: method.sources,
    trustState: method.trustState,
    runs: metrics.runs,
    relevant: metrics.relevant,
    verified: metrics.verified,
    falsePositives: metrics.falsePositives,
    precision: trust.precision,
    aiJobsConsumed: metrics.aiJobsConsumed,
    aiJobsAvoided: metrics.aiJobsAvoided,
    outcomes: { ...metrics.outcomes },
    detectors: detectors.map((d) => ({ key: d.detectorKey, mode: d.mode })),
    proven,
    stillLearning: !retired && !proven && (method.trustState === 'PROPOSED' || method.trustState === 'TESTING' || !trust.sufficient),
    automatic: !retired && (active || noClaude),
    improved: method.version > 1,
    abandoned: method.trustState === 'RETIRED' || method.trustState === 'DEMOTED',
    newSinceWindow: since !== null && method.createdAt >= since,
  };
}

export async function buildSearchReport(
  reader: SearchReader,
  opts: {
    now?: string;
    since?: string | null;
    /** Downstream outcomes keyed by method key, where another module measures them (e.g. cash buckets). */
    downstream?: ReadonlyMap<string, { useful: number; qualified: number; duplicates?: number }>;
  } = {},
): Promise<SearchReport> {
  const since = opts.since ?? null;
  const readings = await readMethodMetrics(reader, opts.downstream ? { downstream: opts.downstream } : {});
  const detectors = await listLearnedDetectors(reader);
  const byMethod = new Map<string, LearnedDetector[]>();
  for (const d of detectors) {
    if (!d.methodId) continue;
    byMethod.set(d.methodId, [...(byMethod.get(d.methodId) ?? []), d]);
  }
  const methods: MethodLine[] = [];
  for (const reading of readings) {
    const runs = await listMethodRuns(reader, reading.method.id);
    methods.push(line(reading, runs, byMethod.get(reading.method.id) ?? [], since));
  }
  const known = methods.filter((m) => m.trustState !== 'RETIRED');
  const keyOf = new Map(readings.map((r) => [r.method.id, r.method.methodKey]));
  const subjects = await listLearnedSubjects(reader, { includeRetired: true });
  const qualified = readings
    .map((r) => r.metrics.validatedOpportunities)
    .filter((n): n is number => n !== null);
  return {
    generatedAt: opts.now ?? new Date().toISOString(),
    since,
    methods,
    subjects: { learned: subjects.filter((s) => s.state === 'ACTIVE').length, retired: subjects.filter((s) => s.state === 'RETIRED').length },
    counts: {
      known: known.length,
      stillLearning: known.filter((m) => m.stillLearning).length,
      automatic: known.filter((m) => m.automatic).length,
      proven: known.filter((m) => m.proven).length,
      unproven: known.filter((m) => !m.proven).length,
      retired: methods.length - known.length,
    },
    newMethodsResearched: since === null ? null : methods.filter((m) => m.newSinceWindow).map((m) => m.methodKey),
    sources: [...new Set(known.flatMap((m) => m.sources))].sort(),
    turnedIntoCode: detectors
      .filter((d) => d.methodId && keyOf.has(d.methodId))
      .map((d) => ({ methodKey: keyOf.get(d.methodId!)!, detectorKey: d.detectorKey, mode: d.mode })),
    results: {
      relevant: methods.reduce((n, m) => n + m.relevant, 0),
      verified: methods.reduce((n, m) => n + m.verified, 0),
      falsePositives: methods.reduce((n, m) => n + m.falsePositives, 0),
    },
    aiUsage: {
      avoided: methods.reduce((n, m) => n + m.aiJobsAvoided, 0),
      consumed: methods.reduce((n, m) => n + m.aiJobsConsumed, 0),
    },
    improved: methods.filter((m) => m.improved).map((m) => m.methodKey),
    abandoned: methods.filter((m) => m.abandoned).map((m) => m.methodKey),
    newOpportunities: qualified.length > 0 ? qualified.reduce((a, b) => a + b, 0) : null,
  };
}

/** The report as plain lines, for a terminal or a workflow log. */
export function renderSearchReport(report: SearchReport): string {
  const c = report.counts;
  const out = [
    `SEARCH REPORT ${report.generatedAt}`,
    `methods known ${c.known} · still learning ${c.stillLearning} · automatic ${c.automatic} · proven ${c.proven} · unproven ${c.unproven} · retired ${c.retired}`,
    `learned subjects ${report.subjects.learned} (${report.subjects.retired} retired)`,
    report.newMethodsResearched === null
      ? 'new methods researched: no window asked for'
      : `new methods researched since ${report.since}: ${report.newMethodsResearched.length}${report.newMethodsResearched.length ? ` (${report.newMethodsResearched.join(', ')})` : ''}`,
    `sources: ${report.sources.length ? report.sources.join(', ') : 'none'}`,
    `turned into code: ${report.turnedIntoCode.length ? report.turnedIntoCode.map((d) => `${d.detectorKey} [${d.mode}]`).join(', ') : 'none'}`,
    `results: ${report.results.relevant} surfaced, ${report.results.verified} verified, ${report.results.falsePositives} rejected`,
    `Claude: ${report.aiUsage.consumed} runs used it, ${report.aiUsage.avoided} did not`,
    `improved: ${report.improved.join(', ') || 'none'} · abandoned: ${report.abandoned.join(', ') || 'none'}`,
    `new opportunities: ${report.newOpportunities === null ? 'not measured' : report.newOpportunities}`,
  ];
  for (const m of report.methods) {
    const flags = [m.proven ? 'proven' : 'unproven', m.stillLearning ? 'learning' : null, m.automatic ? 'automatic' : null].filter(Boolean).join(', ');
    out.push(`  ${m.methodKey} v${m.version} ${m.trustState} (${flags}) runs ${m.runs}, verified ${m.verified}, rejected ${m.falsePositives}, precision ${m.precision === null ? 'not yet' : m.precision.toFixed(2)}`);
  }
  return out.join('\n');
}
