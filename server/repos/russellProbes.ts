/**
 * Light probes — cheap looks with limits the server keeps.
 *
 * A probe is not a small research packet, and the difference is not a matter of
 * degree. A packet plans, researches, verifies, repairs, synthesizes, is audited
 * three ways and is filed. A probe reads a handful of allowed pages to decide
 * whether a candidate is worth a packet at all, and then stops.
 *
 * The envelope is enforced here rather than described to a model:
 *
 *   - `allowed_sources` is checked **before** a request is made, against an
 *     exact host or prefix allowlist. Checking afterwards would mean the
 *     request already happened.
 *   - `max_lookups` is counted from `russell_probe_observations` rather than
 *     from a counter a caller increments, because a counter a caller can forget
 *     to increment is not a limit.
 *   - `deadline_at` is compared to the Brain's clock, never to a worker's.
 *
 * A probe that runs out stops honestly at `UNKNOWN` or `REFUSED`. There is no
 * code path by which it becomes a packet, spends money, files a document,
 * contacts anyone or changes anything outside these two tables — and that is a
 * property of what this module does not export, not of what it promises.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  ProbeOutcome,
  ProbeRetrieval,
  ProbeState,
  RussellProbe,
  RussellProbeObservation,
  RussellProbeObservationRow,
  RussellProbeRow,
  RussellVisibility,
} from '../domain/types.ts';

function mapProbe(row: RussellProbeRow): RussellProbe {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    projectId: row.project_id,
    visibility: row.visibility as RussellVisibility,
    question: row.question,
    allowedSources: parseJson<string[]>(row.allowed_sources, []),
    maxLookups: row.max_lookups,
    deadlineAt: row.deadline_at,
    reservationId: row.reservation_id,
    state: row.state as ProbeState,
    outcome: row.outcome as ProbeOutcome | null,
    explanation: row.explanation,
    lookupsUsed: row.lookups_used,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapObservation(row: RussellProbeObservationRow): RussellProbeObservation {
  return {
    id: row.id,
    probeId: row.probe_id,
    ordinal: row.ordinal,
    sourceUrl: row.source_url,
    retrieval: row.retrieval as ProbeRetrieval,
    note: row.note,
    observedAt: row.observed_at,
  };
}

/**
 * Is this destination inside the envelope?
 *
 * Exported because the probe runner has to ask before it fetches, and because a
 * rule this consequential should be one function with one test rather than an
 * inline condition at each call site.
 *
 * A prefix entry must match on an origin boundary: `https://example.com` allows
 * `https://example.com/x` and must not allow `https://example.com.evil.test`.
 * Redirects are the caller's problem to refuse, and it must re-ask this
 * function about the location it was redirected to rather than trusting that
 * the first URL was checked.
 */
export function destinationAllowed(url: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return allowed.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (!trimmed.includes('://')) return parsed.host.toLowerCase() === trimmed.toLowerCase();
    let base: URL;
    try {
      base = new URL(trimmed);
    } catch {
      return false;
    }
    if (base.protocol !== 'https:') return false;
    if (parsed.host.toLowerCase() !== base.host.toLowerCase()) return false;
    const path = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return base.pathname === '/' || parsed.pathname === base.pathname || parsed.pathname.startsWith(path);
  });
}

export async function createProbe(input: {
  candidateId: string;
  projectId: string | null;
  visibility: RussellVisibility;
  question: string;
  allowedSources: string[];
  maxLookups: number;
  deadlineMinutes: number;
  reservationId?: string | null;
  idempotencyKey: string;
}): Promise<RussellProbe> {
  const id = newId('rpb');
  const at = nowIso();
  const deadline = new Date(Date.parse(at) + Math.max(1, input.deadlineMinutes) * 60_000).toISOString();
  await getDb().run(
    `INSERT INTO russell_probes
       (id, candidate_id, project_id, visibility, question, allowed_sources, max_lookups,
        deadline_at, reservation_id, state, outcome, explanation, lookups_used,
        idempotency_key, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, 0, ?, ?, ?, NULL)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      input.candidateId,
      input.projectId,
      input.visibility,
      input.question,
      toJson(input.allowedSources),
      Math.max(1, input.maxLookups),
      deadline,
      input.reservationId ?? null,
      input.idempotencyKey,
      at,
      at,
    ],
  );
  const rows = await getDb().all<RussellProbeRow>(
    'SELECT * FROM russell_probes WHERE idempotency_key = ?',
    [input.idempotencyKey],
  );
  if (!rows[0]) throw new Error('The probe disappeared immediately after being written.');
  return mapProbe(rows[0]);
}

export async function getProbe(id: string): Promise<RussellProbe | null> {
  const rows = await getDb().all<RussellProbeRow>('SELECT * FROM russell_probes WHERE id = ?', [id]);
  return rows[0] ? mapProbe(rows[0]) : null;
}

export async function listProbesForCandidate(candidateId: string): Promise<RussellProbe[]> {
  const rows = await getDb().all<RussellProbeRow>(
    'SELECT * FROM russell_probes WHERE candidate_id = ? ORDER BY created_at, rowid',
    [candidateId],
  );
  return rows.map(mapProbe);
}

export async function startProbe(probeId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_probes SET state = 'RUNNING', updated_at = ? WHERE id = ? AND state = 'PENDING'`,
    [nowIso(), probeId],
  );
  return result.changes === 1;
}

export interface LookupRefusal {
  ok: false;
  reason: 'NOT_RUNNING' | 'OUT_OF_LOOKUPS' | 'PAST_DEADLINE' | 'DESTINATION_NOT_ALLOWED';
  detail: string;
}
export type LookupPermission = { ok: true; ordinal: number } | LookupRefusal;

/**
 * May the probe read this, and is there budget left to?
 *
 * Asked before the fetch, and it answers from rows rather than from anything
 * the caller passed in about how many lookups it thinks it has used. The count
 * comes from the observations table, so a caller that crashed mid-probe and
 * resumed cannot get its allowance back by forgetting.
 */
export async function permitLookup(input: {
  probeId: string;
  url: string;
  at?: string;
}): Promise<LookupPermission> {
  const probe = await getProbe(input.probeId);
  if (!probe) return { ok: false, reason: 'NOT_RUNNING', detail: 'no such probe' };
  if (probe.state !== 'RUNNING') {
    return { ok: false, reason: 'NOT_RUNNING', detail: `the probe is ${probe.state}` };
  }
  const now = input.at ?? nowIso();
  if (now >= probe.deadlineAt) {
    return { ok: false, reason: 'PAST_DEADLINE', detail: 'the probe deadline has passed' };
  }
  if (!destinationAllowed(input.url, probe.allowedSources)) {
    // The refusal names the rule and not the URL. A probe's allowlist is not
    // secret, but echoing an arbitrary caller-supplied string back into a log
    // or a UI is how a reflected payload travels.
    return { ok: false, reason: 'DESTINATION_NOT_ALLOWED', detail: 'the destination is not on this probe’s allowlist' };
  }
  const used = await countObservations(input.probeId);
  if (used >= probe.maxLookups) {
    return { ok: false, reason: 'OUT_OF_LOOKUPS', detail: `the probe allows ${probe.maxLookups} lookups` };
  }
  return { ok: true, ordinal: used + 1 };
}

async function countObservations(probeId: string): Promise<number> {
  const rows = await getDb().all<{ total: number }>(
    'SELECT COUNT(*) AS total FROM russell_probe_observations WHERE probe_id = ?',
    [probeId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Record one lookup.
 *
 * `UNIQUE (probe_id, ordinal)` is what makes the count trustworthy: two writers
 * racing for the same slot cannot both take it, so the observation table is the
 * budget rather than a log of it. `lookups_used` on the probe is a denormalized
 * convenience updated alongside, and nothing reads it to make a decision.
 */
export async function recordObservation(input: {
  probeId: string;
  ordinal: number;
  sourceUrl: string;
  retrieval: ProbeRetrieval;
  note?: string | null;
}): Promise<RussellProbeObservation | null> {
  const id = newId('rpo');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_probe_observations
       (id, probe_id, ordinal, source_url, retrieval, note, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (probe_id, ordinal) DO NOTHING`,
    [id, input.probeId, input.ordinal, input.sourceUrl, input.retrieval, input.note ?? null, at],
  );
  const rows = await getDb().all<RussellProbeObservationRow>(
    'SELECT * FROM russell_probe_observations WHERE probe_id = ? AND ordinal = ?',
    [input.probeId, input.ordinal],
  );
  if (!rows[0] || rows[0].id !== id) return null;
  await getDb().run(
    'UPDATE russell_probes SET lookups_used = ?, updated_at = ? WHERE id = ?',
    [await countObservations(input.probeId), at, input.probeId],
  );
  return mapObservation(rows[0]);
}

export async function listObservations(probeId: string): Promise<RussellProbeObservation[]> {
  const rows = await getDb().all<RussellProbeObservationRow>(
    'SELECT * FROM russell_probe_observations WHERE probe_id = ? ORDER BY ordinal',
    [probeId],
  );
  return rows.map(mapObservation);
}

/**
 * End the probe with a verdict.
 *
 * Guarded on it still being unfinished, so a probe that hit its deadline and one
 * that returned an answer at the same moment settle once. `UNKNOWN` and
 * `REFUSED` are ordinary outcomes and are recorded as confidently as
 * `SUPPORTED`: a probe that could not find out is evidence about the source,
 * and pretending otherwise is what turns a bounded look into a bad answer.
 */
export async function completeProbe(input: {
  probeId: string;
  outcome: ProbeOutcome;
  explanation: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE russell_probes
        SET state = 'COMPLETE', outcome = ?, explanation = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND state IN ('PENDING','RUNNING')`,
    [input.outcome, input.explanation, at, at, input.probeId],
  );
  return result.changes === 1;
}

export async function failProbe(input: { probeId: string; explanation: string }): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE russell_probes
        SET state = 'FAILED', explanation = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND state IN ('PENDING','RUNNING')`,
    [input.explanation, at, at, input.probeId],
  );
  return result.changes === 1;
}

/**
 * Probes whose deadline has passed while still running.
 *
 * Recovery reads this at boot and ends each one at `UNKNOWN`, so a probe
 * interrupted by a restart resolves to the honest answer rather than staying
 * `RUNNING` forever. Nothing depends on a process staying alive.
 */
export async function listExpiredProbes(at?: string): Promise<RussellProbe[]> {
  const rows = await getDb().all<RussellProbeRow>(
    `SELECT * FROM russell_probes
      WHERE state IN ('PENDING','RUNNING') AND deadline_at <= ?
      ORDER BY deadline_at, rowid`,
    [at ?? nowIso()],
  );
  return rows.map(mapProbe);
}

/**
 * Every probe in one project.
 *
 * Exists because the Ideas projection needs to know, for each candidate,
 * whether anything has actually looked at it — and asking per candidate is a
 * fan-out nobody notices until there are a hundred ideas. The project boundary
 * is the probe's own column, which is the same one `listProbesForCandidate`
 * relies on through the candidate.
 */
export async function listProbesForProject(projectId: string): Promise<RussellProbe[]> {
  const rows = await getDb().all<RussellProbeRow>(
    'SELECT * FROM russell_probes WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500',
    [projectId],
  );
  return rows.map(mapProbe);
}
