/**
 * Everything the commerce kernel knows about one project, read once per pass.
 *
 * Pure readers (`economics.ts`, `standing.ts`, `allocate.ts`) take this
 * snapshot rather than the database, so *why did Brain ask that* is answerable
 * afterwards from a recorded input rather than from a re-run against rows that
 * have since moved — the split `services/dispatch/router.ts` draws first.
 */
import {
  listCommerceFacts,
  listCommerceProducts,
  listCommerceRounds,
} from '../../repos/commerce.ts';
import { readEconomics, type UnitEconomics } from './economics.ts';
import { readStanding, type ProductStanding } from './standing.ts';
import type { CommerceFact, CommerceProduct, CommerceRound } from '../../domain/types.ts';

export interface CommerceSnapshot {
  products: CommerceProduct[];
  facts: CommerceFact[];
  rounds: CommerceRound[];
  economics: UnitEconomics[];
  standing: ProductStanding[];
  openRounds: number;
}

export async function commerceSnapshot(projectId: string, now?: number): Promise<CommerceSnapshot> {
  const [products, facts, rounds] = await Promise.all([
    listCommerceProducts(projectId),
    listCommerceFacts(projectId),
    listCommerceRounds(projectId),
  ]);
  const economics = readEconomics({ products, facts });
  const standing = readStanding({ products, facts, economics, ...(now === undefined ? {} : { now }) });
  return {
    products,
    facts,
    rounds,
    economics,
    standing,
    openRounds: rounds.filter((one) => one.state === 'OPEN').length,
  };
}
