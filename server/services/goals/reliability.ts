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


/*
 * The plan's use of all of the above (F3: the rebuild was never called).
 *
 * `readGoalPlan` hands each serious candidate strategy here as plain facts it
 * already holds — its members, what each brings, who fulfils it, when it pays,
 * what it ties up — together with the other openings it judged. Failure paths
 * are derived from those facts, protections are proposed only from openings
 * whose own rows establish them, every evidenced protection is accepted and the
 * plan is rebuilt, and single and combined setbacks are tested on the plan
 * before and after. The result is stored on the strategy in the plan reading,
 * so an accepted improvement is part of the stored reading and of its evidence,
 * and a changed improvement is a changed reading. Pure: no rows, no model, no
 * research.
 */

/** One member of a strategy, as the plan holds it. Money in cents. */
export interface StrategyMemberFacts {
  opportunityId: string;
  /** What it is counted to bring toward the goal. */
  revenueCents: number;
  /** A named fulfiller other than Brain, when a source or a person says so. */
  fulfilledBy: string | null;
  /** Established days until its money is usable; null when not established. */
  daysToCash: number | null;
  /** The claim the opening rests on, when one. */
  claimId: string | null;
}

export interface StrategyFacts {
  key: string;
  targetCents: number;
  daysLeft: number;
  members: StrategyMemberFacts[];
  directCostsCents: number;
  upfrontCents: number;
  capitalCeilingCents: number | null;
  capacityHours: number | null;
  neededHours: number | null;
  /**
   * Whether every figure above rests on established numbers. When it does not,
   * the setback counts are still reported, and say on what they were computed.
   */
  basis: 'CONSERVATIVE' | 'BEST_CASE_AT_SUPPORTED_PRICE';
}

/** Another opening the plan judged, whose own rows establish a buyer, a dated need and a price buyers pay. */
export interface CompatibleOpening {
  opportunityId: string;
  /** What one sale of it brings, at a price buyers are shown to pay (or what a buyer agreed). */
  revenueCents: number;
}

export interface ReliabilityReading {
  basis: StrategyFacts['basis'];
  failurePaths: { kind: FailureKind; because: string; subject: string | null; revenueAtRiskCents: number }[];
  /** Every evidenced protection, accepted into the rebuilt plan. */
  applied: { kind: ProtectionKind; answers: FailureKind; subject: string | null; evidenceId: string; detail: Record<string, string | number> }[];
  /** Paths no evidence protects yet, with the question that would settle each. */
  unprotected: { kind: FailureKind; subject: string | null; question: string }[];
  before: { tested: number; meetingTarget: number; worst: SetbackResult | null; note: string };
  after: { tested: number; meetingTarget: number; worst: SetbackResult | null; note: string };
  /**
   * Every combination of two or more plausible setbacks tested on the rebuilt
   * plan, and whether the target was still met under it — what a goal policy's
   * combined-setback test reads. Counts of cases, never a probability.
   */
  combinedAfter: { setbacks: string[]; goalMet: boolean }[];
  /** Openings the rebuild combined into the plan. */
  addedOpportunityIds: string[];
  /** The evidence the rebuilt plan rests on, including what each protection added. */
  evidence: string[];
  rebuilt: Pick<CandidatePlan, 'expectedRevenueCents' | 'upfrontCents' | 'paymentDays' | 'capacityUnits' | 'neededUnits'> & {
    customers: PlanCustomer[];
    suppliers: PlanSupplier[];
  };
}

/** The candidate plan a strategy's facts describe. */
export function candidateFromStrategy(f: StrategyFacts): CandidatePlan {
  const total = f.members.reduce((sum, m) => sum + Math.max(0, m.revenueCents), 0);
  const share = (m: StrategyMemberFacts) => (total > 0 ? Math.max(0, m.revenueCents) / total : 1 / Math.max(1, f.members.length));
  const days = f.members.map((m) => m.daysToCash);
  const evidence: string[] = [];
  for (const m of f.members) {
    if (!evidence.includes(m.opportunityId)) evidence.push(m.opportunityId);
    if (m.claimId && !evidence.includes(m.claimId)) evidence.push(m.claimId);
  }
  const suppliers = new Map<string, number>();
  for (const m of f.members) if (m.fulfilledBy) suppliers.set(m.fulfilledBy, (suppliers.get(m.fulfilledBy) ?? 0) + share(m));
  return {
    id: f.key,
    targetCents: f.targetCents,
    daysLeft: f.daysLeft,
    expectedRevenueCents: round(total),
    directCostsCents: round(f.directCostsCents),
    customers: f.members.map((m) => ({ id: m.opportunityId, shareOfRevenue: share(m), evidenceId: m.opportunityId })),
    suppliers: [...suppliers].map(([id, s]) => ({ id, shareOfDelivery: s, alternativeIds: [] })),
    upfrontCents: round(f.upfrontCents),
    capitalCeilingCents: f.capitalCeilingCents,
    // The slowest member decides, and one unknown makes the whole unknown.
    paymentDays: days.length > 0 && days.every((d): d is number => d !== null) ? Math.max(...days) : null,
    capacityUnits: f.capacityHours,
    neededUnits: f.neededHours,
    evidence,
  };
}

/** How many other openings a rebuild considers combining; the best-supported first. */
export const MAX_COMPATIBLE_PATHS = 3;

/** The protections the plan's own rows establish. Deposits and backup capacity need a row that states them; none is invented. */
export function catalogueFromOpenings(plan: CandidatePlan, openings: readonly CompatibleOpening[]): EvidenceCatalogue {
  const members = new Set(plan.customers.map((c) => c.id));
  const compatiblePaths = openings
    .filter((o) => !members.has(o.opportunityId) && o.revenueCents > 0)
    .sort((a, b) => b.revenueCents - a.revenueCents || a.opportunityId.localeCompare(b.opportunityId))
    .slice(0, MAX_COMPATIBLE_PATHS)
    .map((o) => ({ id: o.opportunityId, revenueCents: o.revenueCents, evidenceId: o.opportunityId }));
  return { alternativeSuppliers: [], customerSources: [], deposit: null, backupCapacity: null, compatiblePaths };
}

/** The ordinary setbacks a plan's own facts make plausible: each customer lost, each fulfiller failing, payment a week late, a quarter of capacity short, the money out lost. */
export function plausibleSetbacks(plan: CandidatePlan): Setback[] {
  const out: Setback[] = plan.customers.map((c) => ({ kind: 'LOSE_CUSTOMER', customerId: c.id }));
  for (const s of plan.suppliers) out.push({ kind: 'SUPPLIER_FAILS', supplierId: s.id });
  if (plan.paymentDays !== null) out.push({ kind: 'PAYMENT_LATE', extraDays: 7 });
  if (plan.capacityUnits !== null && plan.neededUnits !== null) out.push({ kind: 'CAPACITY_SHORT', fraction: 0.25 });
  if (plan.upfrontCents > 0) out.push({ kind: 'UPFRONT_LOST' });
  return out;
}

const summaryOf = (t: SetbackTest) => ({ tested: t.tested, meetingTarget: t.meetingTarget, worst: t.worst, note: t.note });

/** Engineer one strategy's reliability: paths, evidenced protections, the rebuilt plan, and setbacks before and after. */
export function assessReliability(facts: StrategyFacts, openings: readonly CompatibleOpening[]): ReliabilityReading {
  const plan = candidateFromStrategy(facts);
  const catalogue = catalogueFromOpenings(plan, openings);
  // The setbacks are those of the plan as it stands; the rebuilt plan is held to the same ones,
  // so an improvement is measured against the risks it was meant to answer.
  const plausible = plausibleSetbacks(plan);
  const result = improvePlan(plan, catalogue, plausible);
  const original = new Set(plan.customers.map((c) => c.id));
  const basisNote = facts.basis === 'CONSERVATIVE' ? '' : ' Computed on the best case at supported prices, because a cautious figure is not yet established.';
  return {
    basis: facts.basis,
    failurePaths: deriveFailurePaths(plan).map((p) => ({ kind: p.kind, because: p.because, subject: p.subject, revenueAtRiskCents: p.revenueAtRiskCents })),
    applied: result.applied.map((p) => ({ kind: p.kind, answers: p.answers.kind, subject: p.answers.subject, evidenceId: p.evidenceId, detail: p.detail })),
    unprotected: result.unprotected.map((u) => ({ kind: u.path.kind, subject: u.path.subject, question: u.question })),
    before: { ...summaryOf(result.before), note: `${result.before.note}${basisNote}` },
    after: { ...summaryOf(result.after), note: `${result.after.note}${basisNote}` },
    combinedAfter: result.after.combined.map((r) => ({ setbacks: r.setbacks, goalMet: r.meetsTarget })),
    addedOpportunityIds: result.rebuilt.customers.map((c) => c.id).filter((id) => !original.has(id)),
    evidence: result.rebuilt.evidence,
    rebuilt: {
      expectedRevenueCents: result.rebuilt.expectedRevenueCents,
      upfrontCents: result.rebuilt.upfrontCents,
      paymentDays: result.rebuilt.paymentDays,
      capacityUnits: result.rebuilt.capacityUnits,
      neededUnits: result.rebuilt.neededUnits,
      customers: result.rebuilt.customers,
      suppliers: result.rebuilt.suppliers,
    },
  };
}
