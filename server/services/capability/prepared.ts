/**
 * A prepared option is cheap, and it is not a production integration (GOV-22-2).
 *
 * A dormant capability (one a goal might need later and Brain cannot yet use)
 * may be investigated while that is cheap: is it feasible, what is the simplest
 * existing provider or open-source tool, what does a tested interface sketch or
 * a source inventory look like. That preparation is *recorded against a
 * capability-map requirement* and nothing more. This module is deliberately
 * not a scheduler, a store or an authority path:
 *
 *  - it records through the append-only `project_events` log (invariant 3),
 *    so no second store exists;
 *  - it never produces a map reading, so a prepared option can never make a
 *    requirement WORKING — only the proof probe over real attempts does that;
 *  - it holds no lease and fires no worker: keeping an option warm costs a row;
 *  - a need is turned into an exact requirement that the *existing* Factory
 *    receives through `ensureChangeRequest`, and the originating goal's
 *    blocked work is judged resumed only when rows show the handoff itself was
 *    implemented (its campaign COMPLETE), the capability then reads WORKING
 *    over real attempts, and the blocked work ran after that.
 *
 * `handOffToFactory` is the one place a handoff is recorded, and `resumeOf` is the
 * one place resumption is judged, from `work_items` rows.
 *
 * The producer is the Russell tick: `advancePreparedOptions` first runs
 * `prepareForLiveGoals`, which reads each live goal's own `CAPABILITY_ASSESSED`
 * row (written by `assessLiveObjectives`), so the dependency comes from the
 * goal's record and nobody has to remember the old option. For each requirement
 * that row says blocks the goal it records a map-derived prepared option once,
 * records the need with its permitted/gated comparison once per goal, and —
 * only for a requirement the improvement loop does not already route — hands
 * the minimum missing capability to the existing Factory through its own
 * contract (`submitObjective` on the Brain repository grant), as a draft.
 *
 * No category, provider or example here is a whitelist: every access method is
 * data the preparer supplied, and the comparison is over its declared traits.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordEvent, listEvents, listEventsByEntity } from '../../repos/events.ts';
import { ensureChangeRequest, getCampaignByChangeRequest, getChangeRequest } from '../../repos/factory.ts';
import { CAPABILITY_MAPS, classify, type CapabilityStatus } from '../../domain/capabilityMap.ts';
import { ownerExists, readProbe } from '../selfmodel/capabilities.ts';
import type { CapabilityRequirement } from '../../domain/capabilityMap.ts';
import type { ProjectEvent } from '../../domain/types.ts';
import type { FactoryChangeRequest } from '../../domain/factory.ts';

export class PreparedOptionError extends Error {}

export const PREPARED_OPTION_KIND = 'PREPARED_OPTION';

/** What crossing a method would require beyond Brain's own authority. */
export const GATES = ['CREDENTIALS', 'CONTRACT', 'SPEND', 'PERMISSION'] as const;
export type Gate = (typeof GATES)[number];

export interface AccessMethod {
  /** A provider, open-source tool or manual route, in the preparer's words. */
  name: string;
  kind: 'API' | 'OPEN_SOURCE_TOOL' | 'NO_API' | 'OTHER';
  /** Gates an owner must open before this method can run in production. */
  gates: Gate[];
  /** Relative effort to make it real, 1 (adapter) .. 5 (costly build such as browser automation). */
  effort: 1 | 2 | 3 | 4 | 5;
  /** Where the facts about it came from. */
  sources: string[];
}

export interface PreparedOption {
  /** The capability-map requirement id this option stands behind. */
  requirementId: string;
  feasibility: { verdict: 'FEASIBLE' | 'UNCERTAIN' | 'INFEASIBLE'; note: string };
  methods: AccessMethod[];
  /** A tested interface sketch, or a source inventory; at least one. */
  interfaceSketch?: { text: string; tested: boolean };
  sourceInventory?: string[];
}

/** Effort at or above this is the "costly browser automation" the spec refuses to keep warm. */
export const COSTLY_EFFORT = 4;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function validatePreparedOption(input: unknown): PreparedOption {
  const o = (input ?? {}) as Record<string, unknown>;
  const requirementId = text(o.requirementId);
  if (!requirementId) throw new PreparedOptionError('a prepared option names the capability-map requirement it stands behind');
  const f = (o.feasibility ?? {}) as Record<string, unknown>;
  const verdict = f.verdict;
  if (verdict !== 'FEASIBLE' && verdict !== 'UNCERTAIN' && verdict !== 'INFEASIBLE') {
    throw new PreparedOptionError('feasibility.verdict must be FEASIBLE, UNCERTAIN or INFEASIBLE');
  }
  if (!text(f.note)) throw new PreparedOptionError('a feasibility note is required');
  const rawMethods = Array.isArray(o.methods) ? o.methods : [];
  if (rawMethods.length === 0) throw new PreparedOptionError('a tool inventory needs at least one access method');
  const methods = rawMethods.map((m, i): AccessMethod => {
    const r = (m ?? {}) as Record<string, unknown>;
    const gates = Array.isArray(r.gates) ? r.gates : [];
    for (const g of gates) if (!(GATES as readonly unknown[]).includes(g)) throw new PreparedOptionError(`method ${i}: unknown gate ${String(g)}`);
    const effort = Number(r.effort);
    if (![1, 2, 3, 4, 5].includes(effort)) throw new PreparedOptionError(`method ${i}: effort must be 1..5`);
    const kind = r.kind;
    if (kind !== 'API' && kind !== 'OPEN_SOURCE_TOOL' && kind !== 'NO_API' && kind !== 'OTHER') throw new PreparedOptionError(`method ${i}: unknown kind`);
    if (!text(r.name)) throw new PreparedOptionError(`method ${i}: a name is required`);
    return {
      name: text(r.name), kind, gates: [...new Set(gates as Gate[])], effort: effort as AccessMethod['effort'],
      sources: (Array.isArray(r.sources) ? r.sources : []).map(text).filter(Boolean),
    };
  });
  const sketch = o.interfaceSketch as Record<string, unknown> | undefined;
  const inventory = (Array.isArray(o.sourceInventory) ? o.sourceInventory : []).map(text).filter(Boolean);
  if (!(sketch && text(sketch.text)) && inventory.length === 0) {
    throw new PreparedOptionError('an interface sketch or a source inventory is required');
  }
  return {
    requirementId,
    feasibility: { verdict, note: text(f.note) },
    methods,
    ...(sketch && text(sketch.text) ? { interfaceSketch: { text: text(sketch.text), tested: sketch.tested === true } } : {}),
    ...(inventory.length ? { sourceInventory: inventory } : {}),
  };
}

/** Record a prepared option. It is an event, never a reading: nothing it says can make a requirement WORKING. */
export async function recordPreparedOption(projectId: string, input: unknown): Promise<PreparedOption> {
  const option = validatePreparedOption(input);
  await recordEvent({
    projectId,
    entityType: 'capability_requirement',
    entityId: option.requirementId,
    eventType: 'CAPABILITY_ASSESSED',
    payload: { kind: PREPARED_OPTION_KIND, integration: false, option: option as unknown as Record<string, unknown> },
  });
  return option;
}

/** The latest prepared option per requirement (history stays; a newer note supersedes for reading only). */
export async function preparedOptions(projectId: string): Promise<Map<string, PreparedOption>> {
  const events: ProjectEvent[] = await listEvents(projectId, 1000);
  const out = new Map<string, PreparedOption>();
  for (const e of [...events].reverse()) {
    if (e.payload.kind !== PREPARED_OPTION_KIND) continue;
    const o = e.payload.option as PreparedOption | undefined;
    if (o?.requirementId) out.set(o.requirementId, o);
  }
  return out;
}

/** A prepared option is never an integration: the only thing that says otherwise is a WORKING reading. */
export function countsAsIntegration(_option: PreparedOption): false {
  return false;
}

/** Keeping an option warm is a row. Anything costly is refused rather than built. */
export function warmCost(option: PreparedOption): { workers: 0; refused: string[] } {
  return {
    workers: 0,
    refused: option.methods.filter((m) => m.effort >= COSTLY_EFFORT).map((m) => `${m.name}: effort ${m.effort} is not built to keep an option warm`),
  };
}

export interface NeedResolution {
  requirementId: string;
  /** Methods Brain may pursue now, cheapest first: no gate stays closed. */
  permitted: AccessMethod[];
  /** Methods held behind a gate only a person can open, with the gates named. */
  gated: Array<{ method: AccessMethod; gates: Gate[] }>;
  /** The minimum missing capability: the cheapest permitted method, if any. */
  minimum: AccessMethod | null;
  /** The exact requirement `handOffToFactory` gives the existing Factory. */
  handoff: { objective: string; acceptanceConditions: string[] } | null;
  /** Gate-crossing steps are listed for the end report; they never block the permitted work. */
  needsPerson: Gate[];
}

/**
 * A real objective now needs a requirement: identify the option, compare the
 * permitted access methods, pick the minimum missing capability. `openGates`
 * are those the owner has already opened; everything else stays uncrossed.
 */
export function resolveNeed(option: PreparedOption | undefined, input: { requirementId: string; goal: string; openGates?: readonly Gate[] }): NeedResolution {
  const open = new Set(input.openGates ?? []);
  const methods = option?.methods ?? [];
  const permitted: AccessMethod[] = [];
  const gated: NeedResolution['gated'] = [];
  for (const m of methods) {
    const closed = m.gates.filter((g) => !open.has(g));
    if (closed.length === 0) permitted.push(m);
    else gated.push({ method: m, gates: closed });
  }
  permitted.sort((a, b) => a.effort - b.effort || a.name.localeCompare(b.name));
  const minimum = permitted[0] ?? null;
  return {
    requirementId: input.requirementId,
    permitted, gated, minimum,
    handoff: minimum
      ? {
          objective: `Make "${input.requirementId}" work for ${input.goal} using ${minimum.name} (${minimum.kind}), reusing the prepared interface sketch where one exists.`,
          acceptanceConditions: [
            `the ${input.requirementId} proof reading reaches WORKING over real attempts`,
            `the blocked work of ${input.goal} that needed it resumes`,
          ],
        }
      : null,
    needsPerson: [...new Set(gated.flatMap((g) => g.gates))],
  };
}

/** The comparison alone: a unit ran after the capability was handed off. `resumeOf` supplies its times from rows. */
export function blockedWorkResumed(input: { handedOffAt: string; unitRunTimes: readonly string[] }): boolean {
  return input.unitRunTimes.some((t) => t > input.handedOffAt);
}

export const PREPARED_HANDOFF_KIND = 'PREPARED_OPTION_HANDOFF';

/** What the Factory needs that a need does not carry: where the code lives and how it is verified. */
export interface FactoryHandoffContext {
  goal: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  mutationScope: string[];
  verificationCommands: string[];
  rollbackRequirement: string;
  repositoryRoot?: string | null;
  /** The originating goal's work items that waited on this capability; `advancePreparedOptions` judges their resumption. */
  blockedWorkItemIds?: string[];
}

/**
 * Hand the minimum missing capability to the existing Factory as a change
 * request, once. The submission key is derived from the requirement and the
 * goal, so a second call returns the same request instead of a duplicate, and
 * the handoff is written to `project_events` so `resumeOf` can find its time.
 * Nothing is handed over when no permitted method exists: gated work is for a
 * person and is reported, not forced. The request is created as a draft with
 * external spend prohibited; approval stays where the Factory puts it.
 */
export async function handOffToFactory(
  projectId: string,
  resolution: NeedResolution,
  context: FactoryHandoffContext,
): Promise<{ changeRequest: FactoryChangeRequest; created: boolean } | null> {
  if (!resolution.handoff || !resolution.minimum) return null;
  const submissionKey = handoffSubmissionKey(projectId, resolution.requirementId, context.goal);
  const { changeRequest, created } = await ensureChangeRequest({
    projectId,
    submissionKey,
    objective: resolution.handoff.objective,
    expectedOutcome: `${resolution.requirementId} works in production and the blocked work of ${context.goal} resumes`,
    nonGoals: ['keeping the option warm', 'crossing a credential, contract, spend or permission gate'],
    acceptanceConditions: resolution.handoff.acceptanceConditions.map((statement, i) => ({
      id: `A${String(i + 1).padStart(2, '0')}`,
      statement,
      verification: 'proof reading over real attempts, and rows showing the goal\'s work ran afterwards',
      mandatory: true,
    })),
    repository: context.repository,
    repositoryRoot: context.repositoryRoot ?? null,
    baseBranch: context.baseBranch,
    baseSha: context.baseSha,
    environment: 'LOCAL',
    riskClass: 'MEDIUM',
    mutationScope: context.mutationScope,
    deploymentPolicy: 'NONE',
    rollbackRequirement: context.rollbackRequirement,
    verificationCommands: context.verificationCommands,
  });
  if (created) await recordHandoff(projectId, resolution, changeRequest.id, context.goal, context.blockedWorkItemIds ?? []);
  return { changeRequest, created };
}

function handoffSubmissionKey(projectId: string, requirementId: string, goal: string): string {
  return `prepared-option:${createHash('sha256').update(`${projectId}\u0000${requirementId}\u0000${goal}`).digest('hex').slice(0, 24)}`;
}

async function recordHandoff(projectId: string, resolution: NeedResolution, changeRequestId: string, goal: string, blockedWorkItemIds: readonly string[]): Promise<void> {
  await recordEvent({
    projectId,
    entityType: 'capability_requirement',
    entityId: resolution.requirementId,
    eventType: 'CAPABILITY_ASSESSED',
    payload: { kind: PREPARED_HANDOFF_KIND, integration: false, changeRequestId, goal, method: resolution.minimum?.name ?? null, blockedWorkItemIds: [...blockedWorkItemIds] },
  });
}

/**
 * The causal chain a resumption must show, every link read from rows:
 * the handoff's change request was implemented, the capability then works, and
 * the blocked work ran after that. `implementedAt` is when the campaign the
 * handoff created reached COMPLETE; `capability` is the proof reading over
 * attempts since then (null when the requirement is on no capability map, so
 * there is no probe to read and the implemented campaign is the only evidence).
 * Pure: `resumeOf` supplies every value.
 */
export function handoffCausedResumption(input: {
  handedOffAt: string;
  changeRequestWithdrawn: boolean;
  implementedAt: string | null;
  capability: CapabilityStatus | null;
  unitRunTimes: readonly string[];
}): boolean {
  if (input.changeRequestWithdrawn || !input.implementedAt) return false;
  if (input.implementedAt < input.handedOffAt) return false;
  if (input.capability !== null && input.capability !== 'WORKING') return false;
  return blockedWorkResumed({ handedOffAt: input.implementedAt, unitRunTimes: input.unitRunTimes });
}

export interface Resumption {
  handedOffAt: string | null;
  changeRequestId: string | null;
  /** When the handoff's campaign reached COMPLETE, or null while it has not. */
  implementedAt: string | null;
  /** The requirement's proof reading since `implementedAt`; null when no map holds the requirement. */
  capability: { status: CapabilityStatus; why: string } | null;
  resumed: boolean;
  /** Blocked items that completed after the capability was implemented and working. */
  completedAfter: string[];
}

/**
 * Did the originating goal's blocked work resume *because of the handoff*?
 *
 * A named work item reaching SUCCEEDED after the handoff is not enough: it may
 * have been completed by other means, or retried and succeeded for an unrelated
 * reason. So three things are read, and all must hold:
 *  1. the handoff's change request was not withdrawn and the campaign Factory
 *     ran for it is COMPLETE (the change was implemented), after the handoff;
 *  2. where the requirement is on a capability map, its own proof probe read
 *     over attempts since that completion classifies WORKING;
 *  3. a named blocked item completed after the implementation.
 * Nothing is asserted by the caller but which items were blocked.
 */
export async function resumeOf(
  projectId: string,
  requirementId: string,
  blockedWorkItemIds: readonly string[],
  options: { changeRequestId?: string; now?: Date; root?: string } = {},
): Promise<Resumption> {
  const events = await listEventsByEntity('capability_requirement', requirementId);
  const handoffs = events
    .filter((e) => e.projectId === projectId && e.payload.kind === PREPARED_HANDOFF_KIND)
    .filter((e) => !options.changeRequestId || e.payload.changeRequestId === options.changeRequestId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const handoff = handoffs[0];
  const none: Resumption = {
    handedOffAt: handoff?.createdAt ?? null,
    changeRequestId: typeof handoff?.payload.changeRequestId === 'string' ? handoff.payload.changeRequestId : null,
    implementedAt: null,
    capability: null,
    resumed: false,
    completedAfter: [],
  };
  if (!handoff || !none.changeRequestId || blockedWorkItemIds.length === 0) return none;
  const handedOffAt = handoff.createdAt;

  const changeRequest = await getChangeRequest(none.changeRequestId);
  const withdrawn = !changeRequest || changeRequest.state === 'WITHDRAWN';
  const campaign = withdrawn ? null : await getCampaignByChangeRequest(none.changeRequestId);
  const implementedAt = campaign && campaign.state === 'COMPLETE' ? (campaign.finishedAt ?? campaign.updatedAt) : null;
  if (withdrawn || !implementedAt || implementedAt < handedOffAt) return { ...none, implementedAt };

  const requirements = Object.values(CAPABILITY_MAPS).flatMap((m) => m.requirements.filter((r) => r.id === requirementId));
  let capability: Resumption['capability'] = null;
  if (requirements.length > 0) {
    const to = (options.now ?? new Date()).toISOString();
    for (const requirement of requirements) {
      let assessed: { status: CapabilityStatus; why: string };
      try {
        const reading = await readProbe(requirement.proof.probe, implementedAt, to);
        assessed = classify(requirement, ownerExists(requirement.owner[0]!, options.root), reading);
      } catch {
        assessed = { status: 'UNPROVEN', why: 'the probe could not be read' };
      }
      capability = { status: assessed.status, why: assessed.why };
      if (assessed.status !== 'WORKING') break;
    }
  }

  const rows = await getDb().all<{ id: string; completed_at: string | null }>(
    `SELECT id, completed_at FROM work_items WHERE project_id = ? AND state = 'SUCCEEDED' AND id IN (${blockedWorkItemIds.map(() => '?').join(',')})`,
    [projectId, ...blockedWorkItemIds],
  );
  const times = rows.filter((r) => r.completed_at !== null);
  const resumed = handoffCausedResumption({
    handedOffAt,
    changeRequestWithdrawn: withdrawn,
    implementedAt,
    capability: capability?.status ?? null,
    unitRunTimes: times.map((r) => r.completed_at!),
  });
  return {
    ...none,
    implementedAt,
    capability,
    resumed,
    completedAfter: resumed ? times.filter((r) => r.completed_at! > implementedAt).map((r) => r.id) : [],
  };
}

export const PREPARED_RESUMED_KIND = 'PREPARED_OPTION_RESUMED';

/**
 * Judge, from rows, every handoff whose blocked work has not yet been recorded
 * as resumed. Called from `advanceSources` on the Russell tick, so nobody has to
 * remember an old option: a handoff that names blocked work items is re-read
 * each pass and, the first time `resumeOf` finds one of them completed after
 * the handoff was implemented and the capability reads WORKING, a single
 * RESUMED event is appended. It creates no work, holds no
 * lease and spends nothing; a handoff that names no work items is never judged.
 */
export async function advancePreparedOptions(
  input: { submit?: FactorySubmit; now?: Date } = {},
): Promise<{ judged: number; resumed: number; prepared: number; needs: number; handedOff: number }> {
  // Produce first, so the rows judged below are ones the running Brain wrote.
  const produced = await prepareForLiveGoals(input).catch((error: unknown) => {
    console.warn(`[prepared] producing prepared options failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    return { prepared: 0, needs: 0, handedOff: 0 };
  });
  const rows = await getDb().all<{ project_id: string; entity_id: string; payload: string }>(
    `SELECT project_id, entity_id, payload FROM project_events
      WHERE entity_type = 'capability_requirement' AND event_type = 'CAPABILITY_ASSESSED'
        AND (payload LIKE ? OR payload LIKE ?)`,
    [`%${PREPARED_HANDOFF_KIND}"%`, `%${PREPARED_RESUMED_KIND}"%`],
  );
  const parse = (raw: string): Record<string, unknown> => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  };
  const done = new Set<string>();
  const pending: Array<{ projectId: string; requirementId: string; changeRequestId: string; blocked: string[] }> = [];
  for (const r of rows) {
    const p = parse(r.payload);
    const crId = typeof p.changeRequestId === 'string' ? p.changeRequestId : '';
    if (p.kind === PREPARED_RESUMED_KIND) done.add(crId);
    else if (p.kind === PREPARED_HANDOFF_KIND && Array.isArray(p.blockedWorkItemIds) && p.blockedWorkItemIds.length > 0) {
      pending.push({ projectId: r.project_id, requirementId: r.entity_id, changeRequestId: crId, blocked: p.blockedWorkItemIds.filter((x): x is string => typeof x === 'string') });
    }
  }
  let judged = 0;
  let resumed = 0;
  for (const h of pending) {
    if (done.has(h.changeRequestId)) continue;
    judged += 1;
    const r = await resumeOf(h.projectId, h.requirementId, h.blocked, h.changeRequestId ? { changeRequestId: h.changeRequestId } : {});
    if (!r.resumed) continue;
    await recordEvent({
      projectId: h.projectId,
      entityType: 'capability_requirement',
      entityId: h.requirementId,
      eventType: 'CAPABILITY_ASSESSED',
      payload: {
        kind: PREPARED_RESUMED_KIND, integration: false, changeRequestId: h.changeRequestId, completedAfter: r.completedAfter,
        implementedAt: r.implementedAt, capability: r.capability,
      },
    });
    resumed += 1;
  }
  return { judged, resumed, ...produced };
}

/* --------------------------------------------------------------------------
 * The production producer: a live goal's own capability record drives it.
 * ------------------------------------------------------------------------ */

export const PREPARED_NEED_KIND = 'PREPARED_OPTION_NEED';

/** At most this many Factory submissions a tick: keeping options warm stays a row, not a burst. */
export const HANDOFFS_PER_TICK = 2;

/**
 * The cheapest honest preparation Brain can make without a worker: what the
 * capability map already states about the requirement. The existing owner is
 * the reuse method (no gate, small effort when it is in the image); a stated
 * external limit is a method only a person can open. The sketch is untested and
 * says so; the inventory is the owner's own paths and the probe that proves it.
 */
export function optionFromRequirement(requirement: CapabilityRequirement, ownerInImage: boolean): PreparedOption {
  const owner = requirement.owner[0] ?? requirement.id;
  const methods: AccessMethod[] = [
    { name: `extend the existing owner ${owner}`, kind: 'OTHER', gates: [], effort: ownerInImage ? 2 : 3, sources: [...requirement.owner] },
  ];
  if (requirement.externalLimit) {
    methods.push({ name: `outside Brain: ${requirement.externalLimit}`.slice(0, 300), kind: 'OTHER', gates: ['PERMISSION'], effort: 3, sources: [] });
  }
  const note = [
    ownerInImage ? `The existing owner ${owner} is in the image; the gap is in what production reads, not in a missing module.` : `The owner ${owner} is not in the image yet.`,
    requirement.externalLimit ? `Part of it is outside Brain: ${requirement.externalLimit}` : '',
    'Map-derived; no integration was built and none is implied.',
  ].filter(Boolean).join(' ');
  return validatePreparedOption({
    requirementId: requirement.id,
    feasibility: { verdict: ownerInImage && !requirement.externalLimit ? 'FEASIBLE' : 'UNCERTAIN', note },
    methods,
    interfaceSketch: {
      text: `${requirement.ability}. Inputs: ${requirement.inputs.join('; ') || 'none stated'}. Outputs: ${requirement.outputs.join('; ') || 'none stated'}. Proven by the ${requirement.proof.probe} probe.`,
      tested: false,
    },
    sourceInventory: [...requirement.owner, `probe:${requirement.proof.probe}`],
  });
}

/** What the existing Factory contract is asked; a unit can satisfy every acceptance condition with a commit. */
export interface PreparedFactoryAsk {
  submissionKey: string;
  objective: string;
  expectedOutcome: string;
  nonGoals: string[];
  acceptanceConditions: Array<{ statement: string; verification: string; mandatory: boolean }>;
  mutationScope: string[];
}

/** Submits an ask to the existing Factory; null when no project holds the Brain repository grant. */
export type FactorySubmit = (ask: PreparedFactoryAsk) => Promise<{ changeRequestId: string; created: boolean } | null>;

/** The existing Factory contract on the Brain repository grant, as the improvement loop submits — left a draft. */
const submitToFactory: FactorySubmit = async (ask) => {
  const grant = await getDb().get<{ project_id: string }>(
    "SELECT project_id FROM factory_project_repositories WHERE grant_id = 'brain' ORDER BY created_at LIMIT 1",
    [],
  );
  if (!grant) return null;
  const [{ submitObjective }, { BRAIN_REPOSITORY_REMOTE }] = await Promise.all([
    import('../factory/contract.ts'),
    import('../improvement/loop.ts'),
  ]);
  const out = await submitObjective({
    projectId: grant.project_id,
    ...ask,
    repositoryRemote: BRAIN_REPOSITORY_REMOTE,
    baseBranch: 'production',
  });
  return { changeRequestId: out.changeRequest.id, created: out.created };
};

const requirementById = (id: string): CapabilityRequirement | null => {
  for (const map of Object.values(CAPABILITY_MAPS)) {
    const found = map.requirements.find((r) => r.id === id);
    if (found) return found;
  }
  return null;
};

/**
 * Read every live goal's latest capability record and act on what blocks it:
 * record a prepared option where none exists, record the need and its
 * permitted/gated comparison once per goal, and hand the minimum missing
 * capability to the existing Factory once per goal where no other path owns it.
 * A requirement with an improvement route is the improvement loop's
 * (`capabilityWeaknesses`), so it is never submitted twice. Holds no lease and
 * starts no worker; the Factory request is a draft, so approval stays with it.
 */
export async function prepareForLiveGoals(
  input: { submit?: FactorySubmit; limit?: number } = {},
): Promise<{ prepared: number; needs: number; handedOff: number }> {
  const submit = input.submit ?? submitToFactory;
  const goals = await getDb().all<{ id: string; project_id: string; intent: string }>(
    `SELECT id, project_id, intent FROM workstreams
      WHERE archived_at IS NULL AND cancelled_at IS NULL AND project_id IS NOT NULL
      ORDER BY created_at DESC LIMIT ?`,
    [Math.max(1, input.limit ?? 20)],
  );
  let prepared = 0;
  let needs = 0;
  let handedOff = 0;
  for (const goal of goals) {
    const last = await getDb().get<{ payload: string }>(
      `SELECT payload FROM project_events WHERE entity_type = 'WORKSTREAM' AND entity_id = ? AND event_type = 'CAPABILITY_ASSESSED'
        ORDER BY created_at DESC LIMIT 1`,
      [goal.id],
    );
    if (!last) continue;
    let blocking: string[] = [];
    try {
      const raw = (JSON.parse(last.payload) as { blocking?: unknown }).blocking;
      blocking = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      continue;
    }
    if (blocking.length === 0) continue;
    const options = await preparedOptions(goal.project_id);
    for (const entry of blocking) {
      const requirement = requirementById(entry.slice(entry.indexOf(':') + 1));
      if (!requirement) continue;
      let option = options.get(requirement.id);
      if (!option) {
        option = await recordPreparedOption(goal.project_id, optionFromRequirement(requirement, ownerExists(requirement.owner[0]!)));
        options.set(requirement.id, option);
        prepared += 1;
      }
      const history = (await listEventsByEntity('capability_requirement', requirement.id)).filter((e) => e.projectId === goal.project_id);
      const resolution = resolveNeed(option, { requirementId: requirement.id, goal: `goal ${goal.id} (${goal.intent.slice(0, 120)})` });
      const routedByImprovement = Boolean(requirement.improvement);
      if (!history.some((e) => e.payload.kind === PREPARED_NEED_KIND && e.payload.goalId === goal.id)) {
        await recordEvent({
          projectId: goal.project_id,
          entityType: 'capability_requirement',
          entityId: requirement.id,
          eventType: 'CAPABILITY_ASSESSED',
          payload: {
            kind: PREPARED_NEED_KIND, integration: false, goalId: goal.id, blocking: entry,
            permitted: resolution.permitted.map((m) => m.name), gated: resolution.gated.map((g) => ({ method: g.method.name, gates: g.gates })),
            minimum: resolution.minimum?.name ?? null, needsPerson: resolution.needsPerson,
            route: routedByImprovement ? 'IMPROVEMENT_LOOP' : resolution.handoff ? 'PREPARED_HANDOFF' : 'PERSON',
          },
        });
        needs += 1;
      }
      if (routedByImprovement || !resolution.handoff || !resolution.minimum || handedOff >= HANDOFFS_PER_TICK) continue;
      if (history.some((e) => e.payload.kind === PREPARED_HANDOFF_KIND && e.payload.goal === goal.id)) continue;
      const blocked = await getDb().all<{ id: string }>(
        `SELECT id FROM work_items WHERE project_id = ? AND state IN ('QUEUED', 'LEASED') ORDER BY created_at LIMIT 20`,
        [goal.project_id],
      );
      const submitted = await submit({
        submissionKey: handoffSubmissionKey(goal.project_id, requirement.id, goal.id),
        objective: `${resolution.handoff.objective} The capability-map requirement ${requirement.id} reads ${entry.slice(0, entry.indexOf(':'))} and blocks goal ${goal.id}.`,
        expectedOutcome: `${requirement.id} reads WORKING over real attempts and the goal's blocked work resumes; Brain measures both from rows.`,
        nonGoals: ['keeping the option warm', 'crossing a credential, contract, spend or permission gate'],
        acceptanceConditions: [
          { statement: `A test exercises "${requirement.ability}" through ${requirement.owner[0]} and passes.`, verification: 'npm test', mandatory: true },
          { statement: 'The repository typechecks and the impacted tests pass.', verification: 'npm run typecheck && npm run test:impacted', mandatory: true },
        ],
        mutationScope: [...requirement.owner, 'tests/**'],
      });
      if (!submitted) continue;
      await recordHandoff(goal.project_id, resolution, submitted.changeRequestId, goal.id, blocked.map((b) => b.id));
      handedOff += 1;
    }
  }
  return { prepared, needs, handedOff };
}
