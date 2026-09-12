/**
 * Why this matters.
 *
 * §19 asks for a subtle, private, non-gamified space that may surface long-term
 * ambitions, meaningful milestones, how current work connects to the larger
 * vision, and progress Brain noticed — with an explicit prohibition on streaks,
 * badges, points, confetti and productivity clichés.
 *
 * The prohibition is the easy half. The hard half is that everything here has
 * to be *true*, and the failure mode of an encouragement feature is precisely
 * that it becomes encouraging before it becomes accurate. So every line below
 * is derived from a row that means something on its own:
 *
 *   - a **frozen layer** is a foundation the audit pipeline settled;
 *   - a **filed document** is bytes in the store with an audit behind it;
 *   - an **accepted conclusion** cleared the evidence gate;
 *   - a **resolved frontier item** is an edge the project no longer has.
 *
 * There is no code path that counts consecutive days, awards anything, or
 * congratulates somebody for opening the page. When nothing has happened, this
 * returns nothing at all — a quiet screen is the honest one, and an
 * encouraging screen over an empty project is the exact thing that makes a
 * person stop believing the rest of the product.
 */
import { listLayers } from '../../repos/layers.ts';
import { listCurrentKnowledge, listMissions } from '../../repos/russellMissions.ts';
import { listFrontier } from '../../repos/russellFrontier.ts';
import { plainLayerName } from './dealDispatch.ts';
import type { RussellMission } from '../../domain/types.ts';

/** One thing that genuinely happened, in the words of the row behind it. */
export interface Milestone {
  /** LAYER_SETTLED | REPORT_FILED | CONCLUSION_ACCEPTED | EDGE_CLOSED */
  kind: string;
  what: string;
  /** When, so nothing here can quietly describe something from March as new. */
  at: string;
  /** The row it came from, so a reader can check rather than trust. */
  sourceId: string;
}

export interface WhyThisMatters {
  /**
   * What the project is trying to become, in its own recorded words.
   *
   * Null when nobody has said. There is no branch that invents an ambition —
   * a made-up purpose is worse than a missing one, because it is the sort of
   * thing a person would quote back later.
   */
  ambition: string | null;
  /** What has actually happened, newest first. Empty when nothing has. */
  milestones: Milestone[];
  /**
   * How what is running now connects to the ambition.
   *
   * Composed only when there *is* an ambition and there *is* work: a
   * connection between two things one of which does not exist is a sentence
   * with nothing in it.
   */
  connection: string | null;
  /**
   * One short observation, or nothing.
   *
   * The rule this obeys is the one that makes the whole feature survivable: it
   * is absent far more often than it is present. A message every time somebody
   * opens the page is noise, and noise is what a person learns to skip.
   */
  note: string | null;
}

/**
 * Whether there is anything worth saying at all.
 *
 * Deliberately strict: two milestones, or one milestone and an ambition.
 * A single event on a new project is not a story, and presenting it as one is
 * the productivity cliché §19 rules out wearing different clothes.
 */
export function worthSurfacing(view: WhyThisMatters): boolean {
  if (view.milestones.length >= 2) return true;
  return view.milestones.length === 1 && view.ambition !== null;
}

/**
 * The note, from what the milestones actually are.
 *
 * Every branch names something countable, and the function returns null far
 * more often than it returns a sentence. Nothing here compares this week to
 * last week, because that comparison is a streak by another name.
 */
export function noteFor(input: {
  milestones: Milestone[];
  ambition: string | null;
  workingNow: number;
}): string | null {
  const settled = input.milestones.filter((milestone) => milestone.kind === 'LAYER_SETTLED');
  const filed = input.milestones.filter((milestone) => milestone.kind === 'REPORT_FILED');
  const closed = input.milestones.filter((milestone) => milestone.kind === 'EDGE_CLOSED');

  if (settled.length >= 2) {
    return `Two foundations are settled now — ${settled[0]!.what} and ${settled[1]!.what}. Those are the parts the rest can be built on.`;
  }
  if (filed.length >= 2) {
    return `${filed.length} reports have been filed and audited here. That is evidence somebody can act on rather than an impression.`;
  }
  if (closed.length >= 2 && input.ambition) {
    return `${closed.length} questions that were open are not any more. The edge of what this project does not know has moved.`;
  }
  if (settled.length === 1 && input.workingNow > 0) {
    return `${settled[0]!.what} is settled, and work is continuing on what depends on it.`;
  }
  // Far more often than not, there is nothing worth saying, and that is the
  // correct answer rather than a gap to fill.
  return null;
}

/**
 * Read one project's story, from rows.
 *
 * Private to the person who asks, in the sense that it never reads knowledge
 * they may not see: `includePrivate` is false by default and the caller is the
 * one that decides, from the authenticated principal.
 */
export async function whyThisMatters(input: {
  projectId: string;
  projectName: string;
  includePrivate?: boolean;
  limit?: number;
}): Promise<WhyThisMatters> {
  const limit = Math.min(20, Math.max(1, input.limit ?? 6));
  const [layers, conclusions, missions, frontier] = await Promise.all([
    listLayers(input.projectId),
    listCurrentKnowledge({
      projectId: input.projectId,
      kinds: ['CONCLUSION'],
      includePrivate: input.includePrivate ?? false,
      limit: 50,
    }),
    listMissions({ projectId: input.projectId, limit: 200 }),
    listFrontier({
      projectId: input.projectId,
      includeResolved: true,
      includePrivate: input.includePrivate ?? false,
    }),
  ]);

  const milestones: Milestone[] = [];

  for (const layer of layers) {
    if (layer.status !== 'FROZEN') continue;
    milestones.push({
      kind: 'LAYER_SETTLED',
      what: plainLayerName(layer.name),
      at: layer.updatedAt,
      sourceId: layer.id,
    });
  }

  for (const mission of missions) {
    if (!mission.documentId || mission.state !== 'DONE') continue;
    milestones.push({
      kind: 'REPORT_FILED',
      what: mission.objective,
      at: mission.completedAt ?? mission.updatedAt,
      sourceId: mission.documentId,
    });
  }

  for (const conclusion of conclusions) {
    if (conclusion.confidence !== 'ESTABLISHED') continue;
    milestones.push({
      kind: 'CONCLUSION_ACCEPTED',
      what: conclusion.statement,
      at: conclusion.updatedAt,
      sourceId: conclusion.id,
    });
  }

  for (const item of frontier) {
    if (item.resolvedAt === null) continue;
    if (item.region !== 'OPEN_QUESTION') continue;
    milestones.push({
      kind: 'EDGE_CLOSED',
      what: item.subject,
      at: item.resolvedAt,
      sourceId: item.id,
    });
  }

  milestones.sort((left, right) => right.at.localeCompare(left.at));
  const recent = milestones.slice(0, limit);

  /*
   * The ambition, read rather than composed.
   *
   * A project's own recorded decision about what it is for is the only thing
   * that can stand here. `DECISION` rows are what a person or the pipeline
   * actually settled; anything else would be this module deciding what somebody
   * else's project is about.
   */
  const decisions = await listCurrentKnowledge({
    projectId: input.projectId,
    kinds: ['DECISION'],
    includePrivate: input.includePrivate ?? false,
    limit: 1,
  });
  const ambition = decisions[0]?.statement ?? null;

  const working = missions.filter(
    (mission: RussellMission) => mission.state === 'RUNNING' || mission.state === 'LAUNCHING',
  );

  return {
    ambition,
    milestones: recent,
    connection:
      ambition && working[0]
        ? `What is running now — ${working[0].objective} — is part of ${lowerFirst(ambition)}`
        : null,
    note: noteFor({ milestones: recent, ambition, workingNow: working.length }),
  };
}

function lowerFirst(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const ended = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return ended.charAt(0).toLowerCase() + ended.slice(1);
}
