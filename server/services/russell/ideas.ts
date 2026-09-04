/**
 * The shape of a project — sites, major ideas, ordinary ideas, and what
 * connects them.
 *
 * One projection serves two surfaces on purpose. The Ideas list and the living
 * constellation are the same facts read at different resolutions, and building
 * them separately is how a map ends up showing something the list denies. So
 * this returns nodes and edges; the list renders the nodes, the map lays them
 * out, and the map's accessible fallback is the list. There is no second source
 * of truth for either.
 *
 * The ownership structure is a **tree** — site, major idea, ordinary idea —
 * because ownership has to be unambiguous for a breadcrumb to mean anything.
 * The things that genuinely cross branches are **edges**, so one idea can feed
 * three others without being duplicated into three places and then disagreeing
 * with itself.
 *
 * What each level actually is, in rows:
 *
 *   - a **site** is a project;
 *   - a **major idea** is a layer, which is a declared set fixed when the
 *     project was created — which is exactly why progress over it is a fraction
 *     rather than an impression;
 *   - an **ordinary idea** is a candidate Russell captured.
 *
 * A candidate is filed under the layer its own missions name. One that has no
 * mission yet is filed under nothing and says so, because §11's rule holds here
 * too: forcing it into one heading would file it under the wrong one, and a
 * guess that renders tidily is still a guess.
 */
import { listLayers } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import { listCandidates } from '../../repos/russellCandidates.ts';
import { listProbesForProject } from '../../repos/russellProbes.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { listDependenciesForProject } from '../../repos/dependencies.ts';
import { countVisibleConversationsForProject } from '../../repos/russellConversations.ts';
import { knowsForProject } from './knows.ts';
import { plainLayerName } from './dealDispatch.ts';
import { ideaProgress, progressOf, type Progress } from './progress.ts';
import { CANDIDATE_PRIORITY_LABELS } from '../../domain/types.ts';
import type {
  CandidatePriority,
  LayerStatus,
  RussellCandidate,
  RussellMission,
} from '../../domain/types.ts';

export type IdeaLevel = 'SITE' | 'MAJOR' | 'REGULAR';

/** Why two nodes are connected, from the rows that connect them. */
export type IdeaEdgeKind = 'CONTAINS' | 'FEEDS' | 'SUPPORTED_BY' | 'CONTRADICTED_BY';

export interface IdeaEdge {
  from: string;
  to: string;
  kind: IdeaEdgeKind;
  /** The sentence a person reads on the edge. Never composed in the client. */
  reason: string;
}

/**
 * What a node has to be able to say about itself.
 *
 * Every field is either a row or null. In particular `why` is the row's own
 * words — a layer's notes, a candidate's reason — and is null when nothing was
 * recorded, rather than a sentence invented to fill the card.
 */
export interface IdeaNode {
  /** `site:<id>`, `major:<id>`, `idea:<id>` — derived, never allocated. */
  id: string;
  level: IdeaLevel;
  parentId: string | null;
  title: string;
  /** What it is for. */
  purpose: string | null;
  /** Why it matters, in Russell's or the row's own words. */
  why: string | null;
  /** The row's own state, unmodified, beside the words a person reads. */
  state: string;
  stateLabel: string;
  progress: Progress;
  priority: CandidatePriority | null;
  priorityLabel: string | null;
  counts: {
    /** Accepted and provisional things known here. */
    knowledge: number;
    /** Gaps, unknowns and contradictions recorded here. */
    unknowns: number;
    /** Missions attached here, in any state. */
    work: number;
    /** Conversations attached here. */
    conversations: number;
    /** Ordinary ideas beneath it. Zero is a real answer. */
    children: number;
  };
  /** The authoritative rows behind it, for a reader who wants to walk back. */
  links: {
    projectId: string | null;
    layerId: string | null;
    candidateId: string | null;
    conversationId: string | null;
  };
}

export interface IdeaMap {
  nodes: IdeaNode[];
  edges: IdeaEdge[];
  /** The node a map opens on. Always the site. */
  rootId: string;
}

/** Plain words for a candidate's state. The enum is not product copy. */
export function plainCandidateState(state: string): string {
  switch (state) {
    case 'CAPTURED':
      return 'Captured';
    case 'PROBING':
      return 'Being looked at';
    case 'PROMOTED':
      return 'Worth doing';
    case 'QUEUED':
      return 'Queued';
    case 'PARKED':
      return 'Parked';
    case 'REJECTED':
      return 'Set aside';
    case 'MERGED':
      return 'Merged into another idea';
    case 'DONE':
      return 'Finished';
    default:
      return state;
  }
}

/** Plain words for a layer's state, for the same reason. */
export function plainLayerState(status: LayerStatus): string {
  switch (status) {
    case 'NOT_STARTED':
      return 'Not started';
    case 'RESEARCHING':
      return 'Being researched';
    case 'INCOMPLETE':
      return 'Started, not finished';
    case 'BLOCKED':
      return 'Blocked';
    case 'AUDIT_READY':
      return 'Ready to be checked';
    case 'AUDITING':
      return 'Being checked';
    case 'MORE_RESEARCH_REQUIRED':
      return 'Needs stronger evidence';
    case 'SYNTHESIS_READY':
      return 'Ready to be written up';
    case 'SYNTHESIS_RUNNING':
      return 'Being written up';
    case 'FROZEN':
      return 'Settled';
    case 'REOPENED':
      return 'Reopened';
    case 'PARKED':
      return 'Parked';
    default:
      return status;
  }
}

/**
 * Which layer an idea belongs under, from its own missions.
 *
 * Missions carry a `layer_id`; candidates do not. So the answer is a fact about
 * the work that was actually launched for the idea, which is the strongest
 * evidence available and is null when there is none.
 */
function layerOfCandidate(candidateId: string, missions: RussellMission[]): string | null {
  for (const mission of missions) {
    if (mission.candidateId === candidateId && mission.layerId) return mission.layerId;
  }
  return null;
}

/**
 * The whole shape of one project.
 *
 * Reads eight authoritative sources once each and joins them in memory rather
 * than per node — a map with forty ideas would otherwise be forty round trips
 * for probes alone. Nothing here writes.
 */
export async function ideaMapForProject(input: {
  projectId: string;
  /**
   * Whose view this is. Required, because two of the numbers on the site card
   * are counts, and a count computed without a viewer is a count that leaks.
   */
  viewerUserId: string;
  includePrivate?: boolean;
}): Promise<IdeaMap | null> {
  const project = await getProject(input.projectId);
  if (!project) return null;

  const [layers, candidates, probes, missions, dependencies, knows, conversationCount] =
    await Promise.all([
      listLayers(project.id),
      listCandidates({ projectId: project.id, limit: 500 }),
      listProbesForProject(project.id),
      listMissions({ projectId: project.id, limit: 500 }),
      listDependenciesForProject(project.id),
      knowsForProject({
        projectId: project.id,
        includePrivate: input.includePrivate ?? false,
        limit: 500,
      }),
      countVisibleConversationsForProject(project.id, input.viewerUserId),
    ]);

  const probedCandidates = new Set(probes.map((probe) => probe.candidateId));
  const nodes: IdeaNode[] = [];
  const edges: IdeaEdge[] = [];

  const siteId = `site:${project.id}`;
  const childrenOfLayer = new Map<string, number>();

  /* ------------------------------------------------------------------ *
   * Ordinary ideas first, so the majors can count their own children.
   * ------------------------------------------------------------------ */
  const ideaNodes: IdeaNode[] = [];
  for (const candidate of candidates) {
    const own = missions.filter((mission) => mission.candidateId === candidate.id);
    const layerId = layerOfCandidate(candidate.id, missions);
    if (layerId) childrenOfLayer.set(layerId, (childrenOfLayer.get(layerId) ?? 0) + 1);

    ideaNodes.push({
      id: `idea:${candidate.id}`,
      level: 'REGULAR',
      // An idea nobody has launched work for hangs off the site, which is where
      // it honestly is: captured, and not yet filed under anything.
      parentId: layerId ? `major:${layerId}` : siteId,
      title: candidate.title,
      purpose: candidate.statement,
      why: candidate.reason,
      state: candidate.state,
      stateLabel: plainCandidateState(candidate.state),
      progress: ideaProgress({
        candidate,
        missions: own,
        hasProbe: probedCandidates.has(candidate.id),
      }),
      priority: candidate.priority,
      priorityLabel: candidate.priority
        ? CANDIDATE_PRIORITY_LABELS[candidate.priority]
        : null,
      counts: {
        knowledge: candidate.supporting.length,
        unknowns: candidate.contradicting.length,
        work: own.length,
        conversations: candidate.conversationId ? 1 : 0,
        children: 0,
      },
      links: {
        projectId: project.id,
        layerId,
        candidateId: candidate.id,
        conversationId: candidate.conversationId,
      },
    });

    for (const supportingId of candidate.supporting) {
      edges.push({
        from: `idea:${candidate.id}`,
        to: `knowledge:${supportingId}`,
        kind: 'SUPPORTED_BY',
        reason: 'something the Brain already knows supports this',
      });
    }
    for (const contradictingId of candidate.contradicting) {
      edges.push({
        from: `idea:${candidate.id}`,
        to: `knowledge:${contradictingId}`,
        kind: 'CONTRADICTED_BY',
        reason: 'something the Brain already knows argues against this',
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Major ideas.
   * ------------------------------------------------------------------ */
  for (const layer of layers) {
    const layerKnows = knows.filter((entry) => entry.layerId === layer.id);
    const layerMissions = missions.filter((mission) => mission.layerId === layer.id);
    const versions = layer.expectedVersions;

    nodes.push({
      id: `major:${layer.id}`,
      level: 'MAJOR',
      parentId: siteId,
      title: plainLayerName(layer.name),
      purpose: layer.notes,
      why: null,
      state: layer.status,
      stateLabel: plainLayerState(layer.status),
      // The declared version list *is* this layer's milestone set, so the
      // fraction is over something the project itself fixed. A layer with no
      // declared versions gets no fraction rather than a made-up denominator.
      progress: progressOf({
        milestones: versions.map((version) => ({
          key: `${layer.id}:${version}`,
          title: version,
          done:
            layer.currentVersion !== null &&
            versions.indexOf(version) <= versions.indexOf(layer.currentVersion),
          detail: null,
        })),
        closed: versions.length > 0,
        started: layer.status !== 'NOT_STARTED',
        blockedBy: layer.status === 'BLOCKED' ? ['this part cannot go further'] : [],
        noun: plainLayerName(layer.name),
      }),
      priority: null,
      priorityLabel: null,
      counts: {
        knowledge: layerKnows.filter(
          (entry) => entry.kind === 'CONCLUSION' || entry.kind === 'DECISION',
        ).length,
        unknowns: layerKnows.filter(
          (entry) =>
            entry.kind === 'GAP' || entry.kind === 'UNKNOWN' || entry.kind === 'CONTRADICTION',
        ).length,
        work: layerMissions.length,
        conversations: 0,
        children: childrenOfLayer.get(layer.id) ?? 0,
      },
      links: {
        projectId: project.id,
        layerId: layer.id,
        candidateId: null,
        conversationId: null,
      },
    });

    edges.push({
      from: siteId,
      to: `major:${layer.id}`,
      kind: 'CONTAINS',
      reason: 'part of this site',
    });
  }

  /* ------------------------------------------------------------------ *
   * What feeds what.
   *
   * Real dependency rows, not the layer order. Two layers next to each other in
   * a list are not thereby connected, and drawing an edge because they are
   * adjacent would be decoration presented as structure.
   * ------------------------------------------------------------------ */
  const layerIds = new Set(layers.map((layer) => layer.id));
  const seenEdges = new Set<string>();
  for (const dependency of dependencies) {
    const required = dependency.requiredLayerId;
    if (!required || !layerIds.has(required)) continue;
    const dependent = missions.find(
      (mission) => mission.documentId && mission.documentId === dependency.dependentDocumentId,
    )?.layerId;
    if (!dependent || !layerIds.has(dependent) || dependent === required) continue;
    const key = `${required}->${dependent}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({
      from: `major:${required}`,
      to: `major:${dependent}`,
      kind: 'FEEDS',
      reason: dependency.notes ?? 'the second one is built on the first',
    });
  }

  /* ------------------------------------------------------------------ *
   * The site itself, last, so its counts are over what was actually built.
   * ------------------------------------------------------------------ */
  const siteBlocked = layers
    .filter((layer) => layer.status === 'BLOCKED')
    .map((layer) => `${plainLayerName(layer.name)} cannot go further`);

  nodes.unshift({
    id: siteId,
    level: 'SITE',
    parentId: null,
    title: project.name,
    purpose: project.description,
    why: project.northStar,
    state: project.status,
    stateLabel: project.status === 'ACTIVE' ? 'Active' : project.status.toLowerCase(),
    progress: progressOf({
      milestones: layers.map((layer) => ({
        key: layer.id,
        title: plainLayerName(layer.name),
        done: layer.status === 'FROZEN',
        detail: layer.status === 'FROZEN' ? null : plainLayerState(layer.status),
      })),
      closed: true,
      started: layers.some((layer) => layer.status !== 'NOT_STARTED'),
      blockedBy: siteBlocked,
      noun: project.name,
    }),
    priority: null,
    priorityLabel: null,
    counts: {
      knowledge: knows.filter(
        (entry) => entry.kind === 'CONCLUSION' || entry.kind === 'DECISION',
      ).length,
      unknowns: knows.filter(
        (entry) =>
          entry.kind === 'GAP' || entry.kind === 'UNKNOWN' || entry.kind === 'CONTRADICTION',
      ).length,
      work: missions.length,
      conversations: conversationCount,
      children: layers.length,
    },
    links: {
      projectId: project.id,
      layerId: null,
      candidateId: null,
      conversationId: null,
    },
  });

  for (const idea of ideaNodes) {
    nodes.push(idea);
    edges.push({
      from: idea.parentId ?? siteId,
      to: idea.id,
      kind: 'CONTAINS',
      reason: idea.links.layerId ? 'an idea inside this part' : 'captured, not yet filed anywhere',
    });
  }

  return { nodes, edges, rootId: siteId };
}

/**
 * The children of one node, for a drill-down that never loads the whole map.
 *
 * A pure function over an already-fetched map rather than a query, so the list
 * and the constellation cannot disagree about what is inside something.
 */
export function childrenOf(map: IdeaMap, nodeId: string): IdeaNode[] {
  return map.nodes.filter((node) => node.parentId === nodeId);
}

/** The path from the root to one node, for a breadcrumb. */
export function pathTo(map: IdeaMap, nodeId: string): IdeaNode[] {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const path: IdeaNode[] = [];
  let current = byId.get(nodeId);
  // Bounded by the node count, so a cycle introduced by a future edge kind
  // cannot hang the request.
  let guard = map.nodes.length + 1;
  while (current && guard-- > 0) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** Convenience for tests and callers that only want one candidate's view. */
export function ideaNodeFor(map: IdeaMap, candidate: RussellCandidate): IdeaNode | undefined {
  return map.nodes.find((node) => node.id === `idea:${candidate.id}`);
}
