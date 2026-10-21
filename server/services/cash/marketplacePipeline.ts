/**
 * Marketplace jobs, read as execution jobs.
 *
 * Production, 2026-10-21: Cash read `JOB_PREPARED=0` while five Freelancer
 * jobs sat PREPARED — each a specific open, fixed-price listing whose request
 * Brain's screen had matched to a deliverable kind it proved it can produce
 * and verify in this process, priced in the listing's currency with a net
 * after Freelancer's fee. Those are the only openings in the project Brain can
 * carry from bid to payment with no person's labour, and the job pipeline did
 * not count one of them, so a person reading Cash saw research and no work.
 *
 * `marketplace_jobs` is the owner of these jobs and keeps its own state
 * machine (`freelancer/operate.ts`). Nothing here writes to it, creates a
 * `cash_opportunities` row or a `cash_jobs` row for it — a second record would
 * be a second master for one fact. This is a derived reading: the stage each
 * job is at, the tasks between it and settled money, and exactly what stops
 * the next one, from the same rows the operation acts on.
 */
import { jobsInStates, type MarketplaceJob } from '../../repos/marketplaceJobs.ts';
import { freelancerConnected, FREELANCER_TOKEN_ENV } from './freelancer/client.ts';
import { freelancerOperationEnabled } from './freelancer/enabled.ts';
import type { JobTask, PipelineStage } from './jobPipeline.ts';

/** States a marketplace job is live work in; the rest are rejections and endings. */
const STAGE_BY_STATE: Readonly<Partial<Record<MarketplaceJob['state'], PipelineStage>>> = Object.freeze({
  PREPARED: 'READY_BLOCKED',
  BID_SENT: 'EXECUTING',
  BID_UNCERTAIN: 'EXECUTING',
  AWARDED: 'AGREED',
  FULFILLING: 'AGREED',
  DELIVERED: 'DELIVERED',
  PAID: 'PAID',
});

export interface MarketplaceJobView {
  jobId: string;
  platform: 'FREELANCER';
  externalId: string;
  url: string;
  title: string;
  state: MarketplaceJob['state'];
  stage: PipelineStage;
  /** What Brain would deliver. */
  categories: string[];
  bid: string | null;
  /** Expected net to us after the platform's fee, in USD, as the screen priced it. */
  netUsd: number | null;
  tasks: JobTask[];
  blockers: string[];
  next: { task: string; because: string } | null;
}

export interface MarketplaceContext {
  connected: { usable: boolean; reason: string };
  /** Per commercial action: whether the live grant covers it, and why not. */
  authority: ReadonlyMap<string, { ok: boolean; reason: string }>;
}

function grant(ctx: MarketplaceContext, action: string): { ok: boolean; because: string } {
  const decision = ctx.authority.get(action);
  return decision?.ok
    ? { ok: true, because: `the standing grant allows ${action}` }
    : { ok: false, because: `the standing commercial grant does not allow ${action}${decision ? `: ${decision.reason}` : ''}` };
}

const AFTER_BID: ReadonlySet<MarketplaceJob['state']> = new Set(['BID_SENT', 'BID_UNCERTAIN', 'AWARDED', 'FULFILLING', 'DELIVERED', 'PAID']);
const AFTER_AWARD: ReadonlySet<MarketplaceJob['state']> = new Set(['AWARDED', 'FULFILLING', 'DELIVERED', 'PAID']);
const AFTER_DELIVERY: ReadonlySet<MarketplaceJob['state']> = new Set(['DELIVERED', 'PAID']);

/** The tasks between this job and settled money, each with its status from rows. Pure. */
export function marketplaceTasks(job: MarketplaceJob, ctx: MarketplaceContext): JobTask[] {
  const connection = ctx.connected.usable
    ? { ok: true, because: `${FREELANCER_TOKEN_ENV} is set` }
    : { ok: false, because: `the Freelancer account is not connected (${FREELANCER_TOKEN_ENV} is not set)` };
  const contact = grant(ctx, 'CONTACT_BUYER');
  const invoice = grant(ctx, 'QUOTE_AND_INVOICE');
  const payment = grant(ctx, 'ACCEPT_PAYMENT');
  const tasks: JobTask[] = [];

  tasks.push({
    key: 'screen',
    action: `Match the request to a deliverable Brain proved it can produce (${job.categories.join(', ') || 'none'})`,
    executor: 'BRAIN_DETERMINISTIC',
    status: 'DONE',
    because: job.screenReasons[0] ?? 'the screen passed it',
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: [],
    artifact: `marketplace job ${job.id}`,
  });

  const bidStatus: JobTask['status'] = AFTER_BID.has(job.state)
    ? 'DONE'
    : !connection.ok
      ? 'BLOCKED_PROVIDER'
      : !contact.ok
        ? 'BLOCKED_AUTHORITY'
        : 'IN_PROGRESS';
  tasks.push({
    key: 'bid',
    action: `Bid ${job.bidAmountCents !== null ? `${job.currency} ${(job.bidAmountCents / 100).toFixed(2)}` : ''} with the prepared proposal`.replace(/\s+/g, ' '),
    executor: 'PROVIDER',
    status: bidStatus,
    because:
      bidStatus === 'DONE'
        ? 'the bid was sent'
        : bidStatus === 'BLOCKED_PROVIDER'
          ? connection.because
          : bidStatus === 'BLOCKED_AUTHORITY'
            ? contact.because
            : 'Brain bids on the next pass, inside the daily bid limit',
    requiresAuthority: 'CONTACT_BUYER',
    requiresCapability: 'FREELANCER_ACCOUNT',
    dependsOn: ['screen'],
    artifact: 'a bid id on Freelancer',
  });

  tasks.push({
    key: 'award',
    action: 'The client awards the job',
    executor: 'BUYER',
    status: AFTER_AWARD.has(job.state) ? 'DONE' : bidStatus === 'DONE' ? 'WAITING_BUYER' : 'BLOCKED_DEPENDENCY',
    because: AFTER_AWARD.has(job.state) ? 'the client awarded it' : bidStatus === 'DONE' ? 'waiting on the client' : 'no bid has been sent yet',
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: ['bid'],
    artifact: 'an award on Freelancer',
  });

  const deliverStatus: JobTask['status'] = AFTER_DELIVERY.has(job.state)
    ? 'DONE'
    : !AFTER_AWARD.has(job.state)
      ? 'BLOCKED_DEPENDENCY'
      : !invoice.ok
        ? 'BLOCKED_AUTHORITY'
        : 'IN_PROGRESS';
  tasks.push({
    key: 'deliver',
    action: 'Produce, verify and attach the deliverable, and request the milestone',
    executor: 'BRAIN_RESEARCH',
    status: deliverStatus,
    because:
      deliverStatus === 'DONE'
        ? 'delivered'
        : deliverStatus === 'BLOCKED_DEPENDENCY'
          ? 'not awarded yet'
          : deliverStatus === 'BLOCKED_AUTHORITY'
            ? invoice.because
            : 'the deliverable bin runs on the fleet',
    requiresAuthority: 'QUOTE_AND_INVOICE',
    requiresCapability: null,
    dependsOn: ['award'],
    artifact: 'verified files and a milestone request',
  });

  tasks.push({
    key: 'collect',
    action: 'Record the released milestone as a customer payment',
    executor: 'PROVIDER',
    status:
      job.state === 'PAID'
        ? 'DONE'
        : !AFTER_DELIVERY.has(job.state)
          ? 'BLOCKED_DEPENDENCY'
          : !payment.ok
            ? 'BLOCKED_AUTHORITY'
            : 'WAITING_BUYER',
    because:
      job.state === 'PAID'
        ? 'the payment is on the ledger'
        : !AFTER_DELIVERY.has(job.state)
          ? 'nothing delivered yet'
          : !payment.ok
            ? payment.because
            : 'waiting on the client to release the milestone',
    requiresAuthority: 'ACCEPT_PAYMENT',
    requiresCapability: null,
    dependsOn: ['deliver'],
    artifact: 'a CUSTOMER_PAYMENT entry referencing the milestone',
  });
  return tasks;
}

export function marketplaceView(job: MarketplaceJob, ctx: MarketplaceContext): MarketplaceJobView | null {
  const stage = STAGE_BY_STATE[job.state];
  if (!stage) return null;
  const tasks = marketplaceTasks(job, ctx);
  const blockers = tasks
    .filter((t) => t.status === 'BLOCKED_AUTHORITY' || t.status === 'BLOCKED_PROVIDER')
    .map((t) => t.because);
  const first = tasks.find((t) => t.status !== 'DONE') ?? null;
  const net = job.economics?.['netUsd'];
  return {
    jobId: job.id,
    platform: 'FREELANCER',
    externalId: job.externalId,
    url: job.url,
    title: job.title,
    state: job.state,
    // A prepared job with nothing blocking it is bid on this pass: executing.
    stage: stage === 'READY_BLOCKED' && blockers.length === 0 ? 'EXECUTING' : stage,
    categories: job.categories,
    bid: job.bidAmountCents !== null ? `${job.currency} ${(job.bidAmountCents / 100).toFixed(2)}` : null,
    netUsd: typeof net === 'number' ? net : null,
    tasks,
    blockers,
    next: first ? { task: first.action, because: first.because } : null,
  };
}

/** Every live marketplace job in a project, as an execution job. */
export async function marketplaceJobViews(
  projectId: string,
  authority: ReadonlyMap<string, { ok: boolean; reason: string }>,
): Promise<MarketplaceJobView[]> {
  // A switched-off operation has no jobs to pursue: its rows are history, and
  // counting a PREPARED bid as an execution job would ask for the very
  // connection the owner refused.
  if (!freelancerOperationEnabled()) return [];
  const ctx: MarketplaceContext = { connected: freelancerConnected(), authority };
  const out: MarketplaceJobView[] = [];
  const live = Object.keys(STAGE_BY_STATE) as MarketplaceJob['state'][];
  for (const job of await jobsInStates(projectId, live)) {
    const view = marketplaceView(job, ctx);
    if (view) out.push(view);
  }
  return out;
}
