/**
 * What a finished campaign leaves in Brain's own project history.
 *
 * A campaign is factory state — `factory_campaigns`, `factory_work_units`,
 * `factory_reviews` and the rest, read through `loadCampaignView`. None of
 * that is `project_events`, and nothing outside `server/services/factory/`
 * reads those tables directly. So a person or a later step asking "what did
 * this campaign actually produce" against the project's own append-only
 * history — the same place a Russell mission's writeback lands — would find
 * nothing, unless one row is written there when the campaign stops moving for
 * good. This module writes exactly that row, once.
 *
 * It is a read of `loadCampaignView` and a single `recordEvent`, in that
 * order, and nothing else: no factory table is touched here, matching
 * `server/services/russell/writeback.ts`'s own boundary between "what
 * happened" (owned elsewhere) and "the fact that it happened is now in
 * project history" (owned here).
 */
import { listEventsByEntity, recordEvent } from '../../repos/events.ts';
import type { EventType, ProjectEvent } from '../../domain/types.ts';
import {
  integratedUnits,
  latestReview,
  loadCampaignView,
  openFindings,
  totalUnits,
} from './campaignView.ts';
import { getDb } from '../../db/database.ts';
import { mapCampaign } from '../../repos/factory.ts';
import type { FactoryCampaign, FactoryCampaignRow, FactoryCampaignState } from '../../domain/factory.ts';

/**
 * `EventType` has no factory member. Adding one means editing the union in
 * `server/domain/types.ts`, and that file is outside this unit's mutation
 * scope for this campaign. The `project_events.event_type` column carries no
 * CHECK constraint — nothing in the schema refuses a value the TypeScript
 * union does not know about — so a plain string cast is safe to store today.
 * The real enum member is a follow-up somebody with that file in scope
 * reviews and lands.
 */
export const FACTORY_CAMPAIGN_OUTCOME = 'FACTORY_CAMPAIGN_COMPLETED' as EventType;

const ENTITY_TYPE = 'FACTORY_CAMPAIGN';

/**
 * States a campaign does not move on from by itself. `BLOCKED` is
 * deliberately absent: §25 re-examines a blocked campaign on the next tick
 * rather than retiring it, so it is not yet the campaign's outcome — writing
 * one now could be writing a verdict the campaign has not reached.
 */
const TERMINAL_STATES: ReadonlySet<FactoryCampaignState> = new Set(['COMPLETE', 'CANCELLED']);

export interface RecordCampaignOutcomeResult {
  recorded: boolean;
  event: ProjectEvent | null;
  reason?: string;
}

/**
 * Write the one project-history row a finished campaign leaves behind.
 *
 * Guarded twice before anything is written: the campaign must actually have
 * finished (`finishedAt` set) and must be in a state nothing will move it out
 * of on its own. Refusing both of those rather than inventing a verdict is
 * the same rule §8 applies to a judge — no state moves from an outcome that
 * was never reached.
 *
 * Idempotent by reading `listEventsByEntity` first: if a row of this event
 * type already exists for this campaign, that row is handed back with
 * `recorded: false` and nothing is inserted. A redelivered tick therefore
 * never appends a second row, and two calls in a row leave exactly one.
 */
export async function recordCampaignOutcome(
  campaignId: string,
): Promise<RecordCampaignOutcomeResult> {
  const view = await loadCampaignView(campaignId);
  if (!view) {
    return { recorded: false, event: null, reason: `no such campaign: ${campaignId}` };
  }
  const { campaign } = view;

  if (!TERMINAL_STATES.has(campaign.state)) {
    return {
      recorded: false,
      event: null,
      reason: `campaign is not in a terminal state (state: ${campaign.state})`,
    };
  }
  if (!campaign.finishedAt) {
    return { recorded: false, event: null, reason: 'campaign has not finished' };
  }

  const existing = await listEventsByEntity(ENTITY_TYPE, campaignId);
  const already = existing.find((event) => event.eventType === FACTORY_CAMPAIGN_OUTCOME);
  if (already) {
    return { recorded: false, event: already, reason: 'already recorded' };
  }

  const review = latestReview(view);

  const event = await recordEvent({
    projectId: campaign.projectId,
    entityType: ENTITY_TYPE,
    entityId: campaign.id,
    eventType: FACTORY_CAMPAIGN_OUTCOME,
    payload: {
      campaignId: campaign.id,
      changeRequestId: campaign.changeRequestId,
      objective: view.changeRequest.objective,
      reviewVerdict: review?.verdict ?? null,
      independenceTier: review?.independence ?? null,
      integrationSha: campaign.integrationSha,
      unitsIntegrated: integratedUnits(view),
      unitsTotal: totalUnits(view),
      openFindings: openFindings(view).map((finding) => ({
        findingKey: finding.findingKey,
        severity: finding.severity,
        statement: finding.statement,
      })),
      finishedAt: campaign.finishedAt,
    },
  });

  return { recorded: true, event };
}

/**
 * Terminal campaigns whose Brain outcome has not landed yet.
 *
 * `recordCampaignOutcome`'s read-before-insert guard is what makes calling it
 * a second time safe; the defect this closes is that nothing was ever calling
 * it a second time. A crash between `patchCampaign(state: 'COMPLETE', ...)`
 * and this module's own insert — or a caught error from the insert itself —
 * leaves a campaign that is COMPLETE or CANCELLED, has a `finishedAt`, and
 * carries no `FACTORY_CAMPAIGN_COMPLETED` row. `listLiveCampaigns` will never
 * surface that campaign again, because by every other measure it is finished;
 * this is the query that looks specifically for the one thing still missing,
 * so a later tick can find it without re-reading every terminal campaign's
 * event history one at a time.
 */
export async function listCampaignsPendingOutcome(): Promise<FactoryCampaign[]> {
  const rows = await getDb().all<FactoryCampaignRow>(
    `SELECT c.* FROM factory_campaigns c
      LEFT JOIN project_events e
        ON e.entity_type = ? AND e.entity_id = c.id AND e.event_type = ?
      WHERE c.state IN ('COMPLETE', 'CANCELLED')
        AND c.finished_at IS NOT NULL
        AND e.id IS NULL
      ORDER BY c.finished_at`,
    [ENTITY_TYPE, FACTORY_CAMPAIGN_OUTCOME],
  );
  return rows.map(mapCampaign);
}
