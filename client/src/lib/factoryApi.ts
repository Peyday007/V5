/**
 * The factory half of the door between the UI and the server.
 *
 * Its own module for the same reason `russellApi.ts` is: the surfaces answer
 * different questions and are versioned by different steps. Everything is a
 * plain function over `api()`, so no screen builds a URL and no screen sees a
 * `fetch`.
 *
 * There is deliberately no function here for anything a person may not do. The
 * factory's two human decisions are approving an objective and answering a
 * release, and both are guarded server-side by principal type — a client that
 * offered a button for something else would be a client misleading its user
 * about what will happen.
 */
import { api } from './api.ts';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryReview,
  FactoryWorkUnit,
} from '../../../server/domain/factory.ts';
import type { CampaignBriefing } from '../../../server/services/factory/projections.ts';
import type { RepositoryGrant } from '../../../server/services/factory/repositoryEnvelope.ts';
import type {
  OnboardResult,
  RepositoryOnboarding,
} from '../../../server/services/factory/onboard.ts';

export type {
  CampaignBriefing,
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryReview,
  FactoryWorkUnit,
  OnboardResult,
  RepositoryGrant,
  RepositoryOnboarding,
};

export interface SubmitObjectiveInput {
  objective: string;
  expectedOutcome: string;
  repository: string;
  baseBranch?: string;
  nonGoals?: string[];
  acceptanceConditions?: { statement: string; verification: string }[];
}

export interface SubmitResponse {
  changeRequest: FactoryChangeRequest;
  created: boolean;
  derived: {
    repository: string;
    baseBranch: string;
    baseSha: string;
    verificationCommands: string[];
    mutationScope: string[];
  };
}

export interface ApproveResponse {
  changeRequest: FactoryChangeRequest;
  campaign: FactoryCampaign;
  campaignCreated: boolean;
  /** What the server decided about how this campaign runs, in its own words. */
  execution: { mode: 'LOCAL' | 'REMOTE'; note: string };
}

export interface CampaignDetail {
  objective: string;
  expectedOutcome: string;
  stage: string;
  stageDetail: string | null;
  blocker: { kind: string; detail: string | null; remedy: string } | null;
  campaign: FactoryCampaign;
  units: FactoryWorkUnit[];
  review: FactoryReview | null;
  openFindings: FactoryFinding[];
}

export const FactoryApi = {
  /**
   * The repositories this factory may be pointed at.
   *
   * Asked for rather than typed, because the list lives in code: a person who
   * had to guess a remote and be refused would be learning the envelope by
   * trial, and the envelope is not a secret — it holds no credential.
   */
  repositories: (projectId: string): Promise<{ repositories: RepositoryOnboarding[] }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/factory/repositories`),

  /**
   * Register a worker for one authorized repository.
   *
   * The third human decision this screen offers, and the reason it belongs here
   * rather than on a terminal: it is a membership grant, which is the same
   * authority as connecting a site, and §26's rule is that a decision a person
   * makes about their own project belongs on the surface they already use.
   *
   * The reply carries the invitation link once. Nothing reads it back.
   */
  /**
   * Onboarding carries the boundary, because the boundary has no default.
   *
   * `scopeKind` is required by the route: a project owning the whole repository
   * is an ordinary answer and it has to be *given*. The defect this closes is
   * that the widest possible reach used to be what a caller got by saying
   * nothing. See `server/services/factory/projectScope.ts`.
   */
  onboard: (
    projectId: string,
    grantId: string,
    scope: { scopeKind: 'WHOLE_REPOSITORY' } | { scopeKind: 'DIRECTORIES'; directories: string[] },
  ): Promise<OnboardResult> =>
    api(
      `/api/projects/${encodeURIComponent(projectId)}/factory/repositories/` +
        `${encodeURIComponent(grantId)}/onboard`,
      { method: 'POST', body: JSON.stringify(scope) },
    ),

  changeRequests: (projectId: string): Promise<{ changeRequests: FactoryChangeRequest[] }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/factory/change-requests`),

  campaigns: (projectId: string): Promise<{ campaigns: FactoryCampaign[] }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/factory/campaigns`),

  campaign: (campaignId: string): Promise<CampaignDetail> =>
    api(`/api/factory/campaigns/${encodeURIComponent(campaignId)}`),

  briefing: (campaignId: string): Promise<CampaignBriefing | null> =>
    api(`/api/factory/campaigns/${encodeURIComponent(campaignId)}/briefing`),

  submit: (projectId: string, input: SubmitObjectiveInput): Promise<SubmitResponse> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/factory/change-requests`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * The first of a person's two decisions, and the only one this screen offers.
   *
   * It is what makes the objective and its acceptance conditions immutable, and
   * it is what starts the campaign — so the wording beside the button says both,
   * rather than calling it "start".
   */
  approve: (changeRequestId: string): Promise<ApproveResponse> =>
    api(`/api/factory/change-requests/${encodeURIComponent(changeRequestId)}/approve`, {
      method: 'POST',
    }),
};
