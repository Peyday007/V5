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
*
 * What *is* decided here is the engineering action itself (AUTH-20-3's
 * standing-grant engineering class). An approved contract is the release
 * envelope: Factory coding and its tests are inside it once the change request
 * is approved, and a merge and a deploy are inside it only when the contract's
 * own `deploymentPolicy` declares a release. Every one of those is judged by
 * `decideAction` — the one authority every action path calls before an effect —
 * so it lands on the durable ledger as an AUTHORITY_DECISION row with its
 * principal, scope and cause, and an emergency stop or a refused envelope stops
 * the campaign before any work is dealt. No second policy engine: the envelope
 * is read from the contract row, and the judgment is the existing owner's.
 */
import { approveObjective } from './contract.ts';
import { campaignSpecFor } from './remote.ts';
import { INITIAL_LANE_TARGET } from './scheduler.ts';
import { ensureCampaign, getChangeRequest } from '../../repos/factory.ts';
import type { FactoryCampaign, FactoryChangeRequest } from '../../domain/factory.ts';
import type { ActionDecision } from '../cash/authority.ts';

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
export async function approveAndStartCampaign(
  input:
    | { changeRequestId: string; userId: string }
    /**
     * Approved on a standing authority a person granted first — §16's rule that
     * a plan may be approved without a person only inside limits a person set.
     * The authority is recorded on the change request, so "Brain approved this"
     * says under which grant. Only `services/cash/factoryHandoff.ts` passes it.
     */
    | { changeRequestId: string; standingAuthorityId: string }
    /**
     * Approved on the owner's standing improvement order (§87): the
     * `improvement_loop` switch, set by a person, for an objective on Brain's
     * own repository only. Only `services/improvement/loop.ts` passes it.
     */
    | { changeRequestId: string; improvementGrant: true },
): Promise<StartCampaignOutcome> {
  if ('improvementGrant' in input) {
    const changeRequest = await getChangeRequest(input.changeRequestId);
    if (!changeRequest) throw new Error('No such change request.');
    const { improvementGrant } = await import('../improvement/authority.ts');
    const grant = await improvementGrant(changeRequest.repository);
    if (!grant.ok) return { ok: false, reason: grant.reason, changeRequest };
    const approval = await approveObjective({
      changeRequestId: input.changeRequestId,
      via: 'STANDING_AUTHORITY',
      userId: null,
      authorityId: grant.authorityId,
    });
    if (!approval.ok) {
      return { ok: false, reason: approval.reason ?? 'The objective could not be approved.', changeRequest: approval.changeRequest };
    }
    return startApproved(approval.changeRequest, null);
  }
  /*
   * A standing authority is checked here as well as by the caller, so no
   * future entrance can approve on a grant id that is not live, not this
   * project's, or does not cover building a test.
   */
  if ('standingAuthorityId' in input) {
    const changeRequest = await getChangeRequest(input.changeRequestId);
    if (!changeRequest) throw new Error('No such change request.');
    const { checkCommercialAuthority } = await import('../cash/authority.ts');
    const decision = await checkCommercialAuthority({
      projectId: changeRequest.projectId,
      action: 'BUILD_A_TEST',
    });
    if (!decision.ok || decision.authority?.id !== input.standingAuthorityId) {
      return {
        ok: false,
        reason: `The standing authority does not cover this: ${decision.reason}.`,
        changeRequest,
      };
    }
  }
  const approval = await approveObjective(
    'standingAuthorityId' in input
      ? {
          changeRequestId: input.changeRequestId,
          via: 'STANDING_AUTHORITY',
          userId: null,
          authorityId: input.standingAuthorityId,
        }
      : { changeRequestId: input.changeRequestId, via: 'PERSON', userId: input.userId },
  );
  if (!approval.ok) {
    return {
      ok: false,
      reason: approval.reason ?? 'The objective could not be approved.',
      changeRequest: approval.changeRequest,
    };
  }

  return startApproved(approval.changeRequest, 'userId' in input ? input.userId : null);
}

/** The engineering actions a campaign for this contract performs, in the order they happen. */
export function engineeringActionsFor(changeRequest: Pick<FactoryChangeRequest, 'deploymentPolicy'>): Array<'FACTORY_CODE' | 'FACTORY_TEST' | 'FACTORY_MERGE' | 'FACTORY_DEPLOY'> {
  const actions: Array<'FACTORY_CODE' | 'FACTORY_TEST' | 'FACTORY_MERGE' | 'FACTORY_DEPLOY'> = ['FACTORY_CODE', 'FACTORY_TEST'];
  if (changeRequest.deploymentPolicy !== 'NONE') actions.push('FACTORY_MERGE', 'FACTORY_DEPLOY');
  return actions;
}

/**
 * Whether the approved contract's release envelope covers an engineering
 * action. Read from the row, never from a caller: coding and testing are inside
 * it once a person or a standing grant approved the change request; a merge and
 * a deploy are inside it only when the contract declares a release. Pure.
 */
export function releaseEnvelopeAllows(
  changeRequest: Pick<FactoryChangeRequest, 'approvedAt' | 'approvedVia' | 'deploymentPolicy'>,
  action: 'FACTORY_CODE' | 'FACTORY_TEST' | 'FACTORY_MERGE' | 'FACTORY_DEPLOY',
): boolean {
  const approved = changeRequest.approvedAt !== null && changeRequest.approvedVia !== null;
  if (!approved) return false;
  if (action === 'FACTORY_CODE' || action === 'FACTORY_TEST') return true;
  return changeRequest.deploymentPolicy !== 'NONE';
}

/**
 * Judge the campaign's engineering actions on the standing-grant engineering
 * class, each one ledgered by `decideAction`. The first refusal is returned and
 * the rest are not judged: a campaign that may not code has nothing to merge.
 */
async function judgeEngineering(approved: FactoryChangeRequest, userId: string | null): Promise<ActionDecision | null> {
  const { BRAIN_PRINCIPAL, decideAction } = await import('../cash/authority.ts');
  const principal = userId ?? approved.approvedByUserId ?? BRAIN_PRINCIPAL;
  for (const action of engineeringActionsFor(approved)) {
    const decision = await decideAction({
      projectId: approved.projectId,
      action,
      path: action === 'FACTORY_CODE' || action === 'FACTORY_TEST' ? 'INTERNAL' : 'API',
      mode: 'PERFORM',
      releaseEnvelopeAllows: releaseEnvelopeAllows(approved, action),
      principal,
      subjectRef: approved.id,
    });
    if (!decision.ok) return decision;
  }
  return null;
}

async function startApproved(approved: FactoryChangeRequest, userId: string | null): Promise<StartCampaignOutcome> {
  const refused = await judgeEngineering(approved, userId);
  if (refused) {
    return {
      ok: false,
      reason: `The campaign was not started: ${refused.ledger.action} was refused (${refused.ledger.cause}): ${refused.reason}.`,
      changeRequest: approved,
    };
  }
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
