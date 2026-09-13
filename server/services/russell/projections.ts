/**
 * What Russell is doing, in words a person reads first.
 *
 * Everything here is derived from authoritative rows, and the rule that shapes
 * all of it is: **translation may simplify; it may not invent.** Progress,
 * certainty and completion have to come from something countable, or they are
 * not said.
 *
 * That rules out the most tempting sentence in the product. "About halfway
 * through figuring out how the money works" is only sayable when a defined
 * milestone ratio supports it — a layer with three of six versions accepted is
 * halfway; a layer with an unknown amount of work left is not.
 *
 * The arithmetic behind that used to live here, and it does not any more.
 * `progress.ts` owns it, for every surface, because the moment Work and Ideas
 * and the map each needed a version of it there were four implementations and
 * three of them were untested. A person reading two screens must not see two
 * different answers about the same project.
 *
 * The other rule is order. Every ordinary update answers, in this sequence:
 * what changed, why it matters, what Russell is doing next, and whether the
 * person is needed. `briefing()` composes exactly those four and nothing else,
 * because a briefing that leads with an orchestration id has already lost.
 */
import { listLayers } from '../../repos/layers.ts';
import { groupOf, listMissions, listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { authorityFor } from './authority.ts';
import { softwareNeedingPerson } from './software.ts';
import { listOpenRequests } from '../../repos/russellMissions.ts';
import { plainLayerName } from './dealDispatch.ts';
import { projectProgress, type Progress } from './progress.ts';
import type { LayerStatus, RussellMission } from '../../domain/types.ts';

/** Layer states that mean work is genuinely under way. */
const UNDER_WAY: readonly LayerStatus[] = [
  'RESEARCHING',
  'AUDITING',
  'AUDIT_READY',
  'MORE_RESEARCH_REQUIRED',
  'SYNTHESIS_READY',
  'SYNTHESIS_RUNNING',
  'INCOMPLETE',
  'REOPENED',
];

export interface Briefing {
  /** One line: what Russell is on. */
  focus: string;
  /**
   * Meaningful progress, from the one shared projection.
   *
   * The whole object rather than its sentence, because a briefing card shows
   * the sentence and a person who opens it wants the milestones behind it —
   * and a second call to work them out could disagree with this one.
   */
  progress: Progress;
  /** The most recent thing worth telling somebody. Null when there is none. */
  latest: string | null;
  /** What Russell intends to do next, or what it is watching. */
  next: string;
  /**
   * The open gaps worth a person knowing about.
   *
   * From the knowledge rows that record them — `GAP`, `UNKNOWN`,
   * `CONTRADICTION` — rather than derived from what is missing, because a gap
   * somebody wrote down is a fact and a gap inferred from an absence is a
   * guess. Empty when the project has recorded none, which is different from
   * having none.
   */
  openGaps: string[];
  /** Whether a person is actually needed, and for what. */
  needsYou: string;
  /**
   * How many open decisions there are, for a badge.
   *
   * A *decision*, not a `russell_human_requests` row. A project with no
   * standing authority is waiting on a person just as surely as a parked
   * packet is, and counting only the rows made the two screens contradict each
   * other: the briefing said "You are not needed" while the panel underneath
   * it presented an approval that had to be given before anything could run.
   */
  openRequests: number;
}

/** What Russell is on, from the missions actually running. */
function focusOf(projectName: string, missions: RussellMission[]): string {
  const working = missions.filter((mission) => groupOf(mission) === 'WORKING_NOW');
  if (working.length === 0) return `Russell is watching ${projectName}.`;
  if (working.length === 1) return `Russell is working on ${projectName}.`;
  return `Russell is working on ${projectName}, on ${working.length} things at once.`;
}

/**
 * What Russell intends to do next.
 *
 * Read from the queue rather than composed: if something is up next it is
 * named, and if nothing is, the honest answer is what Russell is waiting for.
 * "Russell will continue" with nothing behind it is the sentence this avoids.
 */
function nextOf(missions: RussellMission[]): string {
  const upNext = missions.find((mission) => groupOf(mission) === 'UP_NEXT');
  if (upNext) return `Next, Russell is ${lowerFirst(upNext.objective)}`;
  const exploring = missions.find((mission) => groupOf(mission) === 'EXPLORING');
  if (exploring) return `Russell is taking a cheap look at ${lowerFirst(exploring.objective)}`;
  const waiting = missions.find((mission) => groupOf(mission) === 'WAITING');
  if (waiting) return `Russell is waiting on ${waiting.waitingOn ?? 'something outside its control'}.`;
  return 'Russell has nothing queued and is watching for something worth starting.';
}

function lowerFirst(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const ended = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return ended.charAt(0).toLowerCase() + ended.slice(1);
}

/**
 * The one sentence about whether a person is needed, composed from counts.
 *
 * Extracted because it grew a third input and a nested ternary is where a
 * sentence stops being checkable. The order is fixed: an outstanding approval
 * is named first, because nothing else can proceed until it is answered.
 */
function needsYouSentence(input: {
  needsApproval: boolean;
  others: number;
  blocking: number;
}): string {
  const { needsApproval, others, blocking } = input;
  const plural = (count: number): string => (count === 1 ? 'decision is' : 'decisions are');
  if (needsApproval) {
    return others === 0
      ? 'You are needed: Russell needs your permission before it can research anything here.'
      : `You are needed: Russell needs your permission to research here, and ${others} other ${plural(others)} waiting.`;
  }
  if (others === 0) return 'You are not needed.';
  if (blocking > 0) {
    return `You are needed: ${blocking} ${plural(blocking)} holding work up.`;
  }
  return `${others} ${plural(others)} waiting whenever you have a moment.`;
}

/**
 * The briefing for one project.
 *
 * Four sentences in a fixed order, each from rows. The one thing it will not do
 * is describe work it cannot see: an empty project produces an honest empty
 * briefing rather than an encouraging one.
 */
export async function briefing(input: {
  projectId: string;
  projectName: string;
  includePrivate?: boolean;
}): Promise<Briefing> {
  const [progress, missions, knowledge, requests, gaps, software] = await Promise.all([
    projectProgress({ projectId: input.projectId, projectName: input.projectName }),
    listMissions({ projectId: input.projectId }),
    listCurrentKnowledge({
      projectId: input.projectId,
      kinds: ['CONCLUSION'],
      includePrivate: input.includePrivate ?? false,
      limit: 5,
    }),
    listOpenRequests(input.projectId),
    listCurrentKnowledge({
      projectId: input.projectId,
      kinds: ['GAP', 'UNKNOWN', 'CONTRADICTION'],
      includePrivate: input.includePrivate ?? false,
      limit: 5,
    }),
    /*
     * Software decisions are decisions.
     *
     * §29 records what happens when this list is composed from one table: the
     * briefing said "You are not needed" directly above a control that had to
     * be answered before anything could run, because both counted
     * `russell_human_requests` rows and the thing waiting was not one. A change
     * waiting to be authorized, and a campaign stopped at a blocker or a
     * release, are exactly that defect again — so they are counted here, from
     * the same projection the panel underneath renders.
     */
    softwareNeedingPerson(input.projectId),
  ]);

  /*
   * The approval is a decision too.
   *
   * Read from the same projection the panel renders, so the sentence and the
   * card cannot disagree — which they did: a project with no grant showed "You
   * are not needed" above an approval that had to be given before Russell
   * could do anything at all. A status that contradicts the control beside it
   * is worse than no status, because it teaches a person to stop reading it.
   *
   * It is deliberately the *first* thing named when it is outstanding. Nothing
   * else in the list can proceed until it is answered.
   */
  const authority = await authorityFor({ projectId: input.projectId });
  const needsApproval = authority.grant === null;

  /*
   * There was a `spentCeiling` here, and it is gone.
   *
   * It named a real defect at the time: a queued idea sitting behind a spent
   * cumulative ceiling while the briefing said "You are not needed". The
   * remedy was to count the wall as a decision and tell a person to raise the
   * limit. Under the UNCAPPED policy there is no wall — missions, fragments
   * and probes are counted rather than rationed — so a briefing that asked for
   * a top-up would be asking a person to answer a question nothing poses.
   *
   * What is left is the refusal that is real: `AT_ONCE`, which is an ordinary
   * wait for the one investigation ahead of it and needs nobody.
   */
  const blocking = requests.filter((request) => request.urgency !== 'WHENEVER');
  const decisions = requests.length + software.length + (needsApproval ? 1 : 0);

  return {
    focus: focusOf(input.projectName, missions),
    progress,
    latest: knowledge[0]?.statement ?? null,
    next: nextOf(missions),
    openGaps: gaps.map((gap) => gap.statement),
    // The honest default is that a person is *not* needed. Saying otherwise
    // when nothing is blocked trains people to ignore the one time it matters
    // — and so does saying it when something *is* blocked, which is why the
    // approval is counted here rather than only rendered underneath.
    needsYou: needsYouSentence({
      needsApproval,
      others: requests.length + software.length,
      // A software change nobody has authorized is holding its own work up by
      // definition — nothing about it proceeds — so it counts as blocking
      // rather than as something to get to whenever.
      blocking: blocking.length + software.length,
    }),
    openRequests: decisions,
  };
}

/**
 * The layer a person would call the current focus, in plain words.
 *
 * Exposed separately because the shell shows it beside the briefing, and
 * because it is the one place `plainLayerName` has to be applied consistently —
 * "Monetization Logic" must never reach a person's screen.
 */
export async function focusLayer(projectId: string): Promise<string | null> {
  const layers = await listLayers(projectId);
  const active = layers.find((layer) => UNDER_WAY.includes(layer.status));
  return active ? plainLayerName(active.name) : null;
}
