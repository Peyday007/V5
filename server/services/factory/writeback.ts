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
 * It is a read of `loadCampaignView`, an idempotency-guarded write, and
 * nothing else: no factory table is touched here, matching
 * `server/services/russell/writeback.ts`'s own boundary between "what
 * happened" (owned elsewhere) and "the fact that it happened is now in
 * project history" (owned here).
 *
 * "Exactly one row" is a database-arbitrated guarantee, not a re-read of
 * `listEventsByEntity` in front of `recordEvent`. `project_events` carries no
 * unique constraint over (entity_type, entity_id, event_type) in either
 * migration chain, and this unit is not permitted to add one, so the
 * guarantee is built on `idempotency_operations` instead — the table §20
 * already exists for exactly this shape, with
 * `UNIQUE (scope_hash, key_fingerprint)` behind it. `runIdempotent` reserves
 * with `INSERT ... ON CONFLICT DO NOTHING`, so of any number of dispatchers
 * that reach `COMPLETE` for the same campaign and call this function
 * concurrently, exactly one wins the reservation and runs `recordEvent`
 * inside the same transaction as its own success record; every other caller
 * finds the row it collided with and returns without inserting. The
 * `listEventsByEntity` check below is a fast path for the common case — a
 * campaign whose outcome already landed on an earlier tick — and is bounded
 * by the campaign tick lease, the same narrowing (never elimination) of the
 * read-then-write window that `recoverCampaign`'s staleness bound describes;
 * it is not what makes the property true. What makes it true is the unique
 * index the reservation is refused against.
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
import {
  OperationConflict,
  OperationInProgress,
  runIdempotent,
  type OperationNamespace,
} from '../effects/engine.ts';

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

/**
 * One namespace, one campaign per key: `PROJECT` scope, because two
 * dispatchers racing to write this campaign's outcome are the same intent,
 * not two different ones — the second should join the first rather than be
 * refused as a stranger to it. `PERMANENT` retention, because this operation
 * record is the only thing standing behind "exactly one row" and must outlive
 * whatever cleanup policy `idempotency_operations` otherwise carries.
 */
const OUTCOME_NAMESPACE: OperationNamespace = {
  name: 'factory.campaign.outcome',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
};

/**
 * There is no principal here — this runs from the campaign tick, not from a
 * request — so the operation is attributed to the system rather than to
 * anyone who happened to be dispatching when the campaign finished.
 */
const WRITEBACK_PRINCIPAL_ID = 'factory-campaign-writeback';

/**
 * `assertValidKey`'s `KEY_CHARSET` already permits `_`, so a campaign id
 * (`newId('fcp')`) is a valid key as-is and this substitution is not what
 * makes it one. It exists so the key reads as a plain hyphenated slug rather
 * than exposing the id's own separator. The scope hash already carries the
 * namespace and the project, so this only has to stay injective per
 * campaign, not globally unique or secret — and it does, since a UUID's hex
 * digits never produce a `-` for the substitution to collide with.
 */
function outcomeIdempotencyKey(campaignId: string): string {
  return campaignId.replace(/_/g, '-');
}

async function findRecordedOutcome(campaignId: string): Promise<ProjectEvent | null> {
  const events = await listEventsByEntity(ENTITY_TYPE, campaignId);
  return events.find((event) => event.eventType === FACTORY_CAMPAIGN_OUTCOME) ?? null;
}

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
 * The read of `listEventsByEntity` immediately below is a fast path, not the
 * guard: a `COMPLETE` campaign practically always already has its row by the
 * time a later tick asks again, and this skips reservation machinery for that
 * common case. Two callers that both pass it because neither has written yet
 * are exactly the race this function must survive, and what survives it is
 * `runIdempotent`: it reserves this campaign's outcome as one operation keyed
 * off the campaign id, behind `idempotency_operations`'
 * `UNIQUE (scope_hash, key_fingerprint)`, and only the caller that wins the
 * reservation runs `recordEvent` — inside the same transaction as its own
 * success record, so a crash between them leaves neither. Every other caller,
 * concurrent or redelivered, is told what already happened instead of being
 * allowed to repeat it.
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

  const already = await findRecordedOutcome(campaign.id);
  if (already) {
    return { recorded: false, event: already, reason: 'already recorded' };
  }

  const review = latestReview(view);
  const payload = {
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
  };

  try {
    const outcome = await runIdempotent(
      {
        namespace: OUTCOME_NAMESPACE,
        projectId: campaign.projectId,
        key: outcomeIdempotencyKey(campaign.id),
        payload,
        principalType: 'SYSTEM',
        principalId: WRITEBACK_PRINCIPAL_ID,
      },
      async () => {
        const event = await recordEvent({
          projectId: campaign.projectId,
          entityType: ENTITY_TYPE,
          entityId: campaign.id,
          eventType: FACTORY_CAMPAIGN_OUTCOME,
          payload,
        });
        return { value: event, resultRef: event.id };
      },
    );

    switch (outcome.status) {
      case 'EXECUTED':
        return { recorded: true, event: outcome.value };
      case 'REPLAYED': {
        const recorded = await findRecordedOutcome(campaign.id);
        return { recorded: false, event: recorded, reason: 'already recorded' };
      }
      default:
        // UNCERTAIN / TERMINAL_FAILURE are outcomes of a failed executor or a
        // provider call, neither of which this same-database effect performs
        // — reachable only if `recordEvent` itself throws, which the try/catch
        // below already turns into a plain error. Handled rather than assumed
        // away, matching `RunOutcome`'s own shape.
        return {
          recorded: false,
          event: null,
          reason: `writeback did not complete (outcome: ${outcome.status})`,
        };
    }
  } catch (error) {
    if (error instanceof OperationInProgress || error instanceof OperationConflict) {
      // Another caller is mid-reservation for this same campaign right now.
      // That caller either has not committed yet (nothing to hand back) or
      // already has (the lookup below finds it) — either way this call must
      // not insert a second row.
      const recorded = await findRecordedOutcome(campaign.id);
      return {
        recorded: false,
        event: recorded,
        reason: recorded ? 'already recorded' : 'writeback already in progress elsewhere',
      };
    }
    throw error;
  }
}

/**
 * Terminal campaigns whose Brain outcome has not landed yet.
 *
 * `recordCampaignOutcome`'s idempotency guard is what makes calling it a
 * second time safe; the defect this closes is that nothing was ever calling
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
