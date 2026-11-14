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
 * The link between a cash row and a requirement is read from the requirement's
 * own rows, never guessed from prose. A requirement supplies a cash capability
 * when its `outputs` name that capability id (`RESEARCH_A_QUESTION`, or
 * `capability:RESEARCH_A_QUESTION`), or when a file it changes or cites as
 * existing (`paths`, `existing.paths`) lies inside the code that answers that
 * capability (`CAPABILITY_OWNER_PATHS`) — the files whose state decides whether
 * `readCapability` reads PRESENT. Production maps are decomposed from the source
 * and name paths, not cash capability ids, so without the second link the
 * comparison saw no supplier at all (review finding, 2026-11-13). A need for a
 * capability no requirement supplies still promotes nothing.
 *
 * Only a requirement this module promoted is ever demoted, and only once no open
 * need is still blocked on it. A requirement a person left live is never touched,
 * and nothing is removed from the specification.
 */
import type { ProgramRequirement, RequirementMap, RequirementReading, RequirementStatus } from '../../domain/factoryProgram.ts';
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';
import { registerProbe } from '../factory/program/probes.ts';
import { reconcileCapabilities, type BlockedTransactionRow, type CapabilityReconciliation, type CapabilityRecordRow } from './priority.ts';

export const CAPABILITY_EVENT_KINDS = {
  promoted: 'PROGRAM_CAPABILITY_PROMOTED',
  demoted: 'PROGRAM_CAPABILITY_DEMOTED',
  /** Promotable, but ranked below the free worker slots this pass; it stays prepared. */
  deferred: 'PROGRAM_CAPABILITY_DEFERRED',
  /**
   * What one comparison over a program's map read and decided: which requirements
   * supply which capability, how many open needs are blocked on each, and what it
   * promoted, demoted or deferred. Recorded whenever that outcome changes, so the
   * production record shows the comparison running — and finding suppliers, or
   * finding none — even on a pass that moves no requirement.
   */
  reviewed: 'PROGRAM_CAPABILITY_REVIEWED',
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

/**
 * The code that answers each cash capability (`services/cash/capabilities.ts`):
 * the files whose state decides whether its reader says PRESENT. A requirement
 * whose own paths lie inside these supplies the capability. Shared plumbing every
 * effect passes through (`cash/effects.ts`) is deliberately absent, so touching it
 * does not make a requirement the supplier of everything. A capability with no
 * reader and no implementation (`PUBLISH_A_LISTING`) has no owner and is supplied
 * only by an explicit output. `tests/...-capability-supply.test.ts` keeps this in
 * step with the vocabulary and with the files on disk.
 */
export const CAPABILITY_OWNER_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RESEARCH_A_QUESTION: ['server/services/research/auditAdmission.ts', 'server/services/fleet/**', 'server/repos/fleet.ts'],
  SEND_A_MESSAGE: ['server/services/cash/providers/instantly.ts', 'server/services/cash/providers/instantlySync.ts', 'server/services/cash/providers/resend.ts'],
  ISSUE_AN_INVOICE: ['server/services/cash/invoicing.ts', 'server/services/cash/providers/stripe.ts'],
  TAKE_A_PAYMENT: ['server/services/cash/providers/payments.ts', 'server/services/cash/providers/stripe.ts'],
  BUILD_SOFTWARE: ['server/services/cash/factoryHandoff.ts'],
  SIGN_AN_AGREEMENT: ['server/services/cash/journey/deal.ts'],
  PRODUCE_SPREADSHEET: ['server/services/cash/deliverables/**'],
  PRODUCE_DOCUMENT: ['server/services/cash/deliverables/**'],
  PRODUCE_PRESENTATION: ['server/services/cash/deliverables/**'],
  PRODUCE_DATASET: ['server/services/cash/deliverables/**'],
  PRODUCE_WEBSITE: ['server/services/cash/deliverables/**'],
  PRODUCE_CODE: ['server/services/cash/deliverables/**'],
  PRODUCE_GRAPHIC: ['server/services/cash/deliverables/**'],
  PRODUCE_MODEL_3D: ['server/services/cash/deliverables/**'],
});

/** A path or glob with its trailing `/**` (or `*`) removed, and whether it named a tree. */
function pathRoot(path: string): { root: string; tree: boolean } {
  const trimmed = path.trim().replace(/^\.\//, '');
  const star = trimmed.indexOf('*');
  if (star < 0) return { root: trimmed, tree: false };
  return { root: trimmed.slice(0, star).replace(/\/+$/, ''), tree: true };
}

/**
 * Whether a requirement's path lies inside an owner path. The requirement's path
 * must be at least as specific as the owner's: a requirement over the whole of
 * `server/services/cash/**` is not thereby the supplier of a payment provider.
 */
export function pathWithin(requirementPath: string, ownerPath: string): boolean {
  const req = pathRoot(requirementPath);
  const own = pathRoot(ownerPath);
  if (!req.root || !own.root) return false;
  if (!own.tree) return !req.tree && req.root === own.root;
  return req.root === own.root ? true : req.root.startsWith(`${own.root}/`);
}

/** The cash capability ids a requirement supplies: named in its outputs, or owned by a file it changes or cites. */
export function suppliedCapabilities(requirement: Pick<ProgramRequirement, 'outputs'> & Partial<Pick<ProgramRequirement, 'paths' | 'existing'>>): Set<string> {
  const out = new Set<string>();
  for (const raw of requirement.outputs) {
    const one = raw.trim();
    const id = one.startsWith(CAPABILITY_KEY) ? one.slice(CAPABILITY_KEY.length).trim() : one;
    if (/^[A-Z][A-Z0-9_]{2,80}$/.test(id)) out.add(id);
  }
  const paths = [...(requirement.paths ?? []), ...(requirement.existing?.paths ?? [])];
  if (paths.length === 0) return out;
  for (const [id, owners] of Object.entries(CAPABILITY_OWNER_PATHS)) {
    if (paths.some((p) => owners.some((o) => pathWithin(p, o)))) out.add(id);
  }
  return out;
}

/**
 * Which requirements of a map supply which cash capabilities — the reading that
 * shows on production records whether the comparison has any supplier to work
 * with. Pure.
 */
export function capabilitySupply(map: Pick<RequirementMap, 'requirements'>): { requirementsSupplying: number; byCapability: Record<string, string[]> } {
  const byCapability: Record<string, string[]> = {};
  let requirementsSupplying = 0;
  for (const requirement of map.requirements) {
    const supplied = suppliedCapabilities(requirement);
    if (supplied.size > 0) requirementsSupplying += 1;
    for (const id of supplied) (byCapability[id] ??= []).push(requirement.key);
  }
  return { requirementsSupplying, byCapability };
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
  programs(): Promise<{ id: string; map: RequirementMap; mapVersion?: number | null; readings: RequirementReading[]; edgesOf: (r: ProgramRequirement) => string[] }[]>;
  openNeeds(): Promise<CashNeed[]>;
  opportunity(id: string): Promise<CashOpportunity | null>;
  /** Keys promoted here and not since demoted, per program. */
  promotedHere(programId: string): Promise<Set<string>>;
  proposeMap(input: { programId: string; map: RequirementMap; reason: string }): Promise<{ version: number | null }>;
  record(kind: string, detail: Record<string, unknown>): Promise<void>;
  parallelWorkers(): Promise<number | null>;
  /**
   * The fingerprint of the newest review recorded for a program, or null. When the
   * port is absent no review is recorded (a caller that only wants transitions).
   */
  latestReview?(programId: string): Promise<string | null>;
}

/** What one comparison over one program read and decided. */
export interface CapabilityReview {
  programId: string;
  mapVersion: number | null;
  requirementsSupplying: number;
  supply: Record<string, string[]>;
  /** Open needs blocked on each capability some requirement supplies. */
  openNeedsBlocked: Record<string, number>;
  /** Open capability needs no requirement of this map supplies. */
  unsupplied: Record<string, number>;
  prepared: string[];
  promoted: string[];
  demoted: string[];
  deferred: string[];
  refused: boolean;
  parallelWorkers: number | null;
}

/** What makes two reviews the same outcome: nothing a clock changes. Pure. */
export function reviewFingerprint(review: CapabilityReview): string {
  const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return [
    review.programId,
    review.mapVersion ?? '-',
    sorted(review.supply),
    sorted(review.openNeedsBlocked),
    sorted(review.unsupplied),
    review.prepared.join(','),
    review.promoted.join(','),
    review.demoted.join(','),
    review.deferred.join(','),
    review.refused ? 'REFUSED' : 'APPLIED',
  ].join('|');
}

/** The review of one program's comparison, from its map, the open needs and the decision. Pure. */
export function reviewOf(input: {
  programId: string;
  map: RequirementMap;
  mapVersion: number | null;
  needs: Pick<CashNeed, 'requestKey' | 'state'>[];
  decision: Pick<CapabilityReconciliation, 'promotions' | 'demotions'> & { deferred: { id: string }[] };
  refused: boolean;
  parallelWorkers: number | null;
}): CapabilityReview {
  const supply = capabilitySupply(input.map);
  const openNeedsBlocked: Record<string, number> = {};
  const unsupplied: Record<string, number> = {};
  for (const need of input.needs) {
    const capability = capabilityOfNeed(need);
    if (!capability) continue;
    if (supply.byCapability[capability]) openNeedsBlocked[capability] = (openNeedsBlocked[capability] ?? 0) + 1;
    else unsupplied[capability] = (unsupplied[capability] ?? 0) + 1;
  }
  return {
    programId: input.programId,
    mapVersion: input.mapVersion,
    requirementsSupplying: supply.requirementsSupplying,
    supply: supply.byCapability,
    openNeedsBlocked,
    unsupplied,
    prepared: input.map.requirements.filter((r) => r.prepared === true).map((r) => r.key).sort(),
    promoted: input.refused ? [] : input.decision.promotions.map((p) => p.id),
    demoted: input.refused ? [] : input.decision.demotions.map((d) => d.id),
    deferred: input.refused ? [] : input.decision.deferred.map((d) => d.id),
    refused: input.refused,
    parallelWorkers: input.parallelWorkers,
  };
}

async function recordReview(ports: CapabilityPorts, review: CapabilityReview): Promise<void> {
  if (!ports.latestReview) return;
  const fingerprint = reviewFingerprint(review);
  if ((await ports.latestReview(review.programId)) === fingerprint) return;
  await ports.record(CAPABILITY_EVENT_KINDS.reviewed, { ...review, fingerprint });
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
    const review = (refused: boolean) =>
      recordReview(ports, reviewOf({ programId: program.id, map: program.map, mapVersion: program.mapVersion ?? null, needs, decision, refused, parallelWorkers: workers }));
    if (decision.promotions.length === 0 && decision.demotions.length === 0) {
      await review(false);
      continue;
    }
    const promoted = decision.promotions.map((p) => p.id);
    const demoted = decision.demotions.map((d) => d.id);
    const reason = [
      ...decision.promotions.map((p) => `promote ${p.id}: ${p.decision.evidence.join('; ')}`),
      ...demoted.map((key) => `demote ${key}: no open need is blocked on it any more; the requirement is retained`),
    ].join(' | ').slice(0, 900);
    const applied = await ports.proposeMap({ programId: program.id, map: applyDecisions(program.map, decision), reason });
    if (applied.version === null) {
      await review(true);
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
    await review(false);
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
  const { recordFactoryEvent } = await import('../../repos/factoryFleet.ts');
  const { newestFactoryEvent, newestFactoryEvents } = await import('./newestEvents.ts');
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
        out.push({ id: program.id, map: map.map, mapVersion: map.version, readings: reading.requirements, edgesOf: (r) => edgesOf(r, extra) });
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
      // Newest first: the first event seen for a requirement is its current
      // state, so a later demotion overrides the promotion it follows. The whole
      // ledger is read, never its oldest 5000 (`listFactoryEvents` is oldest first).
      const latest = new Map<string, string>();
      for await (const e of newestFactoryEvents([CAPABILITY_EVENT_KINDS.promoted, CAPABILITY_EVENT_KINDS.demoted])) {
        const requirement = e.detail.requirement;
        if (e.detail.programId !== programId || typeof requirement !== 'string' || latest.has(requirement)) continue;
        latest.set(requirement, e.kind);
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
    async latestReview(programId) {
      const newest = await newestFactoryEvent([CAPABILITY_EVENT_KINDS.reviewed], (e) => e.detail.programId === programId);
      return newest && typeof newest.detail.fingerprint === 'string' ? newest.detail.fingerprint : null;
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

/* ------------------------------------------------------------------------- */
/* The fixed check of GOV-22-1, on production records                          */
/* ------------------------------------------------------------------------- */

export interface ComparisonEvidence {
  program: { id: string; map: RequirementMap; mapVersion: number } | null;
  /** This program's promotions and demotions oldest first, then its newest review. */
  events: { kind: string; detail: Record<string, unknown> }[];
}

/**
 * Whether the capability comparison holds on production records. Pure: the caller
 * supplies the program's installed map and the factory events. It passes only when
 *
 *  - some requirement of the installed map supplies a cash capability, so the
 *    comparison has a supplier to promote at all;
 *  - a review of that same map version is recorded, so the running Brain compared
 *    the map with the open needs rather than a test doing so;
 *  - every recorded promotion carries its measured evidence, and every promoted
 *    or demoted requirement is still in the map — demotion changes readiness and
 *    never removes a requirement from the specification.
 *
 * A side that cannot be read is a failure that says which, never a pass.
 */
export function checkCapabilityComparison(evidence: ComparisonEvidence): { ok: boolean; detail: string } {
  const program = evidence.program;
  if (!program) return { ok: false, detail: 'no approved architecture program with an installed map on production' };
  const supply = capabilitySupply(program.map);
  const capabilities = Object.keys(supply.byCapability).sort();
  if (supply.requirementsSupplying === 0) {
    return { ok: false, detail: `program ${program.id} map v${program.mapVersion}: no requirement supplies a cash capability, so no measured blocker can promote anything` };
  }
  const mine = evidence.events.filter((e) => e.detail.programId === program.id);
  const review = mine.filter((e) => e.kind === CAPABILITY_EVENT_KINDS.reviewed).at(-1);
  if (!review) return { ok: false, detail: `program ${program.id}: ${supply.requirementsSupplying} supplier(s), but no comparison is recorded on production yet` };
  if (review.detail.mapVersion !== program.mapVersion) {
    return { ok: false, detail: `program ${program.id}: the newest comparison read map v${String(review.detail.mapVersion)}, the installed map is v${program.mapVersion}` };
  }
  const keys = new Set(program.map.requirements.map((r) => r.key));
  let promotions = 0;
  let demotions = 0;
  for (const e of mine) {
    const requirement = typeof e.detail.requirement === 'string' ? e.detail.requirement : null;
    if (e.kind === CAPABILITY_EVENT_KINDS.promoted) {
      promotions += 1;
      if (!requirement || !keys.has(requirement)) return { ok: false, detail: `promoted requirement ${String(requirement)} is no longer in map v${program.mapVersion}` };
      if (!Array.isArray(e.detail.evidence) || e.detail.evidence.length === 0) return { ok: false, detail: `the promotion of ${requirement} records no measured evidence` };
    } else if (e.kind === CAPABILITY_EVENT_KINDS.demoted) {
      demotions += 1;
      if (!requirement || !keys.has(requirement)) return { ok: false, detail: `demoted requirement ${String(requirement)} was removed from map v${program.mapVersion}; a demotion retains it` };
      if (e.detail.requirementRetained !== true) return { ok: false, detail: `the demotion of ${requirement} does not record the requirement as retained` };
    }
  }
  const counts = (o: unknown) => JSON.stringify(o && typeof o === 'object' ? o : {});
  return {
    ok: true,
    detail:
      `program ${program.id} map v${program.mapVersion}: ${supply.requirementsSupplying} requirement(s) supply ${capabilities.join(', ')}; ` +
      `newest comparison: open needs blocked ${counts(review.detail.openNeedsBlocked)}, unsupplied ${counts(review.detail.unsupplied)}, ` +
      `${Array.isArray(review.detail.prepared) ? review.detail.prepared.length : 0} prepared; ` +
      `${promotions} promotion(s) and ${demotions} demotion(s) recorded, every one still in the map`,
  };
}

/** The evidence on production: the architecture program's installed map and its capability events. */
export async function comparisonEvidenceOnProduction(): Promise<ComparisonEvidence> {
  const { getDb } = await import('../../db/database.ts');
  const { getProgram, getMap } = await import('../../repos/factoryProgram.ts');
  const { ARCHITECTURE_PROGRAM_KEY } = await import('../factory/program/probes.ts');
  const { allFactoryEventsOldestFirst, newestFactoryEvent } = await import('./newestEvents.ts');
  const row = await getDb().get<{ id: string }>(`SELECT id FROM factory_programs WHERE submission_key = ? ORDER BY created_at LIMIT 1`, [ARCHITECTURE_PROGRAM_KEY]);
  const program = row ? await getProgram(row.id) : null;
  const map = program && program.state === 'APPROVED' ? await getMap(program.id) : null;
  // Every transition of this program (oldest first) and its newest review — read
  // newest first, so neither is lost once a kind passes `listFactoryEvents`' cap.
  const mine = (e: { detail: Record<string, unknown> }) => program !== null && e.detail.programId === program.id;
  const transitions = program ? await allFactoryEventsOldestFirst([CAPABILITY_EVENT_KINDS.promoted, CAPABILITY_EVENT_KINDS.demoted], mine) : [];
  const review = program ? await newestFactoryEvent([CAPABILITY_EVENT_KINDS.reviewed], mine) : null;
  const events = review ? [...transitions, review] : transitions;
  return {
    program: program && map ? { id: program.id, map: map.map, mapVersion: map.version } : null,
    events: events.map((e) => ({ kind: e.kind, detail: e.detail })),
  };
}

/**
 * The fixed check of GOV-22-1: `probe r01.gov-22-1({}) passes`. Registered by the
 * module the goals tick loads at boot, so the running Brain answers it from its
 * own rows rather than reporting it unregistered.
 */
registerProbe('r01.gov-22-1', async () => checkCapabilityComparison(await comparisonEvidenceOnProduction()));
