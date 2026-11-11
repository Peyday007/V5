/**
 * The causal graph's door (CAUSAL-14-4, CAUSAL-15-2).
 *
 * Project-scoped like every other kernel: `requireProject` is
 * `decideProjectAccess` against the authenticated principal, so another
 * project's request is the same 404 with the same body as one for a project that
 * does not exist (invariants 21, 23, 30), and `requirePerson` refuses a worker by
 * principal type. Levels come from `services/identity/policy.ts`'s defaults: a
 * POST is WRITE and nothing here widens that.
 *
 * Nothing here acts on the world, and the one thing it writes besides a stored
 * graph is a need: a decision-critical unknown is sent, idempotently, to the
 * owner that acts on it — a research question on the orchestration the request
 * names (`orchestrationId`), or the review a person reads — through
 * `services/quant/needs.ts`, and every answer says per need where it went
 * (`sent`). A graph may travel in the request, or be named
 * by `graphKey` and read back from what an earlier request stored. Storing is an
 * append to `project_events` (the existing append-only history), one row per
 * version of a named graph, so there is no second store and no migration; the
 * version is the row's position in that history. Every answer is computed from the
 * graph by `services/quant/graph.ts`, the one owner of the model: a route that
 * re-derived a figure would be a second model. A figure with no
 * lineage is refused, an unknown stays unknown in every answer, and a question the
 * graph cannot answer is a need sent to its owner rather than a guess.
 */
import { Router } from 'express';
import { badRequest, bodyOf, handler, notFound, pathId, requirePerson, requireProject, unprocessable } from './helpers.ts';
import { listEvents, recordEvent } from '../repos/events.ts';
import {
  FIGURE_STATUSES,
  addAction,
  addMoneyRoute,
  addNode,
  addRelation,
  claimHistory,
  createGraph,
  declareType,
  discoverMissing,
  expandToFixpoint,
  fullAccount,
  linkGraphs,
  makeFigure,
  passVolume,
  readMoneyRoute,
  recordClaim,
  trace,
  unknownFigure,
  type CausalGraph,
  type ChainReading,
  type ChainStage,
  type CrossLink,
  type Figure,
  type FigureStatus,
  type GraphResult,
  type MoneyRoute,
  type MoneyRouteReading,
  type OperationalAction,
} from '../services/quant/graph.ts';
import { UnknownOrchestrationError, sendNeeds, type Need, type NeedDelivery } from '../services/quant/needs.ts';

export const causalRouter = Router();

/** A ceiling on what one request may carry, so a graph is a model and not a payload. */
const LIMITS = { nodes: 2000, relations: 5000, actions: 1000, routes: 200, claims: 2000, stages: 64, subproblems: 200 } as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);

function list(value: unknown, what: string, max: number): Json[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`"${what}" must be an array.`);
  if (value.length > max) throw badRequest(`"${what}" carries ${value.length} entries; the most one request may carry is ${max}.`);
  return value.map((one, index) => {
    if (!isObject(one)) throw badRequest(`"${what}[${index}]" must be an object.`);
    return one;
  });
}

function must<T>(result: GraphResult<T> | { ok: boolean; reason?: string }, where: string): void {
  if (!result.ok) throw unprocessable(`${where}: ${(result as { reason: string }).reason}`);
}

/** A figure from JSON. Lineage is `makeFigure`'s to enforce; an absent figure is unknown, never zero. */
function figureFrom(raw: unknown, where: string, meaning = where, unit = 'cents'): Figure {
  if (raw === undefined || raw === null) return unknownFigure(meaning, unit);
  if (!isObject(raw)) throw badRequest(`"${where}" must be a figure object.`);
  const status = text(raw.status) as FigureStatus;
  if (!(FIGURE_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`"${where}.status" must be one of ${FIGURE_STATUSES.join(', ')}.`);
  }
  const value = raw.value === null || raw.value === undefined ? null : Number(raw.value);
  const bounds = isObject(raw.bounds) ? { low: Number(raw.bounds.low), high: Number(raw.bounds.high) } : null;
  const made = makeFigure({
    meaning: text(raw.meaning) || meaning,
    unit: text(raw.unit) || unit,
    value,
    status,
    source: textOrNull(raw.source),
    window: textOrNull(raw.window),
    geography: textOrNull(raw.geography),
    scope: textOrNull(raw.scope),
    bounds,
    invalidatedBy: strings(raw.invalidatedBy),
  });
  if (!made.ok) throw unprocessable(`${where}: ${made.reason}`);
  return made.figure;
}

function routeFrom(raw: Json, index: number): MoneyRoute {
  const where = `routes[${index}]`;
  return {
    id: text(raw.id),
    payer: text(raw.payer),
    for: text(raw.for),
    terms: text(raw.terms),
    channel: text(raw.channel),
    invoicedAt: textOrNull(raw.invoicedAt),
    collectedAt: textOrNull(raw.collectedAt),
    collectedCents: figureFrom(raw.collectedCents, `${where}.collectedCents`, 'collected cash'),
    heldAgainstCents: figureFrom(raw.heldAgainstCents, `${where}.heldAgainstCents`, 'held against refund or fulfilment'),
    outflows: list(raw.outflows, `${where}.outflows`, 200).map((one) => {
      const amountCents = Number(one.amountCents);
      if (!Number.isFinite(amountCents) || amountCents < 0) throw badRequest(`"${where}.outflows" amounts are non-negative numbers of cents.`);
      return { to: text(one.to), reason: text(one.reason), amountCents, at: textOrNull(one.at) };
    }),
  };
}

function actionFrom(raw: Json): OperationalAction {
  return {
    id: text(raw.id),
    label: text(raw.label),
    prerequisites: strings(raw.prerequisites),
    actor: text(raw.actor),
    permissions: strings(raw.permissions),
    effect: text(raw.effect),
    timing: text(raw.timing),
    externalDependencies: strings(raw.externalDependencies),
    evidence: strings(raw.evidence),
    completionCondition: text(raw.completionCondition),
  };
}

/** Build the graph a request describes, through the model's own constructors, refusing the first step it refuses. */
function graphFrom(raw: unknown): CausalGraph {
  if (!isObject(raw)) throw badRequest('"graph" must be a graph object.');
  const graph = createGraph(text(raw.subject).trim() || 'unnamed');
  for (const one of list(raw.nodeTypes, 'graph.nodeTypes', 200)) must(declareType(graph, 'node', text(one.name), text(one.reason)), `node type ${text(one.name)}`);
  for (const one of list(raw.relationTypes, 'graph.relationTypes', 200)) must(declareType(graph, 'relation', text(one.name), text(one.reason)), `relation type ${text(one.name)}`);
  for (const one of list(raw.nodes, 'graph.nodes', LIMITS.nodes)) {
    const attributes: Record<string, string | number | boolean | null> = {};
    if (isObject(one.attributes)) {
      for (const [key, value] of Object.entries(one.attributes)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) attributes[key] = value as string | number | boolean | null;
      }
    }
    must(addNode(graph, { id: text(one.id), type: text(one.type), label: text(one.label), attributes }), `node ${text(one.id)}`);
  }
  for (const one of list(raw.relations, 'graph.relations', LIMITS.relations)) {
    const label = textOrNull(one.label);
    must(
      addRelation(graph, { id: text(one.id), type: text(one.type), from: text(one.from), to: text(one.to), ...(label ? { label } : {}) }),
      `relation ${text(one.id)}`,
    );
  }
  for (const one of list(raw.actions, 'graph.actions', LIMITS.actions)) must(addAction(graph, actionFrom(one)), `action ${text(one.id)}`);
  list(raw.routes, 'graph.routes', LIMITS.routes).forEach((one, index) => must(addMoneyRoute(graph, routeFrom(one, index)), `route ${text(one.id)}`));
  list(raw.claims, 'graph.claims', LIMITS.claims).forEach((one, index) => {
    const key = text(one.key).trim();
    if (!key) throw badRequest(`"graph.claims[${index}].key" is required.`);
    recordClaim(graph, key, figureFrom(one.figure, `graph.claims[${index}].figure`, key), text(one.reason));
  });
  return graph;
}

function chainFrom(raw: unknown): { startUnits: number; stages: ChainStage[] } | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw badRequest('"chain" must be an object.');
  const startUnits = Number(raw.startUnits);
  if (!Number.isFinite(startUnits) || startUnits < 0) throw badRequest('"chain.startUnits" must be a non-negative number.');
  const stages = list(raw.stages, 'chain.stages', LIMITS.stages).map((one, index) => {
    const name = text(one.name).trim();
    if (!name) throw badRequest(`"chain.stages[${index}].name" is required.`);
    const stage: ChainStage = { name, yield: figureFrom(one.yield, `chain.stages[${index}].yield`, `${name} yield`, 'share') };
    if (one.capacity !== undefined && one.capacity !== null) stage.capacity = figureFrom(one.capacity, `chain.stages[${index}].capacity`, `${name} capacity`, 'units');
    if (one.saturationHalfAt !== undefined && one.saturationHalfAt !== null) {
      const half = Number(one.saturationHalfAt);
      if (!Number.isFinite(half) || half <= 0) throw badRequest(`"chain.stages[${index}].saturationHalfAt" must be a positive number.`);
      stage.saturationHalfAt = half;
    }
    return stage;
  });
  return { startUnits, stages };
}

/* ------------------------------------------------------------------------- */
/* What the graph cannot answer is a need, not a guess                        */
/* ------------------------------------------------------------------------- */

export type { Need, NeedDelivery } from '../services/quant/needs.ts';

/**
 * The decision-critical unknowns: figures nobody has, route gaps, a chain stage
 * with an unknown input, and the actions whose permissions are not yet held.
 * Pure: `delivered` below is what sends them.
 */
function needsOf(graph: CausalGraph, readings: MoneyRouteReading[], chain: ChainReading | null): Need[] {
  const needs: Need[] = [];
  for (const reading of readings) {
    for (const gap of reading.gaps) {
      needs.push({ subject: `route ${reading.route}: ${gap}`, question: `What is the ${gap} for route ${reading.route}, and what evidences it?`, route: 'RESEARCH', permissions: [] });
    }
  }
  if (chain) {
    for (const stage of chain.stages) {
      if (stage.unknown) needs.push({ subject: `stage ${stage.name}`, question: `What is the measured yield or capacity of ${stage.name}?`, route: 'RESEARCH', permissions: [] });
    }
  }
  for (const [key, versions] of graph.claims) {
    const current = versions[versions.length - 1]?.figure;
    if (current && current.status === 'UNKNOWN') needs.push({ subject: `claim ${key}`, question: `What is ${current.meaning}?`, route: 'RESEARCH', permissions: [] });
  }
  for (const action of graph.actions.values()) {
    if (action.permissions.length > 0 && !action.permissions.every((one) => one.toLowerCase() === 'none')) {
      needs.push({
        subject: `action ${action.id}`,
        question: `Is ${action.actor} authorized to ${action.label}?`,
        route: 'AUTHORIZED_ACTION',
        permissions: action.permissions,
      });
    }
  }
  return needs;
}

/** The graph's identity for keying its needs: its stored key when it has one, otherwise its subject. */
function scopeOf(body: Json, fallback: string): string {
  if (typeof body.graphKey === 'string' && body.graph === undefined) return `key:${graphKeyOf(body.graphKey)}`;
  if (typeof body.storeAs === 'string') return `key:${graphKeyOf(body.storeAs)}`;
  return `subject:${fallback}`;
}

/**
 * Send the needs to the owners that act on them (`services/quant/needs.ts`):
 * a research question on the orchestration the request names, or the review a
 * person reads. The answer lists the needs and, per need, where it went.
 */
async function delivered(
  projectId: string,
  actorRef: string,
  body: Json,
  scope: string,
  needs: Need[],
): Promise<{ needs: Need[]; sent: NeedDelivery[] }> {
  const orchestrationId = textOrNull(body.orchestrationId);
  try {
    return { needs, sent: await sendNeeds({ projectId, actorRef, graphScope: scope, needs, orchestrationId }) };
  } catch (error) {
    if (error instanceof UnknownOrchestrationError) throw notFound(error.message);
    throw error;
  }
}

function readingsOf(graph: CausalGraph): MoneyRouteReading[] {
  return [...graph.routes.values()].map(readMoneyRoute);
}

/* ------------------------------------------------------------------------- */
/* Stored graphs: one append-only history per named graph                     */
/* ------------------------------------------------------------------------- */

const GRAPH_VERSION_KIND = 'CAUSAL_GRAPH_VERSION';
const GRAPH_ENTITY = 'causal_graph';

interface StoredGraphVersion {
  version: number;
  at: string;
  reason: string;
  /** The validated request-form graph, which `graphFrom` replays. */
  graph: Json;
}

function graphKeyOf(value: unknown): string {
  const key = text(value).trim();
  if (!key || key.length > 120) throw badRequest('A graph key is 1 to 120 characters.');
  return key;
}

/** Every stored version of one named graph, oldest first, numbered by position in the history. */
async function storedVersions(projectId: string, key: string): Promise<StoredGraphVersion[]> {
  const events = await listEvents(projectId, 5000);
  return events
    .filter((e) => e.entityType === GRAPH_ENTITY && e.entityId === key && e.payload.kind === GRAPH_VERSION_KIND && isObject(e.payload.graph))
    .reverse()
    .map((e, index) => ({ version: index + 1, at: e.createdAt, reason: text(e.payload.reason), graph: e.payload.graph as Json }));
}

/**
 * Claims accumulate across versions: the earlier history is carried into the new
 * snapshot, and a claim whose figure is unchanged adds nothing. A replaced figure
 * becomes the next version of its claim, so history survives the request.
 */
function carryClaims(previous: Json | null, next: Json): Json {
  const earlier = previous ? list(previous.claims, 'graph.claims', LIMITS.claims) : [];
  const latest = new Map<string, string>();
  for (const one of earlier) latest.set(text(one.key), JSON.stringify(one.figure ?? null));
  const added = list(next.claims, 'graph.claims', LIMITS.claims).filter((one) => latest.get(text(one.key)) !== JSON.stringify(one.figure ?? null));
  const merged = [...earlier, ...added];
  if (merged.length > LIMITS.claims) throw badRequest(`A stored graph keeps at most ${LIMITS.claims} claim versions.`);
  return { ...next, claims: merged };
}

/** The graph a request names: its own body, or a stored version of a named graph (latest unless `graphVersion` is given). */
async function graphOf(projectId: string, body: Json): Promise<CausalGraph> {
  if (body.graph !== undefined || body.graphKey === undefined) return graphFrom(body.graph);
  const key = graphKeyOf(body.graphKey);
  const versions = await storedVersions(projectId, key);
  if (versions.length === 0) throw notFound(`No stored graph named ${key}.`);
  const wanted = body.graphVersion === undefined ? versions.length : Number(body.graphVersion);
  const found = versions.find((one) => one.version === wanted);
  if (!found) throw notFound(`Graph ${key} has no version ${String(body.graphVersion)}.`);
  return graphFrom(found.graph);
}

/* ------------------------------------------------------------------------- */
/* Routes                                                                     */
/* ------------------------------------------------------------------------- */

/** The complete account, unsummarised, with every claim's history. */
causalRouter.post(
  '/projects/:projectId/causal/account',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const graph = await graphOf(projectId, body);
    // What the graph implies but does not hold yet: shown, not silently added.
    return {
      account: fullAccount(graph),
      discovered: discoverMissing(graph),
      ...(await delivered(projectId, principal.id, body, scopeOf(body, graph.subject), needsOf(graph, readingsOf(graph), null))),
    };
  }),
);

/** Trace implications forward (effects) or backward (causes) from any node. */
causalRouter.post(
  '/projects/:projectId/causal/trace',
  handler(async (req) => {
    requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const graph = await graphOf(projectId, body);
    const direction = body.direction === 'backward' ? 'backward' : body.direction === 'forward' || body.direction === undefined ? 'forward' : null;
    if (!direction) throw badRequest('"direction" must be forward or backward.');
    const maxDepth = body.maxDepth === undefined ? Infinity : Number(body.maxDepth);
    if (!(maxDepth >= 1)) throw badRequest('"maxDepth" must be at least 1.');
    const traced = trace(graph, text(body.from), direction, maxDepth);
    if (!traced) throw unprocessable(`Node ${text(body.from)} is not in this graph.`);
    return { trace: traced };
  }),
);

/** The history of one claim, and what replaced what. */
causalRouter.post(
  '/projects/:projectId/causal/claim',
  handler(async (req) => {
    requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const graph = await graphOf(projectId, body);
    const key = text(body.key);
    const history = claimHistory(graph, key);
    if (history.length === 0) throw unprocessable(`No claim named ${key} in this graph.`);
    return { key, current: history[history.length - 1], history };
  }),
);

/**
 * Show the money path: who pays, for what, under which terms and channel, who
 * is paid first, what is owed afterward and what is genuinely free to use.
 */
causalRouter.post(
  '/projects/:projectId/causal/money-path',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const graph = await graphOf(projectId, body);
    const wanted = textOrNull(body.route);
    const routes = [...graph.routes.values()].filter((one) => !wanted || one.id === wanted);
    if (routes.length === 0) throw unprocessable(wanted ? `Route ${wanted} is not in this graph.` : 'This graph has no money route.');
    const readings = routes.map(readMoneyRoute);
    return {
      routes: routes.map((route, index) => ({
        id: route.id,
        payer: route.payer,
        for: route.for,
        terms: route.terms,
        channel: route.channel,
        invoicedAt: route.invoicedAt,
        collectedAt: route.collectedAt,
        // The first recipient is the earliest outflow with a stated date; an undated outflow is a gap, not a guess.
        receivesFirst: [...route.outflows].filter((one) => one.at).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] ?? null,
        owedAfterward: route.outflows,
        reading: readings[index],
      })),
      ...(await delivered(projectId, principal.id, body, scopeOf(body, graph.subject), needsOf(graph, readings, null))),
    };
  }),
);

type Change = Json;

/** Apply one assumption change to a freshly built graph or chain, returning what it opened. */
function applyChange(graph: CausalGraph, chain: { startUnits: number; stages: ChainStage[] } | null, change: Change, index: number): { branch?: string } {
  const where = `changes[${index}]`;
  const kind = text(change.kind);
  if (kind === 'route') {
    const route = graph.routes.get(text(change.routeId));
    if (!route) throw unprocessable(`${where}: route ${text(change.routeId)} is not in this graph.`);
    const set = isObject(change.set) ? change.set : {};
    // A changed payer, role, prepayment term, channel, product or delivery is a changed field of the route.
    const next: MoneyRoute = { ...route };
    for (const key of ['payer', 'for', 'terms', 'channel'] as const) if (typeof set[key] === 'string') next[key] = set[key] as string;
    if ('invoicedAt' in set) next.invoicedAt = textOrNull(set.invoicedAt);
    if ('collectedAt' in set) next.collectedAt = textOrNull(set.collectedAt);
    if ('collectedCents' in set) next.collectedCents = figureFrom(set.collectedCents, `${where}.set.collectedCents`, 'collected cash');
    if ('heldAgainstCents' in set) next.heldAgainstCents = figureFrom(set.heldAgainstCents, `${where}.set.heldAgainstCents`, 'held against refund or fulfilment');
    if ('outflows' in set) next.outflows = routeFrom({ ...route, outflows: set.outflows }, index).outflows;
    // A change that opens a different route is a branch beside the original, not a replacement of it.
    const branchId = textOrNull(change.asBranch);
    if (branchId) {
      must(addMoneyRoute(graph, { ...next, id: branchId }), `${where}.asBranch`);
      return { branch: branchId };
    }
    graph.routes.set(route.id, next);
    return {};
  }
  if (!chain) throw unprocessable(`${where}: a "${kind}" change needs a "chain" in the request.`);
  if (kind === 'stage') {
    const stage = chain.stages.find((one) => one.name === text(change.stage));
    if (!stage) throw unprocessable(`${where}: stage ${text(change.stage)} is not in the chain.`);
    const set = isObject(change.set) ? change.set : {};
    if ('yield' in set) stage.yield = figureFrom(set.yield, `${where}.set.yield`, `${stage.name} yield`, 'share');
    if ('capacity' in set) stage.capacity = figureFrom(set.capacity, `${where}.set.capacity`, `${stage.name} capacity`, 'units');
    if ('saturationHalfAt' in set) {
      const half = Number(set.saturationHalfAt);
      if (!Number.isFinite(half) || half <= 0) throw badRequest(`"${where}.set.saturationHalfAt" must be a positive number.`);
      stage.saturationHalfAt = half;
    }
    return {};
  }
  if (kind === 'volume') {
    const add = Number(change.addUnits);
    if (!Number.isFinite(add)) throw badRequest(`"${where}.addUnits" must be a number.`);
    chain.startUnits = Math.max(0, chain.startUnits + add);
    return {};
  }
  if (kind === 'spend') {
    // Added spend is not assumed to buy volume at the old rate: the caller states
    // what it buys, and an unknown rate makes the answer unknown.
    const cents = Number(change.cents);
    const rate = figureFrom(change.unitsPerCent, `${where}.unitsPerCent`, 'units reached per cent spent', 'units/cent');
    if (!Number.isFinite(cents) || cents < 0) throw badRequest(`"${where}.cents" must be a non-negative number.`);
    if (rate.value === null) {
      // What the money buys is unknown, so the output is: a stage with an unknown yield says so in the reading.
      chain.stages = [{ name: 'reach bought by added spend', yield: unknownFigure('units reached per cent spent', 'units/cent') }, ...chain.stages];
    } else {
      chain.startUnits = Math.max(0, chain.startUnits + cents * rate.value);
    }
    return {};
  }
  throw badRequest(`"${where}.kind" must be route, stage, volume or spend.`);
}

/**
 * What happens if an assumption changes: the money routes and the chain are read
 * before and after the change and both readings are returned, so the propagation
 * through price, capacity, cash timing, profit and exposure is visible rather than
 * summarised. A different route a change opens is returned as a branch.
 */
causalRouter.post(
  '/projects/:projectId/causal/what-if',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const changes = list(body.changes, 'changes', 50);
    if (changes.length === 0) throw badRequest('"changes" must name at least one assumption to change.');
    const beforeGraph = await graphOf(projectId, body);
    const afterGraph = await graphOf(projectId, body);
    const beforeChain = chainFrom(body.chain);
    const afterChain = chainFrom(body.chain);
    const branches: string[] = [];
    changes.forEach((change, index) => {
      const opened = applyChange(afterGraph, afterChain, change, index);
      if (opened.branch) branches.push(opened.branch);
    });
    const read = (chain: { startUnits: number; stages: ChainStage[] } | null): ChainReading | null =>
      chain ? passVolume(chain.startUnits, chain.stages) : null;
    const beforeRoutes = readingsOf(beforeGraph);
    const afterRoutes = readingsOf(afterGraph);
    const chainBefore = read(beforeChain);
    const chainAfter = read(afterChain);
    const free = (rows: MoneyRouteReading[], id: string): number | null => rows.find((one) => one.route === id)?.freeCents.value ?? null;
    return {
      before: { routes: beforeRoutes, chain: chainBefore },
      after: { routes: afterRoutes, chain: chainAfter },
      changed: {
        routes: afterRoutes.map((one) => ({
          route: one.route,
          freeCentsBefore: free(beforeRoutes, one.route),
          freeCentsAfter: one.freeCents.value,
          freeCentsDelta: free(beforeRoutes, one.route) !== null && one.freeCents.value !== null ? one.freeCents.value - (free(beforeRoutes, one.route) as number) : null,
        })),
        outputUnitsBefore: chainBefore?.outputUnits ?? null,
        outputUnitsAfter: chainAfter?.outputUnits ?? null,
        bindingConstraintBefore: chainBefore?.bindingConstraint ?? null,
        bindingConstraintAfter: chainAfter?.bindingConstraint ?? null,
      },
      branches,
      ...(await delivered(projectId, principal.id, body, scopeOf(body, afterGraph.subject), needsOf(afterGraph, afterRoutes, chainAfter))),
    };
  }),
);

/**
 * Pass volume through every stage of a chain and name the constraint that caps
 * output. Volume is revenue only after the last stage; saturation and capacity
 * are the caller's stated figures and an unknown one makes the output unknown.
 */
causalRouter.post(
  '/projects/:projectId/causal/chain',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const chain = chainFrom(body.chain);
    if (!chain) throw badRequest('"chain" is required.');
    const reading = passVolume(chain.startUnits, chain.stages);
    const subject = textOrNull(body.subject) ?? 'chain';
    return { reading, ...(await delivered(projectId, principal.id, body, scopeOf(body, subject), needsOf(createGraph(subject), [], reading))) };
  }),
);

/* ------------------------------------------------------------------------- */
/* Decomposing a business nobody has run before                               */
/* ------------------------------------------------------------------------- */

interface Subproblem {
  id: string;
  question: string;
  /** The thing that could be seen or measured that would answer it. */
  observable: string;
  dependsOn: string[];
  origin: 'starting' | 'supplied';
  status: 'UNKNOWN';
}

/**
 * A starting vocabulary of causal links, to be extended and not a checklist: a
 * business that skips one says so, one that needs another adds it, and the model
 * of an AI business uses the same links as any other because its novelty is in the
 * inputs and not in the shape. Each link names what could be observed to settle it.
 */
const STARTING_LINKS: { id: string; question: string; observable: string; dependsOn: string[] }[] = [
  { id: 'demand', question: 'Who would pay for the output, and how many of them are there?', observable: 'a count of payers from a named source, or priced requests already made', dependsOn: [] },
  { id: 'access', question: 'By what path can those payers be reached or can they reach us?', observable: 'a path that has delivered a conversation, with its provider terms read', dependsOn: ['demand'] },
  { id: 'capability', question: 'Can the AI or supplier produce the output at the required quality?', observable: 'a sample judged against the buyer’s acceptance condition', dependsOn: [] },
  { id: 'unit-cost', question: 'What does one unit of output cost to make, all in?', observable: 'metered cost of producing a unit, from real runs', dependsOn: ['capability'] },
  { id: 'capacity', question: 'How many units can be made and delivered in the period?', observable: 'throughput measured over a period, and the limit that bound it', dependsOn: ['capability'] },
  { id: 'purchase', question: 'What makes a payer agree, and at what price and terms?', observable: 'an agreement, or a refusal with its stated reason', dependsOn: ['access', 'capability'] },
  { id: 'acceptance', question: 'What does the buyer do to accept delivery, and how often is it refused?', observable: 'acceptance and rejection records', dependsOn: ['purchase', 'capacity'] },
  { id: 'payment', question: 'When is payment invoiced, collected and cleared, and what can reverse it?', observable: 'cleared funds against an invoice, and any refund or chargeback', dependsOn: ['acceptance'] },
  { id: 'obligations', question: 'What must be paid out or held back, and when?', observable: 'dated outflows and amounts held against refunds', dependsOn: ['payment'] },
  { id: 'failure', question: 'What shared resource or dependency, if it failed, would stop more than one stream?', observable: 'a named dependency used by more than one stream, with its failure history', dependsOn: ['capability', 'access'] },
];

/**
 * Decompose a business into observable causal subproblems. The caller may name
 * any subproblems of their own and may drop a starting link by saying why it does
 * not apply; nothing about the business's category is read, and each subproblem
 * is UNKNOWN until an observation settles it.
 */
causalRouter.post(
  '/projects/:projectId/causal/decompose',
  handler(async (req) => {
    requirePerson();
    await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);
    const business = isObject(body.business) ? body.business : null;
    const name = business ? text(business.name).trim() : '';
    if (!name) throw badRequest('"business.name" is required.');
    const skipped = new Map<string, string>();
    for (const one of list(body.notApplicable, 'notApplicable', 50)) {
      const id = text(one.id);
      const reason = text(one.reason).trim();
      if (!STARTING_LINKS.some((link) => link.id === id)) throw badRequest(`"notApplicable" names ${id}, which is not a starting link.`);
      if (!reason) throw badRequest(`"notApplicable" for ${id} must say why it does not apply.`);
      skipped.set(id, reason);
    }
    const subproblems: Subproblem[] = STARTING_LINKS.filter((link) => !skipped.has(link.id)).map((link) => ({
      ...link,
      dependsOn: link.dependsOn.filter((dep) => !skipped.has(dep)),
      origin: 'starting' as const,
      status: 'UNKNOWN' as const,
    }));
    const known = new Set(subproblems.map((one) => one.id));
    for (const one of list(body.subproblems, 'subproblems', LIMITS.subproblems)) {
      const id = text(one.id).trim();
      if (!/^[a-z][a-z0-9-]{1,60}$/.test(id)) throw badRequest('A subproblem id is lowercase words joined by hyphens.');
      if (known.has(id)) throw badRequest(`Subproblem ${id} already exists.`);
      const question = text(one.question).trim();
      const observable = text(one.observable).trim();
      if (!question || !observable) throw badRequest(`Subproblem ${id} states its question and what could be observed to answer it.`);
      known.add(id);
      subproblems.push({ id, question, observable, dependsOn: strings(one.dependsOn), origin: 'supplied', status: 'UNKNOWN' });
    }
    for (const one of subproblems) {
      for (const dep of one.dependsOn) if (!known.has(dep)) throw unprocessable(`Subproblem ${one.id} depends on ${dep}, which is not in this decomposition.`);
    }
    return {
      business: { name, description: text(business?.description) },
      subproblems,
      notApplicable: [...skipped].map(([id, reason]) => ({ id, reason })),
      note: 'Every subproblem is UNKNOWN until an observation settles it. The starting links are a vocabulary to extend, not a checklist.',
    };
  }),
);

/** The request form of a graph, which `graphFrom` replays: what a constructed graph is stored as. */
function graphToJson(graph: CausalGraph): Json {
  const declared = (table: Map<string, { name: string; reason: string }>) =>
    [...table.values()].filter((one) => one.reason !== 'seed').map((one) => ({ name: one.name, reason: one.reason }));
  return {
    subject: graph.subject,
    nodeTypes: declared(graph.nodeTypes),
    relationTypes: declared(graph.relationTypes),
    nodes: [...graph.nodes.values()],
    relations: [...graph.relations.values()],
    actions: [...graph.actions.values()],
    routes: [...graph.routes.values()],
    claims: [...graph.claims].flatMap(([key, versions]) => versions.map((one) => ({ key, figure: one.figure, reason: one.reason }))),
  };
}

async function storeVersion(projectId: string, key: string, next: Json, reasonText: unknown): Promise<{ version: number; graph: CausalGraph }> {
  const earlier = await storedVersions(projectId, key);
  const merged = carryClaims(earlier.length ? (earlier[earlier.length - 1] as StoredGraphVersion).graph : null, next);
  const graph = graphFrom(merged);
  const reason = text(reasonText).trim().slice(0, 500) || (earlier.length ? 'replaced without a stated reason' : '');
  await recordEvent({
    projectId,
    entityType: GRAPH_ENTITY,
    entityId: key,
    eventType: 'CAPABILITY_ASSESSED',
    payload: { kind: GRAPH_VERSION_KIND, reason, graph: merged },
  });
  return { version: earlier.length + 1, graph };
}

/**
 * Brain constructs the graph (CAUSAL-14-1): from whatever the request or a stored
 * version states — routes, actions, a few nodes — it discovers every variable
 * those imply and does not yet model (the payer, the offer, the channel, each
 * party paid out to, a hold against refunds, the actor, approvals and outside
 * dependencies of each action), declares a type when the vocabulary has none for
 * the role, and expands until nothing new is implied. Every addition names what
 * implied it. With `storeAs`, the constructed graph becomes the next version of
 * that named graph, so later questions read the expanded one.
 */
causalRouter.post(
  '/projects/:projectId/causal/construct',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const graph = await graphOf(projectId, body);
    const expanded = expandToFixpoint(graph);
    if (!expanded.ok) throw unprocessable(expanded.reason);
    let stored: { key: string; version: number } | null = null;
    if (body.storeAs !== undefined) {
      const key = graphKeyOf(body.storeAs);
      const done = await storeVersion(projectId, key, graphToJson(graph), body.reason ?? 'constructed: variables the graph implied were added');
      stored = { key, version: done.version };
    }
    return {
      discovered: expanded.value,
      stored,
      account: fullAccount(graph),
      ...(await delivered(projectId, principal.id, body, scopeOf(body, graph.subject), needsOf(graph, readingsOf(graph), null))),
    };
  }),
);

/**
 * Several graphs as one portfolio: each member keeps its own nodes under its
 * subject, a party or resource more than one member depends on becomes one shared
 * node that constrains each of them, and stated links join members. Members are
 * constructed first, so a dependency two businesses share is found even when
 * neither graph names it as a node. `trace` follows implications across members.
 */
causalRouter.post(
  '/projects/:projectId/causal/portfolio',
  handler(async (req) => {
    const principal = requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const body = bodyOf(req);
    const subject = text(body.subject).trim() || 'portfolio';
    const rawMembers = list(body.members, 'members', 50);
    if (rawMembers.length < 2) throw badRequest('"members" names at least two graphs.');
    const members: CausalGraph[] = [];
    for (const [index, raw] of rawMembers.entries()) {
      const member = await graphOf(projectId, raw);
      const expanded = expandToFixpoint(member);
      if (!expanded.ok) throw unprocessable(`members[${index}]: ${expanded.reason}`);
      members.push(member);
    }
    const links: CrossLink[] = list(body.links, 'links', LIMITS.relations).map((one, index) => {
      const end = (value: unknown, side: string) => {
        if (!isObject(value)) throw badRequest(`"links[${index}].${side}" must name a graph and a node.`);
        return { graph: text(value.graph), node: text(value.node) };
      };
      const label = textOrNull(one.label);
      return { from: end(one.from, 'from'), to: end(one.to, 'to'), type: text(one.type), ...(label ? { label } : {}) };
    });
    const linked = linkGraphs(subject, members, links);
    if (!linked.ok) throw unprocessable(linked.reason);
    const portfolio = linked.value;
    let traced = null;
    if (isObject(body.trace)) {
      const from = text(body.trace.from);
      const direction = body.trace.direction === 'backward' ? 'backward' : 'forward';
      traced = trace(portfolio.graph, from, direction);
      if (!traced) throw unprocessable(`Node ${from} is not in this portfolio.`);
    }
    return {
      subject,
      members: portfolio.members,
      shared: portfolio.shared,
      links: portfolio.links,
      trace: traced,
      account: fullAccount(portfolio.graph),
      ...(await delivered(projectId, principal.id, body, `portfolio:${subject}`, needsOf(portfolio.graph, readingsOf(portfolio.graph), null))),
    };
  }),
);

/**
 * Store a version of a named graph. The request-form graph is validated by
 * building it, carried forward with every earlier claim version, and appended
 * to the project's history; nothing earlier is edited or removed.
 */
causalRouter.post(
  '/projects/:projectId/causal/graphs/:key',
  handler(async (req) => {
    requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const key = graphKeyOf(pathId(req, 'key'));
    const body = bodyOf(req);
    if (!isObject(body.graph)) throw badRequest('"graph" must be a graph object.');
    const { version, graph } = await storeVersion(projectId, key, body.graph, body.reason);
    return { key, version, subject: graph.subject, claims: graph.claims.size };
  }),
);

/** A stored graph: the latest version unless one is named, and the list of every version with its reason. */
causalRouter.get(
  '/projects/:projectId/causal/graphs/:key',
  handler(async (req) => {
    requirePerson();
    const projectId = (await requireProject(pathId(req, 'projectId'))).id;
    const key = graphKeyOf(pathId(req, 'key'));
    const versions = await storedVersions(projectId, key);
    if (versions.length === 0) throw notFound(`No stored graph named ${key}.`);
    const asked = typeof req.query.version === 'string' ? Number(req.query.version) : versions.length;
    const found = versions.find((one) => one.version === asked);
    if (!found) throw notFound(`Graph ${key} has no version ${String(req.query.version)}.`);
    return {
      key,
      version: found.version,
      graph: found.graph,
      account: fullAccount(graphFrom(found.graph)),
      versions: versions.map((one) => ({ version: one.version, at: one.at, reason: one.reason })),
    };
  }),
);
