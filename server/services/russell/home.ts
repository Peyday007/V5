/**
 * Russell's home, as one projection.
 *
 * §6 fixes eight things and fixes their order: Russell's state, what it is
 * focused on, rough meaningful progress, what materially changed, what it
 * plans next, whether a person is needed, current usable power, and a way to
 * talk to it. The order is the product — a home that leads with a chart has
 * already turned into the dashboard §24 rejected — so it is composed here
 * rather than assembled by whichever component happens to render first.
 *
 * It is also the *single* projection. §6 requires one deterministic,
 * permission-aware answer for progress, status, recent changes, next action and
 * decisions across home, Work, project detail, maps and briefings. Two surfaces
 * inferring their own status from prose is how a person ends up reading two
 * different answers about one project, so everything below reuses
 * `projections.briefing`, `progress.projectProgress` and `who.whoForProject`
 * rather than recomputing any of them.
 *
 * The one thing it adds is the Pulse, and the rule for that is the rule for
 * everything else: it is read from a row, or it is absent. There is no sentence
 * in this file that Russell can say when nothing is happening.
 */
import { listMissions } from '../../repos/russellMissions.ts';
import { listCandidates } from '../../repos/russellCandidates.ts';
import { listProbesForProject } from '../../repos/russellProbes.ts';
import { getCycle } from '../../repos/russellCycle.ts';
import { listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { briefing, type Briefing } from './projections.ts';
import { whoForProject } from './who.ts';
import type { Principal, RussellCandidate, RussellMission } from '../../domain/types.ts';

/**
 * The five things Russell can be, derived from the cycle and from capacity.
 *
 * `DEGRADED` is separate from `PAUSED` because the remedies are different: a
 * paused Russell is waiting for somebody to resume it, and a degraded one is
 * running with something broken underneath. Reporting either as the other sends
 * a person to the wrong place.
 */
export const RUSSELL_STATES = ['LIVE', 'WAITING', 'LIMITED', 'PAUSED', 'DEGRADED'] as const;
export type RussellState = (typeof RUSSELL_STATES)[number];

export interface HomeView {
  /** 1. What Russell is. */
  state: RussellState;
  stateReason: string;
  /** 2-6. The briefing, in its fixed order, from the one shared projection. */
  briefing: Briefing;
  /**
   * The live line, or null.
   *
   * Null is the honest answer when nothing is running and nothing is queued,
   * and the interface renders nothing at all rather than an encouraging
   * placeholder.
   */
  pulse: string | null;
  /** 7. What can run right now, at whatever depth this caller is owed. */
  power: {
    level: 'READY' | 'LIMITED' | 'NONE' | 'UNKNOWN';
    explanation: string;
  };
  /**
   * The per-foundation strip's data comes from `briefing.progress.milestones`,
   * and is not duplicated here — one projection, one copy.
   *
   * What is here is the thing a person reads *instead of* a bare count: how
   * much genuinely accepted work exists, so a project with nothing settled and
   * fifty-seven accepted claims does not read as "nothing accomplished" (§6).
   */
  accepted: {
    conclusions: number;
    /** Null when the count could not be read, which is not zero. */
    readable: boolean;
  };
}

/**
 * What Russell is currently thinking about, from rows.
 *
 * The order is what a person would most want to know, and each branch requires
 * a row that says the thing: a running mission's own objective, a probe's own
 * candidate, an idea nobody has judged yet, a gap somebody wrote down. When
 * none of those exists the answer is `null` — there is no final branch that
 * makes something up.
 */
export function pulseOf(input: {
  running: RussellMission[];
  probing: RussellCandidate[];
  unjudged: RussellCandidate[];
  gaps: string[];
}): string | null {
  const mission = input.running[0];
  if (mission) return lowerFirst(mission.objective);
  const probe = input.probing[0];
  if (probe) return `whether ${lowerFirst(probe.title)} is worth a proper look`;
  const idea = input.unjudged[0];
  if (idea) return `what to make of ${lowerFirst(idea.title)}`;
  const gap = input.gaps[0];
  if (gap) return `how to settle ${lowerFirst(gap)}`;
  return null;
}

/**
 * Russell's own state, decided in one place.
 *
 * `PAUSED` outranks everything because it is a fact somebody stated. After
 * that, a cycle that has recorded an error is degraded whatever else is true —
 * a Russell reporting itself LIVE while its loop is throwing is the false
 * confidence this whole platform exists to prevent.
 */
export function stateOf(input: {
  cycleState: 'RUNNING' | 'PAUSED' | 'STOPPED' | null;
  cycleError: string | null;
  power: 'READY' | 'LIMITED' | 'NONE' | 'UNKNOWN';
  working: number;
  decisionsWaiting: number;
}): { state: RussellState; reason: string } {
  if (input.cycleState === 'PAUSED') {
    return { state: 'PAUSED', reason: 'Russell is paused and will not start anything new.' };
  }
  if (input.cycleState === 'STOPPED' || input.cycleState === null) {
    return { state: 'DEGRADED', reason: 'Russell’s loop is not running.' };
  }
  if (input.cycleError) {
    return { state: 'DEGRADED', reason: `Russell’s last cycle ended with a problem: ${input.cycleError}` };
  }
  if (input.power === 'NONE') {
    return { state: 'LIMITED', reason: 'There is nowhere for work to run right now.' };
  }
  if (input.working > 0) {
    return {
      state: 'LIVE',
      reason: `Russell is running ${input.working} ${input.working === 1 ? 'thing' : 'things'}.`,
    };
  }
  if (input.decisionsWaiting > 0) {
    return { state: 'WAITING', reason: 'Russell is waiting on a decision from you.' };
  }
  if (input.power === 'LIMITED') {
    return { state: 'LIMITED', reason: 'Capacity is constrained, so work is going more slowly.' };
  }
  return { state: 'WAITING', reason: 'Nothing is running; Russell is watching for something worth starting.' };
}

/**
 * The whole home, for one project and one caller.
 *
 * Returns `null` when the caller may not read the project, which the route
 * turns into the same 404 a missing project gives — absent and forbidden are
 * one answer with one body, at this door as at every other.
 */
export async function homeFor(input: {
  principal: Principal | null;
  projectId: string;
  projectName: string;
  includePrivate?: boolean;
}): Promise<HomeView | null> {
  const who = await whoForProject({ principal: input.principal, projectId: input.projectId });
  if (!who) return null;

  const [view, cycle, missions, candidates, probes] = await Promise.all([
    briefing({
      projectId: input.projectId,
      projectName: input.projectName,
      includePrivate: input.includePrivate ?? false,
    }),
    getCycle(),
    listMissions({ projectId: input.projectId, limit: 200 }),
    listCandidates({ projectId: input.projectId, limit: 200 }),
    listProbesForProject(input.projectId),
  ]);

  const running = missions.filter(
    (mission) => mission.state === 'RUNNING' || mission.state === 'LAUNCHING',
  );
  const probingIds = new Set(
    probes.filter((probe) => probe.state === 'RUNNING').map((probe) => probe.candidateId),
  );
  const probing = candidates.filter((candidate) => probingIds.has(candidate.id));
  const unjudged = candidates.filter(
    (candidate) => candidate.priority === null && candidate.state === 'CAPTURED',
  );

  /*
   * Accepted work, counted rather than translated.
   *
   * §6 forbids turning accepted claims into "a percentage of a market
   * understood". So this is the count and nothing else, and `readable` says
   * whether it could be read at all — because zero conclusions and a failed
   * read are different facts with different remedies.
   */
  let conclusions = 0;
  let readable = true;
  try {
    const accepted = await listCurrentKnowledge({
      projectId: input.projectId,
      kinds: ['CONCLUSION'],
      includePrivate: input.includePrivate ?? false,
      limit: 500,
    });
    conclusions = accepted.length;
  } catch {
    readable = false;
  }

  const { state, reason } = stateOf({
    cycleState: cycle?.state ?? null,
    cycleError: cycle?.lastError ?? null,
    power: who.capacity,
    working: running.length,
    decisionsWaiting: view.openRequests,
  });

  return {
    state,
    stateReason: reason,
    briefing: view,
    pulse: pulseOf({ running, probing, unjudged, gaps: view.openGaps }),
    power: { level: who.capacity, explanation: who.capacityExplanation },
    accepted: { conclusions, readable },
  };
}

function lowerFirst(text: string): string {
  const trimmed = text.trim().replace(/[.?!]+$/, '');
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
