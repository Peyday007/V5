/**
 * One read of everything a reader of a campaign needs: the campaign, its
 * contract, its units, and everything judgement and execution produced about
 * them — plus the small derivations three later modules (the briefing, the
 * metrics, the PR body) would otherwise each invent for itself.
 *
 * Nothing here writes. A view is a snapshot; the campaign's own state machine
 * lives in repos/factory.ts and repos/factoryFleet.ts, untouched.
 */
import { getCampaign, getChangeRequest, listUnits } from '../../repos/factory.ts';
import {
  listFindings,
  listIntegrations,
  listReleases,
  listReviews,
  listSessions,
} from '../../repos/factoryFleet.ts';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryIntegration,
  FactoryRelease,
  FactoryReview,
  FactorySession,
  FactoryWorkUnit,
} from '../../domain/factory.ts';

export interface CampaignView {
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  units: FactoryWorkUnit[];
  sessions: FactorySession[];
  reviews: FactoryReview[];
  findings: FactoryFinding[];
  integrations: FactoryIntegration[];
  releases: FactoryRelease[];
}

/**
 * The campaign and its change request are read first: a campaign whose change
 * request has vanished is not a state this view can describe, so absence is
 * reported as `null` rather than as a view half-built around a missing
 * contract.
 */
export async function loadCampaignView(campaignId: string): Promise<CampaignView | null> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return null;
  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  if (!changeRequest) return null;

  const [units, sessions, reviews, findings, integrations, releases] = await Promise.all([
    listUnits(campaignId),
    listSessions(campaignId),
    listReviews(campaignId),
    listFindings(campaignId),
    listIntegrations(campaignId),
    listReleases(campaignId),
  ]);

  return { campaign, changeRequest, units, sessions, reviews, findings, integrations, releases };
}

/** Highest round wins; a tie goes to the later `createdAt`, then to array order. */
function pickLatest(reviews: FactoryReview[]): FactoryReview | null {
  let best: FactoryReview | null = null;
  for (const review of reviews) {
    if (
      !best ||
      review.round > best.round ||
      (review.round === best.round && review.createdAt > best.createdAt)
    ) {
      best = review;
    }
  }
  return best;
}

/** The newest review of any scope — never the last element of an unchecked list. */
export function latestReview(view: CampaignView): FactoryReview | null {
  return pickLatest(view.reviews);
}

export function integratedUnits(view: CampaignView): number {
  return view.units.filter((u) => u.state === 'INTEGRATED').length;
}

export function totalUnits(view: CampaignView): number {
  return view.units.filter((u) => u.state !== 'SUPERSEDED').length;
}

export function openFindings(view: CampaignView): FactoryFinding[] {
  return view.findings.filter((f) => f.state === 'OPEN' || f.state === 'REPAIR_QUEUED');
}

export function pendingRelease(view: CampaignView): FactoryRelease | null {
  return view.releases.find((r) => r.decision === 'REQUESTED') ?? null;
}

export interface AcceptanceConditionStatus {
  id: string;
  statement: string;
  mandatory: boolean;
  status: 'MET' | 'NOT_MET' | 'UNVERIFIED';
  basis: string;
}

/**
 * NOT_MET beats everything: an open finding naming the condition settles it
 * whatever any review says. Otherwise the condition is MET only when the
 * newest campaign-scope review — not merely the newest review of any scope —
 * passed. Everything else is UNVERIFIED; there is no inference from a
 * worker's own summary, only from these rows.
 */
export function acceptanceConditionStatus(view: CampaignView): AcceptanceConditionStatus[] {
  const openConditionIds = new Set(
    openFindings(view)
      .map((f) => f.acceptanceConditionId)
      .filter((id): id is string => id !== null),
  );
  const latestCampaignReview = pickLatest(view.reviews.filter((r) => r.scope === 'CAMPAIGN'));

  return view.changeRequest.acceptanceConditions.map((condition) => {
    if (openConditionIds.has(condition.id)) {
      return {
        id: condition.id,
        statement: condition.statement,
        mandatory: condition.mandatory,
        status: 'NOT_MET' as const,
        basis: `An open finding names acceptance condition ${condition.id}.`,
      };
    }
    if (latestCampaignReview && latestCampaignReview.verdict === 'PASS') {
      return {
        id: condition.id,
        statement: condition.statement,
        mandatory: condition.mandatory,
        status: 'MET' as const,
        basis: `No open finding names ${condition.id}, and the latest campaign-scope review (round ${latestCampaignReview.round}) passed.`,
      };
    }
    return {
      id: condition.id,
      statement: condition.statement,
      mandatory: condition.mandatory,
      status: 'UNVERIFIED' as const,
      basis: latestCampaignReview
        ? `No open finding names ${condition.id}, but the latest campaign-scope review (round ${latestCampaignReview.round}) did not pass.`
        : `No open finding names ${condition.id}, and no campaign-scope review has run yet.`,
    };
  });
}
