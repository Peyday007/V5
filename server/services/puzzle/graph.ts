/**
 * Everything the kernel knows, read once per pass.
 *
 * ---------------------------------------------------------------------------
 * Impure here so that every decision above it can be pure
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/router.ts` draws this line and §38, §39 and §45 all
 * follow it: the reads live in one place, and the allocator, the maturity
 * ladder, the leverage arithmetic and the ledger ranking are pure functions
 * over the result. That makes *why did Brain ask that* answerable from a
 * recorded input rather than from a re-run against a database that has moved.
 *
 * Being pure is also what makes those functions useless as a safety mechanism,
 * which is correct: two ticks can both compute the same allocation, and the
 * exclusion is the partial unique index on the live rounds, never the
 * decision.
 */
import {
  currentValidations,
  listEconomics,
  listFormats,
  listInstances,
  listMasters,
  listObservations,
  listOutputMembers,
  listOutputs,
  listRightsConstraints,
  listRounds,
  listRouteEvidence,
  listRoutes,
  listStandards,
} from '../../repos/puzzle.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import type {
  PuzzleEconomicLine,
  PuzzleFormat,
  PuzzleInstance,
  PuzzleMaster,
  PuzzleObservation,
  PuzzleOutput,
  PuzzleOutputMember,
  PuzzleRightsConstraint,
  PuzzleRound,
  PuzzleRoute,
  PuzzleRouteEvidence,
  PuzzleStandard,
  PuzzleValidation,
} from '../../domain/types.ts';

export interface PuzzleSnapshot {
  projectId: string;
  /** The instant the snapshot was taken, so a pure reader never consults a clock. */
  at: string;

  formats: PuzzleFormat[];
  standards: PuzzleStandard[];
  rights: PuzzleRightsConstraint[];
  masters: PuzzleMaster[];
  instances: PuzzleInstance[];
  /** Exactly the current run per instance. A missing entry means nothing validated it. */
  validations: Map<string, PuzzleValidation>;
  outputs: PuzzleOutput[];
  /** Members by output id, already ordered by position. */
  members: Map<string, PuzzleOutputMember[]>;
  routes: PuzzleRoute[];
  routeEvidence: PuzzleRouteEvidence[];
  economics: PuzzleEconomicLine[];
  rounds: PuzzleRound[];
  observations: PuzzleObservation[];

  /**
   * Opportunity ids against which money has actually **settled**.
   *
   * A `CUSTOMER_PAYMENT` and a `SETTLEMENT` are two events about the same
   * money and only the second is cash — §30's own rule, and the reason
   * REVENUE_PROVEN reads this set rather than counting payments. An output
   * whose buyer has agreed to pay is not one that has been paid for.
   */
  settledOpportunityIds: Set<string>;

  /**
   * The settlements themselves, so a money figure is a sum of rows rather than
   * a count of them.
   *
   * Only `SETTLEMENT`, for the reason directly above, and carried whole
   * because a total across two currencies is a figure whose label makes it
   * look checked — the reader groups by currency and says so rather than
   * converting at a rate nobody recorded.
   */
  settlements: { opportunityId: string; amountCents: number; currency: string }[];

  openRounds: number;
}

export async function puzzleSnapshot(projectId: string): Promise<PuzzleSnapshot> {
  const [
    formats,
    standards,
    rights,
    masters,
    instances,
    validationRuns,
    outputs,
    routes,
    routeEvidence,
    economics,
    rounds,
    observations,
    money,
  ] = await Promise.all([
    listFormats(projectId),
    listStandards(projectId),
    listRightsConstraints(projectId),
    listMasters(projectId),
    listInstances(projectId),
    currentValidations(projectId),
    listOutputs(projectId),
    listRoutes(projectId),
    listRouteEvidence(projectId),
    listEconomics(projectId),
    listRounds(projectId),
    listObservations(projectId),
    listMoneyEntries({ projectId, limit: 2000 }),
  ]);

  const validations = new Map<string, PuzzleValidation>();
  for (const run of validationRuns) validations.set(run.instanceId, run);

  const members = new Map<string, PuzzleOutputMember[]>();
  for (const output of outputs) {
    members.set(output.id, await listOutputMembers(output.id));
  }

  const settledOpportunityIds = new Set<string>();
  const settlements: { opportunityId: string; amountCents: number; currency: string }[] = [];
  for (const entry of money) {
    if (entry.kind === 'SETTLEMENT' && entry.opportunityId) {
      settledOpportunityIds.add(entry.opportunityId);
      settlements.push({
        opportunityId: entry.opportunityId,
        amountCents: entry.amountCents,
        currency: entry.currency,
      });
    }
  }

  return {
    projectId,
    at: new Date().toISOString(),
    formats,
    standards,
    rights,
    masters,
    instances,
    validations,
    outputs,
    members,
    routes,
    routeEvidence,
    economics,
    rounds,
    observations,
    settledOpportunityIds,
    settlements,
    openRounds: rounds.filter((one) => one.state === 'OPEN').length,
  };
}

/* --------------------------------------------------------------------------
 * Small shared readings
 *
 * Here rather than in each reader, because two copies of "is this instance
 * evidence" would eventually disagree about what a missing validation means —
 * and the safe answer to that is the whole point.
 * ------------------------------------------------------------------------ */

/**
 * Whether an instance is something this kernel actually has.
 *
 * §9's rule at a new artifact: a `BLOCKED` document is not an empty document,
 * and an instance with no current PASSED run is not a working puzzle. A
 * missing validation is **not** a pass — every reader here must be able to say
 * so rather than treating silence as health.
 */
export function isEvidence(snapshot: PuzzleSnapshot, instanceId: string): boolean {
  return snapshot.validations.get(instanceId)?.verdict === 'PASSED';
}

/** Instances produced by one master. */
export function instancesOf(snapshot: PuzzleSnapshot, masterId: string): PuzzleInstance[] {
  return snapshot.instances.filter((one) => one.masterId === masterId);
}

/** The masters that serve one format key. */
export function mastersOf(snapshot: PuzzleSnapshot, formatKey: string): PuzzleMaster[] {
  return snapshot.masters.filter((one) => one.formatKey === formatKey && !one.retiredAt);
}

/** The outputs compiled from one master. */
export function outputsOf(snapshot: PuzzleSnapshot, masterId: string): PuzzleOutput[] {
  return snapshot.outputs.filter((one) => one.masterId === masterId && !one.retiredAt);
}

/** The evidence rows on one route. */
export function evidenceOn(snapshot: PuzzleSnapshot, routeId: string): PuzzleRouteEvidence[] {
  return snapshot.routeEvidence.filter((one) => one.routeId === routeId);
}
