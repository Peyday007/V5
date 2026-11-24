/**
 * Loading a goal's industry construction from rows (§92).
 *
 * The evidence, strongest last so `resolveFact` prefers it:
 *
 *   1. a reference pack the operator's words name — published figures with
 *      their sources, the weakest layer;
 *   2. the industry map: buyer types, fulfilment sources, value-chain layers,
 *      transaction types, bottlenecks and adjacencies research established
 *      through the evidence gate, and the constraints filed against them;
 *   3. facts — recorded against this goal by a person (a quoted price, an
 *      accepted rate, payment terms, a measured conversion, an unexpected
 *      cost), and established by research on the goal's own map subtree: a
 *      gated claim that stated a figure, filed by the kernel with the claim as
 *      its lineage (W-5). Each is dated; `resolveFact` takes the strongest
 *      and newest, and widens an aged one (W-10).
 *
 * A transaction the map recorded says who pays and who supplies (W-13): the
 * names its finding declared are resolved to the BUYER_TYPE and
 * FULFILMENT_SOURCE subjects beside it, so each money flow runs from a payer
 * segment to a supplier, and a work flow runs back.
 *
 * The goal's own terms bound it: its money ceiling caps the capital the words
 * name, and its deadline decides the execution policy (SQUEEZE sells now).
 * Reading spends nothing, contacts nobody and changes no other goal. The one
 * write besides recording a fact is seeding the industry on the goal's map,
 * which is the existing person-only `seedSubject` — the industry kernel then
 * decides when research asks about it.
 */
import { getWorkstream, listWorkstreams } from '../../../repos/register.ts';
import { listConstraintsForProject, listNodes } from '../../../repos/industry.ts';
import { listConstructionFacts } from '../../../repos/construction.ts';
import { readTarget } from '../../goals/target.ts';
import { seedSubject } from '../seed.ts';
import { goalExecutionPolicy } from '../../../domain/goalPolicy.ts';
import type { Actor, ActorRole, Chokepoint, Fact, FactSource, FailureMode, Gate, IndustryEvidence, Segment, Adjacency, Flow } from '../../../domain/construction.ts';
import { SEED_ROLES } from './roles.ts';
import type { IndustryNode, OpportunityConstraint } from '../../../domain/types.ts';
import type { Workstream } from '../../../domain/register.ts';
import { constructIndustry, type Construction, type ConstructionGoal } from './construction.ts';
import { interpretIntent, type IntentOverrides } from './intent.ts';
import { referenceFor } from './references.ts';
import { EQUIPMENT_WORDS } from '../../../domain/construction.ts';
import { daysLeftOf } from '../../../domain/executionWindow.ts';

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4));
}

/** The map subtree the operator's industry names, by shared words with a root subject. */
export function subtreeFor(nodes: IndustryNode[], industry: string | null): IndustryNode[] {
  if (!industry) return [];
  const want = words(industry);
  const live = nodes.filter((n) => !n.retiredAt);
  const roots = live.filter((n) => n.parentId === null && [...words(n.name)].some((w) => want.has(w)));
  const keep = new Set(roots.map((r) => r.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of live) if (n.parentId && keep.has(n.parentId) && !keep.has(n.id)) { keep.add(n.id); grew = true; }
  }
  return live.filter((n) => keep.has(n.id));
}

/** The industry map's part of the evidence. Pure. */
export function evidenceFromMap(nodes: IndustryNode[], constraints: OpportunityConstraint[]): Pick<IndustryEvidence, 'actors' | 'segments' | 'flows' | 'chokepoints' | 'adjacencies' | 'gates' | 'failures' | 'provenance'> {
  const src = (n: { name: string; sourceClaimId: string | null }): FactSource => ({ title: `industry map: ${n.name}`, url: null, kind: 'MAP', claimId: n.sourceClaimId });
  const actors: Actor[] = [];
  const segments: Segment[] = [];
  const flows: Flow[] = [];
  const chokepoints: Chokepoint[] = [];
  const adjacencies: Adjacency[] = [];
  const status = (n: IndustryNode) => (n.sourceClaimId ? 'VERIFIED' : 'ASSUMPTION') as 'VERIFIED' | 'ASSUMPTION';
  const live = nodes.filter((n) => !n.retiredAt);
  const named = (name: string, kinds: IndustryNode['kind'][]) => {
    const want = name.toLowerCase();
    const pool = live.filter((one) => kinds.includes(one.kind));
    return pool.find((one) => one.name.toLowerCase() === want) ?? pool.find((one) => one.name.toLowerCase().includes(want) || want.includes(one.name.toLowerCase())) ?? null;
  };
  for (const n of nodes) {
    const id = `map_${n.id}`;
    if (n.kind === 'BUYER_TYPE') {
      actors.push({ id, name: n.name, role: 'BUYER', description: n.description ?? '', status: status(n), source: src(n) });
      segments.push({ actorId: id, buys: 'WORK', requires: [], acceptsIntermediary: null, channel: 'not yet established — research names how these buyers are reached', firstTransaction: `a first paid order from ${n.name}`, status: status(n), source: src(n) });
    } else if (n.kind === 'FULFILMENT_SOURCE' || n.kind === 'VALUE_CHAIN_LAYER') {
      actors.push({ id, name: n.name, role: 'OPERATOR', description: n.description ?? '', status: status(n), source: src(n) });
    } else if (n.kind === 'TRANSACTION_TYPE') {
      const parent = nodes.find((p) => p.id === n.parentId);
      const payer = n.payer?.trim() || null;
      const supplier = n.supplier?.trim() || null;
      let from = parent ? `map_${parent.id}` : 'buyers';
      let to = 'operators';
      if (payer) {
        // Who pays, resolved to the buyer subject the map holds — or, when the map holds none yet, a buyer of its own.
        const buyer = named(payer, ['BUYER_TYPE']);
        if (buyer) from = `map_${buyer.id}`;
        else {
          from = `${id}_payer`;
          actors.push({ id: from, name: payer, role: 'BUYER', description: `pays in ${n.name}`, status: status(n), source: src(n) });
          segments.push({ actorId: from, buys: 'WORK', requires: [], acceptsIntermediary: null, channel: 'not yet established — research names how these buyers are reached', firstTransaction: `a first paid order from ${payer}`, status: status(n), source: src(n) });
        }
      }
      if (supplier) {
        const source = named(supplier, ['FULFILMENT_SOURCE', 'VALUE_CHAIN_LAYER']);
        if (source) to = `map_${source.id}`;
        else {
          to = `${id}_supplier`;
          actors.push({ id: to, name: supplier, role: 'OPERATOR', description: `supplies in ${n.name}`, status: status(n), source: src(n) });
        }
      }
      flows.push({ from, to, kind: 'MONEY', terms: n.description ?? n.name, status: status(n), source: src(n), payer, supplier });
      if (payer && supplier) flows.push({ from: to, to: from, kind: 'WORK', terms: `${supplier} supplies ${payer}: ${n.name}`, status: status(n), source: src(n), payer, supplier });
    } else if (n.kind === 'BOTTLENECK') {
      chokepoints.push({ id, name: n.name, why: n.description ?? 'a published constraint on supply', controlledBy: [], status: status(n), source: src(n) });
    } else if (n.kind === 'ADJACENT_INDUSTRY') {
      adjacencies.push({ id, name: n.name, via: [], statement: n.description ?? n.name, status: status(n), source: src(n) });
    }
  }
  const inTree = new Set(nodes.map((n) => n.id));
  const gates: Gate[] = [];
  const failures: FailureMode[] = [];
  for (const c of constraints) {
    if (!c.nodeId || !inTree.has(c.nodeId)) continue;
    const source: FactSource = { title: `industry constraint: ${c.statement.slice(0, 80)}`, url: null, kind: 'MAP', claimId: c.sourceClaimId };
    if (c.kind === 'CREDENTIAL_REQUIRED' || c.kind === 'BONDING_OR_INSURANCE' || c.kind === 'REGULATORY_CAPITAL') {
      // A gate whose cost no source stated is unknown, never free (invariant 39).
      gates.push({ id: c.id, name: c.statement, kind: c.kind === 'CREDENTIAL_REQUIRED' ? 'LICENCE' : 'BOND', applies: {}, upfrontLow: null, upfrontHigh: null, days: null, grants: [c.kind === 'CREDENTIAL_REQUIRED' ? 'OPERATING_AUTHORITY' : 'INSURANCE_COVER'], status: 'VERIFIED', source });
    } else {
      failures.push({ id: c.id, statement: c.statement, applies: c.kind === 'SUBCONTRACTING_PROHIBITED' ? { supply: ['NETWORK'] } : {}, status: 'VERIFIED', source });
    }
  }
  return { actors, segments, flows, chokepoints, adjacencies, gates, failures, provenance: nodes.length ? [`industry map: ${nodes.length} subject(s) established by research`] : [] };
}

/**
 * Merge the layers: reference first, then the map, then recorded facts. Pure.
 *
 * A reference pack is applied only when `operatorNamed` is set — goal
 * construction, where an operator named the industry in their own words
 * (W-9). A map root is a subject research established about the whole
 * economy, and a pack measured in one market (the last-mile pack is Metro
 * Detroit, with undated estimates) would hand a world-level subject that
 * market's actors and figures. Every map-root caller leaves it unset.
 */
export function assembleEvidence(input: { text: string; industry: string | null; geography: string | null; map: ReturnType<typeof evidenceFromMap>; recorded: IndustryEvidence['facts']; operatorNamed?: boolean }): IndustryEvidence {
  const pack = input.operatorNamed ? referenceFor(`${input.industry ?? ''} ${input.text}`) : null;
  const base: IndustryEvidence = pack
    ? pack.build()
    : {
        industry: input.industry ?? 'unnamed industry',
        geography: input.geography,
        workUnit: 'unit of work',
        capacityUnit: 'capacity unit',
        needsEquipment: EQUIPMENT_WORDS.test(input.text),
        actors: [],
        flows: [],
        segments: [],
        gates: [],
        chokepoints: [],
        scale: [],
        failures: [],
        adjacencies: [],
        competition: [],
        bargaining: [],
        facts: [],
        provenance: [],
      };
  if (input.geography && pack && base.geography !== input.geography) {
    // A pack about another market is about another market: every figure in it is a comparable.
    base.provenance.push(`reference pack measured for ${base.geography}; the operator named ${input.geography}`);
    base.geography = input.geography;
  }
  const names = new Set(base.actors.map((a) => a.name.toLowerCase()));
  const m = input.map;
  for (const a of m.actors) if (!names.has(a.name.toLowerCase())) base.actors.push(a);
  for (const s of m.segments) if (!base.segments.some((x) => x.actorId === s.actorId)) base.segments.push(s);
  base.flows.push(...m.flows);
  base.chokepoints.push(...m.chokepoints);
  base.adjacencies.push(...m.adjacencies);
  base.gates.push(...m.gates);
  base.failures.push(...m.failures);
  base.provenance.push(...m.provenance);
  if (input.recorded.length) {
    base.facts.push(...input.recorded);
    const researched = input.recorded.filter((f) => f.source.claimId);
    const goalFacts = input.recorded.length - researched.length;
    if (goalFacts) base.provenance.push(`${goalFacts} fact(s) recorded against this goal`);
    if (researched.length) {
      const hypotheses = researched.filter((f) => f.status === 'ASSUMPTION').length;
      base.provenance.push(`${researched.length} fact(s) established by research on the map (${researched.length - hypotheses} observed in a source, ${hypotheses} hypothesis)`);
    }
    applyRoleOccupants(base, input.recorded);
  }
  return base;
}

/** The party a role id describes, for an occupant research recorded. Unlisted roles stand as intermediaries. */
function actorRoleFor(roleId: string | null): ActorRole {
  switch (roleId) {
    case 'capital_arranger':
    case 'transaction_financier':
      return 'FINANCIER';
    case 'marketplace':
    case 'technology_provider':
      return 'PLATFORM';
    case 'asset_lessor':
      return 'ASSET_PROVIDER';
    case 'distributor':
    case 'reseller':
    case 'inventory_reseller':
    case 'prime_contractor':
    case 'outsourced_operator':
    case 'principal_delivery_risk':
    case 'booking_dispatch_coordinator':
      return 'OPERATOR';
    default:
      return 'INTERMEDIARY';
  }
}

/** Roles in which an occupant is paid by the buyer for standing between it and the work. */
const INTERMEDIARY_ROLES = new Set(['lead_source', 'affiliate_referrer', 'broker_agent', 'representative', 'marketplace']);

/**
 * Who research recorded standing in a role (W-6): each occupant becomes a
 * party of the model, so a role no seed names is constructed as an evidence
 * role rather than dropped, and an occupant a named buyer pays as an
 * intermediary answers whether that buyer pays one. A recorded refusal
 * (`acceptsIntermediary === false`) is never overturned by it.
 */
function applyRoleOccupants(base: IndustryEvidence, facts: readonly Fact[]): void {
  const seeds = new Set(SEED_ROLES.map((one) => one.id));
  for (const f of facts) {
    if (f.key !== 'role_occupants' || !f.occupant) continue;
    const id = `occupant_${f.occupant.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60)}`;
    if (!base.actors.some((a) => a.id === id || a.name.toLowerCase() === f.occupant!.toLowerCase())) {
      base.actors.push({
        id,
        name: f.occupant,
        role: actorRoleFor(f.roleId ?? null),
        description: `recorded standing as ${f.roleId ?? 'an unnamed role'}: ${f.measures}`,
        status: f.status === 'ASSUMPTION' ? 'ASSUMPTION' : 'VERIFIED',
        source: f.source,
      });
    }
    if (f.roleId && !seeds.has(f.roleId)) base.provenance.push(`role "${f.roleId}" recorded by research and named by no seed: kept as an evidence role (${f.occupant})`);
    if (f.segment && f.status !== 'ASSUMPTION' && (INTERMEDIARY_ROLES.has(f.roleId ?? '') || (f.roleId !== null && f.roleId !== undefined && !seeds.has(f.roleId)))) {
      const segment = base.segments.find((s) => s.actorId === f.segment);
      if (segment && segment.acceptsIntermediary === null) segment.acceptsIntermediary = true;
    }
  }
}

function activeMoneyGoal(g: Workstream): boolean {
  return !g.archivedAt && !g.cancelledAt && !g.pausedAt && g.target !== null;
}

export interface GoalConstructionOptions {
  overrides?: IntentOverrides;
  /** Construct from these words instead of the goal's own intent (an exploration). */
  intent?: string | null;
  now?: Date;
}

/** One goal's industry construction, read from rows. Writes nothing. */
export async function goalConstruction(goalId: string, options: GoalConstructionOptions = {}): Promise<{ goal: Workstream; construction: Construction; evidenceLayers: string[] } | null> {
  const goal = await getWorkstream(goalId);
  if (!goal) return null;
  const now = options.now ?? new Date();
  const text = options.intent?.trim() || [goal.intent, goal.outcome].filter(Boolean).join(' ');
  const target = await readTarget(goal, now).catch(() => null);
  const constructionGoal: ConstructionGoal = {
    id: goal.id,
    title: goal.title,
    daysLeft: target?.daysLeft ?? null,
    remainingCents: target?.remainingCents ?? 0,
    capitalCeiling: target?.capitalCeilingCents != null ? target.capitalCeilingCents / 100 : null,
    resources: target?.resources ?? null,
  };
  const intent = interpretIntent(text, options.overrides);
  const nodes = goal.projectId ? await listNodes(goal.projectId) : [];
  const constraints = goal.projectId ? await listConstraintsForProject(goal.projectId) : [];
  const tree = subtreeFor(nodes, intent.industry);
  const map = evidenceFromMap(tree, constraints);
  // The goal's own facts, and research's facts about this industry's subtree only: a price in another industry is not this one's.
  const inTree = new Set(tree.map((n) => n.id));
  const recorded = (await listConstructionFacts(goal.id, goal.projectId ?? null)).filter((f) => f.workstreamId === goal.id || (f.nodeId != null && inTree.has(f.nodeId)));
  const evidence = assembleEvidence({ text, industry: intent.industry, geography: intent.geography, map, recorded, operatorNamed: true });
  const others = (await listWorkstreams({ projectIds: null }))
    .filter((g) => g.id !== goal.id && activeMoneyGoal(g))
    .map((g) => ({ id: g.id, title: g.title, policy: goalExecutionPolicy({ daysLeft: daysLeftOf({ dueAt: g.dueAt, executionWindowDays: g.executionWindowDays ?? null, executionStartedAt: g.executionStartedAt ?? null }, now), remainingCents: g.target?.amountCents ?? 0 }) }));
  const construction = constructIndustry({ intentText: text, overrides: options.overrides, evidence, goal: target ? constructionGoal : { ...constructionGoal, daysLeft: null, remainingCents: 0 }, otherMoneyGoals: others, now });
  return { goal, construction, evidenceLayers: evidence.provenance };
}

/**
 * Put the operator's industry on the goal's map so the existing kernel
 * researches it. A person's act through `seedSubject`; idempotent.
 */
export async function seedGoalIndustry(goal: Workstream, industry: string, actorRef: string): Promise<{ created: boolean; nodeId: string } | null> {
  if (!goal.projectId) return null;
  const seeded = await seedSubject({ projectId: goal.projectId, name: industry, actorRef, reason: `industry construction for goal ${goal.id}` });
  return { created: seeded.created, nodeId: seeded.node.id };
}
