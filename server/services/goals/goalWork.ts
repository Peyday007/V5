import { getDb } from '../../db/database.ts';

/**
 * Which research is an approved goal's own (owner, 2026-11-03: the openings the
 * $10K goal's constructed rounds filed are researched first).
 *
 * An idea is the goal's when it is one of the goal's own search rounds
 * (`goal-…` buckets: lenses and constructed arrangements), or when it asks
 * about an opening one of those rounds found — the opening's deep dive, or a
 * narrow question raised about it that is still being asked. Read from rows,
 * so every selector that orders work (judging, launching, the shared work
 * queue) applies the same rule and none of them keeps a second list.
 *
 * **A withdrawn question is nobody's goal work** (2026-11-17, `goals plan
 * wst_7b4fcbb5f2384f31b6c3`). The goal's path research withdraws a question
 * when it is asked again a different way or its opening is let go, and the
 * question's idea stays QUEUED. Counted as the goal's, ~95 such moot ideas —
 * older than every round, so first by `created_at` — held the goal tier of the
 * launch order while the grant sat at its ceiling (26 live of 13): each slot
 * that freed went to a question nobody was asking any more, the goal's nine
 * open rounds never launched, and they expired ABANDONED
 * (`RESEARCH_NOT_FINISHING`, "opened 0 · harvested 0 · abandoned 4"). Only an
 * OPEN question is the goal's now; a withdrawn one keeps its row and its idea
 * and simply waits in the ordinary order.
 *
 * **Each branch is one uncorrelated set**, not a per-idea join. The earlier
 * form joined every goal-found opening to `cash_needs` (no index on
 * `candidate_id`) for every candidate, and the tick's judge pass died on it
 * ("judge-unjudged: canceling statement due to statement timeout", production
 * 03:30Z), so no idea — the goal's included — was judged on that tick. As
 * `IN (SELECT …)` each set is computed once per statement on both dialects.
 */

/**
 * The request-key prefix of a goal's own price questions (`sendPortfolioNeeds`):
 * what buyers of a population its refused designs share pay. Such a need has
 * no opening row — its design was refused for want of the very price it asks
 * — so the opening branches below never reached it, and its idea waited
 * unjudged behind the ordinary backlog (production 2026-11-19: 14,737 unjudged
 * ideas, the oldest from 2026-11-15). It is the goal's research, so it is the
 * goal's idea while the need is OPEN.
 */
export const GOAL_PRICE_KEY_PREFIX = 'goal-price';

/** The graph scope a population's price question is keyed in (`priceScope`): `price:<population ref>`. */
export const GOAL_PRICE_SCOPE_PREFIX = 'price:';

/** A population's price question's subject (`priceNeedOf`), which names the buyers exactly as the construction does. */
export function goalPriceSubject(buyer: string): string {
  return `what buyers described as "${buyer}" pay`.slice(0, 300);
}

/**
 * The population a goal's price question asked about, read back from the idea
 * `sendNeeds` opened for it: its statement starts `For causal graph
 * price:<ref>,` (the scope) and its title is `Causal unknown: <subject>`
 * (`goalPriceSubject`, which names the buyers). Null when either is not that
 * question's wording — then the idea is not a price question and nothing is
 * read from it. The buyers are the construction's demand name (`clean`ed, so
 * it carries no quote mark), never a researcher's words.
 */
export function goalPriceQuestionOf(idea: { title: string; statement: string }): { ref: string; buyer: string } | null {
  const scope = /^For causal graph price:(.+?), establish from sourced evidence:/s.exec(idea.statement);
  const subject = /what buyers described as "([^"]+)" pay/.exec(idea.title);
  const ref = scope?.[1]?.trim();
  const buyer = subject?.[1]?.replace(/\s+/g, ' ').trim();
  return ref && buyer ? { ref, buyer } : null;
}

/**
 * Every approved, live goal, as one uncorrelated sub-select: a goal a person
 * set with a target (`target_metric`, written only through `domain/goals.ts`
 * by its owner), and not archived, paused or cancelled. The one reading of "a
 * live goal" the research order composes — launch and judging here
 * (`goalIdeaSql`), the shared queue (`servesGoalSearch`), bins
 * (`liveGoalBinSql`) and parked packets (`judgeParkedPacketIds`) — so a paused
 * goal's research drops back into the ordinary order by the same decision that
 * holds its bins. No parameters.
 */
/** The projects a live goal targets, as SQL — the same reading of "live" as `LIVE_GOAL_IDS_SQL`. */
export const LIVE_GOAL_PROJECT_IDS_SQL =
  'SELECT COALESCE(lgp.target_project_id, lgp.project_id) FROM workstreams lgp WHERE lgp.target_metric IS NOT NULL AND COALESCE(lgp.target_project_id, lgp.project_id) IS NOT NULL' +
  ' AND lgp.archived_at IS NULL AND lgp.paused_at IS NULL AND lgp.cancelled_at IS NULL';

export const LIVE_GOAL_IDS_SQL =
  'SELECT lg.id FROM workstreams lg WHERE lg.target_metric IS NOT NULL' +
  ' AND lg.archived_at IS NULL AND lg.paused_at IS NULL AND lg.cancelled_at IS NULL';

/** The projects an approved, live goal targets — the same reading of "a live goal" as `LIVE_GOAL_IDS_SQL`. */
export async function liveGoalProjectIds(): Promise<Set<string>> {
  const rows = await getDb().all<{ project_id: string }>(
    `SELECT DISTINCT lg.target_project_id AS project_id FROM workstreams lg
      WHERE lg.target_metric IS NOT NULL AND lg.target_project_id IS NOT NULL
        AND lg.archived_at IS NULL AND lg.paused_at IS NULL AND lg.cancelled_at IS NULL`,
  );
  return new Set(rows.map((row) => row.project_id));
}

/**
 * The tick's walk over projects, a live goal's projects first and the newest of
 * them first; every other project after, in the order it was given. Pure.
 *
 * The walk is serial and was in creation order, so the newest projects came
 * last. Production, 2026-11-25: twelve evaluation goals created at 03:29Z each
 * in its own project, a walk that had not settled 38 minutes after it started,
 * and no route opening dived in any of them at 04:45Z while 43 dives started in
 * older projects. Every project is still walked on every pass; only who waits
 * for whom within one pass changes.
 */
export function goalProjectsFirst<T extends { id: string; createdAt: string }>(projects: readonly T[], goalProjects: ReadonlySet<string>): T[] {
  const goal = projects.filter((one) => goalProjects.has(one.id)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return [...goal, ...projects.filter((one) => !goalProjects.has(one.id))];
}

/**
 * The ideas any approved, live goal links — the idea itself, or a mission it
 * links — read the way the goal model resolves its work (`goals/model.ts`).
 *
 * Production 2026-11-24: the goals created 11-19 each in their own project
 * (`wst_db2e2e0e…`, `wst_fa4761…`, …) carried 13–15 research bins READY at
 * 0/5 for five days while ~914 ideas waited Brain-wide. Their research is
 * linked to the goal, not filed under a `goal-…` round bucket, so no goal tier
 * recognised it: it launched, was judged and was claimed in the same order as
 * untargeted backlog discovery. Every live goal's linked research is now goal
 * work, in every order that already puts goal work first. No parameters.
 */
export function liveGoalCandidateIdsSql(): string {
  const live = goalLinksLiveSql(LIVE_GOAL_IDS_SQL);
  return (
    `SELECT gl.ref FROM workstream_links gl WHERE ${live} AND gl.kind = 'CANDIDATE' AND gl.ref IS NOT NULL` +
    ` UNION SELECT gm.candidate_id FROM workstream_links gl JOIN russell_missions gm ON gm.id = gl.ref` +
    ` WHERE ${live} AND gl.kind = 'MISSION' AND gm.candidate_id IS NOT NULL`
  );
}

/**
 * The openings any approved, live goal links, as one uncorrelated sub-select:
 * a route its own proposal filed (`routeProposal.ts` links it `SOURCE`, the
 * goal being where the opening came from) or one its plan pursues. No
 * parameters.
 *
 * Production 2026-11-25: twelve evaluation goals, each its own project, had
 * route dives started 04:51–06:35Z, and at 09:05Z every dive's idea was still
 * CAPTURED and unjudged, ordered with 26,551 untargeted ideas (tier 3) at one
 * ordinary judgment a tick. The dive's own `CANDIDATE` link is written when the
 * dive starts (#1305), so it reaches only dives started after that release and
 * none of the narrow questions raised about the same opening (63 in one
 * project, all tier 3). The goal-found-opening branches below read the opening
 * from the goal's round; a route opening has no round, so this is the same rule
 * read from the goal's own link to the opening — derived from rows, so it
 * reaches every dive and question already stranded as well as the next one.
 */
export function liveGoalOpeningIdsSql(): string {
  return (
    `SELECT go.ref FROM workstream_links go WHERE go.workstream_id IN (${LIVE_GOAL_IDS_SQL})` +
    ` AND go.kind = 'OPPORTUNITY' AND go.superseded_at IS NULL AND go.relation <> 'DEPENDS_ON' AND go.ref IS NOT NULL`
  );
}

/** A goal's live, pursuing links, aliased `gl`. `goals` is an id list or an uncorrelated sub-select. */
export function goalLinksLiveSql(goals: string): string {
  return `gl.workstream_id IN (${goals}) AND gl.superseded_at IS NULL AND gl.relation NOT IN ('SOURCE', 'DEPENDS_ON')`;
}

/**
 * The packets these goals reach — linked directly, or through a mission the
 * goal links by id or by candidate — as one uncorrelated sub-select
 * (`repos/bins.ts` explains why it is never correlated). No parameters.
 */
export function goalPacketIdsSql(goals: string): string {
  const live = goalLinksLiveSql(goals);
  return (
    `SELECT gl.ref FROM workstream_links gl WHERE ${live} AND gl.kind = 'PACKET' AND gl.ref IS NOT NULL` +
    ` UNION SELECT gm.orchestration_id FROM workstream_links gl JOIN russell_missions gm ON gm.id = gl.ref` +
    ` WHERE ${live} AND gl.kind = 'MISSION' AND gm.orchestration_id IS NOT NULL` +
    ` UNION SELECT gm.orchestration_id FROM workstream_links gl JOIN russell_missions gm ON gm.candidate_id = gl.ref` +
    ` WHERE ${live} AND gl.kind = 'CANDIDATE' AND gm.orchestration_id IS NOT NULL`
  );
}

/** The packets any approved, live goal reaches. No parameters. */
export function liveGoalPacketIdsSql(): string {
  return goalPacketIdsSql(LIVE_GOAL_IDS_SQL);
}

/**
 * A boolean over a `work_items` row (no alias): its packet serves an approved,
 * live goal. The shared queue's tie-break inside one priority, so every
 * claimant — the free lane and a Routine alike — takes a goal's research before
 * untargeted backlog at the same priority. No parameters.
 */
export function liveGoalWorkItemSql(): string {
  return `(orchestration_id IS NOT NULL AND orchestration_id IN (${liveGoalPacketIdsSql()}))`;
}

/** A boolean SQL expression over a `russell_candidates` row aliased `c`; true for the goal's own ideas. No parameters. */
export function goalIdeaSql(c: string): string {
  /*
   * Only a live goal's project (fresh batch fm1126b, 2026-11-26): the clauses
   * below named ideas by how they were made, never by whether the goal behind
   * them still runs, so a cancelled run's 600 ideas and the paused goals'
   * backlog stood at the head of the judge's goal queue, untouched, while 30
   * live goals' first ideas waited behind them. A paused or cancelled goal's
   * ideas drop to the ordinary order, as `LIVE_GOAL_IDS_SQL` already says.
   */
  return `(${c}.project_id IN (${LIVE_GOAL_PROJECT_IDS_SQL}) AND (${c}.id IN (SELECT gr.candidate_id FROM cash_discovery_rounds gr
                      WHERE gr.bucket_id LIKE 'goal-%' AND gr.candidate_id IS NOT NULL)
    OR ${c}.id IN (SELECT gop.candidate_id FROM cash_opportunities gop
                     JOIN cash_discovery_rounds gr2 ON gr2.id = gop.discovery_round_id
                    WHERE gr2.bucket_id LIKE 'goal-%' AND gop.candidate_id IS NOT NULL)
    OR ${c}.id IN (SELECT gn.candidate_id FROM cash_needs gn
                     JOIN cash_opportunities gop3 ON gop3.id = gn.opportunity_id
                     JOIN cash_discovery_rounds gr3 ON gr3.id = gop3.discovery_round_id
                    WHERE gr3.bucket_id LIKE 'goal-%' AND gn.state = 'OPEN' AND gn.candidate_id IS NOT NULL)
    OR ${c}.id IN (SELECT gp.candidate_id FROM cash_needs gp
                    WHERE gp.state = 'OPEN' AND gp.candidate_id IS NOT NULL
                      AND (gp.request_key LIKE '${GOAL_PRICE_KEY_PREFIX}-%' OR ${planQuestionSql('gp')}))
    OR ${goalDiveSql(c)}
    OR ${c}.id IN (SELECT gn4.candidate_id FROM cash_needs gn4
                    WHERE gn4.state = 'OPEN' AND gn4.candidate_id IS NOT NULL
                      AND gn4.opportunity_id IN (${liveGoalOpeningIdsSql()}))
    OR ${c}.id IN (${liveGoalCandidateIdsSql()})))`;
}

/**
 * A boolean SQL expression: this idea is the deep dive of an opening a live
 * goal links (`liveGoalOpeningIdsSql`) — the qualification its plan is judged
 * on ("research first: the deep dive … establishes or refutes the buyer,
 * price and demand each route proposal assumed"). No parameters.
 */
export function goalDiveSql(c: string): string {
  return `${c}.id IN (SELECT gd.candidate_id FROM cash_opportunities gd
                      WHERE gd.candidate_id IS NOT NULL AND gd.id IN (${liveGoalOpeningIdsSql()}))`;
}

/** A boolean SQL expression: this idea is one of a goal's own search rounds (`goal-…` bucket). No parameters. */
export function goalRoundSql(c: string): string {
  return `(${liveGoalProjectSql(c)} AND ${c}.id IN (SELECT gr.candidate_id FROM cash_discovery_rounds gr
                      WHERE gr.bucket_id LIKE 'goal-%' AND gr.candidate_id IS NOT NULL))`;
}

/**
 * A boolean SQL expression: this idea's project is one a live goal targets. No parameters.
 *
 * Every goal tier is a live goal's own work (fresh batch fm1126b, 2026-11-26,
 * read-only probe `planningEval launching`): the price and round tiers named
 * ideas by how they were made, never by whether the goal behind them still
 * runs. 30 live goals held 143 judged ideas, each with a compiled mission and
 * 6 free grant slots, and launched none in three hours, while 50-70 missions an
 * hour went to the price questions and rounds of paused and ended goals ranked
 * above them as "goal" work. The dive and idea tiers were already gated; these
 * two were not.
 */
export function liveGoalProjectSql(c: string): string {
  return `${c}.project_id IN (${LIVE_GOAL_PROJECT_IDS_SQL})`;
}

/**
 * An `ORDER BY` key: the goal's own rounds first, then the rest of its ideas,
 * then everything else.
 *
 * Production, 2026-11-17 05:35–06:18Z: with ended missions no longer holding
 * slots, the grant turned over (missions 3588 → 3590) at 13 of 13, and every
 * freed slot still went past the $10K goal's nine AWAITING_LAUNCH rounds. The
 * goal tier was one rank, ordered inside by priority, ordinal and age, so the
 * deep dives and questions about openings the goal had already found — older
 * and often ranked higher — took each slot, and the rounds that find new
 * openings (the search the goal is waiting on) never launched and expired.
 * A round is the goal's search itself, so it goes first inside the tier.
 *
 * **A goal's open price question goes before its rounds** (production
 * 2026-11-20 00:5xZ, read-only probe on `claude/probe-price-answers`). Every
 * goal plan stopped at "no price anywhere", and the 91 price questions
 * `sendPortfolioNeeds` raised from 13:36Z were all QUEUED, judged WORTH_DOING,
 * with a compiled mission and no mission launched in eleven hours: each grant
 * sat at its ceiling (13 of 13, 8 of 8, 7 of 7) and every freed slot went to
 * the goal's rounds first. A round finds more openings, and each one arrives
 * as unpriced as the last, so the search widened while nothing the plans
 * already hold was ever priced. A price question unblocks a plan that exists;
 * a round only adds to the set waiting on prices. The questions are bounded
 * (three per plan read, deduplicated by request key), so they cannot hold
 * the slots forever.
 */
export function goalPriceSql(c: string): string {
  return `(${liveGoalProjectSql(c)} AND ${c}.id IN (SELECT gp.candidate_id FROM cash_needs gp
                    WHERE gp.state = 'OPEN' AND gp.candidate_id IS NOT NULL
                      AND (gp.request_key LIKE '${GOAL_PRICE_KEY_PREFIX}-%' OR ${planQuestionSql('gp')})))`;
}

/**
 * A goal plan's own question (`sendPlanQuestions`): a condition the adopted plan rests on and swings on.
 *
 * Production 2026-11-21 23:45Z (read-only probe, claude/probe-price-answers): the $10K plan's own
 * questions ("ticket", "market", "close", "reply") had been OPEN since 11-14 with their ideas QUEUED a
 * week, never launched. They carry the generic `causal-` key, so no goal tier recognised them, and they
 * waited among 1,600 ordinary ideas behind grants that never freed. Recognised by the graph scope
 * `goalPlanScope` writes into the need (`goal:<id>:plan`), and by a `goal-plan-` key should the sender
 * adopt one. They share the price questions' tier: each is a figure an existing plan waits on.
 */
export function planQuestionSql(n: string): string {
  return `(${n}.request_key LIKE 'goal-plan-%' OR (${n}.request_key LIKE 'causal-%' AND ${n}.blocked_action LIKE 'Every answer in causal graph goal:%:plan %'))`;
}

/**
 * The tier `goalFirstSql` gives an idea no live goal claims; every lower tier
 * is a live goal's own work.
 *
 * **A goal opening's deep dive goes before the goal's other ideas**, after its
 * price questions and rounds (production 2026-11-25, d01): inside one project
 * the dive and the 63 narrow questions about the same openings were one tier
 * ordered by age, and the questions were older, so the dive the plan names as
 * "research first" waited for every one of them.
 */
export const GOAL_TIER_NONE = 4;

export function goalFirstSql(c: string): string {
  return `CASE WHEN ${goalPriceSql(c)} THEN 0 WHEN ${goalRoundSql(c)} THEN 1 WHEN ${goalDiveSql(c)} THEN 2 WHEN ${goalIdeaSql(c)} THEN 3 ELSE ${GOAL_TIER_NONE} END`;
}

/**
 * How many of a project's goal search rounds are waiting for a research slot:
 * an idea still live with no mission yet. What a lower-priority producer reads
 * to stand aside while the goal's own search is queued (W3c).
 */
export async function goalRoundsAwaitingLaunch(projectId: string): Promise<number> {
  const rows = await getDb().all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM russell_candidates c
      WHERE c.project_id = ?
        AND c.id IN (SELECT gr.candidate_id FROM cash_discovery_rounds gr
                      WHERE gr.bucket_id LIKE 'goal-%' AND gr.candidate_id IS NOT NULL)
        AND c.state NOT IN ('REJECTED', 'PARKED', 'MERGED', 'DONE')
        AND NOT EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id)`,
    [projectId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The research priority a stopped goal's queued work returns to: the base the
 * packet runner enqueues at before any goal boost (`enqueueResearchItem`).
 */
export const STOPPED_GOAL_RESEARCH_PRIORITY = 6;

/**
 * The queued research one goal reaches: its packets, and the projects no other
 * live goal works in. Read as plain id lists first and matched on the indexed
 * columns, never as one nested UPDATE: production 2026-11-26, a `retire` of
 * twelve goals whose UPDATE carried the goal-link unions inline was still
 * running after 90 minutes on Postgres, beside a claim queue that took and
 * held the same QUEUED rows. Each statement here is a short, bounded read or a
 * write by primary key that re-checks the row's state.
 */
async function goalQueuedWork(goalId: string, priority: { above: number } | { equal: number }): Promise<Array<{ id: string; orchestration_id: string | null }>> {
  const db = getDb();
  const packets = (await db.all<{ ref: string }>(`SELECT x.ref FROM (${goalPacketIdsSql('?')}) x`, [goalId, goalId, goalId]))
    .map((row) => row.ref)
    .filter(Boolean);
  const own = await db.all<{ project_id: string }>(
    `SELECT project_id FROM workstreams WHERE id = ? AND project_id IS NOT NULL
      UNION SELECT target_project_id FROM workstreams WHERE id = ? AND target_project_id IS NOT NULL`,
    [goalId, goalId],
  );
  // A project another live goal works in is that goal's too: only the packets name this goal's share of it.
  const others = new Set(
    (
      await db.all<{ project_id: string }>(
        `SELECT lg.project_id FROM workstreams lg WHERE lg.id IN (${LIVE_GOAL_IDS_SQL}) AND lg.id <> ? AND lg.project_id IS NOT NULL
          UNION SELECT lg.target_project_id FROM workstreams lg WHERE lg.id IN (${LIVE_GOAL_IDS_SQL}) AND lg.id <> ? AND lg.target_project_id IS NOT NULL`,
        [goalId, goalId],
      )
    ).map((row) => row.project_id),
  );
  const projects = own.map((row) => row.project_id).filter((id) => !others.has(id));
  const [cmp, value] = 'above' in priority ? ['>', priority.above] : ['=', priority.equal];
  const found = new Map<string, { id: string; orchestration_id: string | null }>();
  const take = async (column: 'orchestration_id' | 'project_id', ids: string[]): Promise<void> => {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const rows = await db.all<{ id: string; orchestration_id: string | null }>(
        `SELECT id, orchestration_id FROM work_items
          WHERE ${column} IN (${chunk.map(() => '?').join(', ')}) AND state = 'QUEUED' AND priority ${cmp} ?`,
        [...chunk, value],
      );
      for (const row of rows) found.set(row.id, row);
    }
  };
  await take('orchestration_id', packets);
  await take('project_id', projects);
  return [...found.values()];
}

/** Sets these QUEUED items' priority by id, re-checking state and the expected priority in the same statement. */
async function setQueuedPriority(ids: string[], to: number, priority: { above: number } | { equal: number }): Promise<number> {
  const [cmp, value] = 'above' in priority ? ['>', priority.above] : ['=', priority.equal];
  let changes = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const result = await getDb().run(
      `UPDATE work_items SET priority = ?
        WHERE id IN (${chunk.map(() => '?').join(', ')}) AND state = 'QUEUED' AND priority ${cmp} ?`,
      [to, ...chunk, value],
    );
    changes += result.changes;
  }
  return changes;
}

/**
 * A cancelled goal's queued research gives up the boost it was enqueued with.
 *
 * The goal boost is written into `work_items.priority` when an item is
 * enqueued, and nothing took it back when the goal stopped. Production
 * 2026-11-26 01:05Z (`planningEval stall --run all`): with keyed search spent,
 * the free lane admitted two research fragments at a time Brain-wide, and 837
 * evaluation fragments were QUEUED at priority 8-9, most of them for goals
 * already cancelled (retired rounds dev1-dev5). A fresh goal's dives, at 8,
 * queued behind cancelled goals' dives at 9: a stopped goal outranked a live
 * one. Nothing is discarded: the items stay QUEUED at the base research
 * priority, behind every live goal's research and level with untargeted
 * backlog, and `restoreGoalResearch` lifts them again on reinstatement. An item
 * whose packet also serves another live goal keeps its boost. Idempotent.
 */
export async function yieldStoppedGoalResearch(goalId: string): Promise<number> {
  const above = { above: STOPPED_GOAL_RESEARCH_PRIORITY };
  const items = await goalQueuedWork(goalId, above);
  if (items.length === 0) return 0;
  const live = new Set((await getDb().all<{ ref: string }>(`SELECT x.ref FROM (${liveGoalPacketIdsSql()}) x`)).map((row) => row.ref));
  const ids = items.filter((item) => !item.orchestration_id || !live.has(item.orchestration_id)).map((item) => item.id);
  return setQueuedPriority(ids, STOPPED_GOAL_RESEARCH_PRIORITY, above);
}

/** The reverse, on reinstatement: the goal's queued research at base priority takes the goal boost again. */
export async function restoreGoalResearch(goalId: string, boost: number): Promise<number> {
  const equal = { equal: STOPPED_GOAL_RESEARCH_PRIORITY };
  const items = await goalQueuedWork(goalId, equal);
  return setQueuedPriority(items.map((item) => item.id), Math.min(9, STOPPED_GOAL_RESEARCH_PRIORITY + boost), equal);
}
