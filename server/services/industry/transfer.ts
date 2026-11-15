/**
 * The §82 transfer in the standing world-expansion pass (W-8).
 *
 * A design a held opening shows working — its payer and its way of being paid
 * established by gated claims — is a precedent. Goal construction carried it to
 * other buyers only while a live goal was being planned, so a mechanism proven
 * in one industry was never offered to the rest of the map. Here the kernel
 * carries each held precedent's design to the buyer populations on the map
 * that are not its own, as a research ASK: an ordinary SCAN round whose bucket
 * names the design and the precedent, opened through `openAsks` like a role
 * question — no second pipeline, no new purpose, no migration.
 *
 * Never a fact. Nothing here writes a node, a fact or an opening: the question
 * says the transfer is a hypothesis, names each material difference the
 * precedent leaves unbridged (`TRANSFER_MATERIAL`), and what research finds is
 * absorbed through the gate like every other answer.
 *
 * One ask per (population, design, precedent), ever: the round key is the
 * subject and the bucket.
 */
import { heldPrecedents, shownWorkingIn, TRANSFER_MATERIAL } from '../cash/construct.ts';
import { defaultDesign, describeDesign, designKey, FUNDING, AGGREGATION, REPEAT, STRUCTURE_KEYS, type Design } from '../cash/properties.ts';
import { designToPosition } from './construction/designs.ts';
import { positionKey } from './construction/businesses.ts';
import { pathOf } from '../../domain/industry.ts';
import { EQUIPMENT_WORDS } from '../../domain/construction.ts';
import type { Ask } from './allocate.ts';
import type { GraphSnapshot } from './graph.ts';
import type { CashOpportunity } from '../../domain/types.ts';

const TRANSFER_BUCKET = 'transfer:';

/** `transfer:<BASE>/<FUNDING>/<AGGREGATION>/<REPEAT>:<precedent opportunity id>`. */
export function transferBucketId(design: Design, precedentId: string): string {
  return `${TRANSFER_BUCKET}${designKey(design)}:${precedentId}`;
}

/** The design and precedent a transfer bucket names, or null for any other bucket. */
export function transferOfBucket(bucketId: string | null): { design: Design; precedentId: string } | null {
  if (!bucketId || !bucketId.startsWith(TRANSFER_BUCKET)) return null;
  const rest = bucketId.slice(TRANSFER_BUCKET.length);
  const at = rest.indexOf(':');
  if (at < 0) return null;
  const [base, funding, aggregation, repeat] = rest.slice(0, at).split('/');
  const precedentId = rest.slice(at + 1);
  if (!precedentId) return null;
  const known = <T extends string>(set: readonly T[], value: string | undefined): value is T => value !== undefined && (set as readonly string[]).includes(value);
  if (!known(STRUCTURE_KEYS, base) || !known(FUNDING, funding) || !known(AGGREGATION, aggregation) || !known(REPEAT, repeat)) return null;
  return { design: { base, funding, aggregation, repeat }, precedentId };
}

/** One held precedent: the opening and the design it shows working. */
export interface HeldPrecedent {
  opportunity: CashOpportunity;
  design: Design;
}

function norm(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Held precedents in a snapshot's openings, read through the one definition goal construction uses. */
export async function precedentsIn(snapshot: GraphSnapshot): Promise<HeldPrecedent[]> {
  const held = snapshot.opportunities.filter((one) => !one.duplicateOfId && one.state !== 'DECLINED' && one.state !== 'ARCHIVED');
  if (held.length === 0) return [];
  const byBase = heldPrecedents(held, await shownWorkingIn(snapshot.projectId));
  return [...byBase.entries()].map(([base, opportunity]) => ({ opportunity, design: defaultDesign(base) }));
}

/**
 * The transfer asks a snapshot supports, at most `limit`. Pure.
 *
 * A target is a live BUYER_TYPE subject that is not the precedent's own
 * population: not its payer by name, and not under the map root the precedent
 * was filed in. Already-asked (subject, bucket) pairs are skipped. Ordered by
 * when Brain came to know the population, then by precedent, so each pass
 * reaches a new population before it repeats one with another design.
 */
export function transferAsks(input: { snapshot: GraphSnapshot; precedents: readonly HeldPrecedent[]; limit: number }): Ask[] {
  const room = Math.max(0, Math.trunc(input.limit));
  if (room === 0 || input.precedents.length === 0) return [];
  const { snapshot } = input;
  const byId = new Map(snapshot.nodes.map((one) => [one.id, one]));
  const rootOf = (nodeId: string | null): string | null => {
    let current = nodeId ? byId.get(nodeId) : undefined;
    const seen = new Set<string>();
    while (current && current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return current?.id ?? null;
  };
  const asked = new Set(snapshot.rounds.filter((one) => one.nodeId && one.bucketId).map((one) => `${one.nodeId}|${one.bucketId}`));
  const populations = snapshot.nodes
    .filter((one) => one.kind === 'BUYER_TYPE' && one.retiredAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const out: Ask[] = [];
  for (const node of populations) {
    const root = rootOf(node.id);
    const rootName = root ? norm(byId.get(root)?.name) : '';
    for (const one of input.precedents) {
      const precedent = one.opportunity;
      if (norm(precedent.payer) === norm(node.name)) continue;
      if (precedent.industryNodeId && rootOf(precedent.industryNodeId) === root) continue;
      if (precedent.industry && norm(precedent.industry) === rootName) continue;
      const bucketId = transferBucketId(one.design, precedent.id);
      if (asked.has(`${node.id}|${bucketId}`)) continue;
      const path = pathOf(node.id, byId);
      const position = designToPosition(one.design, EQUIPMENT_WORDS.test(`${precedent.title} ${node.name}`));
      out.push({
        purpose: 'SCAN',
        nodeId: node.id,
        bucketId,
        opportunityId: null,
        round: 1,
        rank: 500,
        subject: path.join(' → '),
        since: node.createdAt,
        why:
          `A held opening ("${precedent.title.slice(0, 120)}") shows the design ${designKey(one.design)} ` +
          `(position ${positionKey(position)}) working for ${precedent.payer ?? 'its buyers'}; it has never been asked of ` +
          `${node.name}. A transfer is a hypothesis: it must bridge ${TRANSFER_MATERIAL.join(', ')}.`,
      });
      if (out.length >= room) return out;
    }
  }
  return out;
}

/** The words a transfer round is composed from, for `openAsks`. */
export function transferWords(design: Design, precedent: CashOpportunity, path: readonly string[]): {
  design: string;
  position: string;
  differences: readonly string[];
} {
  const position = designToPosition(design, EQUIPMENT_WORDS.test(`${precedent.title} ${path.join(' ')}`));
  return {
    design: describeDesign(design),
    position: positionKey(position),
    differences: TRANSFER_MATERIAL,
  };
}
