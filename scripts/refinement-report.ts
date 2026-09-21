/**
 * `npm run report:refinement` — where every deep dive actually spent its time.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * "Why is refinement slow" had no answer that was not a guess. `cash-report.ts`
 * prints a validation's *state* and `packet-report.ts` prints a packet's, and
 * between them nothing said when anything started, how long it waited for a
 * worker, or which stage the time went into. So the first production reading of
 * this condition — two openings stuck at `RUNNING` — could be described and not
 * explained, and the obvious remedy for a thing nobody has measured is to guess
 * at a timeout.
 *
 * What it turned out to be is in the first block this prints: a deep dive whose
 * mission reaches `NEEDS_HUMAN` had no branch in `settleValidations`, so it
 * stayed `RUNNING` for ever while nothing ran — and `RUNNING` counts against
 * `MAX_VALIDATIONS_IN_FLIGHT`, which is two. Both slots held by parked
 * missions, thirty-eight openings that could never be qualified, and no state
 * column anywhere saying so.
 *
 * ---------------------------------------------------------------------------
 * What it measures, and what it refuses to
 * ---------------------------------------------------------------------------
 *
 * Every figure is the difference between two recorded timestamps. There is no
 * estimate, no average over a population, and no projection: a stage with no
 * timestamp reads `—` rather than being filled in from the one beside it, for
 * §30's reason — an unknown is never a favourable assumption, and a latency
 * report that invented a number would be measuring itself.
 *
 * The stages, in the order they happen:
 *
 *   started    the dive was launched and the candidate written
 *   judged     the candidate stopped being QUEUED — Brain decided about it
 *   mission    a mission exists for it
 *   packet     the orchestration exists, so research can be claimed
 *   first pass a worker actually began something
 *   last pass  the most recent thing a worker finished
 *   settled    Brain recorded an answer
 *
 * Beside them, the queue: what is claimable for that packet, what is leased,
 * and whether the lease is live or lapsed. An item `LEASED` with an expired
 * lease is claimable work (§19) and reads as running on every other surface.
 *
 * Read-only, by construction: it opens the database, prints, and closes. It
 * settles nothing, cancels nothing, claims nothing and starts nothing. No
 * credential is read or printed.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../server/repos/russellMissions.ts';
import { getOrchestration, listPasses } from '../server/repos/research.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import {
  MAX_VALIDATIONS_IN_FLIGHT,
  MAX_VALIDATION_ROUNDS,
  VALIDATION_STALL_MS,
} from '../server/services/cash/validation.ts';
import type { WorkItem } from '../server/domain/types.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** A duration between two stamps, or `—` when either is missing. */
function span(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '—';
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms)) return '—';
  return human(ms);
}

function human(ms: number): string {
  if (ms < 0) return `-${human(-ms)}`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function stamp(value: string | null | undefined): string {
  return value ? value.replace('T', ' ').slice(0, 19) : '—';
}

async function report(projectId: string, projectName: string): Promise<boolean> {
  const mode = await getCashMode(projectId);
  if (!mode) return false;

  const now = new Date().toISOString();
  const opportunities = await listOpportunities({ projectId });
  const dived = opportunities.filter((one) => one.validationState !== null);

  console.log('');
  console.log('='.repeat(100));
  console.log(`REFINEMENT — ${projectName} (${projectId})`);
  console.log('='.repeat(100));

  const byState = new Map<string, number>();
  for (const one of opportunities) {
    const key = one.validationState ?? 'NOT_STARTED';
    byState.set(key, (byState.get(key) ?? 0) + 1);
  }
  console.log(
    `  openings    ${opportunities.length}  ` +
      [...byState.entries()].map(([key, count]) => `${key}=${count}`).join(' '),
  );
  /*
   * The number that decides whether anything new can start, printed beside the
   * ceiling it is compared against. `NEEDS_PERSON` is deliberately not in it —
   * a dive parked for a person is using no provider capacity — and printing
   * both is what makes that visible rather than a claim in a comment.
   */
  const holding = opportunities.filter(
    (one) => one.validationState === 'PENDING' || one.validationState === 'RUNNING',
  ).length;
  const parked = opportunities.filter((one) => one.validationState === 'NEEDS_PERSON').length;
  console.log(
    `  in flight   ${holding} of ${MAX_VALIDATIONS_IN_FLIGHT} slots` +
      `  ·  ${parked} parked for a person, holding none` +
      `  ·  rounds cap ${MAX_VALIDATION_ROUNDS}  ·  stall after ${human(VALIDATION_STALL_MS)}`,
  );
  if (holding >= MAX_VALIDATIONS_IN_FLIGHT) {
    console.log(
      `  NOTE        every slot is taken, so no opening that has never been qualified can start.`,
    );
  }

  const queue = await listWorkItems(projectId, { limit: 500 });
  const byPacket = new Map<string, WorkItem[]>();
  for (const item of queue) {
    const ref = String((item.payload as Record<string, unknown>)['orchestrationId'] ?? '');
    if (!ref) continue;
    byPacket.set(ref, [...(byPacket.get(ref) ?? []), item]);
  }

  console.log('');
  console.log(`DEEP DIVES (${dived.length})`);
  for (const one of dived) {
    const candidate = one.candidateId ? await getCandidate(one.candidateId) : null;
    const mission = one.candidateId ? await latestMissionForCandidate(one.candidateId) : null;
    const packetId = one.validationOrchestrationId ?? mission?.orchestrationId ?? null;
    const packet = packetId ? await getOrchestration(packetId) : null;
    const passes = packetId ? await listPasses(packetId) : [];
    const completed = passes.filter((pass) => pass.completedAt !== null);
    const firstPass = passes[0] ?? null;
    const lastDone = completed[completed.length - 1] ?? null;

    console.log('');
    console.log(
      `  ${one.id}  ${String(one.validationState).padEnd(13)} round=${one.validationRounds}` +
        `  candidate=${candidate?.state ?? '—'}  mission=${mission?.state ?? '—'}` +
        `  packet=${packet?.status ?? '—'}`,
    );
    console.log(`      ${one.title.slice(0, 92)}`);
    console.log(
      `      started ${stamp(one.validationStartedAt)}   settled ${stamp(one.validationSettledAt)}`,
    );
    console.log(
      `      launch→candidate ${span(one.validationStartedAt, candidate?.createdAt)}` +
        `   →mission ${span(candidate?.createdAt, mission?.createdAt)}` +
        `   →packet ${span(mission?.createdAt, packet?.createdAt)}`,
    );
    console.log(
      `      →first pass ${span(packet?.createdAt, firstPass?.startedAt)}` +
        `   passes ${completed.length}/${passes.length}` +
        `   last finished ${stamp(lastDone?.completedAt)}`,
    );
    /*
     * Total, and the two that are not the same question. *Elapsed* is how long
     * this has been going; *to settle* is how long it took, and is absent
     * while it is still going rather than being filled in from the clock.
     */
    console.log(
      `      elapsed ${span(one.validationStartedAt, now)}` +
        `   to settle ${span(one.validationStartedAt, one.validationSettledAt)}`,
    );

    const items = packetId ? (byPacket.get(packetId) ?? []) : [];
    if (items.length > 0) {
      const claimable = items.filter((item) => item.state === 'QUEUED').length;
      const leased = items.filter((item) => item.state === 'LEASED');
      const lapsed = leased.filter(
        (item) => item.leaseExpiresAt !== null && item.leaseExpiresAt <= now,
      );
      console.log(
        `      queue ${items.length} item(s): ${claimable} claimable, ${leased.length} leased` +
          `${lapsed.length > 0 ? `, ${lapsed.length} on a LAPSED lease — claimable work reading as running` : ''}`,
      );
      for (const item of leased) {
        console.log(
          `        ${item.id}  ${item.workType.padEnd(20)} attempt=${item.attemptCount}/${item.maxAttempts}` +
            `  leased ${stamp(item.leasedAt)}  beat ${stamp(item.heartbeatAt)}` +
            `  expires ${stamp(item.leaseExpiresAt)}` +
            `${item.leaseExpiresAt && item.leaseExpiresAt <= now ? '  LAPSED' : ''}`,
        );
      }
    }
    if (mission && mission.state === 'NEEDS_HUMAN') {
      console.log(
        '      the mission stopped at a decision only a person can make; it is in Needs you.',
      );
    }
  }

  if (dived.length === 0) {
    console.log('  none — no opening in this project has had a deep dive.');
  }
  return true;
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const only = flag('project');
    let found = 0;
    for (const project of await listProjects()) {
      if (only && project.id !== only) continue;
      if (await report(project.id, project.name)) found += 1;
    }
    console.log('');
    console.log(`REFINEMENT-REPORT: OK sprints=${found}`);
  } finally {
    await closeDatabase();
  }
}

await main();
