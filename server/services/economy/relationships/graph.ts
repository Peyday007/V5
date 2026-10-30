/**
 * Typed relationships between industry nodes and activities.
 *
 * The graph is the industry kernel's: a NODE endpoint must be an
 * `industry_nodes` row in the same project, so this is an extension of that
 * map and not a second one. ACTIVITY endpoints are free references (an
 * opportunity or a possibility) because an activity is not a place in the
 * tree.
 */
import { getNode } from '../../../repos/industry.ts';
import { edgesAround, recordEconomicEdge } from '../../../repos/economy.ts';
import type { EconomicEdge, EconomicRelation, EndpointKind, EvidenceStatus, OperatorKind } from '../../../domain/economy.ts';

export interface RelationshipInput {
  projectId: string;
  fromKind: EndpointKind; fromRef: string;
  toKind: EndpointKind; toRef: string;
  relation: EconomicRelation;
  status: EvidenceStatus;
  sourceClaimId?: string | null;
  basis?: string | null;
  operatorKind: OperatorKind;
}

async function endpointProblem(projectId: string, kind: EndpointKind, ref: string): Promise<string | null> {
  if (!ref.trim()) return 'An endpoint must name something.';
  if (kind !== 'NODE') return null;
  const node = await getNode(ref);
  // The same answer for absent and for another project's node.
  return node && node.projectId === projectId ? null : `No industry node ${ref} in this project.`;
}

/** Records one relationship. Refuses a self-edge, an endpoint that is not in this project's map, and a status its evidence does not support. */
export async function recordRelationship(input: RelationshipInput): Promise<{ edge: EconomicEdge; created: boolean }> {
  if (input.fromKind === input.toKind && input.fromRef === input.toRef) throw new Error('Something cannot have a relationship with itself.');
  const from = await endpointProblem(input.projectId, input.fromKind, input.fromRef);
  if (from) throw new Error(from);
  const to = await endpointProblem(input.projectId, input.toKind, input.toRef);
  if (to) throw new Error(to);
  return recordEconomicEdge(input);
}

export interface Neighbour {
  edge: EconomicEdge;
  /** The relation read from the asked-about end: BUYS_FROM stored one way is a supplier the other way. */
  direction: 'OUT' | 'IN';
  otherRef: string;
  otherKind: EndpointKind;
}

export async function relationshipsOf(projectId: string, ref: string): Promise<Neighbour[]> {
  return (await edgesAround(projectId, ref)).map((edge) => (edge.fromRef === ref
    ? { edge, direction: 'OUT' as const, otherRef: edge.toRef, otherKind: edge.toKind }
    : { edge, direction: 'IN' as const, otherRef: edge.fromRef, otherKind: edge.fromKind }));
}

/**
 * What stands behind this reference, following REQUIRES and the things that
 * supply or enable what it requires. Bounded in depth, and each reference is
 * visited once, so a cycle cannot loop and a wide graph cannot run away.
 */
export async function whatItDependsOn(projectId: string, ref: string, maxDepth = 3): Promise<{ ref: string; depth: number; via: EconomicRelation; status: EvidenceStatus }[]> {
  const seen = new Set<string>([ref]);
  const out: { ref: string; depth: number; via: EconomicRelation; status: EvidenceStatus }[] = [];
  let frontier = [ref];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const n of await relationshipsOf(projectId, current)) {
        const needs = (n.direction === 'OUT' && n.edge.relation === 'REQUIRES')
          || (n.direction === 'IN' && (n.edge.relation === 'SUPPLIES' || n.edge.relation === 'ENABLES'));
        if (!needs || seen.has(n.otherRef)) continue;
        seen.add(n.otherRef);
        out.push({ ref: n.otherRef, depth, via: n.edge.relation, status: n.edge.status });
        next.push(n.otherRef);
      }
    }
    frontier = next;
  }
  return out;
}
