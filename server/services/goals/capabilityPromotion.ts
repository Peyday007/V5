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
import { reconcileCapabilities, type BlockedTransactionRow, type CapabilityReconciliation, type CapabilityRecordRow } from './priority.ts';

export const CAPABILITY_EVENT_KINDS = {
  promoted: 'PROGRAM_CAPABILITY_PROMOTED',
  demoted: 'PROGRAM_CAPABILITY_DEMOTED',
  /** Promotable, but ranked below the free worker slots this pass; it stays prepared. */
  deferred: 'PROGRAM_CAPABILITY_DEFERRED',
} as const;

/**
 * The scheduler's use of the comparison. When the fleet's rows say how many
 * workers are free, only the promotions the ranking places within those slots
 * (urgency, net value after cost, opportunity cost and uncertainty, reuse,
 * prerequisites) are applied, in rank order; the rest stay prepared and are
 * recorded as deferred with their rank. When the rows do not say, promotion
 * still follows the measured blocker, as before: an unknown is not a reason
 * to hold a measured blocker back.
 */
export function withinWorkers(
  decision: CapabilityReconciliation,
  workers: number | null,
): CapabilityReconciliation & { deferred: CapabilityReconciliation['ranked'] } {
  if (workers === null) return { ...decision, deferred: [] };
  const startable = new Set(decision.ranked.filter((r) => r.startable).map((r) => r.id));
  const rank = new Map(decision.ranked.map((r) => [r.id, r.rank]));
  const promotions = decision.promotions
    .filter((p) => startable.has(p.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const deferred = decision.ranked.filter((r) => r.promotion.promote && !startable.has(r.id));
  return { ...decision, promotions, deferred };
}

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
  needs: (Pick<CashNeed, 'requestKey' | 'state' | 'opportunityId' | 'projectId'> & Partial<Pick<CashNeed, 'expectedCostCents' | 'occurrence'>>)[];
  opportunities: Map<string, Pick<CashOpportunity, 'id' | 'projectId' | 'priceCents'> & Partial<Pick<CashOpportunity, 'deadline'>>>;
  /** Requirement keys this module promoted and has not since demoted. */
  promotedHere: ReadonlySet<string>;
  /** Free worker slots read from the fleet's rows; null when unread. */
  parallelWorkers?: number | null;
}

/**
 * What building a requirement through Factory commits in money: nothing. A program
 * has no spending path — no money column, no ceiling, no ledger entry — and its
 * workers run on the subscription that started them, never a paid model API. The
 * cost of a build is worker time, which the ranking meets as parallel workers.
 */
export const FACTORY_BUILD_COST_CENTS = 0;

/** The measured comparison inputs for one supplied capability, from the open needs blocked on it. */
interface NeedMeasure {
  /** Transactions blocked: opportunity id -> value (null when unstated). */
  transactions: Map<string, number | null>;
  /** Earliest deadline among the blocked transactions. */
  dueAt: string | null;
  /** What the recommended ways round it cost, summed over the needs that state one. */
  workaroundCostCents: number | null;
  /** A need for it came back after it had been met: the old way stopped working. */
  returned: boolean;
  /** Businesses blocked on it with no transaction yet, beyond those with one. */
  unattachedBusinesses: Set<string>;
  attachedBusinesses: Set<string>;
}

/** Rows for `reconcileCapabilities`, from the program's reading and the open cash needs. */
export function capabilityRowsFromProgram(input: CapabilityRowsInput): { capabilities: CapabilityRecordRow[]; blocked: BlockedTransactionRow[] } {
  const status = new Map(input.readings.map((r) => [r.key, r.status]));
  const suppliers = new Map<string, string[]>();
  for (const requirement of input.map.requirements) {
    for (const id of suppliedCapabilities(requirement)) suppliers.set(id, [...(suppliers.get(id) ?? []), requirement.key]);
  }
  const blocked: BlockedTransactionRow[] = [];
  const measures = new Map<string, NeedMeasure>();
  const measureOf = (key: string): NeedMeasure => {
    let m = measures.get(key);
    if (!m) {
      m = { transactions: new Map(), dueAt: null, workaroundCostCents: null, returned: false, unattachedBusinesses: new Set(), attachedBusinesses: new Set() };
      measures.set(key, m);
    }
    return m;
  };
  for (const need of input.needs) {
    const capability = capabilityOfNeed(need);
    if (!capability) continue;
    const opportunity = need.opportunityId ? input.opportunities.get(need.opportunityId) : undefined;
    const business = opportunity?.projectId ?? need.projectId ?? null;
    for (const key of suppliers.get(capability) ?? []) {
      const m = measureOf(key);
      if (typeof need.expectedCostCents === 'number' && Number.isFinite(need.expectedCostCents) && need.expectedCostCents >= 0) {
        m.workaroundCostCents = (m.workaroundCostCents ?? 0) + need.expectedCostCents;
      }
      if (typeof need.occurrence === 'number' && need.occurrence >= 2) m.returned = true;
      if (!need.opportunityId) {
        if (business) m.unattachedBusinesses.add(business);
        continue;
      }
      if (business) m.attachedBusinesses.add(business);
      const value = typeof opportunity?.priceCents === 'number' ? opportunity.priceCents : null;
      m.transactions.set(need.opportunityId, value);
      const deadline = opportunity?.deadline ?? null;
      if (deadline && (m.dueAt === null || deadline < m.dueAt)) m.dueAt = deadline;
      blocked.push({ transactionId: need.opportunityId, capabilityId: key, valueCents: value, businessKey: business });
    }
  }
  const workers = typeof input.parallelWorkers === 'number' && Number.isFinite(input.parallelWorkers) ? Math.max(0, Math.floor(input.parallelWorkers)) : null;
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
    const m = measures.get(requirement.key);
    const values = m ? [...m.transactions.values()] : [];
    const others = m ? [...m.unattachedBusinesses].filter((b) => !m.attachedBusinesses.has(b)).length : 0;
    capabilities.push({
      id: requirement.key,
      // Prepared reads MAPPED in the program's status; to the decision it is a specified requirement not started.
      status: 'SPECIFIED',
      prepared: requirement.prepared === true,
      prerequisitesMet,
      needStillExists,
      // Urgency: the earliest deadline of a transaction it holds up.
      dueAt: m?.dueAt ?? null,
      // The workaround: what the needs' recommended ways round it cost, where a need states it.
      workaroundCostCents: m?.workaroundCostCents ?? null,
      buildCostCents: FACTORY_BUILD_COST_CENTS,
      // A need that returned after being met says the old way no longer works; otherwise unknown.
      interfaceChanged: m?.returned ? true : null,
      // Businesses blocked on it that have no transaction yet would reuse it too.
      otherBeneficiaries: m ? others : null,
      // The share of blocked transactions whose value no row states.
      uncertainty: values.length > 0 ? values.filter((v) => typeof v !== 'number').length / values.length : null,
      // Building on an idle worker forgoes nothing; with no free slot the cost is not measured.
      opportunityCostCents: workers !== null && workers > 0 ? 0 : null,
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

/** One pass over every approved program: read rows, decide, apply through the coordinator, record. */
export async function reconcilePreparedCapabilities(ports: CapabilityPorts): Promise<CapabilityPassReport[]> {
  const needs = await ports.openNeeds();
  const opportunities = new Map<string, CashOpportunity>();
  for (const need of needs) {
    if (!capabilityOfNeed(need) || !need.opportunityId || opportunities.has(need.opportunityId)) continue;
    const one = await ports.opportunity(need.opportunityId);
    if (one) opportunities.set(one.id, one);
  }
  const workers = await ports.parallelWorkers();
  const reports: CapabilityPassReport[] = [];
  for (const program of await ports.programs()) {
    const promotedHere = await ports.promotedHere(program.id);
    const rows = capabilityRowsFromProgram({ map: program.map, readings: program.readings, edgesOf: program.edgesOf, needs, opportunities, promotedHere, parallelWorkers: workers });
    const decision = withinWorkers(reconcileCapabilities(rows.capabilities, rows.blocked, { parallelWorkers: workers }), workers);
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
    // Recorded beside the transitions the same ranking applied, so a pass that changes nothing writes nothing.
    for (const d of decision.deferred) {
      await ports.record(CAPABILITY_EVENT_KINDS.deferred, { programId: program.id, requirement: d.id, rank: d.rank, netValueCents: d.netValueCents, reasons: d.promotion.reasons, evidence: d.promotion.evidence, parallelWorkers: workers, mapVersion: applied.version });
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
    // Free slots from the fleet's own rows (§23, §98): the safe concurrency target
    // less the bins leased now. A reading that fails is unknown, never a guess.
    async parallelWorkers() {
      try {
        const { idleCounts } = await import('../engineering/watchdog.ts');
        const counts = await idleCounts();
        return Math.max(0, counts.safeTarget - counts.activeWork);
      } catch {
        return null;
      }
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
