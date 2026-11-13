/**
 * The memory pass: one bounded, resumable step of the whole pipeline.
 *
 * Russell's tick runs it (as the deferrable `historical-memory` pass), the
 * owner can ask for one from the page, and `npm run admin -- memory sweep`
 * runs it to completion for the initial sweep. It holds no state of its own:
 * every stage reads what is due from the rows (a version ahead of its
 * checkpoint, an idea whose evidence moved) and writes its checkpoint as it
 * finishes each item, so an interruption loses at most the item in hand and
 * nothing is processed twice.
 *
 *   absorb bridge → index → excavate → organize → reconstruct → link → hubs → reevaluate
 */
import { getDb } from '../../db/database.ts';
import { absorbBridgeConversations } from './ingest.ts';
import { conversationsToIndex, indexConversation } from './indexing.ts';
import { conversationsToExcavate, excavateConversation, ideasToReconstruct, linkOwnerIdeas, loadIdeaIndex, reconstructIdea } from './excavate.ts';
import { organizeOwner } from './organize.ts';
import { refreshHubs } from './hubs.ts';
import { deriveBrainCircumstances, reevaluate } from './rediscover.ts';
import { getCursor, setCursor } from './events.ts';

export interface MemoryPassReport {
  owners: number;
  absorbed: number;
  indexed: number;
  passages: number;
  excavated: number;
  ideasCreated: number;
  organized: number;
  reconstructed: number;
  links: number;
  hubsPrepared: number;
  surfaced: number;
  remaining: { toIndex: number; toExcavate: number; toReconstruct: number };
  stoppedForTime: boolean;
}

export interface MemoryPassOptions {
  ownerId?: string | null;
  /** Wall-clock budget; the pass stops between items once it is spent. */
  budgetMs?: number;
  now?: string;
}

const DEFAULT_BUDGET_MS = 20_000;
/** With nothing new arriving, the registry is re-read against Brain's circumstances this often. */
const REEVALUATE_EVERY_MS = 6 * 60 * 60 * 1000;

async function hasUnappliedCircumstances(ownerId: string): Promise<boolean> {
  const row = await getDb().get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM memory_circumstances WHERE owner_user_id = ? AND applied_at IS NULL',
    [ownerId],
  );
  return Number(row?.n ?? 0) > 0;
}

async function ownersWithHistory(only: string | null): Promise<string[]> {
  if (only) return [only];
  const rows = await getDb().all<{ owner_user_id: string }>(
    `SELECT DISTINCT owner_user_id FROM memory_conversations
     UNION SELECT DISTINCT owner_user_id FROM bridge_conversations WHERE message_count > 0`,
  );
  return rows.map((r) => r.owner_user_id);
}

export async function runMemoryPass(options: MemoryPassOptions = {}): Promise<MemoryPassReport> {
  const started = Date.now();
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const out = (): boolean => Date.now() - started > budget;
  const report: MemoryPassReport = {
    owners: 0, absorbed: 0, indexed: 0, passages: 0, excavated: 0, ideasCreated: 0, organized: 0, reconstructed: 0,
    links: 0, hubsPrepared: 0, surfaced: 0, remaining: { toIndex: 0, toExcavate: 0, toReconstruct: 0 }, stoppedForTime: false,
  };
  const owners = await ownersWithHistory(options.ownerId ?? null);
  report.owners = owners.length;

  for (const ownerId of owners) {
    report.absorbed += await absorbBridgeConversations(ownerId, 25);

    let indexedHere = 0;
    while (!out()) {
      const batch = await conversationsToIndex(ownerId, 10);
      if (batch.length === 0) break;
      for (const id of batch) {
        report.passages += (await indexConversation(id)).passages;
        report.indexed += 1;
        indexedHere += 1;
        if (out()) break;
      }
    }

    const index = (await conversationsToExcavate(ownerId, 1)).length > 0 ? await loadIdeaIndex(ownerId) : [];
    while (!out()) {
      const batch = await conversationsToExcavate(ownerId, 10);
      if (batch.length === 0) break;
      for (const id of batch) {
        const r = await excavateConversation(id, index);
        report.excavated += 1;
        report.ideasCreated += r.created;
        if (out()) break;
      }
    }

    // Whole-archive regrouping only when something new was indexed since the last one.
    const indexedCount = await getDb().get<{ n: number; latest: string | null }>(
      'SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM memory_conversations WHERE owner_user_id = ? AND indexed_version > 0',
      [ownerId],
    );
    const stamp = `${Number(indexedCount?.n ?? 0)}:${indexedCount?.latest ?? ''}`;
    const organizedStamp = await getCursor(ownerId, 'organized');
    const pendingIndex = (await conversationsToIndex(ownerId, 1)).length;
    let organizedNow = false;
    if (Number(indexedCount?.n ?? 0) > 0 && organizedStamp !== stamp && (pendingIndex === 0 || indexedHere === 0) && !out()) {
      await organizeOwner(ownerId);
      await setCursor(ownerId, 'organized', stamp);
      report.organized += 1;
      organizedNow = true;
    }

    while (!out()) {
      const batch = await ideasToReconstruct(ownerId, 20);
      if (batch.length === 0) break;
      for (const id of batch) {
        await reconstructIdea(id);
        report.reconstructed += 1;
        if (out()) break;
      }
    }

    const reconstructPending = (await ideasToReconstruct(ownerId, 1)).length;
    if ((organizedNow || (report.reconstructed > 0 && reconstructPending === 0)) && !out()) {
      report.links += (await linkOwnerIdeas(ownerId)).links;
      report.hubsPrepared += (await refreshHubs(ownerId)).prepared;
    }

    // Rediscovery only once the history has settled, so a half-read archive
    // does not surface a half-understood idea.
    const settled = pendingIndex === 0 && (await conversationsToExcavate(ownerId, 1)).length === 0 && reconstructPending === 0;
    const moved = indexedHere > 0 || organizedNow || report.reconstructed > 0 || report.absorbed > 0;
    const lastReevaluated = await getCursor(ownerId, 'reevaluated_at');
    const stale = !lastReevaluated || Date.now() - Date.parse(lastReevaluated) > REEVALUATE_EVERY_MS;
    if (settled && (moved || stale || (await hasUnappliedCircumstances(ownerId))) && !out()) {
      await deriveBrainCircumstances(ownerId);
      report.surfaced += (await reevaluate(ownerId, options.now)).surfaced;
    }

    report.remaining.toIndex += (await getDb().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND indexed_version < version',
      [ownerId],
    ))?.n ?? 0;
    report.remaining.toExcavate += (await getDb().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND excavated_version < indexed_version',
      [ownerId],
    ))?.n ?? 0;
    report.remaining.toReconstruct += (await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_ideas WHERE owner_user_id = ?
         AND (reconstructed_at IS NULL OR (evidence_changed_at IS NOT NULL AND evidence_changed_at > reconstructed_at))`,
      [ownerId],
    ))?.n ?? 0;
    if (out()) {
      report.stoppedForTime = true;
      break;
    }
  }
  report.remaining = {
    toIndex: Number(report.remaining.toIndex),
    toExcavate: Number(report.remaining.toExcavate),
    toReconstruct: Number(report.remaining.toReconstruct),
  };
  return report;
}

/** Run passes until nothing is due — the comprehensive initial sweep. */
export async function sweepToCompletion(options: { ownerId?: string | null; maxPasses?: number; now?: string } = {}): Promise<MemoryPassReport[]> {
  const reports: MemoryPassReport[] = [];
  for (let i = 0; i < (options.maxPasses ?? 500); i += 1) {
    const r = await runMemoryPass({ ownerId: options.ownerId ?? null, budgetMs: 60_000, now: options.now });
    reports.push(r);
    const busy = r.indexed + r.excavated + r.reconstructed + r.organized + r.absorbed;
    if (busy === 0 && r.remaining.toIndex === 0 && r.remaining.toExcavate === 0 && r.remaining.toReconstruct === 0) break;
  }
  return reports;
}
