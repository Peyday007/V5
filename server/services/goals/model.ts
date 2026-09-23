/**
 * A goal, as Brain can read it right now.
 *
 * The question this module exists to answer is the one a person asks after
 * walking away and coming back: **what happened, what is happening now, what
 * happens next, and what needs me?** Brain already records every part of that —
 * campaigns, missions, packets, bins, requests, documents — and before this
 * module a person had to read six surfaces and join them by hand.
 *
 * Every field below is derived from rows on this read and stored nowhere, with
 * two exceptions that are a person's words rather than Brain's verdicts (the
 * goal's terms, and its pause/cancel decisions). That is §43's rule carried one
 * level up: a stored "waiting on X" is stale the moment X arrives, and a page
 * that then contradicts the control beside it teaches a person to stop reading
 * it.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to do
 * ---------------------------------------------------------------------------
 *
 *   * **No percentage.** A goal's progress is what its rows say, in words, with
 *     the rows named — never a bar over a denominator nobody declared.
 *   * **No invented next action.** Where nothing can be read, the answer says
 *     so; a reassuring sentence that cannot become wrong is not an instruction.
 *   * **No completion by assertion.** A goal is complete when every piece of
 *     work it pursues says it delivered, never because somebody said "done".
 *   * **No decision that is not a person's.** Needs You holds only what needs a
 *     person's authority, judgement, access or resources, and each carries the
 *     answers available, what each causes, what waits on it, and what Brain
 *     does afterwards. §33 records what a card asking a person to attest to
 *     Brain's own work costs.
 *   * **No private work across accounts.** Scope is decided by the caller's
 *     project access before this runs, a dependency on a goal the caller cannot
 *     read is reported as unreadable rather than described, and priority is
 *     ranked within an owner *and* a project so no rank can reveal how much
 *     work sits somewhere a reader cannot see.
 */
import type { Bin } from '../../domain/types.ts';
import type { LinkKind, Workstream, WorkstreamLink } from '../../domain/register.ts';
import { PURPOSE_LABELS } from '../../domain/register.ts';
import {
  COMMITMENT_LABELS,
  binPriorityForRank,
  type GoalLifecycle,
  type NextActor,
  type PriorityCriterion,
  type WaitingKind,
} from '../../domain/goals.ts';
import { listAllLiveLinks, listWorkstreams } from '../../repos/register.ts';
import { binsFor, latestSnapshots } from '../../repos/goals.ts';
import { getMission, latestMissionForCandidate, openRequestFor, getHumanRequest } from '../../repos/russellMissions.ts';
import { getCampaign, getCampaignByChangeRequest, getChangeRequest } from '../../repos/factory.ts';
import { getProject } from '../../repos/projects.ts';
import { getUser } from '../../repos/identity.ts';
import { liveAuthority, listCommitments } from '../../repos/cashAuthority.ts';
import { authorityFor } from '../russell/authority.ts';
import { personName } from '../../domain/personName.ts';
import { viewOf, type WorkstreamView } from '../register/view.ts';
import type { LinkReading } from '../register/resolve.ts';
import { rankGoals, type PriorityFacts } from './priority.ts';
import { listDispatchesForBin } from '../../repos/bins.ts';
import { REFUSAL_WAIT, type RoutingRefusal } from '../dispatch/router.ts';
import { listRoutines } from '../../repos/fleet.ts';
import { listMembershipsForProject } from '../../repos/identity.ts';

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export interface GoalWork {
  binId: string;
  /**
   * What the dispatcher last decided about firing this bin, read from its own
   * intent row. Null when there is no intent at the bin's generation. A goal
   * that said "queued" over a bin the dispatcher has been refusing for hours
   * would be the reassuring pending state §24 corrects — production had one.
   */
  dispatch: { state: string; refusal: string | null; waitsFor: 'CAPACITY' | 'OPERATOR' | null; message: string | null; at: string } | null;
  state: string;
  priority: number;
  attempts: string;
  heldReason: string | null;
  /** Set when a worker holds a lease that has not yet expired. */
  workerOnIt: boolean;
  exhausted: boolean;
  updatedAt: string;
}

export interface GoalBlocker {
  text: string;
  /** What would clear it, in words a person can act on. */
  remedy: string;
  /** Who clears it. */
  by: NextActor;
  ref: string;
  since: string | null;
  ageHours: number | null;
}

export interface GoalDecision {
  id: string;
  kind: 'HUMAN_REQUEST' | 'CHANGE_REQUEST' | 'RELEASE' | 'PULL_REQUEST';
  ref: string;
  question: string;
  /** What Brain recommends, when it has a recommendation. */
  proposedAction: string;
  choices: { key: string | null; label: string; consequence: string }[];
  /** What is standing still until this is answered. */
  waitingWork: string[];
  /** What Brain does, by itself, once it is answered. */
  afterAnswer: string;
  since: string | null;
}

export interface GoalEvidence {
  kind: LinkKind | 'BIN';
  ref: string;
  what: string;
  evidence: string;
}

export interface GoalDependency {
  goalId: string;
  /** Null when the caller may not read that goal: it is not described. */
  title: string | null;
  lifecycle: GoalLifecycle | null;
  met: boolean | null;
}

export interface GoalPriority {
  ownerKey: string;
  rank: number;
  /** The bin priority this rank maps to, so a reader can check the allocation. */
  binPriority: number | null;
  aboveNext: { criterion: PriorityCriterion; reason: string } | null;
  belowPrevious: { criterion: PriorityCriterion; reason: string } | null;
  /** The last recorded move, from the append-only history. */
  lastMove: { from: number | null; to: number; reason: string; at: string } | null;
}

export interface GoalView {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  /** What it is for, in the words of whoever set it. */
  intent: string;
  /** What counts as finished, or null when nobody said. */
  outcome: string | null;
  purpose: Workstream['purpose'];
  purposeLabel: string;
  owner: { userId: string; name: string } | null;
  dueAt: string | null;
  overdue: boolean;
  commitment: Workstream['commitment'];
  commitmentLabel: string;

  lifecycle: GoalLifecycle;
  lifecycleReason: string;

  /** The register's derived state and the reading that decided it. */
  state: WorkstreamView['state'];
  stateEvidence: string;

  authority: { research: string; commercial: string | null };

  linked: LinkReading[];
  sources: LinkReading[];
  work: GoalWork[];
  dependencies: GoalDependency[];
  /** Goals that wait on this one, among those the caller may read. */
  dependents: string[];

  waiting: { kind: WaitingKind; detail: string; since: string | null };
  next: { action: string; by: NextActor; afterwards: string | null };

  blockers: GoalBlocker[];
  decisions: GoalDecision[];
  evidence: GoalEvidence[];
  /** Cash still held against this goal's opportunities, or an open obligation. */
  obligations: string[];

  priority: GoalPriority | null;
  pausedAt: string | null;
  pausedReason: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const DELIVERED = new Set(['DONE', 'VERIFIED_LIVE', 'DEPLOYED', 'MERGED']);
const HOUR = 3_600_000;

function ageHours(since: string | null | undefined, now: string): number | null {
  if (!since) return null;
  const ms = Date.parse(now) - Date.parse(since);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / HOUR)) : null;
}

/** Owner and project together, so no rank ever describes a project a reader cannot see. */
export function ownerKeyOf(goal: Workstream): string {
  const who = goal.ownerUserId ?? goal.createdByUserId ?? 'nobody';
  return `${goal.projectId ?? 'brain'}:${who}`;
}

/** Whether a goal's decisions say it is not being pursued right now. */
function decidedLifecycle(goal: Workstream): { lifecycle: GoalLifecycle; reason: string } | null {
  if (goal.archivedAt) return { lifecycle: 'ARCHIVED', reason: `archived: ${goal.archivedReason ?? ''}`.trim() };
  if (goal.cancelledAt) return { lifecycle: 'CANCELLED', reason: `cancelled: ${goal.cancelledReason ?? ''}`.trim() };
  if (goal.pausedAt) return { lifecycle: 'PAUSED', reason: `paused: ${goal.pausedReason ?? ''}`.trim() };
  return null;
}

/**
 * Complete when there is something it pursues and every piece of it says it
 * delivered. One finished mission beside a running campaign is not a finished
 * goal, which is exactly the case the register's "furthest reading wins" would
 * otherwise call done.
 */
function completion(view: WorkstreamView, links: WorkstreamLink[]): boolean {
  const pursued = view.readings.filter((reading) => {
    const link = links.find((one) => one.id === reading.linkId);
    return link?.relation === 'PURSUES' && reading.state !== null;
  });
  if (pursued.length === 0) {
    // Nothing is pursued, but something linked as evidence delivered.
    return view.readings.some((reading) => {
      const link = links.find((one) => one.id === reading.linkId);
      return link?.relation === 'EVIDENCE' && reading.state !== null && DELIVERED.has(reading.state);
    });
  }
  // A campaign reads PR_READY for ever — its row has no way to learn about the
  // merge. What learns is the attested PULL_REQUEST link the factory's
  // writeback writes from the forge's own answer, so a pursued PR_READY
  // reading is delivered once such a link says merged.
  const mergeAttested = attestedMerge(view.readings);
  return pursued.every(
    (reading) =>
      reading.state !== null && (DELIVERED.has(reading.state) || (reading.state === 'PR_READY' && mergeAttested)),
  );
}

/** Whether a linked pull request is attested merged (or further). */
function attestedMerge(readings: LinkReading[]): boolean {
  return readings.some(
    (reading) => reading.kind === 'PULL_REQUEST' && reading.attested !== undefined && reading.state !== null && DELIVERED.has(reading.state),
  );
}

interface Resolved {
  bins: Bin[];
  decisions: GoalDecision[];
  evidence: GoalEvidence[];
  obligations: string[];
}

/**
 * Follow a goal's links to the bins, requests and evidence behind them.
 *
 * Each hop is a column Brain wrote: a mission's own `bin_id` and
 * `orchestration_id`, a candidate's latest mission, a change request's
 * campaign. Nothing is found by matching a title.
 */
async function resolveWork(
  links: WorkstreamLink[],
  projectId: string | null,
  merged: boolean,
): Promise<Resolved> {
  const campaignIds = new Set<string>();
  const orchestrationIds = new Set<string>();
  const binIds = new Set<string>();
  const decisions: GoalDecision[] = [];
  const evidence: GoalEvidence[] = [];
  const obligations: string[] = [];
  const seenRequests = new Set<string>();

  const missionIds = new Set<string>();
  for (const link of links) {
    if (link.relation === 'SOURCE' || link.relation === 'DEPENDS_ON') continue;
    switch (link.kind) {
      case 'CAMPAIGN':
        campaignIds.add(link.ref);
        break;
      case 'PACKET':
        orchestrationIds.add(link.ref);
        break;
      case 'MISSION':
        missionIds.add(link.ref);
        break;
      case 'CANDIDATE': {
        const mission = await latestMissionForCandidate(link.ref);
        if (mission) missionIds.add(mission.id);
        break;
      }
      case 'CHANGE_REQUEST': {
        const request = await getChangeRequest(link.ref);
        const campaign = await getCampaignByChangeRequest(link.ref);
        if (campaign) campaignIds.add(campaign.id);
        if (request && request.state === 'DRAFT') {
          decisions.push({
            id: `cr:${request.id}`,
            kind: 'CHANGE_REQUEST',
            ref: request.id,
            question: `Approve this change to ${request.repository}: ${request.objective}`,
            proposedAction: 'Approve it on Build, so the factory can start.',
            choices: [
              {
                key: null,
                label: 'Approve',
                consequence:
                  'The factory starts a campaign inside the approved scope; it plans, implements, reviews independently and stops at a pull request you merge.',
              },
              {
                key: null,
                label: 'Withdraw',
                consequence:
                  'Nothing is built. The request keeps its row and its history, and this goal loses that path.',
              },
            ],
            waitingWork: ['every stage of the software change'],
            afterAnswer:
              'On approval the factory tick plans the change within the next pass; nobody has to press a stage button.',
            since: request.createdAt ?? null,
          });
        }
        break;
      }
      case 'HUMAN_REQUEST': {
        const request = await getHumanRequest(link.ref);
        if (request && request.state === 'OPEN' && request.visibility === 'SHARED' && !seenRequests.has(request.id)) {
          seenRequests.add(request.id);
          decisions.push(humanDecision(request, ['the work this goal links to it']));
        }
        break;
      }
      case 'OPPORTUNITY':
        break;
      default:
        break;
    }
  }

  for (const missionId of missionIds) {
    const mission = await getMission(missionId);
    if (!mission) continue;
    if (mission.binId) binIds.add(mission.binId);
    if (mission.orchestrationId) orchestrationIds.add(mission.orchestrationId);
    if (mission.documentId) {
      evidence.push({
        kind: 'DOCUMENT',
        ref: mission.documentId,
        what: `a report filed by mission ${mission.id}`,
        evidence: `russell_missions.document_id${mission.auditId ? `, audited as ${mission.auditId}` : ''}`,
      });
    }
    const request = await openRequestFor(mission.id);
    // A PRIVATE request belongs to one person's thread and stays in their own
    // Needs You; a goal is read by everybody on its project.
    if (request && request.visibility === 'SHARED' && !seenRequests.has(request.id)) {
      seenRequests.add(request.id);
      decisions.push(humanDecision(request, [`mission ${mission.id}: ${clip(mission.objective)}`]));
    }
  }

  for (const campaignId of campaignIds) {
    const campaign = await getCampaign(campaignId);
    if (!campaign) continue;
    if (campaign.state === 'AWAITING_RELEASE') {
      decisions.push({
        id: `release:${campaign.id}`,
        kind: 'RELEASE',
        ref: campaign.id,
        question: `Release campaign ${campaign.id}? Its integrated commit ${campaign.integrationSha ?? '(none recorded)'} passed review.`,
        proposedAction: 'Read what is being let out on Build, then release it or refuse with a reason.',
        choices: [
          { key: null, label: 'Release', consequence: 'The campaign completes and its artifact is let out under its deployment policy.' },
          { key: null, label: 'Refuse', consequence: 'Nothing is released; the refusal and its reason stay on the campaign.' },
        ],
        waitingWork: [`campaign ${campaign.id}`],
        afterAnswer: 'The factory tick records the answer and finishes or stops the campaign by itself.',
        since: campaign.updatedAt,
      });
    }
    // Asking a person to merge what the forge already says merged would be a
    // decision that is not theirs any more — the stale-card defect §33 records.
    if (campaign.state === 'COMPLETE' && campaign.prUrl && !merged) {
      decisions.push({
        id: `pr:${campaign.id}`,
        kind: 'PULL_REQUEST',
        ref: campaign.prUrl,
        question: `Merge the pull request campaign ${campaign.id} opened?`,
        proposedAction: `Read and merge ${campaign.prUrl}. Brain cannot merge — that boundary is yours (§27).`,
        choices: [
          { key: null, label: 'Merge on the forge', consequence: 'The change lands; Brain observes the merge and records it against this goal.' },
          { key: null, label: 'Close it', consequence: 'Nothing lands; the campaign, its commits and its review stay as they are.' },
        ],
        waitingWork: ['the goal reaching delivered'],
        afterAnswer: 'Brain attests the merge onto this goal when it observes it, and the goal moves on without a new prompt.',
        since: campaign.finishedAt ?? campaign.updatedAt,
      });
    }
    if (campaign.state === 'COMPLETE' && campaign.prUrl) {
      evidence.push({
        kind: 'CAMPAIGN',
        ref: campaign.id,
        what: `a reviewed pull request at ${campaign.prUrl}${merged ? ', attested merged' : ''}`,
        evidence: `factory_campaigns.pr_url, integration ${campaign.integrationSha ?? 'unrecorded'}`,
      });
    }
  }

  const bins = await binsFor({
    campaignIds: [...campaignIds],
    orchestrationIds: [...orchestrationIds],
    binIds: [...binIds],
  });

  // A goal's outside obligations are the commitments held against its
  // opportunities. Read, never released: cancelling a goal ends Brain's
  // pursuit of it, not money somebody committed (§30, invariant 40).
  const opportunityIds = links.filter((one) => one.kind === 'OPPORTUNITY').map((one) => one.ref);
  if (opportunityIds.length && projectId) {
    for (const commitment of await listCommitments(projectId)) {
      if (commitment.state === 'HELD' && commitment.opportunityId && opportunityIds.includes(commitment.opportunityId)) {
        obligations.push(
          `${(commitment.amountCents / 100).toFixed(2)} ${commitment.currency} held for ${commitment.purpose} (${commitment.id})`,
        );
      }
    }
  }
  return { bins, decisions, evidence, obligations };
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function humanDecision(
  request: NonNullable<Awaited<ReturnType<typeof getHumanRequest>>>,
  waitingWork: string[],
): GoalDecision {
  const recommended = request.recommendation
    ? request.choices.find((one) => one.key === request.recommendation)?.label ?? request.recommendation
    : null;
  return {
    id: `rhr:${request.id}`,
    kind: 'HUMAN_REQUEST',
    ref: request.id,
    question: request.authorityNeeded,
    proposedAction: recommended
      ? `Brain recommends: ${recommended}. Answer it in Needs You.`
      : 'Brain has no recommendation recorded for this one; each answer and what it causes is below. Answer it in Needs You.',
    choices: request.choices.map((one) => ({ key: one.key, label: one.label, consequence: one.consequence })),
    waitingWork,
    afterAnswer:
      'Brain carries out the chosen answer on its next tick and this goal continues from where it stopped; nothing needs to be asked again.',
    since: request.createdAt,
  };
}

/**
 * Why no surface serves a project, named down to the surfaces that would.
 *
 * `NO_SURFACE_SERVES_THIS_PROJECT` is true and too coarse: it sends a reader to
 * grant a membership when, in production, the membership existed and every
 * Routine bound to that worker had been quarantined for sessions that never
 * checked in — a connector that stopped authorizing, whose remedy is in the
 * Claude account behind it. Routine names and states only, never a trigger ref
 * or a secret's name: those are operator depth (§34).
 */
async function surfaceRemedy(
  projectId: string,
): Promise<{ diagnosis: string | null; remedy: string; since: string | null }> {
  const workers = new Set(
    (await listMembershipsForProject(projectId))
      .filter((one) => one.principalType === 'WORKER' && one.active)
      .map((one) => one.principalId),
  );
  const serving = (await listRoutines()).filter((one) => one.workerId !== null && workers.has(one.workerId));
  if (serving.length === 0) {
    return {
      diagnosis: null,
      remedy:
        'No Routine is bound to any worker that is a member of this project. An operator binds one (npm run fleet -- bind-worker) or grants an existing worker the project (npm run admin -- access grant); the bin fires on the next tick after that.',
      since: null,
    };
  }
  const down = serving.filter((one) => one.state !== 'ENABLED');
  const reasons = new Map<string, string[]>();
  for (const routine of down) {
    const why = `${routine.state}${routine.stateReason ? `: ${routine.stateReason.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
    const list = reasons.get(why);
    if (list) list.push(routine.name);
    else reasons.set(why, [routine.name]);
  }
  const listed = [...reasons.entries()].map(([why, names]) => `${names.join(', ')} (${why})`).join('; ');
  if (down.length < serving.length) {
    return {
      diagnosis: null,
      remedy:
        'At least one Routine serving this project is enabled, so the dispatcher will route to it as capacity frees; if it does not, read the bin trace (Dispatch diagnose).',
      since: null,
    };
  }
  /*
   * The dispatcher's own sentence for this refusal is about a missing
   * membership, and here the membership exists: printing it beside a remedy
   * about a quarantine would be two readings of one bin that disagree. And the
   * dispatch intent is re-stamped every tick, so its timestamp makes a
   * condition hours old read as minutes old; when the last serving surface
   * went out of routing is the honest age, and a quarantined Routine is not
   * fired, so its row is not touched again after that.
   */
  const since = down.map((one) => one.updatedAt).sort().at(-1) ?? null;
  const remedy = `Every Routine that serves this project is out of routing — ${listed}. When the reason is sessions that never checked in, the Brain connector in the Claude account behind those Routines has stopped authorizing: reconnect it there, then lift the quarantine (npm run fleet -- set-state --kind routine --to ENABLED). The bin fires on the next tick after that, with nothing else to press.`;
  return {
    diagnosis: `no enabled Routine serves this project — ${serving.length} would, and every one is out of routing`,
    remedy,
    since,
  };
}

async function dispatchOf(bin: Bin): Promise<GoalWork['dispatch']> {
  if (bin.state !== 'READY' && bin.state !== 'LEASED') return null;
  const intents = (await listDispatchesForBin(bin.id)).filter((one) => one.leaseGeneration === bin.leaseGeneration);
  const intent = intents[intents.length - 1];
  if (!intent) return null;
  const kind = intent.lastErrorKind;
  const refusal = kind && kind in REFUSAL_WAIT ? (kind as RoutingRefusal) : null;
  return {
    state: intent.state,
    refusal: kind,
    waitsFor: refusal ? REFUSAL_WAIT[refusal] : null,
    message: intent.lastError,
    at: intent.updatedAt,
  };
}

async function workOf(bins: Bin[], now: string): Promise<GoalWork[]> {
  const live = bins.filter(
    (bin) => bin.state === 'DRAFT' || bin.state === 'READY' || bin.state === 'LEASED' || bin.state === 'NEEDS_HUMAN',
  );
  const dispatches = new Map<string, GoalWork['dispatch']>();
  for (const bin of live) dispatches.set(bin.id, bin.heldByWorkstreamId ? null : await dispatchOf(bin));
  return live
    .map((bin) => ({
      binId: bin.id,
      dispatch: dispatches.get(bin.id) ?? null,
      state: bin.state,
      priority: bin.priority,
      attempts: `${bin.attemptCount}/${bin.maxAttempts}`,
      heldReason: bin.heldReason ?? null,
      workerOnIt: bin.state === 'LEASED' && bin.leaseExpiresAt !== null && bin.leaseExpiresAt > now,
      exhausted: bin.attemptCount >= bin.maxAttempts,
      updatedAt: bin.updatedAt,
    }));
}

function remedyFor(reading: LinkReading): { remedy: string; by: NextActor } {
  switch (reading.kind) {
    case 'MISSION':
    case 'PACKET':
      return reading.status.includes('NEEDS_HUMAN')
        ? { remedy: 'Answer the decision it stopped at in Needs You.', by: 'PERSON' }
        : { remedy: 'Read the packet report; re-plan it or record why it stopped.', by: 'OPERATOR' };
    case 'CAMPAIGN':
      return {
        remedy: 'The campaign names the operational fact that stopped it; the factory re-examines it every tick and resumes once it no longer holds.',
        by: 'OPERATOR',
      };
    case 'CANDIDATE':
      return { remedy: 'The idea is parked for the reason shown; answering that reason lets Brain launch it again.', by: 'PERSON' };
    default:
      return { remedy: 'Read the linked row.', by: 'OPERATOR' };
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface GoalsSnapshot {
  goals: GoalView[];
  /** Every goal's priority facts, so the tick and the view rank the same set. */
  facts: PriorityFacts[];
  /** Live bins per goal id, for the tick. Never sent to a client. */
  binsByGoal: Map<string, Bin[]>;
  generatedAt: string;
}

/**
 * Read every goal the caller may read — or, with `projectIds: null`, every
 * goal in the Brain, which only the durable tick asks for.
 *
 * Ranking is computed over the **whole** Brain and then shown for the goals a
 * caller may read. Because the owner key includes the project, the ranks a
 * reader sees depend only on goals in projects they can already read: the
 * whole-Brain computation and a scoped one give the same numbers, which is
 * what lets the tick and the page agree without either trusting the other.
 */
export async function assembleGoals(options: {
  projectIds: string[] | null;
  includeArchived?: boolean;
  /**
   * With `includeArchived`, derive only this archived goal rather than all of
   * them. An archived goal holds nothing and ranks nowhere, and the hosted
   * verification archives two more on each side of every deploy, so deriving
   * every one of them to show one is a cost that grows for ever.
   */
  onlyArchivedGoal?: string;
  now?: string;
}): Promise<GoalsSnapshot> {
  const now = options.now ?? new Date().toISOString();
  const all = await listWorkstreams({ projectIds: null, includeArchived: true });
  const visible = new Set(
    (options.projectIds === null
      ? all
      : all.filter((one) => one.projectId === null || options.projectIds!.includes(one.projectId))
    ).map((one) => one.id),
  );

  const links = await listAllLiveLinks(all.map((one) => one.id));
  const linksBy = new Map<string, WorkstreamLink[]>();
  for (const link of links) {
    const list = linksBy.get(link.workstreamId);
    if (list) list.push(link);
    else linksBy.set(link.workstreamId, [link]);
  }

  // First pass: what every goal's rows say, over the whole Brain, because a
  // dependency's lifecycle and a priority rank are both facts about goals the
  // caller may not be able to read.
  const base = new Map<
    string,
    { goal: Workstream; view: WorkstreamView | null; lifecycle: GoalLifecycle; reason: string; resolved: Resolved }
  >();
  for (const goal of all) {
    const own = linksBy.get(goal.id) ?? [];
    const decided = decidedLifecycle(goal);
    /*
     * An archived goal nobody asked to see is present — a dependency's
     * lifecycle and a hold's owner are read from it — and derived no further.
     * Its linked work costs statements on every tick, and archived goals are
     * the one kind this table gains without bound (tests/goalTickCost.test.ts).
     */
    const shown =
      options.includeArchived && (options.onlyArchivedGoal === undefined || options.onlyArchivedGoal === goal.id);
    if (decided?.lifecycle === 'ARCHIVED' && !shown) {
      base.set(goal.id, {
        goal,
        view: null,
        lifecycle: 'ARCHIVED',
        reason: decided.reason,
        resolved: { bins: [], decisions: [], evidence: [], obligations: [] },
      });
      continue;
    }
    const view = await viewOf(goal, own);
    const complete = completion(view, own);
    const lifecycle: GoalLifecycle = decided?.lifecycle ?? (complete ? 'COMPLETE' : 'ACTIVE');
    const reason =
      decided?.reason ??
      (complete ? `every piece of work it pursues has delivered (${view.stateEvidence})` : 'being pursued');
    const resolved = await resolveWork(own, goal.projectId, attestedMerge(view.readings));
    base.set(goal.id, { goal, view, lifecycle, reason, resolved });
  }

  const dependsOn = (id: string) =>
    (linksBy.get(id) ?? []).filter((one) => one.kind === 'WORKSTREAM' && one.relation === 'DEPENDS_ON');

  const facts: PriorityFacts[] = [];
  for (const { goal, lifecycle, resolved } of base.values()) {
    if (lifecycle === 'ARCHIVED') continue;
    // Stopped at a person's decision with nothing else it can run: capacity
    // given to it would be capacity nothing can use, so it is not workable.
    const runnable = resolved.bins.some(
      (bin) => (bin.state === 'READY' || bin.state === 'LEASED') && bin.heldByWorkstreamId === null,
    );
    const waitsOnPerson = resolved.decisions.length > 0 && !runnable;
    const unmet = dependsOn(goal.id).some((one) => base.get(one.ref)?.lifecycle !== 'COMPLETE');
    const dependents = [...base.values()].filter(
      (other) =>
        other.lifecycle === 'ACTIVE' && dependsOn(other.goal.id).some((one) => one.ref === goal.id),
    ).length;
    facts.push({
      id: goal.id,
      ownerKey: ownerKeyOf(goal),
      workable: lifecycle === 'ACTIVE' && !unmet && !waitsOnPerson,
      commitment: goal.commitment,
      dueAt: goal.dueAt,
      purpose: goal.purpose,
      dependents,
      createdAt: goal.createdAt,
    });
  }
  const ranked = new Map(rankGoals(facts).map((one) => [one.id, one]));
  const snapshots = await latestSnapshots([...ranked.keys()]);

  const projectNames = new Map<string, string | null>();
  const authorityByProject = new Map<string, { research: string; commercial: string | null }>();
  const ownerNames = new Map<string, string | null>();

  const goals: GoalView[] = [];
  const binsByGoal = new Map<string, Bin[]>();
  for (const { goal, view, lifecycle, reason, resolved } of base.values()) {
    const own = linksBy.get(goal.id) ?? [];
    binsByGoal.set(goal.id, resolved.bins);
    if (!visible.has(goal.id)) continue;
    if (lifecycle === 'ARCHIVED' && !options.includeArchived) continue;
    if (!view) continue;

    let projectName: string | null = null;
    let authority = { research: 'This goal is Brain-wide; it runs under no project grant.', commercial: null as string | null };
    if (goal.projectId) {
      if (!projectNames.has(goal.projectId)) {
        projectNames.set(goal.projectId, (await getProject(goal.projectId))?.name ?? null);
      }
      projectName = projectNames.get(goal.projectId) ?? null;
      if (!authorityByProject.has(goal.projectId)) {
        const research = await authorityFor({ projectId: goal.projectId, now });
        const cash = await liveAuthority(goal.projectId, now);
        authorityByProject.set(goal.projectId, {
          research: research.headline,
          commercial: cash
            ? `A commercial grant is live${cash.expiresAt ? ` until ${cash.expiresAt.slice(0, 10)}` : ''}; every spend is still checked against it.`
            : 'No commercial grant: Brain may research here but may not spend, contact or publish.',
        });
      }
      authority = authorityByProject.get(goal.projectId)!;
    }

    const ownerId = goal.ownerUserId ?? goal.createdByUserId;
    let owner: GoalView['owner'] = null;
    if (ownerId) {
      if (!ownerNames.has(ownerId)) {
        const user = await getUser(ownerId);
        ownerNames.set(ownerId, user ? personName(user) : null);
      }
      const name = ownerNames.get(ownerId);
      if (name) owner = { userId: ownerId, name };
    }

    const dependencies: GoalDependency[] = dependsOn(goal.id).map((link) => {
      const target = base.get(link.ref);
      if (!target || !visible.has(link.ref)) {
        return { goalId: link.ref, title: null, lifecycle: null, met: null };
      }
      return {
        goalId: link.ref,
        title: target.goal.title,
        lifecycle: target.lifecycle,
        met: target.lifecycle === 'COMPLETE',
      };
    });
    const dependents = [...base.values()]
      .filter((other) => visible.has(other.goal.id) && dependsOn(other.goal.id).some((one) => one.ref === goal.id))
      .map((other) => other.goal.id);

    const work = await workOf(resolved.bins, now);
    const blockers: GoalBlocker[] = [];
    for (const reading of view.readings) {
      if (reading.missing) {
        blockers.push({
          text: `The linked ${reading.kind.toLowerCase()} ${reading.ref} is gone.`,
          remedy: 'Correct the link, or record why the work went.',
          by: 'PERSON',
          ref: reading.ref,
          since: null,
          ageHours: null,
        });
        continue;
      }
      if (!reading.blocker) continue;
      const { remedy, by } = remedyFor(reading);
      blockers.push({
        text: `${reading.kind.toLowerCase()} ${reading.ref}: ${reading.blocker}`,
        remedy,
        by,
        ref: reading.ref,
        since: reading.since ?? null,
        ageHours: ageHours(reading.since, now),
      });
    }
    for (const bin of work) {
      if (bin.dispatch && bin.dispatch.state === 'PENDING' && bin.dispatch.waitsFor === 'OPERATOR' && !bin.workerOnIt) {
        const surface =
          bin.dispatch.refusal === 'NO_SURFACE_SERVES_THIS_PROJECT' && goal.projectId
            ? await surfaceRemedy(goal.projectId)
            : null;
        const since = surface?.since ?? bin.dispatch.at;
        blockers.push({
          text: surface?.diagnosis
            ? `bin ${bin.binId} cannot be fired: ${surface.diagnosis}`
            : `bin ${bin.binId} cannot be fired: ${bin.dispatch.refusal} — ${bin.dispatch.message ?? 'no message recorded'}`,
          remedy:
            surface?.remedy ??
            'Brain defers it and re-checks on every fleet change; an operator makes it routable (the refusal above names how), and it fires on the next tick after that with nothing to press.',
          by: 'OPERATOR',
          ref: bin.binId,
          since,
          ageHours: ageHours(since, now),
        });
      }
      if (bin.dispatch && bin.dispatch.state === 'ABANDONED') {
        blockers.push({
          text: `bin ${bin.binId}: the dispatcher gave up firing it — ${bin.dispatch.message ?? 'no message recorded'}`,
          remedy: 'Read the bin trace (Dispatch diagnose); an abandoned intent is a surface problem a person must fix.',
          by: 'OPERATOR',
          ref: bin.binId,
          since: bin.dispatch.at,
          ageHours: ageHours(bin.dispatch.at, now),
        });
      }
      if (bin.exhausted && (bin.state === 'READY' || bin.state === 'LEASED')) {
        blockers.push({
          text: `bin ${bin.binId} has spent all ${bin.attempts} of its attempts with work still in it.`,
          remedy: `An operator raises its ceiling: npm run step10 -- regrant ${bin.binId} --reason budget-too-small. Nothing is lost meanwhile.`,
          by: 'OPERATOR',
          ref: bin.binId,
          since: bin.updatedAt,
          ageHours: ageHours(bin.updatedAt, now),
        });
      }
    }

    const evidence: GoalEvidence[] = [...resolved.evidence];
    for (const reading of view.readings) {
      if (reading.state !== null && DELIVERED.has(reading.state)) {
        evidence.push({ kind: reading.kind, ref: reading.ref, what: reading.status, evidence: reading.evidence });
      }
    }

    const unmet = dependencies.filter((one) => one.met !== true);
    const waitingNext = waitingAndNext({
      goal,
      lifecycle,
      view,
      work,
      unmet,
      decisions: resolved.decisions,
      blockers,
      obligations: resolved.obligations,
      hasLinks: own.some((one) => one.relation === 'PURSUES' || one.relation === 'EVIDENCE'),
      evidence,
    });

    const rank = ranked.get(goal.id);
    const snapshot = snapshots.get(goal.id);
    goals.push({
      id: goal.id,
      title: goal.title,
      projectId: goal.projectId,
      projectName,
      intent: goal.intent,
      outcome: goal.outcome,
      purpose: goal.purpose,
      purposeLabel: PURPOSE_LABELS[goal.purpose],
      owner,
      dueAt: goal.dueAt,
      overdue: goal.dueAt !== null && goal.dueAt < now && lifecycle !== 'COMPLETE',
      commitment: goal.commitment,
      commitmentLabel: COMMITMENT_LABELS[goal.commitment],
      lifecycle,
      lifecycleReason: reason,
      state: view.state,
      stateEvidence: view.stateEvidence,
      authority,
      linked: view.readings.filter((one) => !view.sources.includes(one)),
      sources: view.sources,
      work,
      dependencies,
      dependents,
      waiting: waitingNext.waiting,
      next: waitingNext.next,
      blockers,
      decisions: resolved.decisions,
      evidence,
      obligations: resolved.obligations,
      priority: rank
        ? {
            ownerKey: rank.ownerKey,
            rank: rank.rank,
            binPriority: lifecycle === 'ACTIVE' ? binPriorityForRank(rank.rank) : null,
            aboveNext: rank.aboveNext,
            belowPrevious: rank.belowPrevious,
            lastMove: snapshot
              ? { from: snapshot.previousRank, to: snapshot.rank, reason: snapshot.reason, at: snapshot.createdAt }
              : null,
          }
        : null,
      pausedAt: goal.pausedAt,
      pausedReason: goal.pausedReason,
      cancelledAt: goal.cancelledAt,
      cancelledReason: goal.cancelledReason,
      archivedAt: goal.archivedAt,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    });
  }

  goals.sort((a, b) => {
    const ap = a.priority ? a.priority.rank : 99;
    const bp = b.priority ? b.priority.rank : 99;
    return ap - bp || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  });
  return { goals, facts, binsByGoal, generatedAt: now };
}

/**
 * What a goal is waiting for and what happens next, as one decision.
 *
 * The branches are ordered by who has to act: a person's decision first,
 * because nothing Brain does can substitute for it; then another goal; then an
 * operator; then Brain's own capacity. The first that applies is the answer.
 */
function waitingAndNext(input: {
  goal: Workstream;
  lifecycle: GoalLifecycle;
  view: WorkstreamView;
  work: GoalWork[];
  unmet: GoalDependency[];
  decisions: GoalDecision[];
  blockers: GoalBlocker[];
  obligations: string[];
  hasLinks: boolean;
  evidence: GoalEvidence[];
}): Pick<GoalView, 'waiting' | 'next'> {
  const { goal, lifecycle, work } = input;
  const held = work.filter((one) => one.heldReason !== null).length;

  if (lifecycle === 'ARCHIVED') {
    return {
      waiting: { kind: 'NOTHING', detail: 'archived', since: goal.archivedAt },
      next: { action: 'Nothing: this goal is archived.', by: 'NOBODY', afterwards: null },
    };
  }
  if (lifecycle === 'CANCELLED') {
    const owed = goal.commitment === 'CUSTOMER' || input.obligations.length > 0;
    return {
      waiting: { kind: 'CANCELLED', detail: goal.cancelledReason ?? 'cancelled', since: goal.cancelledAt },
      next: owed
        ? {
            action: `Brain has stopped pursuing this, and ${input.obligations.length ? input.obligations.join('; ') : 'the customer obligation'} is still outstanding — cancelling a goal does not end what is owed.`,
            by: 'PERSON',
            afterwards: 'Settle or release the obligation through Cash, where it lives.',
          }
        : {
            action: `Nothing: cancelled. ${held} bin(s) are held with every attempt and result kept; reinstating the goal continues them.`,
            by: 'NOBODY',
            afterwards: null,
          },
    };
  }
  if (lifecycle === 'PAUSED') {
    return {
      waiting: { kind: 'PAUSED', detail: goal.pausedReason ?? 'paused', since: goal.pausedAt },
      next: {
        action: `Resume it when you are ready. ${held} bin(s) are held meanwhile, with every lease, attempt and result kept.`,
        by: 'PERSON',
        afterwards: 'On resume the holds are released on the next tick and the work continues where it stopped — no stage has to be restarted.',
      },
    };
  }
  if (lifecycle === 'COMPLETE') {
    const first = input.evidence[0];
    return {
      waiting: { kind: 'NOTHING', detail: 'complete', since: goal.updatedAt },
      next: {
        action: first ? `Nothing: delivered — ${first.what} (${first.ref}).` : 'Nothing: delivered.',
        by: 'NOBODY',
        afterwards: null,
      },
    };
  }
  const decision = input.decisions[0];
  if (decision) {
    return {
      waiting: { kind: 'PERSON', detail: decision.question, since: decision.since },
      next: { action: decision.proposedAction, by: 'PERSON', afterwards: decision.afterAnswer },
    };
  }
  if (input.unmet.length) {
    const names = input.unmet.map((one) => one.title ?? 'a goal outside your projects').join(', ');
    return {
      waiting: { kind: 'DEPENDENCY', detail: `waiting on ${names}`, since: null },
      next: {
        action: `Nothing until ${names} completes; its bins are held so capacity goes to work that can move.`,
        by: 'BRAIN',
        afterwards: 'Brain releases the holds on the first tick after the dependency completes, and the work continues by itself.',
      },
    };
  }
  const operator = input.blockers.find((one) => one.by === 'OPERATOR' || one.by === 'PERSON');
  if (operator) {
    return {
      waiting: { kind: operator.by === 'PERSON' ? 'PERSON' : 'OPERATOR', detail: operator.text, since: operator.since },
      next: { action: operator.remedy, by: operator.by, afterwards: 'The work continues from where it stopped once this is cleared.' },
    };
  }
  const leased = work.find((one) => one.workerOnIt);
  if (leased) {
    return {
      waiting: { kind: 'WORKER', detail: `a worker is on bin ${leased.binId}`, since: leased.updatedAt },
      next: {
        action: `A worker is carrying bin ${leased.binId}; Brain validates what it submits.`,
        by: 'BRAIN',
        afterwards: 'If the worker stops, its lease expires and Brain fires the next free Routine at the same bin, charging no new stage.',
      },
    };
  }
  const ready = work.find((one) => one.state === 'READY' || one.state === 'LEASED');
  if (ready) {
    const deferred = ready.dispatch?.waitsFor === 'CAPACITY' ? ` (the fleet is full: ${ready.dispatch.refusal})` : '';
    return {
      waiting: {
        kind: 'CAPACITY',
        detail: `bin ${ready.binId} is queued at priority ${ready.priority}${deferred}`,
        since: ready.dispatch?.at ?? ready.updatedAt,
      },
      next: {
        action: `Brain fires the next free Routine at bin ${ready.binId}.`,
        by: 'BRAIN',
        afterwards: 'The dispatcher does this on its own tick; nothing has to be pressed.',
      },
    };
  }
  if (!input.hasLinks) {
    return {
      waiting: { kind: 'NOTHING_LINKED', detail: 'no work is linked to this goal', since: goal.createdAt },
      next: {
        action: 'Point this goal at the work that pursues it — an idea, a mission, a change request or a campaign. Until then Brain has nothing to advance.',
        by: 'PERSON',
        afterwards: 'From the first link on, Brain reads and advances that work by itself.',
      },
    };
  }
  const running = input.view.readings.some((one) => one.state === 'IN_PROGRESS');
  return {
    waiting: {
      kind: running ? 'CAPACITY' : 'NOTHING',
      detail: running ? 'between stages; the next stage is produced by Brain\'s own tick' : input.view.stateEvidence,
      since: null,
    },
    next: {
      action: input.view.nextAction ?? (running ? 'Brain produces the next stage on its own tick.' : 'Nothing recorded says what comes next.'),
      by: input.view.ownerAction ? 'PERSON' : running ? 'BRAIN' : 'NOBODY',
      afterwards: null,
    },
  };
}
