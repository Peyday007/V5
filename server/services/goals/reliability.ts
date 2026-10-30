/**
 * Reliability engineering for a serious candidate plan.
 *
 * Pure arithmetic over what the plan and the evidence already say; it reads no
 * rows, calls no model and starts no research.
 *
 *   1. `deriveFailurePaths` finds the ways the plan can fail: customer
 *      acquisition, a single customer, a supplier or worker failing, upfront
 *      exposure, payment arriving late, and capacity. A path is derived only
 *      from a fact the plan states.
 *   2. `proposeProtections` names a concrete protection for a path only when
 *      the evidence catalogue holds one (an alternative supplier, a second
 *      customer source, a deposit, backup capacity, a compatible second path),
 *      each carrying its evidence id. A path with no evidenced protection is
 *      reported as such with the question that would settle it; nothing is
 *      invented.
 *   3. `rebuildPlan` returns a new plan with the accepted protections applied
 *      and the evidence recorded on it, so an improvement is a rebuilt plan
 *      rather than more research piled on.
 *   4. `testSetbacks` tests every plausible setback alone and every pair of
 *      them together, and says how many meet the target. It states counts of
 *      what was tested and never a probability.
 */

export interface PlanCustomer { id: string; shareOfRevenue: number; evidenceId?: string }
export interface PlanSupplier {
  id: string;
  /** What share of delivery depends on it. */
  shareOfDelivery: number;
  /** Alternatives that evidence names for it. */
  alternativeIds: string[];
}

export interface CandidatePlan {
  id: string;
  targetCents: number;
  daysLeft: number;
  expectedRevenueCents: number;
  directCostsCents: number;
  customers: PlanCustomer[];
  suppliers: PlanSupplier[];
  /** Cash out before any comes back. */
  upfrontCents: number;
  capitalCeilingCents: number | null;
  /** Days from now until revenue is usable. Null when no source states it. */
  paymentDays: number | null;
  capacityUnits: number | null;
  neededUnits: number | null;
  /** Evidence ids the plan already rests on. */
  evidence: string[];
}

export interface EvidenceCatalogue {
  alternativeSuppliers: Array<{ supplierId: string; alternativeId: string; evidenceId: string }>;
  customerSources: Array<{ id: string; shareOfRevenue: number; evidenceId: string }>;
  deposit: { fraction: number; evidenceId: string } | null;
  backupCapacity: { units: number; evidenceId: string } | null;
  compatiblePaths: Array<{ id: string; revenueCents: number; evidenceId: string }>;
}

export const FAILURE_KINDS = [
  'CUSTOMER_ACQUISITION', 'SINGLE_CUSTOMER', 'SUPPLIER_OR_WORKER_FAILURE', 'UPFRONT_EXPOSURE', 'PAYMENT_DELAY', 'CAPACITY',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface FailurePath {
  kind: FailureKind;
  /** The plan fact that makes this a path, in words. */
  because: string;
  /** The subject it concerns (a customer or supplier id), when one. */
  subject: string | null;
  revenueAtRiskCents: number;
}

/** A customer holding at least this share is a single point of failure. */
export const SINGLE_CUSTOMER_SHARE = 0.5;
/** Fewer independent customers than this leaves acquisition a single throw. */
export const MIN_CUSTOMERS = 2;

const round = (n: number): number => Math.round(n);

export function deriveFailurePaths(plan: CandidatePlan): FailurePath[] {
  const paths: FailurePath[] = [];
  const revenue = plan.expectedRevenueCents;
  if (plan.customers.length < MIN_CUSTOMERS) {
    paths.push({ kind: 'CUSTOMER_ACQUISITION', because: `the plan rests on ${plan.customers.length} customer source(s)`, subject: null, revenueAtRiskCents: revenue });
  }
  for (const c of plan.customers) {
    if (c.shareOfRevenue >= SINGLE_CUSTOMER_SHARE) {
      paths.push({
        kind: 'SINGLE_CUSTOMER', because: `${c.id} supplies ${Math.round(c.shareOfRevenue * 100)}% of expected revenue`,
        subject: c.id, revenueAtRiskCents: round(revenue * c.shareOfRevenue),
      });
    }
  }
  for (const s of plan.suppliers) {
    if (s.alternativeIds.length === 0) {
      paths.push({
        kind: 'SUPPLIER_OR_WORKER_FAILURE', because: `${s.id} carries ${Math.round(s.shareOfDelivery * 100)}% of delivery and no alternative is named`,
        subject: s.id, revenueAtRiskCents: round(revenue * s.shareOfDelivery),
      });
    }
  }
  if (plan.upfrontCents > 0) {
    const over = plan.capitalCeilingCents !== null && plan.upfrontCents > plan.capitalCeilingCents;
    paths.push({
      kind: 'UPFRONT_EXPOSURE', subject: null, revenueAtRiskCents: plan.upfrontCents,
      because: `${plan.upfrontCents} cents goes out before any comes back${over ? ', over the capital ceiling' : ''}`,
    });
  }
  if (plan.paymentDays === null) {
    paths.push({ kind: 'PAYMENT_DELAY', because: 'when payment arrives is not established', subject: null, revenueAtRiskCents: revenue });
  } else if (plan.paymentDays >= plan.daysLeft * 0.5) {
    paths.push({ kind: 'PAYMENT_DELAY', because: `payment arrives in ${plan.paymentDays} of ${plan.daysLeft} days`, subject: null, revenueAtRiskCents: revenue });
  }
  if (plan.capacityUnits === null || plan.neededUnits === null) {
    paths.push({ kind: 'CAPACITY', because: 'capacity or the amount needed is not established', subject: null, revenueAtRiskCents: revenue });
  } else if (plan.capacityUnits < plan.neededUnits * 1.25) {
    paths.push({ kind: 'CAPACITY', because: `capacity ${plan.capacityUnits} against ${plan.neededUnits} needed leaves under 25% headroom`, subject: null, revenueAtRiskCents: revenue });
  }
  return paths;
}

export type ProtectionKind = 'ALTERNATIVE_SUPPLIER' | 'SECOND_CUSTOMER_SOURCE' | 'DEPOSIT_OR_PAYMENT_TERMS' | 'BACKUP_CAPACITY' | 'COMBINE_COMPATIBLE_PATH';

export interface Protection {
  kind: ProtectionKind;
  answers: FailurePath;
  evidenceId: string;
  /** What it changes, for the rebuild. */
  detail: Record<string, string | number>;
}
export interface UnprotectedPath { path: FailurePath; question: string }

const QUESTION: Record<FailureKind, string> = {
  CUSTOMER_ACQUISITION: 'Where else are buyers for this published, and how many?',
  SINGLE_CUSTOMER: 'Which other buyer takes the same thing, and what share could they give?',
  SUPPLIER_OR_WORKER_FAILURE: 'Who else supplies or does this work, and at what price?',
  UPFRONT_EXPOSURE: 'Can a deposit or staged payment be taken before the money goes out?',
  PAYMENT_DELAY: 'What payment term does the buyer publish?',
  CAPACITY: 'What backup capacity exists, and what does it cost?',
};

export function proposeProtections(
  paths: readonly FailurePath[],
  catalogue: EvidenceCatalogue,
): { protections: Protection[]; unprotected: UnprotectedPath[] } {
  const protections: Protection[] = [];
  const unprotected: UnprotectedPath[] = [];
  for (const path of paths) {
    let found = false;
    if (path.kind === 'SUPPLIER_OR_WORKER_FAILURE') {
      for (const a of catalogue.alternativeSuppliers.filter((x) => x.supplierId === path.subject)) {
        protections.push({ kind: 'ALTERNATIVE_SUPPLIER', answers: path, evidenceId: a.evidenceId, detail: { supplierId: a.supplierId, alternativeId: a.alternativeId } });
        found = true;
      }
    }
    if (path.kind === 'SINGLE_CUSTOMER' || path.kind === 'CUSTOMER_ACQUISITION') {
      for (const s of catalogue.customerSources) {
        protections.push({ kind: 'SECOND_CUSTOMER_SOURCE', answers: path, evidenceId: s.evidenceId, detail: { customerId: s.id, shareOfRevenue: s.shareOfRevenue } });
        found = true;
      }
    }
    if ((path.kind === 'UPFRONT_EXPOSURE' || path.kind === 'PAYMENT_DELAY') && catalogue.deposit) {
      protections.push({ kind: 'DEPOSIT_OR_PAYMENT_TERMS', answers: path, evidenceId: catalogue.deposit.evidenceId, detail: { fraction: catalogue.deposit.fraction } });
      found = true;
    }
    if (path.kind === 'CAPACITY' && catalogue.backupCapacity) {
      protections.push({ kind: 'BACKUP_CAPACITY', answers: path, evidenceId: catalogue.backupCapacity.evidenceId, detail: { units: catalogue.backupCapacity.units } });
      found = true;
    }
    if (path.kind !== 'UPFRONT_EXPOSURE') {
      for (const c of catalogue.compatiblePaths) {
        protections.push({ kind: 'COMBINE_COMPATIBLE_PATH', answers: path, evidenceId: c.evidenceId, detail: { pathId: c.id, revenueCents: c.revenueCents } });
        found = true;
      }
    }
    if (!found) unprotected.push({ path, question: QUESTION[path.kind] });
  }
  return { protections, unprotected };
}

/**
 * Apply accepted protections and return a rebuilt plan. The input is not
 * changed. A protection changes only what it states: an alternative supplier
 * names the alternative; a second customer source adds a customer and dilutes
 * the others by the share it brings; a deposit cuts the upfront exposure and
 * brings payment forward by its own fraction; backup capacity adds units; a
 * compatible path adds its revenue as a further customer.
 */
export function rebuildPlan(plan: CandidatePlan, accepted: readonly Protection[]): CandidatePlan {
  const next: CandidatePlan = {
    ...plan,
    customers: plan.customers.map((c) => ({ ...c })),
    suppliers: plan.suppliers.map((s) => ({ ...s, alternativeIds: [...s.alternativeIds] })),
    evidence: [...plan.evidence],
  };
  const seen = new Set<string>();
  for (const p of accepted) {
    const key = `${p.kind}:${JSON.stringify(p.detail)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.kind === 'ALTERNATIVE_SUPPLIER') {
      const s = next.suppliers.find((x) => x.id === p.detail.supplierId);
      if (s && !s.alternativeIds.includes(String(p.detail.alternativeId))) s.alternativeIds.push(String(p.detail.alternativeId));
    } else if (p.kind === 'SECOND_CUSTOMER_SOURCE') {
      const share = Number(p.detail.shareOfRevenue);
      if (!next.customers.some((c) => c.id === p.detail.customerId) && share > 0 && share < 1) {
        for (const c of next.customers) c.shareOfRevenue *= 1 - share;
        next.customers.push({ id: String(p.detail.customerId), shareOfRevenue: share, evidenceId: p.evidenceId });
      }
    } else if (p.kind === 'DEPOSIT_OR_PAYMENT_TERMS') {
      const f = Math.min(1, Math.max(0, Number(p.detail.fraction)));
      next.upfrontCents = round(next.upfrontCents * (1 - f));
      if (next.paymentDays !== null) next.paymentDays = round(next.paymentDays * (1 - f));
    } else if (p.kind === 'BACKUP_CAPACITY') {
      next.capacityUnits = (next.capacityUnits ?? 0) + Number(p.detail.units);
    } else {
      const add = Number(p.detail.revenueCents);
      const total = next.expectedRevenueCents + add;
      if (add > 0 && !next.customers.some((c) => c.id === p.detail.pathId)) {
        for (const c of next.customers) c.shareOfRevenue = (c.shareOfRevenue * next.expectedRevenueCents) / total;
        next.customers.push({ id: String(p.detail.pathId), shareOfRevenue: add / total, evidenceId: p.evidenceId });
        next.expectedRevenueCents = total;
      }
    }
    if (!next.evidence.includes(p.evidenceId)) next.evidence.push(p.evidenceId);
  }
  return next;
}

export type Setback =
  | { kind: 'LOSE_CUSTOMER'; customerId: string }
  | { kind: 'SUPPLIER_FAILS'; supplierId: string }
  | { kind: 'PAYMENT_LATE'; extraDays: number }
  | { kind: 'CAPACITY_SHORT'; fraction: number }
  | { kind: 'UPFRONT_LOST' };

const label = (s: Setback): string =>
  s.kind === 'LOSE_CUSTOMER' ? `LOSE_CUSTOMER:${s.customerId}` : s.kind === 'SUPPLIER_FAILS' ? `SUPPLIER_FAILS:${s.supplierId}`
    : s.kind === 'PAYMENT_LATE' ? `PAYMENT_LATE:${s.extraDays}` : s.kind === 'CAPACITY_SHORT' ? `CAPACITY_SHORT:${s.fraction}` : 'UPFRONT_LOST';

/**
 * Contribution counted toward the goal under a set of setbacks, in cents.
 * Revenue that arrives after the deadline is not counted, and an unknown
 * payment time counts nothing: an unknown is never a favourable assumption.
 */
export function contributionUnder(plan: CandidatePlan, setbacks: readonly Setback[]): number {
  let revenue = plan.expectedRevenueCents;
  let paymentDays = plan.paymentDays;
  let capacity = plan.capacityUnits;
  let upfrontLost = 0;
  for (const s of setbacks) {
    if (s.kind === 'LOSE_CUSTOMER') {
      const c = plan.customers.find((x) => x.id === s.customerId);
      if (c) revenue -= plan.expectedRevenueCents * c.shareOfRevenue;
    } else if (s.kind === 'SUPPLIER_FAILS') {
      const sup = plan.suppliers.find((x) => x.id === s.supplierId);
      if (sup && sup.alternativeIds.length === 0) revenue -= plan.expectedRevenueCents * sup.shareOfDelivery;
    } else if (s.kind === 'PAYMENT_LATE') {
      if (paymentDays !== null) paymentDays += s.extraDays;
    } else if (s.kind === 'CAPACITY_SHORT') {
      if (capacity !== null) capacity *= 1 - s.fraction;
    } else {
      upfrontLost = plan.upfrontCents;
    }
  }
  if (capacity !== null && plan.neededUnits !== null && plan.neededUnits > 0) {
    revenue *= Math.min(1, capacity / plan.neededUnits);
  }
  if (paymentDays === null || paymentDays > plan.daysLeft) revenue = 0;
  return round(revenue - plan.directCostsCents - upfrontLost);
}

export interface SetbackResult { setbacks: string[]; contributionCents: number; meetsTarget: boolean }
export interface SetbackTest {
  tested: number;
  singles: SetbackResult[];
  combined: SetbackResult[];
  meetingTarget: number;
  /** The lowest contribution found, and what caused it. */
  worst: SetbackResult | null;
  /** Counts of what was tested; this is not a probability. */
  note: string;
}

/** Every plausible setback alone, and every pair of them together. */
export function testSetbacks(plan: CandidatePlan, plausible: readonly Setback[]): SetbackTest {
  const run = (set: readonly Setback[]): SetbackResult => {
    const c = contributionUnder(plan, set);
    return { setbacks: set.map(label), contributionCents: c, meetsTarget: c >= plan.targetCents };
  };
  const singles = plausible.map((s) => run([s]));
  const combined: SetbackResult[] = [];
  for (let i = 0; i < plausible.length; i += 1) {
    for (let j = i + 1; j < plausible.length; j += 1) combined.push(run([plausible[i]!, plausible[j]!]));
  }
  const all = [...singles, ...combined];
  const worst = all.reduce<SetbackResult | null>((w, r) => (w === null || r.contributionCents < w.contributionCents ? r : w), null);
  return {
    tested: all.length, singles, combined, meetingTarget: all.filter((r) => r.meetsTarget).length, worst,
    note: `${all.filter((r) => r.meetsTarget).length} of ${all.length} tested setbacks still meet the target. These are counts of cases tested, not a probability.`,
  };
}

/** Improve a plan with every evidenced protection and report what changed and what remains open. */
export function improvePlan(plan: CandidatePlan, catalogue: EvidenceCatalogue, plausible: readonly Setback[]): {
  before: SetbackTest; after: SetbackTest; rebuilt: CandidatePlan; applied: Protection[]; unprotected: UnprotectedPath[];
} {
  const { protections, unprotected } = proposeProtections(deriveFailurePaths(plan), catalogue);
  const rebuilt = rebuildPlan(plan, protections);
  return { before: testSetbacks(plan, plausible), after: testSetbacks(rebuilt, plausible), rebuilt, applied: protections, unprotected };
}

