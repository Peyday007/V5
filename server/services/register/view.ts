/**
 * One projection, answering the six questions the owner actually asks.
 *
 *   What is pursuing money?  What is being built?  What is running?
 *   What is blocked?         What needs me?        What actually shipped?
 *
 * Every one of those is answered from the rows a workstream points at, read
 * live by `resolve.ts`, and **never** from a stored verdict. §29 makes the
 * argument at length and this is the same argument: two surfaces deriving their
 * own status from the same graph is how a person comes to read two different
 * answers about one piece of work, and the place somebody would write a fresh
 * summary is exactly a page like this one.
 *
 * So there is one `assemble`, the routes call it, and anything that wants a
 * count calls the same function rather than counting for itself.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to do
 * ---------------------------------------------------------------------------
 *
 *   * **No percentage.** Progress is a milestone state and a named denominator
 *     or it is nothing — "0 of 8 settled" is the sentence §29 was rejected for.
 *   * **No score and no rank over a weighting.** Ordering is lexicographic over
 *     facts, in a declared sequence, for §38's reason: a weight is a judgement
 *     nobody made and the number then reads like a measurement.
 *   * **No favourable unknown.** A workstream nothing can be read about is
 *     `UNKNOWN`, which is neither progress nor failure, and it is reported
 *     rather than rounded into `PROPOSED`.
 */
import type {
  LinkKind,
  Workstream,
  WorkstreamLink,
  WorkstreamPurpose,
  WorkstreamState,
} from '../../domain/register.ts';
import { PURPOSE_LABELS, STATE_RANK } from '../../domain/register.ts';
import { listAllLiveLinks, listWorkstreams } from '../../repos/register.ts';
import { contributesState, readLink, type LinkReading } from './resolve.ts';
import { unfiledWork, type UnfiledItem } from './unfiled.ts';

export interface WorkstreamView {
  id: string;
  projectId: string | null;
  title: string;
  intent: string;
  purpose: WorkstreamPurpose;
  purposeLabel: string;

  /** Derived on this read, from the rows below. Never stored. */
  state: WorkstreamState;
  /** Which reading decided it, so the state is checkable rather than asserted. */
  stateEvidence: string;

  /** Every live link, with what its row says right now. */
  readings: LinkReading[];

  /** Where the work came from: conversations and passages. */
  sources: LinkReading[];

  blockers: string[];
  /** Set when a person has to do something before anything else can move. */
  ownerAction: string | null;
  /** The smallest concrete next thing, or null when Brain cannot say. */
  nextAction: string | null;

  archivedAt: string | null;
  updatedAt: string;
}

export interface RegisterView {
  /** The six answers, each a list of workstream ids into `workstreams`. */
  answers: {
    pursuingMoney: string[];
    beingBuilt: string[];
    running: string[];
    blocked: string[];
    needsYou: string[];
    shipped: string[];
  };
  workstreams: WorkstreamView[];
  /**
   * Work this Brain is holding that no workstream accounts for.
   *
   * Derived, offered, and never filed automatically: a workstream stores an
   * intent and a purpose, and composing either would be manufacturing the
   * judgment a person is supposed to supply.
   */
  unfiled: UnfiledItem[];
  /**
   * How many workstreams nothing could be read about.
   *
   * Reported rather than folded into another count, because a register that
   * silently presented "we could not tell" as "nothing is happening" is the
   * favourable-unknown defect invariant 39 names.
   */
  unknown: number;
  generatedAt: string;
}

/**
 * The furthest state any linked row supports, with `BLOCKED` winning below a
 * merge.
 *
 * Two rules and they are in tension on purpose. A person needs to know that
 * work has *stopped* more than that it started, so a blocker beats anything
 * below `MERGED`. But a blocker on one unit of a campaign whose pull request is
 * already open should not hide the pull request, so above `MERGED` the further
 * reading wins and the blocker is still listed beside it.
 */
function deriveState(readings: LinkReading[]): { state: WorkstreamState; evidence: string } {
  let best: { state: WorkstreamState; evidence: string } | null = null;
  let blocked: { state: WorkstreamState; evidence: string } | null = null;

  for (const reading of readings) {
    if (reading.state === null) continue;
    const candidate = { state: reading.state, evidence: `${reading.kind}: ${reading.evidence}` };
    if (reading.state === 'BLOCKED') {
      blocked ??= candidate;
      continue;
    }
    if (!best || STATE_RANK[reading.state] > STATE_RANK[best.state]) best = candidate;
  }

  if (blocked && (!best || STATE_RANK[best.state] < STATE_RANK.MERGED)) return blocked;
  if (best) return best;
  return { state: 'UNKNOWN', evidence: 'nothing linked to this says where it has got to' };
}

/**
 * The smallest concrete next thing.
 *
 * Derived from the readings and deliberately allowed to be `null`. A sentence
 * invented to fill this field would be the reassuring-pending-state §24
 * corrected: a next action that cannot become wrong is not an instruction.
 */
function deriveNextAction(state: WorkstreamState, readings: LinkReading[]): string | null {
  const missing = readings.find((one) => one.missing);
  if (missing) {
    return `A linked ${missing.kind.toLowerCase().replace(/_/g, ' ')} is gone (${missing.ref}). Correct the link or record why it went.`;
  }
  switch (state) {
    case 'BLOCKED': {
      const blocker = readings.find((one) => one.blocker);
      return blocker
        ? `Clear the blocker on ${blocker.kind.toLowerCase().replace(/_/g, ' ')} ${blocker.ref}: ${blocker.blocker}`
        : 'Something here is blocked and nothing recorded why. Read the linked rows.';
    }
    case 'PR_READY': {
      const pr = readings.find((one) => one.kind === 'PULL_REQUEST');
      return pr ? `Review and merge ${pr.ref}.` : 'Open the pull request for the finished work.';
    }
    case 'MERGED':
      return 'Deploy the canonical branch, then record the deployment against this workstream.';
    case 'DEPLOYED':
      return 'Verify it live, and record what was checked.';
    case 'PROPOSED':
      return 'Approve it, or say why not.';
    case 'UNKNOWN':
      return null;
    default:
      return null;
  }
}

/**
 * What a person has to do before anything else here can move.
 *
 * Narrow on purpose. An unapproved change request and a mission parked at
 * `NEEDS_HUMAN` are decisions only a person can make, and a pull request
 * waiting to be merged is the boundary §27 reserves to a person. Everything
 * else is Brain's and must not be put in front of somebody as if it were
 * theirs — §33 records what a screen asking a person to attest to Brain's own
 * work costs.
 */
function deriveOwnerAction(readings: LinkReading[]): string | null {
  const request = readings.find(
    (one) => one.kind === 'CHANGE_REQUEST' && one.status.includes('DRAFT'),
  );
  if (request) return `Approve the change request ${request.ref}, or say why not.`;

  const parked = readings.find((one) => one.kind === 'MISSION' && one.status.includes('NEEDS_HUMAN'));
  if (parked) return `Answer the decision mission ${parked.ref} is waiting on.`;

  const pr = readings.find(
    (one) => one.kind === 'PULL_REQUEST' && one.state === 'PR_READY',
  );
  if (pr) return `Read and merge ${pr.ref}.`;

  const release = readings.find((one) => one.status.includes('AWAITING_RELEASE'));
  if (release) return `Release campaign ${release.ref}, or say why not.`;

  return null;
}

/**
 * Assemble the whole view.
 *
 * `projectIds` is what this caller may read, decided by the route through
 * `decideProjectAccess` before it gets here. Passing it in rather than deciding
 * it here is the same split §29 draws for search: the scope is settled before
 * the query, so "nothing found" and "nothing you can see" are one answer and
 * there is no filter afterwards to forget.
 */
export async function assembleRegister(options: {
  projectIds: string[] | null;
  includeArchived?: boolean;
}): Promise<RegisterView> {
  const workstreams = await listWorkstreams({
    projectIds: options.projectIds,
    includeArchived: options.includeArchived ?? false,
  });
  const links = await listAllLiveLinks(workstreams.map((one) => one.id));

  const byStream = new Map<string, WorkstreamLink[]>();
  for (const link of links) {
    const list = byStream.get(link.workstreamId);
    if (list) list.push(link);
    else byStream.set(link.workstreamId, [link]);
  }

  const views: WorkstreamView[] = [];
  for (const workstream of workstreams) {
    views.push(await viewOf(workstream, byStream.get(workstream.id) ?? []));
  }

  const answers = {
    pursuingMoney: views
      .filter((one) => one.purpose === 'REVENUE_DIRECT' || one.purpose === 'REVENUE_ENABLING')
      .map((one) => one.id),
    beingBuilt: views
      .filter((one) => one.state === 'PROPOSED' || one.state === 'IN_PROGRESS' || one.state === 'PR_READY')
      .map((one) => one.id),
    running: views.filter((one) => one.state === 'IN_PROGRESS').map((one) => one.id),
    blocked: views.filter((one) => one.state === 'BLOCKED').map((one) => one.id),
    needsYou: views.filter((one) => one.ownerAction !== null).map((one) => one.id),
    shipped: views
      .filter(
        (one) =>
          one.state === 'MERGED' || one.state === 'DEPLOYED' || one.state === 'VERIFIED_LIVE' || one.state === 'DONE',
      )
      .map((one) => one.id),
  };

  return {
    answers,
    workstreams: views,
    unfiled: await unfiledWork(options.projectIds ?? []),
    unknown: views.filter((one) => one.state === 'UNKNOWN').length,
    generatedAt: new Date().toISOString(),
  };
}

const SOURCE_KINDS: ReadonlySet<LinkKind> = new Set<LinkKind>([
  'CONVERSATION',
  'BRIDGE_CONVERSATION',
  'PASSAGE',
]);

export async function viewOf(
  workstream: Workstream,
  links: WorkstreamLink[],
): Promise<WorkstreamView> {
  const readings: LinkReading[] = [];
  for (const link of links) readings.push(await readLink(link));

  const stateful = readings.filter((reading, index) => {
    const link = links[index];
    return link !== undefined && contributesState(link);
  });

  const { state, evidence } = deriveState(stateful);
  const blockers = readings
    .map((one) => one.blocker)
    .filter((one): one is string => one !== null);

  return {
    id: workstream.id,
    projectId: workstream.projectId,
    title: workstream.title,
    intent: workstream.intent,
    purpose: workstream.purpose,
    purposeLabel: PURPOSE_LABELS[workstream.purpose],
    state,
    stateEvidence: evidence,
    readings,
    sources: readings.filter((one) => SOURCE_KINDS.has(one.kind)),
    blockers,
    ownerAction: deriveOwnerAction(readings),
    nextAction: deriveNextAction(state, readings),
    archivedAt: workstream.archivedAt,
    updatedAt: workstream.updatedAt,
  };
}
