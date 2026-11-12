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
 *   3. facts recorded against this goal — a quoted price, an accepted rate,
 *      payment terms, a measured conversion, an unexpected cost — which answer
 *      ahead of everything else (learning from operating results).
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
import type { Actor, Chokepoint, FactSource, FailureMode, Gate, IndustryEvidence, Segment, Adjacency, Flow } from '../../../domain/construction.ts';
import type { IndustryNode, OpportunityConstraint } from '../../../domain/types.ts';
import type { Workstream } from '../../../domain/register.ts';
import { constructIndustry, type Construction, type ConstructionGoal } from './construction.ts';
import { interpretIntent, type IntentOverrides } from './intent.ts';
import { referenceFor } from './references.ts';

const EQUIPMENT_WORDS = /\b(truck|van|vehicle|fleet|trailer|equipment|machine|machinery|vessel|aircraft|warehouse|plant|crane|excavator)s?\b/i;

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
  for (const n of nodes) {
    const id = `map_${n.id}`;
    if (n.kind === 'BUYER_TYPE') {
      actors.push({ id, name: n.name, role: 'BUYER', description: n.description ?? '', status: status(n), source: src(n) });
      segments.push({ actorId: id, buys: 'WORK', requires: [], acceptsIntermediary: null, channel: 'not yet established — research names how these buyers are reached', firstTransaction: `a first paid order from ${n.name}`, status: status(n), source: src(n) });
    } else if (n.kind === 'FULFILMENT_SOURCE' || n.kind === 'VALUE_CHAIN_LAYER') {
      actors.push({ id, name: n.name, role: 'OPERATOR', description: n.description ?? '', status: status(n), source: src(n) });
    } else if (n.kind === 'TRANSACTION_TYPE') {
      const parent = nodes.find((p) => p.id === n.parentId);
      flows.push({ from: parent ? `map_${parent.id}` : 'buyers', to: 'operators', kind: 'MONEY', terms: n.description ?? n.name, status: status(n), source: src(n) });
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

/** Merge the layers: reference first, then the map, then recorded facts. Pure. */
export function assembleEvidence(input: { text: string; industry: string | null; geography: string | null; map: ReturnType<typeof evidenceFromMap>; recorded: IndustryEvidence['facts'] }): IndustryEvidence {
  const pack = referenceFor(`${input.industry ?? ''} ${input.text}`);
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
    base.provenance.push(`${input.recorded.length} fact(s) recorded against this goal`);
  }
  return base;
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
  const map = evidenceFromMap(subtreeFor(nodes, intent.industry), constraints);
  const recorded = await listConstructionFacts(goal.id);
  const evidence = assembleEvidence({ text, industry: intent.industry, geography: intent.geography, map, recorded });
  const others = (await listWorkstreams({ projectIds: null }))
    .filter((g) => g.id !== goal.id && activeMoneyGoal(g))
    .map((g) => ({ id: g.id, title: g.title, policy: goalExecutionPolicy({ daysLeft: g.dueAt ? Math.ceil((Date.parse(g.dueAt) - now.getTime()) / 86_400_000) : null, remainingCents: g.target?.amountCents ?? 0 }) }));
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
