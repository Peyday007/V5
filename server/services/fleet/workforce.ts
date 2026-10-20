/**
 * The workforce: each Claude account Brain runs on, as one card.
 *
 * The Fleet reading answers *how much power is there*; this answers the
 * question an owner asks about a team — *what is each account doing, what has
 * it finished, and is any of them sitting idle while work waits?* It adds no
 * mechanism. Every figure is a count of rows the dispatcher, the bins and the
 * research passes already write, over the last 24 hours, and every judgement
 * (can this surface be fired, does it serve this bin) is the router's own
 * function asked again, so the card and the dispatcher cannot disagree.
 *
 * **Attribution is from proof or it is absent.** A bin event names the worker
 * that held the lease, and one worker identity can be shared by several
 * accounts (the Factory worker is). So a lease is attributed to the account
 * whose Routine Brain fired for it — the `bin_dispatch` row at the generation
 * before the lease — and, failing that, to the one account the worker is bound
 * in. A lease that resolves to neither is counted as unattributed rather than
 * guessed onto somebody.
 *
 * **Titles cross a privacy boundary and are treated that way.** A card may show
 * a bin held in a project the reader cannot read; it then says *work in another
 * project* and names nothing, so a count crosses and a subject does not.
 */
import { getDb } from '../../db/database.ts';
import { listAccounts, listRoutines } from '../../repos/fleet.ts';
import { listDispatchableBins } from '../../repos/bins.ts';
import { fleetSnapshot, inFlightByRoutine } from '../dispatch/candidates.ts';
import { binScopeRefusal } from '../dispatch/router.ts';
import { usability } from './view.ts';
import type { Bin, FleetAccount, FleetRoutine } from '../../domain/types.ts';

export const WORKFORCE_WINDOW_MS = 24 * 60 * 60_000;

/** One word for where an account stands, chosen from rows rather than said. */
export type WorkforceStatus =
  | 'WORKING'
  | 'READY'
  | 'IDLE_WITH_WORK'
  | 'HELD'
  | 'NOT_CONNECTED';

export interface WorkforceJob {
  binId: string | null;
  /** The bin's title, or null when it is in a project the reader cannot read. */
  title: string | null;
  routineName: string | null;
  since: string | null;
}

export interface WorkforceAccount {
  accountId: string;
  name: string;
  status: WorkforceStatus;
  /** One sentence a person reads, composed here so every surface says the same. */
  statusSentence: string;
  routines: { total: number; usable: number; held: number };
  /** Why the held Routines are held, in plain words, deduplicated. */
  heldReasons: string[];
  capacity: { inFlight: number; limit: number | null };
  current: WorkforceJob[];
  last24h: {
    started: number;
    arrived: number;
    assigned: number;
    completed: number;
    handedBack: number;
    failed: number;
    /** Research passes this account's sessions completed: claims, verifications, syntheses, audits. */
    researchPasses: number;
  };
  lastWorkAt: string | null;
  nextQueued: WorkforceJob | null;
}

export interface WorkforceView {
  accounts: WorkforceAccount[];
  queue: { ready: number; leased: number };
  totals: {
    connected: number;
    working: number;
    idleWithWork: number;
    completed24h: number;
    researchPasses24h: number;
    unattributed24h: number;
  };
  /** The most recent hand-overs, newest first: how work moved between accounts. */
  movement: { at: string; accountName: string | null; title: string | null; event: string }[];
  windowHours: number;
  readAt: string;
}

interface EventRow {
  event_type: string;
  at: string;
  bin_id: string | null;
  project_id: string | null;
  worker_id: string | null;
  routine_id: string | null;
  account_id: string | null;
  outcome: string | null;
  dispatch_routine_id: string | null;
}

const ATTRIBUTED_EVENTS = [
  'DISPATCH_SENT',
  'DISPATCH_SESSION_ARRIVED',
  'BIN_ASSIGNED',
  'BIN_TAKEOVER',
  'BIN_TERMINAL',
  'BIN_RELEASED',
] as const;

const EVENT_WORDS: Record<string, string> = {
  BIN_ASSIGNED: 'took',
  BIN_TAKEOVER: 'took over',
  BIN_TERMINAL: 'finished',
  BIN_RELEASED: 'handed back',
};

/**
 * The workforce, read for one reader.
 *
 * `mayRead(projectId)` is the reader's own project access, decided by the
 * caller through the policy module; a title is shown only where it answers yes.
 */
export async function workforceView(input: {
  mayRead: (projectId: string) => boolean;
  now?: string;
}): Promise<WorkforceView> {
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const since = new Date(nowMs - WORKFORCE_WINDOW_MS).toISOString();

  const [accounts, routines, perRoutine, snapshot, queue] = await Promise.all([
    listAccounts(),
    listRoutines(),
    inFlightByRoutine(nowMs),
    fleetSnapshot(new Date(now)),
    listDispatchableBins(60),
  ]);
  const capacityAccounts = accounts.filter((account) => account.kind === 'CAPACITY');
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const routineById = new Map(routines.map((routine) => [routine.id, routine]));
  const candidateById = new Map(snapshot.candidates.map((one) => [one.routine.id, one]));

  // A worker bound in exactly one account resolves to it; a shared one does not.
  const accountsByWorker = new Map<string, Set<string>>();
  for (const routine of routines) {
    if (!routine.workerId || routine.state === 'RETIRED') continue;
    const set = accountsByWorker.get(routine.workerId) ?? new Set<string>();
    set.add(routine.accountId);
    accountsByWorker.set(routine.workerId, set);
  }
  const soleAccount = (workerId: string | null): string | null => {
    if (!workerId) return null;
    const set = accountsByWorker.get(workerId);
    return set && set.size === 1 ? [...set][0]! : null;
  };

  const placeholders = ATTRIBUTED_EVENTS.map(() => '?').join(', ');
  const events = await getDb().all<EventRow>(
    `SELECT e.event_type, e.at, e.bin_id, e.project_id, e.worker_id, e.routine_id, e.account_id,
            e.outcome, d.routine_id AS dispatch_routine_id
       FROM bin_events e
       LEFT JOIN bin_dispatch d
         ON d.bin_id = e.bin_id AND d.lease_generation = e.lease_generation - 1 AND d.state = 'SENT'
      WHERE e.event_type IN (${placeholders}) AND e.at >= ?
      ORDER BY e.at DESC`,
    [...ATTRIBUTED_EVENTS, since],
  );

  const accountOf = (row: EventRow): string | null => {
    if (row.event_type.startsWith('DISPATCH_')) {
      if (row.account_id) return row.account_id;
      return row.routine_id ? routineById.get(row.routine_id)?.accountId ?? null : null;
    }
    if (row.dispatch_routine_id) return routineById.get(row.dispatch_routine_id)?.accountId ?? null;
    return soleAccount(row.worker_id);
  };

  type Tally = WorkforceAccount['last24h'] & { lastWorkAt: string | null };
  const tallies = new Map<string, Tally>();
  const tallyFor = (accountId: string): Tally => {
    let tally = tallies.get(accountId);
    if (!tally) {
      tally = { started: 0, arrived: 0, assigned: 0, completed: 0, handedBack: 0, failed: 0, researchPasses: 0, lastWorkAt: null };
      tallies.set(accountId, tally);
    }
    return tally;
  };
  let unattributed = 0;

  // Bin titles for the events and the movement list, read once.
  const binIds = new Set<string>();
  for (const row of events) if (row.bin_id && !row.event_type.startsWith('DISPATCH_')) binIds.add(row.bin_id);
  const titles = await binTitles([...binIds]);

  const movement: WorkforceView['movement'] = [];
  for (const row of events) {
    const accountId = accountOf(row);
    if (!accountId) {
      if (!row.event_type.startsWith('DISPATCH_')) unattributed += 1;
      continue;
    }
    const tally = tallyFor(accountId);
    switch (row.event_type) {
      case 'DISPATCH_SENT':
        tally.started += 1;
        break;
      case 'DISPATCH_SESSION_ARRIVED':
        tally.arrived += 1;
        break;
      case 'BIN_ASSIGNED':
      case 'BIN_TAKEOVER':
        tally.assigned += 1;
        break;
      case 'BIN_RELEASED':
        tally.handedBack += 1;
        break;
      case 'BIN_TERMINAL':
        if (row.outcome === 'COMPLETE') {
          tally.completed += 1;
          if (!tally.lastWorkAt || row.at > tally.lastWorkAt) tally.lastWorkAt = row.at;
        } else if (row.outcome === 'FAILED' || row.outcome === 'NEEDS_HUMAN') {
          tally.failed += 1;
        }
        break;
    }
    if (EVENT_WORDS[row.event_type] && movement.length < 12 && row.worker_id) {
      const bin = row.bin_id ? titles.get(row.bin_id) : undefined;
      movement.push({
        at: row.at,
        accountName: accountById.get(accountId)?.name ?? null,
        title: bin && input.mayRead(bin.projectId) ? bin.title : null,
        event: EVENT_WORDS[row.event_type]!,
      });
    }
  }

  // Useful output: research passes this account's sessions completed.
  for (const row of await getDb().all<{ account_id: string | null; n: number; last: string | null }>(
    `SELECT executor_account_id AS account_id, COUNT(*) AS n, MAX(completed_at) AS last
       FROM research_passes
      WHERE status = 'COMPLETE' AND completed_at >= ? AND executor_account_id IS NOT NULL
      GROUP BY executor_account_id`,
    [since],
  )) {
    if (!row.account_id) continue;
    const tally = tallyFor(row.account_id);
    tally.researchPasses = Number(row.n);
    if (row.last && (!tally.lastWorkAt || row.last > tally.lastWorkAt)) tally.lastWorkAt = row.last;
  }

  // What each account holds right now: live leases, attributed the same way.
  const leased = await getDb().all<{
    id: string;
    title: string;
    project_id: string;
    worker_id: string | null;
    leased_at: string | null;
    dispatch_routine_id: string | null;
  }>(
    `SELECT b.id, b.title, b.project_id, b.worker_id, b.leased_at, d.routine_id AS dispatch_routine_id
       FROM bins b
       LEFT JOIN bin_dispatch d
         ON d.bin_id = b.id AND d.lease_generation = b.lease_generation - 1 AND d.state = 'SENT'
      WHERE b.state = 'LEASED' AND b.lease_expires_at > ?
      ORDER BY b.leased_at DESC`,
    [now],
  );
  const currentByAccount = new Map<string, WorkforceJob[]>();
  for (const row of leased) {
    const routine = row.dispatch_routine_id ? routineById.get(row.dispatch_routine_id) : undefined;
    const accountId = routine?.accountId ?? soleAccount(row.worker_id);
    if (!accountId) continue;
    const list = currentByAccount.get(accountId) ?? [];
    list.push({
      binId: input.mayRead(row.project_id) ? row.id : null,
      title: input.mayRead(row.project_id) ? row.title : null,
      routineName: routine?.name ?? null,
      since: row.leased_at,
    });
    currentByAccount.set(accountId, list);
  }

  const queueCounts = await getDb().get<{ ready: number; leased: number }>(
    `SELECT SUM(CASE WHEN state = 'READY' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN state = 'LEASED' AND lease_expires_at > ? THEN 1 ELSE 0 END) AS leased
       FROM bins WHERE held_by_workstream_id IS NULL`,
    [now],
  );

  const cards = capacityAccounts.map((account) =>
    accountCard({
      account,
      routines: routines.filter((routine) => routine.accountId === account.id && routine.state !== 'RETIRED'),
      now,
      perRoutine,
      candidateById,
      queue,
      tally: tallies.get(account.id) ?? null,
      current: currentByAccount.get(account.id) ?? [],
      mayRead: input.mayRead,
    }),
  );
  // Working accounts first, then the ones that need attention, then the rest.
  const order: Record<WorkforceStatus, number> = { WORKING: 0, IDLE_WITH_WORK: 1, READY: 2, HELD: 3, NOT_CONNECTED: 4 };
  cards.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));

  return {
    accounts: cards,
    queue: { ready: Number(queueCounts?.ready ?? 0), leased: Number(queueCounts?.leased ?? 0) },
    totals: {
      connected: cards.filter((card) => card.status !== 'NOT_CONNECTED').length,
      working: cards.filter((card) => card.status === 'WORKING').length,
      idleWithWork: cards.filter((card) => card.status === 'IDLE_WITH_WORK').length,
      completed24h: cards.reduce((sum, card) => sum + card.last24h.completed, 0),
      researchPasses24h: cards.reduce((sum, card) => sum + card.last24h.researchPasses, 0),
      unattributed24h: unattributed,
    },
    movement,
    windowHours: WORKFORCE_WINDOW_MS / 3_600_000,
    readAt: now,
  };
}

async function binTitles(ids: string[]): Promise<Map<string, { title: string; projectId: string }>> {
  const out = new Map<string, { title: string; projectId: string }>();
  for (let index = 0; index < ids.length; index += 200) {
    const page = ids.slice(index, index + 200);
    if (page.length === 0) continue;
    const rows = await getDb().all<{ id: string; title: string; project_id: string }>(
      `SELECT id, title, project_id FROM bins WHERE id IN (${page.map(() => '?').join(', ')})`,
      page,
    );
    for (const row of rows) out.set(row.id, { title: row.title, projectId: row.project_id });
  }
  return out;
}

function accountCard(input: {
  account: FleetAccount;
  routines: FleetRoutine[];
  now: string;
  perRoutine: Map<string, number>;
  candidateById: Map<string, Parameters<typeof binScopeRefusal>[0]>;
  queue: Bin[];
  tally: (WorkforceAccount['last24h'] & { lastWorkAt: string | null }) | null;
  current: WorkforceJob[];
  mayRead: (projectId: string) => boolean;
}): WorkforceAccount {
  const { account, routines } = input;
  const usableRoutines: FleetRoutine[] = [];
  const heldReasons = new Set<string>();
  let held = 0;
  for (const routine of routines) {
    const candidate = input.candidateById.get(routine.id) ?? null;
    const reading = usability(routine, account, input.now, { candidate });
    if (reading.usable) usableRoutines.push(routine);
    else {
      held += 1;
      if (reading.reason) heldReasons.add(reading.reason);
    }
  }
  const inFlight = routines.reduce((sum, routine) => sum + (input.perRoutine.get(routine.id) ?? 0), 0);
  const limitCandidate = usableRoutines.map((routine) => input.candidateById.get(routine.id)).find(Boolean);
  const limit = limitCandidate?.accountTarget ?? null;

  // The first queued bin some usable Routine of this account may be fired for.
  let nextQueued: WorkforceJob | null = null;
  for (const bin of input.queue) {
    const able = usableRoutines.some((routine) => {
      const candidate = input.candidateById.get(routine.id);
      return candidate ? binScopeRefusal(candidate, bin) === null : false;
    });
    if (able) {
      nextQueued = {
        binId: input.mayRead(bin.projectId) ? bin.id : null,
        title: input.mayRead(bin.projectId) ? bin.title : null,
        routineName: null,
        since: bin.readyAt,
      };
      break;
    }
  }

  const tally = input.tally ?? {
    started: 0, arrived: 0, assigned: 0, completed: 0, handedBack: 0, failed: 0, researchPasses: 0, lastWorkAt: null,
  };
  const working = input.current.length > 0 || inFlight > 0;
  let status: WorkforceStatus;
  if (routines.length === 0) status = 'NOT_CONNECTED';
  else if (working) status = 'WORKING';
  else if (usableRoutines.length === 0) status = 'HELD';
  else if (nextQueued) status = 'IDLE_WITH_WORK';
  else status = 'READY';

  const sentence: Record<WorkforceStatus, string> = {
    WORKING: `Working: ${input.current.length || inFlight} session${(input.current.length || inFlight) === 1 ? '' : 's'} active now.`,
    READY: 'Connected and ready. Nothing waiting is work it may take.',
    IDLE_WITH_WORK:
      'Idle while work it may take is waiting. Brain will start a session for it on the next dispatch pass unless a limit stops it.',
    HELD: `Not taking work: all ${routines.length} of its Routines are held back.`,
    NOT_CONNECTED: 'No Claude Routine is registered for this account.',
  };

  return {
    accountId: account.id,
    name: account.name,
    status,
    statusSentence: sentence[status],
    routines: { total: routines.length, usable: usableRoutines.length, held },
    heldReasons: [...heldReasons].slice(0, 3),
    capacity: { inFlight, limit },
    current: input.current.slice(0, 5),
    last24h: {
      started: tally.started,
      arrived: tally.arrived,
      assigned: tally.assigned,
      completed: tally.completed,
      handedBack: tally.handedBack,
      failed: tally.failed,
      researchPasses: tally.researchPasses,
    },
    lastWorkAt: tally.lastWorkAt,
    nextQueued,
  };
}
