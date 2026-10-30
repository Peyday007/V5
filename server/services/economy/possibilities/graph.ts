/** Reach, research order and chains of opportunity, all derived from the edges. */
import { getDb } from '../../../db/database.ts';
import type { PossibilityRelation } from '../../../domain/economy.ts';

interface Edge { from: string; to: string; relation: PossibilityRelation }

/** Relations along which one possibility leads on to another. */
const FORWARD: ReadonlySet<PossibilityRelation> = new Set(['ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES']);
const TOUCHING: ReadonlySet<PossibilityRelation> = new Set([...FORWARD, 'COMPLEMENTS']);

/** The owner's own edges only; an edge to another person's row never appears. */
export async function ownerEdges(projectId: string, ownerUserId: string): Promise<Edge[]> {
  const rows = await getDb().all<{ from_id: string; to_id: string; relation: PossibilityRelation }>(
    `SELECT e.from_id, e.to_id, e.relation FROM possibility_edges e
       JOIN possibilities a ON a.id = e.from_id AND a.owner_user_id = ?
       JOIN possibilities b ON b.id = e.to_id AND b.owner_user_id = ?
      WHERE e.project_id = ? ORDER BY e.created_at, e.id`,
    [ownerUserId, ownerUserId, projectId]);
  return rows.map((r) => ({ from: r.from_id, to: r.to_id, relation: r.relation }));
}

/** How many other possibilities this one leads to or sits beside. */
export function reachOf(id: string, edges: Edge[]): number {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of edges) {
      if (!TOUCHING.has(e.relation)) continue;
      const next = e.from === cur ? e.to : e.relation === 'COMPLEMENTS' && e.to === cur ? e.from : null;
      if (next && next !== id && !seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen.size;
}

/**
 * What to research next. A zero-reach candidate is not offered while any
 * stronger unexplored candidate remains; `researched` is the caller's record of
 * what already had its research.
 */
export function researchOrder(
  candidateIds: string[], edges: Edge[], researched: ReadonlySet<string>,
): { next: string[]; deferredZeroReach: string[] } {
  const scored = candidateIds.map((id) => ({ id, reach: reachOf(id, edges) }));
  const stronger = scored.filter((c) => c.reach > 0 && !researched.has(c.id))
    .sort((a, b) => b.reach - a.reach || a.id.localeCompare(b.id));
  const zero = scored.filter((c) => c.reach === 0)
    .sort((a, b) => Number(researched.has(a.id)) - Number(researched.has(b.id)) || a.id.localeCompare(b.id));
  if (stronger.length > 0) return { next: stronger.map((c) => c.id), deferredZeroReach: zero.map((c) => c.id) };
  return { next: zero.map((c) => c.id), deferredZeroReach: [] };
}

/** Chains such as cash op → recurring service → larger venture, root first. */
export function chains(edges: Edge[]): string[][] {
  const fwd = edges.filter((e) => FORWARD.has(e.relation));
  const hasIncoming = new Set(fwd.map((e) => e.to));
  const out: string[][] = [];
  const walk = (path: string[]): void => {
    const nexts = fwd.filter((e) => e.from === path[path.length - 1]).map((e) => e.to)
      .filter((n) => !path.includes(n));
    if (nexts.length === 0) { if (path.length > 1) out.push(path); return; }
    for (const n of [...new Set(nexts)].sort()) walk([...path, n]);
  };
  for (const root of [...new Set(fwd.map((e) => e.from))].filter((r) => !hasIncoming.has(r)).sort()) walk([root]);
  return out;
}
