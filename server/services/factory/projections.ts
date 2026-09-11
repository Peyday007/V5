/**
 * What a person watching one campaign is shown: the objective, the stage, what
 * is actually running, the blocker if there is one, and the result — with
 * nothing invented.
 *
 * The rule this file exists to enforce is the one the campaign objective
 * states directly: no progress percentage anybody invented. `stage` and a
 * blocker's remedy are each an exhaustive `Record` over a closed domain enum,
 * so a state or a blocker kind added to `domain/factory.ts` fails typecheck
 * here rather than silently falling through to a blank string. `progress` is
 * either a literal count of unit rows or a non-numeric label — never a ratio,
 * a fraction, a percentage, a confidence or an estimate.
 */
import {
  integratedUnits,
  latestReview,
  loadCampaignView,
  openFindings,
  pendingRelease,
  totalUnits,
} from './campaignView.ts';
import type {
  FactoryBlockerKind,
  FactoryCampaignState,
  FactoryRole,
  FactoryUnitState,
} from '../../domain/factory.ts';

/** One plain-English sentence per campaign state. Adding a state fails typecheck here first. */
const STAGE_SENTENCES: Record<FactoryCampaignState, string> = {
  PLANNING: 'The campaign is planning: turning the objective into a graph of units.',
  EXECUTING: 'Units are being implemented.',
  INTEGRATING: 'A finished unit is being merged into the campaign branch and verified.',
  REVIEWING: 'The integrated work is being reviewed by an independent session.',
  REPAIRING: 'A review finding is being repaired.',
  VERIFYING: "The campaign's verification commands are being run.",
  ASSEMBLING: 'The pull request title and body are being assembled from the finished work.',
  AWAITING_RELEASE: 'The campaign is finished and is waiting for a person to approve its release.',
  COMPLETE: 'The campaign is complete.',
  BLOCKED: 'The campaign is blocked and cannot proceed on its own.',
  CANCELLED: 'The campaign was cancelled.',
};

/** One operational remedy per blocker kind. Adding a kind fails typecheck here first. */
const BLOCKER_REMEDIES: Record<FactoryBlockerKind, string> = {
  NO_HEALTHY_EXECUTION_SURFACE: 'Register or restore a worker that can execute this campaign.',
  NO_ELIGIBLE_REVIEWER:
    'Register or free up a worker that can review independently of whoever implemented the work.',
  DEPENDENCY_CYCLE: 'Fix the plan: two or more units depend on each other in a cycle.',
  STALE_BASE: "Rebase the campaign's integration branch onto the repository's current base.",
  UNIT_EXHAUSTED_ATTEMPTS: 'A unit exhausted its attempts; raise its ceiling or replan the work.',
  CONTRADICTORY_CONTRACT: 'Resolve the contradiction in the change request before continuing.',
  AWAITING_HUMAN_RELEASE: 'A person needs to approve or refuse the release.',
  /*
   * Not "give Brain the credential". Brain holds none and must not: access to a
   * repository is granted where the worker runs, which is §27's mechanism rather
   * than a preference. The remedy has to name the place a person can actually act.
   */
  EXTERNAL_CREDENTIAL_REQUIRED:
    'Grant the repository where the workers run — attach it to a worker surface. ' +
    'Brain holds no repository credential and must not.',
};

/** A unit somebody is actually working on right now, as opposed to waiting or done. */
const ACTIVE_UNIT_STATES: readonly FactoryUnitState[] = ['LEASED', 'IMPLEMENTED'];

export interface ActiveWorkItem {
  unitKey: string;
  title: string;
  state: FactoryUnitState;
  role: FactoryRole;
}

export interface CampaignBlocker {
  kind: FactoryBlockerKind;
  detail: string | null;
  remedy: string;
}

export interface CampaignResult {
  integrationSha: string | null;
  unitsIntegrated: number;
  latestReviewVerdict: string | null;
  latestReviewIndependence: string | null;
  openFindings: number;
}

export type PersonNeeded =
  | { needed: false }
  | { needed: true; kind: 'RELEASE_APPROVAL' | 'BLOCKER'; detail: string };

export type CampaignProgress =
  | { kind: 'MILESTONE'; integratedUnits: number; totalUnits: number }
  | { kind: 'NONE'; label: string };

export interface CampaignBriefing {
  objective: string;
  expectedOutcome: string;
  stage: string;
  activeWork: {
    units: ActiveWorkItem[];
    readyCount: number;
    blockedCount: number;
  };
  blocker: CampaignBlocker | null;
  result: CampaignResult | null;
  personNeeded: PersonNeeded;
  progress: CampaignProgress;
}

/**
 * The briefing for one campaign, or `null` when it does not resolve.
 *
 * Read-only: everything here is a derivation over `loadCampaignView`'s rows,
 * and nothing is written.
 */
export async function campaignBriefing(campaignId: string): Promise<CampaignBriefing | null> {
  const view = await loadCampaignView(campaignId);
  if (!view) return null;
  const { campaign, changeRequest, units } = view;

  const activeUnits = units.filter((u) => ACTIVE_UNIT_STATES.includes(u.state));
  const readyCount = units.filter((u) => u.state === 'READY').length;
  const blockedCount = units.filter((u) => u.state === 'BLOCKED').length;

  const blocker: CampaignBlocker | null = campaign.blockerKind
    ? {
        kind: campaign.blockerKind,
        detail: campaign.blockerDetail,
        remedy: BLOCKER_REMEDIES[campaign.blockerKind],
      }
    : null;

  const result: CampaignResult | null =
    campaign.state === 'COMPLETE'
      ? {
          integrationSha: campaign.integrationSha,
          unitsIntegrated: integratedUnits(view),
          latestReviewVerdict: latestReview(view)?.verdict ?? null,
          latestReviewIndependence: latestReview(view)?.independence ?? null,
          openFindings: openFindings(view).length,
        }
      : null;

  const release = pendingRelease(view);
  const personNeeded: PersonNeeded = release
    ? {
        needed: true,
        kind: 'RELEASE_APPROVAL',
        detail: `A ${release.kind} release is awaiting approval.`,
      }
    : blocker
      ? { needed: true, kind: 'BLOCKER', detail: blocker.remedy }
      : { needed: false };

  const total = totalUnits(view);
  const progress: CampaignProgress =
    total > 0
      ? { kind: 'MILESTONE', integratedUnits: integratedUnits(view), totalUnits: total }
      : { kind: 'NONE', label: campaign.state === 'PLANNING' ? 'Planning' : 'Waiting for a worker' };

  return {
    objective: changeRequest.objective,
    expectedOutcome: changeRequest.expectedOutcome,
    stage: STAGE_SENTENCES[campaign.state],
    activeWork: {
      units: activeUnits.map((u) => ({
        unitKey: u.unitKey,
        title: u.title,
        state: u.state,
        role: u.role,
      })),
      readyCount,
      blockedCount,
    },
    blocker,
    result,
    personNeeded,
    progress,
  };
}
