/**
 * What may cross between people: general public knowledge through the existing
 * shared_findings boundary. A possibility row never crosses; a worker is refused
 * by principal type, as everywhere a person's goals are read.
 */
import { eligibleFindings } from '../../../repos/sharedFindings.ts';
import type { SharedFindingEvidence } from '../../../repos/sharedFindings.ts';
import { listPossibilities } from '../../../repos/economy.ts';
import type { Possibility } from '../../../domain/economy.ts';
import { decideProjectAccess } from '../../identity/policy.ts';
import type { Principal } from '../../../domain/types.ts';

/** Null is "there is nothing here for you": the same answer as a project that does not exist. */
export async function myPossibilities(principal: Principal | null, projectId: string): Promise<Possibility[] | null> {
  if (!principal || principal.type !== 'HUMAN') return null;
  if (!decideProjectAccess(principal, projectId, 'READ').allowed) return null;
  return listPossibilities(projectId, principal.id);
}

/** Findings other projects established, for a goal here, with no research repeated. */
export async function knowledgeForLaterGoal(
  principal: Principal | null, projectId: string,
): Promise<SharedFindingEvidence[] | null> {
  if (!principal || principal.type !== 'HUMAN') return null;
  if (!decideProjectAccess(principal, projectId, 'READ').allowed) return null;
  return eligibleFindings({ excludeProjectId: projectId });
}
