/**
 * An estimate, handed to the scenario engine without overstating it.
 *
 * Only an estimate whose every leaf is evidence (DIRECT, COMPARABLE, or a
 * COMPONENT rebuilt entirely from those) may become a distribution, and it
 * becomes an EMPIRICAL one built from its own quantiles — so the engine samples
 * exactly the shape the reconstruction produced, skew and all, rather than a
 * normal fitted to it. Everything else becomes a RANGE, which the engine
 * sweeps: a plan resting on it is coverage of tested conditions, and §77's
 * gate refuses to call it a probability.
 */
import { DISTRIBUTION_TIERS, type Estimate } from '../../domain/quant.ts';
import type { SourceRef, VariableProvenance, VariableSpec } from '../../domain/scenario.ts';

/** Model learning (LEARN-15-1) is reached from the same entry the scenario engine uses for estimates. */
export { assessModelLearning } from './learning.ts';
export { forecastAndRecordCash, recordCashForecast, assessLedger, recordExposure, recordOutcome, recordPrediction, dealSignals, REASON_SIGNAL } from './ledger.ts';

/** Quantiles kept when an estimate becomes an empirical distribution. */
export const EXPORT_QUANTILES = 101;

export interface ExportedInput {
  provenance: VariableProvenance;
  spec: VariableSpec;
  sources: SourceRef[];
  note: string;
}

export function justifiesDistribution(est: Pick<Estimate, 'tier' | 'distributionJustified'>): boolean {
  return est.distributionJustified && DISTRIBUTION_TIERS.includes(est.tier);
}

export function describeEstimate(est: Estimate): string {
  const round = (x: number) => (Math.abs(x) < 1 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : String(Math.round(x)));
  return `${est.contested ? `CONTESTED (${est.contested.reason}) ` : ''}${est.tier.toLowerCase()} estimate, p10 ${round(est.p10)} · p50 ${round(est.p50)} · p90 ${round(est.p90)} ${est.unit} from ${est.used.length} observation(s)${est.collapsed.length ? `, ${est.collapsed.length} shared-data group(s) counted once` : ''}`;
}

/**
 * What an inferred input carries forward about the evidence behind it (Q2-1,
 * Q2-2): independent populations, those with a stated sample, and the events
 * its predictive distribution is worth. One representation, read by the plan's
 * chain links and by the assurance alike, so a link and a probability can
 * never disagree about what the same estimate rests on.
 */
export interface InputSample {
  events: number;
  populations: number;
  sizedPopulations: number;
  /** Its sized sources contradict each other (L-1): never establishes, never verifies. */
  contested?: string;
}

export function inputSample(est: Pick<Estimate, 'populations' | 'sizedPopulations' | 'events' | 'distributionJustified' | 'tier' | 'contested'>): InputSample {
  return { events: justifiesDistribution(est) ? (est.events ?? 0) : 0, populations: est.populations ?? 0, sizedPopulations: est.sizedPopulations ?? 0, ...(est.contested ? { contested: est.contested.reason } : {}) };
}

/**
 * Exports already made, by estimate (W2c, 2026-11-17). An estimate is read,
 * never changed, once reconstructed, and one estimate in a context is shared
 * by every opening and arrangement in it — so the sort of its samples is done
 * once, not once per reader: 400 arrangements re-sorted the same samples for
 * each of seven inputs.
 */
const exportedCache = new WeakMap<Estimate, ExportedInput>();

/** The engine's input for an estimate. */
export function toScenarioInput(est: Estimate): ExportedInput {
  const hit = exportedCache.get(est);
  if (hit) return hit;
  const out = exportOf(est);
  exportedCache.set(est, out);
  return out;
}

/**
 * The input for an estimate read in other units (`scale` > 0, e.g. a share of
 * a price into money): exactly `toScenarioInput` of the scaled estimate, from
 * the unscaled export, so the samples are not copied and sorted again.
 * `scaled` is the estimate with its quantiles already scaled. Pure.
 */
export function toScenarioInputScaled(est: Estimate, scaled: Estimate, scale: number): ExportedInput {
  if (scale === 1 || !(scale > 0)) return toScenarioInput(scale === 1 ? est : { ...scaled, samples: est.samples.map((x) => x * scale) });
  const base = toScenarioInput(est);
  const note = describeEstimate(scaled);
  if (base.spec.kind === 'EMPIRICAL') return { ...base, spec: { kind: 'EMPIRICAL', values: base.spec.values.map((x) => x * scale) }, note };
  const min = Math.min(scaled.p05, scaled.p95);
  const max = Math.max(scaled.p05, scaled.p95, min + 1e-9);
  return { ...base, spec: { kind: 'RANGE', min, max }, note: `${note}; bounds only` };
}

function exportOf(est: Estimate): ExportedInput {
  const sources = dedupe(est.sources).slice(0, 12);
  const note = describeEstimate(est);
  if (justifiesDistribution(est) && est.samples.length > 0) {
    const sorted = [...est.samples].sort((a, b) => a - b);
    const values: number[] = [];
    for (let i = 0; i < EXPORT_QUANTILES; i++) {
      const p = (i + 0.5) / EXPORT_QUANTILES;
      values.push(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);
    }
    return { provenance: 'EVIDENCE', spec: { kind: 'EMPIRICAL', values }, sources, note };
  }
  const min = Math.min(est.p05, est.p95);
  const max = Math.max(est.p05, est.p95, min + 1e-9);
  return { provenance: est.tier === 'ASSUMED' ? 'ASSUMPTION' : 'UNKNOWN', spec: { kind: 'RANGE', min, max }, sources, note: `${note}; bounds only` };
}

function dedupe(list: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return list.filter((one) => {
    const key = `${one.kind}:${one.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
