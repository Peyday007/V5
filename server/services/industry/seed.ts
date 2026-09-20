/**
 * A person naming a subject to start the map from.
 *
 * ---------------------------------------------------------------------------
 * Why Brain may not do this
 * ---------------------------------------------------------------------------
 *
 * `SEED` is the one node origin Brain cannot write, and the schema enforces it
 * rather than this comment: every other origin requires a `source_claim_id`,
 * and Brain has no way to produce a claim that has not been through the
 * evidence gate. A machine that could seed its own subjects would be deciding
 * what the economy is — §22's rule that a worker cannot create its own work,
 * arriving at the table that decides where everything else looks.
 *
 * What a seed *is* is an instruction: somebody has a reason to believe this
 * subject is worth Brain's attention, and that reason is theirs. The kernel
 * then treats the seeded node exactly like a discovered one — it is scanned,
 * decomposed, and retired if it turns out to be barren, with no special case
 * anywhere. A seed decides where to start looking and nothing else.
 *
 * ---------------------------------------------------------------------------
 * It is not a way round the authorization
 * ---------------------------------------------------------------------------
 *
 * Seeding creates a row. It spends nothing, contacts nobody, and starts no
 * research: the kernel's allocator decides when the subject is asked about,
 * the discovery grant decides whether that may run, and the evidence gate
 * decides what may be claimed. A seed on a project with no sprint sits there
 * until somebody starts one.
 */
import { createNode, getNode, retireNode } from '../../repos/industry.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import type { IndustryNode, IndustryNodeKind } from '../../domain/types.ts';

const SEEDED = 'INDUSTRY_SUBJECT_SEEDED';
const RETIRED = 'INDUSTRY_SUBJECT_RETIRED';

export interface SeedResult {
  node: IndustryNode;
  /** False when the subject was already on the map, which is not an error. */
  created: boolean;
}

/**
 * Put a subject on the map because somebody said so.
 *
 * Idempotent by the unique index on `(project, parent, name)`, so pressing it
 * twice produces one subject and reports the one that is there. A subject that
 * already exists as a *discovered* node is returned unchanged rather than
 * re-origined: how Brain came to know about something is history, and history
 * does not stop having happened because somebody later named it too.
 */
export async function seedSubject(input: {
  projectId: string;
  name: string;
  kind?: IndustryNodeKind;
  description?: string | null;
  parentId?: string | null;
  actorRef: string;
  reason?: string | null;
}): Promise<SeedResult> {
  if (input.parentId) {
    const parent = await getNode(input.parentId);
    if (!parent || parent.projectId !== input.projectId) {
      throw new Error('That parent subject is not on this project’s map.');
    }
  }

  const result = await createNode({
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    // A seeded root is a sector unless somebody says otherwise: it is a place
    // in the economy rather than a fact about one, and every narrower kind is
    // something research establishes rather than something a person declares.
    kind: input.kind ?? (input.parentId ? 'SUB_INDUSTRY' : 'SECTOR'),
    name: input.name,
    description: input.description ?? null,
    origin: 'SEED',
  });

  if (result.created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: SEEDED,
      actorRef: input.actorRef,
      summary: `${result.node.name} was seeded onto the industry map.`,
      detail: {
        nodeId: result.node.id,
        kind: result.node.kind,
        parentId: result.node.parentId,
        reason: input.reason ?? null,
      },
    });
  }
  return { node: result.node, created: result.created };
}

/**
 * A person deciding a path is not worth following.
 *
 * Destroys nothing: the node keeps its id, its evidence, its children and
 * every round ever run against it, and `listNodes` still returns it. What
 * changes is that the allocator stops offering it and `standingOf` reads
 * `DEAD_END` with the person's own reason — which is the one verdict no
 * derivation could ever reach.
 *
 * Deleting instead would be worse than useless: the same subject would arrive
 * again on the next expansion as a fresh discovery, and the allowance would be
 * spent learning something somebody had already decided.
 */
export async function retireSubject(input: {
  projectId: string;
  nodeId: string;
  reason: string;
  actorRef: string;
}): Promise<IndustryNode | null> {
  const node = await getNode(input.nodeId);
  if (!node || node.projectId !== input.projectId) return null;
  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('Retiring a subject records why, so that it stays answerable.');

  if (await retireNode(input.nodeId, reason)) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: RETIRED,
      actorRef: input.actorRef,
      summary: `${node.name} was retired from the industry map.`,
      detail: { nodeId: node.id, reason },
    });
  }
  return getNode(input.nodeId);
}
