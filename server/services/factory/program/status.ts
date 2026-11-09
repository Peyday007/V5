/**
 * Where every requirement of a program stands, derived from rows on every read.
 *
 * The rules that make "DONE" mean something:
 *
 *   * A merged pull request is IMPLEMENTED at best until production runs it, and
 *     INTEGRATED until the requirement's own checks pass *on production*.
 *   * A requirement is PRODUCTION_VERIFIED only when its own latest checks
 *     passed **and** every requirement it depends on (or, for an interaction,
 *     every participant) is PRODUCTION_VERIFIED. A dependent never passes
 *     because the component under it exists.
 *   * A failed production check reopens the requirement (NOT_DONE) even if it
 *     passed before, and every requirement that depends on it loses its
 *     verified status with it.
 *   * An open ambiguity a person has not answered BLOCKS the requirement; Factory
 *     does not get to choose the owner's meaning by implementing one.
 *   * The program is DONE only when every requirement is PRODUCTION_VERIFIED.
 */
import {
  MAX_REPAIR_EPISODES,
  REQUIREMENT_STATUSES,
  type CampaignProgress,
  type PlannedCampaign,
  type ProgramPlan,
  type ProgramReading,
  type ProgramRequirement,
  type RequirementMap,
  type RequirementReading,
  type RequirementStatus,
  type RequirementVerification,
} from '../../../domain/factoryProgram.ts';
import { edgesOf } from './map.ts';

export interface StatusInput {
  programId: string;
  approved: boolean;
  map: RequirementMap;
  plan: ProgramPlan;
  /** Campaign progress keyed by planned campaign key (including repair campaigns). */
  progress: Map<string, CampaignProgress>;
  /** Every verification, any order. */
  verifications: RequirementVerification[];
  extraEdges?: Map<string, string[]>;
}

/** The latest verification of each requirement. */
export function latestVerifications(verifications: RequirementVerification[]): Map<string, RequirementVerification> {
  const latest = new Map<string, RequirementVerification>();
  for (const v of verifications) {
    const known = latest.get(v.requirementKey);
    if (!known || known.at < v.at || (known.at === v.at && known.id < v.id)) latest.set(v.requirementKey, v);
  }
  return latest;
}

/** The campaign that currently answers for a requirement: its newest repair if any, else its build. */
export function answeringCampaign(plan: ProgramPlan, key: string): PlannedCampaign | null {
  const repairs = plan.campaigns.filter((c) => c.repairOf?.requirement === key || (c.kind !== 'BUILD' && c.implements.includes(key)));
  if (repairs.length > 0) {
    return repairs.sort((a, b) => (a.repairOf?.episode ?? 0) - (b.repairOf?.episode ?? 0))[repairs.length - 1]!;
  }
  return plan.campaigns.find((c) => c.kind === 'BUILD' && c.implements.includes(key)) ?? null;
}

function campaignStatus(progress: CampaignProgress | undefined): { status: RequirementStatus; reason: string; live: boolean } {
  if (progress && !progress.changeRequestId && progress.blocker) return { status: 'BLOCKED', reason: progress.blocker, live: false };
  if (!progress || !progress.changeRequestId) return { status: 'MAPPED', reason: 'its campaign has not started', live: false };
  switch (progress.outcome) {
    case 'LIVE':
      return { status: 'INTEGRATED', reason: 'production runs its campaign; its checks have not all passed there yet', live: true };
    case 'BLOCKED':
      if (progress.delivered) return { status: 'IMPLEMENTED', reason: `delivered, not yet live: ${progress.blocker ?? 'blocked'}`, live: false };
      return { status: progress.needsPerson ? 'BLOCKED' : 'MAPPED', reason: `its campaign is blocked: ${progress.blocker ?? 'no detail'}`, live: false };
    case 'CANCELLED':
      return { status: 'BLOCKED', reason: 'its campaign was cancelled; nothing implements it', live: false };
    case 'RELEASING':
    case 'VERIFYING':
      return { status: progress.delivered ? 'IMPLEMENTED' : 'MAPPED', reason: `its campaign is ${progress.outcome.toLowerCase()}`, live: false };
    default:
      return { status: 'MAPPED', reason: 'its campaign is building', live: false };
  }
}

/** Derive the reading. Pure: the same rows always give the same answer. */
export function deriveProgramReading(input: StatusInput): ProgramReading {
  const byKey = new Map(input.map.requirements.map((r) => [r.key, r]));
  const latest = latestVerifications(input.verifications);
  const memo = new Map<string, RequirementReading>();
  const visiting = new Set<string>();

  const read = (requirement: ProgramRequirement): RequirementReading => {
    const known = memo.get(requirement.key);
    if (known) return known;
    visiting.add(requirement.key);
    const last = latest.get(requirement.key) ?? null;
    const campaign = answeringCampaign(input.plan, requirement.key);
    const make = (status: RequirementStatus, reason: string, reopened = false): RequirementReading => ({
      key: requirement.key,
      kind: requirement.kind,
      title: requirement.title,
      status,
      reason,
      campaign: campaign?.key ?? null,
      reopened,
      lastVerification: last,
    });
    let reading: RequirementReading;
    const open = requirement.ambiguities.filter((a) => a.interpretation === null && !a.resolvedBy);
    const everFailed = input.verifications.some((v) => v.requirementKey === requirement.key && v.outcome === 'FAIL');
    if (!input.approved) {
      reading = make('SPECIFIED', 'the program is not approved, so no work may start');
    } else if (open.length > 0) {
      reading = make('BLOCKED', `open question a person must answer: ${open[0]!.question}`);
    } else if (last?.outcome === 'PASS') {
      const unmet = edgesOf(requirement, input.extraEdges)
        .map((key) => byKey.get(key))
        .filter((dep): dep is ProgramRequirement => dep !== undefined && !visiting.has(dep.key))
        .map((dep) => read(dep))
        .filter((dep) => dep.status !== 'PRODUCTION_VERIFIED');
      reading = unmet.length === 0
        ? make('PRODUCTION_VERIFIED', `every check passed on production (${last.revision?.slice(0, 12) ?? 'unknown revision'})`)
        : make('INTEGRATED', `its own checks pass, but it depends on ${unmet.map((d) => `${d.key} (${d.status})`).join(', ')}`);
    } else if (last?.outcome === 'FAIL') {
      const progress = campaign && campaign.kind !== 'BUILD' ? input.progress.get(campaign.key) : undefined;
      const repairs = input.plan.campaigns.filter((c) => c.repairOf?.requirement === requirement.key).length;
      if (repairs > MAX_REPAIR_EPISODES && progress?.outcome === 'LIVE') {
        reading = make('BLOCKED', `failed on production after ${repairs} repairs; a structural change is needed`, true);
      } else {
        const where = progress ? campaignStatus(progress).reason : 'repair not yet started';
        reading = make('NOT_DONE', `failed on production: ${failedChecks(last)}; ${where}`, true);
      }
    } else if (!campaign) {
      reading = requirement.existing && input.plan.verifyOnly.includes(requirement.key)
        ? make('INTEGRATED', 'claimed as existing; production has not confirmed it yet')
        : make('SPECIFIED', 'no campaign implements it');
    } else {
      const derived = campaignStatus(input.progress.get(campaign.key));
      reading = make(derived.status, derived.reason, everFailed);
    }
    visiting.delete(requirement.key);
    memo.set(requirement.key, reading);
    return reading;
  };

  const requirements = input.map.requirements.map(read);
  const counts = Object.fromEntries(REQUIREMENT_STATUSES.map((s) => [s, 0])) as Record<RequirementStatus, number>;
  for (const r of requirements) counts[r.status] += 1;
  const unmet = requirements.filter((r) => r.status !== 'PRODUCTION_VERIFIED').map((r) => `${r.key} ${r.status}: ${r.reason}`);
  const actionable = requirements.filter((r) => r.status !== 'PRODUCTION_VERIFIED' && r.status !== 'BLOCKED');
  const verdict = unmet.length === 0 && input.approved && requirements.length > 0
    ? 'DONE'
    : actionable.length === 0 && counts.BLOCKED > 0
      ? 'BLOCKED'
      : 'NOT_DONE';
  return { programId: input.programId, verdict, counts, requirements, unmet };
}

function failedChecks(verification: RequirementVerification): string {
  const failed = verification.checks.filter((c) => c.ok !== true);
  return failed.length ? failed.map((c) => `${c.check} (${c.detail})`).join('; ').slice(0, 300) : 'no check passed';
}

export interface RepairTarget {
  requirement: string;
  /** Requirements whose verification this failure invalidates (transitive dependents). */
  affected: string[];
  /** Which repair episode this would be (1-based). */
  episode: number;
  /** STRUCTURAL once ordinary repairs are exhausted. */
  kind: 'REPAIR' | 'STRUCTURAL' | 'EXHAUSTED';
  failures: string[];
}

/**
 * The repairs a failure set calls for, smallest first.
 *
 * Only the *earliest* failures are repaired — a failing requirement none of
 * whose own dependencies are failing. A dependent that fails because what it
 * stands on fails is not a second defect, and repairing it first would build a
 * fix on a broken floor; it is re-verified once the root passes.
 *
 * A repair already in flight is resumed rather than duplicated: a requirement
 * whose newest repair campaign has not gone live is not a target.
 */
export function repairTargets(input: StatusInput): RepairTarget[] {
  const latest = latestVerifications(input.verifications);
  const failing = new Set([...latest.values()].filter((v) => v.outcome === 'FAIL').map((v) => v.requirementKey));
  const byKey = new Map(input.map.requirements.map((r) => [r.key, r]));
  const dependents = new Map<string, string[]>();
  for (const r of input.map.requirements) {
    for (const edge of edgesOf(r, input.extraEdges)) dependents.set(edge, [...(dependents.get(edge) ?? []), r.key]);
  }
  const transitive = (key: string): string[] => {
    const out = new Set<string>();
    const stack = [...(dependents.get(key) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      stack.push(...(dependents.get(next) ?? []));
    }
    return [...out].sort();
  };
  const failingAncestor = (key: string): boolean => {
    const seen = new Set<string>();
    const stack = edgesOf(byKey.get(key)!, input.extraEdges);
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (failing.has(next)) return true;
      const r = byKey.get(next);
      if (r) stack.push(...edgesOf(r, input.extraEdges));
    }
    return false;
  };
  const targets: RepairTarget[] = [];
  for (const key of [...failing].sort()) {
    if (!byKey.has(key) || failingAncestor(key)) continue;
    const repairs = input.plan.campaigns.filter((c) => c.repairOf?.requirement === key);
    const newest = repairs.sort((a, b) => (a.repairOf?.episode ?? 0) - (b.repairOf?.episode ?? 0))[repairs.length - 1];
    if (newest) {
      const progress = input.progress.get(newest.key);
      // In flight (or not yet submitted): resume it, do not open another.
      if (!progress || progress.outcome !== 'LIVE') continue;
      // It went live and the requirement still fails: the repair did not hold.
    } else {
      // The original build is still running: its own review and repair loop owns the work.
      const build = input.plan.campaigns.find((c) => c.kind === 'BUILD' && c.implements.includes(key));
      const progress = build ? input.progress.get(build.key) : undefined;
      if (build && progress && progress.outcome !== 'LIVE' && progress.outcome !== 'CANCELLED') continue;
    }
    const episode = repairs.length + 1;
    const failures = input.verifications
      .filter((v) => v.requirementKey === key && v.outcome === 'FAIL')
      .map((v) => `${v.at} ${failedChecks(v)}`)
      .slice(-5);
    targets.push({
      requirement: key,
      affected: transitive(key),
      episode,
      kind: episode > MAX_REPAIR_EPISODES + 1 ? 'EXHAUSTED' : episode === MAX_REPAIR_EPISODES + 1 ? 'STRUCTURAL' : 'REPAIR',
      failures,
    });
  }
  return targets;
}
