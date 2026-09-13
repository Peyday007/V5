/**
 * Approving an objective and starting its campaign — once, for every entrance.
 *
 * There are two of those entrances now: the Build page, and a person
 * authorizing a software change that came out of a Russell conversation. Both
 * do exactly the same three things — approve the change request, derive how the
 * campaign runs, ensure the campaign row — and this file exists so they cannot
 * do them differently.
 *
 * That is not a tidiness argument. **A rule applied by one of two runners is
 * worse than none**, and this codebase has paid for it four times:
 * `reconcileAcceptedFragment` showed `MISSING` on a `COMPLETE` packet because
 * only the in-process orchestrator called it; `reconcileRepairs` left a repaired
 * finding listed as a remaining limitation on a pull request for the same
 * reason; `rearmSurfaceDeferredIntents` and the router disagreed about which
 * refusals an operator can answer; `linkFiledWork` had two readers of one
 * derivation. A second way to start a campaign is precisely the shape those all
 * had, so there is one.
 *
 * Nothing about the authorization lives here. Both callers have already done
 * `requirePerson` and the project check appropriate to their route before
 * reaching this, and neither may pass a principal in: this function starts a
 * campaign for a change request that is already approvable, and deciding *who*
 * may is the router's job in both cases.
 */
import { approveObjective } from './contract.ts';
import { campaignSpecFor } from './remote.ts';
import { INITIAL_LANE_TARGET } from './scheduler.ts';
import { ensureCampaign } from '../../repos/factory.ts';
import type { FactoryCampaign, FactoryChangeRequest } from '../../domain/factory.ts';

export type StartCampaignOutcome =
  | { ok: false; reason: string; changeRequest: FactoryChangeRequest }
  | {
      ok: true;
      changeRequest: FactoryChangeRequest;
      campaign: FactoryCampaign;
      campaignCreated: boolean;
      execution: { mode: FactoryCampaign['executionMode']; note: string };
    };

/**
 * Approve, then start. Idempotent at both steps and for the same reason:
 * approval is a state transition that a second call reports as already made,
 * and `ensureCampaign` is one campaign per change request decided by the
 * database — so a person pressing the button twice, a retried request and a
 * redelivered event all join the campaign that exists rather than forking it.
 */
export async function approveAndStartCampaign(input: {
  changeRequestId: string;
  userId: string;
}): Promise<StartCampaignOutcome> {
  const approval = await approveObjective({
    changeRequestId: input.changeRequestId,
    via: 'PERSON',
    userId: input.userId,
  });
  if (!approval.ok) {
    return {
      ok: false,
      reason: approval.reason ?? 'The objective could not be approved.',
      changeRequest: approval.changeRequest,
    };
  }

  const approved = approval.changeRequest;
  /*
   * How this campaign runs, and whether it continues a pull request somebody is
   * already reading — both derived from the contract and the forge rather than
   * chosen by a caller, so no entrance can disagree with another about the same
   * campaign.
   */
  const spec = await campaignSpecFor(approved);
  const { campaign, created } = await ensureCampaign({
    changeRequestId: approved.id,
    projectId: approved.projectId,
    baseSha: approved.baseSha,
    laneTarget: INITIAL_LANE_TARGET,
    laneTargetReason: 'initial',
    executionMode: spec.executionMode,
    integrationBranch: spec.integrationBranch,
    pullRequest: spec.pullRequest,
  });

  return {
    ok: true,
    changeRequest: approved,
    campaign,
    campaignCreated: created,
    execution: { mode: spec.executionMode, note: spec.note },
  };
}
