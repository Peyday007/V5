import type { EconomicRelationship, RelationshipKind } from './types.ts';
import { RELATIONSHIP_KINDS } from './types.ts';

export function relationshipProblem(r: EconomicRelationship): string | null {
  if (!RELATIONSHIP_KINDS.includes(r.kind)) return `unknown kind ${r.kind}`;
  if (r.from.id === r.to.id && r.from.kind === r.to.kind) return 'a subject cannot relate to itself';
  if (r.state === 'VERIFIED' && !r.source) return 'VERIFIED needs a source';
  if (r.state === 'ESTIMATE' && !(r.basis && r.basis.trim())) return 'ESTIMATE needs its basis stated';
  return null;
}

/** Edges that pass validation; the rest are returned with the reason, never silently dropped. */
export function partitionRelationships(rs: EconomicRelationship[]): { valid: EconomicRelationship[]; refused: { id: string; reason: string }[] } {
  const valid: EconomicRelationship[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const r of rs) {
    const reason = relationshipProblem(r);
    if (reason) refused.push({ id: r.id, reason });
    else valid.push(r);
  }
  return { valid, refused };
}

/** Subjects reachable from a subject along one kind, in either direction for symmetric kinds. */
export function related(rs: EconomicRelationship[], subjectId: string, kind: RelationshipKind): string[] {
  const symmetric = kind === 'COMPLEMENTS' || kind === 'COMPETES_WITH';
  const out = new Set<string>();
  for (const r of rs) {
    if (r.kind !== kind) continue;
    if (r.from.id === subjectId) out.add(r.to.id);
    else if (symmetric && r.to.id === subjectId) out.add(r.from.id);
  }
  return [...out].sort();
}

/** Everything a subject REQUIRES, transitively, with cycles tolerated (each subject once). */
export function requiredClosure(rs: EconomicRelationship[], subjectId: string): string[] {
  const seen = new Set<string>();
  const stack = [subjectId];
  while (stack.length) {
    const next = stack.pop() as string;
    for (const id of related(rs, next, 'REQUIRES')) {
      if (id !== subjectId && !seen.has(id)) { seen.add(id); stack.push(id); }
    }
  }
  return [...seen].sort();
}
