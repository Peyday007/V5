/**
 * Which project a conversation is about.
 *
 * The capability is "recognise Deal Dispatch from what I said", and the danger
 * is the same shape as every other retrieval question in this codebase: the set
 * of things considered has to be the set the asker may see, decided before the
 * comparison rather than filtered after it. A router that scored every project
 * and then removed the forbidden ones would leak through the ranking, the
 * timing and the "did you mean…" question, none of which are content.
 *
 * So `candidateProjects` asks `decideProjectAccess` first, and an unauthorized
 * project is absent rather than refused — §17's rule that a resource you may
 * not have is reported as one that does not exist, applied to a router.
 *
 * The scoring itself is deterministic and deliberately modest. It reads the
 * project's own name, slug and layer names out of the database, and it reads
 * the person's past corrections. It is not a model, and it is not pretending to
 * be one: a model's judgment arrives through the turn's structured proposal and
 * is *validated against this*, because the model may propose a project and may
 * not be trusted about whether the asker is allowed to see it.
 *
 * **A correction outranks a match.** If a person has said before that a message
 * of this shape is not about a project, that is stronger evidence than the
 * project's name appearing in the text — which is the difference between
 * learning from a correction and merely being told once.
 */
import { listProjects } from '../../repos/projects.ts';
import { listLayers } from '../../repos/layers.ts';
import { listCorrections } from '../../repos/russellConversations.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { fingerprintOf } from '../../repos/russellCandidates.ts';
import type { Principal } from '../../domain/types.ts';

/** Below this, Russell asks rather than attaches. */
export const ATTACH_CONFIDENCE_FLOOR = 55;
/** Below this, Russell does not even offer a suggestion. */
export const SUGGEST_CONFIDENCE_FLOOR = 25;

export interface RouteOption {
  projectId: string;
  projectName: string;
  confidence: number;
  /** Plain, and safe to show: it names evidence rather than a score. */
  reason: string;
}

export interface RouteDecision {
  /** The project to attach to, or null when Russell should ask instead. */
  projectId: string | null;
  confidence: number;
  reason: string;
  /** What Russell would offer if it has to ask. Authorized projects only. */
  options: RouteOption[];
  /** True when the gap between the best two is too small to choose. */
  ambiguous: boolean;
}

interface Scored {
  projectId: string;
  projectName: string;
  score: number;
  evidence: string[];
}

/** The projects this principal may actually converse about. */
export async function candidateProjects(principal: Principal): Promise<
  { id: string; name: string; slug: string }[]
> {
  const all = await listProjects();
  const allowed: { id: string; name: string; slug: string }[] = [];
  for (const project of all) {
    // READ, because routing a conversation is reading which projects exist for
    // this person. Anything a VIEWER may open, Russell may route to.
    if (decideProjectAccess(principal, project.id, 'READ').allowed) {
      allowed.push({ id: project.id, name: project.name, slug: project.slug });
    }
  }
  return allowed;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

/**
 * Score one project against the message.
 *
 * Names are worth more than layer words, and a whole-phrase hit is worth more
 * than a token overlap, because "Deal Dispatch" appearing verbatim is a much
 * stronger signal than the word "dispatch" appearing anywhere. Every
 * contribution appends a sentence to `evidence`, so the reason Russell gives is
 * assembled from what actually matched rather than written afterwards.
 */
async function score(
  project: { id: string; name: string; slug: string },
  message: string,
): Promise<Scored> {
  const lower = message.toLowerCase();
  const words = tokens(message);
  const evidence: string[] = [];
  let points = 0;

  if (lower.includes(project.name.toLowerCase())) {
    points += 60;
    evidence.push(`it names ${project.name}`);
  } else {
    const nameWords = tokens(project.name);
    const overlap = [...nameWords].filter((word) => words.has(word));
    if (overlap.length > 0 && overlap.length === nameWords.size) {
      points += 35;
      evidence.push(`every word of ${project.name} appears`);
    } else if (overlap.length > 0) {
      points += 12 * overlap.length;
      evidence.push(`it mentions ${overlap.join(' and ')}`);
    }
  }

  for (const layer of await listLayers(project.id)) {
    if (lower.includes(layer.name.toLowerCase())) {
      points += 30;
      evidence.push(`it names the ${layer.name} layer`);
      continue;
    }
    const layerWords = tokens(layer.name);
    const overlap = [...layerWords].filter((word) => words.has(word));
    if (layerWords.size > 0 && overlap.length === layerWords.size) {
      points += 15;
      evidence.push(`it covers ${layer.name}`);
    }
  }

  return { projectId: project.id, projectName: project.name, score: points, evidence };
}

/**
 * Choose a project for this message, or decide to ask.
 *
 * The returned `options` are always authorized, so a caller may render them
 * without a second filter. When Russell is not confident enough it returns a
 * null project and the options it would offer; when two projects are within a
 * few points of each other it says so, because picking the higher one there is
 * guessing with a confident face on.
 */
export async function routeMessage(input: {
  principal: Principal;
  message: string;
  /** Corrections this person has made before. Loaded when not supplied. */
  correctionsFor?: { projectId: string | null; reason: string }[];
}): Promise<RouteDecision> {
  const projects = await candidateProjects(input.principal);
  if (projects.length === 0) {
    return {
      projectId: null,
      confidence: 0,
      reason: 'there is no project here to attach this to',
      options: [],
      ambiguous: false,
    };
  }

  const scored = await Promise.all(projects.map((project) => score(project, input.message)));

  /*
   * Corrections, applied after scoring rather than mixed into it.
   *
   * A person who has previously said "this is not about that project" for a
   * message of the same shape is better evidence than a name match, so it
   * subtracts hard — enough to move a confident wrong answer below the floor.
   * Keeping it separate from the match score is what lets the reason say which
   * of the two decided.
   */
  const corrections =
    input.correctionsFor ??
    (await listCorrections(input.principal.id)).map((row) => ({
      projectId: row.projectId,
      reason: row.reason,
    }));
  const fingerprint = fingerprintOf(input.message);
  for (const entry of scored) {
    const contradicted = corrections.some(
      (correction) =>
        correction.projectId !== entry.projectId &&
        fingerprintOf(correction.reason).length > 0 &&
        fingerprint.length > 0 &&
        sharesWords(correction.reason, input.message),
    );
    if (contradicted) {
      entry.score -= 40;
      entry.evidence.push('a person corrected a similar routing before');
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const runnerUp = scored[1];

  const confidence = Math.max(0, Math.min(100, best.score));
  const options: RouteOption[] = scored
    .filter((entry) => entry.score >= SUGGEST_CONFIDENCE_FLOOR)
    .slice(0, 3)
    .map((entry) => ({
      projectId: entry.projectId,
      projectName: entry.projectName,
      confidence: Math.max(0, Math.min(100, entry.score)),
      reason: entry.evidence.join('; ') || 'no strong signal',
    }));

  const ambiguous =
    runnerUp !== undefined && best.score > 0 && best.score - runnerUp.score < 15;

  if (confidence < ATTACH_CONFIDENCE_FLOOR || ambiguous) {
    return {
      projectId: null,
      confidence,
      reason: ambiguous
        ? 'two projects fit this about equally well'
        : 'nothing in the message points clearly at one project',
      options,
      ambiguous,
    };
  }

  return {
    projectId: best.projectId,
    confidence,
    reason: best.evidence.join('; '),
    options,
    ambiguous: false,
  };
}

/** Do two texts share a meaningful word? Cheap, and only used as a hint. */
function sharesWords(a: string, b: string): boolean {
  const left = tokens(a);
  const right = tokens(b);
  for (const word of left) if (right.has(word)) return true;
  return false;
}

/**
 * Is a project the model proposed one this principal may actually have?
 *
 * The turn's structured response may name a project. It is a *proposal*: the
 * model has read the conversation and may be right, and it has no business
 * deciding whether the asker is allowed to see what it named. So every proposed
 * id passes through here, and one that fails is treated as absent rather than
 * refused — the model learns nothing about which ids exist.
 */
export function proposalIsAuthorized(principal: Principal, projectId: string): boolean {
  return decideProjectAccess(principal, projectId, 'READ').allowed;
}
