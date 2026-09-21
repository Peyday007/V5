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
 * Wiring this to run automatically — a scheduler, a tick, a route — is
 * separate, later work and outside this unit's mutation scope. What this
 * unit delivers is the capability, correctly sourced and tested directly.
 */
import { getCampaign, getChangeRequest } from '../../repos/factory.ts';
import { linkWorkstream, listLinks, supersedeLink, workstreamsForRef } from '../../repos/register.ts';
import { nowIso } from '../../repos/util.ts';
import { parseRemote, readPullRequest } from '../factory/forge.ts';
import { pullRequestNumber } from '../factory/remote.ts';

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
