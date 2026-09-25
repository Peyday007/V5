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
  FactoryRelease,
  FactoryReview,
  FactoryWorkUnit,
} from '../../../server/domain/factory.ts';
import type {
  ActiveWorkItem,
  CampaignBriefing,
} from '../../../server/services/factory/projections.ts';
import type { CampaignMetrics } from '../../../server/services/factory/metrics.ts';
import type { RepositoryGrant } from '../../../server/services/factory/repositoryEnvelope.ts';
import type {
  FactoryInvitations,
  FactoryInvitationView,
  IssuedFactoryInvitation,
  OnboardResult,
  RepositoryOnboarding,
} from '../../../server/services/factory/onboard.ts';

export type {
  ActiveWorkItem,
  CampaignBriefing,
  CampaignMetrics,
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryRelease,
  FactoryReview,
  FactoryWorkUnit,
  FactoryInvitations,
  FactoryInvitationView,
  IssuedFactoryInvitation,
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
  /**
   * The release this campaign is waiting on, if it is waiting on one.
   *
   * The route has always sent it and this type dropped it, which is how the
   * second of the factory's two person-only decisions came to have a blocker on
   * the screen and no way to answer it — §35 records what an unchecked fixture
   * costs, and a type that silently loses a server field is the same defect one
   * layer along. It carries the evidence the release was requested with, so the
   * card can say what is being let out rather than asking a person to decide
   * about something it declines to describe.
   */
  decisionWaiting: FactoryRelease | null;
  campaign: FactoryCampaign;
  /**
   * The two fields the route has always sent and this type used to drop.
   *
   * `decisionWaiting` was the third, and dropping *it* is what left the
   * factory's second person-only decision with a blocker on the screen and no
   * way to answer it. These two are informational rather than a control, so
   * losing them cost a reader rather than a decision — but the defect is the
   * same one and it is the type, not the screen: a screen chooses what to
   * render, and a type that silently loses a server field makes the choice
   * invisible. `tests/factoryHttp.test.ts` holds this interface against the
   * route's own response keys now, so the next field cannot go the same way.
   */
  activeWork: ActiveWorkItem[];
  metrics: CampaignMetrics;
  units: FactoryWorkUnit[];
  review: FactoryReview | null;
  openFindings: FactoryFinding[];
}

export interface FactoryAllocation {
  windowHours: 24;
  reportExpiresAfterHours: 6;
  canReport: boolean;
  repositories: {
    grantId: string;
    remote: string;
    nextAccountId: string | null;
    explanation: string;
    accounts: {
      id: string;
      name: string;
      remainingPercent: number | null;
      reportedAt: string | null;
      reportFresh: boolean;
      fires: number;
      arrivals: number;
      providerRefusals: number;
    }[];
  }[];
}

export const FactoryApi = {
  allocation: (projectId: string): Promise<FactoryAllocation> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/factory/allocation`),

  reportAllowance: (
    projectId: string, accountId: string, remainingPercent: number,
  ): Promise<{ report: { accountId: string; remainingPercent: number; reportedAt: string } }> =>
    api(
      `/api/projects/${encodeURIComponent(projectId)}/factory/allocation/` +
        `${encodeURIComponent(accountId)}/report`,
      { method: 'POST', body: JSON.stringify({ remainingPercent }) },
    ),

  /**
   * The repositories this factory may be pointed at.
   *
   * Asked for rather than typed, because the list lives in code: a person who
   * had to guess a remote and be refused would be learning the envelope by
   * trial, and the envelope is not a secret — it holds no credential.
   */
  repositories: (
    projectId: string,
  ): Promise<{
    repositories: RepositoryOnboarding[];
    /** Same fleet snapshot as repository readiness, with account allocation. */
    allocation?: FactoryAllocation;
    /** Whether this reader may connect another Claude account to a pool here. */
    mayConnectAccounts?: boolean;
    connectAccountsRefusal?: string | null;
  }> =>
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

  /**
   * The links issued for an onboarded repository's worker, and the members one
   * may be issued for. Never a token: a link is shown once, when it is issued.
   */
  invitations: (projectId: string, grantId: string): Promise<FactoryInvitations> =>
    api(
      `/api/projects/${encodeURIComponent(projectId)}/factory/repositories/` +
        `${encodeURIComponent(grantId)}/invitations`,
    ),

  /**
   * One more Claude account for an already-onboarded worker, for one member.
   * Nothing about the repository is asked again, and no other link is touched.
   */
  invite: (projectId: string, grantId: string, intendedUserId: string): Promise<IssuedFactoryInvitation> =>
    api(
      `/api/projects/${encodeURIComponent(projectId)}/factory/repositories/` +
        `${encodeURIComponent(grantId)}/invitations`,
      { method: 'POST', body: JSON.stringify({ intendedUserId }) },
    ),

  withdrawInvitation: (
    projectId: string,
    grantId: string,
    invitationId: string,
  ): Promise<{ withdrawn: boolean }> =>
    api(
      `/api/projects/${encodeURIComponent(projectId)}/factory/repositories/` +
        `${encodeURIComponent(grantId)}/invitations/${encodeURIComponent(invitationId)}/withdraw`,
      { method: 'POST' },
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
   * The first of a person's two decisions.
   *
   * It is what makes the objective and its acceptance conditions immutable, and
   * it is what starts the campaign — so the wording beside the button says both,
   * rather than calling it "start".
   */
  approve: (changeRequestId: string): Promise<ApproveResponse> =>
    api(`/api/factory/change-requests/${encodeURIComponent(changeRequestId)}/approve`, {
      method: 'POST',
    }),

  /**
   * The second of a person's two decisions, which this module's own header said
   * existed and no screen offered.
   *
   * A campaign that reaches `AWAITING_RELEASE` parks with the blocker
   * `AWAITING_HUMAN_RELEASE` — *"the reviewable artifact is ready and a person
   * has not answered"* — and `Build.tsx` rendered exactly that sentence with
   * nothing beside it to answer with. §24's escalation nobody can resolve, on
   * the product surface, at the one stage whose entire purpose is to wait for a
   * person.
   *
   * Both answers, because a card that offers one is not a decision. The server
   * is guarded on `REQUESTED`, so a second press changes nothing rather than
   * re-stamping somebody else's answer, and `answered` says which it was.
   */
  answerRelease: (
    campaignId: string,
    decision: 'APPROVED' | 'REFUSED',
    reason: string,
  ): Promise<{ answered: boolean; release: FactoryRelease | null }> =>
    api(`/api/factory/campaigns/${encodeURIComponent(campaignId)}/release`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason }),
    }),
};
