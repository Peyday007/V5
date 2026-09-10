/**
 * Registering a site's records, and taking one typed command from a person on it.
 *
 * Everything here is a thin layer over machinery that already existed. There is
 * no second Opportunity model, no second work queue, no second command bus and
 * no second identity: a record becomes a link row plus — once somebody asks for
 * it — a `russell_candidates` row, and from that moment Russell's own loop
 * judges it, decides against the archive first, and launches only what a
 * person's standing authority permits. §21's rule about the MCP door applies
 * word for word here: this adds a way in without adding a way around.
 *
 * ---------------------------------------------------------------------------
 * The command is an idea, not work
 * ---------------------------------------------------------------------------
 *
 * §22 is explicit that a worker cannot create its own work, and the site
 * connector is a worker. So `RESEARCH_FURTHER` does not enqueue anything, does
 * not launch a mission and does not approve a plan. It captures an idea, which
 * spends nothing — and then the existing loop asks the archive first (§13),
 * forms a view, and stops at the standing authority if there is none. A person
 * on the site can ask; only a person in Russell can authorise the spending.
 *
 * That is also why the projection has a `NEEDS_PERSON` answer naming the
 * missing authority rather than a `QUEUED` that would never move.
 */
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { nowIso } from '../../repos/util.ts';
import {
  countExternalRecords,
  findExternalRecord,
  getExternalRecord,
  linkCandidate,
  listExternalRecords,
  recordRejection,
  touchExternalRecord,
  upsertExternalRecord,
  type UpsertOutcome,
} from '../../repos/externalRecords.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import { capture } from '../russell/judgment.ts';
import {
  CONTRACT_VERSION,
  MAX_RECORDS_PER_BATCH,
  actorLabel,
  parseRecord,
  type RejectedRecord,
} from './contract.ts';
import { projectRecord, type ExternalProjection } from './projection.ts';
import type {
  ExternalCommand,
  ExternalRecord,
  ExternalSourceSystem,
} from '../../domain/types.ts';

export class BatchTooLarge extends Error {
  constructor() {
    super(`A batch may carry at most ${MAX_RECORDS_PER_BATCH} records.`);
    this.name = 'BatchTooLarge';
  }
}

export interface SyncReport {
  /** Counted, not listed: the site knows what it sent. */
  imported: number;
  updated: number;
  unchanged: number;
  /** Deliveries that were older than what Brain already holds. */
  stale: number;
  rejected: RejectedRecord[];
  /** Brain's watermark after this batch, for the caller's next `since`. */
  cursor: string | null;
  /** Everything Brain now holds for this site in this project. */
  total: number;
}

/**
 * Take a batch of deliveries.
 *
 * Ordinary, boring and re-runnable. Running the same batch twice produces
 * `unchanged` for every record and writes nothing — which is what makes the
 * backfill safe to repeat rather than something anybody has to be careful with.
 */
export async function syncRecords(input: {
  projectId: string;
  sourceSystem: ExternalSourceSystem;
  records: unknown[];
  at?: string;
}): Promise<SyncReport> {
  if (input.records.length > MAX_RECORDS_PER_BATCH) throw new BatchTooLarge();
  const at = input.at ?? nowIso();

  const report: SyncReport = {
    imported: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    rejected: [],
    cursor: null,
    total: 0,
  };

  for (const raw of input.records) {
    const parsed = parseRecord(input.sourceSystem, raw);
    if (!parsed.ok) {
      report.rejected.push(parsed.rejection);
      await recordRejection({
        projectId: input.projectId,
        sourceSystem: input.sourceSystem,
        sourceRecordType: 'UNKNOWN',
        sourceRecordId: parsed.rejection.sourceRecordId,
        reason: parsed.rejection.reason,
        detail: parsed.rejection.detail,
        at,
      });
      continue;
    }

    const record = parsed.record;
    const result = await upsertExternalRecord({
      projectId: input.projectId,
      sourceSystem: record.sourceSystem,
      sourceRecordType: record.sourceRecordType,
      sourceRecordId: record.sourceRecordId,
      sourceVersion: record.sourceVersion,
      sourceCreatedAt: record.sourceCreatedAt,
      sourceRef: record.sourceRef,
      title: record.title,
      summary: record.summary,
      attributes: record.attributes,
      provenance: {
        contract: CONTRACT_VERSION,
        sourceSystem: record.sourceSystem,
        sourceRecordType: record.sourceRecordType,
        sourceRecordId: record.sourceRecordId,
        registeredAt: at,
      },
      contentHash: record.contentHash,
      idempotencyKey: record.idempotencyKey,
      at,
    });

    tally(report, result.outcome);

    /*
     * A row in the project's own append-only history, for the two outcomes that
     * changed something. `UNCHANGED` and `STALE` write nothing at all — an
     * event per poll would turn a one-minute cadence into a log nobody can read
     * and would be the connector filling the disk it is supposed to report on.
     */
    if (result.outcome === 'IMPORTED' || result.outcome === 'UPDATED') {
      await recordEvent({
        projectId: input.projectId,
        entityType: 'EXTERNAL_RECORD',
        entityId: result.record.id,
        eventType:
          result.outcome === 'IMPORTED' ? 'EXTERNAL_RECORD_IMPORTED' : 'EXTERNAL_RECORD_UPDATED',
        payload: {
          sourceSystem: record.sourceSystem,
          sourceRecordType: record.sourceRecordType,
          sourceRecordId: record.sourceRecordId,
          sourceVersion: record.sourceVersion,
          contract: CONTRACT_VERSION,
        },
      });
    }
  }

  if (report.rejected.length > 0) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'EXTERNAL_RECORD',
      entityId: null,
      eventType: 'EXTERNAL_RECORD_REJECTED',
      payload: {
        sourceSystem: input.sourceSystem,
        count: report.rejected.length,
        reasons: [...new Set(report.rejected.map((entry) => entry.reason))],
      },
    });
  }

  report.total = await countExternalRecords({
    projectId: input.projectId,
    sourceSystem: input.sourceSystem,
  });
  const tail = await listExternalRecords({
    projectId: input.projectId,
    sourceSystem: input.sourceSystem,
    limit: 1,
  });
  report.cursor = await newestCursor(input.projectId, input.sourceSystem, tail);
  return report;
}

function tally(report: SyncReport, outcome: UpsertOutcome): void {
  if (outcome === 'IMPORTED') report.imported += 1;
  else if (outcome === 'UPDATED') report.updated += 1;
  else if (outcome === 'UNCHANGED') report.unchanged += 1;
  else report.stale += 1;
}

async function newestCursor(
  projectId: string,
  sourceSystem: string,
  fallback: ExternalRecord[],
): Promise<string | null> {
  const rows = await getDb().all<{ newest: string | null }>(
    'SELECT MAX(updated_at) AS newest FROM external_records WHERE project_id = ? AND source_system = ?',
    [projectId, sourceSystem],
  );
  return rows[0]?.newest ?? fallback[0]?.updatedAt ?? null;
}

export interface ProjectionPage {
  records: ExternalProjection[];
  /** Pass back as `since` to continue. Null when nothing has ever been held. */
  cursor: string | null;
  /** True when the page was full, so the caller should ask again immediately. */
  more: boolean;
}

/**
 * The delta feed the site polls.
 *
 * Ordered by Brain's own `updated_at`, which moves both when an import changes
 * a record and when the work behind it changes state — the second through
 * `touchExternalRecord`, called from `refreshProjections` below. Without that
 * second half a site would see imports promptly and research progress never,
 * which is the failure mode a poll-based projection usually has.
 */
export async function projectionsSince(input: {
  projectId: string;
  sourceSystem: ExternalSourceSystem;
  since?: string | null;
  limit?: number;
  at?: string;
}): Promise<ProjectionPage> {
  const at = input.at ?? nowIso();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const records = await listExternalRecords({
    projectId: input.projectId,
    sourceSystem: input.sourceSystem,
    since: input.since ?? null,
    limit,
  });
  const projections: ExternalProjection[] = [];
  for (const record of records) projections.push(await projectRecord(record, at));
  return {
    records: projections,
    cursor: projections.at(-1)?.lastUpdatedAt ?? input.since ?? null,
    more: records.length === limit,
  };
}

export async function projectionFor(input: {
  projectId: string;
  sourceSystem: ExternalSourceSystem;
  sourceRecordId: string;
  at?: string;
}): Promise<ExternalProjection | null> {
  const record = await findExternalRecord(input.sourceSystem, input.sourceRecordId);
  if (!record || record.projectId !== input.projectId) return null;
  return await projectRecord(record, input.at ?? nowIso());
}

/**
 * Make a record whose *work* has moved visible to a poller again.
 *
 * The delta feed is ordered by the link row's own timestamp, and nothing about
 * the link changes when a mission starts or an audit lands. So the state is
 * derived, compared to the last one the site could have seen, and the row is
 * touched only when the answer has actually changed — which keeps the feed
 * quiet and still makes a state change visible on the next poll.
 *
 * Called from the same tick that already runs Russell's loop, so it adds a
 * cadence rather than a service.
 */
export async function refreshProjections(input: {
  limit?: number;
  at?: string;
}): Promise<{ touched: string[] }> {
  const at = input.at ?? nowIso();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM external_records
      WHERE candidate_id IS NOT NULL
      ORDER BY updated_at, rowid
      LIMIT ?`,
    [limit],
  );

  const touched: string[] = [];
  for (const row of rows) {
    const record = await getExternalRecord(row.id);
    if (!record) continue;
    const projection = await projectRecord(record, at);
    const stamped = stateStamp(projection);
    const previous = typeof record.provenance['projectionStamp'] === 'string'
      ? (record.provenance['projectionStamp'] as string)
      : null;
    if (stamped === previous) continue;
    await stampProjection(record, stamped);
    await touchExternalRecord(record.id, at);
    touched.push(record.id);
  }
  return { touched };
}

/**
 * What the site would see, reduced to a value that can be compared.
 *
 * Deliberately not the whole projection: it carries `observedAt`, which changes
 * every call, so comparing projections would touch every row every tick. This
 * is the part that means something has actually happened.
 */
function stateStamp(projection: ExternalProjection): string {
  return [
    projection.state,
    projection.priority ?? '',
    projection.stateReason,
    projection.research?.missionId ?? '',
    projection.research?.documentId ?? '',
  ].join('|');
}

async function stampProjection(record: ExternalRecord, stamp: string): Promise<void> {
  const provenance = { ...record.provenance, projectionStamp: stamp };
  await getDb().run('UPDATE external_records SET provenance = ? WHERE id = ?', [
    JSON.stringify(provenance),
    record.id,
  ]);
}

export interface CommandResult {
  /** The projection as it stands after the command. */
  projection: ExternalProjection;
  /** The Brain object the command produced or joined. */
  candidateId: string;
  /** True when this command found the record already commanded. */
  alreadyRequested: boolean;
}

export class UnknownRecord extends Error {
  constructor() {
    super('No record with that id.');
    this.name = 'UnknownRecord';
  }
}

/**
 * The one command a person on the site may issue.
 *
 * Idempotent twice over, deliberately. The route wraps it in Step 6's effect
 * engine, so a retried HTTP request replays rather than re-executes; and this
 * function is itself idempotent, so a command that reached Brain by some other
 * route still produces one idea. Belt and braces is right here because the
 * failure it prevents — two ideas for one opportunity, each researched
 * separately — spends the allowance twice and is invisible from the site.
 */
export async function runCommand(input: {
  projectId: string;
  sourceSystem: ExternalSourceSystem;
  sourceRecordId: string;
  command: ExternalCommand;
  actor?: unknown;
  at?: string;
}): Promise<CommandResult> {
  const at = input.at ?? nowIso();
  const record = await findExternalRecord(input.sourceSystem, input.sourceRecordId);
  if (!record || record.projectId !== input.projectId) throw new UnknownRecord();

  if (record.candidateId) {
    const existing = await getCandidate(record.candidateId);
    if (existing) {
      return {
        projection: await projectRecord(record, at),
        candidateId: existing.id,
        alreadyRequested: true,
      };
    }
  }

  /*
   * The statement Brain will judge.
   *
   * Composed here, from the record's own fields, rather than accepted from the
   * site. A site that could write the question would be a site that could
   * widen what gets researched, and §24's rule is that Brain composes what it
   * is going to act on.
   */
  const statement = researchQuestion(record);
  const outcome = await capture({
    title: record.title.slice(0, 200),
    statement,
    projectId: record.projectId,
    // A record on a shared operational site is not somebody's private thread.
    visibility: 'SHARED',
  });
  if (!outcome.candidate) {
    throw new Error('The idea could not be captured.');
  }

  const label = actorLabel(
    input.actor && typeof input.actor === 'object'
      ? (input.actor as Record<string, unknown>)['label']
      : null,
  );
  const linked = await linkCandidate({
    recordId: record.id,
    candidateId: outcome.candidate.id,
    command: input.command,
    byLabel: label,
    at,
  });

  await recordEvent({
    projectId: record.projectId,
    entityType: 'EXTERNAL_RECORD',
    entityId: record.id,
    eventType: 'EXTERNAL_COMMAND_ACCEPTED',
    payload: {
      sourceSystem: record.sourceSystem,
      sourceRecordId: record.sourceRecordId,
      command: input.command,
      candidateId: outcome.candidate.id,
      merged: outcome.merged,
      // Attribution as the site named it. Nothing reads this to decide anything.
      requestedBy: label,
    },
  });

  const settled = (await getExternalRecord(record.id)) ?? record;
  return {
    projection: await projectRecord(settled, at),
    candidateId: outcome.candidate.id,
    alreadyRequested: !linked,
  };
}

/**
 * The question Brain will actually answer.
 *
 * Deterministic and composed from the record, for the reason `compileMission`
 * is deterministic: a specification with an accountable author cannot widen its
 * own scope. It names what the site says is blocking the record, because that
 * is the part research can move.
 */
export function researchQuestion(record: ExternalRecord): string {
  const blocker = typeof record.attributes['primaryBlocker'] === 'string'
    ? (record.attributes['primaryBlocker'] as string)
    : null;
  const missing = Array.isArray(record.attributes['missingInformation'])
    ? (record.attributes['missingInformation'] as string[])
    : [];
  const where = typeof record.attributes['location'] === 'string'
    ? ` in ${record.attributes['location'] as string}`
    : '';

  const parts = [
    `What would we need to establish to decide whether to pursue "${record.title}"${where}?`,
  ];
  if (blocker) parts.push(`Deal Dispatch records the main obstacle as: ${blocker}.`);
  if (missing.length > 0) {
    parts.push(`It reports these as unknown: ${missing.slice(0, 8).join('; ')}.`);
  }
  parts.push(record.summary);
  return parts.join(' ').slice(0, 1_500);
}
