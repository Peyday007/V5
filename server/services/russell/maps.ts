/**
 * The six specialized maps.
 *
 * §20 asks for a system map, a workflow map, a knowledge map, a decision tree,
 * a timeline and a money-flow map, alongside the living constellation. All
 * seven are *views over the authoritative graph* rather than seven stores, and
 * the rule that keeps them honest is one sentence: **a map may only draw
 * relationships that are recorded.**
 *
 * That has a consequence worth stating plainly rather than working around. A
 * project that records no money does not get a money-flow map with plausible
 * arrows on it; it gets a map that says the project records nothing to draw.
 * An empty map for an absent subject is the correct output, and inventing edges
 * to make a diagram look finished is the exact failure this platform exists to
 * prevent — one altitude down from an invented citation.
 *
 * Nothing here writes. Dragging a node in the client changes a layout and never
 * business truth (§20), so there is no mutation in this module at all: a model
 * edit goes through the ordinary guarded services with their own authority.
 */
import { listLayers } from '../../repos/layers.ts';
import { listCurrentKnowledge, listMissions } from '../../repos/russellMissions.ts';
import { listDocuments } from '../../repos/documents.ts';
import { listEvents } from '../../repos/events.ts';
import { listExternalRecords } from '../../repos/externalRecords.ts';
import { EXTERNAL_SOURCE_SYSTEMS } from '../../domain/types.ts';
import { plainLayerName } from './dealDispatch.ts';
import { milestoneStateOfLayer } from './progress.ts';

/** The six, plus the constellation which has its own module. */
export const MAP_TYPES = [
  'SYSTEM',
  'WORKFLOW',
  'KNOWLEDGE',
  'DECISIONS',
  'TIMELINE',
  'MONEY_FLOW',
] as const;
export type MapType = (typeof MAP_TYPES)[number];

export const MAP_LABELS: Record<MapType, string> = {
  SYSTEM: 'System map',
  WORKFLOW: 'Workflow map',
  KNOWLEDGE: 'Knowledge map',
  DECISIONS: 'Decision tree',
  TIMELINE: 'Timeline',
  MONEY_FLOW: 'Money-flow map',
};

export const MAP_QUESTIONS: Record<MapType, string> = {
  SYSTEM: 'What this project is made of, and how the parts connect.',
  WORKFLOW: 'How a piece of work moves from an idea to something filed.',
  KNOWLEDGE: 'What is known, and what each thing rests on.',
  DECISIONS: 'What was decided, and what depended on it.',
  TIMELINE: 'What happened, in order.',
  MONEY_FLOW: 'Where money comes from and where it goes.',
};

export interface MapNode {
  id: string;
  label: string;
  /** What kind of thing this is, so the renderer can shape it by role. */
  kind: string;
  /** The row's own state, when it has one. */
  state: string | null;
  detail: string | null;
  /** The authoritative row, so a reader can walk back rather than trust. */
  sourceId: string | null;
  at: string | null;
}

export interface MapEdge {
  from: string;
  to: string;
  /** What the relationship is, in the words of the thing that recorded it. */
  kind: string;
  label: string | null;
}

export interface MapView {
  type: MapType;
  label: string;
  question: string;
  nodes: MapNode[];
  edges: MapEdge[];
  /**
   * Why the map is empty, when it is.
   *
   * Six different reasons a map could have nothing on it, and they are not the
   * same fact: the project records nothing of this kind, nothing has happened
   * yet, or the subject does not apply to this kind of project. A blank canvas
   * with no sentence is the failure §6 names for lists, at a different
   * altitude.
   */
  emptyReason: string | null;
  /**
   * The same content as an ordered list.
   *
   * §20 requires an accessible synchronized outline for keyboard and
   * screen-reader use, and *synchronized* is the operative word: it is built
   * from the same nodes in the same pass, so the two cannot describe different
   * graphs.
   */
  outline: { id: string; label: string; depth: number; detail: string | null }[];
}

/**
 * Build one map.
 *
 * Each branch reads only rows that genuinely record the relationship it draws.
 * Where a project has nothing of that kind, the map comes back empty with the
 * reason — never with a plausible shape.
 */
export async function mapFor(input: {
  type: MapType;
  projectId: string;
  projectName: string;
  includePrivate?: boolean;
}): Promise<MapView> {
  const base = {
    type: input.type,
    label: MAP_LABELS[input.type],
    question: MAP_QUESTIONS[input.type],
  };

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  let emptyReason: string | null = null;

  if (input.type === 'SYSTEM') {
    const [layers, sites] = await Promise.all([
      listLayers(input.projectId),
      /*
       * A connected site's records, across every source system there is.
       *
       * `external_records` is keyed by source system, so this walks the
       * declared set rather than naming one: a map that hard-coded the only
       * system that exists today would draw an empty graph the day a second
       * one is connected, with the rows sitting there under a different key.
       */
      Promise.all(
        EXTERNAL_SOURCE_SYSTEMS.map((system) =>
          listExternalRecords({ projectId: input.projectId, sourceSystem: system, limit: 50 }),
        ),
      ).then((lists) => lists.flat()),
    ]);
    nodes.push({
      id: `project:${input.projectId}`,
      label: input.projectName,
      kind: 'PROJECT',
      state: null,
      detail: null,
      sourceId: input.projectId,
      at: null,
    });
    for (const layer of layers) {
      nodes.push({
        id: `layer:${layer.id}`,
        label: plainLayerName(layer.name),
        kind: 'FOUNDATION',
        state: milestoneStateOfLayer(layer.status),
        detail: null,
        sourceId: layer.id,
        at: layer.updatedAt,
      });
      edges.push({
        from: `project:${input.projectId}`,
        to: `layer:${layer.id}`,
        kind: 'PART_OF',
        label: null,
      });
    }
    for (const site of sites) {
      nodes.push({
        id: `site:${site.id}`,
        label: site.title,
        kind: 'CONNECTED_SITE',
        // The site owns its operational fields; Brain draws what it holds.
        state: site.sourceSystem,
        detail: site.summary,
        sourceId: site.id,
        at: site.updatedAt,
      });
      edges.push({
        from: `project:${input.projectId}`,
        to: `site:${site.id}`,
        kind: 'CONNECTED_TO',
        label: null,
      });
    }
    if (layers.length === 0 && sites.length === 0) {
      emptyReason = 'This project has no foundations and no connected system recorded yet.';
    }
  }

  if (input.type === 'WORKFLOW') {
    const missions = await listMissions({ projectId: input.projectId, limit: 100 });
    /*
     * The workflow is the pipeline a mission actually walked, from its own
     * columns. Every stage a mission reached has a row behind it; a stage it
     * did not reach is simply absent rather than drawn as pending, because a
     * mission that skipped a stage did not do it.
     */
    for (const mission of missions.slice(0, 25)) {
      const stages: { key: string; label: string; present: boolean; id: string | null }[] = [
        { key: 'IDEA', label: 'Idea', present: mission.candidateId !== null, id: mission.candidateId },
        { key: 'MISSION', label: 'Mission', present: true, id: mission.id },
        {
          key: 'PACKET',
          label: 'Research packet',
          present: mission.orchestrationId !== null,
          id: mission.orchestrationId,
        },
        { key: 'BIN', label: 'Handed to a worker', present: mission.binId !== null, id: mission.binId },
        { key: 'FILED', label: 'Filed', present: mission.documentId !== null, id: mission.documentId },
        { key: 'AUDITED', label: 'Audited', present: mission.auditId !== null, id: mission.auditId },
      ];
      let previous: string | null = null;
      for (const stage of stages) {
        if (!stage.present) continue;
        const id = `${mission.id}:${stage.key}`;
        nodes.push({
          id,
          label: stage.label,
          kind: stage.key,
          state: stage.key === 'MISSION' ? mission.state : null,
          detail: stage.key === 'MISSION' ? mission.objective : null,
          sourceId: stage.id,
          at: mission.updatedAt,
        });
        if (previous) edges.push({ from: previous, to: id, kind: 'THEN', label: null });
        previous = id;
      }
    }
    if (missions.length === 0) emptyReason = 'No work has been started here yet.';
  }

  if (input.type === 'KNOWLEDGE' || input.type === 'DECISIONS') {
    const kinds =
      input.type === 'DECISIONS'
        ? (['DECISION'] as const)
        : (['CONCLUSION', 'ASSUMPTION', 'UNKNOWN', 'CONTRADICTION', 'GAP'] as const);
    const knowledge = await listCurrentKnowledge({
      projectId: input.projectId,
      kinds: [...kinds],
      includePrivate: input.includePrivate ?? false,
      limit: 100,
    });
    const layers = await listLayers(input.projectId);
    const layerIds = new Set(layers.map((layer) => layer.id));

    for (const layer of layers) {
      nodes.push({
        id: `layer:${layer.id}`,
        label: plainLayerName(layer.name),
        kind: 'FOUNDATION',
        state: milestoneStateOfLayer(layer.status),
        detail: null,
        sourceId: layer.id,
        at: layer.updatedAt,
      });
    }
    for (const row of knowledge) {
      nodes.push({
        id: `knowledge:${row.id}`,
        label: row.statement,
        kind: row.kind,
        state: row.confidence,
        detail: row.detail,
        sourceId: row.id,
        at: row.updatedAt,
      });
      /*
       * An edge only where the row records one.
       *
       * A knowledge row carries the layer it belongs to. A row with none is
       * genuinely project-wide, and attaching it to an arbitrary foundation to
       * make the picture tidier would file it under the wrong heading — which
       * is §11's own warning at a different altitude.
       */
      if (row.layerId && layerIds.has(row.layerId)) {
        edges.push({
          from: `layer:${row.layerId}`,
          to: `knowledge:${row.id}`,
          kind: 'BELONGS_TO',
          label: null,
        });
      }
      if (row.supersedesId) {
        edges.push({
          from: `knowledge:${row.supersedesId}`,
          to: `knowledge:${row.id}`,
          kind: 'SUPERSEDED_BY',
          label: 'replaced by',
        });
      }
    }
    if (knowledge.length === 0) {
      emptyReason =
        input.type === 'DECISIONS'
          ? 'No decisions have been recorded for this project yet.'
          : 'Nothing has been concluded, assumed or questioned here yet.';
    }
  }

  if (input.type === 'TIMELINE') {
    const events = await listEvents(input.projectId, 100);
    let previous: string | null = null;
    for (const event of events.slice().reverse()) {
      const id = `event:${event.id}`;
      nodes.push({
        id,
        // An event's own type is what it is; the payload is arbitrary JSON and
        // composing a sentence from it would be this module inventing prose.
        label: `${event.eventType.toLowerCase().replace(/_/g, ' ')}${event.entityType ? ` — ${event.entityType.toLowerCase()}` : ''}`,
        kind: event.eventType,
        state: null,
        detail: null,
        sourceId: event.id,
        at: event.createdAt,
      });
      if (previous) edges.push({ from: previous, to: id, kind: 'THEN', label: null });
      previous = id;
    }
    if (events.length === 0) emptyReason = 'Nothing has happened in this project yet.';
  }

  if (input.type === 'MONEY_FLOW') {
    /*
     * The map that is usually empty, and must say so.
     *
     * Brain records research, evidence and work. It does not record revenue,
     * cost or margin unless a connected site sends them, and this project's
     * connector deliberately does not — the margin, the contacts and the costs
     * are the site's and stay there (§25). So the honest money-flow map is one
     * that reports having nothing to draw, rather than a diagram of arrows
     * somebody could mistake for a financial model.
     */
    const documents = await listDocuments(input.projectId);
    const financial = documents.filter((document) =>
      /revenue|margin|cost|price|pricing|fee/i.test(document.canonicalName),
    );
    for (const document of financial) {
      nodes.push({
        id: `document:${document.id}`,
        label: document.canonicalName,
        kind: 'DOCUMENT',
        state: document.status,
        detail: 'A document whose name suggests it is about money. Its contents decide, not its name.',
        sourceId: document.id,
        at: document.updatedAt,
      });
    }
    emptyReason =
      financial.length === 0
        ? 'Brain records no money for this project. The figures live in the connected system, which keeps them deliberately — so there is nothing here to draw.'
        : null;
  }

  return {
    ...base,
    nodes,
    edges,
    emptyReason,
    outline: outlineOf(nodes, edges),
  };
}

/**
 * The same graph as an ordered list.
 *
 * Built from the nodes and edges already computed, in one pass, so the outline
 * and the diagram cannot describe different graphs. Depth comes from how far a
 * node is from a root — a node nothing points at — which is a property of the
 * edges rather than of the drawing.
 */
export function outlineOf(
  nodes: MapNode[],
  edges: MapEdge[],
): { id: string; label: string; depth: number; detail: string | null }[] {
  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node.id, 0);
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: { id: string; label: string; depth: number; detail: string | null }[] = [];
  const seen = new Set<string>();

  const walk = (id: string, depth: number): void => {
    // A cycle is possible in a recorded graph — a contradiction can point both
    // ways — so the guard is on having seen the node, not on depth.
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    out.push({ id, label: node.label, depth, detail: node.detail });
    for (const child of children.get(id) ?? []) walk(child, depth + 1);
  };

  for (const node of nodes) {
    if ((incoming.get(node.id) ?? 0) === 0) walk(node.id, 0);
  }
  // Anything only reachable through a cycle still belongs in the list.
  for (const node of nodes) if (!seen.has(node.id)) walk(node.id, 0);
  return out;
}
