/**
 * An industry node as the economy sees it: where it sits, how it relates to
 * others, and what its activity variables would feed the goal model.
 *
 * A reader over the industry map and the relationship graph; it adds no node
 * and no edge of its own.
 */
import { getNode } from '../../repos/industry.ts';
import { currentVariables } from '../../repos/economy.ts';
import type { IndustryNode } from '../../domain/types.ts';
import type { ActivityVariable, OperatorKind } from '../../domain/economy.ts';
import { relationshipsOf, type Neighbour } from '../economy/relationships/graph.ts';
import { modelInputsFrom, type ActivityModelInputs } from '../economy/relationships/variables.ts';

export interface IndustryEconomics {
  node: IndustryNode;
  relationships: Neighbour[];
  variables: ActivityVariable[];
  /** Goal-model inputs for each kind of operator, with provenance. */
  inputs: Record<OperatorKind, ActivityModelInputs>;
}

/** Null for an unknown node and for another project's, which are the same answer. */
export async function industryEconomics(projectId: string, nodeId: string): Promise<IndustryEconomics | null> {
  const node = await getNode(nodeId);
  if (!node || node.projectId !== projectId) return null;
  const [relationships, variables] = await Promise.all([relationshipsOf(projectId, nodeId), currentVariables(projectId, nodeId)]);
  return {
    node, relationships, variables,
    inputs: {
      ESTABLISHED_OPERATOR: modelInputsFrom(variables, 'ESTABLISHED_OPERATOR'),
      REPRODUCIBLE_BY_NEW_OPERATOR: modelInputsFrom(variables, 'REPRODUCIBLE_BY_NEW_OPERATOR'),
    },
  };
}
