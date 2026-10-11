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
import { cashEventsOfKind, getCashMode } from '../server/repos/cashMode.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { latestMissionForCandidate, missionsForCandidate } from '../server/repos/russellMissions.ts';
import {
  getOrchestration,
  listClaimsForFragment,
  listFragments,
  listPasses,
} from '../server/repos/research.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { cashTier } from '../server/services/cash/tier.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { getDb } from '../server/db/database.ts';
import { getBin } from '../server/repos/bins.ts';
import { checkAuthority, spendTotals } from '../server/repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../server/services/russell/launch.ts';
import {
  MAX_VALIDATIONS_IN_FLIGHT,
  MAX_VALIDATION_ROUNDS,
  VALIDATION_STALL_MS,
  describeDiveRefusal,
  sprintCanRefine,
  whyNotDiving,
} from '../server/services/cash/validation.ts';
import type { CashOpportunity, WorkItem } from '../server/domain/types.ts';

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

  /*
   * Why nothing is being refined, causally, rather than as a count.
   *
   * `passes 0/0` is a true statement about a packet and no statement at all
   * about whether the lifecycle is stuck, waiting on a person, or working
   * exactly as designed. This block answers the question in two halves that
   * must not be collapsed: whether the **sprint** can start anything at all,
   * and, per opening, what refused *that* one.
   *
   * Both come from `services/cash/validation.ts` — the same functions
   * `startValidations` itself applies, in the same order — so what is printed
   * here is the refusal that actually happened rather than a second opinion
   * about it. A report with its own copy of an eligibility rule is the *two
   * readers of one fact* defect, and it is always the copy nobody exercises
   * that drifts.
   */
  const sprint = await sprintCanRefine(projectId);
  const sprintLine =
    sprint.kind === 'NO_SPRINT'
      ? 'there is no sprint on this project'
      : sprint.kind === 'WOUND_DOWN'
        ? `the sprint is not taking new work: ${sprint.reason}`
        : sprint.kind === 'NO_RESEARCH_AUTHORITY'
          ? 'no live research grant covers this project, so nothing could be compiled'
          : sprint.kind === 'SLOTS_TAKEN'
            ? `no free slot: ${sprint.inFlight} of ${sprint.cap} are held by live dives`
            : `${sprint.free} of ${sprint.cap} slot(s) free`;
  console.log('');
  console.log('WHY REFINEMENT IS OR IS NOT MOVING');
  console.log(`  sprint      ${sprintLine}`);

  const refusals = new Map<string, { count: number; line: string; examples: string[] }>();
  for (const one of opportunities) {
    const refusal = await whyNotDiving(one);
    const entry = refusals.get(refusal.kind) ?? {
      count: 0,
      line: describeDiveRefusal(refusal),
      examples: [],
    };
    entry.count += 1;
    if (entry.examples.length < 3) entry.examples.push(one.id);
    refusals.set(refusal.kind, entry);
  }
  for (const [kind, entry] of [...refusals.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${kind.padEnd(28)} ${String(entry.count).padStart(3)}  ${entry.line}` +
        `  [${entry.examples.join(' ')}]`,
    );
  }

  /*
   * And the sentence that joins the two halves.
   *
   * Eligible openings with no free slot is a **capacity** answer; no eligible
   * opening at all is a **decision** answer, and saying which requires both
   * numbers. A lifecycle that cannot proceed *only* because every path reaches
   * a person is a real and legitimate end state, and it is a different fact
   * from one that cannot proceed because nobody authorized anything.
   */
  const eligible = refusals.get('ELIGIBLE')?.count ?? 0;
  const awaiting = refusals.get('AWAITING_PERSON')?.count ?? 0;
  if (sprint.kind !== 'READY') {
    console.log(`  VERDICT     nothing can start: ${sprintLine}.`);
  } else if (eligible > 0) {
    console.log(
      `  VERDICT     ${eligible} opening(s) are eligible and ${sprint.free} slot(s) are free — ` +
        `the next tick starts one.`,
    );
  } else if (awaiting > 0) {
    console.log(
      `  VERDICT     no opening is eligible, and ${awaiting} of them are parked on a decision ` +
        `only a person can make. That is the lifecycle waiting rather than stuck: answering ` +
        `a Needs you card resumes the mission already there.`,
    );
  } else {
    console.log(
      `  VERDICT     no opening is eligible and none is waiting on a person. Every refusal ` +
        `above is a property of the opening itself.`,
    );
  }

  await researchConcurrency(projectId);

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
    await printGateOutcome(one);
  }

  if (dived.length === 0) {
    console.log('  none — no opening in this project has had a deep dive.');
  }
  await printCancellations(projectId);
  await printWorkByExecutor(projectId, now);
  return true;
}

/**
 * Who actually finished research here, by the worker and Routine Brain recorded
 * on each pass — never by a fire or an arrival, which say a session started and
 * nothing about whether it did the work.
 */
async function printWorkByExecutor(projectId: string, now: string): Promise<void> {
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const rows = await getDb().all<{
    worker: string | null;
    routine: string | null;
    pass_key: string;
    n: number;
    first_done: string | null;
    last_done: string | null;
  }>(
    `SELECT p.executor_worker_id AS worker, p.executor_routine_id AS routine, p.pass_key AS pass_key,
            COUNT(*) AS n, MIN(p.completed_at) AS first_done, MAX(p.completed_at) AS last_done
       FROM research_passes p
       JOIN research_orchestrations o ON o.id = p.orchestration_id
      WHERE o.project_id = ? AND p.status = 'COMPLETE' AND p.completed_at >= ?
      GROUP BY p.executor_worker_id, p.executor_routine_id, p.pass_key
      ORDER BY p.executor_worker_id, p.executor_routine_id, p.pass_key`,
    [projectId, since],
  );
  console.log('');
  console.log(`RESEARCH COMPLETED BY EXECUTOR (last 24h, since ${stamp(since)})`);
  if (rows.length === 0) console.log('  none');
  for (const row of rows) {
    console.log(
      `  ${String(row.worker ?? '—').padEnd(26)} ${String(row.routine ?? '—').padEnd(26)}` +
        ` ${row.pass_key.padEnd(12)} ${String(Number(row.n)).padStart(4)}` +
        `  ${stamp(row.first_done)} .. ${stamp(row.last_done)}`,
    );
  }
}

/** The measured healthy window the cancellation rates are compared against. */
const HEALTHY_FROM = '2026-10-08T07:28:00.000Z';
const HEALTHY_TO = '2026-10-09T04:27:00.000Z';

/** A reason with its row ids and numbers folded, so one cause counts once. */
function reasonKey(text: string | null): string {
  return (text ?? '(no reason recorded)')
    .replace(/\b[a-z]{2,4}_[0-9a-f]{12,}\b/g, '<id>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

/**
 * Why work was cancelled, grouped by the reason recorded on each row.
 *
 * The cancellation *rate* had been reported without its causes, over a mixed
 * period that included outages. Both halves are printed here: every
 * cancellation, and the ones created inside the measured healthy window, so a
 * reader can tell a policy that discards work from an outage that stranded it.
 * Read-only: it counts rows and changes none.
 */
async function printCancellations(projectId: string): Promise<void> {
  const items = await getDb().all<{ work_type: string; state: string; cancelled_reason: string | null; created_at: string }>(
    `SELECT work_type, state, cancelled_reason, created_at FROM work_items WHERE project_id = ?`,
    [projectId],
  );
  const packets = await getDb().all<{ status: string; failure_reason: string | null; created_at: string }>(
    `SELECT status, failure_reason, created_at FROM research_orchestrations WHERE project_id = ?`,
    [projectId],
  );
  const healthy = (at: string): boolean => at >= HEALTHY_FROM && at <= HEALTHY_TO;
  const group = <T,>(rows: T[], key: (row: T) => string): [string, number][] => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log('');
  console.log('CANCELLATIONS');
  for (const [label, scope] of [
    ['all time', (_: string) => true],
    [`healthy window ${HEALTHY_FROM.slice(0, 16)}..${HEALTHY_TO.slice(0, 16)}`, healthy],
  ] as const) {
    const scopedItems = items.filter((row) => scope(row.created_at));
    const cancelledItems = scopedItems.filter((row) => row.state === 'CANCELLED');
    const scopedPackets = packets.filter((row) => scope(row.created_at));
    const cancelledPackets = scopedPackets.filter((row) => row.status === 'CANCELLED');
    console.log(
      `  ${label}: work items ${cancelledItems.length}/${scopedItems.length} cancelled,` +
        ` packets ${cancelledPackets.length}/${scopedPackets.length} cancelled`,
    );
    for (const [reason, n] of group(cancelledItems, (row) => `${row.work_type} · ${reasonKey(row.cancelled_reason)}`).slice(0, 12)) {
      console.log(`    item   ${String(n).padStart(4)} × ${reason}`);
    }
    for (const [reason, n] of group(cancelledPackets, (row) => reasonKey(row.failure_reason)).slice(0, 10)) {
      console.log(`    packet ${String(n).padStart(4)} × ${reason}`);
    }
  }
}

/**
 * What every round of one opening's deep dive actually produced, at the gate.
 *
 * The timings above say where the time went; this says what came of it, which
 * is the half *why does nothing qualify* turns on. Per round: the packet, why
 * it stopped, and per fragment the gate's two verdicts, the claims accepted by
 * lane, the rejections grouped by reason, and what the verification pass
 * itself said about sufficiency. Then the card: which tier the opening reads
 * and what it still needs. Read-only, like the rest of this file.
 */
async function printGateOutcome(one: CashOpportunity): Promise<void> {
  const started = await cashEventsOfKind(one.id, 'CASH_VALIDATION_STARTED');
  const packets: { round: unknown; candidateId: string; orchestrationId: string | null; mission: string; reason: string | null }[] = [];
  for (const event of started) {
    const candidateId = event.detail['candidateId'];
    if (typeof candidateId !== 'string') continue;
    const candidate = await getCandidate(candidateId);
    const missions = await missionsForCandidate(candidateId);
    if (missions.length === 0) {
      packets.push({
        round: event.detail['round'],
        candidateId,
        orchestrationId: null,
        mission: '—',
        reason: candidate?.reason ?? null,
      });
    }
    for (const mission of missions) {
      packets.push({
        round: event.detail['round'],
        candidateId,
        orchestrationId: mission.orchestrationId,
        mission: `${mission.id} ${mission.state}`,
        reason: mission.terminalReason ?? candidate?.reason ?? null,
      });
    }
  }
  for (const entry of packets) {
    const packet = entry.orchestrationId ? await getOrchestration(entry.orchestrationId) : null;
    console.log(
      `      gate r${String(entry.round ?? '?')}  ${entry.candidateId}  mission ${entry.mission}` +
        `  packet ${entry.orchestrationId ?? '—'} ${packet?.status ?? ''}`,
    );
    const why = packet?.failureReason ?? entry.reason;
    if (why) console.log(`        stopped   ${why.replace(/\s+/g, ' ').slice(0, 220)}`);
    if (!entry.orchestrationId) continue;
    const passes = await listPasses(entry.orchestrationId);
    for (const fragment of await listFragments(entry.orchestrationId)) {
      const claims = await listClaimsForFragment(fragment.id);
      const accepted = claims.filter((claim) => claim.accepted);
      const lanes = new Map<string, number>();
      for (const claim of accepted) {
        const key = claim.evidenceLane ?? '(untagged)';
        lanes.set(key, (lanes.get(key) ?? 0) + 1);
      }
      const refused = new Map<string, number>();
      for (const claim of claims) {
        if (claim.accepted || !claim.rejectionReason) continue;
        const key = claim.rejectionReason.replace(/\s+/g, ' ').slice(0, 90);
        refused.set(key, (refused.get(key) ?? 0) + 1);
      }
      const unread = claims.filter((claim) => claim.retrievalState !== 'RETRIEVED').length;
      console.log(
        `        fragment  ${fragment.fragmentKey} a${fragment.attempt} ${fragment.status}` +
          `  integrity ${fragment.integrityVerdict ?? '—'} sufficiency ${fragment.sufficiencyVerdict ?? '—'}` +
          `  claims ${claims.length} accepted ${accepted.length} unread ${unread}`,
      );
      if (lanes.size > 0) {
        console.log(`          lanes   ${[...lanes.entries()].map(([k, n]) => `${k}×${n}`).join(' ')}`);
      }
      // The two lanes whose claim *type* decides what the answer means: a
      // documented absence of a disqualifier, or one found; a route, or none.
      for (const claim of accepted) {
        if (!['disqualifier', 'ruled_out', 'contact_mode'].includes(claim.evidenceLane ?? '')) continue;
        console.log(
          `          ${(claim.evidenceLane ?? '').padEnd(12)} ${claim.claimType.padEnd(18)} ` +
            claim.claim.replace(/\s+/g, ' ').slice(0, 120),
        );
      }
      for (const [reason, n] of [...refused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        console.log(`          refused ${n} × ${reason}`);
      }
      const verify = passes.filter(
        (pass) => pass.fragmentId === fragment.id && pass.passKey === 'VERIFICATION' && pass.parsed,
      );
      const last = verify[verify.length - 1];
      if (last) {
        const parsed = last.parsed as Record<string, unknown>;
        const raw = (parsed['raw'] ?? parsed) as Record<string, unknown>;
        const missing = Array.isArray(raw['missingLanes']) ? (raw['missingLanes'] as unknown[]).join(',') : '';
        console.log(
          `          verify  ${String(raw['sufficiency'] ?? parsed['sufficiency'] ?? '—')}` +
            (missing ? `  missing ${missing.slice(0, 160)}` : ''),
        );
      }
      if (fragment.blockedReason) {
        console.log(`          blocked ${fragment.blockedReason.replace(/\s+/g, ' ').slice(0, 260)}`);
      }
    }
  }
  const facts = await cardFactsFor(one.id);
  const card = cashEngineCard({ opportunity: one, facts });
  const tier = cashTier({ opportunity: one, card, readiness: evidenceCard(one).readiness });
  console.log(
    `      card      tier ${tier.tier} answered ${tier.answered}/${tier.required}` +
      `  facts ${facts.length}  to advance ${tier.toAdvance.map((item) => item.key).join(',') || '—'}`,
  );
}

/**
 * Who holds the research grant's mission slots, row by row.
 *
 * `researchMissionSlotsFull` answers yes or no, and a dive that waits on it
 * waits on whatever that count is made of — so "the slots are full" is only a
 * diagnosis once each live hold is named with the mission, the idea, the packet
 * and the bin behind it. Read-only, and the arithmetic is `spendTotals`' own
 * predicate (`HELD` and unexpired), so the list adds up to the number the gate
 * compares.
 */
async function researchConcurrency(projectId: string): Promise<void> {
  const authority = await checkAuthority({ projectId, workClass: RESEARCH_WORK_CLASS });
  console.log('');
  console.log('RESEARCH CONCURRENCY');
  if (!authority.ok || !authority.goal) {
    console.log('  no live research grant governs this project');
    return;
  }
  const goal = authority.goal;
  const now = new Date().toISOString();
  const totals = await spendTotals(goal.id, 'MISSION', now);
  console.log(
    `  grant       ${goal.id}  maxConcurrent=${goal.maxConcurrent}  live=${totals.live}  ` +
      `full=${totals.live >= goal.maxConcurrent ? 'yes' : 'no'}`,
  );
  const holders = await getDb().all<{
    reservation_id: string;
    created_at: string;
    expires_at: string;
    mission_id: string | null;
    mission_state: string | null;
    mission_updated: string | null;
    waiting_on: string | null;
    candidate_id: string | null;
    candidate_title: string | null;
    orchestration_id: string | null;
    packet_status: string | null;
    packet_pass: string | null;
    packet_updated: string | null;
    failure_reason: string | null;
    bin_id: string | null;
  }>(
    `SELECT r.id AS reservation_id, r.created_at, r.expires_at,
            m.id AS mission_id, m.state AS mission_state, m.updated_at AS mission_updated,
            m.waiting_on, m.candidate_id, c.title AS candidate_title,
            m.orchestration_id, o.status AS packet_status, o.current_pass AS packet_pass,
            o.updated_at AS packet_updated, o.failure_reason, m.bin_id
       FROM russell_budget_reservations r
       LEFT JOIN russell_missions m ON m.reservation_id = r.id
       LEFT JOIN russell_candidates c ON c.id = m.candidate_id
       LEFT JOIN research_orchestrations o ON o.id = m.orchestration_id
      WHERE r.goal_id = ? AND r.kind = 'MISSION' AND r.state = 'HELD' AND r.expires_at > ?
      ORDER BY r.created_at`,
    [goal.id, now],
  );
  for (const row of holders) {
    const bin = row.bin_id ? await getBin(row.bin_id) : null;
    const passes = row.orchestration_id ? await listPasses(row.orchestration_id) : [];
    const lastPass = passes
      .map((pass) => pass.completedAt ?? pass.startedAt ?? null)
      .filter((at): at is string => !!at)
      .sort()
      .at(-1);
    console.log(
      `  HOLDER  ${row.reservation_id}  reserved ${stamp(row.created_at)}  expires ${stamp(row.expires_at)}`,
    );
    console.log(
      `      mission   ${row.mission_id ?? '— (no mission names this reservation)'} ` +
        `${row.mission_state ?? ''}  updated ${stamp(row.mission_updated)}`,
    );
    console.log(`      idea      ${row.candidate_id ?? '—'}  ${(row.candidate_title ?? '').slice(0, 90)}`);
    console.log(
      `      packet    ${row.orchestration_id ?? '—'}  ${row.packet_status ?? ''} pass ${row.packet_pass ?? '—'}  ` +
        `updated ${stamp(row.packet_updated)}  last pass ${stamp(lastPass)}`,
    );
    if (row.packet_status === 'NEEDS_HUMAN' || row.failure_reason) {
      console.log(`      reason    ${(row.failure_reason ?? row.waiting_on ?? '').slice(0, 160)}`);
    }
    console.log(
      `      bin       ${bin ? `${bin.id} ${bin.state} attempts ${bin.attemptCount}/${bin.maxAttempts}` : '—'}`,
    );
  }
  const unheld = await getDb().all<{ state: string; packet: string | null; n: number }>(
    `SELECT m.state, o.status AS packet, COUNT(*) AS n
       FROM russell_missions m
       LEFT JOIN russell_budget_reservations r ON r.id = m.reservation_id
       LEFT JOIN research_orchestrations o ON o.id = m.orchestration_id
      WHERE m.project_id = ? AND m.state IN ('PLANNED','LAUNCHING','RUNNING','WAITING','NEEDS_HUMAN')
        AND NOT (r.state = 'HELD' AND r.expires_at > ?)
      GROUP BY m.state, o.status
      ORDER BY m.state, o.status`,
    [projectId, now],
  );
  for (const row of unheld) {
    console.log(`  not holding  mission=${row.state} packet=${row.packet ?? '—'}  ${Number(row.n)}`);
  }
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
