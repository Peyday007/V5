/**
 * Every Freelancer action Brain takes, through Step 6's effects engine.
 *
 * One operation per logical action, keyed by the job and the action, so a
 * retry after a timeout is the same operation rather than a second bid or a
 * second message (invariant 26). A bid is EXTERNAL_RECONCILABLE: after an
 * ambiguous send Brain asks Freelancer whether this account already bid on
 * the project and attaches the answer instead of bidding again. A message, an
 * acceptance or a milestone request cannot be looked up by Brain's identity, so
 * those are EXTERNAL_OPAQUE: one attempt, and an unknown outcome stops at
 * UNCERTAIN and is never resent automatically.
 */
import type { EffectAdapter, SendOutcome } from '../../effects/adapter.ts';
import { runExternalEffect, type ExternalOutcome } from '../../effects/external.ts';
import type { OperationNamespace } from '../../effects/engine.ts';
import { receiptOf } from '../effects.ts';
import {
  FreelancerRefused,
  FreelancerUnknown,
  acceptAward,
  myBids,
  placeBid,
  postAttachment,
  postMessage,
  requestMilestone,
  requestRelease,
  startThread,
} from './client.ts';

function namespace(name: string): OperationNamespace {
  return { name: `freelancer.${name}`, version: 1, principalScope: 'PROJECT', retention: 'PERMANENT' };
}

export const BID = namespace('bid');
export const MESSAGE = namespace('message');
export const ACCEPT = namespace('accept_award');
export const MILESTONE = namespace('milestone');

function classify(error: unknown): SendOutcome {
  if (error instanceof FreelancerRefused) {
    return {
      kind: 'REJECTED',
      category: error.status === 401 || error.status === 403 ? 'NOT_AUTHORIZED' : 'PROVIDER_REJECTED',
      retryable: error.status === 429,
      detail: `${error.code}: ${error.message}`,
    };
  }
  if (error instanceof FreelancerUnknown) return { kind: 'UNCERTAIN', reason: error.message };
  return { kind: 'UNCERTAIN', reason: (error as Error)?.message ?? 'unknown failure' };
}

function adapter(
  name: string,
  ns: OperationNamespace,
  perform: (payload: Record<string, unknown>) => Promise<string>,
  reconcile?: EffectAdapter['reconcile'],
): EffectAdapter {
  return {
    name,
    effectClass: reconcile ? 'EXTERNAL_RECONCILABLE' : 'EXTERNAL_OPAQUE',
    namespace: ns.name,
    validate(payload) {
      if (!payload || typeof payload !== 'object') throw new Error(`${name} needs a payload object.`);
      return payload as Record<string, unknown>;
    },
    fingerprintInputs(payload) {
      return payload;
    },
    async send(request) {
      try {
        return { kind: 'CONFIRMED', receiptRef: await perform(request.payload) };
      } catch (error) {
        return classify(error);
      }
    },
    ...(reconcile ? { reconcile } : {}),
  };
}

const num = (value: unknown): number => Number(value);

const bidAdapter = adapter(
  'freelancer-bid',
  BID,
  async (p) =>
    String(
      (
        await placeBid({
          projectId: num(p.projectId),
          bidderId: num(p.bidderId),
          amount: num(p.amount),
          period: num(p.period),
          description: String(p.description),
        })
      ).id,
    ),
  async (businessId) => {
    // businessId is "<projectId>:<bidderId>".
    const [projectId, bidderId] = businessId.split(':').map(Number);
    try {
      const bids = (await myBids(projectId!, bidderId!)).filter((one) => !one.retracted);
      return bids[0] ? { kind: 'FOUND', receiptRef: String(bids[0].id) } : { kind: 'ABSENT' };
    } catch (error) {
      return { kind: 'INCONCLUSIVE', reason: (error as Error).message };
    }
  },
);

const messageAdapter = adapter('freelancer-message', MESSAGE, async (p) => {
  if (p.attachment || p.attachments) {
    const list = (p.attachments ?? [p.attachment]) as { name: string; base64: string; type: string }[];
    const sent = await postAttachment(
      num(p.threadId),
      list.map((file) => ({ name: file.name, bytes: Buffer.from(file.base64, 'base64'), type: file.type })),
    );
    if (p.message) await postMessage(num(p.threadId), String(p.message));
    return String(sent.id);
  }
  if (p.threadId) return String((await postMessage(num(p.threadId), String(p.message))).id);
  return `thread:${await startThread(num(p.employerId), num(p.projectId), String(p.message))}`;
});

const acceptAdapter = adapter('freelancer-accept', ACCEPT, async (p) => {
  await acceptAward(num(p.bidId));
  return `accepted:${p.bidId}`;
});

const milestoneAdapter = adapter('freelancer-milestone', MILESTONE, async (p) => {
  if (p.milestoneId) {
    await requestRelease(num(p.milestoneId));
    return `release:${p.milestoneId}`;
  }
  const created = await requestMilestone({
    projectId: num(p.projectId),
    bidId: num(p.bidId),
    amount: num(p.amount),
    description: String(p.description),
  });
  return `request:${created.id}`;
});

export interface RunResult {
  status: ExternalOutcome['status'];
  receipt: string | null;
  operationId: string;
  detail: string | null;
}

async function run(
  a: EffectAdapter,
  ns: OperationNamespace,
  input: { projectId: string; key: string; businessId: string; payload: Record<string, unknown> },
): Promise<RunResult> {
  const outcome = await runExternalEffect({
    adapter: a,
    namespace: ns,
    projectId: input.projectId,
    key: input.key,
    businessId: input.businessId,
    payload: input.payload,
    principalType: 'SYSTEM',
    principalId: 'brain-marketplace',
    correlationId: input.key,
  });
  return {
    status: outcome.status,
    receipt: receiptOf(outcome),
    operationId: outcome.operation.id,
    detail: outcome.status === 'UNCERTAIN' ? outcome.reason : outcome.operation.failureCategory ?? null,
  };
}

export function sendBid(input: {
  projectId: string;
  jobId: string;
  externalProjectId: number;
  bidderId: number;
  amount: number;
  period: number;
  description: string;
}): Promise<RunResult> {
  return run(bidAdapter, BID, {
    projectId: input.projectId,
    key: `freelancer.bid.${input.jobId}`,
    businessId: `${input.externalProjectId}:${input.bidderId}`,
    payload: {
      projectId: input.externalProjectId,
      bidderId: input.bidderId,
      amount: input.amount,
      period: input.period,
      description: input.description,
    },
  });
}

export function sendMessage(input: {
  projectId: string;
  jobId: string;
  /** Which message this is in the job's life: started, delivered, unable. */
  purpose: string;
  threadId: number | null;
  employerId: number | null;
  externalProjectId: number;
  message: string;
  attachment?: { name: string; base64: string; type: string };
  /** Several files in one message: all of a deliverable arrives together. */
  attachments?: { name: string; base64: string; type: string }[];
}): Promise<RunResult> {
  return run(messageAdapter, MESSAGE, {
    projectId: input.projectId,
    key: `freelancer.message.${input.jobId}.${input.purpose}`,
    businessId: `${input.jobId}:${input.purpose}`,
    payload: {
      threadId: input.threadId,
      employerId: input.employerId,
      projectId: input.externalProjectId,
      message: input.message,
      ...(input.attachment ? { attachment: input.attachment } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
  });
}

export function sendAccept(input: { projectId: string; jobId: string; bidId: number }): Promise<RunResult> {
  return run(acceptAdapter, ACCEPT, {
    projectId: input.projectId,
    key: `freelancer.accept.${input.jobId}`,
    businessId: `${input.jobId}:accept`,
    payload: { bidId: input.bidId },
  });
}

export function sendMilestone(input: {
  projectId: string;
  jobId: string;
  purpose: 'request' | 'release';
  externalProjectId: number;
  bidId: number;
  amount: number;
  milestoneId?: number;
  description: string;
}): Promise<RunResult> {
  return run(milestoneAdapter, MILESTONE, {
    projectId: input.projectId,
    key: `freelancer.milestone.${input.jobId}.${input.purpose}`,
    businessId: `${input.jobId}:${input.purpose}`,
    payload:
      input.purpose === 'release'
        ? { milestoneId: input.milestoneId }
        : { projectId: input.externalProjectId, bidId: input.bidId, amount: input.amount, description: input.description },
  });
}
