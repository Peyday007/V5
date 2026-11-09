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
 *    blocked work is judged resumed only by rows that show it ran afterwards.
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
import { ensureChangeRequest } from '../../repos/factory.ts';
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
  const submissionKey = `prepared-option:${createHash('sha256').update(`${projectId}\u0000${resolution.requirementId}\u0000${context.goal}`).digest('hex').slice(0, 24)}`;
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
      payload: { kind: PREPARED_HANDOFF_KIND, integration: false, changeRequestId: changeRequest.id, goal: context.goal, method: resolution.minimum.name },
    });
  }
  return { changeRequest, created };
}

/**
 * Did the originating goal's blocked work resume? Read from `work_items`: the
 * named items must have completed successfully after the handoff event was
 * written. Nothing is asserted by the caller but which items were blocked.
 */
export async function resumeOf(
  projectId: string,
  requirementId: string,
  blockedWorkItemIds: readonly string[],
): Promise<{ handedOffAt: string | null; resumed: boolean; completedAfter: string[] }> {
  const events = await listEventsByEntity('capability_requirement', requirementId);
  const handoff = events
    .filter((e) => e.projectId === projectId && e.payload.kind === PREPARED_HANDOFF_KIND)
    .map((e) => e.createdAt)
    .sort()[0];
  if (!handoff || blockedWorkItemIds.length === 0) return { handedOffAt: handoff ?? null, resumed: false, completedAfter: [] };
  const rows = await getDb().all<{ id: string; completed_at: string | null }>(
    `SELECT id, completed_at FROM work_items WHERE project_id = ? AND state = 'SUCCEEDED' AND id IN (${blockedWorkItemIds.map(() => '?').join(',')})`,
    [projectId, ...blockedWorkItemIds],
  );
  const times = rows.filter((r) => r.completed_at !== null);
  const resumed = blockedWorkResumed({ handedOffAt: handoff, unitRunTimes: times.map((r) => r.completed_at!) });
  return { handedOffAt: handoff, resumed, completedAfter: times.filter((r) => r.completed_at! > handoff).map((r) => r.id) };
}
