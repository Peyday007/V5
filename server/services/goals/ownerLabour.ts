/**
 * The owner-labour offer that governs one opening: its goal's, when the
 * opening is a route proposed for one goal (`routeGoalOf`), and nobody's
 * otherwise — an opening no goal owns stays under the standing rule (§91), and
 * one goal's offer never reaches another goal's openings. The predicate is
 * `ownerLabourOffer` (`domain/operatingModel.ts`); this only finds the goal.
 */
import { goalOwnerLabour, type OwnerLabour } from '../../domain/operatingModel.ts';
import { routeGoalOf } from '../../domain/routeOrigin.ts';
import { getWorkstream } from '../../repos/register.ts';

export async function openingOwnerLabour(opportunity: { externalRecordId?: string | null }): Promise<OwnerLabour | null> {
  const goalId = routeGoalOf(opportunity);
  if (!goalId) return null;
  const goal = await getWorkstream(goalId).catch(() => null);
  if (!goal || goal.archivedAt || goal.cancelledAt) return null;
  return goalOwnerLabour(goal);
}
