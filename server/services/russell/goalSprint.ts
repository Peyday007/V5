/**
 * A cash goal a person set is the decision to research it, so its project gets
 * the sprint that research runs under.
 *
 * Production, 2026-11-19: three goals created through `goals create` on Cash
 * Mode 2, 3 and 4 (`wst_deede4995…`, `wst_fa476177…`, `wst_4f0c3124…`) planned
 * 16-17 RESEARCH_FIRST questions each and launched none. Those projects had no
 * `cash_modes` row and no `russell_goals` row, so every research entrance
 * refused: `standingAuthority` (no grant, and no layer), the compiler's
 * `envelopeIdFor` (a project with no sprint has no envelope), `openGoalDiscovery`
 * (`discoveryAllowed`) and `openConstructedRound` (`knowledgeResearchAllowed`).
 * The goal read NOTHING_LINKED and asked the owner to "point this goal at the
 * work" — the second ask for one decision that `discoveryAuthority.ts` already
 * names as the defect: *Start Cash Mode is the authorization*, and asking a
 * person to make it again is the ask that gets left unanswered.
 *
 * So this extends the existing owner rather than adding a mechanism: for a live
 * goal with a cash target, created by a person who could have pressed Start on
 * that project (project ADMIN or a Brain administrator), on a project with no
 * sprint row at all, it calls `activate` — the same function the route calls —
 * with the goal's own words as the objective, the goal's owner as the sprint's
 * owner and its creator as the actor. Everything that follows is the ordinary
 * sprint: the layer, the research-only discovery grant (`ensureDiscoveryAuthority`,
 * `max_external_spend = 0`, every external effect prohibited), the envelope.
 *
 * What it does not do, and why each is structural:
 *
 * - **No money, contact or publication.** Activation authorizes none of them;
 *   the commercial grant (§30) is a separate decision this module neither reads
 *   nor writes, and `activate` cannot write one.
 * - **No goal a machine set.** The operator creates goals with no user
 *   (`userId: null`), so a goal with no person behind it activates nothing — a
 *   machine that could create its own work could create work nobody asked for
 *   (§22).
 * - **No widening past the person.** A creator without ADMIN on the project
 *   could not have pressed Start there, so their goal does not press it either.
 * - **No reversal of a person's stop.** Any `cash_modes` row — including an
 *   ARCHIVED one, which is a person's decision to stop — is left alone.
 *
 * Idempotent by `activateCashMode`'s one-row-per-project rule, and derived from
 * rows on every tick, so it reaches goals already stranded as well as new ones.
 */
import { listWorkstreams, recordWorkstreamEvent } from '../../repos/register.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { getUser, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import type { Principal } from '../../domain/types.ts';
import type { Workstream } from '../../domain/register.ts';

/** The workstream event a goal-derived activation is recorded under. */
export const GOAL_SPRINT_EVENT = 'GOAL_RESEARCH_SPRINT_ACTIVATED';

const DAY_MS = 24 * 60 * 60_000;

export interface GoalSprintOutcome {
  goalId: string;
  projectId: string;
  activated: boolean;
  reason: string;
}

/** A live cash goal with a person behind it and a deadline still ahead. */
export function sprintCandidate(goal: Workstream, now: Date): boolean {
  if (goal.archivedAt || goal.cancelledAt || goal.pausedAt) return false;
  if (!goal.projectId || !goal.target || goal.target.projectId !== goal.projectId) return false;
  if (!goal.createdByUserId) return false;
  if (goal.dueAt && Date.parse(goal.dueAt) <= now.getTime()) return false;
  return true;
}

/** Could this person have pressed Start on this project themselves? */
async function personMayActivate(userId: string, projectId: string): Promise<boolean> {
  const user = await getUser(userId);
  if (!user || user.disabledAt || user.kind !== 'PERSON') return false;
  const principal: Principal = {
    type: 'HUMAN',
    id: user.id,
    handle: user.email ?? null,
    displayName: user.displayName,
    isBrainAdmin: user.isBrainAdmin,
    mustChangePassword: false,
    credentialId: 'goal-sprint',
    authMethod: 'SESSION_COOKIE',
    memberships: await listMembershipsForPrincipal('HUMAN', user.id),
    requestId: 'goal-sprint',
  };
  return decideProjectAccess(principal, projectId, 'ADMIN').allowed;
}

/**
 * Give each eligible goal's project its sprint. Returns what it did, per goal
 * it considered; a project that already has a sprint row is not considered.
 */
export async function activateGoalSprints(now = new Date()): Promise<GoalSprintOutcome[]> {
  const { activate, isSprintCurrency, DEFAULT_HORIZON_DAYS } = await import('../cash/lifecycle.ts');
  const out: GoalSprintOutcome[] = [];
  const done = new Set<string>();
  // Oldest first, so the goal that asked first names the sprint.
  const goals = (await listWorkstreams()).filter((goal) => sprintCandidate(goal, now)).reverse();
  for (const goal of goals) {
    const projectId = goal.projectId!;
    if (done.has(projectId)) continue;
    if (await getCashMode(projectId)) {
      done.add(projectId);
      continue;
    }
    const actor = goal.createdByUserId!;
    if (!(await personMayActivate(actor, projectId))) {
      out.push({ goalId: goal.id, projectId, activated: false, reason: 'the person who set this goal could not start a sprint on this project themselves' });
      continue;
    }
    const currency = goal.target!.currency;
    const horizonDays = goal.dueAt ? Math.max(1, Math.ceil((Date.parse(goal.dueAt) - now.getTime()) / DAY_MS)) : DEFAULT_HORIZON_DAYS;
    const outcome = await activate({
      projectId,
      ownerUserId: goal.ownerUserId ?? actor,
      actorUserId: actor,
      objective: goal.intent || goal.title,
      horizonDays,
      ...(isSprintCurrency(currency) ? { currency } : {}),
    });
    done.add(projectId);
    if (!outcome.ok) {
      out.push({ goalId: goal.id, projectId, activated: false, reason: outcome.reason });
      continue;
    }
    if (outcome.changed) {
      await recordWorkstreamEvent({
        workstreamId: goal.id,
        kind: GOAL_SPRINT_EVENT,
        summary:
          `Cash Mode started on this goal's project (${outcome.mode.id}): setting this goal was the decision to research it, ` +
          'so Brain may now read published sources for it. Nothing here permits spending, contact, purchase, commitment or publication.',
        detail: { cashModeId: outcome.mode.id, authorizedByUserId: actor, horizonDays, currency: outcome.mode.currency },
        actorRef: 'BRAIN',
      });
    }
    out.push({ goalId: goal.id, projectId, activated: outcome.changed, reason: outcome.message });
  }
  return out;
}
