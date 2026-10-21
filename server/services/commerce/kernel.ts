/**
 * One project's commerce pass, for the tick (§73).
 *
 * File, then allocate. Filing first means a round that settled since the last
 * pass has its products and figures on the map before the allocator looks, so
 * a product that has just been costed is acted on this pass rather than the
 * next.
 *
 * **What a pause, a wound-down sprint or no sprint at all stops is asking.**
 * Filing what research already found runs whenever the programme exists: the
 * spending happened when the research ran, and §30's rule is that an off
 * switch ends new discovery and nothing else.
 *
 * Derived on the tick rather than hooked to a moment, so a tick that dies
 * halfway leaves rows the next one reads correctly, and two instances running
 * it produce one round because the arbiter is a unique index.
 */
import { getCommerceProgramme } from '../../repos/commerce.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { allocate, MAX_OPEN_COMMERCE_ROUNDS, type Ask, type Declined } from './allocate.ts';
import { fileCommerceFindings, openCommerceAsks, type Filed, type OpenedCommerceRound } from './expand.ts';
import { commerceSnapshot, type CommerceSnapshot } from './graph.ts';

export interface CommercePass {
  filed: Filed;
  opened: OpenedCommerceRound[];
  declined: Declined[];
  products: number;
  qualified: number;
  openRounds: number;
}

function emptyPass(): CommercePass {
  return {
    filed: { products: [], facts: [], settled: [], refused: [] },
    opened: [],
    declined: [],
    products: 0,
    qualified: 0,
    openRounds: 0,
  };
}

export async function runCommerceKernel(projectId: string): Promise<CommercePass> {
  // One read answers it for every project that never started a programme,
  // which is what makes this cheap enough to run for every project every tick.
  const programme = await getCommerceProgramme(projectId);
  if (!programme) return emptyPass();

  const filed = await fileCommerceFindings({ projectId });
  const snapshot = await commerceSnapshot(projectId);
  const summary = {
    products: snapshot.products.length,
    qualified: snapshot.standing.filter((one) => one.stage === 'QUALIFIED').length,
    openRounds: snapshot.openRounds,
  };

  if (programme.state !== 'ACTIVE') {
    return {
      filed,
      opened: [],
      declined: [{ subject: 'every question this kernel would ask', why: 'The commerce programme is paused.' }],
      ...summary,
    };
  }
  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) {
    return {
      filed,
      opened: [],
      declined: [{ subject: 'every question this kernel would ask', why: gate.reason }],
      ...summary,
    };
  }

  const plan = planFrom(snapshot);
  const opened = await openCommerceAsks({ projectId, asks: plan.asks, snapshot });
  return { filed, opened, declined: plan.declined, ...summary };
}

/**
 * What the allocator would do next, without anything being created — so a
 * person, the read route or a test can look before anything moves.
 */
export function planFrom(snapshot: CommerceSnapshot, now?: number): { asks: Ask[]; declined: Declined[] } {
  return allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_COMMERCE_ROUNDS - snapshot.openRounds),
    ...(now === undefined ? {} : { now }),
  });
}
