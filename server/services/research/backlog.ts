/**
 * The research backlog, explained: every queued research idea classified by
 * what it is for, which goal it serves, its priority, whether the rows show it
 * obsolete, and how ideas of its kind have actually turned out.
 *
 * Why this exists (owner, 2026-11-24): production showed 1,608 waiting ideas
 * beside 31 research slots, and nothing said what they were, which goal each
 * served, or how many were still worth a slot. The pool reading
 * (`engineering/watchdog.ts`) counts them; this reads them.
 *
 * Everything is read from rows — the idea (`russell_candidates`), the links
 * `goals/goalWork.ts` already uses to say whose research an idea is
 * (`cash_discovery_rounds`, `cash_opportunities`, `cash_needs`), the goals
 * (`workstreams`) and the missions that ran ideas of the same kind. Nothing is
 * estimated. Where the rows cannot say something (a goal's capital terms
 * changing under an idea), the reading says so rather than guessing.
 *
 * `retireObsoleteIdeas` takes the ideas the rows prove obsolete out of
 * scheduling: QUEUED → REJECTED, the row kept, and one `RESEARCH_BACKLOG_RETIRED`
 * event per project naming every idea and its reason (§5, invariant 3). It
 * retires only reasons that cannot become untrue on their own — a paused goal
 * or a passed deadline is reported, never retired, because a person can resume
 * the goal or move the date.
 */
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { transitionCandidate } from '../../repos/russellCandidates.ts';
import { isMarketLevelFigure } from '../cash/positionEvidence.ts';
import { GOAL_PRICE_KEY_PREFIX } from '../goals/goalWork.ts';

export type BacklogCategory =
  | 'GOAL_PRICE_QUESTION'
  | 'GOAL_PLAN_QUESTION'
  | 'GOAL_SEARCH_ROUND'
  | 'GOAL_OPENING_RESEARCH'
  | 'OPENING_RESEARCH'
  | 'OPENING_QUESTION'
  | 'DISCOVERY_ROUND'
  | 'CAUSAL_QUESTION'
  | 'OTHER';

export type ObsoleteReason =
  | 'QUESTION_WITHDRAWN'
  | 'QUESTION_ANSWERED'
  | 'OPENING_CLOSED'
  | 'MARKET_LEVEL_OPENING'
  | 'ROUND_CLOSED'
  | 'GOAL_ENDED'
  | 'DUPLICATE';

/** Reported, never retired: a person can undo the condition. */
export type HeldReason = 'GOAL_PAUSED' | 'GOAL_DEADLINE_PASSED';

export const CATEGORY_TEXT: Readonly<Record<BacklogCategory, { purpose: string; contribution: string; tier: number }>> = Object.freeze({
  GOAL_PRICE_QUESTION: {
    purpose: 'Price a buyer population a goal plan already depends on',
    contribution: 'Direct: unblocks a plan that exists but has no price. Launched first (goalWork tier 0).',
    tier: 0,
  },
  GOAL_PLAN_QUESTION: {
    purpose: 'Settle a condition a goal plan rests on',
    contribution: 'Direct: a figure an adopted plan waits on. Launched first (goalWork tier 0).',
    tier: 0,
  },
  GOAL_SEARCH_ROUND: {
    purpose: "Search for new openings for a goal",
    contribution: 'Indirect: widens the set of openings a goal plan can be built from (tier 1).',
    tier: 1,
  },
  GOAL_OPENING_RESEARCH: {
    purpose: "Research an opening a goal's own search found",
    contribution: 'Qualifies or rules out one candidate transaction for the goal (tier 2).',
    tier: 2,
  },
  OPENING_RESEARCH: {
    purpose: 'Deep-dive one specific opening found by general discovery',
    contribution: 'Qualifies one opening not yet tied to a goal; counts only if a goal adopts it (tier 3).',
    tier: 3,
  },
  OPENING_QUESTION: {
    purpose: 'Answer a narrow question about one opening',
    contribution: 'Removes an unknown from one opening not yet tied to a goal (tier 3).',
    tier: 3,
  },
  DISCOVERY_ROUND: {
    purpose: 'General discovery round not tied to a goal',
    contribution: 'Speculative: may surface openings any goal could later use (tier 3).',
    tier: 3,
  },
  CAUSAL_QUESTION: {
    purpose: 'Establish a causal figure (a rate, a price, a conversion) for a model',
    contribution: 'Feeds plan models; direct only when a plan names it (tier 3 otherwise).',
    tier: 3,
  },
  OTHER: {
    purpose: 'Other research (industry, labor, manufacturing, feeds and similar generators)',
    contribution: 'Not tied to a goal by any row (tier 3).',
    tier: 3,
  },
});

export const OBSOLETE_TEXT: Readonly<Record<ObsoleteReason | HeldReason, string>> = Object.freeze({
  QUESTION_WITHDRAWN: 'Its question was withdrawn (asked again another way, or its opening let go)',
  QUESTION_ANSWERED: 'Its question was already answered',
  OPENING_CLOSED: 'Its opening was declined, archived, expired or merged into a duplicate',
  MARKET_LEVEL_OPENING: 'Its "opening" is a market-level statistic with no buyer, supplier or price',
  ROUND_CLOSED: 'Its discovery round already closed (harvested or abandoned)',
  GOAL_ENDED: 'The goal it served was cancelled or archived',
  DUPLICATE: 'An older queued idea in the same project asks exactly the same thing',
  GOAL_PAUSED: 'The goal it serves is paused (kept: resuming the goal resumes it)',
  GOAL_DEADLINE_PASSED: "The goal's deadline has passed (kept: the deadline can be moved)",
});

const RETIRABLE: ReadonlySet<ObsoleteReason> = new Set<ObsoleteReason>([
  'QUESTION_WITHDRAWN',
  'QUESTION_ANSWERED',
  'OPENING_CLOSED',
  'MARKET_LEVEL_OPENING',
  'ROUND_CLOSED',
  'GOAL_ENDED',
  'DUPLICATE',
]);

interface IdeaRow {
  id: string;
  project_id: string;
  title: string;
  priority: string | null;
  created_at: string;
  compiled: number;
}
interface RoundRow { id: string; candidate_id: string | null; bucket_id: string; state: string }
interface OppRow {
  id: string;
  candidate_id: string | null;
  title: string;
  state: string;
  expires_at: string | null;
  duplicate_of_id: string | null;
  discovery_round_id: string | null;
  payer: string | null;
  price_cents: number | null;
  buying_signal: string | null;
}
interface NeedRow { id: string; candidate_id: string | null; opportunity_id: string | null; state: string; request_key: string | null; blocked_action: string }
interface GoalRow { id: string; title: string; paused_at: string | null; cancelled_at: string | null; archived_at: string | null; due_at: string | null }

export interface ClassifiedIdea {
  id: string;
  projectId: string;
  title: string;
  priority: string | null;
  createdAt: string;
  launchable: boolean;
  category: BacklogCategory;
  goalId: string | null;
  obsolete: ObsoleteReason | null;
  held: HeldReason | null;
}

const WST = /wst_[0-9a-f]{20}/;

function goalOf(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    const hit = text ? WST.exec(text) : null;
    if (hit) return hit[0];
  }
  return null;
}

function normalTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Rows in chunks, so an `IN (…)` list never outgrows either driver's parameter limit. */
async function inChunks<T>(ids: string[], sql: (marks: string) => string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    if (part.length === 0) continue;
    out.push(...(await getDb().all<T>(sql(part.map(() => '?').join(', ')), part)));
  }
  return out;
}

/** Classify ideas by their links. `ideas` may be any state; obsolescence is meaningful for QUEUED ones. */
export async function classifyIdeas(ideas: IdeaRow[], now = new Date().toISOString()): Promise<ClassifiedIdea[]> {
  const ids = ideas.map((one) => one.id);
  const rounds = await inChunks<RoundRow>(ids, (m) => `SELECT id, candidate_id, bucket_id, state FROM cash_discovery_rounds WHERE candidate_id IN (${m})`);
  const needs = await inChunks<NeedRow>(ids, (m) => `SELECT id, candidate_id, opportunity_id, state, request_key, blocked_action FROM cash_needs WHERE candidate_id IN (${m})`);
  const oppCols = 'id, candidate_id, title, state, expires_at, duplicate_of_id, discovery_round_id, payer, price_cents, buying_signal';
  const diveOpps = await inChunks<OppRow>(ids, (m) => `SELECT ${oppCols} FROM cash_opportunities WHERE candidate_id IN (${m})`);
  const needOppIds = [...new Set(needs.map((n) => n.opportunity_id).filter((x): x is string => !!x))];
  const questionOpps = await inChunks<OppRow>(needOppIds, (m) => `SELECT ${oppCols} FROM cash_opportunities WHERE id IN (${m})`);
  const opps = new Map<string, OppRow>([...diveOpps, ...questionOpps].map((o) => [o.id, o]));
  const oppRoundIds = [...new Set([...opps.values()].map((o) => o.discovery_round_id).filter((x): x is string => !!x))];
  const oppRounds = await inChunks<RoundRow>(oppRoundIds, (m) => `SELECT id, candidate_id, bucket_id, state FROM cash_discovery_rounds WHERE id IN (${m})`);
  const roundById = new Map(oppRounds.map((r) => [r.id, r]));
  const roundByIdea = new Map(rounds.filter((r) => r.candidate_id).map((r) => [r.candidate_id!, r]));
  const needByIdea = new Map(needs.filter((n) => n.candidate_id).map((n) => [n.candidate_id!, n]));
  const diveByIdea = new Map(diveOpps.filter((o) => o.candidate_id).map((o) => [o.candidate_id!, o]));
  const goals = new Map(
    (await getDb().all<GoalRow>('SELECT id, title, paused_at, cancelled_at, archived_at, due_at FROM workstreams', [])).map((g) => [g.id, g]),
  );

  const nowMs = Date.parse(now);
  const oldestByTitle = new Map<string, string>();
  for (const idea of [...ideas].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const key = `${idea.project_id}\u0000${normalTitle(idea.title)}`;
    if (!oldestByTitle.has(key)) oldestByTitle.set(key, idea.id);
  }

  return ideas.map((idea) => {
    const round = roundByIdea.get(idea.id);
    const need = needByIdea.get(idea.id);
    const dive = diveByIdea.get(idea.id);
    const opp = dive ?? (need?.opportunity_id ? opps.get(need.opportunity_id) : undefined);
    const oppRound = opp?.discovery_round_id ? roundById.get(opp.discovery_round_id) : undefined;
    const goalBucket = (b: string | undefined) => !!b && b.startsWith('goal-');

    let category: BacklogCategory = 'OTHER';
    if (need && (need.request_key ?? '').startsWith(`${GOAL_PRICE_KEY_PREFIX}-`)) category = 'GOAL_PRICE_QUESTION';
    else if (need && ((need.request_key ?? '').startsWith('goal-plan-') || /causal graph goal:[^:]+:plan/.test(need.blocked_action))) category = 'GOAL_PLAN_QUESTION';
    else if (round) category = goalBucket(round.bucket_id) ? 'GOAL_SEARCH_ROUND' : 'DISCOVERY_ROUND';
    else if (opp && goalBucket(oppRound?.bucket_id)) category = 'GOAL_OPENING_RESEARCH';
    else if (dive) category = 'OPENING_RESEARCH';
    else if (need && need.opportunity_id) category = 'OPENING_QUESTION';
    else if (need) category = 'CAUSAL_QUESTION';
    else if (/^causal unknown:/i.test(idea.title)) category = 'CAUSAL_QUESTION';

    const goalId = goalOf(round?.bucket_id, oppRound?.bucket_id, need?.request_key, need?.blocked_action);
    const goal = goalId ? goals.get(goalId) : undefined;

    let obsolete: ObsoleteReason | null = null;
    if (need && need.state === 'WITHDRAWN') obsolete = 'QUESTION_WITHDRAWN';
    else if (need && need.state === 'RESOLVED') obsolete = 'QUESTION_ANSWERED';
    else if (opp && (opp.state === 'DECLINED' || opp.state === 'ARCHIVED' || opp.duplicate_of_id || (opp.expires_at && Date.parse(opp.expires_at) < nowMs))) obsolete = 'OPENING_CLOSED';
    else if (opp && (isMarketLevelFigure(opp.title) || isMarketLevelFigure(opp.buying_signal)) && !opp.payer && opp.price_cents === null) obsolete = 'MARKET_LEVEL_OPENING';
    else if (round && round.state !== 'OPEN') obsolete = 'ROUND_CLOSED';
    else if (goal && (goal.cancelled_at || goal.archived_at)) obsolete = 'GOAL_ENDED';
    else if (oldestByTitle.get(`${idea.project_id}\u0000${normalTitle(idea.title)}`) !== idea.id) obsolete = 'DUPLICATE';

    let held: HeldReason | null = null;
    if (!obsolete && goal?.paused_at) held = 'GOAL_PAUSED';
    else if (!obsolete && goal?.due_at && Date.parse(goal.due_at) < nowMs) held = 'GOAL_DEADLINE_PASSED';

    return {
      id: idea.id,
      projectId: idea.project_id,
      title: idea.title,
      priority: idea.priority,
      createdAt: idea.created_at,
      launchable: idea.compiled === 1,
      category,
      goalId,
      obsolete,
      held,
    };
  });
}

async function queuedIdeas(): Promise<IdeaRow[]> {
  return await getDb().all<IdeaRow>(
    `SELECT id, project_id, title, priority, created_at,
            CASE WHEN judgment LIKE '%"missionSpec"%' THEN 1 ELSE 0 END AS compiled
       FROM russell_candidates WHERE state = 'QUEUED' AND project_id IS NOT NULL
      ORDER BY created_at ASC LIMIT 50000`,
    [],
  );
}

export interface BacklogReading {
  readAt: string;
  total: number;
  launchable: number;
  obsolete: number;
  held: number;
  categories: {
    category: BacklogCategory;
    purpose: string;
    contribution: string;
    tier: number;
    count: number;
    launchable: number;
    obsolete: number;
    byPriority: Record<string, number>;
    /** Missions of this kind that finished in the last seven days, from `russell_missions`. */
    finished7d: { done: number; useful: number; failed: number; cancelled: number };
  }[];
  goals: { goalId: string | null; title: string; state: string; count: number; obsolete: number; held: number }[];
  obsoleteReasons: { reason: ObsoleteReason | HeldReason; text: string; count: number; retirable: boolean }[];
  /** A few titles per category so a person can see what the rows say, never the whole statement. */
  samples: { category: BacklogCategory; title: string; obsolete: ObsoleteReason | null }[];
  limits: string[];
}

/** Missions finished in the last seven days, classified by the same rules, for an honest yield per category. */
async function finishedByCategory(now: string): Promise<Map<BacklogCategory, { done: number; useful: number; failed: number; cancelled: number }>> {
  const since = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const missions = await getDb().all<{ candidate_id: string; state: string; document_id: string | null }>(
    `SELECT candidate_id, state, document_id FROM russell_missions
      WHERE candidate_id IS NOT NULL AND completed_at IS NOT NULL AND completed_at > ? AND state IN ('DONE', 'FAILED', 'CANCELLED')`,
    [since],
  );
  const ideaIds = [...new Set(missions.map((m) => m.candidate_id))];
  const ideas = await inChunks<IdeaRow>(ideaIds, (m) => `SELECT id, project_id, title, priority, created_at, 0 AS compiled FROM russell_candidates WHERE id IN (${m})`);
  const classified = new Map((await classifyIdeas(ideas, now)).map((c) => [c.id, c.category]));
  const out = new Map<BacklogCategory, { done: number; useful: number; failed: number; cancelled: number }>();
  for (const mission of missions) {
    const category = classified.get(mission.candidate_id) ?? 'OTHER';
    const row = out.get(category) ?? { done: 0, useful: 0, failed: 0, cancelled: 0 };
    if (mission.state === 'DONE') {
      row.done += 1;
      if (mission.document_id) row.useful += 1;
    } else if (mission.state === 'FAILED') row.failed += 1;
    else row.cancelled += 1;
    out.set(category, row);
  }
  return out;
}

export async function readResearchBacklog(now = new Date().toISOString()): Promise<BacklogReading> {
  const ideas = await classifyIdeas(await queuedIdeas(), now);
  const finished = await finishedByCategory(now);
  const goalTitles = new Map(
    (await getDb().all<GoalRow>('SELECT id, title, paused_at, cancelled_at, archived_at, due_at FROM workstreams', [])).map((g) => [g.id, g]),
  );

  const categories = (Object.keys(CATEGORY_TEXT) as BacklogCategory[])
    .map((category) => {
      const mine = ideas.filter((one) => one.category === category);
      const byPriority: Record<string, number> = {};
      for (const one of mine) byPriority[one.priority ?? 'UNJUDGED'] = (byPriority[one.priority ?? 'UNJUDGED'] ?? 0) + 1;
      return {
        category,
        ...CATEGORY_TEXT[category],
        count: mine.length,
        launchable: mine.filter((one) => one.launchable).length,
        obsolete: mine.filter((one) => one.obsolete).length,
        byPriority,
        finished7d: finished.get(category) ?? { done: 0, useful: 0, failed: 0, cancelled: 0 },
      };
    })
    .filter((row) => row.count > 0 || row.finished7d.done + row.finished7d.failed + row.finished7d.cancelled > 0)
    .sort((a, b) => a.tier - b.tier || b.count - a.count);

  const goalCounts = new Map<string | null, { count: number; obsolete: number; held: number }>();
  for (const one of ideas) {
    const row = goalCounts.get(one.goalId) ?? { count: 0, obsolete: 0, held: 0 };
    row.count += 1;
    if (one.obsolete) row.obsolete += 1;
    if (one.held) row.held += 1;
    goalCounts.set(one.goalId, row);
  }
  const goals = [...goalCounts.entries()]
    .map(([goalId, row]) => {
      const goal = goalId ? goalTitles.get(goalId) : undefined;
      const state = !goalId
        ? 'NO_GOAL'
        : !goal
          ? 'UNKNOWN_GOAL'
          : goal.cancelled_at || goal.archived_at
            ? 'ENDED'
            : goal.paused_at
              ? 'PAUSED'
              : 'ACTIVE';
      return { goalId, title: goal?.title ?? (goalId ? goalId : 'Not tied to any goal'), state, ...row };
    })
    .sort((a, b) => b.count - a.count);

  const reasonCounts = new Map<ObsoleteReason | HeldReason, number>();
  for (const one of ideas) {
    const reason = one.obsolete ?? one.held;
    if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const obsoleteReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, text: OBSOLETE_TEXT[reason], count, retirable: RETIRABLE.has(reason as ObsoleteReason) }))
    .sort((a, b) => b.count - a.count);

  const samples: BacklogReading['samples'] = [];
  for (const row of categories) {
    for (const one of ideas.filter((idea) => idea.category === row.category).slice(-4)) {
      samples.push({ category: row.category, title: one.title.slice(0, 160), obsolete: one.obsolete });
    }
  }

  return {
    readAt: now,
    total: ideas.length,
    launchable: ideas.filter((one) => one.launchable).length,
    obsolete: ideas.filter((one) => one.obsolete).length,
    held: ideas.filter((one) => one.held).length,
    categories,
    goals,
    obsoleteReasons,
    samples,
    limits: [
      'An idea generated under a goal\'s earlier capital terms or a strategy the plan later rejected is not marked: no row records which terms or strategy an idea was generated under.',
      'Useful = a mission that finished DONE and filed a document; a DONE mission that filed nothing is counted as done, not useful.',
    ],
  };
}

/**
 * Take the ideas the rows prove obsolete out of scheduling. QUEUED → REJECTED
 * only (a compare-and-swap, so an idea that launched meanwhile is left alone);
 * every row is kept, and one event per project records each idea and why.
 */
export async function retireObsoleteIdeas(input: { dryRun: boolean; actor: string; now?: string }): Promise<{
  considered: number;
  retired: { id: string; projectId: string; reason: ObsoleteReason }[];
  byReason: Record<string, number>;
}> {
  const now = input.now ?? new Date().toISOString();
  const ideas = await classifyIdeas(await queuedIdeas(), now);
  const targets = ideas.filter((one): one is ClassifiedIdea & { obsolete: ObsoleteReason } => !!one.obsolete && RETIRABLE.has(one.obsolete));
  const retired: { id: string; projectId: string; reason: ObsoleteReason }[] = [];
  if (!input.dryRun) {
    for (const one of targets) {
      if (await transitionCandidate({ candidateId: one.id, from: 'QUEUED', to: 'REJECTED' })) {
        retired.push({ id: one.id, projectId: one.projectId, reason: one.obsolete });
      }
    }
    const byProject = new Map<string, typeof retired>();
    for (const one of retired) byProject.set(one.projectId, [...(byProject.get(one.projectId) ?? []), one]);
    for (const [projectId, rows] of byProject) {
      await recordEvent({
        projectId,
        entityType: 'RUSSELL_CANDIDATE',
        entityId: null,
        eventType: 'RESEARCH_BACKLOG_RETIRED',
        payload: {
          actor: input.actor,
          count: rows.length,
          ideas: rows.map((r) => ({ id: r.id, reason: r.reason, why: OBSOLETE_TEXT[r.reason] })),
        },
      });
    }
  } else {
    retired.push(...targets.map((one) => ({ id: one.id, projectId: one.projectId, reason: one.obsolete })));
  }
  const byReason: Record<string, number> = {};
  for (const one of retired) byReason[one.reason] = (byReason[one.reason] ?? 0) + 1;
  return { considered: ideas.length, retired, byReason };
}

const RETIRE_EVERY_MS = 30 * 60_000;
let lastRetireAt = 0;

/**
 * The tick's call: retire at most every thirty minutes. A moot idea is created
 * whenever a question is withdrawn and re-asked (`goals/pathResearch.ts`), so a
 * one-off clean-up would fill again; this keeps it from accumulating.
 */
export async function retireObsoleteIdeasIfDue(nowMs = Date.now()): Promise<number> {
  if (nowMs - lastRetireAt < RETIRE_EVERY_MS) return 0;
  lastRetireAt = nowMs;
  const out = await retireObsoleteIdeas({ dryRun: false, actor: 'BRAIN', now: new Date(nowMs).toISOString() });
  return out.retired.length;
}
