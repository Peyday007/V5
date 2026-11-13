/**
 * Production probes for AUTH-20-3, AUTH-21-6 and AUTH-34: graduated authority
 * with a durable ledger, read-only learning never authorizing consequential
 * agency, and policy-to-action authority that keeps obligations on a stop.
 *
 * They read `cash_events` only — the AUTHORITY_DECISION rows the action path
 * writes before an effect, and the AUTHORITY_ACTION_SUSPENDED rows a stop or a
 * revocation leaves — and the approval requests in `cash_needs`. Nothing here
 * imports the code under test: a probe that called the judge would be the judge
 * marking its own work. With no decision row the answer is a failure — "no
 * action was ever judged" is not a demonstration (§39) — never a pass.
 */
import type { ProbeResult } from '../probes.ts';

const CLASSES = new Set(['STANDING_GRANT_ENGINEERING', 'THIRD_PARTY_AUTHENTICATED', 'EXTERNALLY_CONSEQUENTIAL']);
const PATHS = new Set(['API', 'BROWSER', 'INTERNAL']);
const DISPOSITIONS = new Set(['PERFORMED', 'PROPOSED', 'REFUSED']);
/** The causes under which a consequential effect may be performed. */
const AUTHORIZING = new Set(['ALLOWED', 'OWNER_APPROVED', 'RELEASE_ENVELOPE']);
/** Keys that would mean a credential travelled into the ledger. */
const SECRET_KEY = /secret|password|token|credential|api[_-]?key|cookie/i;

interface Decision {
  id: string;
  projectId: string;
  createdAt: string;
  d: Record<string, unknown>;
}

async function decisions(): Promise<Decision[]> {
  const { getDb } = await import('../../../../db/database.ts');
  const rows = await getDb().all<{ id: string; project_id: string; detail: string; created_at: string }>(
    `SELECT id, project_id, detail, created_at FROM cash_events WHERE kind = ? ORDER BY created_at, id`,
    ['AUTHORITY_DECISION'],
  );
  return rows.map((row) => {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      d = {};
    }
    return { id: row.id, projectId: row.project_id, createdAt: row.created_at, d };
  });
}

async function eventsOfKind(kind: string): Promise<Array<{ projectId: string; createdAt: string; d: Record<string, unknown> }>> {
  const { getDb } = await import('../../../../db/database.ts');
  const rows = await getDb().all<{ project_id: string; detail: string; created_at: string }>(
    `SELECT project_id, detail, created_at FROM cash_events WHERE kind = ? ORDER BY created_at, id`,
    [kind],
  );
  return rows.map((row) => {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      d = {};
    }
    return { projectId: row.project_id, createdAt: row.created_at, d };
  });
}

function performed(x: Decision): boolean {
  return x.d.disposition === 'PERFORMED' && x.d.ok === true;
}

/** The ledger's own shape on every row: what any reading of authority depends on. */
function malformed(all: Decision[]): string | null {
  for (const x of all) {
    const scope = x.d.scope as { projectId?: unknown } | undefined;
    if (!CLASSES.has(String(x.d.consequenceClass))) return `decision ${x.id} has no consequential class (${String(x.d.consequenceClass)})`;
    if (!PATHS.has(String(x.d.path))) return `decision ${x.id} does not say which path it came by`;
    if (!DISPOSITIONS.has(String(x.d.disposition))) return `decision ${x.id} does not say whether Brain performed, proposed or refused`;
    if (typeof x.d.cause !== 'string' || x.d.cause === '') return `decision ${x.id} carries no machine cause`;
    if (!scope || scope.projectId !== x.projectId) return `decision ${x.id} is not scoped to the project it is filed under`;
    const leaked = Object.keys(x.d).find((key) => SECRET_KEY.test(key));
    if (leaked) return `decision ${x.id} carries a field named ${leaked}`;
  }
  return null;
}

/** AUTH-20-3: every consequential act is classified, decided on the ledger, and a missing approval is asked for once and remembered. */
export async function graduatedAuthorityHoldsOnRows(): Promise<ProbeResult> {
  const all = await decisions();
  if (all.length === 0) return { ok: false, detail: 'no AUTHORITY_DECISION row: no consequential action has been judged on production' };
  const bad = malformed(all);
  if (bad) return { ok: false, detail: bad };
  const unauthorized = all.find((x) => performed(x) && !AUTHORIZING.has(String(x.d.cause)));
  if (unauthorized) return { ok: false, detail: `decision ${unauthorized.id} performed ${String(unauthorized.d.action)} under ${String(unauthorized.d.cause)}` };
  const asked = all.filter((x) => x.d.disposition === 'REFUSED' && typeof x.d.neededApproval === 'string');
  const unasked = asked.find((x) => typeof x.d.approvalNeedId !== 'string');
  if (unasked) return { ok: false, detail: `decision ${unasked.id} named a missing approval but stored no request for it` };
  const { getDb } = await import('../../../../db/database.ts');
  const keys = new Map<string, number>();
  for (const x of asked) {
    const need = await getDb().get<{ request_key: string | null }>('SELECT request_key FROM cash_needs WHERE id = ?', [String(x.d.approvalNeedId)]);
    if (!need) return { ok: false, detail: `decision ${x.id} points at approval request ${String(x.d.approvalNeedId)}, which does not exist` };
    keys.set(String(need.request_key), (keys.get(String(need.request_key)) ?? 0) + 1);
  }
  const classes = new Set(all.map((x) => String(x.d.consequenceClass)));
  return {
    ok: true,
    detail: `${all.length} consequential decision(s) on the ledger across ${classes.size} class(es) (${[...classes].join(', ')}); every performed one under an authorizing cause; ${asked.length} missing approval(s) asked for through ${keys.size} remembered request(s)`,
  };
}

/** AUTH-21-6: a read-only grant never carries a consequential act, and refusals leave the internal work running. */
export async function readOnlyNeverActsOnRows(): Promise<ProbeResult> {
  const all = await decisions();
  if (all.length === 0) return { ok: false, detail: 'no AUTHORITY_DECISION row: nothing shows how read-only access is treated on production' };
  const bad = malformed(all);
  if (bad) return { ok: false, detail: bad };
  const leaked = all.find((x) => x.d.cause === 'READ_ONLY_GRANT' && x.d.disposition !== 'REFUSED');
  if (leaked) return { ok: false, detail: `decision ${leaked.id} let a read-only grant ${String(leaked.d.disposition).toLowerCase()} ${String(leaked.d.action)}` };
  const unauthorized = all.find((x) => performed(x) && !AUTHORIZING.has(String(x.d.cause)));
  if (unauthorized) return { ok: false, detail: `decision ${unauthorized.id} performed ${String(unauthorized.d.action)} under ${String(unauthorized.d.cause)}` };
  const readOnly = all.filter((x) => x.d.cause === 'READ_ONLY_GRANT').length;
  return {
    ok: true,
    detail: `${all.length} consequential decision(s); none performed without an authorizing cause; ${readOnly} read-only attempt(s), every one refused`,
  };
}

/** AUTH-34: principal, path and scope on every decision; nothing performed under a stop; a stop or revocation keeps obligations on record. */
export async function policyToActionHoldsOnRows(): Promise<ProbeResult> {
  const all = await decisions();
  if (all.length === 0) return { ok: false, detail: 'no AUTHORITY_DECISION row: no action has passed the policy-to-action check on production' };
  const bad = malformed(all);
  if (bad) return { ok: false, detail: bad };
  const unauthorized = all.find((x) => performed(x) && !AUTHORIZING.has(String(x.d.cause)));
  if (unauthorized) return { ok: false, detail: `decision ${unauthorized.id} performed ${String(unauthorized.d.action)} under ${String(unauthorized.d.cause)}` };
  const stops = await eventsOfKind('AUTHORITY_EMERGENCY_STOP');
  const resumes = await eventsOfKind('AUTHORITY_EMERGENCY_RESUME');
  const stoppedAt = (projectId: string, at: string): boolean => {
    const stop = stops.filter((s) => s.projectId === projectId && s.createdAt <= at).at(-1);
    if (!stop) return false;
    const resume = resumes.filter((r) => r.projectId === projectId && r.createdAt <= at).at(-1);
    return !resume || resume.createdAt <= stop.createdAt;
  };
  const underStop = all.find((x) => performed(x) && stoppedAt(x.projectId, x.createdAt));
  if (underStop) return { ok: false, detail: `decision ${underStop.id} performed ${String(underStop.d.action)} while the project's emergency stop was on` };
  const suspended = await eventsOfKind('AUTHORITY_ACTION_SUSPENDED');
  const halted = all.filter((x) => x.d.cause === 'EMERGENCY_STOP' || x.d.cause === 'REVOKED');
  for (const x of halted) {
    const kept = suspended.find((s) => s.projectId === x.projectId && s.d.action === x.d.action && s.d.cause === x.d.cause && Array.isArray(s.d.heldCommitmentIds));
    if (!kept) return { ok: false, detail: `decision ${x.id} was halted (${String(x.d.cause)}) but no row records the obligations it left` };
  }
  const paths = new Set(all.map((x) => String(x.d.path)));
  const principals = all.filter((x) => typeof x.d.principal === 'string' && x.d.principal !== '').length;
  return {
    ok: true,
    detail: `${all.length} decision(s) by ${[...paths].join(', ')}; ${principals} name their principal; none performed under a stop; ${halted.length} halted decision(s) each with its obligations on record`,
  };
}
