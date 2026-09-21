/**
 * One project's dealflow pass, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the fifth
 * time this repository has needed that distinction: a hook fixes one entrance,
 * and a derivation reaches every entrance plus everything already stranded. A
 * sprint activated before this kernel existed gets a map on the next tick with
 * nobody pressing anything; a tick that dies halfway leaves rows the next one
 * reads correctly; and two instances running it produce one round, because the
 * arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * The order of the four steps is the whole design
 * ---------------------------------------------------------------------------
 *
 * File, pair, promote, allocate — in that order, and each one because of the
 * one after it.
 *
 * Filing first means a round that settled on the previous pass has its parties
 * and requirements on the map *before* the allocator looks, so a class that
 * has just gained a supplier is paired on this pass rather than the next one.
 * Pairing before promoting means a deal that has just become possible is read
 * at its real stage. Promoting before allocating means a deal that is finished
 * with research is out of the allocator's way, so the slots go to the ones
 * that still need it. Allocating first would make every discovery a tick late,
 * for ever.
 *
 * ---------------------------------------------------------------------------
 * It refuses to open work where discovery is refused, and only there
 * ---------------------------------------------------------------------------
 *
 * Opening a round is new discovery, so it is behind `discoveryAllowed` — the
 * same gate the buckets and the industry kernel are behind. Filing, pairing
 * and promoting are **not**: filing what research already found is not new
 * discovery, the spending happened when it ran, and dropping results because
 * the sprint wound down would throw away work already paid for. §30's rule
 * that winding down ends new discovery and never a customer's obligation,
 * applied one kernel along.
 */
import { actionsFor } from '../../repos/cashActions.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { pairDeal } from '../../repos/dealflow.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { allocate, MAX_OPEN_DEAL_ROUNDS, type Ask, type Declined } from './allocate.ts';
import { dealflowSnapshot, type DealflowSnapshot } from './graph.ts';
import { fileFindings, openDealAsks, type Filed, type OpenedDealRound } from './expand.ts';
import { readDeal, type DealReading } from './maturity.ts';
import { promoteReadyDeals, type Promotion } from './promote.ts';
import type { Deal } from '../../domain/types.ts';

export interface DealflowPass {
  /** What the finished rounds established. */
  filed: Filed;
  /** New pairings this pass made possible. */
  paired: Deal[];
  /** Deals that reached outreach-ready and became portfolio work. */
  promoted: Promotion[];
  /** Rounds opened, each carrying why the allocator chose it. */
  opened: OpenedDealRound[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: Declined[];
  classes: number;
  deals: number;
  openRounds: number;
}

/**
 * The pass a project with no sprint returns.
 *
 * A function rather than a shared constant, for `emptyFiled`'s reason one
 * level up: every field here is an array, and a constant returned from a
 * function is the *same* array every time — so a caller that appended to one
 * would be appending to the value every other project's empty pass reports.
 * Nothing does that today, which is exactly the kind of thing that stays true
 * until it does not.
 */
function emptyPass(): DealflowPass {
  return {
    filed: {
      parties: [],
      requirements: [],
      costs: [],
      structures: [],
      decisionMakers: [],
      settled: [],
      refused: [],
    },
    paired: [],
    promoted: [],
    opened: [],
    declined: [],
    classes: 0,
    deals: 0,
    openRounds: 0,
  };
}

export async function runDealflowKernel(projectId: string): Promise<DealflowPass> {
  // One read answers it for the many projects that hold no sprint at all,
  // which is what makes this cheap enough to run for every project every tick.
  const mode = await getCashMode(projectId);
  if (!mode) return emptyPass();

  const filed = await fileFindings({ projectId });

  const afterFiling = await dealflowSnapshot(projectId);
  const paired = await pairSides(afterFiling);

  const snapshot = paired.length > 0 ? await dealflowSnapshot(projectId) : afterFiling;
  const readings = await readAll(snapshot);
  const promoted = await promoteReadyDeals({ projectId, readings });

  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) {
    return {
      filed,
      paired,
      promoted,
      opened: [],
      declined: [{ subject: 'every question this kernel would ask', why: gate.reason }],
      classes: snapshot.classes.length,
      deals: snapshot.deals.length,
      openRounds: snapshot.openRounds,
    };
  }

  const plan = planFrom(snapshot, readings);
  const opened = await openDealAsks({ projectId, asks: plan.asks, snapshot });

  return {
    filed,
    paired,
    promoted,
    opened,
    declined: plan.declined,
    classes: snapshot.classes.length,
    deals: snapshot.deals.length,
    openRounds: snapshot.openRounds,
  };
}

/**
 * The allocation for one snapshot, with the free slots counted from it.
 *
 * Exported separately from the pass that acts on it so a person — or a test —
 * can ask *what would Brain do next* without anything being created.
 * `services/realize/prove.ts` and `services/industry/kernel.ts` both split
 * reading from applying for the same reason: somebody should be able to look
 * before anything moves.
 */
export function planFrom(
  snapshot: DealflowSnapshot,
  readings: readonly DealReading[],
): { asks: Ask[]; declined: Declined[] } {
  return allocate({
    snapshot,
    readings,
    slots: Math.max(0, MAX_OPEN_DEAL_ROUNDS - snapshot.openRounds),
  });
}

/**
 * Pair every buyer with every supplier of the same class.
 *
 * The cartesian product, deliberately and without a cap. A pairing is not work
 * — it creates no round, spends nothing and fires nothing — and it is what
 * makes the two-sided question askable at all. What bounds the cost is the
 * allocator, which asks about at most `MAX_OPEN_DEAL_ROUNDS` at a time
 * whatever the table holds.
 *
 * Idempotent by the unique index on (buyer, supplier, class), so two ticks
 * produce one row and a re-run creates nothing.
 */
export async function pairSides(snapshot: DealflowSnapshot): Promise<Deal[]> {
  const made: Deal[] = [];
  for (const view of snapshot.classes) {
    for (const buyer of view.buyers) {
      for (const supplier of view.suppliers) {
        /*
         * One organisation can be both sides of a class — a trading house that
         * publishes both a need and a capability — and a deal with itself is
         * refused by a CHECK rather than reaching the database and failing.
         */
        if (buyer.id === supplier.id) continue;
        const { deal, created } = await pairDeal({
          projectId: snapshot.projectId,
          buyerPartyId: buyer.id,
          supplierPartyId: supplier.id,
          equipmentClass: view.equipmentClass,
        });
        if (created) made.push(deal);
      }
    }
  }
  return made;
}

/**
 * Read every deal, with the opportunity and the recorded actions it needs.
 *
 * The reads happen here rather than inside `readDeal` so that the reading
 * itself stays a pure function of rows — which is what lets a test drive it
 * and lets the allocator be pure over the result.
 */
export async function readAll(snapshot: DealflowSnapshot): Promise<DealReading[]> {
  const byId = new Map(snapshot.parties.map((one) => [one.id, one]));
  const out: DealReading[] = [];
  for (const deal of snapshot.deals) {
    const buyer = byId.get(deal.buyerPartyId);
    const supplier = byId.get(deal.supplierPartyId);
    if (!buyer || !supplier) continue;

    const opportunity = deal.opportunityId ? await getOpportunity(deal.opportunityId) : null;
    const actions = deal.opportunityId
      ? (await actionsFor(deal.opportunityId)).map((one) => one.action)
      : [];

    out.push(
      readDeal({
        deal,
        buyer,
        supplier,
        requirements: snapshot.requirements,
        costs: snapshot.costs,
        structures: snapshot.structures,
        opportunity,
        actions,
      }),
    );
  }
  return out;
}
