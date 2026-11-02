/**
 * Whether a finished campaign's work was actually delivered, and the one record
 * that its objective reached an end.
 *
 * Measured 2026-11-02 (docs/FACTORY-PERFORMANCE-2026-11-02.md): 75 campaigns read
 * COMPLETE while 53 of their pull requests were still open, median 32 days old.
 * `COMPLETE` is the campaign's own stage — reviewed and confirmed by the forge as
 * a pull request — and nothing read the forge again afterwards unless the
 * campaign happened to be filed under a register workstream. So a pull request
 * nobody merged, closed or rebased stayed "done" for ever, and the person who
 * asked for it was told so.
 *
 * Two things live here, and nothing else:
 *
 * 1. **Delivery observation.** What the forge says happened to a finished
 *    campaign's pull request — open, merged (and whether the running Brain
 *    carries the merge), closed unmerged — written as a `DELIVERY_OBSERVED`
 *    factory event only when the answer changes. `release/outcome.ts` reads it,
 *    so the objective outcome a person or a session reads says LIVE only for
 *    work that is running, CANCELLED for a request closed unmerged, and
 *    BLOCKED with the exact action for one still waiting. Production reads the
 *    forge without a token (sixty calls an hour, shared), so one list call per
 *    repository answers every campaign, and a merged one is compared against
 *    the running revision only until it is seen deployed.
 *
 * 2. **The finished record.** `noteObjectiveOutcome` writes exactly one
 *    `OBJECTIVE_FINISHED` factory event and one project event per terminal
 *    outcome — LIVE, CANCELLED, or BLOCKED on something only a person can do —
 *    keyed through `runIdempotent`, so a tick that runs twice, or two machines,
 *    cannot announce it twice. `factory wait` exits on it and Needs-you lists
 *    the person-blocked ones. No second status is stored: the outcome stays
 *    derived (§58), and only the fact that it ended is recorded.
 */
import crypto from 'node:crypto';
import type { FactoryCampaign } from '../../domain/factory.ts';
import type { EventType } from '../../domain/types.ts';
import type { ObjectiveOutcome } from '../../domain/factoryRelease.ts';
import { listFactoryEvents, recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { getChangeRequest } from '../../repos/factory.ts';
import { recordEvent } from '../../repos/events.ts';
import { getDb } from '../../db/database.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import {
  OperationConflict,
  OperationInProgress,
  runIdempotent,
  type OperationNamespace,
} from '../effects/engine.ts';

export type DeliveryState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface DeliveryObservation {
  state: DeliveryState;
  mergeSha: string | null;
  /** True once the running Brain's revision is known to contain the merge. */
  deployed: boolean;
  /** The revision that was compared, when one was. */
  revision: string | null;
}

/** The newest observation for a campaign, or null when nobody has looked. */
export async function latestDelivery(campaignId: string): Promise<DeliveryObservation | null> {
  const events = await listFactoryEvents(campaignId, { kinds: [FACTORY_EVENT_KINDS.deliveryObserved], limit: 500 });
  const last = events.at(-1);
  if (!last) return null;
  const detail = last.detail as Partial<DeliveryObservation>;
  if (detail.state !== 'OPEN' && detail.state !== 'MERGED' && detail.state !== 'CLOSED') return null;
  return {
    state: detail.state,
    mergeSha: typeof detail.mergeSha === 'string' ? detail.mergeSha : null,
    deployed: detail.deployed === true,
    revision: typeof detail.revision === 'string' ? detail.revision : null,
  };
}

/** Nothing about this observation can change any more. */
export function deliveryIsFinal(observation: DeliveryObservation | null): boolean {
  return observation !== null && (observation.state === 'CLOSED' || (observation.state === 'MERGED' && observation.deployed));
}

export interface ForgePort {
  /** Recent pull requests of one repository, by number. Null when unreadable. */
  recent(remote: string): Promise<Map<number, { state: string; merged: boolean; mergeCommitSha: string | null }> | null>;
  /** One pull request, for one older than the recent list reaches. */
  one(remote: string, number: number): Promise<{ state: string; merged: boolean; mergeCommitSha: string | null } | null>;
  /** Whether `revision` contains `commit`. Null when unknowable. */
  contains(remote: string, commit: string, revision: string): Promise<boolean | null>;
}

async function defaultForge(): Promise<ForgePort> {
  const { parseRemote, listRecentPullRequests, readPullRequest, compareCommits } = await import('./forge.ts');
  return {
    async recent(remote) {
      const repository = parseRemote(remote);
      if (!repository) return null;
      const reply = await listRecentPullRequests(repository);
      if (!reply.ok || !reply.body) return null;
      return new Map(reply.body.map((row) => [row.number, row]));
    },
    async one(remote, number) {
      const repository = parseRemote(remote);
      if (!repository) return null;
      const reply = await readPullRequest(repository, number);
      if (!reply.ok || !reply.body) return null;
      return reply.body;
    },
    async contains(remote, commit, revision) {
      if (commit === revision) return true;
      const repository = parseRemote(remote);
      if (!repository) return null;
      const reply = await compareCommits(repository, commit, revision);
      if (!reply.ok || !reply.body) return null;
      return reply.body.status === 'ahead' || reply.body.status === 'identical';
    },
  };
}

/** How often one repository's pull requests are listed. */
export const DELIVERY_LIST_EVERY_MS = 10 * 60_000;
/** At most this many single-request or compare reads per sweep, for the shared forge budget. */
const SINGLE_READS_PER_SWEEP = 2;

const listedAt = new Map<string, number>();
const listCache = new Map<string, Map<number, { state: string; merged: boolean; mergeCommitSha: string | null }>>();
const singleAt = new Map<string, number>();

/** Tests: forget the throttles. */
export function resetDeliveryThrottle(): void {
  listedAt.clear();
  listCache.clear();
  singleAt.clear();
}

/**
 * Observe every finished campaign whose delivery can still change, writing a
 * row only when the forge's answer did. Bounded by the throttles above, so it
 * is safe to call from every tick.
 */
export async function observeDeliveries(
  campaigns: FactoryCampaign[],
  options: { forge?: ForgePort; revision?: string | null; now?: number } = {},
): Promise<{ observed: number; changed: string[] }> {
  const now = options.now ?? Date.now();
  const revision =
    options.revision !== undefined ? options.revision : (await import('../../env.ts')).BRAIN_REVISION;
  let forge: ForgePort | null = options.forge ?? null;
  let singles = 0;
  const changed: string[] = [];
  let observed = 0;
  const { pullRequestNumber } = await import('./remote.ts');

  for (const campaign of campaigns) {
    if (campaign.state !== 'COMPLETE' || !campaign.prUrl) continue;
    const number = pullRequestNumber(campaign);
    if (number === null) continue;
    const previous = await latestDelivery(campaign.id);
    if (deliveryIsFinal(previous)) continue;
    const changeRequest = await getChangeRequest(campaign.changeRequestId);
    if (!changeRequest) continue;
    const remote = changeRequest.repository;
    forge ??= await defaultForge();

    let list = listCache.get(remote) ?? null;
    if (!list || now - (listedAt.get(remote) ?? 0) >= DELIVERY_LIST_EVERY_MS) {
      listedAt.set(remote, now);
      list = await forge.recent(remote).catch(() => null);
      if (list) listCache.set(remote, list);
    }
    let pr = list?.get(number) ?? null;
    if (!pr) {
      // Older than the recent list reaches: one direct read, rate-bounded.
      const key = `${remote}#${number}`;
      if (singles >= SINGLE_READS_PER_SWEEP || now - (singleAt.get(key) ?? 0) < DELIVERY_LIST_EVERY_MS * 6) continue;
      singles += 1;
      singleAt.set(key, now);
      pr = await forge.one(remote, number).catch(() => null);
      if (!pr) continue;
    }
    observed += 1;

    const state: DeliveryState = pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';
    const mergeSha = pr.merged ? pr.mergeCommitSha : null;
    let deployed = false;
    if (state === 'MERGED' && mergeSha && revision) {
      if (previous?.state === 'MERGED' && previous.revision === revision && !previous.deployed) {
        deployed = false; // Already compared against this very revision.
      } else if (singles < SINGLE_READS_PER_SWEEP) {
        singles += 1;
        deployed = (await forge.contains(remote, mergeSha, revision).catch(() => null)) === true;
      } else {
        continue; // Compare on a later sweep rather than record a guess.
      }
    }
    const next: DeliveryObservation = { state, mergeSha, deployed, revision: state === 'MERGED' ? revision : null };
    if (
      previous &&
      previous.state === next.state &&
      previous.mergeSha === next.mergeSha &&
      previous.deployed === next.deployed &&
      previous.revision === next.revision
    ) {
      continue;
    }
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.deliveryObserved,
      evidenceClass: 'MEASURED',
      detail: { ...next, pullRequest: number },
    });
    changed.push(campaign.id);
  }
  return { observed, changed };
}

/* ------------------------------------------------------------------------- */
/* The finished record                                                         */
/* ------------------------------------------------------------------------- */

const FINISHED_NAMESPACE: OperationNamespace = {
  name: 'factory.objective.finished',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
};
export const FACTORY_OBJECTIVE_FINISHED = 'FACTORY_OBJECTIVE_FINISHED' as EventType;
const FINISHED_PRINCIPAL_ID = 'factory-objective-finished';

/** Whether an outcome is an end a session or person should hear about. */
export function isTerminalOutcome(outcome: Pick<ObjectiveOutcome, 'status' | 'needsPerson'>): boolean {
  return outcome.status === 'LIVE' || outcome.status === 'CANCELLED' || (outcome.status === 'BLOCKED' && outcome.needsPerson);
}

/** What makes two terminal outcomes the same fact. Timings never enter it. */
export function outcomeFingerprint(campaign: FactoryCampaign, outcome: ObjectiveOutcome, delivery: DeliveryObservation | null): string {
  return [
    outcome.status,
    outcome.release?.runId ?? '',
    outcome.release?.state ?? '',
    campaign.state,
    campaign.blockerKind ?? '',
    (campaign.integrationSha ?? '').slice(0, 12),
    delivery ? `${delivery.state}:${delivery.deployed ? 1 : 0}` : '',
  ].join('|');
}

export interface FinishedRecord {
  status: ObjectiveOutcome['status'];
  detail: string;
  blocker: string | null;
  personAction: string | null;
  prUrl: string | null;
  pageUrl: string | null;
  fingerprint: string;
  at: string;
}

/** Every finished record for a campaign, oldest first. */
export async function finishedRecords(campaignId: string): Promise<FinishedRecord[]> {
  const events = await listFactoryEvents(campaignId, { kinds: [FACTORY_EVENT_KINDS.objectiveFinished], limit: 500 });
  return events.map((event) => ({ ...(event.detail as Omit<FinishedRecord, 'at'>), at: event.at }));
}

/**
 * Record, exactly once, that this campaign's objective reached a terminal
 * outcome. Returns the record when this call wrote it, null otherwise.
 */
export async function noteObjectiveOutcome(campaign: FactoryCampaign): Promise<FinishedRecord | null> {
  const { objectiveOutcome } = await import('./release/outcome.ts');
  const outcome = await objectiveOutcome(campaign);
  if (!isTerminalOutcome(outcome)) return null;
  const delivery = await latestDelivery(campaign.id);
  const fingerprint = outcomeFingerprint(campaign, outcome, delivery);
  const digest = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  const record = {
    status: outcome.status,
    detail: outcome.detail,
    blocker: outcome.blocker,
    personAction: outcome.personAction,
    prUrl: outcome.prUrl,
    pageUrl: outcome.pageUrl,
    fingerprint,
  };
  try {
    const result = await runIdempotent(
      {
        namespace: FINISHED_NAMESPACE,
        projectId: campaign.projectId,
        key: `${campaign.id.replace(/_/g, '-')}.${digest}`,
        payload: record,
        principalType: 'SYSTEM',
        principalId: FINISHED_PRINCIPAL_ID,
      },
      async () => {
        const event = await recordEvent({
          projectId: campaign.projectId,
          entityType: 'FACTORY_CAMPAIGN',
          entityId: campaign.id,
          eventType: FACTORY_OBJECTIVE_FINISHED,
          payload: record,
        });
        await recordFactoryEvent({
          campaignId: campaign.id,
          kind: FACTORY_EVENT_KINDS.objectiveFinished,
          evidenceClass: 'DERIVED',
          detail: record,
        });
        return { value: event, resultRef: event.id };
      },
    );
    if (result.status !== 'EXECUTED') return null;
    return { ...record, at: result.value.createdAt };
  } catch (error) {
    if (error instanceof OperationInProgress || error instanceof OperationConflict) return null;
    throw error;
  }
}

/**
 * The finished campaigns a sweep should look at: every COMPLETE campaign whose
 * delivery is not final, newest first, so the one a session is waiting on is
 * answered before the old backlog.
 */
export async function campaignsAwaitingDelivery(limit = 200): Promise<FactoryCampaign[]> {
  const { mapCampaign } = await import('../../repos/factory.ts');
  const rows = await getDb().all<import('../../domain/factory.ts').FactoryCampaignRow>(
    `SELECT * FROM factory_campaigns
      WHERE state IN ('COMPLETE', 'CANCELLED', 'BLOCKED')
      ORDER BY updated_at DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map(mapCampaign);
}
