/**
 * The owner's policy for a goal, as explicit versions with precedence (MEM-32).
 *
 * "The owner's current policies and approved objectives should have explicit
 * versions and precedence: an older report cannot silently override a newer
 * authorized instruction."
 *
 * Nothing new is stored. Every decision a person makes about a goal already has
 * one writer in `decide.ts`, and each writes an append-only `workstream_events`
 * row carrying who decided, when, and what it replaced. Those rows *are* the
 * policy history: numbering them 1..n in the order they were made gives each
 * one an explicit version, and the newest is the governing one. Deriving it by
 * reading means the version can never disagree with the decision it numbers
 * (invariant 45) — there is no second record of it to drift.
 *
 * The precedence rule is pure: anything produced before the governing version
 * was decided — a plan reading, a report, a decision Brain made — was produced
 * under an older instruction, and cannot override the newer one. The refusal
 * names both versions, so whoever reads it can see what changed.
 *
 * The latest owner intent governs (the approved reading of S-0473). Whatever the
 * owner's words give as examples is recorded here as data on the version,
 * exactly as written; nothing here reads it as a list of what is allowed.
 *
 * An unknown is never favourable (invariant 39): a goal with no recorded
 * decision, or a report whose time cannot be read, is reported as unknown and
 * is not accepted as current.
 */
import type { WorkstreamEvent } from '../../domain/register.ts';
import { listWorkstreamEvents } from '../../repos/register.ts';

/** The owner decision events `decide.ts` writes, one writer each. */
export const OWNER_POLICY_EVENT_KINDS = [
  'GOAL_TERMS_SET',
  'GOAL_OBJECTIVE_CHANGED',
  'GOAL_PAUSED',
  'GOAL_RESUMED',
  'GOAL_CANCELLED',
  'GOAL_REINSTATED',
] as const;
export type OwnerPolicyEventKind = (typeof OWNER_POLICY_EVENT_KINDS)[number];

const POLICY_KINDS: ReadonlySet<string> = new Set(OWNER_POLICY_EVENT_KINDS);

/** One explicit version of a goal's owner policy: one owner decision, numbered in order. */
export interface PolicyVersion {
  goalId: string;
  /** 1 for the first recorded owner decision, n for the newest. */
  version: number;
  /** The decision event this version is. */
  eventId: string;
  kind: OwnerPolicyEventKind;
  decidedAt: string;
  /** Who decided, as the decision recorded it. */
  actorRef: string;
  /** The version this one replaced; null for the first. */
  supersedes: number | null;
  summary: string;
  /** What the decision recorded, verbatim — including what it replaced. Data, never a whitelist. */
  detail: Record<string, unknown>;
}

export type GoverningPolicy =
  | ({ known: true; versions: PolicyVersion[] } & PolicyVersion)
  | { known: false; goalId: string; reason: string; versions: PolicyVersion[] };

/** How many of a goal's events are read when deriving its policy: every one a goal plausibly has. */
export const POLICY_EVENT_READ_LIMIT = 100_000;

/**
 * The owner decision events of one goal, numbered 1..n in the order they were
 * made. Pure. Events of other kinds, or of another goal, are not policy and are
 * skipped; ties on the timestamp keep the order the store returned them in.
 */
export function policyVersions(goalId: string, events: readonly Pick<WorkstreamEvent, 'id' | 'workstreamId' | 'kind' | 'summary' | 'detail' | 'actorRef' | 'createdAt'>[]): PolicyVersion[] {
  const decisions = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.workstreamId === goalId && POLICY_KINDS.has(event.kind))
    .sort((a, b) => (a.event.createdAt < b.event.createdAt ? -1 : a.event.createdAt > b.event.createdAt ? 1 : a.index - b.index));
  return decisions.map(({ event }, i) => ({
    goalId,
    version: i + 1,
    eventId: event.id,
    kind: event.kind as OwnerPolicyEventKind,
    decidedAt: event.createdAt,
    actorRef: event.actorRef,
    supersedes: i === 0 ? null : i,
    summary: event.summary,
    detail: event.detail,
  }));
}

/** The governing policy from a set of versions. Pure. */
export function governingFrom(goalId: string, versions: PolicyVersion[]): GoverningPolicy {
  const newest = versions.at(-1);
  if (!newest) {
    return { known: false, goalId, reason: `No owner decision is recorded for goal ${goalId}, so no policy version governs it.`, versions };
  }
  return { known: true, versions, ...newest };
}

export interface OwnerPolicyDeps {
  listEvents?: (goalId: string) => Promise<WorkstreamEvent[]>;
}

/**
 * The newest authorized version of a goal's owner policy, with its event id,
 * timestamp, actor and the version it superseded. Reads; writes nothing.
 */
export async function governingPolicy(goalId: string, deps: OwnerPolicyDeps = {}): Promise<GoverningPolicy> {
  const list = deps.listEvents ?? ((id: string) => listWorkstreamEvents(id, POLICY_EVENT_READ_LIMIT));
  // The store answers newest first; reversing gives the order the decisions were made in.
  const events = [...(await list(goalId))].reverse();
  return governingFrom(goalId, policyVersions(goalId, events));
}

export type PolicyVerdict =
  | {
      verdict: 'CURRENT';
      /** May it stand against the governing instruction? */
      accepted: true;
      governingVersion: number;
      producedUnder: number;
      reason: string;
    }
  | {
      verdict: 'STALE';
      accepted: false;
      governingVersion: number;
      /** The version in force when it was produced; 0 when that was before any recorded decision. */
      producedUnder: number;
      reason: string;
    }
  | { verdict: 'UNKNOWN'; accepted: false; governingVersion: number | null; producedUnder: null; reason: string };

function describe(version: PolicyVersion): string {
  return `version ${version.version} (${version.kind}, ${version.decidedAt}, by ${version.actorRef})`;
}

/**
 * The precedence rule. Pure. Something produced at `producedAt` — a plan
 * reading, a report, a decision — stands against the governing policy only if
 * it was produced at or after the governing version was decided. Anything
 * older was produced under an earlier instruction and cannot override the
 * newer one; the refusal names both versions. A policy that is not known, or a
 * time that cannot be read, is UNKNOWN, and UNKNOWN is never accepted.
 */
export function staleAgainstPolicy(producedAt: string | null | undefined, policy: GoverningPolicy): PolicyVerdict {
  if (!policy.known) {
    return { verdict: 'UNKNOWN', accepted: false, governingVersion: null, producedUnder: null, reason: `${policy.reason} Whether it is current cannot be said, so it is not treated as current.` };
  }
  const at = producedAt ? Date.parse(producedAt) : Number.NaN;
  if (!Number.isFinite(at)) {
    return {
      verdict: 'UNKNOWN',
      accepted: false,
      governingVersion: policy.version,
      producedUnder: null,
      reason: `It carries no readable time, so it cannot be placed against ${describe(policy)}; it is not treated as current.`,
    };
  }
  const under = [...policy.versions].reverse().find((one) => Date.parse(one.decidedAt) <= at) ?? null;
  if (under && under.version === policy.version) {
    return { verdict: 'CURRENT', accepted: true, governingVersion: policy.version, producedUnder: under.version, reason: `Produced under the governing ${describe(policy)}.` };
  }
  return {
    verdict: 'STALE',
    accepted: false,
    governingVersion: policy.version,
    producedUnder: under?.version ?? 0,
    reason:
      `Produced under ${under ? describe(under) : 'no recorded owner decision (before version 1)'}, ` +
      `which ${describe(policy)} has since replaced; an older report cannot override the newer authorized instruction.`,
  };
}
