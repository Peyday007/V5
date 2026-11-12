/**
 * Discovery's buckets are search methods, and their rounds are runs.
 *
 * A discovery bucket is a stored way of looking for something: what it finds
 * (its question), where it is useful (its mechanism) and how its results are
 * checked (an opening is filed from a sourced claim, and is useful once it
 * reaches CANDIDATE). So each bucket a project asks is recorded as a
 * PROJECT-scoped search method keyed by the bucket id — the same key
 * `discoveryYield` measures it under — and each round that closes is one run of
 * it, through `recordRunAndSettle`, so trust moves only on what rounds actually
 * found.
 *
 * Before a bucket is asked again, `decideMethod` reads its runs: a bucket whose
 * recent rounds keep failing for one cause is paused until a retry time (the
 * source was unavailable, or nothing suitable existed) or flagged for revision
 * (its results are mostly wrong, or it has gone stale) instead of being rerun.
 * A bucket with no method yet is DEVELOP work by `routeRequest`: its first
 * round is what creates the method.
 *
 * Nothing here opens a round or decides what a round asks; `cash/discovery.ts`
 * stays the one owner of that, and calls in here at the two points where a
 * method's record changes.
 */
import { createSearchMethod, listMethodRuns, listSearchMethods } from '../../../repos/searchMethods.ts';
import type { RunOutcome, SearchMethod, SearchReader } from '../../../domain/searchIntelligence.ts';
import { decideMethod, type MethodDecision } from '../searchFailures/classify.ts';
import { routeRequest, type Route } from '../searchRouting/route.ts';
import { recordRunAndSettle } from './lifecycle.ts';
import { autoCompareSubject, sameSubject, type SubjectMethodYield } from './compare.ts';
import { SUBJECT_LENS_PREFIX } from '../../knowledge/subjects/subjects.ts';
import type { CompareResult } from './compare.ts';
import { currentFragments } from '../../../repos/research.ts';
import { UNREADABLE_CAUSES, blockCauseOf } from '../gate.ts';

/** The part of a discovery bucket its method record is made from. */
export interface BucketShape {
  id: string;
  title: string;
  question?: string;
  mechanism?: string;
}

/** How a discovery round ended, as `closeEndedRounds` knows it. */
export interface RoundEnding {
  to: 'HARVESTED' | 'ABANDONED';
  /** The research mission's state, when there was one. */
  missionState: string | null;
  /** Openings filed from the round. */
  found: number;
  /** Of those, how many have reached CANDIDATE or above. */
  useful: number;
  /** Of those, how many were duplicates of an opening already held. */
  duplicates: number;
  /** The round's current research fragments, across every attempt. */
  fragments?: number;
  /** Of those, how many were blocked because their sources could not be read. */
  sourceBlocked?: number;
}

/** Above this share of duplicated openings, what a round surfaced was mostly wrong. */
export const FALSE_POSITIVE_SHARE = 0.5;

/**
 * How many of the rounds' research fragments there are, and how many were
 * blocked because their sources could not be read (`SOURCE_ACCESS` or
 * `SOURCES_UNREADABLE`, as the gate stored it). Read from the fragments the
 * research runner already wrote; nothing here re-judges a fragment.
 */
export async function roundSourceAccess(orchestrationIds: readonly string[]): Promise<{ fragments: number; sourceBlocked: number }> {
  let fragments = 0;
  let sourceBlocked = 0;
  for (const id of new Set(orchestrationIds)) {
    for (const fragment of await currentFragments(id)) {
      fragments += 1;
      if (fragment.status === 'BLOCKED' && UNREADABLE_CAUSES.has(blockCauseOf(fragment))) sourceBlocked += 1;
    }
  }
  return { fragments, sourceBlocked };
}

export function readerForProject(projectId: string): SearchReader {
  return { projectIds: [projectId], userId: null };
}

/**
 * What a closed round says about its bucket as a method, or null when it says
 * nothing. Pure.
 *
 * A round that filed openings FOUND something — unless most of what it filed
 * duplicated openings already held, in which case what it surfaced was mostly
 * wrong: FALSE_POSITIVES. A round that filed nothing while most of its research
 * fragments were blocked because their sources could not be read did not
 * search: SOURCE_UNAVAILABLE, which says nothing about whether anything is
 * there. One that otherwise finished its research and filed none searched and
 * found NOTHING_SUITABLE. One whose research failed is an ERROR of the method's
 * execution. A round stopped for any other reason — a mission parked for a
 * person, cancelled, or a question the archive already answered — is not
 * evidence about the method either way, and records no run, so it can neither
 * earn trust nor count toward a failing streak.
 */
export function outcomeOfRound(ending: RoundEnding): { outcome: RunOutcome; failureCause: string | null } | null {
  if (ending.found > 0) {
    if (ending.duplicates > ending.found * FALSE_POSITIVE_SHARE) {
      return {
        outcome: 'FALSE_POSITIVES',
        failureCause: `${ending.duplicates} of the ${ending.found} opening(s) the round filed duplicated openings already held`,
      };
    }
    return { outcome: 'FOUND', failureCause: null };
  }
  const judged = ending.to === 'HARVESTED' || ending.missionState === 'FAILED';
  const fragments = ending.fragments ?? 0;
  const blocked = ending.sourceBlocked ?? 0;
  if (judged && blocked > 0 && blocked * 2 >= fragments) {
    return {
      outcome: 'SOURCE_UNAVAILABLE',
      failureCause: `${blocked} of the round's ${fragments} research fragment(s) were blocked because their sources could not be read`,
    };
  }
  if (ending.to === 'HARVESTED') return { outcome: 'NOTHING_SUITABLE', failureCause: 'the round finished its research and filed no opening' };
  if (ending.missionState === 'FAILED') return { outcome: 'ERROR', failureCause: 'the round\'s research mission failed' };
  return null;
}

/**
 * The subject a bucket searches for: the learned subject a lens was made from,
 * or null for a bucket that asks a mechanism question about no one subject.
 */
export function subjectOfBucket(bucketId: string): string | null {
  if (!bucketId.startsWith(SUBJECT_LENS_PREFIX)) return null;
  return bucketId.slice(SUBJECT_LENS_PREFIX.length) || null;
}

/**
 * The bucket's method, created on its first recorded run. A lens's method is
 * linked to the learned subject it was asked through, and one recorded before
 * that link existed is linked on its next run.
 */
export async function methodForBucket(projectId: string, bucket: BucketShape): Promise<SearchMethod> {
  return createSearchMethod({
    scope: 'PROJECT',
    projectId,
    methodKey: bucket.id,
    subjectId: subjectOfBucket(bucket.id),
    finds: (bucket.question?.trim() || bucket.title).slice(0, 2_000),
    usefulWhen: bucket.mechanism ? `openings by the ${bucket.mechanism} mechanism` : null,
    sources: ['cash discovery round'],
    requiredInputs: [],
    query: bucket.title,
    checkProcedure: 'An opening is filed only from a sourced claim; it counts as verified once it reaches CANDIDATE, and a duplicate of an opening already held counts against the method.',
  });
}

/**
 * Record one closed round as a run of its bucket's method and let trust settle.
 * Returns what the method may do next, or null when the round recorded nothing.
 */
export async function recordRoundAsRun(
  projectId: string,
  bucket: BucketShape,
  ending: RoundEnding,
  now = new Date().toISOString(),
): Promise<{ method: SearchMethod; decision: MethodDecision } | null> {
  const judged = outcomeOfRound(ending);
  if (!judged) return null;
  const reader = readerForProject(projectId);
  const method = await methodForBucket(projectId, bucket);
  const settled = await recordRunAndSettle(reader, {
    methodId: method.id,
    // A discovery round is a research packet a Claude worker answers.
    executor: 'CLAUDE',
    outcome: judged.outcome,
    failureCause: judged.failureCause,
    examined: ending.found,
    surfaced: ending.found,
    confirmed: ending.useful,
    rejected: ending.duplicates,
  });
  if (!settled) return null;
  return { method: settled.method, decision: decideMethod(await listMethodRuns(reader, method.id), now) };
}

export interface BucketGate {
  route: Route;
  decision: MethodDecision | null;
  /** Whether a round of this bucket may be opened now. */
  mayOpen: boolean;
}

/**
 * Whether each bucket may be asked now, from its method's recorded runs.
 * A bucket with no method may: its first round is the method's development.
 * A RETIRED method's bucket may not be asked again.
 */
export async function bucketGates(projectId: string, bucketIds: readonly string[], now: string): Promise<Map<string, BucketGate>> {
  const reader = readerForProject(projectId);
  const wanted = new Set(bucketIds);
  const byKey = new Map<string, SearchMethod>();
  for (const method of await listSearchMethods(reader)) {
    if (method.scope !== 'PROJECT' || method.projectId !== projectId || !wanted.has(method.methodKey)) continue;
    const held = byKey.get(method.methodKey);
    if (!held || method.version > held.version) byKey.set(method.methodKey, method);
  }
  const out = new Map<string, BucketGate>();
  for (const id of bucketIds) {
    const method = byKey.get(id) ?? null;
    const route = routeRequest(method ? { id: method.id, looksFor: method.finds } : null);
    if (!method) {
      out.set(id, { route, decision: null, mayOpen: true });
      continue;
    }
    if (method.trustState === 'RETIRED') {
      out.set(id, { route, decision: null, mayOpen: false });
      continue;
    }
    const decision = decideMethod(await listMethodRuns(reader, method.id), now);
    out.set(id, { route, decision, mayOpen: decision.action === 'RUN' });
  }
  return out;
}

/**
 * Compare every method this project asks for one subject, on what their rounds
 * filed. `yieldsByBucket` is each bucket's openings — surfaced, confirmed
 * (reached CANDIDATE) and rejected (duplicated one already held) — and only
 * buckets whose method is for the same subject (`sameSubject`: the same
 * learned subject, or one with the same key) take part. Recorded in the
 * project through `autoCompareSubject`; null when there was nothing to compare
 * or nothing new.
 */
export async function compareSubjectBuckets(
  projectId: string,
  subjectId: string,
  yieldsByBucket: ReadonlyMap<string, Omit<SubjectMethodYield, 'methodId'>>,
): Promise<CompareResult | null> {
  const reader = readerForProject(projectId);
  const latest = new Map<string, SearchMethod>();
  for (const method of await listSearchMethods(reader)) {
    if (method.scope !== 'PROJECT' || method.projectId !== projectId || !yieldsByBucket.has(method.methodKey)) continue;
    const held = latest.get(method.methodKey);
    if (!held || method.version > held.version) latest.set(method.methodKey, method);
  }
  const yields: SubjectMethodYield[] = [];
  for (const [bucketId, method] of latest) {
    if (method.trustState === 'RETIRED') continue;
    if (!(await sameSubject(reader, method.subjectId, subjectId))) continue;
    yields.push({ methodId: method.id, ...yieldsByBucket.get(bucketId)! });
  }
  return autoCompareSubject(reader, { subjectId, scope: { scope: 'PROJECT', projectId }, yields });
}
