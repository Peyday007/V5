/**
 * The Freelancer operation: find work Brain can deliver, bid, deliver, get paid.
 *
 * One pass per tick per project, derived from rows so a restart or a dead
 * tick resumes exactly where the last one stopped:
 *
 *   1. discover   Read open jobs (public, no credential), screen each against
 *                 the capabilities Brain has proved in this process, and record
 *                 it PREPARED with its bid and figures, or REJECTED with why.
 *                 A job rejected by an earlier screen is asked again while it
 *                 is still open, so a capability added later reaches it.
 *   2. bid        Connected, authorized and under the limits: send the bid.
 *   3. watch      Read each bid; an award moves it to AWARDED, a closed or
 *                 lost project to LOST. New client messages are recorded, and
 *                 a question is answered (`reply` bins).
 *   4. start      Accept the award, tell the client, and start the work: a
 *                 research goal for a research report, or a deliverable bin
 *                 (`fulfil.ts`) for every other kind, fed the client's files.
 *   5. deliver    The work passed its checks: attach every file, ask for the
 *                 milestone to be released. A client reply after delivery is a
 *                 revision, bounded, as a new version.
 *   6. collect    The milestone cleared: record the payment in the ledger, in
 *                 the sprint's currency at Freelancer's own published rate.
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
import { getBin } from '../../../repos/bins.ts';
import { createResearchGoal } from '../../../repos/russellAuthority.ts';
import {
  allJobs,
  bidsSentSince,
  deliverablesFor,
  jobByExternalId,
  jobsInStates,
  markDeliverableDelivered,
  move,
  recordDeliverable,
  recordJob,
  type MarketplaceJob,
} from '../../../repos/marketplaceJobs.ts';
import { checkCommercialAuthority } from '../authority.ts';
import { recordMoneyEvent } from '../opportunities.ts';
import { readObject, storageKeyOf } from '../../storage.ts';
import { CASH_LAYER_NAME } from '../lifecycle.ts';
import {
  downloadClientFile,
  freelancerConnected,
  getProject,
  myBids,
  projectFiles,
  projectMilestones,
  projectThread,
  searchProjects,
  self,
  threadFiles,
  threadMessages,
  type FreelancerProject,
} from './client.ts';
import { bidPeriodDays, screenProject, type ScreenContext, type ScreenVerdict } from './screen.ts';
import {
  composeBid,
  deliveredFilesMessage,
  deliveredMessage,
  filesRequestMessage,
  researchAssignment,
  startedDeliverableMessage,
  startedMessage,
  unableMessage,
} from './proposal.ts';
import { sendAccept, sendBid, sendMessage, sendMilestone } from './effects.ts';
import { codeLanguages, proveCapabilities } from './deliverables/capabilities.ts';
import { DELIVERABLE_KINDS, type DeliverableKind } from './deliverables/spec.ts';
import { messageProblems } from './deliverables/spec.ts';
import {
  ingestBin,
  loadFiles,
  MAX_DELIVERABLE_BINS,
  MAX_REVISIONS,
  openDeliverableBin,
  openReplyBin,
  readClientFile,
  replyOf,
  storeClientFile,
  type ReadFile,
} from './fulfil.ts';

/** Operating limits. A person approves them with the grant; changing one is a reviewed change. */
export const LIMITS = Object.freeze({
  scanEveryMs: 30 * 60 * 1000,
  bidsPerDay: 5,
  activeJobs: 2,
  maxBidUsd: 250,
  newPerScan: 300,
  repliesPerJob: 3,
  /**
   * How long one scan may spend asking Freelancer. The scan runs inside the
   * Russell tick, and every request may take the client's 30 s timeout, so
   * 33 searches plus a recheck per prepared job could otherwise hold the tick
   * for many minutes when Freelancer is slow. What is not asked in time is
   * asked by the next scan; nothing is withdrawn for being unread.
   */
  discoveryBudgetMs: 120_000,
});

export const SEARCH_QUERIES = [
  'market research',
  'research report',
  'competitor analysis',
  'industry analysis',
  'feasibility study',
  'business research',
  'excel',
  'spreadsheet',
  'google sheets',
  'financial model',
  'budget template',
  'business plan',
  'proposal writing',
  'report writing',
  'powerpoint',
  'pitch deck',
  'presentation',
  'data cleaning',
  'data entry',
  'data extraction',
  'csv',
  'data analysis',
  'landing page',
  'html css',
  'python script',
  'javascript',
  'automation script',
  'logo',
  'flyer',
  'banner design',
  'social media graphics',
  '3d model',
  'product render',
];

const ACTOR = 'BRAIN';
const ACTIVE: MarketplaceJob['state'][] = ['BID_SENT', 'AWARDED', 'FULFILLING', 'DELIVERED'];
const DAY = 24 * 3600 * 1000;

export interface MarketplaceReport {
  scanned: number;
  recorded: number;
  prepared: number;
  /** Jobs an earlier screen rejected that the current one qualifies. */
  requalified: number;
  bid: string[];
  awarded: string[];
  started: string[];
  delivered: string[];
  revised: string[];
  replied: string[];
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

const announced = new Set<string>();

/** What the screen may assume in this process: the capabilities proved, and what is in flight. */
export async function screenContext(projectId: string): Promise<ScreenContext> {
  const caps = await proveCapabilities();
  const available = new Set<DeliverableKind>(DELIVERABLE_KINDS.filter((k) => caps[k].available));
  if (!announced.has(projectId)) {
    announced.add(projectId);
    await event(
      projectId,
      'MARKETPLACE_CAPABILITIES_PROVED',
      `Deliverable kinds proved in this process: ${[...available].join(', ') || 'none'}.`,
      { readings: Object.values(caps).map((c) => ({ kind: c.kind, available: c.available, detail: c.detail })), revision: process.env.BRAIN_REVISION ?? null },
    );
  }
  const proven = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_events WHERE project_id = ? AND kind = 'MARKETPLACE_CLIENT_FILE_READ'`,
    [projectId],
  );
  const active = (await jobsInStates(projectId, ACTIVE)).filter((j) => j.needsClientFiles).length;
  return { available, python: codeLanguages().python, clientFilesProven: Number(proven?.n ?? 0) > 0, clientFileJobsActive: active };
}

function verdictFields(project: FreelancerProject, verdict: ScreenVerdict) {
  const e = verdict.economics;
  const days = verdict.deliverable ? bidPeriodDays(project) : null;
  return {
    proposalText: e && days !== null ? composeBid(project, e.bid, days, verdict.categories) : null,
    bidAmountCents: e ? Math.round(e.bid * 100) : null,
    bidPeriodDays: days,
    categories: verdict.categories,
    economics: e ? { ...e, readAt: new Date().toISOString(), rateSource: 'Freelancer project currency.exchange_rate' } : null,
    needsClientFiles: verdict.needsClientFiles,
  };
}

export async function discover(projectId: string, now = Date.now()): Promise<{ scanned: number; recorded: number; prepared: number; requalified: number }> {
  const context = await screenContext(projectId);
  const seen = new Map<number, FreelancerProject>();
  const deadline = Date.now() + LIMITS.discoveryBudgetMs;
  for (const query of SEARCH_QUERIES) {
    if (Date.now() >= deadline) break;
    try {
      for (const project of await searchProjects(query, 100)) seen.set(project.id, project);
    } catch {
      /* an unreadable query is skipped; the next scan asks again */
    }
  }
  let recorded = 0;
  let prepared = 0;
  let requalified = 0;
  for (const project of seen.values()) {
    const existing = await jobByExternalId(projectId, String(project.id));
    if (existing) {
      // A job an earlier screen rejected is asked again while it is still open,
      // so a capability added since reaches it, and its reasons stay current.
      if (existing.state !== 'REJECTED') continue;
      const verdict = screenProject(project, now, context);
      if (verdict.deliverable) {
        const f = verdictFields(project, verdict);
        const moved = await move(existing.id, 'REJECTED', 'PREPARED', {
          stateReason: 'qualified by a later screen',
          screenReasons: JSON.stringify(verdict.reasons),
          proposalText: f.proposalText,
          bidAmountCents: f.bidAmountCents,
          bidPeriodDays: f.bidPeriodDays,
          categories: JSON.stringify(f.categories),
          economics: JSON.stringify(f.economics),
          needsClientFiles: f.needsClientFiles ? 1 : 0,
        });
        if (moved) {
          requalified += 1;
          prepared += 1;
          await event(projectId, 'MARKETPLACE_REQUALIFIED', `"${existing.title}" now qualifies: ${verdict.reasons[0]}.`, {
            jobId: existing.id,
            categories: f.categories,
            previous: existing.screenReasons,
          });
        }
      } else if (JSON.stringify(verdict.reasons) !== JSON.stringify(existing.screenReasons)) {
        await move(existing.id, 'REJECTED', 'REJECTED', { screenReasons: JSON.stringify(verdict.reasons) });
      }
      continue;
    }
    if (recorded >= LIMITS.newPerScan) continue;
    const verdict = screenProject(project, now, context);
    const f = verdictFields(project, verdict);
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
      proposalText: f.proposalText,
      bidAmountCents: f.bidAmountCents,
      bidPeriodDays: f.bidPeriodDays,
      state: verdict.deliverable ? 'PREPARED' : 'REJECTED',
      categories: f.categories,
      economics: f.economics,
      needsClientFiles: f.needsClientFiles,
    });
    if (created) {
      recorded += 1;
      if (verdict.deliverable) prepared += 1;
    }
  }
  // Every prepared job is asked again each scan, against the current screen and
  // Freelancer's current reading, so one that closed or no longer passes is
  // withdrawn with its reason whether or not an account is connected.
  for (const job of await jobsInStates(projectId, ['PREPARED'])) {
    try {
      const listed = seen.get(Number(job.externalId));
      if (!listed && Date.now() >= deadline) continue;
      const current = listed ?? (await getProject(job.externalId));
      const recheck = screenProject(current, now, context);
      if (!recheck.deliverable) {
        await move(job.id, 'PREPARED', 'WITHDRAWN', { stateReason: recheck.reasons.join('; ') });
      }
    } catch {
      /* unreadable now is not a reason to withdraw */
    }
  }
  await event(
    projectId,
    'MARKETPLACE_SCAN',
    `Read ${seen.size} open Freelancer jobs; ${prepared} deliverable (${requalified} re-qualified), ${recorded - (prepared - requalified)} new rejected.`,
    { scanned: seen.size, recorded, prepared, requalified, available: [...context.available] },
  );
  return { scanned: seen.size, recorded, prepared, requalified };
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

const thread = async (job: MarketplaceJob): Promise<number | null> =>
  job.threadExternalId ? Number(job.threadExternalId) : await projectThread(Number(job.externalId)).catch(() => null);

const money = (job: MarketplaceJob) => `${job.currency} ${(job.bidAmountCents ?? 0) / 100}`;

async function bidOnPrepared(projectId: string, report: MarketplaceReport): Promise<void> {
  const active = (await jobsInStates(projectId, ACTIVE)).length;
  if (active >= LIMITS.activeJobs) return;
  const since = new Date(Date.now() - DAY).toISOString();
  let room = Math.min(LIMITS.bidsPerDay - (await bidsSentSince(projectId, since)), LIMITS.activeJobs - active);
  if (room <= 0) return;
  const context = await screenContext(projectId);
  for (const job of await jobsInStates(projectId, ['PREPARED'])) {
    if (room <= 0) break;
    // Re-read: a prepared job may have closed since it was screened.
    let current: FreelancerProject;
    try {
      current = await getProject(job.externalId);
    } catch {
      continue;
    }
    const recheck = screenProject(current, Date.now(), context);
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
      await event(projectId, 'MARKETPLACE_BID_SENT', `Bid ${money(job)} on "${job.title}".`, {
        jobId: job.id,
        externalId: job.externalId,
        bidId: result.receipt,
        operationId: result.operationId,
        categories: job.categories,
        economics: job.economics,
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

/** The client's files on this job, read once each; returns every file read so far. */
async function gatherClientFiles(projectId: string, job: MarketplaceJob): Promise<ReadFile[]> {
  const t = await thread(job);
  const refs = [
    ...(await projectFiles(Number(job.externalId)).catch(() => [])),
    ...(t !== null ? await threadFiles(t, job.employerExternalId).catch(() => []) : []),
  ];
  const known = new Map((job.clientFiles ?? []).map((f) => [f.name, f]));
  const out: ReadFile[] = [];
  const stored = new Map<string, { storageKey: string; sha256: string }>();
  for (const ref of refs.slice(0, 10)) {
    let read: ReadFile;
    try {
      const bytes = await downloadClientFile(ref);
      read = await readClientFile(ref.name, bytes);
      if (read.readable) stored.set(ref.name, await storeClientFile(job, ref.name, bytes));
    } catch (error) {
      read = { name: ref.name, text: '', readable: false, note: `could not be downloaded: ${(error as Error).message.slice(0, 120)}` };
    }
    out.push(read);
    if (!known.has(ref.name) && read.readable) {
      await event(projectId, 'MARKETPLACE_CLIENT_FILE_READ', `Read the client's file "${ref.name}" on "${job.title}" (${read.note}).`, {
        jobId: job.id,
        name: ref.name,
        chars: read.text.length,
        source: ref.source,
      });
    }
  }
  const summary = out.map((f) => ({ name: f.name, chars: f.text.length, readable: f.readable, note: f.note, ...(stored.get(f.name) ?? {}) }));
  if (JSON.stringify(summary) !== JSON.stringify(job.clientFiles ?? [])) {
    await move(job.id, job.state, job.state, { clientFiles: JSON.stringify(summary) });
  }
  return out;
}

async function clientMessages(job: MarketplaceJob): Promise<string[]> {
  const t = await thread(job);
  if (t === null) return [];
  const messages = await threadMessages(t).catch(() => []);
  return messages
    .filter((m) => String(m.from_user) === job.employerExternalId)
    .sort((a, b) => a.time_created - b.time_created)
    .map((m) => m.message.slice(0, 2000));
}

const deliverableKinds = (job: MarketplaceJob) => job.categories.filter((c) => c !== 'RESEARCH_REPORT') as DeliverableKind[];

async function binsSpent(jobId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM bins WHERE created_by_id LIKE ?`, [`freelancer:deliver:${jobId}:%`]);
  return Number(row?.n ?? 0);
}

/** Open the next deliverable bin for a job, with whatever the client has sent. */
async function startDeliverableWork(
  projectId: string,
  job: MarketplaceJob,
  extra: { previous?: { spec: unknown; version: number }; problems?: string[]; askedForFiles?: boolean } = {},
): Promise<'OPENED' | 'WAITING_FOR_FILES' | 'EXHAUSTED'> {
  const spent = await binsSpent(job.id);
  if (spent >= MAX_DELIVERABLE_BINS) return 'EXHAUSTED';
  const files = await gatherClientFiles(projectId, job);
  if (job.needsClientFiles && !files.some((f) => f.readable)) {
    const unreadable = files.filter((f) => !f.readable);
    // The award message already asked for the files; ask again only about one that could not be read.
    if (extra.askedForFiles && unreadable.length === 0) return 'WAITING_FOR_FILES';
    const t = await thread(job);
    await sendMessage({
      projectId,
      jobId: job.id,
      purpose: `files-request-${files.filter((f) => !f.readable).map((f) => f.name).join('|') || 'none'}`.slice(0, 120),
      threadId: t,
      employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
      externalProjectId: Number(job.externalId),
      message: filesRequestMessage(files.filter((f) => !f.readable).map((f) => f.name)),
    });
    return 'WAITING_FOR_FILES';
  }
  const bin = await openDeliverableBin({
    job,
    kinds: deliverableKinds(job),
    attempt: spent + 1,
    clientMessages: await clientMessages(job),
    files,
    previous: extra.previous ?? null,
    problems: extra.problems,
  });
  await move(job.id, job.state, job.state, { deliverableBinId: bin.id });
  await event(projectId, 'MARKETPLACE_WORK_REQUESTED', `Asked the fleet to produce "${job.title}" (bin ${spent + 1} of ${MAX_DELIVERABLE_BINS}).`, {
    jobId: job.id,
    binId: bin.id,
    kinds: deliverableKinds(job),
    revision: Boolean(extra.previous),
  });
  return 'OPENED';
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
    const days = job.bidPeriodDays ?? 4;
    const research = job.categories.length === 0 || job.categories.includes('RESEARCH_REPORT');
    let goalId = job.goalId;
    if (research && !goalId) {
      const layer = (await listLayers(projectId)).find((one) => one.name === CASH_LAYER_NAME) ?? (await listLayers(projectId))[0];
      if (layer) {
        const goal = await createResearchGoal({
          projectId,
          ownerUserId: mode.ownerUserId,
          createdByUserId: mode.ownerUserId,
          name: `Client job: ${job.title}`.slice(0, 200),
          maxPackets: 2,
          maxFragments: 12,
          deadline: new Date(Date.now() + days * DAY).toISOString(),
          researchAssignment: researchAssignment(job),
          researchLayerId: layer.id,
        });
        goalId = goal.id;
      }
    }
    const t = await projectThread(Number(job.externalId)).catch(() => null);
    await sendMessage({
      projectId,
      jobId: job.id,
      purpose: 'started',
      threadId: t,
      employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
      externalProjectId: Number(job.externalId),
      message: research ? startedMessage(days) : startedDeliverableMessage(days, job.needsClientFiles),
    });
    await sendMilestone({
      projectId,
      jobId: job.id,
      purpose: 'request',
      externalProjectId: Number(job.externalId),
      bidId: Number(job.bidExternalId),
      amount: (job.bidAmountCents ?? 0) / 100,
      description: `${research ? 'Research report' : 'Deliverable'}: ${job.title}`.slice(0, 200),
    });
    if (await move(job.id, 'AWARDED', 'FULFILLING', { goalId, threadExternalId: t !== null ? String(t) : null })) {
      await event(projectId, 'MARKETPLACE_FULFILMENT_STARTED', `Work started for "${job.title}".`, { jobId: job.id, goalId, categories: job.categories });
      report.started.push(job.id);
      if (!research) {
        const fresh = (await jobByExternalId(projectId, job.externalId))!;
        await startDeliverableWork(projectId, fresh, { askedForFiles: true });
      }
    }
  }
}

async function failJob(projectId: string, job: MarketplaceJob, reason: string): Promise<void> {
  await sendMessage({
    projectId,
    jobId: job.id,
    purpose: 'unable',
    threadId: await thread(job),
    employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
    externalProjectId: Number(job.externalId),
    message: unableMessage(),
  });
  await move(job.id, 'FULFILLING', 'FULFILMENT_FAILED', { stateReason: reason });
  await event(projectId, 'MARKETPLACE_FULFILMENT_FAILED', `Could not deliver "${job.title}": ${reason}`, { jobId: job.id });
}

async function requestRelease(projectId: string, job: MarketplaceJob): Promise<string | null> {
  const milestones = await projectMilestones(Number(job.externalId)).catch(() => []);
  const funded = milestones.find((one) => one.status !== 'cancelled' && one.status !== 'cleared');
  if (!funded) return null;
  await sendMilestone({
    projectId,
    jobId: job.id,
    purpose: 'release',
    externalProjectId: Number(job.externalId),
    bidId: Number(job.bidExternalId),
    amount: (job.bidAmountCents ?? 0) / 100,
    milestoneId: funded.transaction_id,
    description: 'Work delivered',
  });
  return String(funded.transaction_id);
}

async function deliverResearch(projectId: string, job: MarketplaceJob, report: MarketplaceReport, deadline: number): Promise<void> {
  if (!job.goalId) return;
  const packets = await getDb().all<{ id: string; status: string; document_id: string | null }>(
    'SELECT id, status, document_id FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at, id',
    [job.goalId],
  );
  const done = packets.find((one) => one.status === 'COMPLETE' && one.document_id);
  if (done) {
    const document = await getDocument(done.document_id!);
    const key = storageKeyOf(document);
    if (!document || !key) return;
    const bytes = await readObject(key);
    const sent = await sendMessage({
      projectId,
      jobId: job.id,
      purpose: 'delivered',
      threadId: await thread(job),
      employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
      externalProjectId: Number(job.externalId),
      message: deliveredMessage(),
      attachment: { name: `${(document.filename ?? 'report.md').replace(/[^\w.-]+/g, '-')}`, base64: bytes.toString('base64'), type: 'text/markdown' },
    });
    if (sent.status === 'FAILED' || sent.status === 'UNCERTAIN') return;
    const milestone = await requestRelease(projectId, job);
    if (await move(job.id, 'FULFILLING', 'DELIVERED', { documentId: done.document_id, milestoneExternalId: milestone })) {
      await event(projectId, 'MARKETPLACE_DELIVERED', `Delivered the report for "${job.title}".`, { jobId: job.id, documentId: done.document_id });
      report.delivered.push(job.id);
    }
  } else if (packets.some((one) => ['FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(one.status)) || Date.now() > deadline) {
    await failJob(projectId, job, packets.map((one) => one.status).join(', ') || 'the research did not finish in time');
  }
}

async function deliverWork(projectId: string, job: MarketplaceJob, report: MarketplaceReport, deadline: number): Promise<void> {
  if (!job.deliverableBinId) {
    const started = await startDeliverableWork(projectId, job, { askedForFiles: true });
    if (started === 'EXHAUSTED') await failJob(projectId, job, 'no deliverable bin could be opened');
    else if (Date.now() > deadline) await failJob(projectId, job, 'the client’s files did not arrive in time');
    return;
  }
  const bin = await getBin(job.deliverableBinId);
  if (!bin) return;
  if (bin.state === 'COMPLETE') {
    const already = (await deliverablesFor(job.id)).find((d) => d.binId === bin.id);
    let version = already ?? null;
    if (!version) {
      const ingested = await ingestBin(job, bin.id);
      if ('refused' in ingested) {
        await recordDeliverable({
          projectId,
          jobId: job.id,
          binId: bin.id,
          kinds: deliverableKinds(job),
          spec: null,
          message: null,
          files: [],
          verification: { passed: false, checks: [], problems: ingested.refused },
          state: 'REFUSED',
        });
        const next = await startDeliverableWork(projectId, job, { problems: ingested.refused });
        if (next === 'EXHAUSTED') await failJob(projectId, job, `the work did not pass Brain's checks: ${ingested.refused.slice(0, 3).join('; ')}`);
        return;
      }
      version = await recordDeliverable({
        projectId,
        jobId: job.id,
        binId: bin.id,
        kinds: deliverableKinds(job),
        spec: ingested.produced.submission!.specs,
        message: ingested.produced.submission!.message,
        files: ingested.files,
        verification: { passed: true, checks: ingested.produced.verification!.checks },
        state: 'VERIFIED',
      });
      await event(projectId, 'MARKETPLACE_DELIVERABLE_VERIFIED', `Version ${version.version} of "${job.title}" passed ${version.verification.checks.length} check(s).`, {
        jobId: job.id,
        deliverableId: version.id,
        files: version.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
      });
    }
    if (version.state === 'REFUSED') return;
    const attachments = await loadFiles(version.files);
    const sent = await sendMessage({
      projectId,
      jobId: job.id,
      purpose: `delivered-v${version.version}`,
      threadId: await thread(job),
      employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
      externalProjectId: Number(job.externalId),
      message: deliveredFilesMessage(version.files.map((f) => f.name), version.message),
      attachments,
    });
    if (sent.status === 'FAILED' || sent.status === 'UNCERTAIN') return;
    await markDeliverableDelivered(version.id);
    const milestone = job.milestoneExternalId ?? (await requestRelease(projectId, job));
    if (await move(job.id, 'FULFILLING', 'DELIVERED', { milestoneExternalId: milestone })) {
      await event(projectId, 'MARKETPLACE_DELIVERED', `Delivered version ${version.version} of "${job.title}": ${version.files.map((f) => f.name).join(', ')}.`, {
        jobId: job.id,
        deliverableId: version.id,
      });
      report.delivered.push(job.id);
    }
    return;
  }
  if (['FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(bin.state)) {
    const next = await startDeliverableWork(projectId, job, { problems: [`The previous worker could not finish (${bin.state}). Start again from the brief.`] });
    if (next === 'EXHAUSTED') await failJob(projectId, job, `every attempt to produce the work ended ${bin.state}`);
    return;
  }
  if (Date.now() > deadline) await failJob(projectId, job, 'the work did not finish in time');
}

async function deliverFinished(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['FULFILLING'])) {
    const deadline = Date.parse(job.updatedAt) + ((job.bidPeriodDays ?? 4) + 2) * DAY;
    const research = job.categories.length === 0 || job.categories.includes('RESEARCH_REPORT');
    if (research) await deliverResearch(projectId, job, report, deadline);
    else await deliverWork(projectId, job, report, deadline);
  }
}

/** A short acknowledgement is not a change request; anything else after delivery is. */
export function isAcknowledgement(text: string): boolean {
  const t = text.trim();
  if (t.length >= 80 || t.includes('?')) return false;
  if (/\b(can you|could you|please|change|add|update|fix|instead|but|however|wrong|missing|revise|edit|remove|replace)\b/i.test(t)) return false;
  return /^(thanks?|thank you|thx|great|perfect|approved|looks good|received|got it|ok(ay)?|nice|awesome|excellent)\b/i.test(t);
}

/** A message that asks something, as opposed to one that tells or thanks. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.includes('?') || /^(can|could|would|will|do|does|did|is|are|how|what|when|why|which|who|where)\b/i.test(t);
}

/** Client messages on active jobs: recorded once each, answered, and after delivery treated as a revision. */
async function readMessages(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['BID_SENT', 'AWARDED', 'FULFILLING', 'DELIVERED'])) {
    const t = await thread(job);
    if (t === null) continue;
    const messages = await threadMessages(t).catch(() => []);
    const fromClient = messages.filter((one) => String(one.from_user) === job.employerExternalId);
    const known = new Set(
      (
        await getDb().all<{ detail: string }>(
          `SELECT detail FROM cash_events WHERE project_id = ? AND kind = 'MARKETPLACE_MESSAGE_RECEIVED' AND detail LIKE ?`,
          [projectId, `%"jobId":"${job.id}"%`],
        )
      ).map((one) => String((JSON.parse(one.detail) as { messageId?: unknown }).messageId)),
    );
    const fresh = fromClient.filter((m) => !known.has(String(m.id)));
    for (const message of fresh) {
      await event(projectId, 'MARKETPLACE_MESSAGE_RECEIVED', `Client wrote on "${job.title}": ${message.message.slice(0, 240)}`, {
        jobId: job.id,
        messageId: message.id,
      });
      report.messages += 1;
    }
    if (fresh.length === 0) continue;
    const latest = fresh[fresh.length - 1]!;
    const research = job.categories.length === 0 || job.categories.includes('RESEARCH_REPORT');
    if (job.state === 'DELIVERED' && !research && !fresh.every((m) => isAcknowledgement(m.message))) {
      if (job.revisions >= MAX_REVISIONS) continue;
      const versions = (await deliverablesFor(job.id)).filter((d) => d.state === 'DELIVERED');
      const last = versions[versions.length - 1];
      if (!last) continue;
      if (await move(job.id, 'DELIVERED', 'FULFILLING', { revisions: job.revisions + 1, deliverableBinId: null })) {
        const fresher = (await jobByExternalId(projectId, job.externalId))!;
        const opened = await startDeliverableWork(projectId, fresher, { previous: { spec: last.spec, version: last.version } });
        await event(projectId, 'MARKETPLACE_REVISION_STARTED', `Revision ${job.revisions + 1} of "${job.title}" after the client wrote: ${latest.message.slice(0, 200)}`, {
          jobId: job.id,
          opened,
        });
        report.revised.push(job.id);
      }
      continue;
    }
    if (job.state === 'DELIVERED' || !isQuestion(latest.message)) continue;
    // A question before or during the work is answered by the fleet, bounded per job.
    const asked = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM bins WHERE created_by_id LIKE ?`, [`freelancer:reply:${job.id}:%`]);
    if (Number(asked?.n ?? 0) >= LIMITS.repliesPerJob) continue;
    await openReplyBin(job, String(latest.id), await clientMessages(job));
  }
}

/** Send the fleet's answers to client questions, once each. */
async function sendReplies(projectId: string, report: MarketplaceReport): Promise<void> {
  const bins = await getDb().all<{ id: string; created_by_id: string }>(
    `SELECT id, created_by_id FROM bins WHERE project_id = ? AND state = 'COMPLETE' AND created_by_id LIKE 'freelancer:reply:%'`,
    [projectId],
  );
  for (const bin of bins) {
    const jobId = bin.created_by_id.split(':')[2]!;
    const job = (await allJobs(projectId)).find((j) => j.id === jobId);
    if (!job || !ACTIVE.includes(job.state)) continue;
    const text = await replyOf(bin.id);
    if (!text || messageProblems(text).length) continue;
    const sent = await sendMessage({
      projectId,
      jobId: job.id,
      purpose: `reply-${bin.id}`,
      threadId: await thread(job),
      employerId: job.employerExternalId ? Number(job.employerExternalId) : null,
      externalProjectId: Number(job.externalId),
      message: text,
    });
    if (sent.status === 'CONFIRMED') {
      await event(projectId, 'MARKETPLACE_REPLIED', `Answered the client on "${job.title}".`, { jobId: job.id, binId: bin.id });
      report.replied.push(job.id);
    }
  }
}

async function collectPaid(projectId: string, report: MarketplaceReport): Promise<void> {
  for (const job of await jobsInStates(projectId, ['DELIVERED'])) {
    const milestones = await projectMilestones(Number(job.externalId)).catch(() => []);
    const cleared = milestones.find((one) => one.status === 'cleared');
    if (!cleared) continue;
    const mode = await getCashMode(projectId);
    const ledgerCurrency = mode?.currency ?? 'USD';
    let amountCents = Math.round(cleared.amount * 100);
    let note = `Freelancer milestone released for "${job.title}".`;
    if (job.currency !== ledgerCurrency) {
      // Converted at Freelancer's own published rate, read now, and the original kept in the note.
      let rate: number | null = null;
      try {
        rate = Number((await getProject(job.externalId)).currency.exchange_rate) || null;
      } catch {
        rate = null;
      }
      if (ledgerCurrency !== 'USD' || !rate) continue;
      amountCents = Math.round(cleared.amount * rate * 100);
      note += ` ${job.currency} ${cleared.amount} at Freelancer's rate ${rate} USD per ${job.currency}.`;
    }
    const recorded = await recordMoneyEvent({
      projectId,
      opportunityId: null,
      kind: 'CUSTOMER_PAYMENT',
      amountCents,
      currency: ledgerCurrency,
      verifiedReference: `freelancer-milestone:${cleared.transaction_id}`,
      idempotencyKey: `freelancer.paid.${job.id}`,
      actorRef: ACTOR,
      note,
    });
    if (!recorded.ok) {
      await move(job.id, 'DELIVERED', 'DELIVERED', { stateReason: recorded.reason });
      continue;
    }
    if (await move(job.id, 'DELIVERED', 'PAID', { milestoneExternalId: String(cleared.transaction_id), stateReason: null })) {
      await event(projectId, 'MARKETPLACE_PAID', `Paid ${job.currency} ${cleared.amount} for "${job.title}".`, { jobId: job.id, milestone: cleared.transaction_id, ledgerCents: amountCents });
      report.paid.push(job.id);
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
    requalified: 0,
    bid: [],
    awarded: [],
    started: [],
    delivered: [],
    revised: [],
    replied: [],
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
  await sendReplies(projectId, report);
  await startAwarded(projectId, report);
  await deliverFinished(projectId, report);
  await collectPaid(projectId, report);
  await bidOnPrepared(projectId, report);
  return report;
}

export { allJobs };
