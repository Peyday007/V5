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
export async function auditRoundStartedAt(orchestrationId: string): Promise<string | null> {
  const rows = await getDb().all<{ created_at: string; payload: string }>(
    `SELECT created_at, payload FROM project_events
      WHERE event_type = 'DOCUMENT_HANDED_OFF'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 50`,
  );
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    if (payload['orchestrationId'] === orchestrationId) return row.created_at;
  }
  return null;
}

/** Does this pass belong to the round that began at `since`? */
export function passInRound(pass: ResearchPass, since: string | null): boolean {
  if (!since) return true;
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
  const [passes, since] = await Promise.all([
    listPasses(orchestrationId),
    auditRoundStartedAt(orchestrationId),
  ]);
  if (!since) return passes;
  return passes.filter((pass) => passInRound(pass, since));
}
