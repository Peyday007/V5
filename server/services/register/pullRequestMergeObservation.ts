/**
 * Correcting a campaign's `PULL_REQUEST` attestation once the forge itself
 * says the request merged.
 *
 * §43 closes the register's second gap. `campaignPullRequestLink.ts` records
 * a campaign's own pull request as `EVIDENCE`, honestly `merged: false`,
 * because a `prUrl` proves only that the forge confirmed the request exists
 * (§27's rule that Brain holds no forge credential and never writes to one).
 * That link is correct the day it is written and stale from the moment the
 * request actually merges, and nothing was reading the forge again to find
 * out — so the register's ceiling stayed `PR_READY` for ever, on work that
 * had long since shipped.
 *
 * This module is the read that fixes that, and it is deliberately narrow:
 * one campaign in, exactly one call to the forge's own `readPullRequest`,
 * and a correction only when the forge itself reports `merged: true`. It
 * never reads a title, a branch name or the URL's own text to decide
 * anything — that is the invented citation §12 refuses, at this module's own
 * door.
 *
 * §27's rule that a link is corrected without being destroyed:
 * `supersedeLink` retires the stale `merged: false` link rather than
 * mutating it, and a fresh `PULL_REQUEST`/`EVIDENCE` link carries the
 * correction — with `detail.attestedBy` naming this observation, never a
 * person and never the campaign, because "the campaign says it has a
 * confirmed pull request" and "the forge says that pull request merged" are
 * two different claims with two different evidence.
 *
 * A prior round left this uncalled — the capability existed, correctly
 * sourced and tested, and nothing outside its own test file ever invoked it,
 * so it could never actually run against a real campaign. `writeback.ts`
 * calls it now, from `recordCampaignOutcome` — the same production entrance
 * that already calls `attestCampaignPullRequest` on every tick a campaign is
 * offered to — and `campaignNeedsMergeObservation` below is the predicate
 * `listCampaignsPendingOutcome` uses to decide when a campaign should keep
 * being offered for a merge check, exactly as `campaignNeedsPullRequestAttestation`
 * already decides when it should keep being offered for its first attestation.
 */
import { getCampaign, getChangeRequest } from '../../repos/factory.ts';
import { linkWorkstream, listLinks, supersedeLink, workstreamsForRef } from '../../repos/register.ts';
import { nowIso } from '../../repos/util.ts';
import { parseRemote, readPullRequest } from '../factory/forge.ts';
import { pullRequestNumber } from '../factory/remote.ts';
import type { FactoryCampaign } from '../../domain/factory.ts';

/**
 * Who this module records itself as, on the corrected link's
 * `detail.attestedBy`. Never a person and never `'factory-campaign'` (the
 * mechanism `campaignPullRequestLink.ts` names): the claim here is the
 * forge's own report of a merge, obtained by this observation.
 */
const ATTESTED_BY = 'pull-request-merge-observation';

export interface ObserveCampaignPullRequestMergeResult {
  /** False for every refusal below; true once the forge call itself succeeded. */
  ok: boolean;
  /** True only when the forge reported the pull request merged. */
  merged: boolean;
  /** Set on a refusal, naming exactly why nothing was read or written. */
  reason: string | null;
  /** The workstreams whose `PULL_REQUEST` link this call corrected. Empty unless `merged` is true. */
  correctedWorkstreamIds: string[];
}

function refused(reason: string): ObserveCampaignPullRequestMergeResult {
  return { ok: false, merged: false, reason, correctedWorkstreamIds: [] };
}

/**
 * Ask the forge whether a campaign's own pull request has merged, and
 * correct the register if it has.
 *
 * Makes exactly one outbound call — `readPullRequest` — and only when the
 * campaign already carries both a `prUrl` and a `prRef` naming a request
 * number, and its change request's `repository` parses as one this factory
 * can read. Any other condition is a named refusal that reads and writes
 * nothing.
 */
export async function observeCampaignPullRequestMerge(
  campaignId: string,
): Promise<ObserveCampaignPullRequestMergeResult> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return refused(`no such campaign: ${campaignId}`);
  }
  if (!campaign.prUrl) {
    return refused('this campaign carries no attested pull request to observe');
  }
  const number = pullRequestNumber(campaign);
  if (number === null) {
    return refused(`the campaign's prRef does not name a pull request number: ${campaign.prRef ?? '(none)'}`);
  }

  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  if (!changeRequest) {
    return refused(`no such change request: ${campaign.changeRequestId}`);
  }
  const repository = parseRemote(changeRequest.repository);
  if (!repository) {
    return refused(`the change request's repository does not parse: ${changeRequest.repository}`);
  }

  const reply = await readPullRequest(repository, number);
  if (!reply.ok || !reply.body) {
    return refused(reply.reason ?? 'the forge did not answer');
  }

  if (!reply.body.merged) {
    return { ok: true, merged: false, reason: null, correctedWorkstreamIds: [] };
  }

  const workstreamIds = await workstreamsForRef('CAMPAIGN', campaign.id);
  const correctedWorkstreamIds: string[] = [];
  const attestedAt = nowIso();

  for (const workstreamId of workstreamIds) {
    const links = await listLinks(workstreamId);
    const stale = links.find(
      (link) =>
        link.kind === 'PULL_REQUEST' &&
        link.relation === 'EVIDENCE' &&
        link.ref === campaign.prUrl &&
        link.detail.merged !== true,
    );
    if (!stale) continue;

    const superseded = await supersedeLink(
      stale.id,
      `the forge reports this pull request merged (observed by ${ATTESTED_BY})`,
    );
    if (!superseded) continue; // Another caller already corrected this exact link.

    await linkWorkstream({
      workstreamId,
      kind: 'PULL_REQUEST',
      ref: campaign.prUrl,
      relation: 'EVIDENCE',
      recordedBy: 'BRAIN',
      detail: {
        attestedBy: ATTESTED_BY,
        attestedAt,
        merged: true,
        state: 'merged',
      },
    });
    correctedWorkstreamIds.push(workstreamId);
  }

  return { ok: true, merged: true, reason: null, correctedWorkstreamIds };
}

/**
 * Would calling `observeCampaignPullRequestMerge` on this campaign right now
 * still have something to correct?
 *
 * True only when the campaign carries a confirmed pull request and at least
 * one live workstream pursuing it carries a `PULL_REQUEST`/`EVIDENCE` link for
 * that same URL still recorded `merged: false` — exactly the condition
 * `attestCampaignPullRequest` leaves behind and the one this observation
 * exists to resolve. `false` covers the case nothing here should keep
 * checking for ever: no confirmed pull request, no live workstream at all, or
 * every live workstream already carries a `merged: true` correction. A
 * caller offering campaigns to a tick on this predicate therefore keeps
 * offering one for as long as its pull request is genuinely still open, and
 * stops the instant every attestation it can see says merged.
 *
 * It says nothing about a request the forge itself never confirms merged —
 * closed without merging, for instance — because that is not a fact this
 * predicate can read: `merged` stays `false` in the forge's own answer
 * either way, and this module refuses to guess at intent from a state or a
 * title. A campaign in that shape keeps being offered, and keeps costing one
 * read-only forge call per tick, until a person corrects the link by hand or
 * the workstream that names it is archived. That is a real, known cost of
 * this design rather than an oversight: the alternative, inferring "this is
 * never merging" from the forge's own words, is the invented citation §12
 * refuses at every other door in this module.
 */
export async function campaignNeedsMergeObservation(
  campaign: Pick<FactoryCampaign, 'id' | 'prUrl'>,
): Promise<boolean> {
  if (!campaign.prUrl) return false;

  const workstreamIds = await workstreamsForRef('CAMPAIGN', campaign.id);
  for (const workstreamId of workstreamIds) {
    const links = await listLinks(workstreamId);
    const stillOpen = links.some(
      (link) =>
        link.kind === 'PULL_REQUEST' &&
        link.relation === 'EVIDENCE' &&
        link.ref === campaign.prUrl &&
        link.detail.merged !== true,
    );
    if (stillOpen) return true;
  }
  return false;
}
