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
  reusableLessons,
} from '../../../repos/researchIntelligence.ts';
import { assessSufficiency } from './sufficiency.ts';
import { readGraph } from './uncertainty.ts';
import { listOpportunities } from '../../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../../repos/cashCardFacts.ts';
import { profileFor } from '../../russell/compilerProfiles.ts';
import { cashEngineCard } from '../../cash/engineCard.ts';
import { evidenceCard } from '../../cash/card.ts';
import {
  CAPTURE_INPUTS,
  cashTier,
  qualificationKeys,
  tierRank,
  type CashTier,
} from '../../cash/tier.ts';
import type {
  CashCardFact,
  CashOpportunity,
  ResearchOrchestration,
  ResearchRetrospective,
} from '../../../domain/types.ts';

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

/* ==========================================================================
 * Research usefulness: which approaches yield, read from rows
 *
 * The lessons above are about one campaign. These are about the *approaches*
 * a project's research has used — the compiler profile a packet was planned
 * under, the evidence lane a fragment answered, the repair strategy an attempt
 * took, and the surface (Routine) that ran it — and what each one produced:
 * accepted evidence, fields that the opportunity's current tier depends on,
 * qualified openings, harvested openings that were not duplicates, commercial
 * tests and settled money; against what it cost: passes and sessions, failed
 * retrievals, questions re-asked after an earlier fragment had answered them,
 * and abandoned assignments.
 *
 * **It is a reading, never a rule.** Nothing here is stored, nothing here is
 * imported by the gate, the depth allocation, the repair ladder, the dive
 * order or the commission allocator, and a test reads those modules to hold
 * that. The lessons it composes are DOMAIN-level context a prompt may carry
 * (§40, and RESEARCH-METHODS-NOTE row 8: Agent Workflow Memory's mechanism is
 * past outcomes in the prompt, not in the gate). An approach that yields more
 * is described as yielding more; nothing reorders, raises or lowers anything
 * because of it.
 *
 * An unknown is printed as unknown. A project with no recorded outcome has no
 * commercial-test figure for any approach, not a zero; a surface whose passes
 * carry no session reference has an unknown session count.
 * ======================================================================== */

export const USEFULNESS_DIMENSIONS = ['PROFILE', 'LANE', 'REPAIR_STRATEGY', 'SURFACE'] as const;
export type UsefulnessDimension = (typeof USEFULNESS_DIMENSIONS)[number];

/** The smallest sample a usefulness lesson may be read off. One fragment is an anecdote. */
export const USEFULNESS_MIN_SAMPLE = 5;
/** How far back the reading looks by default. */
export const USEFULNESS_WINDOW_DAYS = 30;

export interface ApproachUsefulness {
  dimension: UsefulnessDimension;
  approach: string;
  label: string;
  fragments: number;
  fragmentsAccepted: number;
  fragmentsBlocked: number;
  /** Fragments cancelled before they finished. */
  abandoned: number;
  /** Blocked fragments by their stored `block_cause` (workstream D); unclassified ones are absent. */
  blockCauses: Record<string, number>;
  claimsAccepted: number;
  /** Claims whose source could not be read (any retrieval state but RETRIEVED). */
  failedRetrievals: number;
  passes: number;
  /** Distinct session references across those passes; unknown when none carried one. */
  sessions: number | null;
  /** Fragments that re-asked a question an earlier fragment in this project had already answered. */
  repeatedWork: number;
  /** Card fields answered from this approach's claims. */
  fieldsAnswered: number;
  /**
   * Of those, fields the opportunity's current tier depends on, on pieces that
   * have left SIGNAL — the fields that moved a tier. A reading of what holds a
   * tier now, because tier crossings themselves are not recorded.
   */
  decisiveAnswered: number;
  /** Openings qualified now that carry evidence from this approach. */
  opportunitiesQualified: number;
  /** Openings harvested from this approach's claims that were not duplicates. */
  usefulDiscoveries: number;
  /** Openings with a recorded commercial outcome. Unknown when the project has none. */
  commercialTests: number | null;
  /** Settled money in minor units across currencies. Unknown when nothing has settled. */
  settledMinor: number | null;
}

export interface UsefulnessLesson {
  lessonKey: string;
  abstraction: 'DOMAIN';
  lesson: string;
  /** The approach ids and row ids it was read off. */
  evidence: string[];
  metrics: Record<string, number>;
  /** Always true: derived on read, stored nowhere, and it gates nothing. */
  informational: true;
}

export interface ResearchUsefulness {
  window: { since: string; until: string };
  approaches: ApproachUsefulness[];
  lessons: UsefulnessLesson[];
}

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  const match = /^https?:\/\/([^/\s?#]+)/i.exec(url);
  return match ? match[1]!.toLowerCase().replace(/^www\./, '') : null;
}

/**
 * The usefulness reading for one project. Reads, composes, returns.
 */
export async function researchUsefulness(input: {
  projectId: string;
  now?: string;
  windowDays?: number;
}): Promise<ResearchUsefulness> {
  const db = getDb();
  const until = input.now ?? new Date().toISOString();
  const since = new Date(
    Date.parse(until) - (input.windowDays ?? USEFULNESS_WINDOW_DAYS) * 86_400_000,
  ).toISOString();

  const fragments = await db.all<{
    id: string;
    status: string;
    evidence_lane: string | null;
    repair_strategy: string | null;
    attempt: number;
    question: string;
    created_at: string;
    envelope: string | null;
    block_cause: string | null;
    block_host: string | null;
  }>(
    `SELECT f.id, f.status, f.evidence_lane, f.repair_strategy, f.attempt, f.question, f.created_at,
            f.block_cause, f.block_host, o.approval_envelope_id AS envelope
       FROM research_fragments f
       JOIN research_orchestrations o ON o.id = f.orchestration_id
      WHERE f.project_id = ? AND f.created_at >= ? AND f.created_at <= ?`,
    [input.projectId, since, until],
  );
  const answered = await db.all<{ question: string; accepted_at: string | null; updated_at: string }>(
    `SELECT question, accepted_at, updated_at FROM research_fragments
      WHERE project_id = ? AND status = 'ACCEPTED'`,
    [input.projectId],
  );
  const firstAnswered = new Map<string, string>();
  for (const row of answered) {
    const at = row.accepted_at ?? row.updated_at;
    const key = normalizeQuestion(row.question);
    const seen = firstAnswered.get(key);
    if (!seen || at < seen) firstAnswered.set(key, at);
  }
  const passes = await db.all<{
    fragment_id: string;
    executor_routine_id: string | null;
    executor_session_ref: string | null;
    started_at: string;
  }>(
    `SELECT p.fragment_id, p.executor_routine_id, p.executor_session_ref, p.started_at
       FROM research_passes p
       JOIN research_fragments f ON f.id = p.fragment_id
      WHERE f.project_id = ? AND f.created_at >= ? AND f.created_at <= ?`,
    [input.projectId, since, until],
  );
  const claims = await db.all<{
    id: string;
    fragment_id: string | null;
    accepted: number;
    retrieval_state: string | null;
    source_url: string | null;
  }>(
    `SELECT c.id, c.fragment_id, c.accepted, c.retrieval_state, c.source_url
       FROM research_claims c
       JOIN research_fragments f ON f.id = c.fragment_id
      WHERE f.project_id = ? AND f.created_at >= ? AND f.created_at <= ?`,
    [input.projectId, since, until],
  );
  const routineNames = new Map<string, string>();
  for (const row of await db.all<{ id: string; name: string }>('SELECT id, name FROM fleet_routines')) {
    routineNames.set(row.id, row.name);
  }

  // Cash attribution: which claims answered which card fields, and each piece's tier now.
  const opportunities = await listOpportunities({ projectId: input.projectId });
  const facts = await cardFactsForProject(input.projectId);
  const factsByPiece = new Map<string, CashCardFact[]>();
  for (const fact of facts) {
    factsByPiece.set(fact.opportunityId, [...(factsByPiece.get(fact.opportunityId) ?? []), fact]);
  }
  const tierOf = new Map<string, CashTier>();
  const pieceById = new Map<string, CashOpportunity>();
  for (const opportunity of opportunities) {
    pieceById.set(opportunity.id, opportunity);
    tierOf.set(
      opportunity.id,
      cashTier({
        opportunity,
        card: cashEngineCard({ opportunity, facts: factsByPiece.get(opportunity.id) ?? [] }),
        readiness: evidenceCard(opportunity).readiness,
      }).tier,
    );
  }
  const outcomeRows = await db.all<{ opportunity_id: string }>(
    'SELECT DISTINCT opportunity_id FROM cash_outcomes WHERE project_id = ?',
    [input.projectId],
  );
  const tested = new Set(outcomeRows.map((row) => row.opportunity_id));
  const settledRows = await db.all<{ opportunity_id: string | null; total: number }>(
    `SELECT opportunity_id, SUM(amount_cents) AS total FROM cash_money_entries
      WHERE project_id = ? AND kind = 'SETTLEMENT' GROUP BY opportunity_id`,
    [input.projectId],
  );
  const settled = new Map<string, number>();
  for (const row of settledRows) if (row.opportunity_id) settled.set(row.opportunity_id, Number(row.total));
  const anyOutcome = outcomeRows.length > 0;
  const anySettled = settledRows.length > 0;

  // Each fragment's approach on every dimension.
  const surfaceOf = new Map<string, string>();
  const latestPass = new Map<string, string>();
  for (const pass of passes) {
    if (!pass.executor_routine_id) continue;
    const previous = latestPass.get(pass.fragment_id);
    if (!previous || pass.started_at > previous) {
      latestPass.set(pass.fragment_id, pass.started_at);
      surfaceOf.set(pass.fragment_id, pass.executor_routine_id);
    }
  }
  const fragmentApproach = new Map<string, Record<UsefulnessDimension, string>>();
  for (const fragment of fragments) {
    fragmentApproach.set(fragment.id, {
      PROFILE: fragment.envelope ? (profileFor(fragment.envelope)?.id ?? fragment.envelope) : 'NO_ENVELOPE',
      LANE: fragment.evidence_lane ?? 'NO_LANE',
      REPAIR_STRATEGY:
        fragment.repair_strategy ?? (Number(fragment.attempt) > 1 ? 'UNNAMED_REPAIR' : 'FIRST_ATTEMPT'),
      SURFACE: surfaceOf.get(fragment.id) ?? 'UNATTRIBUTED',
    });
  }
  const labelOf = (dimension: UsefulnessDimension, approach: string): string =>
    dimension === 'SURFACE' ? (routineNames.get(approach) ?? approach) : approach;

  interface Accumulator {
    dimension: UsefulnessDimension;
    approach: string;
    label: string;
    fragments: number;
    fragmentsAccepted: number;
    fragmentsBlocked: number;
    abandoned: number;
    blockCauses: Record<string, number>;
    claimsAccepted: number;
    failedRetrievals: number;
    passes: number;
    repeatedWork: number;
    fieldsAnswered: number;
    decisiveAnswered: number;
    sessionRefs: Set<string>;
    qualified: Set<string>;
    discoveries: Set<string>;
    tested: Set<string>;
  }
  const table = new Map<string, Accumulator>();
  const slot = (dimension: UsefulnessDimension, approach: string): Accumulator => {
    const key = `${dimension}|${approach}`;
    let entry = table.get(key);
    if (!entry) {
      entry = {
        dimension,
        approach,
        label: labelOf(dimension, approach),
        fragments: 0,
        fragmentsAccepted: 0,
        fragmentsBlocked: 0,
        abandoned: 0,
        blockCauses: {},
        claimsAccepted: 0,
        failedRetrievals: 0,
        passes: 0,
        repeatedWork: 0,
        fieldsAnswered: 0,
        decisiveAnswered: 0,
        sessionRefs: new Set(),
        qualified: new Set(),
        discoveries: new Set(),
        tested: new Set(),
      };
      table.set(key, entry);
    }
    return entry;
  };
  const each = (fragmentId: string | null, visit: (entry: Accumulator) => void): void => {
    if (!fragmentId) return;
    const approaches = fragmentApproach.get(fragmentId);
    if (!approaches) return;
    for (const dimension of USEFULNESS_DIMENSIONS) visit(slot(dimension, approaches[dimension]));
  };

  for (const fragment of fragments) {
    const earlier = firstAnswered.get(normalizeQuestion(fragment.question));
    const repeated = earlier !== undefined && earlier < fragment.created_at;
    each(fragment.id, (entry) => {
      entry.fragments += 1;
      if (fragment.status === 'ACCEPTED') entry.fragmentsAccepted += 1;
      if (fragment.status === 'BLOCKED') entry.fragmentsBlocked += 1;
      if (fragment.status === 'CANCELLED') entry.abandoned += 1;
      if (fragment.status === 'BLOCKED' && fragment.block_cause) {
        entry.blockCauses[fragment.block_cause] = (entry.blockCauses[fragment.block_cause] ?? 0) + 1;
      }
      if (repeated) entry.repeatedWork += 1;
    });
  }
  for (const pass of passes) {
    each(pass.fragment_id, (entry) => {
      entry.passes += 1;
      if (pass.executor_session_ref) entry.sessionRefs.add(pass.executor_session_ref);
    });
  }
  const claimFragment = new Map<string, string>();
  const unreadByHostSurface = new Map<string, { failed: number; retrieved: number; claimIds: string[] }>();
  for (const claim of claims) {
    if (claim.fragment_id) claimFragment.set(claim.id, claim.fragment_id);
    const failed = claim.retrieval_state !== null && claim.retrieval_state !== 'RETRIEVED';
    each(claim.fragment_id, (entry) => {
      if (Number(claim.accepted)) entry.claimsAccepted += 1;
      if (failed) entry.failedRetrievals += 1;
    });
    const host = hostOf(claim.source_url);
    const surface = claim.fragment_id ? surfaceOf.get(claim.fragment_id) : undefined;
    if (host && surface) {
      const key = `${surface}|${host}`;
      const cell = unreadByHostSurface.get(key) ?? { failed: 0, retrieved: 0, claimIds: [] };
      if (failed) {
        cell.failed += 1;
        cell.claimIds.push(claim.id);
      } else cell.retrieved += 1;
      unreadByHostSurface.set(key, cell);
    }
  }
  // A blocked fragment whose stored cause named a host counts as a failed read of that host.
  for (const fragment of fragments) {
    const surface = surfaceOf.get(fragment.id);
    const host = fragment.block_host?.toLowerCase().replace(/^www\./, '') ?? null;
    if (fragment.status !== 'BLOCKED' || !host || !surface) continue;
    const key = `${surface}|${host}`;
    const cell = unreadByHostSurface.get(key) ?? { failed: 0, retrieved: 0, claimIds: [] };
    cell.failed += 1;
    cell.claimIds.push(fragment.id);
    unreadByHostSurface.set(key, cell);
  }
  const qualifiedRank = tierRank('QUALIFIED');
  for (const fact of facts) {
    if (fact.kind !== 'EVIDENCE' || !fact.claimId) continue;
    const fragmentId = claimFragment.get(fact.claimId);
    if (!fragmentId) continue;
    const piece = pieceById.get(fact.opportunityId);
    const tier = tierOf.get(fact.opportunityId) ?? 'SIGNAL';
    const decisive =
      piece !== undefined &&
      tier !== 'SIGNAL' &&
      ([...qualificationKeys(piece.opportunitySignal ?? null), ...CAPTURE_INPUTS] as string[]).includes(
        fact.field,
      );
    each(fragmentId, (entry) => {
      entry.fieldsAnswered += 1;
      if (decisive) entry.decisiveAnswered += 1;
      if (tierRank(tier) >= qualifiedRank) entry.qualified.add(fact.opportunityId);
      if (tested.has(fact.opportunityId)) entry.tested.add(fact.opportunityId);
    });
  }
  for (const piece of opportunities) {
    if (!piece.sourceClaimId) continue;
    const fragmentId = claimFragment.get(piece.sourceClaimId);
    if (!fragmentId) continue;
    each(fragmentId, (entry) => {
      if (!piece.duplicateOfId) entry.discoveries.add(piece.id);
      if (tierRank(tierOf.get(piece.id) ?? 'SIGNAL') >= qualifiedRank) entry.qualified.add(piece.id);
      if (tested.has(piece.id)) entry.tested.add(piece.id);
    });
  }

  const approaches: ApproachUsefulness[] = [...table.values()]
    .map((entry) => {
      const settledTotal = [...new Set([...entry.qualified, ...entry.discoveries, ...entry.tested])]
        .map((id) => settled.get(id) ?? 0)
        .reduce((total, one) => total + one, 0);
      return {
        dimension: entry.dimension,
        approach: entry.approach,
        label: entry.label,
        fragments: entry.fragments,
        fragmentsAccepted: entry.fragmentsAccepted,
        fragmentsBlocked: entry.fragmentsBlocked,
        abandoned: entry.abandoned,
        blockCauses: entry.blockCauses,
        claimsAccepted: entry.claimsAccepted,
        failedRetrievals: entry.failedRetrievals,
        passes: entry.passes,
        sessions: entry.sessionRefs.size > 0 ? entry.sessionRefs.size : null,
        repeatedWork: entry.repeatedWork,
        fieldsAnswered: entry.fieldsAnswered,
        decisiveAnswered: entry.decisiveAnswered,
        opportunitiesQualified: entry.qualified.size,
        usefulDiscoveries: entry.discoveries.size,
        commercialTests: anyOutcome ? entry.tested.size : null,
        settledMinor: anySettled ? settledTotal : null,
      };
    })
    .sort((a, b) =>
      a.dimension !== b.dimension
        ? USEFULNESS_DIMENSIONS.indexOf(a.dimension) - USEFULNESS_DIMENSIONS.indexOf(b.dimension)
        : b.fragments - a.fragments || (a.approach < b.approach ? -1 : 1),
    );

  return {
    window: { since, until },
    approaches,
    lessons: usefulnessLessonsFrom(approaches, unreadByHostSurface, routineNames),
  };
}

/**
 * The DOMAIN lessons the reading supports. Each one is a sentence about counts,
 * with the counts beside it; none exists below `USEFULNESS_MIN_SAMPLE`.
 */
export function usefulnessLessonsFrom(
  approaches: readonly ApproachUsefulness[],
  unreadByHostSurface: ReadonlyMap<string, { failed: number; retrieved: number; claimIds: string[] }> = new Map(),
  routineNames: ReadonlyMap<string, string> = new Map(),
): UsefulnessLesson[] {
  const lessons: UsefulnessLesson[] = [];
  const lesson = (
    lessonKey: string,
    text: string,
    evidence: string[],
    metrics: Record<string, number>,
  ): void => {
    lessons.push({ lessonKey, abstraction: 'DOMAIN', lesson: text, evidence, metrics, informational: true });
  };

  // Within each dimension: which approach's fragments cleared their gate most and least often.
  for (const dimension of USEFULNESS_DIMENSIONS) {
    const sampled = approaches.filter(
      (one) => one.dimension === dimension && one.fragments >= USEFULNESS_MIN_SAMPLE,
    );
    if (sampled.length < 2) continue;
    const share = (one: ApproachUsefulness): number => one.fragmentsAccepted / one.fragments;
    const ordered = [...sampled].sort((a, b) => share(b) - share(a) || b.fragments - a.fragments);
    const best = ordered[0]!;
    const worst = ordered[ordered.length - 1]!;
    if (share(best) === share(worst)) continue;
    lesson(
      `acceptance-by-${dimension.toLowerCase()}`,
      `In this project, fragments researched under ${dimension.toLowerCase().replace('_', ' ')} ` +
        `${best.label} cleared their gate ${best.fragmentsAccepted} of ${best.fragments} times; under ` +
        `${worst.label}, ${worst.fragmentsAccepted} of ${worst.fragments}.`,
      [best.approach, worst.approach],
      {
        bestAccepted: best.fragmentsAccepted,
        bestFragments: best.fragments,
        worstAccepted: worst.fragmentsAccepted,
        worstFragments: worst.fragments,
      },
    );
  }

  // Compiler profiles: qualified openings per session, where sessions are known.
  const profiles = approaches.filter(
    (one) =>
      one.dimension === 'PROFILE' && one.sessions !== null && one.sessions >= USEFULNESS_MIN_SAMPLE,
  );
  if (profiles.length >= 2) {
    const per = (one: ApproachUsefulness): number => one.opportunitiesQualified / (one.sessions ?? 1);
    const ordered = [...profiles].sort((a, b) => per(b) - per(a));
    const best = ordered[0]!;
    const worst = ordered[ordered.length - 1]!;
    if (best.opportunitiesQualified > 0 && per(best) > per(worst)) {
      lesson(
        'qualified-per-session-by-profile',
        `In this project, research planned under ${best.label} qualified ${best.opportunitiesQualified} ` +
          `opening(s) over ${best.sessions} session(s); under ${worst.label}, ` +
          `${worst.opportunitiesQualified} over ${worst.sessions}.`,
        [best.approach, worst.approach],
        {
          bestQualified: best.opportunitiesQualified,
          bestSessions: best.sessions ?? 0,
          worstQualified: worst.opportunitiesQualified,
          worstSessions: worst.sessions ?? 0,
        },
      );
    }
  }

  // A host a surface has repeatedly failed to read, and never read.
  for (const [key, cell] of [...unreadByHostSurface.entries()].sort((a, b) => b[1].failed - a[1].failed)) {
    if (cell.failed < USEFULNESS_MIN_SAMPLE || cell.retrieved > 0) continue;
    const [surface, host] = key.split('|') as [string, string];
    lesson(
      `unreadable-${host}-from-${surface}`,
      `Sources on ${host} were unreadable from surface ${routineNames.get(surface) ?? surface} ` +
        `${cell.failed} time(s) and never read from it. An alternative source for the same fact is ` +
        'the likelier route from that surface.',
      [surface, host, ...cell.claimIds.slice(0, 10)],
      { failed: cell.failed, retrieved: cell.retrieved },
    );
  }

  // Questions asked again after an earlier fragment had answered them.
  const repeated = approaches
    .filter((one) => one.dimension === 'PROFILE')
    .reduce((total, one) => total + one.repeatedWork, 0);
  if (repeated >= USEFULNESS_MIN_SAMPLE) {
    lesson(
      'repeated-after-answered',
      `${repeated} fragment(s) in this project asked a question an earlier fragment had already ` +
        "answered. Reading the project's own accepted evidence first would have answered them.",
      approaches
        .filter((one) => one.dimension === 'PROFILE' && one.repeatedWork > 0)
        .map((one) => one.approach),
      { repeated },
    );
  }
  return lessons;
}

/**
 * The lessons a prompt may carry: the stored DOMAIN and GENERAL lessons
 * (`reusableLessons`) beside the derived usefulness lessons. Context only — a
 * caller puts these in front of a worker and changes nothing else because of
 * them.
 */
export async function lessonsForPrompt(
  projectId: string,
): Promise<{ lessonKey: string; abstraction: string; lesson: string; derived: boolean }[]> {
  const stored = await reusableLessons(projectId);
  const derived = (await researchUsefulness({ projectId })).lessons;
  return [
    ...stored.map((one) => ({
      lessonKey: one.lessonKey,
      abstraction: one.abstraction,
      lesson: one.lesson,
      derived: false,
    })),
    ...derived.map((one) => ({
      lessonKey: one.lessonKey,
      abstraction: one.abstraction,
      lesson: one.lesson,
      derived: true,
    })),
  ];
}

/** The usefulness block's lines, exactly as the cash report prints them. */
export function formatUsefulness(reading: ResearchUsefulness): string[] {
  const unknown = (value: number | null): string => (value === null ? 'unknown' : String(value));
  const lines: string[] = [];
  lines.push(
    `RESEARCH USEFULNESS (fragments created ${reading.window.since} → ${reading.window.until}; ` +
      'a reading, it gates nothing)',
  );
  if (reading.approaches.length === 0) lines.push('  no fragments in the window');
  let dimension: string | null = null;
  for (const one of reading.approaches) {
    if (one.dimension !== dimension) {
      dimension = one.dimension;
      lines.push(`  by ${dimension.toLowerCase().replace('_', ' ')}`);
    }
    lines.push(
      `    ${one.label.slice(0, 40).padEnd(40)} frag=${one.fragments} acc=${one.fragmentsAccepted}` +
        ` blk=${one.fragmentsBlocked}` +
        (Object.keys(one.blockCauses).length > 0
          ? `(${Object.entries(one.blockCauses).map(([k, n]) => `${k}:${n}`).join(',')})`
          : '') +
        ` abandoned=${one.abandoned} claims-acc=${one.claimsAccepted}` +
        ` unread=${one.failedRetrievals} passes=${one.passes} sessions=${unknown(one.sessions)}` +
        ` repeated=${one.repeatedWork} fields=${one.fieldsAnswered} decisive=${one.decisiveAnswered}` +
        ` qualified=${one.opportunitiesQualified} discoveries=${one.usefulDiscoveries}` +
        ` tests=${unknown(one.commercialTests)} settled=${unknown(one.settledMinor)}`,
    );
  }
  lines.push('  lessons (DOMAIN, informational)');
  if (reading.lessons.length === 0) lines.push('    none supported by the sample yet');
  for (const one of reading.lessons) lines.push(`    ${one.lessonKey}: ${one.lesson}`);
  return lines;
}
