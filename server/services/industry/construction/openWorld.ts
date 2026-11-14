/**
 * Open-world construction (ARCH-01, with OPP-03 and COM-13-1; §81, §82, §92, §93).
 *
 * Existing knowledge is a resource, not the limit of options. Given what the
 * rows already hold, this asks which commercial roles could exist on each flow
 * that no record represents yet, constructs a business for each through the
 * one construction path (`constructBusinesses` → `solveEconomics`, ranked by
 * `viabilityRank`), and evaluates it. Nothing here is a catalog lookup, a fixed
 * play list or a goal-specific script: the role vocabulary is `roles.ts`'s
 * (seeds plus whatever the evidence records), the businesses are `businesses.ts`'s
 * positions, and the economics are `economics.ts`'s, so an arrangement nobody
 * has a row for is produced and scored exactly like one somebody has.
 *
 * Evaluation reads the evidence's observed facts, so it adapts when those
 * change: `adaptationToRecorded` compares a subject's reading without and with
 * the cash, demand, price, capacity and financing facts actually recorded
 * against its goals, and `adaptation` reports what moved. `withObserved` is a
 * pure what-if for callers and tests; the probe never uses it.
 *
 * Pure, except `openWorldHoldsOnRows`, which only reads. No store, scheduler or
 * authority path: the held records are read through the existing repositories.
 */
import type { Fact, FactKey, IndustryEvidence } from '../../../domain/construction.ts';
import type { CashOpportunity, IndustryNode } from '../../../domain/types.ts';
import { constructBusinesses, positionKey, type Business } from './businesses.ts';
import { solveEconomics, type BusinessEconomics } from './economics.ts';
import { viabilityRank } from './strategy.ts';
import { commercialRoles, type CommercialRole } from './roles.ts';
import { opportunityField, type FieldInput, type OpportunitySeed } from './origins.ts';
import type { assembleEvidence as assembleEvidenceFn, evidenceFromMap } from './service.ts';

/** What the rows already hold, as text: a role is represented when a record names it. */
export interface HeldRecords {
  texts: string[];
}

export function heldFromRows(nodes: Pick<IndustryNode, 'name' | 'description' | 'retiredAt'>[], opportunities: Pick<CashOpportunity, 'title' | 'industry'>[]): HeldRecords {
  const texts: string[] = [];
  for (const n of nodes) if (!n.retiredAt) texts.push(`${n.name} ${n.description ?? ''}`.toLowerCase());
  for (const o of opportunities) texts.push(`${o.title} ${o.industry ?? ''}`.toLowerCase());
  return { texts };
}

/** The words of a role's label that identify it (e.g. "broker", "reseller"), longest first. */
function roleTerms(role: CommercialRole): string[] {
  return role.label
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 5)
    .sort((a, b) => b.length - a.length);
}

export function represented(role: CommercialRole, held: HeldRecords): boolean {
  const terms = roleTerms(role);
  if (terms.length === 0) return false;
  return held.texts.some((t) => terms.some((w) => t.includes(w)));
}

export interface OpenArrangement {
  flowKey: string;
  roleId: string;
  roleLabel: string;
  roleOrigin: CommercialRole['origin'];
  /** The business constructed for the role, through the existing construction path. */
  business: Pick<Business, 'key' | 'label' | 'position' | 'segmentName' | 'excluded'>;
  viability: BusinessEconomics['viability'];
  rank: number;
  /** Monthly contribution at the middle case; null when unpriced. */
  midContribution: number | null;
  /** Days to the first collected dollar, working capital tied up and people doing the work, at the middle case. */
  midFirstCashDays: number | null;
  midWorkingCapital: number | null;
  midWorkers: number | null;
  unpriced: FactKey[];
  /** Field seeds whose category or prompt touches this flow's industry — the origins it answers. */
  seeds: Pick<OpportunitySeed, 'key' | 'origin'>[];
}

export interface OpenWorldReading {
  industry: string;
  flows: number;
  rolesConsidered: number;
  representedRoles: string[];
  arrangements: OpenArrangement[];
}

const ACCOUNTS = 3;

function bestBusinessFor(role: CommercialRole, segmentId: string | null, businesses: Business[], evidence: IndustryEvidence): { business: Business; econ: BusinessEconomics } | null {
  const keys = new Set(role.positions.map((p) => positionKey(p.position)));
  let best: { business: Business; econ: BusinessEconomics } | null = null;
  for (const b of businesses) {
    if (b.excluded || !keys.has(positionKey(b.position))) continue;
    // A flow's role is paid by that flow's payer, when the evidence names one.
    if (segmentId !== null && b.segment.actorId !== segmentId) continue;
    const econ = solveEconomics(b, evidence, { accounts: ACCOUNTS });
    if (!best) {
      best = { business: b, econ };
      continue;
    }
    const r = viabilityRank(econ) - viabilityRank(best.econ);
    const better = r < 0 || (r === 0 && (econ.mid?.contribution ?? -Infinity) > (best.econ.mid?.contribution ?? -Infinity));
    if (better) best = { business: b, econ };
  }
  return best;
}

/**
 * Roles on every flow that no held record represents, each constructed and
 * evaluated. Pure: same evidence and records, same reading.
 */
export function openWorld(evidence: IndustryEvidence, held: HeldRecords, seeds: OpportunitySeed[] = []): OpenWorldReading {
  const sets = commercialRoles(evidence);
  const businesses = constructBusinesses(evidence);
  const industry = evidence.industry.toLowerCase();
  const touching = seeds.filter((s) => (s.category ?? '').toLowerCase().includes(industry) || s.prompt.toLowerCase().includes(industry));
  const representedRoles: string[] = [];
  const arrangements: OpenArrangement[] = [];
  let considered = 0;
  for (const set of sets) {
    for (const role of set.roles) {
      considered += 1;
      if (represented(role, held)) {
        representedRoles.push(role.key);
        continue;
      }
      if (role.occupiable.answer === 'NO') continue;
      const found = bestBusinessFor(role, set.segmentId, businesses, evidence);
      if (!found) continue;
      arrangements.push({
        flowKey: set.flowKey,
        roleId: role.roleId,
        roleLabel: role.label,
        roleOrigin: role.origin,
        business: { key: found.business.key, label: found.business.label, position: found.business.position, segmentName: found.business.segmentName, excluded: found.business.excluded },
        viability: found.econ.viability,
        rank: viabilityRank(found.econ),
        midContribution: found.econ.mid?.contribution ?? null,
        midFirstCashDays: found.econ.mid?.firstCashDays ?? null,
        midWorkingCapital: found.econ.mid?.workingCapital ?? null,
        midWorkers: found.econ.mid?.workers ?? null,
        unpriced: found.econ.unpriced,
        seeds: touching.map((s) => ({ key: s.key, origin: s.origin })),
      });
    }
  }
  arrangements.sort((a, b) => a.rank - b.rank || (b.midContribution ?? -Infinity) - (a.midContribution ?? -Infinity) || a.roleId.localeCompare(b.roleId));
  return { industry: evidence.industry, flows: sets.length, rolesConsidered: considered, representedRoles, arrangements };
}

/* ------------------------------------------------------------- adaptation */

/** The observed inputs a change in cash, demand, prices, capacity or financing moves. */
export const OBSERVED_INPUTS = {
  PRICE: ['price_per_unit'],
  DEMAND: ['account_units_per_month', 'accounts_reachable'],
  CAPACITY: ['units_per_capacity_day', 'supply_available'],
  FINANCING: ['buyer_payment_days', 'supplier_payment_days'],
  CASH: ['overhead_per_month'],
} as const satisfies Record<string, readonly FactKey[]>;
export type ObservedInput = keyof typeof OBSERVED_INPUTS;

/**
 * The evidence with an observed change overlaid, in memory: every fact for the
 * input's keys is scaled by `factor`. A key with no fact gains an OBSERVED one
 * only when `set` gives its value — an absent figure is never invented.
 */
export function withObserved(evidence: IndustryEvidence, input: ObservedInput, change: { factor?: number; set?: { low: number; high: number } }): IndustryEvidence {
  const keys = new Set<FactKey>(OBSERVED_INPUTS[input]);
  const facts: Fact[] = evidence.facts.map((f) => {
    if (!keys.has(f.key)) return f;
    if (change.set) return { ...f, low: change.set.low, high: change.set.high, status: 'OBSERVED' };
    const k = change.factor ?? 1;
    return { ...f, low: f.low * k, high: f.high * k, status: 'OBSERVED' };
  });
  if (change.set) {
    for (const key of keys) {
      if (facts.some((f) => f.key === key)) continue;
      facts.push({ key, segment: null, low: change.set.low, high: change.set.high, status: 'OBSERVED', source: { title: `observed ${input.toLowerCase()} change`, url: null, kind: 'OPERATOR' }, measures: key });
    }
  }
  return { ...evidence, facts };
}

function figures(a: OpenArrangement): string {
  const n = (x: number | null) => (x === null ? 'null' : String(Math.round(x * 100) / 100));
  // What is still unpriced is part of the evaluation: observing a figure that was unknown moves it.
  return `${a.business.key}:${a.viability}:${n(a.midContribution)}:${n(a.midFirstCashDays)}:${n(a.midWorkingCapital)}:${n(a.midWorkers)}:${[...a.unpriced].sort().join(',')}`;
}

function signature(r: OpenWorldReading): string {
  return r.arrangements.map((a) => `${a.flowKey}:${a.roleId}:${figures(a)}`).join('|');
}

/** Whether, and how, the evaluation moved when an observed input changed. */
export function adaptation(before: OpenWorldReading, after: OpenWorldReading): { changed: boolean; detail: string } {
  const changed = signature(before) !== signature(after);
  const moved = after.arrangements.filter((a) => {
    const b = before.arrangements.find((x) => x.roleId === a.roleId && x.flowKey === a.flowKey);
    return !b || figures(b) !== figures(a);
  });
  return { changed, detail: changed ? `${moved.length} arrangement(s) re-evaluated` : 'no arrangement moved' };
}

/* ------------------------------------------------------- recorded observations */

const OBSERVED_KEYS = new Set<FactKey>(Object.values(OBSERVED_INPUTS).flat());

/** Which observed input a recorded fact moves, or null when it moves none. */
export function observedInputOf(key: FactKey): ObservedInput | null {
  for (const [input, keys] of Object.entries(OBSERVED_INPUTS) as [ObservedInput, readonly FactKey[]][]) if (keys.includes(key)) return input;
  return null;
}

/**
 * How a subject's evaluation reacts to what was actually recorded: the reading
 * without the recorded cash, demand, price, capacity and financing facts, and
 * the reading with them. Both come from the same rows — nothing is invented,
 * scaled or overlaid; a subject with no such row recorded has no adaptation to
 * show, and says so. Pure.
 */
export function adaptationToRecorded(
  input: { text: string; industry: string; map: ReturnType<typeof evidenceFromMap>; recorded: Fact[] },
  assemble: typeof assembleEvidenceFn,
  held: HeldRecords,
  seeds: OpportunitySeed[] = [],
): { before: OpenWorldReading; after: OpenWorldReading; observed: Fact[]; inputs: ObservedInput[]; changed: boolean; detail: string } {
  const observed = input.recorded.filter((f) => OBSERVED_KEYS.has(f.key));
  const rest = input.recorded.filter((f) => !OBSERVED_KEYS.has(f.key));
  const common = { text: input.text, industry: input.industry, geography: null, map: input.map };
  const before = openWorld(assemble({ ...common, recorded: rest }), held, seeds);
  const after = observed.length ? openWorld(assemble({ ...common, recorded: input.recorded }), held, seeds) : before;
  const inputs = [...new Set(observed.map((f) => observedInputOf(f.key)).filter((x): x is ObservedInput => x !== null))].sort();
  const moved = observed.length ? adaptation(before, after) : { changed: false, detail: 'no observed cash, demand, price, capacity or financing row recorded' };
  return { before, after, observed, inputs, changed: moved.changed, detail: moved.detail };
}

/* ------------------------------------------------------------------ the probe */

/**
 * Read-only check for the r01.arch-01 probe: on the production industry maps,
 * at least one arrangement whose role no record represents is constructed and
 * evaluated, and its evaluation moves with the cash, demand, price, capacity
 * or financing facts actually recorded against the goals that work that
 * subject (`construction_facts`). No figure is invented and nothing is written:
 * a Brain with no such recorded row fails the probe and says so.
 */
export async function openWorldHoldsOnRows(): Promise<{ ok: boolean; detail: string }> {
  const { getDb } = await import('../../../db/database.ts');
  const { listNodes, listConstraintsForProject } = await import('../../../repos/industry.ts');
  const { listOpportunities } = await import('../../../repos/cashPortfolio.ts');
  const { listWorkstreams } = await import('../../../repos/register.ts');
  const { listConstructionFacts } = await import('../../../repos/construction.ts');
  const { assembleEvidence, evidenceFromMap, subtreeFor } = await import('./service.ts');
  const { interpretIntent } = await import('./intent.ts');
  const projects = await getDb().all<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM industry_nodes WHERE retired_at IS NULL ORDER BY project_id`,
    [],
  );
  let arrangements = 0;
  let subjects = 0;
  let observedRows = 0;
  let adapted = 0;
  let example = '';
  let adaptedExample = '';
  for (const { project_id: projectId } of projects) {
    const [nodes, constraints, opportunities, goals] = await Promise.all([
      listNodes(projectId),
      listConstraintsForProject(projectId),
      listOpportunities({ projectId }),
      listWorkstreams({ projectIds: [projectId] }),
    ]);
    const held = heldFromRows(nodes, opportunities);
    const field: FieldInput = { nodes, opportunities, goals: [], constraints };
    const seeds = opportunityField(field);
    // The subjects each of this project's goals works, read the way goalConstruction reads them.
    const goalSubjects: { roots: Set<string>; recorded: Fact[] }[] = [];
    for (const g of goals.filter((x) => x.projectId === projectId)) {
      const industry = interpretIntent([g.intent, g.outcome].filter(Boolean).join(' ')).industry;
      const roots = new Set(subtreeFor(nodes, industry).filter((n) => n.parentId === null).map((n) => n.id));
      if (roots.size === 0) continue;
      const recorded = await listConstructionFacts(g.id);
      if (recorded.length) goalSubjects.push({ roots, recorded });
    }
    for (const root of nodes.filter((n) => n.parentId === null && !n.retiredAt)) {
      const map = evidenceFromMap(subtreeFor(nodes, root.name), constraints);
      if (map.flows.length === 0) continue;
      const recorded = goalSubjects.filter((g) => g.roots.has(root.id)).flatMap((g) => g.recorded);
      const reacted = adaptationToRecorded({ text: root.name, industry: root.name, map, recorded }, assembleEvidence, held, seeds);
      const reading = reacted.after;
      if (reading.arrangements.length === 0) continue;
      subjects += 1;
      arrangements += reading.arrangements.length;
      observedRows += reacted.observed.length;
      if (reacted.changed) {
        adapted += 1;
        if (!adaptedExample) adaptedExample = `"${root.name}" re-evaluated on ${reacted.observed.length} recorded ${reacted.inputs.join('/').toLowerCase()} row(s): ${reacted.detail}`;
      }
      if (!example) {
        const a = reading.arrangements[0]!;
        example = `"${root.name}": ${a.roleLabel} as ${a.business.label} (${a.viability})`;
      }
    }
  }
  if (arrangements === 0) return { ok: false, detail: 'no production industry map yields a role that no record represents, so no open-world arrangement could be constructed' };
  if (observedRows === 0) return { ok: false, detail: `${arrangements} open-world arrangement(s) constructed, but no cash, demand, price, capacity or financing fact is recorded against a goal working those subjects, so no adaptation to observed change can be shown` };
  if (adapted === 0) return { ok: false, detail: `${arrangements} open-world arrangement(s) constructed and ${observedRows} observed row(s) recorded, but no evaluation moved with them` };
  return { ok: true, detail: `${arrangements} arrangement(s) for roles no record represents, across ${subjects} subject(s); ${adapted} re-evaluated on recorded observations; e.g. ${example}; ${adaptedExample}` };
}
