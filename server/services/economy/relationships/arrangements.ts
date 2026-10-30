/**
 * Different ways of being paid for the same underlying need, compared.
 *
 * Direct sale, brokerage, subcontract, referral and resale put the operator in
 * different roles with different money at risk. This compares them on facts
 * already stored as variables and on nothing else: no score and no weights,
 * because weights are a judgement nobody made. The order is lexicographic and
 * the first criterion two arrangements differ on is the stated reason.
 *
 * An arrangement whose figures are not established is not "worth zero": it
 * sorts after every one that is known, and says what is missing.
 */
import { activityModelInputs, normalName } from './variables.ts';
import { currentVariables } from '../../../repos/economy.ts';
import type { ActivityVariable, OperatorKind } from '../../../domain/economy.ts';
import type { VariableProvenance } from '../../../domain/scenario.ts';

export const ARRANGEMENTS = ['DIRECT_SALE', 'BROKERAGE', 'SUBCONTRACT', 'REFERRAL', 'RESALE'] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export interface ArrangementReading {
  arrangement: Arrangement;
  activityRef: string;
  /** Whole currency units we keep per transaction: revenue × margin. Null while either half is unestablished. */
  netPerDeal: number | null;
  /** Money the operator must have out before it pays back, in the same units. */
  capital: number | null;
  daysToCash: number | null;
  /** The weakest provenance among the readings the net rests on. */
  netProvenance: VariableProvenance | 'UNKNOWN';
  missing: string[];
}

export interface ArrangementComparison {
  /** Best first. */
  ordered: ArrangementReading[];
  /** Why each arrangement sits where it does, against the one above it. */
  reasons: Record<string, string>;
}

const WEAKNESS: Record<VariableProvenance, number> = { EVIDENCE: 0, HISTORICAL: 0, ASSUMPTION: 1, HYPOTHETICAL: 2, UNKNOWN: 3 };

function weakest(a: VariableProvenance, b: VariableProvenance): VariableProvenance {
  return WEAKNESS[a] >= WEAKNESS[b] ? a : b;
}

function marginFraction(variables: readonly ActivityVariable[], operatorKind: OperatorKind): { value: number; provenance: VariableProvenance } | null {
  const v = variables.find((x) => x.operatorKind === operatorKind && normalName(x.name) === 'margin');
  if (!v || v.status === 'UNKNOWN' || v.value === null) return null;
  const unit = (v.unit ?? '').trim().toLowerCase();
  const value = unit === 'percent' || unit === '%' ? v.value / 100 : unit === 'fraction' || unit === 'ratio' ? v.value : null;
  if (value === null || value < 0 || value > 1) return null;
  return { value, provenance: v.status === 'VERIFIED' ? 'EVIDENCE' : 'ASSUMPTION' };
}

/** Pure: one arrangement's reading from the goal-model inputs and the margin. */
export function readArrangement(
  arrangement: Arrangement, activityRef: string,
  inputs: Awaited<ReturnType<typeof activityModelInputs>>,
  margin: ReturnType<typeof marginFraction>,
): ArrangementReading {
  const missing: string[] = [];
  const price = inputs.price?.value ?? null;
  if (price === null) missing.push('revenue per transaction');
  if (margin === null) missing.push('margin');
  const net = price !== null && margin !== null ? Math.round(price * margin.value * 100) / 100 : null;
  const netProvenance: VariableProvenance = net === null || !inputs.price || !margin
    ? 'UNKNOWN' : weakest(inputs.price.provenance, margin.provenance);
  const capital = inputs.capital?.value ?? null;
  const daysToCash = inputs.daysToCash?.value ?? null;
  if (capital === null) missing.push('upfront capital');
  if (daysToCash === null) missing.push('payment timing');
  return { arrangement, activityRef, netPerDeal: net, capital, daysToCash, netProvenance, missing };
}

/** Known beats unknown; then lower is better for capital and days, higher for net. Ties fall to the arrangement name, for determinism only. */
const CRITERIA: { name: string; compare: (a: ArrangementReading, b: ArrangementReading) => number; label: string }[] = [
  { name: 'net', label: 'it keeps more per transaction', compare: (a, b) => cmpNullLast(a.netPerDeal === null ? null : -a.netPerDeal, b.netPerDeal === null ? null : -b.netPerDeal) },
  { name: 'capital', label: 'it needs less money out first', compare: (a, b) => cmpNullLast(a.capital, b.capital) },
  { name: 'days', label: 'it pays sooner', compare: (a, b) => cmpNullLast(a.daysToCash, b.daysToCash) },
];

function cmpNullLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function compareReadings(readings: readonly ArrangementReading[]): ArrangementComparison {
  const ordered = [...readings].sort((a, b) => {
    for (const c of CRITERIA) {
      const d = c.compare(a, b);
      if (d !== 0) return d;
    }
    return a.arrangement.localeCompare(b.arrangement);
  });
  const reasons: Record<string, string> = {};
  ordered.forEach((r, i) => {
    if (i === 0) { reasons[r.arrangement] = 'First: nothing above it to compare against.'; return; }
    const above = ordered[i - 1]!;
    const decided = CRITERIA.find((c) => c.compare(above, r) !== 0);
    reasons[r.arrangement] = decided
      ? `Below ${above.arrangement} because ${decided.label.replace(/^it /, above.arrangement + ' ')}, or because that figure is established there and not here.`
      : `Level with ${above.arrangement} on every compared figure; placed by name only.`;
  });
  return { ordered, reasons };
}

/**
 * Compare the arrangements for one need. `activities` maps each arrangement to
 * the activity whose variables describe it; arrangements not listed are not
 * compared, and nothing is assumed for them.
 */
export async function compareArrangements(input: {
  projectId: string; operatorKind: OperatorKind; activities: Partial<Record<Arrangement, string>>;
}): Promise<ArrangementComparison> {
  const readings: ArrangementReading[] = [];
  for (const arrangement of ARRANGEMENTS) {
    const ref = input.activities[arrangement];
    if (!ref) continue;
    const [inputs, variables] = await Promise.all([
      activityModelInputs(input.projectId, ref, input.operatorKind),
      currentVariables(input.projectId, ref),
    ]);
    readings.push(readArrangement(arrangement, ref, inputs, marginFraction(variables, input.operatorKind)));
  }
  return compareReadings(readings);
}
