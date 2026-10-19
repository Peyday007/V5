/**
 * The Freelancer operation: find work Brain can deliver, bid, deliver, get paid.
 *
 * One pass per tick per project, derived from rows so a restart or a dead
 * tick resumes exactly where the last one stopped:
 *
 *   1. discover   Read open jobs (public, no credential), screen each once,
 *                 and record it PREPARED with its bid, or REJECTED with why.
 *   2. bid        Connected, authorized and under the limits: send the bid.
 *   3. watch      Read each bid; an award moves it to AWARDED, a closed or
 *                 lost project to LOST. New client messages are recorded.
 *   4. start      Accept the award, open a research goal on the brief (the
 *                 research fleet does the work, unattended), tell the client.
 *   5. deliver    The goal's packet filed and passed its audit: attach the
 *                 report, ask for the milestone to be released.
 *   6. collect    The milestone cleared: record the payment in the ledger.
 *
 * Authority is the standing commercial grant a person set (§30): CONTACT_BUYER
 * for bids and messages, QUOTE_AND_INVOICE for milestones, ACCEPT_PAYMENT for
 * the ledger entry. Without the grant, or without the owner's Freelancer
 * account connected, steps 2 to 6 stop where they are and say which is missing;
 * discovery keeps going. Nothing here spends money or publishes a listing.
 */
import { getDb } from '../../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { listLayers } from '../../../repos/layers.ts';
import { getDocument } from '../../../repos/documents.ts';
import { createResearchGoal } from '../../../repos/russellAuthority.ts';
import {
  allJobs,
  bidsSentSince,
  jobByExternalId,
  jobsInStates,
  move,
  recordJob,
  type MarketplaceJob,
} from '../../../repos/marketplaceJobs.ts';
import { checkCommercialAuthority } from '../authority.ts';
import { recordMoneyEvent } from '../opportunities.ts';
import { readObject, storageKeyOf } from '../../storage.ts';
import { CASH_LAYER_NAME } from '../lifecycle.ts';
import {
  freelancerConnected,
  getProject,
  myBids,
  projectMilestones,
  projectThread,
  searchProjects,
  self,
  threadMessages,
  type FreelancerProject,
} from './client.ts';
import { bidAmount, bidPeriodDays, screenProject } from './screen.ts';
import {
  composeBid,
  deliveredMessage,
  researchAssignment,
  startedMessage,
  unableMessage,
} from './proposal.ts';
import { sendAccept, sendBid, sendMessage, sendMilestone } from './effects.ts';

/** Operating limits. A person approves them with the grant; changing one is a reviewed change. */
export const LIMITS = Object.freeze({
  scanEveryMs: 30 * 60 * 1000,
  bidsPerDay: 5,
  activeJobs: 2,
  maxBidUsd: 250,
  newPerScan: 300,
});

export const SEARCH_QUERIES = [
  'market research',
  'research report',
  'competitor analysis',
  'competitive analysis',
  'industry analysis',
  'market analysis',
  'feasibility study',
  'business research',
  'desk research',
  'market sizing',
];

const ACTOR = 'BRAIN';
const ACTIVE: MarketplaceJob['state'][] = ['BID_SENT', 'AWARDED', 'FULFILLING', 'DELIVERED'];

export interface MarketplaceReport {
  scanned: number;
  recorded: number;
  prepared: number;
  bid: string[];
  awarded: string[];
  started: string[];
  delivered: string[];
  paid: string[];
  messages: number;
  /** Why acting stopped this pass, if it did. Safe to show a person. */
  blocked: string | null;
}

async function event(projectId: string, kind: string, summary: string, detail: Record<string, unknown> = {}) {
  await recordCashEvent({ projectId, kind, actorRef: ACTOR, summary, detail });
}

async function lastScanAt(projectId: string): Promise<number> {
  const row = await getDb().get<{ at: string | null }>(
    `SELECT MAX(created_at) AS at FROM cash_events WHERE project_id = ? AND kind = 'MARKETPLACE_SCAN'`,
    [projectId],
  );
  return row?.at ? Date.parse(row.at) : 0;
}

export async function discover(projectId: string, now = Date.now()): Promise<{ scanned: number; recorded: number; prepared: number }> {
  const seen = new Map<number, FreelancerProject>();
  for (const query of SEARCH_QUERIES) {
    try {
      for (const project of await searchProjects(query, 100)) seen.set(project.id, project);
    } catch {
      /* an unreadable query is skipped; the next scan asks again */
    }
  }
  let recorded = 0;
  let prepared = 0;
  for (const project of seen.values()) {
    if (recorded >= LIMITS.newPerScan) break;
    if (await jobByExternalId(projectId, String(project.id))) continue;
    const verdict = screenProject(project, now);
    const amount = verdict.deliverable ? Math.min(bidAmount(project), LIMITS.maxBidUsd) : null;
    const days = verdict.deliverable ? bidPeriodDays(project) : null;
    const { created } = await recordJob({
      projectId,
      externalId: String(project.id),
      title: project.title.slice(0, 300),
      url: `https://www.freelancer.com/projects/${project.seo_url}`,
      employerExternalId: String(project.owner_id),
      currency: project.currency.code,
      budgetMinCents: project.budget?.minimum != null ? Math.round(project.budget.minimum * 100) : null,
      budgetMaxCents: project.budget?.maximum != null ? Math.round(project.budget.maximum * 100) : null,
      postedAt: new Date(project.time_submitted * 1000).toISOString(),
      description: (project.description ?? project.preview_description ?? '').slice(0, 8000),
      screenReasons: verdict.reasons,
      proposalText: amount !== null && days !== null ? composeBid(project, amount, days) : null,
      bidAmountCents: amount !== null ? amount * 100 : null,
      bidPeriodDays: days,
      state: verdict.deliverable ? 'PREPARED' : 'REJECTED',
    });
    if (created) {
      recorded += 1;
      if (verdict.deliverable) prepared += 1;
    }
  }
  await event(projectId, 'MARKETPLACE_SCAN', `Read ${seen.size} open Freelancer jobs; ${prepared} new deliverable, ${recorded - prepared} rejected.`, {
    scanned: seen.size,
    recorded,
    prepared,
  });
  return { scanned: seen.size, recorded, prepared };
}

let cachedSelf: { id: number; username: string } | null = null;
async function bidder(): Promise<{ id: number; username: string }> {
  cachedSelf ??= await self();
  return cachedSelf;
}

/** Tests replace the account between runs. */
export function forgetAccount(): void {
  cachedSelf = null;
}

async function bidOnPrepared(projectId: string, report: MarketplaceReport): Promise<void> {
  const active = (await jobsInStates(projectId, ACTIVE)).length;
  if (active >= LIMITS.activeJobs) return;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let room = Math.min(LIMITS.bidsPerDay - (await bidsSentSince(projectId, since)), LIMITS.activeJobs - active);
  if (room <= 0) return;
  for (const job of await jobsInStates(projectId, ['PREPARED'])) {
    if (room <= 0) break;
    // Re-read: a prepared job may have closed since it was screened.
    let current: FreelancerProject;
    try {
      current = await getProject(job.externalId);
    } catch {
      continue;
    }
    const recheck = screenProject(current, Date.now());
    if (!recheck.deliverable) {
      await move(job.id, 'PREPARED', 'WITHDRAWN', { stateReason: recheck.reasons.join('; ') });
      continue;
    }
    const account = await bidder();
    const result = await sendBid({
      projectId,
      jobId: job.id,
      externalProjectId: Number(job.externalId),
      bidderId: account.id,
      amount: (job.bidAmountCents ?? 0) / 100,
      period: job.bidPeriodDays ?? 4,
      description: job.proposalText ?? '',
    });
    if (result.status === 'CONFIRMED' || result.status === 'RECONCILED' || result.status === 'REPLAYED') {
      await move(job.id, 'PREPARED', 'BID_SENT', { bidExternalId: result.receipt });
      await event(projectId, 'MARKETPLACE_BID_SENT', `Bid USD ${(job.bidAmountCents ?? 0) / 100} on "${job.title}".`, {
        jobId: job.id,
        externalId: job.externalId,
        bidId: result.receipt,
        operationId: result.operationId,
      });
      report.bid.push(job.id);
      room -= 1;
    } else if (result.status === 'UNCERTAIN') {
      await move(job.id, 'PREPARED', 'BID_UNCERTAIN', { stateReason: result.detail });
    } else {
      await move(job.id, 'PREPARED', 'BID_REFUSED', { stateReason: result.detail });
    }
  }
}

async function watchBids(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['BID_SENT', 'BID_UNCERTAIN'])) {
    let bids;
    try {
      bids = await myBids(Number(job.externalId), (await bidder()).id);
    } catch {
      continue;
    }
    const mine = bids.find((one) => !one.retracted);
    if (job.state === 'BID_UNCERTAIN') {
      // Asked rather than resent: a bid Freelancer holds is a sent bid.
      if (mine) await move(job.id, 'BID_UNCERTAIN', 'BID_SENT', { bidExternalId: String(mine.id), stateReason: null });
      continue;
    }
    if (mine?.award_status === 'awarded' || mine?.award_status === 'pending') {
      if (await move(job.id, 'BID_SENT', 'AWARDED', { bidExternalId: String(mine.id) })) {
        await event(projectId, 'MARKETPLACE_AWARDED', `Awarded "${job.title}".`, { jobId: job.id, bidId: mine.id });
        report.awarded.push(job.id);
      }
      continue;
    }
    try {
      const project = await getProject(job.externalId);
      const open = project.status === 'active' && (project.frontend_project_status ?? 'open') === 'open';
      if (!open && mine?.award_status !== 'awarded') {
        await move(job.id, 'BID_SENT', 'LOST', { stateReason: `project ${project.status}/${project.frontend_project_status ?? '-'}` });
      }
    } catch {
      /* unreadable is not lost */
    }
  }
}

async function startAwarded(projectId: string, report: MarketplaceReport): Promise<void> {
  const mode = await getCashMode(projectId);
  if (!mode) return;
  for (const job of await jobsInStates(projectId, ['AWARDED'])) {
    const accepted = await sendAccept({ projectId, jobId: job.id, bidId: Number(job.bidExternalId) });
    if (accepted.status === 'FAILED') {
      await move(job.id, 'AWARDED', 'LOST', { stateReason: `award could not be accepted: ${accepted.detail}` });
      continue;
    }
    if (accepted.status === 'UNCERTAIN') continue;
    const layer = (await listLayers(projectId)).find((one) => one.name === CASH_LAYER_NAME) ?? (await listLayers(projectId))[0];
    const days = job.bidPeriodDays ?? 4;
    let goalId = job.goalId;
    if (!goalId && layer) {
      const goal = await createResearchGoal({
        projectId,
        ownerUserId: mode.ownerUserId,
        createdByUserId: mode.ownerUserId,
        name: `Client job: ${job.title}`.slice(0, 200),
        maxPackets: 2,
        maxFragments: 12,
        deadline: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
        researchAssignment: researchAssignment(job),
        researchLayerId: layer.id,
      });
      goalId = goal.id;
    }
    const thread = await projectThread(Number(job.externalId)).catch(() => null);
    await sendMessage({
      projectId,
      jobId: job.id,
      purpose: 'started',
      threadId: thread,
      employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
      externalProjectId: Number(job.externalId),
      message: startedMessage(days),
    });
    await sendMilestone({
      projectId,
      jobId: job.id,
      purpose: 'request',
      externalProjectId: Number(job.externalId),
      bidId: Number(job.bidExternalId),
      amount: (job.bidAmountCents ?? 0) / 100,
      description: `Research report: ${job.title}`.slice(0, 200),
    });
    if (await move(job.id, 'AWARDED', 'FULFILLING', { goalId, threadExternalId: thread !== null ? String(thread) : null })) {
      await event(projectId, 'MARKETPLACE_FULFILMENT_STARTED', `Research started for "${job.title}".`, { jobId: job.id, goalId });
      report.started.push(job.id);
    }
  }
}

async function deliverFinished(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['FULFILLING'])) {
    if (!job.goalId) continue;
    const packets = await getDb().all<{ id: string; status: string; document_id: string | null; verdict: string | null }>(
      'SELECT id, status, document_id, verdict FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at, id',
      [job.goalId],
    );
    const done = packets.find((one) => one.status === 'COMPLETE' && one.document_id);
    const deadline = Date.parse(job.updatedAt) + ((job.bidPeriodDays ?? 4) + 2) * 24 * 3600 * 1000;
    const thread = job.threadExternalId ? Number(job.threadExternalId) : await projectThread(Number(job.externalId)).catch(() => null);
    if (done) {
      const document = await getDocument(done.document_id!);
      const key = storageKeyOf(document);
      if (!document || !key) continue;
      const bytes = await readObject(key);
      const sent = await sendMessage({
        projectId,
        jobId: job.id,
        purpose: 'delivered',
        threadId: thread,
        employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
        externalProjectId: Number(job.externalId),
        message: deliveredMessage(),
        attachment: { name: `${(document.filename ?? 'report.md').replace(/[^\w.-]+/g, '-')}`, base64: bytes.toString('base64'), type: 'text/markdown' },
      });
      if (sent.status === 'FAILED' || sent.status === 'UNCERTAIN') continue;
      const milestones = await projectMilestones(Number(job.externalId)).catch(() => []);
      const funded = milestones.find((one) => one.status !== 'cancelled' && one.status !== 'cleared');
      if (funded) {
        await sendMilestone({
          projectId,
          jobId: job.id,
          purpose: 'release',
          externalProjectId: Number(job.externalId),
          bidId: Number(job.bidExternalId),
          amount: (job.bidAmountCents ?? 0) / 100,
          milestoneId: funded.transaction_id,
          description: 'Report delivered',
        });
      }
      if (await move(job.id, 'FULFILLING', 'DELIVERED', { documentId: done.document_id, milestoneExternalId: funded ? String(funded.transaction_id) : null })) {
        await event(projectId, 'MARKETPLACE_DELIVERED', `Delivered the report for "${job.title}".`, { jobId: job.id, documentId: done.document_id });
        report.delivered.push(job.id);
      }
    } else if (packets.some((one) => ['FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(one.status)) || Date.now() > deadline) {
      await sendMessage({
        projectId,
        jobId: job.id,
        purpose: 'unable',
        threadId: thread,
        employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
        externalProjectId: Number(job.externalId),
        message: unableMessage(),
      });
      await move(job.id, 'FULFILLING', 'FULFILMENT_FAILED', {
        stateReason: packets.map((one) => one.status).join(', ') || 'the research did not finish in time',
      });
    }
  }
}

async function collectPaid(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['DELIVERED'])) {
    const milestones = await projectMilestones(Number(job.externalId)).catch(() => []);
    const cleared = milestones.find((one) => one.status === 'cleared');
    if (!cleared) continue;
    const recorded = await recordMoneyEvent({
      projectId,
      opportunityId: null,
      kind: 'CUSTOMER_PAYMENT',
      amountCents: Math.round(cleared.amount * 100),
      currency: job.currency,
      verifiedReference: `freelancer-milestone:${cleared.transaction_id}`,
      idempotencyKey: `freelancer.paid.${job.id}`,
      actorRef: ACTOR,
      note: `Freelancer milestone released for "${job.title}".`,
    });
    if (!recorded.ok) {
      await move(job.id, 'DELIVERED', 'DELIVERED', { stateReason: recorded.reason });
      continue;
    }
    if (await move(job.id, 'DELIVERED', 'PAID', { milestoneExternalId: String(cleared.transaction_id), stateReason: null })) {
      await event(projectId, 'MARKETPLACE_PAID', `Paid USD ${cleared.amount} for "${job.title}".`, { jobId: job.id, milestone: cleared.transaction_id });
      report.paid.push(job.id);
    }
  }
}

/** Client messages on active jobs, recorded once each so a person and the next pass can read them. */
async function readMessages(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['BID_SENT', 'AWARDED', 'FULFILLING', 'DELIVERED'])) {
    const thread = job.threadExternalId ? Number(job.threadExternalId) : await projectThread(Number(job.externalId)).catch(() => null);
    if (thread === null) continue;
    const messages = await threadMessages(thread).catch(() => []);
    const fromClient = messages.filter((one) => String(one.from_user) === job.employerExternalId);
    const known = new Set(
      (
        await getDb().all<{ detail: string }>(
          `SELECT detail FROM cash_events WHERE project_id = ? AND kind = 'MARKETPLACE_MESSAGE_RECEIVED' AND detail LIKE ?`,
          [projectId, `%"jobId":"${job.id}"%`],
        )
      ).map((one) => String((JSON.parse(one.detail) as { messageId?: unknown }).messageId)),
    );
    for (const message of fromClient) {
      if (known.has(String(message.id))) continue;
      await event(projectId, 'MARKETPLACE_MESSAGE_RECEIVED', `Client wrote on "${job.title}": ${message.message.slice(0, 240)}`, {
        jobId: job.id,
        messageId: message.id,
      });
      report.messages += 1;
    }
  }
}

export async function runFreelancerOperation(projectId: string, now = Date.now()): Promise<MarketplaceReport | null> {
  const mode = await getCashMode(projectId);
  if (!mode || mode.state !== 'ACTIVE' || mode.currency !== 'USD') return null;
  const report: MarketplaceReport = {
    scanned: 0,
    recorded: 0,
    prepared: 0,
    bid: [],
    awarded: [],
    started: [],
    delivered: [],
    paid: [],
    messages: 0,
    blocked: null,
  };
  if (now - (await lastScanAt(projectId)) >= LIMITS.scanEveryMs) {
    Object.assign(report, await discover(projectId, now));
  }
  const connection = freelancerConnected();
  if (!connection.usable) {
    report.blocked = connection.reason;
    return report;
  }
  const contact = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' });
  if (!contact.ok) {
    report.blocked = `Bidding needs the standing commercial grant to allow CONTACT_BUYER: ${contact.reason}.`;
    return report;
  }
  await watchBids(projectId, report);
  await readMessages(projectId, report);
  await startAwarded(projectId, report);
  await deliverFinished(projectId, report);
  await collectPaid(projectId, report);
  await bidOnPrepared(projectId, report);
  return report;
}

export { allJobs };
