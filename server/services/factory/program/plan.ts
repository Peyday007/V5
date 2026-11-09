/**
 * From a requirement map to bounded campaigns, and the proof that the campaigns
 * cover the map.
 *
 * Decomposition is derived, not invented: a requirement that needs work goes to
 * a campaign of its own subsystem at its own depth in the dependency graph, so
 * every edge between campaigns points from a deeper campaign to a shallower
 * one and the campaign graph cannot have a cycle. Same-subsystem campaigns are
 * merged where that keeps the graph acyclic and the campaign bounded. Two
 * campaigns that would own the same files with nothing ordering them are
 * serialized, and the edge is recorded — two campaigns writing one file at once
 * is a conflict nobody scheduled.
 *
 * `validateProgramPlan` is the gate the coordinator runs before it submits
 * anything, and it is the same gate whether the plan was derived here or
 * proposed by an architect: every requirement accounted for exactly once, every
 * dependency that crosses campaigns carried as a campaign edge, no cycle, no
 * campaign over its bound, no unordered overlap, and no campaign reaching the
 * code that verifies it.
 */
import {
  MAX_REQUIREMENTS_PER_CAMPAIGN,
  PROTECTED_VERIFICATION_PATHS,
  type PlannedCampaign,
  type ProgramIssue,
  type ProgramPlan,
  type ProgramRequirement,
  type ProgramValidation,
  type RequirementMap,
} from '../../../domain/factoryProgram.ts';
import { matchesGlob } from '../glob.ts';
import { edgesOf, findCycle } from './map.ts';

/** Whether two path lists (files or globs) can name the same file. */
export function scopesOverlap(a: string[], b: string[]): string[] {
  const shared: string[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x === y || matchesGlob(x, y) || matchesGlob(y, x) || globPrefixOverlap(x, y)) shared.push(x === y ? x : `${x} ∩ ${y}`);
    }
  }
  return [...new Set(shared)];
}

function globPrefixOverlap(x: string, y: string): boolean {
  const base = (glob: string): string | null => (glob.endsWith('/**') ? glob.slice(0, -3) : null);
  const bx = base(x);
  const by = base(y);
  if (bx && (y === bx || y.startsWith(`${bx}/`))) return true;
  if (by && (x === by || x.startsWith(`${by}/`))) return true;
  return false;
}

/** Whether a requirement needs code written, as opposed to existing code verified. */
export function needsWork(requirement: ProgramRequirement): boolean {
  return requirement.existing === null || requirement.missingWork.length >= 8;
}

function depthOf(map: RequirementMap, extra: Map<string, string[]>): Map<string, number> {
  const byKey = new Map(map.requirements.map((r) => [r.key, r]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0; // a cycle is refused elsewhere; do not loop here
    visiting.add(key);
    const requirement = byKey.get(key);
    let d = 0;
    for (const edge of requirement ? edgesOf(requirement, extra) : []) {
      if (byKey.has(edge)) d = Math.max(d, visit(edge) + 1);
    }
    visiting.delete(key);
    depth.set(key, d);
    return d;
  };
  for (const r of map.requirements) visit(r.key);
  return depth;
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'general';

/** Campaign-level edges implied by requirement edges. */
export function deriveCampaignEdges(
  map: RequirementMap,
  campaigns: PlannedCampaign[],
  extra: Map<string, string[]> = new Map(),
): Map<string, Set<string>> {
  const owner = new Map<string, string>();
  for (const campaign of campaigns) for (const key of campaign.implements) owner.set(key, campaign.key);
  const edges = new Map<string, Set<string>>(campaigns.map((c) => [c.key, new Set<string>()]));
  for (const requirement of map.requirements) {
    const from = owner.get(requirement.key);
    if (!from) continue;
    for (const dependency of edgesOf(requirement, extra)) {
      const to = owner.get(dependency);
      if (to && to !== from) edges.get(from)!.add(to);
    }
  }
  return edges;
}

function hasPath(edges: Map<string, Set<string>>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === to) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of edges.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Derive a plan. Requirements with an existing implementation and no missing
 * work go to `verifyOnly`: existing code is reused, and it still has to pass its
 * checks on production before anything counts it.
 */
export function deriveProgramPlan(
  map: RequirementMap,
  options: { maxPerCampaign?: number; extraEdges?: Map<string, string[]>; keep?: PlannedCampaign[] } = {},
): ProgramPlan {
  const max = options.maxPerCampaign ?? MAX_REQUIREMENTS_PER_CAMPAIGN;
  const extra = options.extraEdges ?? new Map<string, string[]>();
  const kept = options.keep ?? [];
  const keptKeys = new Set(kept.flatMap((c) => c.implements));
  const depth = depthOf(map, extra);
  const verifyOnly = map.requirements.filter((r) => !needsWork(r)).map((r) => r.key);

  // Bucket by (subsystem, depth), in a deterministic order.
  const buckets = new Map<string, ProgramRequirement[]>();
  for (const requirement of map.requirements) {
    if (!needsWork(requirement) || keptKeys.has(requirement.key)) continue;
    const bucket = `${requirement.subsystem}\u0000${String(depth.get(requirement.key) ?? 0).padStart(4, '0')}`;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), requirement]);
  }
  let campaigns: PlannedCampaign[] = [...kept];
  const usedKeys = new Set(kept.map((c) => c.key));
  const uniqueKey = (base: string): string => {
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) key = `${base}-${n++}`;
    usedKeys.add(key);
    return key;
  };
  for (const name of [...buckets.keys()].sort()) {
    const [subsystem, d] = name.split('\u0000') as [string, string];
    const members = buckets.get(name)!.sort((a, b) => a.key.localeCompare(b.key));
    for (let i = 0; i < members.length; i += max) {
      const chunk = members.slice(i, i + max);
      campaigns.push({
        key: uniqueKey(`${slug(subsystem)}-d${Number(d)}${members.length > max ? `-${i / max + 1}` : ''}`),
        kind: 'BUILD',
        title: `${subsystem}: ${chunk.map((r) => r.key).join(', ')}`.slice(0, 160),
        subsystem,
        implements: chunk.map((r) => r.key),
        dependsOn: [],
        mutationScope: [...new Set(chunk.flatMap((r) => r.paths))].sort(),
        repairOf: null,
      });
    }
  }

  // Merge same-subsystem neighbours where the result stays bounded and acyclic.
  let merged = true;
  while (merged) {
    merged = false;
    const edges = deriveCampaignEdges(map, campaigns, extra);
    outer: for (const a of campaigns) {
      if (kept.includes(a)) continue;
      for (const b of campaigns) {
        if (a === b || kept.includes(b) || a.subsystem !== b.subsystem) continue;
        if (a.implements.length + b.implements.length > max) continue;
        // Merging is safe only when no path between them runs through a third campaign.
        const trial = new Map([...edges].map(([k, v]) => [k, new Set(v)]));
        const combined = new Set([...(trial.get(a.key) ?? []), ...(trial.get(b.key) ?? [])]);
        combined.delete(a.key);
        combined.delete(b.key);
        trial.delete(b.key);
        trial.set(a.key, combined);
        for (const set of trial.values()) {
          if (set.delete(b.key)) set.add(a.key);
        }
        for (const [k, set] of trial) if (k !== a.key) set.delete(k);
        if (findCycle(new Map([...trial].map(([k, v]) => [k, [...v].filter((x) => x !== k)])))) continue;
        a.implements = [...a.implements, ...b.implements].sort();
        a.mutationScope = [...new Set([...a.mutationScope, ...b.mutationScope])].sort();
        a.title = `${a.subsystem}: ${a.implements.join(', ')}`.slice(0, 160);
        campaigns = campaigns.filter((c) => c !== b);
        merged = true;
        break outer;
      }
    }
  }

  // Edges from requirements, then serialization of unordered overlaps.
  const edges = deriveCampaignEdges(map, campaigns, extra);
  for (const campaign of kept) for (const dep of campaign.dependsOn) edges.get(campaign.key)?.add(dep);
  const serialized: ProgramPlan['serialized'] = [];
  const ordered = [...campaigns].sort((x, y) => x.key.localeCompare(y.key));
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      const shared = scopesOverlap(a.mutationScope, b.mutationScope);
      if (shared.length === 0) continue;
      if (hasPath(edges, a.key, b.key) || hasPath(edges, b.key, a.key)) continue;
      // The later one waits; a kept (already submitted) campaign never waits on a new one.
      const [later, earlier] = kept.includes(b) && !kept.includes(a) ? [a, b] : [b, a];
      edges.get(later.key)!.add(earlier.key);
      serialized.push({ campaign: later.key, after: earlier.key, paths: shared });
    }
  }
  for (const campaign of campaigns) campaign.dependsOn = [...(edges.get(campaign.key) ?? [])].sort();
  return { campaigns, verifyOnly, serialized };
}

/** The gate: a plan that leaves anything unaccounted for is refused whole. */
export function validateProgramPlan(
  map: RequirementMap,
  plan: ProgramPlan,
  options: { maxPerCampaign?: number; extraEdges?: Map<string, string[]> } = {},
): ProgramValidation & { coverage: Array<{ requirement: string; by: string }> } {
  const max = options.maxPerCampaign ?? MAX_REQUIREMENTS_PER_CAMPAIGN;
  const extra = options.extraEdges ?? new Map<string, string[]>();
  const errors: ProgramIssue[] = [];
  const warnings: ProgramIssue[] = [];
  const byKey = new Map(map.requirements.map((r) => [r.key, r]));
  const implementedBy = new Map<string, string[]>();
  const campaignKeys = new Set<string>();

  for (const campaign of plan.campaigns) {
    if (campaignKeys.has(campaign.key)) errors.push({ code: 'DUPLICATE_IMPLEMENTATION', subject: campaign.key, detail: `Two campaigns share the key ${campaign.key}.` });
    campaignKeys.add(campaign.key);
    if (campaign.implements.length === 0) errors.push({ code: 'EMPTY_CAMPAIGN', subject: campaign.key, detail: 'A campaign that implements no requirement is work nobody asked for.' });
    if (campaign.kind === 'BUILD' && campaign.implements.length > max) {
      errors.push({ code: 'OVERSIZED_CAMPAIGN', subject: campaign.key, detail: `It implements ${campaign.implements.length} requirements; a campaign is bounded at ${max}.` });
    }
    if (campaign.mutationScope.length === 0 || campaign.mutationScope.includes('**')) {
      errors.push({ code: 'NO_MUTATION_SCOPE', subject: campaign.key, detail: 'A campaign needs a bounded mutation scope derived from its requirements, never the whole repository.' });
    }
    const protectedHit = scopesOverlap(campaign.mutationScope, PROTECTED_VERIFICATION_PATHS);
    if (protectedHit.length > 0) {
      errors.push({ code: 'PROTECTED_VERIFICATION_SCOPE', subject: campaign.key, detail: `Its scope reaches the code that verifies it (${protectedHit.join(', ')}); an implementer may not write its own exam.` });
    }
    for (const key of campaign.implements) {
      if (!byKey.has(key)) errors.push({ code: 'UNKNOWN_REQUIREMENT', subject: campaign.key, detail: `It implements ${key}, which the map does not define.` });
      // A repair re-implements a requirement its build (or an existing implementation) already
      // owns; that is the repair, not a second owner.
      if (campaign.kind === 'BUILD') implementedBy.set(key, [...(implementedBy.get(key) ?? []), campaign.key]);
    }
    for (const dep of campaign.dependsOn) {
      if (!plan.campaigns.some((c) => c.key === dep)) errors.push({ code: 'CAMPAIGN_DEPENDENCY_MISSING', subject: campaign.key, detail: `It waits for ${dep}, which the plan does not define.` });
    }
  }

  const verifyOnly = new Set(plan.verifyOnly);
  const coverage: Array<{ requirement: string; by: string }> = [];
  for (const requirement of map.requirements) {
    const by = implementedBy.get(requirement.key) ?? [];
    if (by.length > 1) {
      errors.push({ code: 'DUPLICATE_IMPLEMENTATION', subject: requirement.key, detail: `${requirement.key} is implemented by ${by.join(' and ')}; one requirement is implemented once.` });
    }
    if (by.length === 0 && !verifyOnly.has(requirement.key)) {
      errors.push({ code: 'UNASSIGNED_REQUIREMENT', subject: requirement.key, detail: `${requirement.key} is in no campaign and not verified as existing. A plan may not shrink by dropping it.` });
    }
    if (by.length === 0 && verifyOnly.has(requirement.key) && needsWork(requirement)) {
      errors.push({ code: 'UNASSIGNED_REQUIREMENT', subject: requirement.key, detail: `${requirement.key} has missing work but is only scheduled for verification.` });
    }
    if (by.length > 0 && verifyOnly.has(requirement.key)) {
      warnings.push({ code: 'DUPLICATE_IMPLEMENTATION', subject: requirement.key, detail: `${requirement.key} is both verified as existing and implemented by ${by[0]}.` });
    }
    coverage.push({ requirement: requirement.key, by: by[0] ?? (verifyOnly.has(requirement.key) ? 'EXISTING' : 'NOBODY') });
  }

  // Every requirement edge that crosses campaigns must be a campaign edge (or reachable through one).
  const owner = new Map(coverage.map((c) => [c.requirement, c.by]));
  const campaignEdges = new Map(plan.campaigns.map((c) => [c.key, new Set(c.dependsOn)]));
  for (const requirement of map.requirements) {
    const from = owner.get(requirement.key);
    if (!from || !campaignEdges.has(from)) continue;
    for (const dependency of edgesOf(requirement, extra)) {
      const to = owner.get(dependency);
      if (!to || to === from || !campaignEdges.has(to)) continue;
      if (!hasPath(campaignEdges, from, to)) {
        errors.push({ code: 'CAMPAIGN_DEPENDENCY_MISSING', subject: from, detail: `${requirement.key} (in ${from}) depends on ${dependency} (in ${to}), and ${from} does not wait for ${to}. The relationship would be lost between campaigns.` });
      }
    }
  }
  const cycle = findCycle(new Map([...campaignEdges].map(([k, v]) => [k, [...v]])));
  if (cycle) errors.push({ code: 'CAMPAIGN_CYCLE', subject: cycle[0]!, detail: `Campaigns wait for each other in a circle: ${cycle.join(' → ')}.` });

  // Two campaigns owning one file must be ordered.
  for (let i = 0; i < plan.campaigns.length; i += 1) {
    for (let j = i + 1; j < plan.campaigns.length; j += 1) {
      const a = plan.campaigns[i]!;
      const b = plan.campaigns[j]!;
      const shared = scopesOverlap(a.mutationScope, b.mutationScope);
      if (shared.length > 0 && !hasPath(campaignEdges, a.key, b.key) && !hasPath(campaignEdges, b.key, a.key)) {
        errors.push({ code: 'UNSERIALIZED_OVERLAP', subject: `${a.key}/${b.key}`, detail: `${a.key} and ${b.key} both own ${shared.join(', ')} with nothing ordering them.` });
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, coverage };
}

/** Campaigns that may start now: every campaign they wait for is finished. */
export function eligibleCampaigns(plan: ProgramPlan, finished: Set<string>, started: Set<string>): PlannedCampaign[] {
  return plan.campaigns.filter((c) => !started.has(c.key) && c.dependsOn.every((dep) => finished.has(dep)));
}
