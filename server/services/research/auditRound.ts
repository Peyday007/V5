/**
 * Which audit round a pass belongs to.
 *
 * A packet is audited once, normally, and then there is one round and this
 * module answers null to everything. It exists for the case §24's handoff
 * creates: a document that reached `OTHER_LAYER` and moved to the layer that
 * owns it was judged against the criteria of a layer it has since left, so that
 * verdict is history and the three roles have to run again where the work now
 * lives.
 *
 * **The boundary is a timestamp, not a mutation.** The obvious alternative was
 * to cancel or supersede the completed passes so every role lookup stopped
 * finding them — and that destroys the record of an audit that really happened,
 * three real sessions and three real verdicts, to make a bookkeeping lookup come
 * out differently. §5 is unambiguous: a failed run is never overwritten and
 * neither is a superseded one. Every pass stays exactly as it was written; which
 * round it belongs to is decided by comparing its clock to the handoff's.
 *
 * The boundary is read from `project_events`, which is append-only, so it cannot
 * be moved backwards to re-admit a pass a later round has superseded.
 *
 * ---------------------------------------------------------------------------
 * One rule, every reader
 * ---------------------------------------------------------------------------
 *
 * This lives in its own module because the boundary has four readers and they
 * must not disagree: the brief a role works from, the runner deciding which
 * roles are outstanding, the admission check deciding who may take one, and the
 * allocator ranking where to send it. A boundary applied by three of the four is
 * worse than none — it would let a judge be admitted against the *previous*
 * round's arguments, which is the one thing the three roles exist to prevent.
 */
import type { ResearchPass } from '../../domain/types.ts';
import { listPasses } from '../../repos/research.ts';
import { getDb } from '../../db/database.ts';
import { parseJson } from '../../repos/util.ts';

/**
 * When this packet's current audit round began, or null if it has only had one.
 *
 * Newest handoff wins: a document routed twice is on its third round, and the
 * rounds before it are history in exactly the same way.
 */
/** Every event type that begins a new audit round. Both are append-only. */
const ROUND_EVENTS = ['DOCUMENT_HANDED_OFF', 'AUDIT_ROUND_REOPENED'] as const;

/**
 * The current round, as the one rule its readers share.
 *
 * `since` is the boundary. `carried` is the set of audit ordinals an integrity
 * reopen decided may be kept from the previous round — a role whose session
 * authored nothing and which depends on no role being rerun. A handoff carries
 * nothing, so this is empty for one and the behaviour is exactly what it was.
 *
 * Returned as one object rather than two calls because the two answers must
 * come from the same event: a reader that took the boundary from the newest
 * round and the carried set from an older one would offer a role as satisfied
 * against a boundary that postdates it.
 */
export interface AuditRound {
  since: string | null;
  carried: ReadonlySet<number>;
}

/** The ordinals the audit roles occupy, mirroring `auditBrief.ts`. */
const ORDINAL_BY_ROLE: Record<string, number> = { PRIMARY: 5, ADVERSARIAL: 6, JUDGE: 7 };

export async function auditRoundFor(orchestrationId: string): Promise<AuditRound> {
  const rows = await getDb().all<{ created_at: string; payload: string }>(
    `SELECT created_at, payload FROM project_events
      WHERE event_type IN (${ROUND_EVENTS.map(() => '?').join(', ')})
      ORDER BY created_at DESC, rowid DESC
      LIMIT 50`,
    [...ROUND_EVENTS],
  );
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    if (payload['orchestrationId'] !== orchestrationId) continue;
    /*
     * An integrity reopen carries the boundary in its payload, and that is
     * preferred over the row's own `created_at`. The two are milliseconds apart
     * and the difference is not cosmetic: the reservation that decides a round
     * exists is written first and the event a moment later, so taking the row's
     * clock would give the boundary a second value the reopen record disagrees
     * with. One instant, stored once and referenced.
     */
    const declared = payload['roundStartedAt'];
    const since = typeof declared === 'string' && declared !== '' ? declared : row.created_at;

    const carriedRoles = Array.isArray(payload['rolesCarried']) ? payload['rolesCarried'] : [];
    const carried = new Set<number>();
    for (const entry of carriedRoles) {
      const role = (entry as { role?: unknown } | null)?.role;
      const ordinal = typeof role === 'string' ? ORDINAL_BY_ROLE[role] : undefined;
      if (ordinal !== undefined) carried.add(ordinal);
    }
    return { since, carried };
  }
  return { since: null, carried: new Set<number>() };
}

export async function auditRoundStartedAt(orchestrationId: string): Promise<string | null> {
  return (await auditRoundFor(orchestrationId)).since;
}

/**
 * Does this pass belong to the round that began at `since`?
 *
 * `carried` is the set of audit ordinals an integrity reopen decided may be
 * kept: a role whose session authored nothing and which depends on no role
 * being rerun does not have to be argued again. Carrying one forward is not
 * copying it — nothing about the pass changes, and the reader simply stops
 * treating the boundary as disqualifying for that ordinal. Absent by default,
 * so the handoff behaves exactly as it did.
 */
export function passInRound(
  pass: ResearchPass,
  since: string | null,
  carried?: ReadonlySet<number>,
): boolean {
  if (!since) return true;
  if (carried && pass.passKey === 'AUDIT' && carried.has(pass.ordinal)) return true;
  // Only the audit is re-run. The plan, the fragments, the verification and the
  // synthesis are the packet's evidence and they did not move layers, so
  // filtering them out here would make a re-audited packet look like one that
  // had never done any research.
  if (pass.passKey !== 'AUDIT') return true;
  return (pass.completedAt ?? pass.startedAt) > since;
}

/**
 * This packet's passes, with the previous audit rounds' left out.
 *
 * Every current-round decision reads this rather than `listPasses`, because a
 * decision made against a superseded round is a decision about a verdict that
 * no longer stands. The rows are untouched — this is a filter on the way out,
 * not a write.
 */
export async function passesInCurrentRound(orchestrationId: string): Promise<ResearchPass[]> {
  const [passes, round] = await Promise.all([
    listPasses(orchestrationId),
    auditRoundFor(orchestrationId),
  ]);
  if (!round.since) return passes;
  return passes.filter((pass) => passInRound(pass, round.since, round.carried));
}
