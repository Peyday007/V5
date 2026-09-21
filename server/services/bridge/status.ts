/**
 * The return path: what happened to what somebody said.
 *
 * A bridge that only carried text one way would be a filing cabinet. The
 * question a person actually has, in the client they are already in, is *what
 * did Brain do with that* — and every part of the answer is already a row:
 *
 *   * the turn Russell opened, and whether a worker has answered it yet;
 *   * the software change requests that came out of the thread, with the
 *     campaign each one became;
 *   * the ideas captured from it;
 *   * the workstreams the register says this conversation feeds;
 *   * and what is waiting on a person.
 *
 * Nothing here is composed prose about progress. Every line resolves to a row
 * and says which, so a person reading it in a chat window can check it — which
 * is the same standard §33 holds a Cash card to, at a different surface.
 *
 * It is a **projection**: it writes nothing, queues nothing, fires nothing, and
 * a test asserts that.
 */
import type { BridgeConversation } from '../../domain/register.ts';
import { getBridgeConversation } from '../../repos/bridge.ts';
import { getConversation, listTurns } from '../../repos/russellConversations.ts';
import { listSoftwareRequestsForConversation } from '../../repos/russellSoftware.ts';
import { getCampaign, getChangeRequest } from '../../repos/factory.ts';
import { listAllLiveLinks, workstreamsForRef, getWorkstream } from '../../repos/register.ts';
import { viewOf } from '../register/view.ts';
import type { WorkstreamView } from '../register/view.ts';

export interface BridgeStatus {
  conversation: {
    id: string;
    russellConversationId: string;
    title: string;
    source: string;
    messageCount: number;
    lastSyncAt: string | null;
    /** The project Brain resolved this thread to, or null if it has not. */
    projectId: string | null;
  };

  /** Turns Russell has taken, newest last, with what each is waiting for. */
  turns: {
    id: string;
    role: string;
    status: string;
    /** Present on a PENDING turn: what it is waiting for, right now. */
    pendingReason: string | null;
    createdAt: string;
  }[];

  /** Software the conversation asked for, and where each one got to. */
  softwareRequests: {
    id: string;
    title: string;
    state: string;
    changeRequestId: string | null;
    changeRequestState: string | null;
    campaignId: string | null;
    campaignState: string | null;
    /** A blocker in the campaign's own words, when it has one. */
    blocker: string | null;
    declineReason: string | null;
  }[];

  /** Workstreams the register says this conversation feeds. */
  workstreams: WorkstreamView[];

  /**
   * What a person has to do. Empty is the ordinary and good answer.
   *
   * Composed from the same derivations the register uses, rather than from a
   * second opinion about the same rows — §29's one-projection rule, which this
   * codebase has had to restate every time two readers counted one fact.
   */
  needsYou: string[];
}

export async function bridgeStatus(conversationId: string): Promise<BridgeStatus | null> {
  const bridge = await getBridgeConversation(conversationId);
  if (!bridge) return null;
  return await statusFor(bridge);
}

export async function statusFor(bridge: BridgeConversation): Promise<BridgeStatus> {
  const thread = await getConversation(bridge.russellConversationId);
  const turns = await listTurns(bridge.russellConversationId, 20);
  const requests = await listSoftwareRequestsForConversation(bridge.russellConversationId);

  const needsYou: string[] = [];

  const softwareRequests: BridgeStatus['softwareRequests'] = [];
  for (const request of requests) {
    const changeRequest = request.changeRequestId
      ? await getChangeRequest(request.changeRequestId)
      : null;
    const campaign = request.campaignId ? await getCampaign(request.campaignId) : null;

    if (request.state === 'PROPOSED') {
      needsYou.push(`Authorize the software change "${request.title}" (${request.id}), or decline it.`);
    }
    if (campaign?.state === 'AWAITING_RELEASE') {
      needsYou.push(`Release campaign ${campaign.id}, or say why not.`);
    }

    softwareRequests.push({
      id: request.id,
      title: request.title,
      state: request.state,
      changeRequestId: request.changeRequestId,
      changeRequestState: changeRequest?.state ?? null,
      campaignId: request.campaignId,
      campaignState: campaign?.state ?? null,
      blocker: campaign?.blockerKind
        ? `${campaign.blockerKind}: ${campaign.blockerDetail ?? 'no detail recorded'}`
        : null,
      declineReason: request.declineReason,
    });
  }

  /*
   * Both ways a conversation can reach the register: by its bridge row, which
   * is what a bridge client knows, and by the Russell thread, which is what
   * anything inside Brain links. Reading only one of them would make a
   * workstream invisible from exactly one side, which is the kind of asymmetry
   * §36 records as two people seeing two products.
   */
  const streamIds = new Set([
    ...(await workstreamsForRef('BRIDGE_CONVERSATION', bridge.id)),
    ...(await workstreamsForRef('CONVERSATION', bridge.russellConversationId)),
  ]);
  const links = await listAllLiveLinks([...streamIds]);
  const workstreams: WorkstreamView[] = [];
  for (const id of streamIds) {
    const workstream = await getWorkstream(id);
    if (!workstream) continue;
    const view = await viewOf(
      workstream,
      links.filter((one) => one.workstreamId === id),
    );
    workstreams.push(view);
    if (view.ownerAction) needsYou.push(view.ownerAction);
  }

  return {
    conversation: {
      id: bridge.id,
      russellConversationId: bridge.russellConversationId,
      title: bridge.title,
      source: bridge.source,
      messageCount: bridge.messageCount,
      lastSyncAt: bridge.lastSyncAt,
      projectId: thread?.projectId ?? null,
    },
    turns: turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      status: turn.status,
      pendingReason: turn.pendingReason,
      createdAt: turn.createdAt,
    })),
    softwareRequests,
    workstreams,
    // Deduplicated, because one campaign can be reached through both a software
    // request and a workstream and asking somebody twice reads as two jobs.
    needsYou: [...new Set(needsYou)],
  };
}
