/**
 * Owner notices, as rows: what Brain has to tell the owner, waiting to be delivered in the
 * owner's own Claude Code conversation (owner, 2026-11-13: "notify me DIRECTLY IN THIS
 * ORIGINAL CLAUDE CODE CONVERSATION … STOP USING INSTANTLY OR RESEND FOR OWNER
 * NOTIFICATIONS").
 *
 * Brain sends nothing outward here. A notice is a `project_events` row — READY with the
 * composed text, once per key — and a scheduled task bound to the owner's conversation reads
 * the undelivered ones through `brain_owner_notices`, announces each, and records it DELIVERED
 * through `brain_owner_notice_delivered`. Both are append-only rows on the existing event log;
 * there is no second tracker and no channel to configure.
 */
import { getDb } from '../db/database.ts';
import { recordEvent } from '../repos/events.ts';

/** The two notices Brain keeps for the owner, each its own event type and key. */
export const OWNER_NOTICE_EVENTS = {
  PLAN_READY: 'OWNER_PLAN_READY_NOTIFIED',
  IMPROVEMENT: 'OWNER_IMPROVEMENT_NOTIFIED',
  /** The hourly operations report (owner, 2026-11-13): only the newest undelivered one is ever offered. */
  REPORT: 'OWNER_OPERATIONS_REPORT',
} as const;
export type OwnerNoticeKind = keyof typeof OWNER_NOTICE_EVENTS;
const KIND_OF: Record<string, OwnerNoticeKind> = Object.fromEntries(
  Object.entries(OWNER_NOTICE_EVENTS).map(([kind, type]) => [type, kind as OwnerNoticeKind]),
);

export interface OwnerNotice {
  noticeId: string;
  kind: OwnerNoticeKind;
  projectId: string;
  readyAt: string;
  subject: string;
  text: string;
  deliveredAt: string | null;
}

interface Row {
  entity_id: string;
  project_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

async function rowsFor(noticeId: string): Promise<{ status: string; payload: Record<string, unknown>; at: string; projectId: string; type: string }[]> {
  const rows = await getDb().all<Row>(
    `SELECT entity_id, project_id, event_type, payload, created_at FROM project_events
      WHERE entity_id = ? AND event_type IN (?, ?, ?) ORDER BY created_at ASC, id ASC`,
    [noticeId, OWNER_NOTICE_EVENTS.PLAN_READY, OWNER_NOTICE_EVENTS.IMPROVEMENT, OWNER_NOTICE_EVENTS.REPORT],
  );
  return rows.map((r) => {
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    return { status: String(payload['status'] ?? ''), payload, at: r.created_at, projectId: r.project_id, type: r.event_type };
  });
}

/**
 * Record a notice READY, once per key: the first call writes the row with its composed text;
 * every later call for the same key returns that row and writes nothing, so the text the owner
 * reads is the text recorded when it first qualified.
 */
/**
 * Check-then-write is serialized per notice in this process, so two attempts at one notice (a
 * generation presumed hung and the one started after it) can never both write READY.
 */
const writing = new Map<string, Promise<unknown>>();

export async function recordOwnerNotice(input: Parameters<typeof recordOwnerNoticeNow>[0]): Promise<{ created: boolean; notice: OwnerNotice }> {
  const before = writing.get(input.noticeId) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => recordOwnerNoticeNow(input));
  writing.set(input.noticeId, mine);
  try {
    return await mine;
  } finally {
    if (writing.get(input.noticeId) === mine) writing.delete(input.noticeId);
  }
}

async function recordOwnerNoticeNow(input: {
  kind: OwnerNoticeKind;
  projectId: string;
  noticeId: string;
  subject: string;
  text: string;
  detail?: Record<string, unknown>;
}): Promise<{ created: boolean; notice: OwnerNotice }> {
  const existing = (await rowsFor(input.noticeId)).find((r) => r.status === 'READY');
  if (existing) {
    return { created: false, notice: (await readOwnerNotice(input.noticeId))! };
  }
  await recordEvent({
    projectId: input.projectId,
    entityType: 'PROJECT',
    entityId: input.noticeId,
    eventType: OWNER_NOTICE_EVENTS[input.kind],
    payload: { status: 'READY', noticeId: input.noticeId, subject: input.subject, text: input.text, ...(input.detail ?? {}) },
  });
  return { created: true, notice: (await readOwnerNotice(input.noticeId))! };
}

export async function readOwnerNotice(noticeId: string): Promise<OwnerNotice | null> {
  const rows = await rowsFor(noticeId);
  const ready = rows.find((r) => r.status === 'READY');
  if (!ready) return null;
  const delivered = rows.find((r) => r.status === 'DELIVERED');
  return {
    noticeId,
    kind: KIND_OF[ready.type]!,
    projectId: ready.projectId,
    readyAt: ready.at,
    subject: String(ready.payload['subject'] ?? ''),
    text: String(ready.payload['text'] ?? ''),
    deliveredAt: delivered?.at ?? null,
  };
}

/** Every READY notice in these projects not yet delivered, oldest first. */
export async function undeliveredOwnerNotices(projectIds: string[]): Promise<OwnerNotice[]> {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => '?').join(', ');
  const rows = await getDb().all<{ entity_id: string }>(
    `SELECT entity_id FROM project_events
      WHERE project_id IN (${marks}) AND event_type IN (?, ?) AND payload LIKE ?
      ORDER BY created_at ASC, id ASC LIMIT 200`,
    [...projectIds, OWNER_NOTICE_EVENTS.PLAN_READY, OWNER_NOTICE_EVENTS.IMPROVEMENT, '%"status":"READY"%'],
  );
  const out: OwnerNotice[] = [];
  for (const { entity_id } of rows) {
    const notice = await readOwnerNotice(entity_id);
    if (notice && !notice.deliveredAt && projectIds.includes(notice.projectId)) out.push(notice);
  }
  // Only the newest hour's report is offered (by its hour, not by when it was written, so a
  // recovered earlier hour never displaces it): an older one is superseded, never queued.
  const report = await getDb().get<{ entity_id: string }>(
    `SELECT entity_id FROM project_events WHERE project_id IN (${marks}) AND event_type = ? AND payload LIKE ?
      ORDER BY entity_id DESC LIMIT 1`,
    [...projectIds, OWNER_NOTICE_EVENTS.REPORT, '%"status":"READY"%'],
  );
  if (report) {
    const notice = await readOwnerNotice(report.entity_id);
    if (notice && !notice.deliveredAt) out.push(notice);
  }
  return out;
}

/** Record that the owner's conversation announced a notice. Idempotent: a second call changes nothing. */
export async function markOwnerNoticeDelivered(input: { noticeId: string; deliveredBy: string; where: string }): Promise<OwnerNotice | null> {
  const notice = await readOwnerNotice(input.noticeId);
  if (!notice) return null;
  if (notice.deliveredAt) return notice;
  await recordEvent({
    projectId: notice.projectId,
    entityType: 'PROJECT',
    entityId: input.noticeId,
    eventType: OWNER_NOTICE_EVENTS[notice.kind],
    payload: { status: 'DELIVERED', noticeId: input.noticeId, deliveredBy: input.deliveredBy.slice(0, 120), where: input.where.slice(0, 200) },
  });
  return readOwnerNotice(input.noticeId);
}
