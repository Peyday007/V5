/**
 * `npm run report:cash` — what a Cash sprint actually holds, and nothing else.
 *
 * Read-only, on purpose and by construction: it opens the database, prints what
 * is there, and closes it. It activates nothing, authorizes nothing, launches
 * nothing, harvests nothing and takes no decision. The one thing it can do to
 * production is read it.
 *
 *   npm run report:cash -- --project prj_xxx
 *   npm run report:cash                      (every project that runs a sprint)
 *
 * It exists because the production audit that found this pipeline had never run
 * to the end had to ship a scratch query runner into the container to ask the
 * question, and a question worth asking once about a live sprint is worth being
 * able to ask again. `packet-report.ts` is the same shape one altitude down,
 * and runs the same way: inside the container, through `flyctl ssh console`,
 * from a workflow, so the answer comes from the rows rather than from a screen
 * somebody photographed.
 *
 * What it reports is chosen to answer the questions a repaired sprint actually
 * raises, in the order they are asked:
 *
 *   * is the sprint running, and what does its own authorization permit;
 *   * is a commercial grant present, which is a separate decision and must
 *     read absent unless somebody made it;
 *   * where every discovery round is, and what is stopping the parked ones;
 *   * what the queue holds — queued, leased, done, failed;
 *   * what has been promoted into the portfolio, and from which claim;
 *   * which openings are being qualified and which have a card.
 *
 * No credential is read, printed or required. Nothing here names a connection
 * string, a bucket key or a token: it reports what a project contains, never
 * where it is kept.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getCashMode, listCashEvents } from '../server/repos/cashMode.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { liveAuthority } from '../server/repos/cashAuthority.ts';
import { listGoals } from '../server/repos/russellAuthority.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { listOrchestrationsByProject } from '../server/repos/research.ts';
import { cashRoadmap } from '../server/services/cash/roadmap.ts';
import { CASH_DISCOVERY_AUTHORITY_NAME } from '../server/services/cash/discoveryAuthority.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import type { WorkItem } from '../server/domain/types.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** One line, never wrapped, never a wall of JSON. */
function trim(value: string | null | undefined, width = 88): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function tally<T>(rows: T[], key: (row: T) => string): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}=${count}`)
    .join(' ') || '—';
}

/** The work items belonging to this project's research, by state. */
function queueShape(items: WorkItem[]): {
  queued: number;
  leased: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  const count = (state: string): number => items.filter((one) => one.state === state).length;
  return {
    queued: count('QUEUED'),
    leased: count('LEASED'),
    completed: count('COMPLETED'),
    failed: count('FAILED'),
    cancelled: count('CANCELLED'),
  };
}

async function reportProject(projectId: string, projectName: string): Promise<boolean> {
  const mode = await getCashMode(projectId);
  if (!mode) return false;

  console.log('');
  console.log('='.repeat(100));
  console.log(`CASH MODE — ${projectName} (${projectId})`);
  console.log('='.repeat(100));
  console.log(`  state       ${mode.state}`);
  console.log(`  currency    ${mode.currency}`);
  console.log(`  objective   ${trim(mode.objective)}`);
  console.log(`  envelope    ${mode.envelopeId ?? '—'}`);
  console.log(`  activated   ${mode.createdAt} by ${mode.createdByUserId}`);

  /*
   * The two authorizations, side by side and never conflated.
   *
   * The research grant is what pressing Start writes. The commercial grant is a
   * separate decision a person makes deliberately, and it must read absent
   * unless somebody has made it — printing them together is what makes that
   * checkable at a glance rather than inferred.
   */
  const goals = await listGoals(projectId);
  const discovery = goals.find(
    (goal) => goal.state === 'ACTIVE' && goal.name === CASH_DISCOVERY_AUTHORITY_NAME,
  );
  console.log('');
  console.log('AUTHORIZATION');
  if (discovery) {
    console.log(`  research    ACTIVE ${discovery.id}`);
    console.log(`    allows        ${discovery.allowedWork.join(', ')}`);
    console.log(`    prohibits     ${discovery.prohibitions.join(', ')}`);
    console.log(`    max spend     ${discovery.maxExternalSpend}`);
    console.log(`    concurrency   ${discovery.maxConcurrent}`);
    console.log(`    policy        ${discovery.workPolicy}`);
  } else {
    console.log('  research    ABSENT — no live internal discovery grant on this project');
  }
  const commercial = await liveAuthority(projectId);
  console.log(
    commercial
      ? `  commercial  PRESENT ${commercial.id} committed_ceiling=${commercial.maxCommittedCents} per_action=${commercial.maxPerActionCents} actions=${commercial.allowedActions.join(',')}`
      : '  commercial  ABSENT — nothing here may contact, buy, spend, commit or publish',
  );

  // --- Where the ideas are ------------------------------------------------
  const candidates = await listCandidates({ projectId });
  console.log('');
  console.log(`IDEAS (${candidates.length}) — ${tally(candidates, (one) => one.state)}`);
  /*
   * A parked idea prints the exact field the resume reads, not a paraphrase.
   *
   * `resumeAuthorityParkedCandidates` matches `judgment.blockedBy` against the
   * sentences `checkAuthority` itself composes, and refuses to unpark anything
   * else — so when a park survives a tick, the one thing worth knowing is
   * which of those sentences it actually carries. Printing `reason` alone
   * would be printing a neighbour of the answer.
   */
  for (const candidate of candidates.filter((one) => one.state === 'PARKED')) {
    // Already mapped out of the row by the repository, so it is read rather
    // than parsed here — the raw column is what `blockedOnStandingAuthority`
    // reads, and both resolve to the same value.
    const blockedBy = candidate.judgment['blockedBy'];
    console.log(`  PARKED ${candidate.id} priority=${candidate.priority ?? '—'}`);
    console.log(`      blockedBy: ${trim(typeof blockedBy === 'string' ? blockedBy : null)}`);
    console.log(`      reason:    ${trim(candidate.reason)}`);
  }

  const roadmap = await cashRoadmap(projectId);
  console.log('');
  console.log(
    `DISCOVERY ROUNDS — total=${roadmap.rounds.total} open=${roadmap.rounds.open}` +
      ` harvested=${roadmap.rounds.harvested} abandoned=${roadmap.rounds.abandoned}`,
  );
  // The live ones, which are the only ones anything is still waiting on.
  for (const round of roadmap.active) {
    console.log(
      `  ${round.bucketId.padEnd(26)} r${String(round.round).padEnd(3)}` +
        ` ${round.activity.padEnd(16)} found=${round.found}` +
        (round.plan ? ` items=${round.plan.byStatus.ACCEPTED}/${round.plan.planned}` : ' items=—'),
    );
    if (round.blocker) console.log(`      not moving: ${trim(round.blocker)}`);
  }

  // --- What the fleet has to do -------------------------------------------
  const orchestrations = await listOrchestrationsByProject(projectId);
  const items = await listWorkItems(projectId, { limit: 500 });
  const shape = queueShape(items);
  console.log('');
  console.log(`RESEARCH (${orchestrations.length} packets) — ${tally(orchestrations, (one) => one.status)}`);
  console.log(
    `  work items  queued=${shape.queued} leased=${shape.leased} completed=${shape.completed}` +
      ` failed=${shape.failed} cancelled=${shape.cancelled}`,
  );
  console.log(`  by type     ${tally(items, (one) => one.workType)}`);

  // --- What became a piece of work ----------------------------------------
  const opportunities = await listOpportunities({ projectId });
  console.log('');
  console.log(`PORTFOLIO (${opportunities.length})`);
  let cardsComplete = 0;
  let validationsStarted = 0;
  for (const opportunity of opportunities) {
    if (opportunity.validationState !== null) validationsStarted += 1;
    const facts = await cardFactsFor(opportunity.id);
    const card = cashEngineCard({ opportunity, facts });
    if (card.unknowns.length === 0) cardsComplete += 1;
    console.log(
      `  ${opportunity.id}  ${opportunity.state.padEnd(15)}` +
        ` validation=${String(opportunity.validationState ?? 'NOT_STARTED').padEnd(12)}` +
        ` answered=${card.entries.length - card.unknowns.length}/${card.entries.length}`,
    );
    console.log(`      ${trim(opportunity.title)}`);
    console.log(
      `      from claim ${opportunity.sourceClaimId ?? '—'}` +
        ` · packet ${opportunity.orchestrationId ?? '—'}` +
        ` · round ${opportunity.discoveryRoundId ?? '—'}`,
    );
  }

  const events = await listCashEvents(projectId);
  console.log('');
  console.log(`HISTORY (${events.length}) — ${tally(events, (one) => one.kind)}`);

  console.log('');
  console.log(
    `CASH-REPORT: ${projectId} state=${mode.state}` +
      ` research_grant=${discovery ? 'ACTIVE' : 'ABSENT'}` +
      ` commercial_grant=${commercial ? 'PRESENT' : 'ABSENT'}` +
      ` ideas=${candidates.length}` +
      ` rounds=${roadmap.rounds.total}` +
      ` queued=${shape.queued} leased=${shape.leased}` +
      ` completed=${shape.completed} failed=${shape.failed}` +
      ` opportunities=${opportunities.length}` +
      ` validations=${validationsStarted}` +
      ` cards_complete=${cardsComplete}`,
  );
  return true;
}

async function main(): Promise<void> {
  await initDatabase();

  const only = flag('project');
  const projects = await listProjects();
  let found = 0;
  for (const project of projects) {
    if (only && project.id !== only) continue;
    if (await reportProject(project.id, project.name)) found += 1;
  }

  console.log('');
  if (found === 0) {
    // Not a failure: most projects hold no sprint, and saying so is the answer.
    console.log('CASH-REPORT: OK sprints=0 — no project here is running a cash sprint');
    return;
  }
  console.log(`CASH-REPORT: OK sprints=${found}`);
}

main()
  .catch((error) => {
    console.error('CASH-REPORT: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
