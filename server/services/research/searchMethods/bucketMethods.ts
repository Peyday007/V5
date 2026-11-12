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
 * source was unavailable, or nothing suitable existed) or revised (its results
 * are mostly wrong, or it has gone stale) instead of being rerun unchanged.
 *
 * **A revision is a new version, never a closed door.** `reviseBucketMethod`
 * is the one consumer of REVISE: it writes version N+1 of the bucket's method
 * with a revised check and a revision instruction that says what went wrong
 * and what to do differently, retires version N with the reason it was
 * superseded, and records a cash event. The next round of the bucket is asked
 * under the new version — `discovery.ts` adds the instruction to the round's
 * question, so the round actually asks differently — and the new version's
 * runs start a fresh streak. A bucket whose revisions keep failing
 * (`MAX_REVISIONS`) is paused with a retry time instead of being revised
 * again; it is never removed from discovery without a time it comes back.
 * A bucket with no method yet is DEVELOP work by `routeRequest`: its first
 * round is what creates the method.
 *
 * Nothing here opens a round or decides what a round asks; `cash/discovery.ts`
 * stays the one owner of that, and calls in here at the two points where a
 * method's record changes.
 */
import { createSearchMethod, listMethodRuns, listSearchMethods, setMethodTrust } from '../../../repos/searchMethods.ts';
import { recordCashEvent } from '../../../repos/cashMode.ts';
import type { RunOutcome, SearchMethod, SearchReader } from '../../../domain/searchIntelligence.ts';
import { MAX_RETRY_MS, decideMethod, recentFailures, type FailureCause, type MethodDecision } from '../searchFailures/classify.ts';
import { routeRequest, type Route } from '../searchRouting/route.ts';
import { recordRunAndSettle } from './lifecycle.ts';
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

/** The newest version of a bucket's method, whatever its trust state, or null when it has none. */
export async function latestBucketMethod(projectId: string, bucketId: string): Promise<SearchMethod | null> {
  let latest: SearchMethod | null = null;
  for (const method of await listSearchMethods(readerForProject(projectId))) {
    if (method.scope !== 'PROJECT' || method.projectId !== projectId || method.methodKey !== bucketId) continue;
    if (!latest || method.version > latest.version) latest = method;
  }
  return latest;
}

/** The bucket's current method: its newest version, or version 1 created on its first recorded run. */
export async function methodForBucket(projectId: string, bucket: BucketShape): Promise<SearchMethod> {
  const latest = await latestBucketMethod(projectId, bucket.id);
  if (latest) return latest;
  return createSearchMethod({
    scope: 'PROJECT',
    projectId,
    methodKey: bucket.id,
    finds: (bucket.question?.trim() || bucket.title).slice(0, 2_000),
    usefulWhen: bucket.mechanism ? `openings by the ${bucket.mechanism} mechanism` : null,
    sources: ['cash discovery round'],
    requiredInputs: [],
    query: bucket.title,
    checkProcedure: 'An opening is filed only from a sourced claim; it counts as verified once it reaches CANDIDATE, and a duplicate of an opening already held counts against the method.',
  });
}

/** Revisions of one bucket's method before a further failure pauses it with a retry time instead. */
export const MAX_REVISIONS = 3;

/** The words a revised version carries: why it was revised and what its rounds must do differently. Pure. */
export function revisionInstruction(cause: FailureCause, failed: readonly { surfaced: number; rejected: number; finishedAt: string }[], lastFoundAt: string | null): string {
  if (cause === 'HIGH_FALSE_POSITIVES') {
    const surfaced = failed.reduce((n, run) => n + run.surfaced, 0);
    const rejected = failed.reduce((n, run) => n + run.rejected, 0);
    return (
      `The last ${failed.length} rounds of this search mostly re-reported openings Brain already held ` +
      `(${rejected} of the ${surfaced} filed were duplicates). Check every opening against the openings ` +
      'already listed before reporting it, report only ones that are genuinely new, look in places those ' +
      'rounds did not, and say plainly when nothing new exists.'
    );
  }
  return (
    `This search has found nothing ${lastFoundAt ? `since ${lastFoundAt.slice(0, 10)}` : 'for a long time'} and its last ` +
    `${failed.length} rounds found nothing suitable, so what it assumes about where these openings are published ` +
    'may no longer hold. Establish where openings of this kind are published now, including sources earlier ' +
    'rounds did not use, name the sources you tried, and say plainly when nothing exists.'
  );
}

export interface Revision {
  from: SearchMethod;
  to: SearchMethod;
  cause: FailureCause;
  instruction: string;
}

/**
 * Act on a REVISE decision: write the next version of the bucket's method with
 * the revision instruction and a tightened check, retire the version it
 * supersedes with the reason, and record the revision as a cash event. Null
 * when the decision is not REVISE, or when the bucket has been revised
 * `MAX_REVISIONS` times already (the gate then pauses it with a retry time).
 * Idempotent: a second call for the same version finds the revision written.
 */
export async function reviseBucketMethod(projectId: string, method: SearchMethod, decision: MethodDecision, now: string): Promise<Revision | null> {
  if (decision.action !== 'REVISE' || decision.cause === null) return null;
  if (method.version > MAX_REVISIONS) return null;
  const reader = readerForProject(projectId);
  const runs = await listMethodRuns(reader, method.id);
  const failed = recentFailures(runs);
  const lastFound = runs.filter((run) => run.outcome === 'FOUND').map((run) => run.finishedAt).sort().pop() ?? null;
  const instruction = revisionInstruction(decision.cause, failed, lastFound);
  const next = await createSearchMethod({
    scope: 'PROJECT',
    projectId,
    methodKey: method.methodKey,
    subjectId: method.subjectId,
    finds: method.finds,
    usefulWhen: method.usefulWhen,
    sources: method.sources,
    requiredInputs: method.requiredInputs,
    query: method.query,
    checkProcedure:
      decision.cause === 'HIGH_FALSE_POSITIVES'
        ? `${method.checkProcedure} Revised: an opening matching one already held is not filed at all.`.slice(0, 2_000)
        : method.checkProcedure,
    limits: `Revision ${method.version + 1} (${decision.cause}): ${instruction}`.slice(0, 2_000),
    version: method.version + 1,
  });
  const reason = `superseded by version ${next.version} (${decision.cause}): ${decision.reason}`;
  const retired = method.trustState === 'RETIRED' ? false : await setMethodTrust(method.id, method.trustState, 'RETIRED', reason);
  if (retired) {
    await recordCashEvent({
      projectId,
      kind: 'CASH_DISCOVERY_METHOD_REVISED',
      actorRef: 'BRAIN',
      summary: `Discovery search "${method.methodKey}" revised to version ${next.version}: ${decision.cause === 'HIGH_FALSE_POSITIVES' ? 'its rounds mostly re-reported openings already held' : 'it has gone stale'}.`,
      detail: { bucketId: method.methodKey, fromMethodId: method.id, toMethodId: next.id, fromVersion: method.version, toVersion: next.version, cause: decision.cause, failedInARow: decision.failedInARow, at: now },
    }).catch(() => undefined);
  }
  return { from: method, to: next, cause: decision.cause, instruction };
}

/** A REVISE that may not be revised again waits instead: the longest wait from its newest failure, never forever. */
function exhaustedRevision(decision: MethodDecision, runs: readonly { finishedAt: string }[], now: string): MethodDecision {
  const newest = runs.map((run) => run.finishedAt).sort().pop() ?? now;
  const retryAt = new Date(Date.parse(newest) + MAX_RETRY_MS).toISOString();
  if (Date.parse(now) >= Date.parse(retryAt)) {
    return { ...decision, action: 'RUN', retryAt: null, reason: `${decision.reason}; it was revised ${MAX_REVISIONS} times already and its wait is over, so it may be tried once more` };
  }
  return { ...decision, action: 'PAUSE', retryAt, reason: `${decision.reason}; it was revised ${MAX_REVISIONS} times already, so it waits rather than being revised again` };
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
): Promise<{ method: SearchMethod; decision: MethodDecision; revision?: Revision } | null> {
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
  const runs = await listMethodRuns(reader, method.id);
  const decision = decideMethod(runs, now);
  // REVISE is acted on where the streak is found: the next round runs under the revised version.
  const revision = await reviseBucketMethod(projectId, settled.method, decision, now);
  if (revision) return { method: revision.to, decision: decideMethod([], now), revision };
  return { method: settled.method, decision: decision.action === 'REVISE' ? exhaustedRevision(decision, runs, now) : decision };
}

export interface BucketGate {
  route: Route;
  decision: MethodDecision | null;
  /** Whether a round of this bucket may be opened now. */
  mayOpen: boolean;
  /** The current version's revision instruction, which the round's question carries; null for an unrevised method. */
  revision: string | null;
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
      out.set(id, { route, decision: null, mayOpen: true, revision: null });
      continue;
    }
    if (method.trustState === 'RETIRED') {
      out.set(id, { route, decision: null, mayOpen: false, revision: null });
      continue;
    }
    const runs = await listMethodRuns(reader, method.id);
    let decision = decideMethod(runs, now);
    if (decision.action === 'REVISE') {
      // A REVISE is never a closed bucket: it becomes the next version, which may run now,
      // or — once revised MAX_REVISIONS times — a pause with a time it comes back.
      const revision = await reviseBucketMethod(projectId, method, decision, now);
      if (revision) {
        const fresh = decideMethod([], now);
        out.set(id, { route: routeRequest({ id: revision.to.id, looksFor: revision.to.finds }), decision: fresh, mayOpen: true, revision: revision.to.limits });
        continue;
      }
      decision = exhaustedRevision(decision, runs, now);
    }
    out.set(id, { route, decision, mayOpen: decision.action === 'RUN', revision: method.version > 1 ? method.limits : null });
  }
  return out;
}
