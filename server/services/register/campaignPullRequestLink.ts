/**
 * Attesting a campaign's own pull request onto the workstreams that point at it.
 *
 * §43 closes the register's first gap: nothing recorded a campaign's pull
 * request against the workstream that pursues it, so a person had to notice
 * the request and link it by hand — and until they did, the register read
 * `IN_PROGRESS` about work that was actually waiting on a review.
 *
 * The evidence this writer stands on is two facts, not a guess read off the
 * URL: `campaign.prUrl` is never written until the forge has confirmed the
 * request exists (`verifyDelivery`/`ingestDeliverBin` in
 * `server/services/factory/remote.ts` and `remoteLoop.ts`), and the factory
 * never merges anything into a protected branch (§27 of CLAUDE.md). So a
 * `prUrl` this module sees is, by those two invariants together, a request
 * the forge has confirmed exists and that Brain has not caused to be merged
 * — which is exactly `merged: false, state: 'open'`, attested by the
 * campaign itself rather than by a person.
 *
 * This never reads the URL's own text, its title or its branch name to
 * decide anything — that would be the invented citation §12 refuses. And it
 * never records `merged: true`: correcting an open attestation to a merged
 * one is a separate observation, made from the forge's own answer, by
 * `services/register/pullRequestMergeObservation.ts`.
 *
 * `linkWorkstream` is idempotent by (workstream_id, kind, ref, relation) —
 * §43's `linkWorkstream` doc says so — so calling this function once per
 * `recordCampaignOutcome` invocation, on every terminal, finished campaign,
 * including a call that finds the outcome event already recorded, produces
 * exactly one live `PULL_REQUEST`/`EVIDENCE` link per workstream rather than
 * one per call.
 */
import { linkWorkstream, workstreamsForRef } from '../../repos/register.ts';
import { nowIso } from '../../repos/util.ts';
import type { FactoryCampaign } from '../../domain/factory.ts';

/**
 * The minimal shape this needs from a campaign. A caller that already has a
 * `FactoryCampaign` in hand (`recordCampaignOutcome` does) passes it as-is;
 * `Pick` documents that nothing else about the campaign is read here.
 */
export type CampaignForPullRequestLink = Pick<FactoryCampaign, 'id' | 'prUrl'>;

/**
 * Who this module records itself as, on the link's `detail.attestedBy`.
 *
 * Never a person and never the campaign's own id: the claim is that the
 * campaign carries a forge-confirmed `prUrl`, not that any particular row
 * asserted it, and naming the mechanism rather than an instance keeps every
 * attestation this module writes comparable.
 */
const ATTESTED_BY = 'factory-campaign';

/**
 * Record a campaign's pull request as `EVIDENCE` on every live workstream
 * that carries a live `CAMPAIGN` link to it.
 *
 * Does nothing when the campaign carries no `prUrl` (no request has been
 * confirmed to exist yet) and does nothing when no live workstream points at
 * this campaign at all — both are ordinary, silent no-ops rather than
 * refusals, because neither is a fault.
 */
export async function attestCampaignPullRequest(campaign: CampaignForPullRequestLink): Promise<void> {
  if (!campaign.prUrl) return;

  const workstreamIds = await workstreamsForRef('CAMPAIGN', campaign.id);
  if (workstreamIds.length === 0) return;

  const attestedAt = nowIso();
  for (const workstreamId of workstreamIds) {
    await linkWorkstream({
      workstreamId,
      kind: 'PULL_REQUEST',
      ref: campaign.prUrl,
      relation: 'EVIDENCE',
      recordedBy: 'BRAIN',
      detail: {
        attestedBy: ATTESTED_BY,
        attestedAt,
        merged: false,
        state: 'open',
      },
    });
  }
}
