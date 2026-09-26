/**
 * Would the dispatcher fire *this* surface for *this* kind of work, right now?
 *
 * The question a readiness card is asking, answered by the dispatcher itself
 * rather than by a second opinion. It pins the given work to one Routine and
 * hands it to `routeBin` over the same `fleetSnapshot` the tick reads — so the
 * project, the family, the repository, the capabilities, the account and
 * Routine state, the deployment credential, the provider's cooldown and every
 * target are judged by the code that actually decides a fire, and nothing here
 * restates any of them.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Build called a repository *Ready to execute* when any enabled Routine was
 * bound to its worker. A Routine meets that while its trigger token is not
 * deployed, while its account is quarantined, and while it declares no
 * `repository-write` — and the dispatcher refuses every one of those. A card
 * that reads READY over a surface routing will never fire is §24's *waiting
 * nobody can resolve* wearing a green label: a person submits an objective and
 * the campaign sits at its first stage with the reason on a ledger nobody
 * reads. The remedy is not a better copy of the routing rules in Build; it is
 * Build asking the router.
 *
 * ---------------------------------------------------------------------------
 * Three answers, because there are three remedies
 * ---------------------------------------------------------------------------
 *
 *   * `ELIGIBLE` — the router would select this surface now.
 *   * `WAITING`  — it passes every dimension an operator controls, and is
 *     refused only for capacity: a provider cooldown, a target reached, a
 *     paused fleet. `REFUSAL_WAIT` already classifies those as `CAPACITY`, and
 *     it is read rather than restated. A busy surface is not a broken
 *     registration (§23: *a refusal is not misconduct*), and telling somebody
 *     to re-register it would send them to fix something that works.
 *   * `UNUSABLE` — refused for a reason an operator's write answers. The
 *     sentence names the dimension and the remedy.
 *
 * Proof is deliberately not one of the three. Whether a surface has ever
 * completed work is history; whether it can take work is now. A proven surface
 * that has since been quarantined is UNUSABLE, and an eligible one that has
 * never been fired is ELIGIBLE — the two facts are reported side by side by
 * whoever reads this, never folded into each other.
 */
import type { Bin, FleetRoutine } from '../../domain/types.ts';
import type { FleetSnapshot } from './candidates.ts';
import { REFUSAL_WAIT, routeBin, type RoutingRefusal } from './router.ts';

export type SurfaceDispatch = 'ELIGIBLE' | 'WAITING' | 'UNUSABLE';

export interface SurfaceEligibility {
  routineId: string;
  dispatch: SurfaceDispatch;
  /** The router's own refusal, or null when it would fire. */
  refusal: RoutingRefusal | null;
  /** One sentence about this surface: what the router decided, and the remedy. */
  reason: string;
  /** When a provider cooldown ends, for a surface that is waiting on one. */
  retryAt: string | null;
}

/**
 * The remedy for one surface refused on one dimension.
 *
 * Per surface rather than the router's own reason, because the router speaks
 * about a fleet — *"No enabled Routine is bound to…"* — and the card is about
 * one Routine. This is wording, not policy: which refusal applies is the
 * router's decision, and a `Record` over the union so a refusal added there is
 * a compile error here until somebody says what it means for one surface.
 */
const REMEDY: Record<RoutingRefusal, string> = {
  NO_ROUTINES_REGISTERED: 'Register it with `fleet register-routine`.',
  FLEET_PAUSED: 'The whole fleet is paused by policy; it resumes when the pause is lifted.',
  FLEET_TARGET_REACHED:
    'The fleet is at its concurrency target; it frees when an activation finishes, or raise the target.',
  ALL_SURFACES_INELIGIBLE:
    'Fix what took it out, then put it back with `fleet set-state --to ENABLED`.',
  ALL_SURFACES_RATE_LIMITED: 'The provider asked Brain to wait; it resumes by itself.',
  NO_CAPABLE_SURFACE:
    'A Factory surface needs repository and repository-write declared (`fleet set-capabilities`) and a passing ' +
    'delivery probe for this repository — its own fired session pushing, opening and closing a pull request. ' +
    'Run `fleet commission --ref <trig> --repository <owner/name> --probe`; it names the first missing step.',
  NO_SURFACE_SERVES_THIS_FAMILY:
    'Its worker may not be handed Software Factory work; onboard the repository for that worker, or bind the Routine to the Factory worker with `fleet bind-worker`.',
  NO_SURFACE_SERVES_THIS_REPOSITORY:
    'Its worker is not authorized for this repository; that is an onboarding decision, not a capacity one.',
  NO_SURFACE_SERVES_THIS_PROJECT:
    'Its worker holds no live membership on this project, so it may be handed nothing here. Onboard the repository in this project, or bind the Routine to a worker that is a member.',
  PINNED_SURFACE_UNAVAILABLE:
    'Brain will not fire it until it is a routing candidate.',
  ACCOUNT_TARGETS_REACHED:
    'It is at its configured target; it frees when an activation finishes, or raise the Routine or account target.',
};

/**
 * Ask the router about one surface, for one piece of work.
 *
 * `work` is a bin as the dispatcher would see it — its project, its manifest
 * and its required capabilities are what the router reads. It is never written:
 * the pin is applied to a copy, and nothing here touches a row.
 */
export function surfaceEligibility(input: {
  routine: FleetRoutine;
  work: Bin;
  snapshot: FleetSnapshot;
  now: string;
}): SurfaceEligibility {
  const { routine, snapshot } = input;

  /*
   * A Routine whose trigger token is not deployed is not a routing candidate at
   * all — `fleetSnapshot` leaves it out on purpose, so Brain never spends a
   * fire discovering it. Said first and by name, because the router cannot say
   * it: with the Routine absent from the candidate list the router answers
   * whatever an empty or pinned-away list answers, which names no secret.
   */
  const missing = snapshot.missingSecrets.find((one) => one.routineId === routine.id);
  if (missing) {
    return {
      routineId: routine.id,
      dispatch: 'UNUSABLE',
      refusal: 'PINNED_SURFACE_UNAVAILABLE',
      reason:
        `Its trigger token is not deployed: this deployment has no secret named ${missing.secretName}, ` +
        'so Brain will not spend a fire finding that out. A Brain administrator sets that secret; ' +
        'nothing else has to be redone.',
      retryAt: null,
    };
  }

  const decision = routeBin({
    bin: { ...input.work, pinnedRoutineId: routine.id, heldByWorkstreamId: null },
    candidates: snapshot.candidates,
    fleetPolicy: snapshot.fleetPolicy,
    fleetInFlight: snapshot.fleetInFlight,
    now: input.now,
  });

  if (decision.ok) {
    return {
      routineId: routine.id,
      dispatch: 'ELIGIBLE',
      refusal: null,
      reason: 'Brain would fire this surface for this work now.',
      retryAt: null,
    };
  }

  const refusal = decision.refusal;
  const verdict = decision.considered.find((one) => one.routineId === routine.id)?.verdict ?? null;

  let reason: string;
  if (refusal === 'PINNED_SURFACE_UNAVAILABLE' || refusal === 'NO_ROUTINES_REGISTERED') {
    reason = 'Its account is not registered in the fleet, so it is not a routing candidate.';
  } else if (REFUSAL_WAIT[refusal] === 'CAPACITY') {
    // The router's own sentence, because at this level it is already about the
    // condition rather than the fleet, and it carries the instant it ends.
    reason = `${verdict ? `${capitalise(verdict)}. ` : ''}${
      refusal === 'FLEET_PAUSED' || refusal === 'FLEET_TARGET_REACHED' ? decision.reason : REMEDY[refusal]
    }`;
  } else {
    const detail =
      refusal === 'ALL_SURFACES_INELIGIBLE' && routine.stateReason
        ? ` (${routine.stateReason})`
        : '';
    reason = `Brain will not fire it: ${verdict ?? refusal}${detail}. ${REMEDY[refusal]}`;
  }

  return {
    routineId: routine.id,
    dispatch: REFUSAL_WAIT[refusal] === 'CAPACITY' ? 'WAITING' : 'UNUSABLE',
    refusal,
    reason,
    retryAt: decision.retryAt,
  };
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * The work a Factory campaign in one repository would put in front of the fleet.
 *
 * Shaped exactly like the bins `services/factory/remote.ts` creates for the
 * stages that push — a `FACTORY_UNITS` bin in this project, whose manifest
 * names this repository and which requires both capabilities — because those
 * are the stages a campaign cannot get past without. A surface that could take
 * the plan and not the units would read ready and strand the campaign one stage
 * later, so the stricter bin is the honest question.
 *
 * It is never written anywhere. The router and the admission rule are pure, and
 * this exists only to be asked about.
 */
export function repositoryProbeWork(input: {
  projectId: string;
  remote: string;
  requiredCapabilities: readonly string[];
}): Bin {
  const at = new Date(0).toISOString();
  const { projectId, remote } = input;
  return {
    id: 'bin_readiness_probe',
    projectId,
    layerId: null,
    kind: 'FACTORY_UNITS',
    title: 'Readiness probe',
    objective: 'Would the dispatcher fire a surface for this repository?',
    rationale: null,
    manifest: {
      objective: 'Would the dispatcher fire a surface for this repository?',
      why: 'readiness',
      repository: {
        remote,
        ref: 'main',
        baseSha: '0'.repeat(40),
        integrationBranch: 'factory/readiness-probe',
        pullRequest: null,
      },
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: null,
      retry: { maxAttempts: 1, backoffSeconds: 0 },
      stoppingConditions: [],
    },
    completionContract: 'FACTORY_UNITS_V1' as Bin['completionContract'],
    contractVersion: 1,
    state: 'READY',
    priority: 7,
    orchestrationId: null,
    budgetUnits: null,
    attemptCount: 0,
    maxAttempts: 1,
    dispatchNotBefore: null,
    heldByWorkstreamId: null,
    heldReason: null,
    leaseGeneration: 0,
    leaseId: null,
    workerId: null,
    leaseCredentialId: null,
    leaseSessionRef: null,
    leasedAt: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    leaseRenewals: 0,
    checkpoint: null,
    checkpointAt: null,
    terminalReason: null,
    requiredCapabilities: [...input.requiredCapabilities],
    workloadClass: 'FACTORY_UNIT',
    pinnedRoutineId: null,
    lastRefusal: null,
    refusalCount: 0,
    createdByType: 'SYSTEM',
    createdById: 'factory:readiness',
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    completedAt: null,
    factoryCampaignId: null,
  };
}

const RANK: Record<SurfaceDispatch, number> = { ELIGIBLE: 0, WAITING: 1, UNUSABLE: 2 };

/**
 * The best answer across several projects a surface's worker serves.
 *
 * A pool is project-agnostic — one Factory worker may be onboarded in several
 * projects — so "could a bin be routed here" is asked of each project it holds
 * a membership on, and the most favourable answer stands. A worker in no
 * project can be handed nothing, which the router says by name rather than
 * this function inventing a sentence of its own.
 */
export function bestEligibility(answers: readonly SurfaceEligibility[]): SurfaceEligibility | null {
  let best: SurfaceEligibility | null = null;
  for (const answer of answers) {
    if (!best || RANK[answer.dispatch] < RANK[best.dispatch]) best = answer;
  }
  return best;
}
