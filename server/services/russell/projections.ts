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
 * halfway; a layer with an unknown amount of work left is not. So
 * `roughProgress` returns a milestone-backed phrase or a **non-numeric** one,
 * and there is no code path that turns a feeling into a percentage.
 *
 * The other rule is order. Every ordinary update answers, in this sequence:
 * what changed, why it matters, what Russell is doing next, and whether the
 * person is needed. `briefing()` composes exactly those four and nothing else,
 * because a briefing that leads with an orchestration id has already lost.
 */
import { listLayers } from '../../repos/layers.ts';
import { groupOf, listMissions, listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { listOpenRequests } from '../../repos/russellMissions.ts';
import { plainLayerName } from './dealDispatch.ts';
import type { LayerStatus, RussellMission } from '../../domain/types.ts';

export interface Briefing {
  /** One line: what Russell is on. */
  focus: string;
  /** Meaningful progress, milestone-backed or deliberately non-numeric. */
  progress: string;
  /** The most recent thing worth telling somebody. Null when there is none. */
  latest: string | null;
  /** What Russell intends to do next, or what it is watching. */
  next: string;
  /** Whether a person is actually needed, and for what. */
  needsYou: string;
  /** How many open human decisions there are, for a badge. */
  openRequests: number;
}

/** Layer states that count as settled, for a milestone ratio. */
const SETTLED: readonly LayerStatus[] = ['FROZEN'];
/** Layer states that count as genuinely under way. */
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
 * Meaningful progress, or an honest refusal to quantify it.
 *
 * The ratio is over *defined milestones* — the project's own layers, which are
 * a fixed and declared set — so "three of eight settled" is a fact rather than
 * an impression. Anything less structured gets words instead, and the words are
 * chosen so that none of them implies a fraction.
 */
export function roughProgress(input: {
  settled: number;
  underWay: number;
  total: number;
}): string {
  const { settled, underWay, total } = input;
  if (total === 0) return 'Nothing is mapped out yet.';
  if (settled === 0 && underWay === 0) return 'Nothing has been started yet.';
  if (settled === total) return 'Every part of this is settled.';

  const ratio = settled / total;
  // Only these five phrases, and each one is a range over a counted ratio. A
  // sixth that said "about 62%" would be inventing precision the milestones do
  // not have.
  const shape =
    ratio === 0
      ? 'The early parts are still forming'
      : ratio < 0.25
        ? 'A small part of this is settled'
        : ratio < 0.45
          ? 'Some of this is settled'
          : ratio < 0.7
            ? 'About halfway through'
            : 'Most of this is settled';

  return underWay > 0
    ? `${shape}, and ${underWay} ${underWay === 1 ? 'part is' : 'parts are'} being worked on.`
    : `${shape}.`;
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
  const [layers, missions, knowledge, requests] = await Promise.all([
    listLayers(input.projectId),
    listMissions({ projectId: input.projectId }),
    listCurrentKnowledge({
      projectId: input.projectId,
      kinds: ['CONCLUSION'],
      includePrivate: input.includePrivate ?? false,
      limit: 5,
    }),
    listOpenRequests(input.projectId),
  ]);

  const settled = layers.filter((layer) => SETTLED.includes(layer.status)).length;
  const underWay = layers.filter((layer) => UNDER_WAY.includes(layer.status)).length;

  const blocking = requests.filter((request) => request.urgency !== 'WHENEVER');

  return {
    focus: focusOf(input.projectName, missions),
    progress: roughProgress({ settled, underWay, total: layers.length }),
    latest: knowledge[0]?.statement ?? null,
    next: nextOf(missions),
    // The honest default is that a person is *not* needed. Saying otherwise
    // when nothing is blocked trains people to ignore the one time it matters.
    needsYou:
      requests.length === 0
        ? 'You are not needed.'
        : blocking.length > 0
          ? `You are needed: ${blocking.length} ${blocking.length === 1 ? 'decision is' : 'decisions are'} holding work up.`
          : `${requests.length} ${requests.length === 1 ? 'decision is' : 'decisions are'} waiting whenever you have a moment.`,
    openRequests: requests.length,
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
