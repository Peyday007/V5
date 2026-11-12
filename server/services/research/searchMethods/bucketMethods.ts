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
 * Development and execution are separate (gap 5). A Claude round is method
 * development: it is how a bucket's method is created and measured. Once the
 * method has earned PROVEN from those measured rounds it is compiled
 * (`compileBucketMethod`) into a GENERAL learned detector over the feed
 * sources, serving a privacy-checked GENERAL copy of the method. From then on
 * the bucket's route is CODE: the feeds pass runs that detector on every tick
 * (`feeds/learnedRun.ts`), its near-misses go to the cheap lane, its runs are
 * recorded as CODE runs, and `openDiscovery` opens no Claude round for it. The
 * bucket returns to DEVELOP only when its compiled executor needs revision or
 * is retired. A PROVEN method that cannot be compiled (too few confirmed
 * examples, no shared term, or examples holding private data) has no code
 * executor and stays DEVELOP, with the refusal named on its gate.
 *
 * Nothing here opens a round or decides what a round asks; `cash/discovery.ts`
 * stays the one owner of that, and calls in here at the two points where a
 * method's record changes.
 */
import {
  createSearchMethod, getSearchMethod, linkMethodSubject, listLearnedDetectors, listMethodRuns, listSearchMethods, setMethodTrust,
} from '../../../repos/searchMethods.ts';
import { recordCashEvent } from '../../../repos/cashMode.ts';
import { SUBJECT_LENS_PREFIX } from '../../knowledge/subjects/subjects.ts';
import type { LearnedDetector, RunOutcome, SearchMethod, SearchReader } from '../../../domain/searchIntelligence.ts';
import { MAX_RETRY_MS, decideMethod, recentFailures, type FailureCause, type MethodDecision } from '../searchFailures/classify.ts';
import { routeRequest, type Route } from '../searchRouting/route.ts';
import { PROVEN_PRECISION, provenMethods, recordRunAndSettle } from './lifecycle.ts';
import { createDetectorFromExamples } from '../../feeds/learned.ts';
import { FEED_READER } from '../../feeds/learnedRun.ts';
import { FEED_SOURCES } from '../../feeds/sources.ts';
import { privateDataIn } from '../../knowledge/scope/privacy.ts';
import { shareAsGeneral } from '../../knowledge/scope/share.ts';
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


/**
 * The learned subject a bucket asks about, or null for a constant bucket. A
 * learned subject reaches discovery as a lens whose id is the subject's id
 * behind `SUBJECT_LENS_PREFIX` (`knowledge/subjects/subjects.ts` `lensFor`).
 */
export function subjectOfBucket(bucketId: string): string | null {
  if (!bucketId.startsWith(SUBJECT_LENS_PREFIX)) return null;
  const id = bucketId.slice(SUBJECT_LENS_PREFIX.length).trim();
  return id || null;
}

/**
 * The bucket's method, created on its first recorded run. A lens asked for a
 * learned subject is linked to that subject, including a method created before
 * methods carried one, so every method for a subject can be compared with the
 * others.
 */
export async function methodForBucket(projectId: string, bucket: BucketShape): Promise<SearchMethod> {
  const subjectId = subjectOfBucket(bucket.id);
  const method = await createSearchMethod({
    scope: 'PROJECT',
    projectId,
    methodKey: bucket.id,
    subjectId,
    finds: (bucket.question?.trim() || bucket.title).slice(0, 2_000),
    usefulWhen: bucket.mechanism ? `openings by the ${bucket.mechanism} mechanism` : null,
    sources: ['cash discovery round'],
    requiredInputs: [],
    query: bucket.title,
    checkProcedure: 'An opening is filed only from a sourced claim; it counts as verified once it reaches CANDIDATE, and a duplicate of an opening already held counts against the method.',
  });
  if (subjectId && method.subjectId === null && (await linkMethodSubject(method.id, subjectId))) {
    return { ...method, subjectId };
  }
  return method;
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
  // Version 1 is written on the first run; a revised bucket's rounds are runs of its newest version.
  const first = await methodForBucket(projectId, bucket);
  const method = (await latestBucketMethod(projectId, bucket.id)) ?? first;
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

/** The detector key a bucket's compiled code executor is stored under. */
export function bucketDetectorKey(bucketId: string): string {
  return `bucket:${bucketId}`;
}

/** A bucket's code executor: the compiled detector and the GENERAL method it serves. */
export interface BucketExecutor {
  detector: LearnedDetector;
  method: SearchMethod;
}

/** The compiled executors of these buckets, newest version of each. */
export async function bucketExecutors(bucketIds: readonly string[]): Promise<Map<string, BucketExecutor>> {
  const keys = new Map(bucketIds.map((id) => [bucketDetectorKey(id), id] as const));
  const newest = new Map<string, LearnedDetector>();
  for (const detector of await listLearnedDetectors(FEED_READER)) {
    const bucketId = keys.get(detector.detectorKey);
    if (!bucketId || detector.scope !== 'GENERAL' || !detector.methodId) continue;
    const held = newest.get(bucketId);
    if (!held || detector.version > held.version) newest.set(bucketId, detector);
  }
  const out = new Map<string, BucketExecutor>();
  for (const [bucketId, detector] of newest) {
    const method = await getSearchMethod(FEED_READER, detector.methodId!);
    if (method) out.set(bucketId, { detector, method });
  }
  return out;
}

export type CompileResult =
  | { compiled: true; executor: BucketExecutor }
  | { compiled: false; reason: string };

/**
 * Compile a PROVEN bucket method into code, so routine searching for it stops
 * consuming Claude.
 *
 * The method must read as proven from its own runs (`provenMethods`, not the
 * stored state alone). Its confirmed openings' titles are the detector's
 * positive examples; titles that hold anything private are refused rather than
 * shared, and the method itself is shared only through `shareAsGeneral`, which
 * refuses a private definition. The detector is GENERAL because the feeds pass
 * runs only GENERAL detectors over the shared feed items; it starts in SHADOW
 * and goes ACTIVE only on measured precision, like every learned detector.
 * Idempotent: a bucket already compiled returns its executor.
 */
export async function compileBucketMethod(
  projectId: string,
  bucket: BucketShape,
  examples: { positives: readonly string[]; negatives?: readonly string[] },
): Promise<CompileResult> {
  const existing = (await bucketExecutors([bucket.id])).get(bucket.id);
  if (existing) return { compiled: true, executor: existing };
  const reader = readerForProject(projectId);
  const method = (await provenMethods(reader)).find(
    (one) => one.scope === 'PROJECT' && one.projectId === projectId && one.methodKey === bucket.id,
  );
  if (!method) return { compiled: false, reason: 'The bucket\'s method has not earned PROVEN from its measured rounds.' };
  const positives = [...new Set(examples.positives.map((t) => t.trim()).filter(Boolean))];
  const negatives = [...new Set((examples.negatives ?? []).map((t) => t.trim()).filter(Boolean))];
  const leaked = privateDataIn(
    { finds: [...positives, ...negatives].join('\n'), usefulWhen: null, sources: [], requiredInputs: [], query: null, checkProcedure: '', limits: null },
    { projectIds: [projectId] },
  );
  if (leaked.length > 0) {
    return { compiled: false, reason: `The confirmed openings hold ${leaked.join(', ')}, so they cannot become a shared detector.` };
  }
  let shared: Awaited<ReturnType<typeof shareAsGeneral>>;
  try {
    shared = await shareAsGeneral(reader, method.id, { projectIds: [projectId] });
  } catch (error) {
    return { compiled: false, reason: error instanceof Error ? error.message : 'The method could not be shared.' };
  }
  if (!shared.ok) return { compiled: false, reason: shared.reason };
  const made = await createDetectorFromExamples({
    scope: 'GENERAL',
    detectorKey: bucketDetectorKey(bucket.id),
    methodId: shared.method.id,
    sources: FEED_SOURCES.map((one) => one.id),
    positives,
    negatives,
    threshold: PROVEN_PRECISION,
  });
  if (!made.ok) return { compiled: false, reason: made.reason };
  return { compiled: true, executor: { detector: made.detector, method: shared.method } };
}

export interface BucketGate {
  /**
   * DEVELOP while the bucket has no code executor that may run: a Claude round
   * develops and measures its method. CODE once its PROVEN method is compiled:
   * the feeds pass executes it and no Claude round is opened.
   */
  route: Route;
  decision: MethodDecision | null;
  /** Whether a Claude development round of this bucket may be opened now. Never true on CODE. */
  mayOpen: boolean;
  /** Whether the bucket's own method reads as PROVEN from its runs, so it should be compiled. */
  proven: boolean;
  /** The compiled executor's detector, when the bucket routes to CODE. */
  executorDetectorId: string | null;
  /**
   * Whether the bucket has a compiled executor at all, running or not. One
   * held for revision or retired is not compiled again: its bucket is
   * redeveloped by Claude rounds instead.
   */
  compiled: boolean;
  /** The current version's revision instruction, which the round's question carries; null for an unrevised method. */
  revision: string | null;
}

/**
 * Whether each bucket may be asked now, and by whom, from its method's runs.
 *
 * A bucket with a compiled executor that is not retired and not held for
 * revision routes to CODE and may not open a Claude round; its decision is the
 * executor's own (a paused executor waits; it is not handed back to Claude).
 * Every other bucket routes to DEVELOP: one with no method may be asked, since
 * its first round is the method's development; a RETIRED method's bucket may
 * not be asked again; otherwise its recorded runs decide.
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
  const proven = new Set((await provenMethods(reader)).map((one) => one.id));
  const executors = await bucketExecutors(bucketIds);
  const out = new Map<string, BucketGate>();
  for (const id of bucketIds) {
    const method = byKey.get(id) ?? null;
    const isProven = method !== null && proven.has(method.id);
    const executor = executors.get(id);
    if (executor && executor.method.trustState !== 'RETIRED') {
      const decision = decideMethod(await listMethodRuns(FEED_READER, executor.method.id), now);
      if (decision.action !== 'REVISE') {
        out.set(id, {
          route: routeRequest({ id: executor.method.id, looksFor: executor.method.finds }),
          decision,
          mayOpen: false,
          proven: isProven,
          executorDetectorId: executor.detector.id,
          compiled: true,
          revision: null,
        });
        continue;
      }
    }
    // No code executor that may run: the method is (re)developed by a Claude round.
    const route = routeRequest(null);
    const compiled = executor !== undefined;
    if (!method) {
      out.set(id, { route, decision: null, mayOpen: true, proven: false, executorDetectorId: null, compiled, revision: null });
      continue;
    }
    if (method.trustState === 'RETIRED') {
      out.set(id, { route, decision: null, mayOpen: false, proven: false, executorDetectorId: null, compiled, revision: null });
      continue;
    }
    const runs = await listMethodRuns(reader, method.id);
    let decision = decideMethod(runs, now);
    if (decision.action === 'REVISE') {
      // A REVISE is never a closed bucket: it becomes the next version, which a Claude
      // development round may ask now (route stays DEVELOP: a revised method has no code
      // executor), or — once revised MAX_REVISIONS times — a pause with a time it comes back.
      const revision = await reviseBucketMethod(projectId, method, decision, now);
      if (revision) {
        out.set(id, { route, decision: decideMethod([], now), mayOpen: true, proven: false, executorDetectorId: null, compiled, revision: revision.to.limits });
        continue;
      }
      decision = exhaustedRevision(decision, runs, now);
    }
    out.set(id, { route, decision, mayOpen: decision.action === 'RUN', proven: isProven, executorDetectorId: null, compiled, revision: method.version > 1 ? method.limits : null });
  }
  return out;
}
