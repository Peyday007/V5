/**
 * Conversations, organized the way a person thinks about them.
 *
 * Step 12A left a flat list ordered by recency, which fails in one specific
 * way: somebody with thirty threads across four projects cannot find the one
 * they were in the middle of. §7 asks for two things instead — automatic
 * organization into collections, and ranking *by meaning* inside each.
 *
 * Three rules shape all of it.
 *
 * **Organization is deterministic, and it never invents a category.** A thread
 * attached to a project goes in that project's collection; a private thread
 * with no project goes in Personal; everything else is unfiled and says so. No
 * model is asked to name a theme here, because a category Russell guessed would
 * be indistinguishable from one a person chose — and §8's rule that model prose
 * never mutates state applies to a filing decision exactly as it does to a
 * verdict.
 *
 * **A person's filing always wins.** `collection_source` records who decided,
 * and the automatic pass is guarded to write only over its own decisions, in
 * the statement that makes the change. That is the same shape `attachment_source`
 * already gives project routing one column along.
 *
 * **Rank is derived, never stored.** "Major and unfinished" is a fact about
 * live missions and the thread's last turn, both of which move without anybody
 * touching the conversation. A stored rank would be stale the moment a worker
 * answered something.
 */
import {
  ensureCollection,
  fileConversation,
  listCollections,
} from '../../repos/russellCollections.ts';
import {
  lastTurnPerConversation,
  listConversationsForOwner,
} from '../../repos/russellConversations.ts';
import { listMissions, listOpenRequests, listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { listCandidates } from '../../repos/russellCandidates.ts';
import { getProject } from '../../repos/projects.ts';
import { groupOf } from '../../repos/russellMissions.ts';
import type {
  RussellCollection,
  RussellConversation,
  RussellMission,
} from '../../domain/types.ts';

/** The collection every unattached shared thread lands in until somebody files it. */
export const UNFILED = 'Unfiled';
/** Where a person's own thinking lives. Private by default, and stays private. */
export const PERSONAL = 'Personal';

/**
 * The four standings, strongest first (§7).
 *
 * `MAJOR_UNFINISHED` is not "important": it is a thread that produced work
 * Russell itself ranked as a must-do or a big move, *and* has something
 * outstanding. Both halves matter — a major thread that is finished belongs at
 * the bottom with the rest of the finished ones.
 */
export const STANDINGS = ['MAJOR_UNFINISHED', 'UNFINISHED', 'ACTIVE', 'FINISHED'] as const;
export type Standing = (typeof STANDINGS)[number];

export const STANDING_LABELS: Record<Standing, string> = {
  MAJOR_UNFINISHED: 'Major, unfinished',
  UNFINISHED: 'Unfinished',
  ACTIVE: 'Active',
  FINISHED: 'Finished',
};

export interface RankedThread {
  id: string;
  title: string;
  standing: Standing;
  /**
   * The words for that standing, sent rather than mapped again in the client.
   *
   * The vocabulary belongs to the server for the same reason the authority
   * sentences do: a client with its own copy is a second mapping, and two
   * mappings of one enum eventually disagree.
   */
  standingLabel: string;
  /** Why it stands where it does, in one sentence a person reads. */
  reason: string;
  projectId: string | null;
  visibility: 'PRIVATE' | 'SHARED';
  updatedAt: string;
  closedAt: string | null;
  collectionId: string | null;
  /** Whether a person filed it here, so the interface can say so. */
  filedBy: 'NONE' | 'AUTOMATIC' | 'USER';
}

export interface CollectionView {
  id: string | null;
  name: string;
  kind: 'PROJECT' | 'CATEGORY' | 'PERSONAL';
  projectId: string | null;
  threads: RankedThread[];
  /**
   * Openers written from this collection's own state.
   *
   * Empty when there is nothing true to suggest. "What would you like to
   * explore?" is the filler §7 rules out by name, and an empty list renders as
   * nothing at all rather than as a prompt with no content behind it.
   */
  starters: Starter[];
}

export interface Starter {
  /** What the person would be saying. Sent verbatim if they pick it. */
  text: string;
  /** The row it came from, so nothing here is composed out of nowhere. */
  from: 'REQUEST' | 'GAP' | 'MISSION' | 'THREAD' | 'CANDIDATE';
}

/**
 * Which collection a thread belongs in, with no model involved.
 *
 * Returns the *name*, because the caller is what creates or finds the row —
 * keeping this a pure function is what makes the rule testable without a
 * database.
 */
export function collectionNameFor(input: {
  projectName: string | null;
  visibility: 'PRIVATE' | 'SHARED';
}): { name: string; kind: 'PROJECT' | 'CATEGORY' | 'PERSONAL' } {
  if (input.projectName) return { name: input.projectName, kind: 'PROJECT' };
  if (input.visibility === 'PRIVATE') return { name: PERSONAL, kind: 'PERSONAL' };
  return { name: UNFILED, kind: 'CATEGORY' };
}

/**
 * Where one thread stands, from what is true about it right now.
 *
 * Order matters and is not the order of the enum: closed is checked first
 * because a person saying a thread is done outranks every derivation, and
 * "major" is checked before "unfinished" because a major unfinished thread is
 * both and must be reported as the stronger one.
 */
export function standingOf(input: {
  closedAt: string | null;
  /** True when the last thing said was a person's and nothing answered it. */
  awaitingAnswer: boolean;
  /** Missions from this thread that are not terminal. */
  liveMissions: number;
  /** True when this thread produced a must-do or big-move idea. */
  major: boolean;
  /** A decision waiting on a person, from work this thread started. */
  decisionsWaiting: number;
}): { standing: Standing; reason: string } {
  if (input.closedAt) {
    return { standing: 'FINISHED', reason: 'You marked this one finished.' };
  }
  const unfinished =
    input.awaitingAnswer || input.liveMissions > 0 || input.decisionsWaiting > 0;
  const because = input.decisionsWaiting > 0
    ? `${input.decisionsWaiting} ${input.decisionsWaiting === 1 ? 'decision is' : 'decisions are'} waiting on you.`
    : input.awaitingAnswer
      ? 'Russell has not answered your last message yet.'
      : input.liveMissions > 0
        ? `${input.liveMissions} ${input.liveMissions === 1 ? 'piece' : 'pieces'} of work from this thread ${input.liveMissions === 1 ? 'is' : 'are'} still running.`
        : '';
  if (input.major && unfinished) {
    return { standing: 'MAJOR_UNFINISHED', reason: `This started something big. ${because}`.trim() };
  }
  if (unfinished) return { standing: 'UNFINISHED', reason: because };
  return { standing: 'ACTIVE', reason: 'Nothing outstanding; pick it up whenever.' };
}

const RANK: Record<Standing, number> = {
  MAJOR_UNFINISHED: 0,
  UNFINISHED: 1,
  ACTIVE: 2,
  FINISHED: 3,
};

/** Standing first, then recency inside it. Never recency alone. */
export function orderThreads(threads: RankedThread[]): RankedThread[] {
  return [...threads].sort((left, right) => {
    const byStanding = RANK[left.standing] - RANK[right.standing];
    if (byStanding !== 0) return byStanding;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

/**
 * File every thread this person owns that nobody has filed by hand.
 *
 * Idempotent by its guarded write and by `ensureCollection`'s conflict clause,
 * so running it on every read of the collections view costs one pass and
 * changes nothing the second time.
 */
export async function organize(ownerUserId: string): Promise<void> {
  const threads = await listConversationsForOwner(ownerUserId, 200);
  const names = new Map<string, RussellCollection>();
  for (const thread of threads) {
    if (thread.collectionSource === 'USER') continue;
    const project = thread.projectId ? await getProject(thread.projectId) : null;
    const target = collectionNameFor({
      projectName: project?.name ?? null,
      visibility: thread.visibility,
    });
    let collection = names.get(target.name);
    if (!collection) {
      collection = await ensureCollection({
        ownerUserId,
        name: target.name,
        kind: target.kind,
        projectId: project?.id ?? null,
      });
      names.set(target.name, collection);
    }
    if (thread.collectionId === collection.id) continue;
    await fileConversation({
      conversationId: thread.id,
      ownerUserId,
      collectionId: collection.id,
      actor: 'AUTOMATIC',
    });
  }
}

/**
 * Everything a person's conversation list needs, in one read.
 *
 * The per-thread facts are gathered in two passes rather than per thread: one
 * listing of missions and one of candidates per *project*, indexed by
 * conversation. A fan-out of two queries per thread is invisible with four
 * threads and unusable with four hundred.
 */
export async function collectionsFor(input: {
  ownerUserId: string;
  /** The project whose state supplies starters. Null when there is none. */
  projectId: string | null;
  projectName: string | null;
  now?: string;
}): Promise<CollectionView[]> {
  await organize(input.ownerUserId);

  const [threads, collections] = await Promise.all([
    listConversationsForOwner(input.ownerUserId, 200),
    listCollections(input.ownerUserId),
  ]);

  const missions = input.projectId
    ? await listMissions({ projectId: input.projectId, limit: 500 })
    : [];
  const candidates = input.projectId
    ? await listCandidates({ projectId: input.projectId, limit: 500 })
    : [];
  const requests = input.projectId ? await listOpenRequests(input.projectId) : [];

  const missionsByThread = new Map<string, RussellMission[]>();
  for (const mission of missions) {
    if (!mission.conversationId) continue;
    const list = missionsByThread.get(mission.conversationId) ?? [];
    list.push(mission);
    missionsByThread.set(mission.conversationId, list);
  }
  const majorThreads = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.conversationId) continue;
    if (candidate.priority === 'MUST_DO' || candidate.priority === 'BIG_MOVE') {
      majorThreads.add(candidate.conversationId);
    }
  }
  const requestsByMission = new Map<string, number>();
  for (const request of requests) {
    // A request with no mission is a project-level decision — real, and not
    // attributable to any one thread, so it is counted nowhere rather than
    // counted against an arbitrary thread.
    if (!request.missionId) continue;
    requestsByMission.set(request.missionId, (requestsByMission.get(request.missionId) ?? 0) + 1);
  }

  /*
   * The last turn in every thread, in one query.
   *
   * This was a `listTurns` call inside the loop — the fan-out the comment
   * above this function claims it avoids, which made the comment wrong rather
   * than the code slow. Two hundred threads was two hundred round trips.
   */
  const lastTurns = await lastTurnPerConversation(threads.map((thread) => thread.id));

  const ranked: RankedThread[] = [];
  for (const thread of threads) {
    const threadMissions = missionsByThread.get(thread.id) ?? [];
    const live = threadMissions.filter(
      (mission) => groupOf(mission) !== 'FINISHED',
    ).length;
    const decisions = threadMissions.reduce(
      (total, mission) => total + (requestsByMission.get(mission.id) ?? 0),
      0,
    );
    const last = lastTurns.get(thread.id);
    const awaitingAnswer =
      last !== undefined && (last.role === 'USER' || last.status === 'PENDING');
    const { standing, reason } = standingOf({
      closedAt: thread.closedAt,
      awaitingAnswer,
      liveMissions: live,
      major: majorThreads.has(thread.id),
      decisionsWaiting: decisions,
    });
    ranked.push({
      id: thread.id,
      title: thread.title,
      standing,
      standingLabel: STANDING_LABELS[standing],
      reason,
      projectId: thread.projectId,
      visibility: thread.visibility,
      updatedAt: thread.updatedAt,
      closedAt: thread.closedAt,
      collectionId: thread.collectionId,
      filedBy: thread.collectionSource,
    });
  }

  const starters = await startersFor({
    projectId: input.projectId,
    projectName: input.projectName,
    requests,
    missions,
    threads: ranked,
  });

  const views: CollectionView[] = collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    kind: collection.kind,
    projectId: collection.projectId,
    threads: orderThreads(ranked.filter((thread) => thread.collectionId === collection.id)),
    // Starters come from the project's state, so only the project's own
    // collection gets them. Offering "finish the customer-acquisition problem"
    // above a list of personal notes would be nonsense.
    starters: collection.projectId && collection.projectId === input.projectId ? starters : [],
  }));

  const loose = ranked.filter((thread) => thread.collectionId === null);
  if (loose.length > 0) {
    views.push({
      id: null,
      name: UNFILED,
      kind: 'CATEGORY',
      projectId: null,
      threads: orderThreads(loose),
      starters: [],
    });
  }

  // A collection with nothing in it is noise on somebody's first day and a
  // leftover after they move the last thread out of one.
  return views.filter((view) => view.threads.length > 0);
}

/**
 * Openers, each from a row.
 *
 * Ordered by what a person is most likely to want next: a decision that is
 * holding work up, then a gap somebody wrote down, then something that just
 * came back, then a thread left mid-sentence. Capped at four, because a wall of
 * suggestions is the same failure as none.
 */
export async function startersFor(input: {
  projectId: string | null;
  projectName: string | null;
  requests: Awaited<ReturnType<typeof listOpenRequests>>;
  missions: RussellMission[];
  threads: RankedThread[];
}): Promise<Starter[]> {
  const starters: Starter[] = [];

  for (const request of input.requests) {
    if (starters.length >= 2) break;
    starters.push({
      text: `Walk me through the decision about ${lowerFirst(request.authorityNeeded)}`,
      from: 'REQUEST',
    });
  }

  if (input.projectId) {
    const gaps = await listCurrentKnowledge({
      projectId: input.projectId,
      kinds: ['GAP', 'UNKNOWN', 'CONTRADICTION'],
      includePrivate: false,
      limit: 2,
    });
    for (const gap of gaps) {
      starters.push({ text: `Finish ${lowerFirst(gap.statement)}`, from: 'GAP' });
    }
  }

  const finished = input.missions
    .filter((mission) => mission.state === 'DONE' && mission.documentId !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (finished) {
    starters.push({
      text: `What did we learn from ${lowerFirst(finished.objective)}`,
      from: 'MISSION',
    });
  }

  const midSentence = input.threads.find((thread) => thread.standing === 'MAJOR_UNFINISHED');
  if (midSentence) {
    starters.push({ text: `Pick up ${midSentence.title}`, from: 'THREAD' });
  }

  return starters.slice(0, 4);
}

function lowerFirst(text: string): string {
  const trimmed = text.trim().replace(/[.?!]+$/, '');
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
