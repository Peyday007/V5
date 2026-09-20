/**
 * Everything the kernel knows, read once per pass.
 *
 * ---------------------------------------------------------------------------
 * One read, then a pure decision over it
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/candidates.ts` and `services/industry/graph.ts` both draw
 * this line and for the same reason: the allocator has to be a pure function
 * over a recorded input, so *why did Brain research that* is answerable
 * afterwards from a snapshot rather than from a re-run against a database that
 * has since moved. Being pure also makes the allocator useless as a safety
 * mechanism, which is correct — the exclusion is the unique index on
 * `deal_rounds`, and two ticks both deciding correctly produce one round.
 *
 * ---------------------------------------------------------------------------
 * A class is a distinct key, not a table
 * ---------------------------------------------------------------------------
 *
 * There is no equipment table in this kernel. A class exists because a party,
 * a requirement or a cost row names it, and the set of classes is the distinct
 * set of keys across those rows. That is deliberate: a table would need a row
 * created before any evidence named it, which is the seeded-vocabulary problem
 * §38 refused for industries — and the classes converge instead by Brain
 * naming one verbatim in the question it asks.
 */
import {
  listCosts,
  listDealRounds,
  listDeals,
  listObservations,
  listParties,
  listRequirements,
  listStructureEvidence,
} from '../../repos/dealflow.ts';
import { equipmentKey, jurisdictionKey } from '../../domain/dealflow.ts';
import type {
  Deal,
  DealCost,
  DealObservation,
  DealParty,
  DealRequirement,
  DealRound,
  DealStructureEvidence,
} from '../../domain/types.ts';

/** One class of equipment, with both sides of it counted. */
export interface ClassView {
  key: string;
  /** As the sources write it. The first spelling seen wins, and it is shown. */
  equipmentClass: string;
  buyers: DealParty[];
  suppliers: DealParty[];
  /** The markets buyers of this class are in, deduplicated by key. */
  destinations: string[];
  requirements: DealRequirement[];
  costs: DealCost[];
  structures: DealStructureEvidence[];
  deals: Deal[];
  /** Rounds asked about this class, settled and live. */
  rounds: DealRound[];
  liveRounds: number;
}

export interface DealflowSnapshot {
  projectId: string;
  parties: DealParty[];
  requirements: DealRequirement[];
  costs: DealCost[];
  structures: DealStructureEvidence[];
  deals: Deal[];
  rounds: DealRound[];
  observations: DealObservation[];
  classes: ClassView[];
  /** Live rounds across the whole kernel, which is what the concurrency bound counts. */
  openRounds: number;
  takenAt: string;
}

export async function dealflowSnapshot(projectId: string): Promise<DealflowSnapshot> {
  const [parties, requirements, costs, structures, deals, rounds, observations] =
    await Promise.all([
      listParties(projectId),
      listRequirements(projectId),
      listCosts(projectId),
      listStructureEvidence(projectId),
      listDeals(projectId),
      listDealRounds(projectId),
      listObservations(projectId),
    ]);

  const live = parties.filter((one) => one.retiredAt === null);

  /*
   * The classes, in the order they were first seen. Deterministic rather than
   * alphabetical, because the allocator's tie-break falls through to this and
   * an alphabetical order would leave the same classes at the back of the
   * queue for ever — the defect §38 records finding by running its own kernel.
   */
  const order: string[] = [];
  const display = new Map<string, string>();
  const note = (key: string, shown: string) => {
    if (!display.has(key)) {
      display.set(key, shown);
      order.push(key);
    }
  };
  for (const party of live) note(party.equipmentKey, party.equipmentClass);
  for (const row of requirements) note(row.equipmentKey, row.equipmentClass);
  for (const row of costs) note(row.equipmentKey, row.equipmentClass);
  for (const row of structures) note(row.equipmentKey, row.equipmentClass);

  const classes: ClassView[] = order.map((key) => {
    const buyers = live.filter((one) => one.kind === 'BUYER' && one.equipmentKey === key);
    const suppliers = live.filter((one) => one.kind === 'SUPPLIER' && one.equipmentKey === key);
    const mineRounds = rounds.filter((one) => one.equipmentKey === key);
    const destinations: string[] = [];
    const seen = new Set<string>();
    for (const buyer of buyers) {
      if (!buyer.country) continue;
      const k = jurisdictionKey(buyer.country);
      if (seen.has(k)) continue;
      seen.add(k);
      destinations.push(buyer.country);
    }
    return {
      key,
      equipmentClass: display.get(key) ?? key,
      buyers,
      suppliers,
      destinations,
      requirements: requirements.filter((one) => one.equipmentKey === key),
      costs: costs.filter((one) => one.equipmentKey === key),
      structures: structures.filter((one) => one.equipmentKey === key),
      deals: deals.filter((one) => one.equipmentKey === key),
      rounds: mineRounds,
      liveRounds: mineRounds.filter((one) => one.state === 'OPEN').length,
    };
  });

  return {
    projectId,
    parties,
    requirements,
    costs,
    structures,
    deals,
    rounds,
    observations,
    classes,
    openRounds: rounds.filter((one) => one.state === 'OPEN').length,
    takenAt: new Date().toISOString(),
  };
}

/** The class a key names, or null. Used by callers that hold only the key. */
export function classFor(snapshot: DealflowSnapshot, key: string): ClassView | null {
  return snapshot.classes.find((one) => one.key === key) ?? null;
}

export function classForName(snapshot: DealflowSnapshot, name: string): ClassView | null {
  return classFor(snapshot, equipmentKey(name));
}
