/**
 * A person naming a channel, or a product, or retiring one.
 *
 * ---------------------------------------------------------------------------
 * `SEED` is the one origin Brain may not write
 * ---------------------------------------------------------------------------
 *
 * A machine that could seed its own channels would be deciding where commerce
 * happens — §22's rule that a worker cannot create its own work, at the table
 * that decides where everything else looks. So this is the whole of how TikTok
 * gets into a Brain that holds no list of platforms: somebody says so, at
 * ADMIN, on a surface behind `requirePerson`.
 *
 * ---------------------------------------------------------------------------
 * Seeding spends nothing and starts nothing
 * ---------------------------------------------------------------------------
 *
 * It creates a row. The allocator decides when the channel is asked about, the
 * discovery grant decides whether that may run, the approval envelope decides
 * whether the plan may start, and the evidence gate decides what may be
 * claimed. A seed on a project with no sprint sits there until somebody starts
 * one.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import {
  createChannel,
  createProposition,
  getChannel,
  getProposition,
  retireChannel,
  retireProposition,
} from '../../repos/commerce.ts';
import type { CommerceChannel, CommerceProposition } from '../../domain/types.ts';

const SEEDED = 'COMMERCE_SEEDED';
const RETIRED = 'COMMERCE_RETIRED';

export async function seedChannel(input: {
  projectId: string;
  name: string;
  description?: string | null;
  actorRef: string;
  reason?: string | null;
}): Promise<{ channel: CommerceChannel; created: boolean }> {
  const result = await createChannel({
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    origin: 'SEED',
  });
  if (result.created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: SEEDED,
      actorRef: input.actorRef,
      summary: `${result.channel.name} was named as a channel to look at.`,
      detail: {
        channelId: result.channel.id,
        name: result.channel.name,
        reason: input.reason ?? null,
        /*
         * Said on the event rather than only in a reply, because the reply is
         * read once and the history is read afterwards by somebody asking why
         * money was spent.
         */
        spends: 'nothing — this creates a row and starts no research',
      },
    });
  }
  return result;
}

/**
 * A person naming something they already believe is worth selling.
 *
 * It requires a channel, for `validateCommerce`'s reason: the same product on
 * two channels has two fee structures, two audiences and two sets of
 * eligibility rules, and a proposition with no channel has nothing to work out
 * about it.
 *
 * It establishes **no demand**. A seeded proposition starts at
 * `DEMAND_SIGNAL` with no purchase reading behind it, exactly like a
 * discovered one, and the kernel's own question is what establishes whether
 * anybody buys it. A person's belief is an assumption, and this kernel's whole
 * purpose is to find out whether an assumption survives evidence.
 */
export async function seedProposition(input: {
  projectId: string;
  channelId: string;
  product: string;
  audience?: string | null;
  supplier?: string | null;
  actorRef: string;
  reason?: string | null;
}): Promise<{ proposition: CommerceProposition; created: boolean } | null> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return null;
  const channel = await getChannel(input.channelId);
  if (!channel || channel.projectId !== input.projectId) return null;

  const result = await createProposition({
    projectId: input.projectId,
    cashModeId: mode.id,
    channelId: channel.id,
    product: input.product,
    audience: input.audience ?? null,
    supplier: input.supplier ?? null,
    origin: 'SEED',
  });
  if (result.created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: SEEDED,
      actorRef: input.actorRef,
      summary: `${result.proposition.product} on ${channel.name} was named as worth looking at.`,
      detail: {
        propositionId: result.proposition.id,
        channelId: channel.id,
        reason: input.reason ?? null,
        establishes:
          'nothing about demand — it starts with no purchase evidence, exactly like one Brain ' +
          'found, and the kernel asks whether anybody actually buys it',
      },
    });
  }
  return result;
}

export async function retireChannelSubject(input: {
  projectId: string;
  channelId: string;
  reason: string;
  actorRef: string;
}): Promise<CommerceChannel | null> {
  const channel = await getChannel(input.channelId);
  if (!channel || channel.projectId !== input.projectId) return null;
  if (await retireChannel(channel.id, input.reason)) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: RETIRED,
      actorRef: input.actorRef,
      summary: `${channel.name} was retired as a channel.`,
      detail: { channelId: channel.id, reason: input.reason },
    });
  }
  return (await getChannel(channel.id)) ?? channel;
}

export async function retirePropositionSubject(input: {
  projectId: string;
  propositionId: string;
  reason: string;
  actorRef: string;
}): Promise<CommerceProposition | null> {
  const proposition = await getProposition(input.propositionId);
  if (!proposition || proposition.projectId !== input.projectId) return null;
  if (await retireProposition(proposition.id, input.reason)) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: RETIRED,
      actorRef: input.actorRef,
      summary: `${proposition.product} was retired.`,
      detail: { propositionId: proposition.id, reason: input.reason },
    });
  }
  return (await getProposition(proposition.id)) ?? proposition;
}
