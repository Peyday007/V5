/**
 * What Deal Dispatch is actually doing, read-only, with its freshness stated.
 *
 * This exists to stop the new interface making fake claims of live awareness.
 * A shell that says "Deal Dispatch is healthy" from a memory written last week
 * is worse than one that says nothing, because the reader cannot tell which it
 * is looking at — so every answer here carries **when it was observed** and
 * every failure to observe is reported as a failure rather than smoothed into
 * the last known good value.
 *
 * Three states, and the distinction between them is the whole point:
 *
 *   `CURRENT`      observed just now, with the timestamp
 *   `STALE`        this is the last thing known, and here is how old it is
 *   `UNAVAILABLE`  the source did not answer, and here is a safe reason
 *
 * **Stored memory is never presented as live state.** A `STALE` reading keeps
 * its content — it is still the best available answer and hiding it would be
 * its own kind of dishonesty — but it is labelled, and the label is not
 * optional in the type.
 *
 * Read-only in 12A. There is no code path here that writes to Deal Dispatch,
 * and adding one is a Step 12B decision with its own authority question.
 */
import { getProjectBySlug } from '../../repos/projects.ts';
import { listLayers } from '../../repos/layers.ts';
import { listEvents } from '../../repos/events.ts';
import { listCurrentKnowledge } from '../../repos/russellMissions.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { nowIso } from '../../repos/util.ts';
import type { LayerStatus } from '../../domain/types.ts';

export const DEAL_DISPATCH_SLUG = 'deal-dispatch';

/** How old an observation may be before it stops being called current. */
export const FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

export type Freshness = 'CURRENT' | 'STALE' | 'UNAVAILABLE';

export interface ConnectedSystemView {
  freshness: Freshness;
  /** When this was read. Always present, including on a stale answer. */
  observedAt: string | null;
  /** Safe to show. Names what went wrong, never a credential or an internal id. */
  reason: string | null;
  purpose: string | null;
  /** What is being worked on, in the layer's own plain name. */
  activeWork: { name: string; state: string }[];
  blocked: { name: string; state: string }[];
  recentChange: string | null;
  /** Counts, not contents: the contents are behind their own authorization. */
  knowledgeCount: number;
  openMissionCount: number;
}

/**
 * Human-facing layer names.
 *
 * One mapping, tested, rather than the same translation scattered through
 * components. A person asked what Brain is working on should hear "how the
 * money works", not "Monetization Logic v1C" — and a layer this does not know
 * about falls back to its own name rather than to a guess.
 */
export const LAYER_MEANINGS: Record<string, string> = {
  'World Model': 'How the market works',
  Taxonomy: 'The different kinds of deals',
  'Monetization Logic': 'How the money works',
  'Discovery Logic': 'How we find opportunities',
  'Qualification Logic': 'Which opportunities are worth it',
  'Execution Playbooks': 'How we actually do them',
  'Decision Routing Rules': 'What Brain should do next',
  'Learning Evaluation': 'How Brain learns what works',
};

export function plainLayerName(name: string): string {
  return LAYER_MEANINGS[name] ?? name;
}

/** Layer states that mean work is happening or waiting to. */
const ACTIVE: readonly LayerStatus[] = [
  'RESEARCHING',
  'AUDITING',
  'AUDIT_READY',
  'MORE_RESEARCH_REQUIRED',
  'SYNTHESIS_READY',
  'SYNTHESIS_RUNNING',
];
const BLOCKED: readonly LayerStatus[] = ['BLOCKED'];

/** Plain words for a layer's state. Never the enum, which is not product copy. */
function plainState(status: LayerStatus): string {
  switch (status) {
    case 'MORE_RESEARCH_REQUIRED':
      return 'needs stronger evidence';
    case 'AUDIT_READY':
      return 'waiting to be checked';
    case 'RESEARCHING':
      return 'being researched';
    case 'AUDITING':
      return 'being checked';
    case 'SYNTHESIS_READY':
      return 'ready to pull together';
    case 'SYNTHESIS_RUNNING':
      return 'being pulled together';
    case 'INCOMPLETE':
      return 'started but unfinished';
    case 'REOPENED':
      return 'reopened';
    case 'PARKED':
      return 'parked';
    case 'BLOCKED':
      return 'blocked';
    case 'FROZEN':
      return 'settled';
    case 'NOT_STARTED':
    default:
      return 'not started';
  }
}

/**
 * Read the connected system.
 *
 * Everything comes from rows this Brain owns, so "unavailable" here means the
 * project itself could not be read rather than that a remote host was down —
 * which is the honest shape for 12A, where Deal Dispatch is a project inside
 * this Brain rather than a separate deployment behind an API. When it becomes
 * one, the failure modes change and the three states are already the vocabulary
 * for them.
 */
export async function readDealDispatch(input: {
  slug?: string;
  /** A previously stored reading, for the stale path. */
  lastKnown?: ConnectedSystemView | null;
  at?: string;
} = {}): Promise<ConnectedSystemView> {
  const at = input.at ?? nowIso();
  const slug = input.slug ?? DEAL_DISPATCH_SLUG;

  let project;
  try {
    project = await getProjectBySlug(slug);
  } catch {
    return unavailable('the connected system could not be read', input.lastKnown, at);
  }
  if (!project) {
    return unavailable('the connected system is not configured here', input.lastKnown, at);
  }

  const layers = await listLayers(project.id);
  const events = await listEvents(project.id, 5);
  const knowledge = await listCurrentKnowledge({ projectId: project.id, limit: 1000 });
  const missions = await listMissions({
    projectId: project.id,
    states: ['PLANNED', 'LAUNCHING', 'RUNNING', 'WAITING', 'NEEDS_HUMAN'],
  });

  return {
    freshness: 'CURRENT',
    observedAt: at,
    reason: null,
    purpose: project.description ?? null,
    activeWork: layers
      .filter((layer) => ACTIVE.includes(layer.status))
      .map((layer) => ({ name: plainLayerName(layer.name), state: plainState(layer.status) })),
    blocked: layers
      .filter((layer) => BLOCKED.includes(layer.status))
      .map((layer) => ({ name: plainLayerName(layer.name), state: plainState(layer.status) })),
    recentChange: events[0]?.eventType ? describeEvent(events[0]!.eventType) : null,
    knowledgeCount: knowledge.length,
    openMissionCount: missions.length,
  };
}

/**
 * The unavailable path, which keeps the last known reading rather than blanking.
 *
 * A stale answer with its age is more useful than an empty one and is still
 * honest, *because it is labelled*. What must never happen is the last reading
 * being returned as `CURRENT`, and the only way to do that here would be to
 * construct the object by hand — which is why this is the one function that
 * builds it.
 */
function unavailable(
  reason: string,
  lastKnown: ConnectedSystemView | null | undefined,
  at: string,
): ConnectedSystemView {
  if (lastKnown && lastKnown.observedAt) {
    return { ...lastKnown, freshness: 'STALE', reason, observedAt: lastKnown.observedAt };
  }
  return {
    freshness: 'UNAVAILABLE',
    observedAt: null,
    reason,
    purpose: null,
    activeWork: [],
    blocked: [],
    recentChange: null,
    knowledgeCount: 0,
    openMissionCount: 0,
  };
}

/**
 * Has this reading aged out?
 *
 * Compared against the Brain's clock, and it downgrades rather than discards: a
 * reading that was current ten minutes ago is still the best answer available,
 * and it stops being called current.
 */
export function ageFreshness(view: ConnectedSystemView, at?: string): ConnectedSystemView {
  if (view.freshness !== 'CURRENT' || !view.observedAt) return view;
  const now = Date.parse(at ?? nowIso());
  if (now - Date.parse(view.observedAt) <= FRESHNESS_WINDOW_MS) return view;
  return { ...view, freshness: 'STALE', reason: 'this is the last reading, not a live one' };
}

/** Plain words for the event types worth mentioning. Anything else is skipped. */
function describeEvent(eventType: string): string | null {
  switch (eventType) {
    case 'RUSSELL_MISSION_WRITEBACK':
      return 'a piece of research finished and changed what the project believes';
    case 'DOCUMENT_IMPORTED':
    case 'DOCUMENT_COMPLETED':
      return 'a new document was filed';
    case 'LAYER_FROZEN':
      return 'a layer was settled';
    case 'AUDIT_RECORDED':
      return 'an audit was recorded';
    default:
      return null;
  }
}
