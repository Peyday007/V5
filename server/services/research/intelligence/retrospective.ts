/**
 * What a campaign taught, at the abstraction it is actually true at.
 *
 * ---------------------------------------------------------------------------
 * The failure this is written against
 * ---------------------------------------------------------------------------
 *
 * The easy version of "learn from the campaign" is to store what happened and
 * replay it: this user asked for X and was happy, so next time do X. That learns
 * *"always do exactly what the user said last time"*, which is not a lesson — it
 * is a cache of one interaction presented as understanding, and it gets worse
 * the more of them there are.
 *
 * So every lesson declares the level it holds at. `CAMPAIGN` is about this
 * packet and nothing else; `DOMAIN` holds for this kind of question; `GENERAL`
 * is about how Brain researches. `reusableLessons` returns only the last two,
 * and even those are shown to a reader rather than applied to a gate — there is
 * no code path anywhere that lets a stored lesson change an evidence bar, a
 * coverage decision or an audit verdict.
 *
 * ---------------------------------------------------------------------------
 * Every lesson is read off rows
 * ---------------------------------------------------------------------------
 *
 * No provider is called and no prose is interpreted. A lesson exists because a
 * count came out a particular way — a decisive question discovered on the second
 * plan revision rather than the first, a branch retired after work had already
 * been spent on it, an uncertainty that was never load-bearing. Each carries the
 * rows it was read off, because a lesson with no evidence is an opinion and this
 * table must not store one as a finding.
 */
import { listWorkItemsForOrchestration } from '../../../repos/workQueue.ts';
import {
  citableClaims,
  getOrchestration,
  listClaims,
  listFragments,
} from '../../../repos/research.ts';
import { getDb } from '../../../db/database.ts';
import { TERMINAL_ORCHESTRATION } from '../outcome.ts';
import { listCoverage, listRequirements } from '../../../repos/reconciliation.ts';
import {
  listLessons,
  listPlanRevisions,
  recordLesson,
} from '../../../repos/researchIntelligence.ts';
import { assessSufficiency } from './sufficiency.ts';
import { readGraph } from './uncertainty.ts';
import type { ResearchOrchestration, ResearchRetrospective } from '../../../domain/types.ts';

/**
 * The measured facts about one campaign.
 *
 * Every field is a count of rows. None of them is an opinion, and none of them
 * is activity dressed as progress: `fragmentsResearched` is reported beside
 * `decisiveSettled` precisely so the second can be read instead of the first.
 */
export interface CampaignMetrics {
  fragmentsPlanned: number;
  fragmentsResearched: number;
  fragmentsAccepted: number;
  fragmentsBlocked: number;
  repairAttempts: number;
  /** Requirements the archive already answered, so nothing was spent on them. */
  duplicateResearchSuppressed: number;
  uncertaintiesOpened: number;
  decisiveTotal: number;
  decisiveSettled: number;
  branchesRetired: number;
  followUpsCreated: number;
  contradictionsDetected: number;
  personOnlyEscalations: number;
  /** Claims accepted inside a fragment that did not itself clear its bar. */
  claimsPreservedFromIncompleteWork: number;
  planRevisions: number;
  workItems: number;
  elapsedMs: number | null;
}

export async function measureCampaign(
  orchestration: ResearchOrchestration,
): Promise<CampaignMetrics> {
  const [fragments, claims, citable, graph, revisions, coverage, items] = await Promise.all([
    listFragments(orchestration.id),
    listClaims(orchestration.id),
    citableClaims(orchestration.id),
    readGraph(orchestration.id),
    listPlanRevisions(orchestration.id),
    listCoverage(orchestration.id),
    listWorkItemsForOrchestration(orchestration.id),
  ]);

  const acceptedFragmentIds = new Set(
    fragments.filter((fragment) => fragment.status === 'ACCEPTED').map((fragment) => fragment.id),
  );
  const decisive = graph.uncertainties.filter(
    (one) => one.invalidating || one.consequence === 'CRITICAL' || one.consequence === 'HIGH',
  );

  /*
   * Queued to finished, which on this path is the whole of it.
   *
   * `research_orchestrations.started_at` has the same single writer the
   * fragment column above does — `orchestrator.ts`, which cannot run in the
   * deployed Brain — so the fallback is not a fallback in production, it is the
   * value. That is the right reading anyway for a packet whose work is pulled:
   * the time a person waited starts when the packet was queued, not when some
   * worker happened to arrive. Said here rather than left to be rediscovered.
   */
  const started = orchestration.startedAt ?? orchestration.queuedAt;
  const ended = orchestration.completedAt ?? orchestration.cancelledAt ?? orchestration.failedAt;

  return {
    fragmentsPlanned: fragments.length,
    /*
     * A fragment that was actually handed out, read from its status.
     *
     * This counted `started_at !== null` and was therefore **structurally zero
     * on every real campaign**: the only writer of that column is
     * `orchestrator.ts`, the in-process push loop, which cannot run in the
     * deployed Brain at all (§24). So the metric described the path nothing
     * takes, and the first campaign it was measured against reported seven
     * fragments planned, six blocked, one accepted — and none researched.
     *
     * Found by measuring rather than by reading, which is the same lesson this
     * whole faculty is written from, arriving in its own metrics: a column
     * nothing writes is not a reading. The status is a row every path updates.
     */
    fragmentsResearched: fragments.filter(
      (fragment) =>
        fragment.startedAt !== null ||
        (fragment.status !== 'PLANNED' && fragment.status !== 'QUEUED'),
    ).length,
    fragmentsAccepted: acceptedFragmentIds.size,
    fragmentsBlocked: fragments.filter((fragment) => fragment.status === 'BLOCKED').length,
    // An attempt above the first is a repair by definition: §15 says a retry is
    // a new row, so the count is the rows rather than a counter.
    repairAttempts: fragments.filter((fragment) => fragment.attempt > 1).length,
    duplicateResearchSuppressed: coverage.filter((row) => !row.needsResearch).length,
    uncertaintiesOpened: graph.uncertainties.length,
    decisiveTotal: decisive.length,
    decisiveSettled: decisive.filter((one) => one.disposition === 'RESOLVED').length,
    branchesRetired: graph.uncertainties.filter((one) => one.disposition === 'RETIRED').length,
    followUpsCreated: graph.uncertainties.filter((one) => one.origin !== 'PLAN').length,
    contradictionsDetected: claims.filter(
      (claim) =>
        claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED',
    ).length,
    personOnlyEscalations: graph.uncertainties.filter((one) => one.disposition === 'PERSON_ONLY')
      .length,
    // The difference between what synthesis may cite and what its own fragment
    // proved. §12's rule that accepted evidence outlives its fragment, counted.
    claimsPreservedFromIncompleteWork: citable.filter(
      (claim) => !claim.fragmentId || !acceptedFragmentIds.has(claim.fragmentId),
    ).length,
    planRevisions: revisions.length,
    workItems: items.length,
    elapsedMs:
      started && ended ? Math.max(0, new Date(ended).getTime() - new Date(started).getTime()) : null,
  };
}

/**
 * Write the lessons this campaign's rows actually support.
 *
 * Idempotent by `lesson_key`, so running it on every tick over a terminal packet
 * writes each lesson exactly once — a derivation rather than a hook, which is
 * what reaches packets that finished before this existed.
 */
export async function recordRetrospective(
  orchestration: ResearchOrchestration,
): Promise<ResearchRetrospective[]> {
  const existing = await listLessons(orchestration.id);
  if (existing.some((lesson) => lesson.scope === 'CAMPAIGN_CLOSED')) return existing;

  const metrics = await measureCampaign(orchestration);
  const graph = await readGraph(orchestration.id);

  // Nothing to learn from a packet the faculty never saw. Writing a lesson about
  // one would be reporting an absence of rows as a finding about research.
  if (metrics.uncertaintiesOpened === 0) return existing;

  const [requirements, coverage, claims, fragments] = await Promise.all([
    listRequirements(orchestration.id),
    listCoverage(orchestration.id),
    listClaims(orchestration.id),
    listFragments(orchestration.id),
  ]);
  const reading = assessSufficiency({
    uncertainties: graph.uncertainties,
    links: graph.links,
    requirements,
    coverage,
    claims,
    fragments,
    mayRecordGaps: orchestration.unresolvedGapPolicy === 'RECORD_GAPS',
  });

  const numbers: Record<string, number> = {
    ...metrics,
    elapsedMs: metrics.elapsedMs ?? -1,
  };

  const written: ResearchRetrospective[] = [];
  const write = async (
    lessonKey: string,
    abstraction: 'CAMPAIGN' | 'DOMAIN' | 'GENERAL',
    lesson: string,
    evidence: string[],
  ): Promise<void> => {
    written.push(
      await recordLesson({
        orchestrationId: orchestration.id,
        projectId: orchestration.projectId,
        lessonKey,
        scope: 'CAMPAIGN_CLOSED',
        abstraction,
        lesson,
        evidence,
        metrics: numbers,
      }),
    );
  };

  // The campaign's own summary. Always written, always CAMPAIGN: it is true
  // about this packet and about nothing else, which is exactly what that level
  // means.
  await write(
    'outcome',
    'CAMPAIGN',
    `Finished ${orchestration.status} with ${metrics.decisiveSettled} of ` +
      `${metrics.decisiveTotal} decisive question(s) settled. Sufficiency read ` +
      `${reading.verdict}: ${reading.detail}`,
    graph.uncertainties.map((one) => one.uncertaintyKey),
  );

  /*
   * A decisive question discovered late.
   *
   * The lesson is not "that question was important" — that is about this packet.
   * It is that the *framing pass* missed it, which is a claim about how the
   * question was decomposed and holds for questions of this kind. The evidence
   * is the plan version the uncertainty was opened at.
   */
  const lateDecisive = graph.uncertainties.filter(
    (one) =>
      one.planVersion > 1 &&
      (one.invalidating || one.consequence === 'CRITICAL' || one.consequence === 'HIGH'),
  );
  if (lateDecisive.length > 0) {
    await write(
      'decisive-found-late',
      'DOMAIN',
      `${lateDecisive.length} question(s) that could change the outcome were only opened after ` +
        'research had started. The first decomposition of a question of this kind should ask ' +
        `about ${lateDecisive.map((one) => one.question).join('; ')} before spending anything.`,
      lateDecisive.map((one) => one.uncertaintyKey),
    );
  }

  /*
   * Work spent on a branch that later stopped mattering.
   *
   * The general form is an ordering lesson: the question that retired the branch
   * was cheaper than the work it retired, and asking it first would have saved
   * all of it. That holds beyond this campaign, which is why it is GENERAL.
   */
  const retired = graph.uncertainties.filter((one) => one.disposition === 'RETIRED');
  const retiredWithWork = retired.filter((one) =>
    fragments.some(
      (fragment) => fragment.fragmentKey === one.uncertaintyKey && fragment.startedAt !== null,
    ),
  );
  if (retiredWithWork.length > 0) {
    await write(
      'retired-after-spending',
      'GENERAL',
      `${retiredWithWork.length} branch(es) were researched and then retired because a ` +
        'prerequisite could not be established. The prerequisite was the cheaper question and ' +
        'should be sequenced ahead of anything that only matters if it holds.',
      retiredWithWork.map((one) => one.uncertaintyKey),
    );
  } else if (retired.length > 0) {
    await write(
      'retired-before-spending',
      'GENERAL',
      `${retired.length} branch(es) stopped bearing on the decision before anything was spent ` +
        'on them, because the prerequisite was investigated first. That ordering worked.',
      retired.map((one) => one.uncertaintyKey),
    );
  }

  /*
   * The archive answering something the campaign was about to research.
   *
   * §13's own rule, measured. DOMAIN rather than GENERAL: what it says is that
   * this project's archive is worth reading for questions of this kind, which is
   * a fact about this project.
   */
  if (metrics.duplicateResearchSuppressed > 0) {
    await write(
      'archive-answered-it',
      'DOMAIN',
      `${metrics.duplicateResearchSuppressed} requirement(s) were answered by the project's own ` +
        'archive and never researched. Reading the archive first is paying for itself on ' +
        'questions of this kind.',
      coverage.filter((row) => !row.needsResearch).map((row) => row.requirementId),
    );
  }

  /*
   * Evidence that survived work that did not.
   *
   * The lesson is about the mechanism rather than the packet: had the fragment's
   * failure discarded its claims, this many pieces of accepted evidence would
   * have been paid for and thrown away.
   */
  if (metrics.claimsPreservedFromIncompleteWork > 0) {
    await write(
      'evidence-outlived-its-fragment',
      'GENERAL',
      `${metrics.claimsPreservedFromIncompleteWork} accepted claim(s) came from fragments that ` +
        'did not themselves clear their bar. Discarding a fragment\'s evidence with the fragment ' +
        'would have thrown away work that had already been paid for.',
      [],
    );
  }

  /*
   * A disagreement that was found and attacked.
   */
  if (metrics.contradictionsDetected > 0) {
    const challenged = graph.uncertainties.filter((one) => one.origin === 'CONTRADICTION');
    await write(
      'contradiction-handled',
      'DOMAIN',
      `${metrics.contradictionsDetected} claim(s) were contested and ${challenged.length} ` +
        'challenge question(s) were opened. Sources of this kind disagree often enough that the ' +
        'disagreement is worth planning for rather than discovering.',
      challenged.map((one) => one.uncertaintyKey),
    );
  }

  return written.length > 0 ? written : existing;
}

/**
 * Terminal packets whose lessons have not been written, and the writing of them.
 *
 * On the tick and derived from rows, for the reason every other reconciliation
 * in this repository is: a hook on the moment a packet ends reaches only packets
 * that end after it is deployed, and this reaches the ones already finished.
 * Cheap on a healthy Brain — the query returns nothing once every terminal
 * packet has a row.
 */
export async function reconcileRetrospectives(
  limit: number,
): Promise<{ orchestrationId: string; lessons: number }[]> {
  const terminal = [...TERMINAL_ORCHESTRATION];
  const rows = await getDb().all<{ id: string }>(
    `SELECT o.id AS id
       FROM research_orchestrations o
      WHERE o.status IN (${terminal.map(() => '?').join(', ')})
        AND EXISTS (SELECT 1 FROM research_uncertainties u WHERE u.orchestration_id = o.id)
        AND NOT EXISTS (
          SELECT 1 FROM research_retrospectives r
           WHERE r.orchestration_id = o.id AND r.scope = 'CAMPAIGN_CLOSED'
        )
      ORDER BY o.id
      LIMIT ?`,
    [...terminal, Math.max(1, limit)],
  );

  const out: { orchestrationId: string; lessons: number }[] = [];
  for (const row of rows) {
    const orchestration = await getOrchestration(row.id);
    if (!orchestration) continue;
    const written = await recordRetrospective(orchestration);
    const closed = written.filter((lesson) => lesson.scope === 'CAMPAIGN_CLOSED');
    if (closed.length > 0) {
      out.push({ orchestrationId: orchestration.id, lessons: closed.length });
    }
  }
  return out;
}
