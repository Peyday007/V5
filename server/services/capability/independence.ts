/**
 * A reading is not audited by the session that produced it.
 *
 * ---------------------------------------------------------------------------
 * The same sentence, at a third kind of work
 * ---------------------------------------------------------------------------
 *
 * §23 says it about an audit role, §27 says it about a factory review, and it
 * is true here for the identical reason: the threat an independent audit exists
 * to defeat is **one model context reviewing its own work**. A session that read
 * the blueprint and proposed fourteen definitions is not a second opinion about
 * those definitions, however the bin is labelled.
 *
 * ---------------------------------------------------------------------------
 * Where the session identity comes from
 * ---------------------------------------------------------------------------
 *
 * From Brain's own `bin_dispatch` row, never from anything a worker says about
 * itself. §24 settles this: a session identity comes from Brain's record of the
 * fire. `finishBin` clears the bin's worker, lease and credential in the same
 * statement, so a finished bin cannot say who finished it — but the dispatch
 * row it was fired through can, keyed by the lease generation each unit result
 * carries.
 *
 * The worker's reported `session_ref` is *preferred* for the arriving reviewer,
 * because an arrival Brain did not fire has no dispatch row. With neither, the
 * floor fails closed: unknown lineage is a refusal, because "we could not tell"
 * must never read the same as "we checked".
 *
 * ---------------------------------------------------------------------------
 * Why the credential is not what is compared
 * ---------------------------------------------------------------------------
 *
 * I would have reached for it first — it is the one identity in the exchange
 * the caller does not supply, which is the property every compare-and-swap in
 * this codebase rests on. It is the wrong instrument here for the reason §27
 * records: **the MCP credential is per-connector rather than per-session**, so
 * every session an account fires presents the same one and comparing
 * credentials would make every reviewer identical to every extractor and refuse
 * every audit for ever.
 */
import { getDb } from '../../db/database.ts';
import { dispatchedSessionForBin, listBinUnitResults } from '../../repos/bins.ts';
import { listSources } from '../../repos/faculties.ts';

export type CapabilityIndependenceTier = 'SESSION_SEPARATED' | 'WORKER_SEPARATED';

export interface CapabilityLineage {
  ok: boolean;
  /** The tier actually achieved, never rounded up. */
  tier: CapabilityIndependenceTier;
  reason: string | null;
}

/**
 * Which sessions and workers produced a source's reading.
 *
 * Read from the unit results the extraction bin holds: each one carries the
 * lease generation it was submitted under, and `bin_dispatch` says which
 * session Brain fired for that generation. A result whose generation resolves
 * to no dispatch contributes its worker and no session — it is an arrival Brain
 * did not fire, which is a real case and not a reason to claim more than is
 * known.
 */
export async function extractingSessions(
  extractionBinId: string,
): Promise<{ sessions: Set<string>; workers: Set<string> }> {
  const sessions = new Set<string>();
  const workers = new Set<string>();

  for (const result of await listBinUnitResults(extractionBinId)) {
    if (result.submittedBy) workers.add(result.submittedBy);
    if (result.leaseGeneration === null) continue;
    const session = await dispatchedSessionForBin(extractionBinId, result.leaseGeneration);
    if (session) sessions.add(session);
  }

  // The bin's own current session, when it still has one. A bin audited before
  // it was finished is not the ordinary case and is not a reason to miss the
  // session that is holding it right now.
  const row = await getDb().get<{ lease_session_ref: string | null; worker_id: string | null }>(
    `SELECT lease_session_ref, worker_id FROM bins WHERE id = ?`,
    [extractionBinId] as never[],
  );
  if (row?.lease_session_ref) sessions.add(row.lease_session_ref);
  if (row?.worker_id) workers.add(row.worker_id);

  return { sessions, workers };
}

/**
 * Is this arriving session independent of the reading it would judge, and how?
 *
 * Refuses rather than labels. A verdict from the context that wrote the
 * definition is the one thing this exists to prevent, so nothing is recorded at
 * all — the candidate stays `VALIDATED` and waits for a surface that did not
 * read it.
 */
export async function capabilityAuditLineage(input: {
  extractionBinId: string | null;
  reviewer: { sessionId: string | null; workerId: string | null };
}): Promise<CapabilityLineage> {
  if (input.extractionBinId === null) {
    return {
      ok: false,
      tier: 'SESSION_SEPARATED',
      reason:
        'The source records no extraction bin, so the reading this audit would judge cannot be ' +
        'attributed. An audit whose independence cannot be established did not establish it.',
    };
  }
  if (!input.reviewer.sessionId) {
    return {
      ok: false,
      tier: 'SESSION_SEPARATED',
      reason:
        'This arrival recorded no session, so its independence from the reading cannot be ' +
        'established. Unknown lineage fails closed.',
    };
  }

  const { sessions, workers } = await extractingSessions(input.extractionBinId);
  if (sessions.size === 0 && workers.size === 0) {
    return {
      ok: false,
      tier: 'SESSION_SEPARATED',
      reason:
        'Nothing is recorded about which session produced the reading, so no separation from it ' +
        'can be established. It is refused rather than assumed.',
    };
  }
  if (sessions.has(input.reviewer.sessionId)) {
    return {
      ok: false,
      tier: 'SESSION_SEPARATED',
      reason:
        `Session ${input.reviewer.sessionId} produced this reading, so its verdict on the same ` +
        'definitions is not an independent audit. The remedy is operational: a later activation ' +
        'is a distinct session, and the candidates keep their rows until one arrives.',
    };
  }

  const workerSeparated =
    input.reviewer.workerId !== null &&
    !workers.has(input.reviewer.workerId) &&
    workers.size > 0;
  return { ok: true, tier: workerSeparated ? 'WORKER_SEPARATED' : 'SESSION_SEPARATED', reason: null };
}

/**
 * The extraction bin behind an audit bin, from rows.
 *
 * The audit bin does not point at the extraction bin — the source does, and it
 * points at whichever bin is current, which by the time an audit exists is the
 * audit's own. So the link is the `capability_sources` row reached through the
 * audit bin's `created_by_id`, which `dispatchAudit` writes as
 * `capability:audit:<sourceId>` and which nothing else can set: `created_by_id`
 * is written at creation from `createBin`'s own input and is never a value a
 * worker supplies.
 */
export async function extractionBinForAudit(auditBinId: string): Promise<string | null> {
  const row = await getDb().get<{ created_by_id: string | null }>(
    `SELECT created_by_id FROM bins WHERE id = ?`,
    [auditBinId] as never[],
  );
  const createdBy = row?.created_by_id ?? '';
  const prefix = 'capability:audit:';
  if (!createdBy.startsWith(prefix)) return null;
  const sourceId = createdBy.slice(prefix.length);

  // The source's `bin_id` is the audit bin by now, so the extraction bin is
  // found the way it was recorded: the bin whose `created_by_id` names the same
  // source with the extraction prefix.
  const extraction = await getDb().get<{ id: string }>(
    `SELECT id FROM bins WHERE created_by_id = ? ORDER BY created_at DESC, id LIMIT 1`,
    [`capability:extract:${sourceId}`] as never[],
  );
  return extraction?.id ?? null;
}

/** Every source whose reading is currently awaiting or undergoing an audit. */
export async function sourcesAwaitingAudit(): Promise<string[]> {
  const sources = await listSources({ states: ['PROPOSED', 'AUDITING'] });
  return sources.map((source) => source.id);
}
