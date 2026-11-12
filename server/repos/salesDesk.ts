/**
 * The sales desk's own records (§107): leads Brain researched, replies it
 * analysed, and what it measured and decided. Brain owns these; the agents
 * service and Instantly keep nothing Brain depends on.
 */
import { getDb } from '../db/database.ts';
import type { SalesLeadRow, SalesLearningRow, SalesReplyRow } from '../domain/types.ts';
import { randomUUID } from 'node:crypto';
import { newId, nowIso, parseJson, toJson } from './util.ts';

/*
 * Ids that sort in the order they were made, so "the latest" is well defined
 * when two rows share a millisecond (they do: a pass records several at once,
 * and Postgres breaks a recorded_at tie by id where SQLite happened not to).
 */
let lastMs = 0;
let seq = 0;
function orderedId(prefix: string): string {
  const now = Date.now();
  seq = now === lastMs ? seq + 1 : 0;
  lastMs = now;
  return `${prefix}_${now.toString(36).padStart(9, '0')}${seq.toString(36).padStart(3, '0')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export type SalesVariant = SalesLeadRow['variant'];

export interface SalesLead {
  id: string;
  business: string;
  email: string;
  domain: string;
  campaignId: string | null;
  fitScore: number | null;
  fitReasons: string[];
  facts: string[];
  research: Record<string, unknown>;
  variant: SalesVariant;
  subject: string | null;
  body: string | null;
  writeNote: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapLead(row: SalesLeadRow): SalesLead {
  return {
    id: row.id,
    business: row.business,
    email: row.email,
    domain: row.domain,
    campaignId: row.campaign_id,
    fitScore: row.fit_score === null ? null : Number(row.fit_score),
    fitReasons: parseJson<string[]>(row.fit_reasons, []),
    facts: parseJson<string[]>(row.facts, []),
    research: parseJson<Record<string, unknown>>(row.research, {}),
    variant: row.variant,
    subject: row.subject,
    body: row.body,
    writeNote: row.write_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record (or replace) what Brain knows about one lead of one business. */
export async function saveSalesLead(input: {
  business: string;
  email: string;
  domain: string;
  campaignId?: string | null;
  fitScore?: number | null;
  fitReasons?: string[];
  facts?: string[];
  research?: Record<string, unknown>;
  variant: SalesVariant;
  subject?: string | null;
  body?: string | null;
  writeNote?: string | null;
}): Promise<void> {
  const now = nowIso();
  await getDb().run(
    `INSERT INTO sales_leads (id, business, email, domain, campaign_id, fit_score, fit_reasons, facts, research, variant,
       subject, body, write_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (business, email) DO UPDATE SET
       domain = excluded.domain, campaign_id = excluded.campaign_id, fit_score = excluded.fit_score,
       fit_reasons = excluded.fit_reasons, facts = excluded.facts, research = excluded.research,
       variant = excluded.variant, subject = excluded.subject, body = excluded.body,
       write_note = excluded.write_note, updated_at = excluded.updated_at`,
    [
      newId('sl'), input.business, input.email.toLowerCase(), input.domain, input.campaignId ?? null,
      input.fitScore ?? null, toJson(input.fitReasons ?? []), toJson(input.facts ?? []), toJson(input.research ?? {}),
      input.variant, input.subject ?? null, input.body ?? null, input.writeNote ?? null, now, now,
    ],
  );
}

export async function salesLead(business: string, email: string): Promise<SalesLead | null> {
  const row = await getDb().get<SalesLeadRow>('SELECT * FROM sales_leads WHERE business = ? AND email = ?', [business, email.toLowerCase()]);
  return row ? mapLead(row) : null;
}

export async function salesLeadByEmail(email: string): Promise<SalesLead | null> {
  const row = await getDb().get<SalesLeadRow>(
    'SELECT * FROM sales_leads WHERE email = ? ORDER BY updated_at DESC LIMIT 1',
    [email.toLowerCase()],
  );
  return row ? mapLead(row) : null;
}

export async function salesLeadCounts(business: string): Promise<Record<SalesVariant, number>> {
  const rows = await getDb().all<{ variant: SalesVariant; n: number | string }>(
    'SELECT variant, COUNT(*) AS n FROM sales_leads WHERE business = ? GROUP BY variant',
    [business],
  );
  const out: Record<SalesVariant, number> = { PERSONAL: 0, TEMPLATE: 0 };
  for (const r of rows) out[r.variant] = Number(r.n);
  return out;
}

export interface SalesReply {
  id: string;
  emailId: string;
  business: string;
  campaignId: string;
  leadEmail: string;
  threadId: string | null;
  receivedAt: string | null;
  replyText: string;
  intent: string;
  stage: string;
  status: string;
  optOut: Record<string, unknown> | null;
  escalation: Record<string, unknown>[] | null;
  answer: string | null;
  action: string;
  actionDetail: string;
  answerEmailId: string | null;
  recordedAt: string;
}

function mapReply(row: SalesReplyRow): SalesReply {
  return {
    id: row.id,
    emailId: row.email_id,
    business: row.business,
    campaignId: row.campaign_id,
    leadEmail: row.lead_email,
    threadId: row.thread_id,
    receivedAt: row.received_at,
    replyText: row.reply_text,
    intent: row.intent,
    stage: row.stage,
    status: row.status,
    optOut: parseJson<Record<string, unknown> | null>(row.opt_out, null),
    escalation: parseJson<Record<string, unknown>[] | null>(row.escalation, null),
    answer: row.answer,
    action: row.action,
    actionDetail: row.action_detail,
    answerEmailId: row.answer_email_id,
    recordedAt: row.recorded_at,
  };
}

export async function salesReplySeen(emailId: string): Promise<boolean> {
  return Boolean(await getDb().get<{ id: string }>('SELECT id FROM sales_replies WHERE email_id = ?', [emailId]));
}

/** Record one analysed reply. A second record for the same email id is ignored. */
export async function recordSalesReply(input: Omit<SalesReply, 'id' | 'recordedAt'>): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO sales_replies (id, email_id, business, campaign_id, lead_email, thread_id, received_at, reply_text, intent,
       stage, status, opt_out, escalation, answer, action, action_detail, answer_email_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (email_id) DO NOTHING`,
    [
      orderedId('sr'), input.emailId, input.business, input.campaignId, input.leadEmail.toLowerCase(), input.threadId,
      input.receivedAt, input.replyText.slice(0, 8000), input.intent, input.stage, input.status,
      input.optOut ? toJson(input.optOut) : null, input.escalation && input.escalation.length ? toJson(input.escalation) : null,
      input.answer, input.action, input.actionDetail.slice(0, 2000), input.answerEmailId, nowIso(),
    ],
  );
  return (result.changes ?? 0) > 0;
}

/** Every earlier reply from this lead, oldest first: the conversation Brain holds. */
export async function salesRepliesFrom(leadEmail: string): Promise<SalesReply[]> {
  return (await getDb().all<SalesReplyRow>(
    'SELECT * FROM sales_replies WHERE lead_email = ? ORDER BY recorded_at ASC, id ASC',
    [leadEmail.toLowerCase()],
  )).map(mapReply);
}

export async function salesReplies(business: string | null, limit = 500): Promise<SalesReply[]> {
  return (await getDb().all<SalesReplyRow>(
    business
      ? 'SELECT * FROM sales_replies WHERE business = ? ORDER BY recorded_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM sales_replies ORDER BY recorded_at DESC, id DESC LIMIT ?',
    business ? [business, limit] : [limit],
  )).map(mapReply);
}

export interface SalesLearning {
  id: string;
  business: string;
  kind: string;
  detail: Record<string, unknown>;
  recordedAt: string;
}

export async function recordSalesLearning(business: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  await getDb().run(
    'INSERT INTO sales_learnings (id, business, kind, detail, recorded_at) VALUES (?, ?, ?, ?, ?)',
    [orderedId('sg'), business, kind, toJson(detail), nowIso()],
  );
}

export async function latestSalesLearning(business: string, kind: string): Promise<SalesLearning | null> {
  const row = await getDb().get<SalesLearningRow>(
    'SELECT * FROM sales_learnings WHERE business = ? AND kind = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
    [business, kind],
  );
  return row ? { id: row.id, business: row.business, kind: row.kind, detail: parseJson(row.detail, {}), recordedAt: row.recorded_at } : null;
}
