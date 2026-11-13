/**
 * The production consumer of `reconcileCapabilities` (GOV-22-1).
 *
 * `priority.ts` decides, purely, which prepared requirements a measured blocker
 * promotes and which promoted ones lost their need. This module is the caller it
 * names: it builds `CapabilityRecordRow`s from an approved program's own reading
 * and `BlockedTransactionRow`s from open cash needs, reconciles them, applies the
 * decision to the requirement's `prepared` flag through the program coordinator's
 * own `proposeMap` (so the map, the plan and the validation stay one owner), and
 * records one factory event per transition with the measured evidence.
 *
 * The link between a cash row and a requirement is data, not a list in code: a
 * requirement supplies a cash capability when its `outputs` name that capability
 * id (`RESEARCH_A_QUESTION`, or `capability:RESEARCH_A_QUESTION`). A need for a
 * capability no requirement supplies promotes nothing — it is never matched by
 * guessing from prose.
 *
 * Only a requirement this module promoted is ever demoted, and only once no open
 * need is still blocked on it. A requirement a person left live is never touched,
 * and nothing is removed from the specification.
 */
import type { ProgramRequirement, RequirementMap, RequirementReading, RequirementStatus } from '../../domain/factoryProgram.ts';
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';
import { registerProbe, type ProbeResult } from '../factory/program/probes.ts';
import { reconcileCapabilities, type BlockedTransactionRow, type CapabilityReconciliation, type CapabilityRecordRow } from './priority.ts';

export const CAPABILITY_EVENT_KINDS = {
  promoted: 'PROGRAM_CAPABILITY_PROMOTED',
  demoted: 'PROGRAM_CAPABILITY_DEMOTED',
} as const;

const CAPABILITY_KEY = 'capability:';

/** The cash capability id an open need is blocked on, or null when it is not a capability need. */
export function capabilityOfNeed(need: Pick<CashNeed, 'requestKey' | 'state'>): string | null {
  if (need.state !== 'OPEN' || !need.requestKey?.startsWith(CAPABILITY_KEY)) return null;
  const id = need.requestKey.slice(need.requestKey.lastIndexOf(':') + 1).trim();
  return id || null;
}

/** The cash capability ids a requirement says it supplies, from its own outputs. */
export function suppliedCapabilities(requirement: Pick<ProgramRequirement, 'outputs'>): Set<string> {
  const out = new Set<string>();
  for (const raw of requirement.outputs) {
    const one = raw.trim();
    const id = one.startsWith(CAPABILITY_KEY) ? one.slice(CAPABILITY_KEY.length).trim() : one;
    if (/^[A-Z][A-Z0-9_]{2,80}$/.test(id)) out.add(id);
  }
  return out;
}

/** Not yet started: no campaign has taken it up, so promotion or demotion only moves readiness. */
function notStarted(status: RequirementStatus): boolean {
  return status === 'SPECIFIED' || status === 'MAPPED';
}

export interface CapabilityRowsInput {
  map: RequirementMap;
  readings: Pick<RequirementReading, 'key' | 'status'>[];
  /** Dependency edges of each requirement (declared and discovered). */
  edgesOf: (requirement: ProgramRequirement) => string[];
  needs: Pick<CashNeed, 'requestKey' | 'state' | 'opportunityId' | 'projectId'>[];
  opportunities: Map<string, Pick<CashOpportunity, 'id' | 'projectId' | 'priceCents'>>;
  /** Requirement keys this module promoted and has not since demoted. */
  promotedHere: ReadonlySet<string>;
}

/** Rows for `reconcileCapabilities`, from the program's reading and the open cash needs. */
export function capabilityRowsFromProgram(input: CapabilityRowsInput): { capabilities: CapabilityRecordRow[]; blocked: BlockedTransactionRow[] } {
  const status = new Map(input.readings.map((r) => [r.key, r.status]));
  const suppliers = new Map<string, string[]>();
  for (const requirement of input.map.requirements) {
    for (const id of suppliedCapabilities(requirement)) suppliers.set(id, [...(suppliers.get(id) ?? []), requirement.key]);
  }
  const blocked: BlockedTransactionRow[] = [];
  for (const need of input.needs) {
    const capability = capabilityOfNeed(need);
    if (!capability || !need.opportunityId) continue;
    const opportunity = input.opportunities.get(need.opportunityId);
    for (const key of suppliers.get(capability) ?? []) {
      blocked.push({
        transactionId: need.opportunityId,
        capabilityId: key,
        valueCents: typeof opportunity?.priceCents === 'number' ? opportunity.priceCents : null,
        businessKey: opportunity?.projectId ?? need.projectId ?? null,
      });
    }
  }
  const blockedKeys = new Set(blocked.map((b) => b.capabilityId));
  const capabilities: CapabilityRecordRow[] = [];
  for (const requirement of input.map.requirements) {
    const current = status.get(requirement.key);
    if (!current || !notStarted(current)) continue;
    const edges = input.edgesOf(requirement);
    const prerequisitesMet = edges.every((key) => status.get(key) === 'PRODUCTION_VERIFIED');
    // A blocker measured now says the need exists; its absence says the need vanished only
    // for a requirement this module promoted. Otherwise nothing is known about the need.
    const needStillExists = blockedKeys.has(requirement.key) ? true : input.promotedHere.has(requirement.key) ? false : null;
    capabilities.push({
      id: requirement.key,
      // Prepared reads MAPPED in the program's status; to the decision it is a specified requirement not started.
      status: 'SPECIFIED',
      prepared: requirement.prepared === true,
      prerequisitesMet,
      needStillExists,
      dueAt: null,
      workaroundCostCents: null,
      buildCostCents: null,
      interfaceChanged: null,
      otherBeneficiaries: null,
      uncertainty: null,
      opportunityCostCents: null,
    });
  }
  return { capabilities, blocked };
}

/** The map with each decision applied to `prepared`. Nothing else about a requirement changes. */
export function applyDecisions(map: RequirementMap, decision: Pick<CapabilityReconciliation, 'promotions' | 'demotions'>): RequirementMap {
  const promote = new Set(decision.promotions.map((p) => p.id));
  const demote = new Set(decision.demotions.map((d) => d.id));
  return {
    ...map,
    requirements: map.requirements.map((r) => {
      if (promote.has(r.key)) {
        const { prepared: _dropped, ...live } = r;
        return live;
      }
      if (demote.has(r.key)) return { ...r, prepared: true };
      return r;
    }),
  };
}

export interface CapabilityPorts {
  programs(): Promise<{ id: string; map: RequirementMap; readings: RequirementReading[]; edgesOf: (r: ProgramRequirement) => string[] }[]>;
  openNeeds(): Promise<CashNeed[]>;
  opportunity(id: string): Promise<CashOpportunity | null>;
  /** Keys promoted here and not since demoted, per program. */
  promotedHere(programId: string): Promise<Set<string>>;
  proposeMap(input: { programId: string; map: RequirementMap; reason: string }): Promise<{ version: number | null }>;
  record(kind: string, detail: Record<string, unknown>): Promise<void>;
  parallelWorkers(): Promise<number | null>;
}

export interface CapabilityPassReport {
  programId: string;
  promoted: string[];
  demoted: string[];
  /** Set when the coordinator refused the revised map; nothing was recorded as applied. */
  refused: boolean;
}

async function openNeedsWithOpportunities(ports: Pick<CapabilityPorts, 'openNeeds' | 'opportunity'>) {
  const needs = await ports.openNeeds();
  const opportunities = new Map<string, CashOpportunity>();
  for (const need of needs) {
    if (!capabilityOfNeed(need) || !need.opportunityId || opportunities.has(need.opportunityId)) continue;
    const one = await ports.opportunity(need.opportunityId);
    if (one) opportunities.set(one.id, one);
  }
  return { needs, opportunities };
}

/** One pass over every approved program: read rows, decide, apply through the coordinator, record. */
export async function reconcilePreparedCapabilities(ports: CapabilityPorts): Promise<CapabilityPassReport[]> {
  const { needs, opportunities } = await openNeedsWithOpportunities(ports);
  const workers = await ports.parallelWorkers();
  const reports: CapabilityPassReport[] = [];
  for (const program of await ports.programs()) {
    const promotedHere = await ports.promotedHere(program.id);
    const rows = capabilityRowsFromProgram({ map: program.map, readings: program.readings, edgesOf: program.edgesOf, needs, opportunities, promotedHere });
    const decision = reconcileCapabilities(rows.capabilities, rows.blocked, { parallelWorkers: workers });
    if (decision.promotions.length === 0 && decision.demotions.length === 0) continue;
    const promoted = decision.promotions.map((p) => p.id);
    const demoted = decision.demotions.map((d) => d.id);
    const reason = [
      ...decision.promotions.map((p) => `promote ${p.id}: ${p.decision.evidence.join('; ')}`),
      ...demoted.map((key) => `demote ${key}: no open need is blocked on it any more; the requirement is retained`),
    ].join(' | ').slice(0, 900);
    const applied = await ports.proposeMap({ programId: program.id, map: applyDecisions(program.map, decision), reason });
    if (applied.version === null) {
      reports.push({ programId: program.id, promoted: [], demoted: [], refused: true });
      continue;
    }
    for (const p of decision.promotions) {
      await ports.record(CAPABILITY_EVENT_KINDS.promoted, { programId: program.id, requirement: p.id, reasons: p.decision.reasons, evidence: p.decision.evidence, mapVersion: applied.version });
    }
    for (const key of demoted) {
      await ports.record(CAPABILITY_EVENT_KINDS.demoted, { programId: program.id, requirement: key, requirementRetained: true, mapVersion: applied.version });
    }
    reports.push({ programId: program.id, promoted, demoted, refused: false });
  }
  return reports;
}

/** The ports production runs on. Imported lazily so the goals tick does not load the factory at module load. */
export async function productionCapabilityPorts(): Promise<CapabilityPorts> {
  const { listPrograms, getMap } = await import('../../repos/factoryProgram.ts');
  const { readProgram, proposeMap } = await import('../factory/program/coordinator.ts');
  const { productionPorts } = await import('../factory/program/ports.ts');
  const { edgesOf } = await import('../factory/program/map.ts');
  const { listDiscoveredDependencies } = await import('../../repos/factoryProgram.ts');
  const { listProjects } = await import('../../repos/projects.ts');
  const { listNeeds, getOpportunity } = await import('../../repos/cashPortfolio.ts');
  const { listFactoryEvents, recordFactoryEvent } = await import('../../repos/factoryFleet.ts');
  const ports = productionPorts();
  return {
    async programs() {
      const out: Awaited<ReturnType<CapabilityPorts['programs']>> = [];
      for (const program of await listPrograms(['APPROVED'])) {
        const map = await getMap(program.id);
        if (!map) continue;
        const reading = await readProgram(program.id, ports);
        const extra = new Map<string, string[]>();
        for (const d of await listDiscoveredDependencies(program.id)) extra.set(d.requirementKey, [...(extra.get(d.requirementKey) ?? []), d.dependsOn]);
        out.push({ id: program.id, map: map.map, readings: reading.requirements, edgesOf: (r) => edgesOf(r, extra) });
      }
      return out;
    },
    async openNeeds() {
      const out: CashNeed[] = [];
      for (const project of await listProjects()) out.push(...(await listNeeds({ projectId: project.id, states: ['OPEN'] })));
      return out;
    },
    opportunity: getOpportunity,
    async promotedHere(programId) {
      const events = await listFactoryEvents(null, { kinds: [CAPABILITY_EVENT_KINDS.promoted, CAPABILITY_EVENT_KINDS.demoted], limit: 5000 });
      const latest = new Map<string, string>();
      // Newest first: the first event seen for a requirement is its current state.
      for (const e of events) {
        const requirement = e.detail.requirement;
        if (e.detail.programId !== programId || typeof requirement !== 'string') continue;
        if (!latest.has(requirement)) latest.set(requirement, e.kind);
      }
      return new Set([...latest].filter(([, kind]) => kind === CAPABILITY_EVENT_KINDS.promoted).map(([key]) => key));
    },
    async proposeMap(input) {
      const result = await proposeMap({ programId: input.programId, map: input.map, actorType: 'FACTORY', actorId: null, reason: `capability promotion (GOV-22-1): ${input.reason}` });
      return { version: result.version };
    },
    async record(kind, detail) {
      await recordFactoryEvent({ kind, evidenceClass: 'MEASURED', detail });
    },
    // No row states how many workers are free for program work, so none is assumed:
    // the ranking is recorded and promotion still follows the measured blocker.
    async parallelWorkers() {
      return null;
    },
  };
}

export const CAPABILITY_PASS_EVERY_MS = 60_000;
let lastPass = 0;

/** At most once a minute, from the goals tick. A failure is reported, never thrown into the tick. */
export async function reconcilePreparedCapabilitiesIfDue(now = Date.now()): Promise<CapabilityPassReport[] | { error: string }> {
  if (now - lastPass < CAPABILITY_PASS_EVERY_MS) return [];
  lastPass = now;
  try {
    return await reconcilePreparedCapabilities(await productionCapabilityPorts());
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/* ------------------------------------------------------------------------- */
/* The fixed check of GOV-22-1: probe r01.gov-22-1                             */
/* ------------------------------------------------------------------------- */

/**
 * Reads the same production rows the pass reads and decides without applying,
 * then checks the recorded transitions against the installed maps: every
 * requirement whose newest capability event is a promotion is still in the map
 * (neither promotion nor demotion removes a requirement from the specification).
 * Fails when there is no approved program to read, or a promoted requirement has
 * vanished from its map. Pending decisions are reported, not failed: the pass
 * applies them on its next minute.
 */
export async function capabilityPromotionHolds(ports: CapabilityPorts): Promise<ProbeResult> {
  const programs = await ports.programs();
  if (programs.length === 0) return { ok: false, detail: 'no approved program with an installed map to read' };
  const { needs, opportunities } = await openNeedsWithOpportunities(ports);
  const workers = await ports.parallelWorkers();
  const parts: string[] = [];
  for (const program of programs) {
    const promotedHere = await ports.promotedHere(program.id);
    const byKey = new Map(program.map.requirements.map((r) => [r.key, r]));
    let reprepared = 0;
    for (const key of promotedHere) {
      const requirement = byKey.get(key);
      if (!requirement) return { ok: false, detail: `program ${program.id}: ${key} was promoted but is no longer in the map` };
      // Another map revision (a person's) may prepare it again; that is reported, not overridden.
      if (requirement.prepared === true) reprepared += 1;
    }
    const rows = capabilityRowsFromProgram({ map: program.map, readings: program.readings, edgesOf: program.edgesOf, needs, opportunities, promotedHere });
    const decision = reconcileCapabilities(rows.capabilities, rows.blocked, { parallelWorkers: workers });
    const prepared = program.map.requirements.filter((r) => r.prepared === true).length;
    parts.push(
      `program ${program.id}: ${prepared} prepared, ${rows.capabilities.length} not started, ${rows.blocked.length} blocked transaction link(s), ` +
        `${promotedHere.size} promoted by a measured blocker (${reprepared} since prepared again by another revision), pending ${decision.promotions.length} promotion(s) / ${decision.demotions.length} demotion(s)`,
    );
  }
  return { ok: true, detail: `${needs.length} open cash need(s) read; ${parts.join('; ')}`.slice(0, 900) };
}

registerProbe('r01.gov-22-1', async () => capabilityPromotionHolds(await productionCapabilityPorts()));
