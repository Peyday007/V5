/**
 * The operator's standing mission and the findings inventory it directs (Surge B, H2-1/H2-2/H2-7).
 *
 * Both are rows of §87's improvement register (`improvement_candidates`), not a new store:
 *
 *   MISSION    kind `OPERATOR_MISSION`, keyed e.g. `SURGE:B`; `evidence.mission` holds the text
 *              and OPEN/CLOSED. The brief reads every open mission on every run, so a mission
 *              survives restarts, deploys and a model that forgets.
 *   INVENTORY  kind `OPERATOR_INVENTORY`, keyed `SURGE-B:<issue id>`; `evidence.inventory` holds
 *              the finding (capability, symptom, evidence, root cause, severity, owner,
 *              verification criteria, result, verification, status).
 *
 * Why the register and not a workstream or a new table: the register is where the operator's
 * directives, Factory campaigns, attempts and verdicts already live (§109), keyed by the weakness
 * and deduplicated by key, with an append-only event log (`improvement_events`) — exactly what a
 * finding needs, and the campaign commissioned for a finding is a row beside it. A workstream is
 * a goal with a ledger and a plan, which a mission is not. The `evidence` JSON column holds the
 * fields, so no schema change. The loop's tick never advances these rows (`isRecordOnly`): a
 * finding becomes Factory work only through `brain_operator_commission`.
 *
 * Status lives in the evidence, never in `decision`: the register's decisions (KEPT, REVERTED, …)
 * are verdicts on a measured change, and a finding's lifecycle is not one. Every change is an
 * `improvement_events` row naming the run that made it.
 */
import { getCandidate, getCandidateByKey, listCandidates, listImprovementEvents, patchCandidate, recordImprovementEvent, upsertCandidate, type ImprovementCandidate } from '../../repos/improvement.ts';
import {
  DEFAULT_MISSION_KEY,
  INVENTORY_KEY_PREFIX,
  INVENTORY_SEVERITIES,
  INVENTORY_STATUSES,
  MISSION_MAX_CHARS,
  inventoryForBrief,
  inventoryKey,
  inventoryTransitionRefusal,
  registerSeverity,
  type InventoryItem,
  type InventorySeverity,
  type InventoryStatus,
  type InventoryVerification,
} from '../../domain/operator.ts';
import type { MetricKey } from '../../domain/improvement.ts';

/** A record-only row is never measured; the column still needs a metric, and this one is read by nothing for it. */
const RECORD_METRIC: MetricKey = 'READY_OPPORTUNITIES_PER_DAY';

export interface ChangeContext {
  runId: string | null;
  /** `operator:<runId>`, `terminal`, … — who made the change. */
  actor: string;
}

/* ------------------------------------------------------------------------- */
/* Mission                                                                    */
/* ------------------------------------------------------------------------- */

export interface Mission {
  key: string;
  candidateId: string;
  text: string;
  status: 'OPEN' | 'CLOSED';
  setAt: string;
  setBy: string;
}

function missionOf(c: ImprovementCandidate): Mission | null {
  const m = c.evidence['mission'] as Partial<Mission> | undefined;
  if (c.kind !== 'OPERATOR_MISSION' || !m || typeof m.text !== 'string') return null;
  return { key: c.weaknessKey, candidateId: c.id, text: m.text, status: m.status === 'CLOSED' ? 'CLOSED' : 'OPEN', setAt: String(m.setAt ?? c.updatedAt), setBy: String(m.setBy ?? '') };
}

export function missionKeyRefusal(key: string): string | null {
  if (!/^[A-Z0-9][A-Z0-9:_-]{1,40}$/.test(key)) return 'a mission key is upper-case letters, digits, ":", "_" or "-" (e.g. SURGE:B)';
  if (key.startsWith('OPERATOR:') || key.startsWith(INVENTORY_KEY_PREFIX)) return 'that key prefix belongs to commissions or inventory findings';
  return null;
}

/** Set or refresh a standing mission. The same key again replaces its text and reopens it. */
export async function setMission(input: { key?: string; text: string }, ctx: ChangeContext): Promise<{ ok: true; mission: Mission; created: boolean } | { ok: false; reason: string }> {
  const key = (input.key ?? DEFAULT_MISSION_KEY).trim();
  const keyRefusal = missionKeyRefusal(key);
  if (keyRefusal) return { ok: false, reason: keyRefusal };
  const text = input.text.trim();
  if (text.length < 20) return { ok: false, reason: 'a mission states what the operator is to achieve (20+ characters)' };
  if (text.length > MISSION_MAX_CHARS) return { ok: false, reason: `a mission is at most ${MISSION_MAX_CHARS} characters; put detail in the inventory` };
  const existing = await getCandidateByKey(key);
  if (existing && existing.kind !== 'OPERATOR_MISSION') return { ok: false, reason: `${key} is already a register row of another kind` };
  const at = new Date().toISOString();
  const { candidate, created } = await upsertCandidate({
    weaknessKey: key,
    kind: 'OPERATOR_MISSION',
    title: `Standing mission ${key}`,
    problem: text.slice(0, 2000),
    metric: RECORD_METRIC,
    downstreamMetric: null,
    ownerComponent: `mission:${key}`,
    frequency: 0,
    denominator: 0,
    scope: 'GENERAL',
    severity: 'HIGH',
    evidence: { mission: { text, status: 'OPEN', setAt: at, setBy: ctx.actor } },
  });
  await recordImprovementEvent({ candidateId: candidate.id, kind: 'MISSION_SET', detail: { key, runId: ctx.runId, actor: ctx.actor, created, chars: text.length } });
  return { ok: true, mission: missionOf(candidate)!, created };
}

export async function closeMission(key: string, ctx: ChangeContext): Promise<{ ok: boolean; reason: string }> {
  const row = await getCandidateByKey(key);
  const mission = row ? missionOf(row) : null;
  if (!row || !mission) return { ok: false, reason: `no mission ${key}` };
  if (mission.status === 'CLOSED') return { ok: true, reason: `${key} was already closed` };
  await patchCandidate(row.id, { evidence: { ...row.evidence, mission: { ...(row.evidence['mission'] as object), status: 'CLOSED', closedAt: new Date().toISOString(), closedBy: ctx.actor } } });
  await recordImprovementEvent({ candidateId: row.id, kind: 'MISSION_CLOSED', detail: { key, runId: ctx.runId, actor: ctx.actor } });
  return { ok: true, reason: `${key} closed` };
}

export async function openMissions(): Promise<Mission[]> {
  return (await listCandidates({ open: true }))
    .map(missionOf)
    .filter((m): m is Mission => m !== null && m.status === 'OPEN');
}

/** The mission text the brief opens with: every open mission, keyed. Empty when none. */
export async function missionForBrief(): Promise<string> {
  const missions = await openMissions();
  return missions.map((m) => `[${m.key}, set ${m.setAt} by ${m.setBy}]\n${m.text}`).join('\n\n');
}

/* ------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* ------------------------------------------------------------------------- */

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function inventoryOf(c: ImprovementCandidate): InventoryItem | null {
  const raw = c.evidence['inventory'] as Record<string, unknown> | undefined;
  if (c.kind !== 'OPERATOR_INVENTORY' || !raw) return null;
  const status = (INVENTORY_STATUSES as readonly string[]).includes(String(raw['status'])) ? (raw['status'] as InventoryStatus) : 'DISCOVERED';
  const severity = (INVENTORY_SEVERITIES as readonly string[]).includes(String(raw['severity'])) ? (raw['severity'] as InventorySeverity) : 'MINOR';
  const verification = raw['verification'] && typeof raw['verification'] === 'object' ? (raw['verification'] as InventoryVerification) : null;
  return {
    id: c.weaknessKey.slice(INVENTORY_KEY_PREFIX.length),
    status,
    capability: str(raw['capability']) ?? '',
    symptom: str(raw['symptom']) ?? c.problem,
    evidence: str(raw['evidence']) ?? '',
    rootCause: str(raw['rootCause']),
    severity,
    owner: str(raw['owner']),
    verificationCriteria: str(raw['verificationCriteria']),
    result: str(raw['result']),
    verification,
    linkedCandidates: Array.isArray(raw['linkedCandidates']) ? (raw['linkedCandidates'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    note: str(raw['note']),
  };
}

export async function listInventory(options: { status?: string } = {}): Promise<(InventoryItem & { candidateId: string; updatedAt: string })[]> {
  return (await listCandidates())
    .filter((c) => c.kind === 'OPERATOR_INVENTORY' && c.weaknessKey.startsWith(INVENTORY_KEY_PREFIX))
    .map((c) => {
      const item = inventoryOf(c);
      return item ? { ...item, candidateId: c.id, updatedAt: c.updatedAt } : null;
    })
    .filter((x): x is InventoryItem & { candidateId: string; updatedAt: string } => x !== null)
    .filter((x) => !options.status || x.status === options.status);
}

export async function getInventoryItem(id: string): Promise<(InventoryItem & { candidateId: string }) | null> {
  const key = inventoryKey(id);
  const row = key ? await getCandidateByKey(key) : null;
  const item = row ? inventoryOf(row) : null;
  return row && item ? { ...item, candidateId: row.id } : null;
}

export interface InventoryUpsert {
  id: string;
  capability?: string | null;
  symptom?: string | null;
  evidence?: string | null;
  rootCause?: string | null;
  severity?: string | null;
  owner?: string | null;
  verificationCriteria?: string | null;
  result?: string | null;
  status?: string | null;
  note?: string | null;
  verification?: Partial<InventoryVerification> | null;
  linkedCandidateId?: string | null;
}

type InventoryResult = { ok: true; item: InventoryItem; created: boolean; candidateId: string } | { ok: false; reason: string };

/**
 * Record a finding, or update the fields given on the one that exists. A new finding needs its
 * capability, symptom, evidence and severity. A status in the same call passes the same rule as
 * `setInventoryStatus` — VERIFIED_FIXED only with a verification reference.
 */
export async function upsertInventory(input: InventoryUpsert, ctx: ChangeContext): Promise<InventoryResult> {
  const key = inventoryKey(input.id);
  if (!key) return { ok: false, reason: 'id is the issue id (letters, digits, ".", "_" or "-", e.g. H2-1)' };
  const row = await getCandidateByKey(key);
  if (row && row.kind !== 'OPERATOR_INVENTORY') return { ok: false, reason: `${key} is already a register row of another kind` };
  const before = row ? inventoryOf(row) : null;
  if (input.severity && !(INVENTORY_SEVERITIES as readonly string[]).includes(input.severity)) return { ok: false, reason: `severity must be one of ${INVENTORY_SEVERITIES.join(', ')}` };
  const pick = (value: string | null | undefined, prior: string | null | undefined): string | null => (value === undefined || value === null ? (prior ?? null) : value.trim() || null);
  const capability = pick(input.capability, before?.capability);
  const symptom = pick(input.symptom, before?.symptom);
  const evidence = pick(input.evidence, before?.evidence);
  const severity = (input.severity ?? before?.severity ?? null) as InventorySeverity | null;
  if (!before) {
    const missing = [!capability && 'capability', !symptom && 'symptom', !evidence && 'evidence', !severity && 'severity'].filter(Boolean);
    if (missing.length) return { ok: false, reason: `a new finding needs ${missing.join(', ')}` };
  }
  if (input.linkedCandidateId && !(await getCandidate(input.linkedCandidateId))) return { ok: false, reason: `no register row ${input.linkedCandidateId} to link` };
  const next: InventoryItem = {
    id: key.slice(INVENTORY_KEY_PREFIX.length),
    status: before?.status ?? 'DISCOVERED',
    capability: capability!,
    symptom: symptom!,
    evidence: evidence!,
    rootCause: pick(input.rootCause, before?.rootCause),
    severity: severity!,
    owner: pick(input.owner, before?.owner),
    verificationCriteria: pick(input.verificationCriteria, before?.verificationCriteria),
    result: pick(input.result, before?.result),
    verification: before?.verification ?? null,
    linkedCandidates: [...new Set([...(before?.linkedCandidates ?? []), ...(input.linkedCandidateId ? [input.linkedCandidateId] : [])])],
    note: pick(input.note, before?.note),
  };
  if (input.status && input.status !== next.status) {
    const refusal = inventoryTransitionRefusal(next, input.status, { verification: input.verification, note: input.note });
    if (refusal) return { ok: false, reason: refusal };
    next.status = input.status as InventoryStatus;
    if (next.status === 'VERIFIED_FIXED') next.verification = verificationRecord(input.verification!, ctx, next);
  }
  return write(key, next, before, ctx);
}

/** Move a finding to a status, with the rule each status carries (H2-7: verified only with a reference). */
export async function setInventoryStatus(
  input: { id: string; status: string; note?: string | null; result?: string | null; verification?: Partial<InventoryVerification> | null },
  ctx: ChangeContext,
): Promise<InventoryResult> {
  const key = inventoryKey(input.id);
  const row = key ? await getCandidateByKey(key) : null;
  const before = row ? inventoryOf(row) : null;
  if (!key || !row || !before) return { ok: false, reason: `no inventory finding ${input.id}: upsert it first` };
  const refusal = inventoryTransitionRefusal(before, input.status, { verification: input.verification, note: input.note });
  if (refusal) return { ok: false, reason: refusal };
  const next: InventoryItem = {
    ...before,
    status: input.status as InventoryStatus,
    note: input.note?.trim() || before.note,
    result: input.result?.trim() || before.result,
  };
  if (next.status === 'VERIFIED_FIXED') next.verification = verificationRecord(input.verification!, ctx, before);
  return write(key, next, before, ctx);
}

/**
 * The verification as recorded: the reference, who recorded it, and whether the fix came from
 * one of the operator's own commissions or from elsewhere (a direct session's merge, H2-7).
 */
function verificationRecord(v: Partial<InventoryVerification>, ctx: ChangeContext, item: InventoryItem): InventoryVerification & Record<string, unknown> {
  return {
    kind: v.kind!,
    ref: v.ref!.trim(),
    detail: v.detail!.trim().slice(0, 1000),
    recordedAt: new Date().toISOString(),
    recordedBy: ctx.actor,
    runId: ctx.runId,
    source: item.linkedCandidates.length ? 'COMMISSIONED' : 'OUTSIDE_COMMISSION',
  };
}

async function write(key: string, next: InventoryItem, before: InventoryItem | null, ctx: ChangeContext): Promise<InventoryResult> {
  const { candidate, created } = await upsertCandidate({
    weaknessKey: key,
    kind: 'OPERATOR_INVENTORY',
    title: `${next.capability}: ${next.symptom}`.slice(0, 200),
    problem: next.symptom.slice(0, 2000),
    metric: RECORD_METRIC,
    downstreamMetric: null,
    // Unique per finding, so no detected weakness is ever combined into an inventory row.
    ownerComponent: `inventory:${key}`,
    frequency: 0,
    denominator: 0,
    scope: 'GENERAL',
    severity: registerSeverity(next.severity),
    evidence: { inventory: next },
  });
  const changed = (Object.keys(next) as (keyof InventoryItem)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before?.[k]));
  if (created || changed.length) {
    await recordImprovementEvent({
      candidateId: candidate.id,
      kind: 'INVENTORY_CHANGED',
      detail: { key, runId: ctx.runId, actor: ctx.actor, created, from: before?.status ?? null, to: next.status, fields: changed, ...(next.status === 'VERIFIED_FIXED' && before?.status !== 'VERIFIED_FIXED' ? { verification: next.verification } : {}) },
    });
  }
  return { ok: true, item: inventoryOf(candidate)!, created, candidateId: candidate.id };
}

/** Each finding's change history, newest first (append-only rows). */
export async function inventoryHistory(id: string, limit = 20): Promise<{ at: string; detail: Record<string, unknown> }[]> {
  const item = await getInventoryItem(id);
  if (!item) return [];
  return (await listImprovementEvents({ candidateId: item.candidateId, kinds: ['INVENTORY_CHANGED'], limit })).map((e) => ({ at: e.at, detail: e.detail }));
}

export async function inventoryBrief(): Promise<string> {
  return inventoryForBrief(await listInventory());
}
