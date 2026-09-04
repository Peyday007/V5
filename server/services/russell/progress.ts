/**
 * How far along something is — from milestones, or not at all.
 *
 * There is exactly one of these in the product, and that is the point. Progress
 * was previously computed in `projections.ts` for a briefing and would have been
 * computed again for Work, again for Ideas, again for the map — four functions
 * that drift, three of which nobody tests, and a person reading two different
 * numbers for the same project on two screens.
 *
 * The rule every path here obeys is the one §24 already wrote for translation:
 * **it may simplify; it may not invent.** So a fraction is only ever reported
 * over a *declared closed set* of milestones — a project's own layers, a
 * candidate's own pipeline, the build's own steps — and anything less structured
 * gets a named stage and a list of what is done and what is missing. There is no
 * code path in this file that turns a feeling into a percentage, and a stage is
 * never chosen because the alternative reads badly.
 *
 * `BLOCKED` outranks everything. A project three-quarters settled with a
 * document nobody can read is not three-quarters of the way anywhere, and
 * saying "Strengthening" over the top of that is the false confidence the whole
 * platform exists to prevent.
 */
import { listLayers } from '../../repos/layers.ts';
import { listMissions, listOpenRequests } from '../../repos/russellMissions.ts';
import type { LayerStatus, RussellCandidate, RussellMission } from '../../domain/types.ts';

/**
 * The five stages, plus the two honest ends.
 *
 * `NOT_STARTED` and `SETTLED` are separate from the middle three because they
 * are facts rather than judgements: nothing has begun, or everything defined is
 * finished. Collapsing either into `FOUNDATION` or `STRENGTHENING` would make
 * the vocabulary read like a gradient when two of its members are not.
 */
export const PROGRESS_STAGES = [
  'NOT_STARTED',
  'FOUNDATION',
  'FORMING',
  'OPERATIONAL',
  'STRENGTHENING',
  'SETTLED',
  'BLOCKED',
] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/** What a person reads for each stage. One mapping, tested, not scattered. */
export const STAGE_LABELS: Record<ProgressStage, string> = {
  NOT_STARTED: 'Not started',
  FOUNDATION: 'Foundation',
  FORMING: 'Forming',
  OPERATIONAL: 'Operational',
  STRENGTHENING: 'Strengthening',
  SETTLED: 'Settled',
  BLOCKED: 'Blocked',
};

/** One named thing that is either done or not. Never a partial credit. */
export interface Milestone {
  key: string;
  title: string;
  done: boolean;
  /** Why it is or is not done, when there is something worth saying. */
  detail: string | null;
}

export interface Progress {
  stage: ProgressStage;
  /** The sentence. Milestone-backed, or deliberately non-numeric. */
  headline: string;
  completed: Milestone[];
  missing: Milestone[];
  /**
   * A fraction *only* over a closed declared set. Null means the total is
   * genuinely unknown, and a caller that renders a bar must show nothing rather
   * than guess a denominator.
   */
  ratio: { done: number; total: number } | null;
  /** Named obstacles, in a person's words. Empty when nothing is blocked. */
  blockedBy: string[];
}

/**
 * Stage from a counted ratio, with blocking taken first.
 *
 * The bands are wide on purpose. Four stages over a ratio is about as much
 * resolution as a layer count actually carries, and a fifth band would be
 * precision the milestones do not have.
 */
export function stageFor(input: {
  done: number;
  total: number;
  started: boolean;
  blocked: boolean;
}): ProgressStage {
  if (input.blocked) return 'BLOCKED';
  if (input.total === 0 || !input.started) return 'NOT_STARTED';
  if (input.done === input.total) return 'SETTLED';
  const ratio = input.done / input.total;
  if (ratio === 0) return 'FOUNDATION';
  if (ratio < 0.34) return 'FORMING';
  if (ratio < 0.67) return 'OPERATIONAL';
  return 'STRENGTHENING';
}

/**
 * The sentence, composed from the counts rather than from the stage.
 *
 * Composed here so that every surface says the same thing, and so that the one
 * place a number could leak into prose is the one place a test watches.
 */
export function describe(progress: Omit<Progress, 'headline'>, noun: string): string {
  if (progress.stage === 'BLOCKED') {
    const first = progress.blockedBy[0];
    return first ? `Blocked: ${first}` : `${noun} is blocked.`;
  }
  if (progress.stage === 'NOT_STARTED') return `Nothing has been started on ${noun} yet.`;
  if (progress.stage === 'SETTLED') return `Everything defined for ${noun} is settled.`;
  const ratio = progress.ratio;
  if (!ratio) {
    // No denominator, so no fraction — and no sentence that implies one.
    return `${STAGE_LABELS[progress.stage]}: ${progress.completed.length} done, ${progress.missing.length} still open.`;
  }
  return `${STAGE_LABELS[progress.stage]} — ${ratio.done} of ${ratio.total} settled.`;
}

/** Assemble, so no caller composes a headline of its own. */
export function progressOf(input: {
  milestones: Milestone[];
  /** Whether the ratio is over a genuinely closed set. */
  closed: boolean;
  started: boolean;
  blockedBy: string[];
  noun: string;
}): Progress {
  const completed = input.milestones.filter((milestone) => milestone.done);
  const missing = input.milestones.filter((milestone) => !milestone.done);
  const stage = stageFor({
    done: completed.length,
    total: input.milestones.length,
    started: input.started,
    blocked: input.blockedBy.length > 0,
  });
  const partial: Omit<Progress, 'headline'> = {
    stage,
    completed,
    missing,
    ratio: input.closed && input.milestones.length > 0
      ? { done: completed.length, total: input.milestones.length }
      : null,
    blockedBy: input.blockedBy,
  };
  return { ...partial, headline: describe(partial, input.noun) };
}

// ---------------------------------------------------------------------------
// A project
// ---------------------------------------------------------------------------

/** Layer states that count as settled. Only one, and deliberately. */
const SETTLED: readonly LayerStatus[] = ['FROZEN'];
/** Layer states that mean work is genuinely happening. */
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

/**
 * How far along a project is.
 *
 * The milestones are the project's own layers, which are a fixed declared set
 * decided when the project was created — so "three of eight settled" is a fact
 * about rows rather than an impression, and the ratio is honest.
 */
export async function projectProgress(input: {
  projectId: string;
  projectName: string;
}): Promise<Progress> {
  const [layers, requests] = await Promise.all([
    listLayers(input.projectId),
    listOpenRequests(input.projectId),
  ]);

  const blockedBy: string[] = [];
  for (const layer of layers) {
    if (layer.status === 'BLOCKED') blockedBy.push(`${layer.name} cannot go further`);
  }
  for (const request of requests) {
    if (request.urgency !== 'WHENEVER') blockedBy.push(request.authorityNeeded);
  }

  return progressOf({
    milestones: layers.map((layer) => ({
      key: layer.id,
      title: layer.name,
      done: SETTLED.includes(layer.status),
      detail: layer.status === 'FROZEN' ? null : `currently ${layer.status.toLowerCase().replace(/_/g, ' ')}`,
    })),
    closed: true,
    started: layers.some(
      (layer) => SETTLED.includes(layer.status) || UNDER_WAY.includes(layer.status),
    ),
    blockedBy,
    noun: input.projectName,
  });
}

// ---------------------------------------------------------------------------
// One idea
// ---------------------------------------------------------------------------

/**
 * The pipeline every candidate walks, named once.
 *
 * This is a closed set because the pipeline is: an idea is captured, may be
 * probed, is judged, is launched as a mission, researched, audited, filed, and
 * written back. A candidate that skipped a step did not do it, and a milestone
 * list that quietly omitted the skipped ones would report every idea as
 * complete the moment it finished whatever it happened to do.
 */
export const IDEA_MILESTONES = [
  'CAPTURED',
  'LOOKED_AT',
  'JUDGED',
  'LAUNCHED',
  'RESEARCHED',
  'FILED',
] as const;

/**
 * How far along one idea is.
 *
 * Takes the rows rather than fetching them, because the Ideas view has already
 * read every candidate and its missions and a second query per idea would be a
 * fan-out nobody would notice until there were a hundred of them.
 */
export function ideaProgress(input: {
  candidate: RussellCandidate;
  missions: RussellMission[];
  hasProbe: boolean;
}): Progress {
  const { candidate, missions, hasProbe } = input;
  const launched = missions.length > 0;
  const researched = missions.some((mission) => mission.orchestrationId !== null);
  const filed = missions.some((mission) => mission.documentId !== null);

  const blockedBy: string[] = [];
  if (candidate.state === 'PARKED') blockedBy.push('this idea is parked');
  if (missions.some((mission) => mission.state === 'NEEDS_HUMAN')) {
    blockedBy.push('a decision is waiting for you');
  }

  const milestones: Milestone[] = [
    { key: 'CAPTURED', title: 'Captured', done: true, detail: null },
    {
      key: 'LOOKED_AT',
      title: 'Cheaply looked at',
      done: hasProbe,
      detail: hasProbe ? null : 'no probe has run',
    },
    {
      key: 'JUDGED',
      title: 'Judged worth doing',
      done: candidate.priority !== null,
      detail: candidate.reason,
    },
    {
      key: 'LAUNCHED',
      title: 'Work started',
      done: launched,
      detail: launched ? null : 'no mission exists yet',
    },
    {
      key: 'RESEARCHED',
      title: 'Researched',
      done: researched,
      detail: researched ? null : 'no research packet has run',
    },
    {
      key: 'FILED',
      title: 'Written down',
      done: filed,
      detail: filed ? null : 'nothing has been filed',
    },
  ];

  return progressOf({
    milestones,
    closed: true,
    started: true,
    blockedBy,
    noun: candidate.title,
  });
}

// ---------------------------------------------------------------------------
// The Brain itself
// ---------------------------------------------------------------------------

/**
 * The build, as a declared ledger.
 *
 * This is a constant rather than a query, and that is a deliberate choice with
 * a cost worth naming: it cannot notice a step closing by itself, so closing a
 * step means editing this list in a change somebody reviews. The alternative —
 * inferring build progress from row counts — would let any test fixture advance
 * the product, which is the mistake §24's acceptance scoping exists to undo.
 *
 * `done` here means the step's own closure was recorded in `CLAUDE.md`, which is
 * the same evidence a reader would check. The open step carries what it is
 * waiting on and no fraction, because its gates are proved by running the
 * acceptance reporter rather than by anything readable at request time.
 */
export const BUILD_MILESTONES: readonly Milestone[] = [
  { key: 'S1', title: 'The archive and its state engine', done: true, detail: null },
  { key: 'S2', title: 'Reading documents, and auditing what they say', done: true, detail: null },
  { key: 'S3', title: 'Research that has to prove itself', done: true, detail: null },
  { key: 'S4', title: 'Everyone who asks has a name', done: true, detail: null },
  { key: 'S5', title: 'A queue two machines can share', done: true, detail: null },
  { key: 'S6', title: 'A retry is not a second effect', done: true, detail: null },
  { key: 'S7', title: 'A door for other tools', done: true, detail: null },
  { key: 'S8', title: 'The first real worker', done: true, detail: null },
  { key: 'S9', title: 'The first real research packet', done: true, detail: null },
  { key: 'S10', title: 'Workers that start themselves', done: true, detail: null },
  { key: 'S11', title: 'A fleet, and where each job runs', done: true, detail: null },
  {
    key: 'S12A',
    title: 'Russell — a way in',
    done: false,
    detail: 'proved by the acceptance reporter, not by anything readable from here',
  },
];

/**
 * How far along the Brain build is.
 *
 * Deliberately does not read the database. Everything countable here is
 * recorded in the repository, and a build that reported itself further along
 * because somebody inserted rows would be measuring the wrong thing.
 */
export function buildProgress(): Progress {
  return progressOf({
    milestones: [...BUILD_MILESTONES],
    closed: true,
    started: true,
    blockedBy: [],
    noun: 'the Brain',
  });
}

// ---------------------------------------------------------------------------
// Active work
// ---------------------------------------------------------------------------

/**
 * How far along the work happening right now is.
 *
 * The milestone set here is *not* closed — missions arrive as Russell decides
 * they should — so this returns no ratio however tempting the arithmetic is.
 * "Four of six missions done" reads like a finish line and there is not one.
 */
export async function activeWorkProgress(projectId: string): Promise<Progress> {
  const missions = await listMissions({ projectId, limit: 200 });
  const terminal = new Set(['DONE', 'FAILED', 'CANCELLED']);
  const blockedBy = missions
    .filter((mission) => mission.state === 'NEEDS_HUMAN')
    .map((mission) => mission.waitingOn ?? mission.objective);

  return progressOf({
    milestones: missions.map((mission) => ({
      key: mission.id,
      title: mission.objective,
      done: mission.state === 'DONE',
      detail: terminal.has(mission.state) ? mission.terminalReason : mission.waitingOn,
    })),
    closed: false,
    started: missions.length > 0,
    blockedBy,
    noun: 'this work',
  });
}
