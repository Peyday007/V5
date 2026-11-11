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
 * `handOffToFactory` is the one place the handoff is made, and `resumeOf` is the
 * one place resumption is judged, from `work_items` rows.
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
import type { ProjectEvent } from '../../domain/types.ts';
import type { FactoryChangeRequest } from '../../domain/factory.ts';
import type { ProgramRequirement } from '../../domain/factoryProgram.ts';

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

/**
 * Record a prepared option. It is an event, never a reading: nothing it says can make a requirement WORKING.
 * `origin` says which production record the option was read from, so a reader can trace it.
 */
export async function recordPreparedOption(projectId: string, input: unknown, origin?: Record<string, unknown>): Promise<PreparedOption> {
  const option = validatePreparedOption(input);
  await recordEvent({
    projectId,
    entityType: 'capability_requirement',
    entityId: option.requirementId,
    eventType: 'CAPABILITY_ASSESSED',
    payload: { kind: PREPARED_OPTION_KIND, integration: false, option: option as unknown as Record<string, unknown>, ...(origin ? { origin } : {}) },
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

/** One handoff per requirement and goal, whichever entrance made it. */
function handoffSubmissionKey(projectId: string, requirementId: string, goal: string): string {
  return `prepared-option:${createHash('sha256').update(`${projectId}\u0000${requirementId}\u0000${goal}`).digest('hex').slice(0, 24)}`;
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
  if (created) {
    await recordEvent({
      projectId,
      entityType: 'capability_requirement',
      entityId: resolution.requirementId,
      eventType: 'CAPABILITY_ASSESSED',
      payload: { kind: PREPARED_HANDOFF_KIND, integration: false, changeRequestId: changeRequest.id, goal: context.goal, method: resolution.minimum.name, blockedWorkItemIds: context.blockedWorkItemIds ?? [] },
    });
  }
  return { changeRequest, created };
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

/** Link 1, from rows: was the handoff's change request withdrawn, and when did its campaign reach COMPLETE? */
async function implementationOf(changeRequestId: string): Promise<{ withdrawn: boolean; implementedAt: string | null; requestedAt: string | null }> {
  const changeRequest = await getChangeRequest(changeRequestId);
  const withdrawn = !changeRequest || changeRequest.state === 'WITHDRAWN';
  const campaign = withdrawn ? null : await getCampaignByChangeRequest(changeRequestId);
  const implementedAt = campaign && campaign.state === 'COMPLETE' ? (campaign.finishedAt ?? campaign.updatedAt) : null;
  return { withdrawn, implementedAt, requestedAt: changeRequest?.createdAt ?? null };
}

/** Link 2: the requirement's own proof reading since `implementedAt`; null when no capability map holds it. */
async function capabilitySince(
  requirementId: string,
  implementedAt: string,
  options: { now?: Date; root?: string },
): Promise<{ status: CapabilityStatus; why: string } | null> {
  const requirements = Object.values(CAPABILITY_MAPS).flatMap((m) => m.requirements.filter((r) => r.id === requirementId));
  let capability: { status: CapabilityStatus; why: string } | null = null;
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
  return capability;
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

  const { withdrawn, implementedAt } = await implementationOf(none.changeRequestId);
  if (withdrawn || !implementedAt || implementedAt < handedOffAt) return { ...none, implementedAt };
  const capability = await capabilitySince(requirementId, implementedAt, options);

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

/** A dependent live requirement's campaign, as rows record it, for `programDependentsResumed`. */
export interface DependentCampaignRun {
  requirementKey: string;
  campaignId: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * The program path's comparison (finding F5). For a program dependency the
 * blocked work is the dependent live requirements' campaigns: they wait on the
 * prepared requirement's campaign through the plan's dependency order. A
 * dependent campaign resumed when, after the prepared campaign reached
 * COMPLETE (and, where a capability map holds the requirement, its proof
 * reads WORKING), it started (and was not cancelled) or it completed. Pure.
 */
export function programDependentsResumed(input: {
  changeRequestWithdrawn: boolean;
  implementedAt: string | null;
  capability: CapabilityStatus | null;
  dependents: readonly DependentCampaignRun[];
}): DependentCampaignRun[] {
  if (input.changeRequestWithdrawn || !input.implementedAt) return [];
  if (input.capability !== null && input.capability !== 'WORKING') return [];
  const at = input.implementedAt;
  return input.dependents.filter((d) =>
    (d.state !== 'CANCELLED' && d.startedAt > at)
    || (d.state === 'COMPLETE' && d.finishedAt !== null && d.finishedAt > at));
}

export interface ProgramResumption {
  changeRequestId: string;
  implementedAt: string | null;
  capability: { status: CapabilityStatus; why: string } | null;
  /** Every dependent campaign the program has linked so far, read from rows. */
  dependents: DependentCampaignRun[];
  /** Those that started or completed after the prepared campaign completed. */
  resumedCampaigns: DependentCampaignRun[];
  resumed: boolean;
}

/**
 * Did the originating goal's blocked work resume, for a program dependency?
 * Every value is read from rows: the prepared requirement's campaign (the
 * handoff the coordinator linked) and its completion; the dependent live
 * requirements' campaigns, found through the program's current plan
 * (`implements`) and its campaign links. Nothing is supplied by a caller but
 * which program and which live requirements depend on the prepared one, both
 * recorded on the handoff when it was identified.
 */
export async function resumeOfProgram(
  requirementId: string,
  changeRequestId: string,
  programId: string,
  dependentRequirements: readonly string[],
  options: { now?: Date; root?: string } = {},
): Promise<ProgramResumption> {
  const { withdrawn, implementedAt } = await implementationOf(changeRequestId);
  const base: ProgramResumption = { changeRequestId, implementedAt, capability: null, dependents: [], resumedCampaigns: [], resumed: false };
  if (withdrawn || !implementedAt || dependentRequirements.length === 0) return base;
  const capability = await capabilitySince(requirementId, implementedAt, options);

  const { getPlan, listCampaignLinks } = await import('../../repos/factoryProgram.ts');
  const plan = await getPlan(programId);
  const links = new Map((await listCampaignLinks(programId)).map((l) => [l.campaignKey, l.changeRequestId]));
  const dependents: DependentCampaignRun[] = [];
  const seen = new Set<string>();
  for (const key of dependentRequirements) {
    for (const planned of plan?.plan.campaigns.filter((c) => c.implements.includes(key)) ?? []) {
      const crId = links.get(planned.key);
      if (!crId || crId === changeRequestId) continue;
      const campaign = await getCampaignByChangeRequest(crId);
      if (!campaign || seen.has(campaign.id)) continue;
      seen.add(campaign.id);
      dependents.push({ requirementKey: key, campaignId: campaign.id, state: campaign.state, startedAt: campaign.startedAt, finishedAt: campaign.finishedAt });
    }
  }
  const resumedCampaigns = programDependentsResumed({ changeRequestWithdrawn: withdrawn, implementedAt, capability: capability?.status ?? null, dependents });
  return { ...base, capability, dependents, resumedCampaigns, resumed: resumedCampaigns.length > 0 };
}

export const PREPARED_RESUMED_KIND = 'PREPARED_OPTION_RESUMED';

/**
 * Identify, from rows, open work that needs a recorded option and hand it off
 * (`identifyPreparedDependencies`); then judge every handoff whose blocked work
 * has not yet been recorded as resumed. Called from `advanceSources` on the Russell tick, so nobody has to
 * remember an old option: a handoff that names blocked work items is re-read
 * each pass and, the first time `resumeOf` finds one of them completed after
 * the handoff was implemented and the capability reads WORKING, a single
 * RESUMED event is appended. A program handoff (the campaign the program's
 * coordinator linked for a prepared requirement) is judged by `resumeOfProgram`
 * instead: its blocked work is the dependent live requirements' campaigns, read
 * from the plan and the campaign links. It creates no work, holds no lease and
 * spends nothing; a handoff that names neither work items nor dependent
 * requirements is never judged.
 */
export async function advancePreparedOptions(): Promise<{ judged: number; resumed: number; identified: number; handedOff: number; recorded: number }> {
  // The producer (F1): every prepared requirement of an approved program is recorded as an option, from rows.
  const { recorded } = await recordProgramPreparedOptions();
  // Then, from rows, which open work now needs a recorded option (F2): no caller names it.
  const { identified, handedOff } = await identifyPreparedDependencies();
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
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const pending: Array<{ projectId: string; requirementId: string; changeRequestId: string; blocked: string[] }> = [];
  const programPending: Array<{ projectId: string; requirementId: string; changeRequestId: string; programId: string; dependents: string[] }> = [];
  // A program handoff recorded before it carried its dependents is re-read from the program's rows.
  let current: IdentifiedDependency[] | null = null;
  const dependentsNow = async (programId: string, requirementId: string): Promise<string[]> => {
    current ??= await identifyProgramDependencies();
    return current.find((d) => d.programId === programId && d.requirementId === requirementId)?.dependentRequirements ?? [];
  };
  for (const r of rows) {
    const p = parse(r.payload);
    const crId = typeof p.changeRequestId === 'string' ? p.changeRequestId : '';
    const fromProgram = typeof p.programId === 'string' ? p.programId
      : typeof p.identifiedFrom === 'string' && p.identifiedFrom.startsWith('program:') ? p.identifiedFrom.slice('program:'.length) : null;
    if (p.kind === PREPARED_RESUMED_KIND) done.add(crId);
    else if (p.kind === PREPARED_HANDOFF_KIND && crId && fromProgram) {
      // A program dependency's blocked work is its dependent live requirements' campaigns (F5).
      const recorded = strings(p.dependentRequirements);
      const dependents = recorded.length > 0 ? recorded : await dependentsNow(fromProgram, r.entity_id);
      if (dependents.length > 0) programPending.push({ projectId: r.project_id, requirementId: r.entity_id, changeRequestId: crId, programId: fromProgram, dependents });
    } else if (p.kind === PREPARED_HANDOFF_KIND && strings(p.blockedWorkItemIds).length > 0) {
      pending.push({ projectId: r.project_id, requirementId: r.entity_id, changeRequestId: crId, blocked: strings(p.blockedWorkItemIds) });
    }
  }
  let judged = 0;
  let resumed = 0;
  for (const h of programPending) {
    if (done.has(h.changeRequestId)) continue;
    done.add(h.changeRequestId);
    judged += 1;
    const r = await resumeOfProgram(h.requirementId, h.changeRequestId, h.programId, h.dependents);
    if (!r.resumed) continue;
    await recordEvent({
      projectId: h.projectId,
      entityType: 'capability_requirement',
      entityId: h.requirementId,
      eventType: 'CAPABILITY_ASSESSED',
      payload: {
        kind: PREPARED_RESUMED_KIND, integration: false, changeRequestId: h.changeRequestId, programId: h.programId,
        completedAfter: r.resumedCampaigns.map((c) => c.campaignId),
        resumedCampaigns: r.resumedCampaigns as unknown as Record<string, unknown>[],
        implementedAt: r.implementedAt, capability: r.capability,
      },
    });
    resumed += 1;
  }
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
  return { judged, resumed, identified, handedOff, recorded };
}

/* -------------------------------------------------------------------------- */
/* Identifying the dependency from rows (finding F2)                           */
/* -------------------------------------------------------------------------- */

export const PREPARED_DEPENDENCY_KIND = 'PREPARED_OPTION_DEPENDENCY';

/** Bins in these states are work that has not happened yet. */
const OPEN_BIN_STATES = ['DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN'] as const;

/**
 * One piece of a real objective's blocked work that names a requirement a
 * prepared option stands behind. Read from rows, never supplied by a caller:
 *  - a bin not yet finished whose `required_capabilities` names it — its
 *    unfinished work items are the blocked work `resumeOf` later judges;
 *  - an OPEN cash need blocked on it (`CAPABILITY:<id>`, or the older request
 *    key `capability:<opportunity>:<id>`), the commercial pipeline's own record
 *    that an opening is waiting on it.
 */
export interface IdentifiedDependency {
  projectId: string;
  requirementId: string;
  /** `bin:<id>` or `need:<id>` — what is waiting. */
  sourceRef: string;
  goal: string;
  blockedWorkItemIds: string[];
  /**
   * For a dependency read from a program map: the change request the program's
   * coordinator linked for the campaign that implements the requirement (null
   * while none is linked). Present only for program dependencies.
   */
  reuseChangeRequestId?: string | null;
  /** For a program dependency: the program, and the live requirements whose campaigns wait on it (the blocked work). */
  programId?: string;
  dependentRequirements?: string[];
}

/** Which recorded prepared options a project's open work now depends on. Reads only. */
export async function identifyDependencies(projectId: string, requirementIds: readonly string[]): Promise<IdentifiedDependency[]> {
  if (requirementIds.length === 0) return [];
  const db = getDb();
  const out: IdentifiedDependency[] = [];
  const wanted = new Set(requirementIds);

  const bins = await db.all<{ id: string; title: string; objective: string; manifest: string; required_capabilities: string | null }>(
    `SELECT id, title, objective, manifest, required_capabilities FROM bins
      WHERE project_id = ? AND state IN (${OPEN_BIN_STATES.map(() => '?').join(', ')})
        AND (${requirementIds.map(() => 'required_capabilities LIKE ?').join(' OR ')})
      ORDER BY created_at, id`,
    [projectId, ...OPEN_BIN_STATES, ...requirementIds.map((id) => `%"${id}"%`)],
  );
  for (const bin of bins) {
    let caps: unknown;
    try { caps = JSON.parse(bin.required_capabilities ?? '[]'); } catch { caps = []; }
    const named = (Array.isArray(caps) ? caps : []).filter((c): c is string => typeof c === 'string' && wanted.has(c));
    if (named.length === 0) continue;
    let goal = '';
    try {
      const lineage = (JSON.parse(bin.manifest) as { lineage?: { goal?: unknown } }).lineage;
      goal = typeof lineage?.goal === 'string' ? lineage.goal.trim() : '';
    } catch { /* an unreadable manifest still names its bin */ }
    const items = await db.all<{ id: string }>(
      `SELECT id FROM work_items WHERE project_id = ? AND bin_id = ? AND state <> 'SUCCEEDED' ORDER BY created_at, id`,
      [projectId, bin.id],
    );
    for (const requirementId of [...new Set(named)]) {
      out.push({
        projectId, requirementId, sourceRef: `bin:${bin.id}`,
        goal: goal || `bin ${bin.id}: ${bin.title || bin.objective}`,
        blockedWorkItemIds: items.map((i) => i.id),
      });
    }
  }

  const { listNeeds } = await import('../../repos/cashPortfolio.ts');
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    // The typed blocker key names the fact; the request key is the older rows' only record of it.
    const typed = need.blockerKey?.startsWith('CAPABILITY:') ? need.blockerKey.slice('CAPABILITY:'.length) : null;
    const keyed = /^capability:.+:([^:]+)$/.exec(need.requestKey ?? '')?.[1] ?? null;
    const requirementId = typed ?? keyed;
    if (!requirementId || !wanted.has(requirementId)) continue;
    out.push({
      projectId, requirementId, sourceRef: `need:${need.id}`,
      goal: need.opportunityId ? `opportunity ${need.opportunityId}: ${need.blockedAction}` : need.blockedAction,
      blockedWorkItemIds: [],
    });
  }
  return out;
}

/**
 * Hand an identified dependency to the existing Factory through its own
 * entrance, `submitObjective`, against the one repository the project has
 * onboarded. Anything that stops it (no repository, several, a refusal, a
 * forge that did not answer) is returned as a reason rather than forced: the
 * next pass asks again, and the dependency stays recorded meanwhile.
 */
async function submitIdentified(dep: IdentifiedDependency, resolution: NeedResolution): Promise<{ changeRequestId: string; created: boolean } | { reason: string }> {
  if (!resolution.handoff || !resolution.minimum) {
    return { reason: resolution.needsPerson.length ? `every access method is behind a closed gate: ${resolution.needsPerson.join(', ')}` : 'no access method is recorded' };
  }
  const { repositoryChoicesFor } = await import('../russell/software.ts');
  const choices = await repositoryChoicesFor(dep.projectId);
  if (choices.length !== 1) {
    return { reason: choices.length === 0 ? 'this project has no repository onboarded for the Factory' : `this project has ${choices.length} repositories onboarded, and choosing one is a person's decision` };
  }
  const { submitObjective, ContractError } = await import('../factory/contract.ts');
  try {
    const submitted = await submitObjective({
      projectId: dep.projectId,
      objective: resolution.handoff.objective,
      expectedOutcome: `${dep.requirementId} works in production and the blocked work of ${dep.goal} resumes`,
      nonGoals: ['keeping the option warm', 'crossing a credential, contract, spend or permission gate'],
      acceptanceConditions: resolution.handoff.acceptanceConditions.map((statement) => ({
        statement,
        verification: 'proof reading over real attempts, and rows showing the goal\'s work ran afterwards',
        mandatory: true,
      })),
      repositoryRemote: choices[0]!.remote,
      submissionKey: handoffSubmissionKey(dep.projectId, dep.requirementId, dep.goal),
    });
    return { changeRequestId: submitted.changeRequest.id, created: submitted.created };
  } catch (error) {
    if (error instanceof ContractError) return { reason: `the Factory refused the objective: ${error.message}` };
    throw error;
  }
}

/**
 * Nobody has to remember an old option. Each pass reads every recorded
 * prepared option, finds the open work that names its requirement, records
 * that dependency once (with the access-method comparison and the minimum
 * missing capability), and hands the minimum to the existing Factory. The
 * handoff event carries the blocked work items, so `advancePreparedOptions`
 * then judges resumption with no caller supplying anything.
 */
export async function identifyPreparedDependencies(): Promise<{ identified: number; handedOff: number }> {
  const rows = await getDb().all<{ project_id: string; entity_id: string; payload: string; created_at: string }>(
    `SELECT project_id, entity_id, payload, created_at FROM project_events
      WHERE entity_type = 'capability_requirement' AND event_type = 'CAPABILITY_ASSESSED' AND payload LIKE ?
      ORDER BY created_at, id`,
    [`%"${PREPARED_OPTION_KIND}"%`],
  );
  const options = new Map<string, Map<string, PreparedOption>>();
  for (const r of rows) {
    let p: Record<string, unknown>;
    try { p = JSON.parse(r.payload) as Record<string, unknown>; } catch { continue; }
    if (p.kind !== PREPARED_OPTION_KIND) continue;
    const o = p.option as PreparedOption | undefined;
    if (!o?.requirementId) continue;
    const byReq = options.get(r.project_id) ?? new Map<string, PreparedOption>();
    byReq.set(o.requirementId, o);
    options.set(r.project_id, byReq);
  }

  let identified = 0;
  let handedOff = 0;
  const programDeps = await identifyProgramDependencies();
  for (const [projectId, byReq] of options) {
    const deps: IdentifiedDependency[] = [
      ...(await identifyDependencies(projectId, [...byReq.keys()])),
      ...programDeps.filter((d) => d.projectId === projectId && byReq.has(d.requirementId)),
    ];
    for (const dep of deps) {
      const option = byReq.get(dep.requirementId)!;
      const prior = (await listEventsByEntity('capability_requirement', dep.requirementId)).filter((e) => e.projectId === projectId);
      const resolution = resolveNeed(option, { requirementId: dep.requirementId, goal: dep.goal });
      if (!prior.some((e) => e.payload.kind === PREPARED_DEPENDENCY_KIND && e.payload.sourceRef === dep.sourceRef)) {
        await recordEvent({
          projectId,
          entityType: 'capability_requirement',
          entityId: dep.requirementId,
          eventType: 'CAPABILITY_ASSESSED',
          payload: {
            kind: PREPARED_DEPENDENCY_KIND, integration: false, sourceRef: dep.sourceRef, goal: dep.goal,
            blockedWorkItemIds: dep.blockedWorkItemIds,
            permitted: resolution.permitted.map((m) => m.name),
            gated: resolution.gated.map((g) => ({ method: g.method.name, gates: g.gates })),
            minimum: resolution.minimum?.name ?? null,
            needsPerson: resolution.needsPerson,
          },
        });
        identified += 1;
      }
      const handedFor = prior.some((e) => e.payload.kind === PREPARED_HANDOFF_KIND && e.payload.goal === dep.goal);
      if (handedFor) continue;
      // A program's own coordinator already starts the campaign that implements a promoted
      // requirement; that campaign is the handoff, reused rather than submitted a second time.
      const submitted = dep.reuseChangeRequestId !== undefined
        ? (dep.reuseChangeRequestId ? { changeRequestId: dep.reuseChangeRequestId, created: false } : { reason: 'the program has not linked a campaign for it yet' })
        : await submitIdentified(dep, resolution);
      if ('reason' in submitted) continue;
      await recordEvent({
        projectId,
        entityType: 'capability_requirement',
        entityId: dep.requirementId,
        eventType: 'CAPABILITY_ASSESSED',
        payload: {
          kind: PREPARED_HANDOFF_KIND, integration: false, changeRequestId: submitted.changeRequestId, goal: dep.goal,
          method: resolution.minimum?.name ?? null, blockedWorkItemIds: dep.blockedWorkItemIds, identifiedFrom: dep.sourceRef,
          ...(dep.reuseChangeRequestId !== undefined ? { reused: true } : {}),
          ...(dep.programId ? { programId: dep.programId, dependentRequirements: dep.dependentRequirements ?? [] } : {}),
        },
      });
      handedOff += 1;
    }
  }
  return { identified, handedOff };
}

/* -------------------------------------------------------------------------- */
/* The production producer (finding F1)                                        */
/* -------------------------------------------------------------------------- */

/** The origin a program-derived option carries; one record per program, requirement and map version. */
export const PROGRAM_MAP_ORIGIN = 'PROGRAM_MAP';

/**
 * A program requirement marked `prepared` is the approved specification's own
 * record of a dormant capability: specified and kept ready, not yet needed
 * (§97). Its preparation is read from the requirement's fields and nothing is
 * invented beyond them:
 *  - feasibility: FEASIBLE when the map names existing code as evidence,
 *    UNCERTAIN otherwise, with the requirement's missing work as the note;
 *  - the tool inventory is the one route Brain already owns — the existing
 *    Factory, over the paths the map declares — with no gate, because the map
 *    records none (a person adds one by amendment), and effort 1 when existing
 *    code is reused, 2 when it must be written. It is never at COSTLY_EFFORT:
 *    nothing is built to keep it warm;
 *  - the interface sketch is the behavior, inputs and outputs, untested;
 *  - the source inventory is the source items and the existing evidence paths.
 * Pure. The option is a record, and never an integration.
 */
export function preparedOptionFromRequirement(r: ProgramRequirement): PreparedOption {
  const paths = r.paths.length ? r.paths : (r.existing?.paths ?? []);
  const reused = r.existing !== null && r.existing.paths.length > 0;
  const note = (r.missingWork || r.behavior || r.title).trim() || r.key;
  const sketch = [
    r.behavior.trim(),
    r.inputs.length ? `inputs: ${r.inputs.join('; ')}` : '',
    r.outputs.length ? `outputs: ${r.outputs.join('; ')}` : '',
  ].filter(Boolean).join('\n');
  return validatePreparedOption({
    requirementId: r.key,
    feasibility: { verdict: reused ? 'FEASIBLE' : 'UNCERTAIN', note },
    methods: [{
      name: `existing Factory campaign over ${paths.length ? paths.join(', ') : `the ${r.subsystem} subsystem`}`,
      kind: 'OTHER',
      gates: [],
      effort: reused ? 1 : 2,
      sources: r.source,
    }],
    ...(sketch ? { interfaceSketch: { text: sketch, tested: false } } : {}),
    sourceInventory: [...r.source.map((s) => `source item ${s}`), ...(r.existing?.paths ?? [])],
  });
}

/**
 * Record every prepared requirement of every approved program as a prepared
 * option, once per map version. Called on the tick from `advancePreparedOptions`,
 * so a deferred capability stays recorded with nobody remembering it. It writes
 * events only: no lease, no worker, no bin, no change request.
 */
export async function recordProgramPreparedOptions(): Promise<{ recorded: number }> {
  const { listPrograms, getMap } = await import('../../repos/factoryProgram.ts');
  let recorded = 0;
  for (const program of await listPrograms(['APPROVED'])) {
    const installed = await getMap(program.id);
    if (!installed) continue;
    const prepared = installed.map.requirements.filter((r) => r.prepared === true);
    if (prepared.length === 0) continue;
    const seen = new Set<string>();
    const rows = await getDb().all<{ entity_id: string; payload: string }>(
      `SELECT entity_id, payload FROM project_events
        WHERE project_id = ? AND entity_type = 'capability_requirement' AND event_type = 'CAPABILITY_ASSESSED' AND payload LIKE ?`,
      [program.projectId, `%"${PROGRAM_MAP_ORIGIN}"%`],
    );
    for (const row of rows) {
      let origin: Record<string, unknown> | undefined;
      try { origin = (JSON.parse(row.payload) as { origin?: Record<string, unknown> }).origin; } catch { continue; }
      if (origin?.source === PROGRAM_MAP_ORIGIN && origin.programId === program.id) seen.add(`${row.entity_id}\u0000${String(origin.mapVersion)}`);
    }
    for (const requirement of prepared) {
      if (seen.has(`${requirement.key}\u0000${String(installed.version)}`)) continue;
      let option: PreparedOption;
      try { option = preparedOptionFromRequirement(requirement); } catch { continue; }
      await recordPreparedOption(program.projectId, option, { source: PROGRAM_MAP_ORIGIN, programId: program.id, mapVersion: installed.version });
      recorded += 1;
    }
  }
  return { recorded };
}

/**
 * Which program-derived options a live requirement now needs, from rows: a
 * prepared requirement reached from a requirement that is not prepared, through
 * declared and discovered edges — the same reading the coordinator uses to start
 * its campaign (`promotedRequirements`). The goal names the live requirements
 * that depend on it; the handoff reuses the campaign the coordinator linked.
 */
export async function identifyProgramDependencies(): Promise<IdentifiedDependency[]> {
  const { listPrograms, getMap, getPlan, listCampaignLinks, listDiscoveredDependencies } = await import('../../repos/factoryProgram.ts');
  const { promotedRequirements } = await import('../factory/program/plan.ts');
  const out: IdentifiedDependency[] = [];
  for (const program of await listPrograms(['APPROVED'])) {
    const installed = await getMap(program.id);
    if (!installed) continue;
    const map = installed.map;
    if (!map.requirements.some((r) => r.prepared === true)) continue;
    const extra = new Map<string, string[]>();
    for (const d of await listDiscoveredDependencies(program.id)) extra.set(d.requirementKey, [...(extra.get(d.requirementKey) ?? []), d.dependsOn]);
    const promoted = promotedRequirements(map, extra);
    if (promoted.size === 0) continue;
    const plan = await getPlan(program.id);
    const links = new Map((await listCampaignLinks(program.id)).map((l) => [l.campaignKey, l.changeRequestId]));
    for (const key of [...promoted].sort()) {
      // Which live requirements reach it: each one alone as the only live root.
      const dependents = map.requirements
        .filter((r) => r.prepared !== true)
        .filter((live) => promotedRequirements({ ...map, requirements: map.requirements.map((x) => ({ ...x, prepared: x.key !== live.key })) }, extra).has(key))
        .map((r) => r.key)
        .sort();
      const campaign = plan?.plan.campaigns.find((c) => c.implements.includes(key));
      out.push({
        projectId: program.projectId,
        requirementId: key,
        sourceRef: `program:${program.id}`,
        goal: `program ${program.id}: ${dependents.join(', ') || 'a live requirement'} depend(s) on ${key}`,
        blockedWorkItemIds: [],
        reuseChangeRequestId: campaign ? (links.get(campaign.key) ?? null) : null,
        programId: program.id,
        dependentRequirements: dependents,
      });
    }
  }
  return out;
}
