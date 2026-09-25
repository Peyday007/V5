/**
 * Build's account allocation: which Factory account the dispatcher would fire
 * next, and what each account has actually done.
 *
 * Three kinds of number sit on this card and they must never be read as each
 * other:
 *
 *   * **fires**, **arrivals** and **provider refusals** are measured — rows in
 *     `bin_events` Brain wrote as the thing happened;
 *   * **remaining allowance** is *reported* — a person read it off the account
 *     holder's Claude usage screen and typed it in. Brain cannot see a
 *     subscription balance and never derives one from how often it fired.
 *
 * The preview is `routeBin` itself, over the same `fleetSnapshot` the dispatch
 * tick reads and a `FACTORY_UNITS`-shaped probe bin, so the card and the fire
 * cannot disagree about which account is next. Nothing here fires, claims a
 * slot or writes a row.
 */
import { getDb } from '../../db/database.ts';
import type { AllowanceReport } from '../../domain/types.ts';
import { listRepositoryGrants } from './repositoryEnvelope.ts';
import { factoryProbeWork } from './onboard.ts';
import { fleetSnapshot, type FleetSnapshot } from '../dispatch/candidates.ts';
import {
  ALLOWANCE_REPORT_MAX_AGE_MS,
  freshAllowancePercent,
  routeBin,
  servesBinScope,
} from '../dispatch/router.ts';

const WINDOW_HOURS = 24;

export interface FactoryAllocationAccount {
  id: string;
  name: string;
  /** PERSON-REPORTED, never measured. Null when nobody has reported. */
  remainingPercent: number | null;
  reportedAt: string | null;
  /** Whether the report is recent enough to influence routing. */
  reportFresh: boolean;
  /** Measured: activations Brain sent to this account's Routines in the window. */
  fires: number;
  /** Measured: of those fires, how many bins a session then took. */
  arrivals: number;
  /** Measured: rate-limit refusals the provider returned for this account. */
  providerRefusals: number;
  /** Why the router would not fire this account right now, or null if it could. */
  unavailable: string | null;
}

export interface FactoryAllocation {
  windowHours: number;
  reportExpiresAfterHours: number;
  canReport: boolean;
  repositories: {
    grantId: string;
    remote: string;
    nextAccountId: string | null;
    explanation: string;
    accounts: FactoryAllocationAccount[];
  }[];
}

/** Read only: no probe fire, no slot claim and no credential is needed. */
export async function factoryAllocation(input: {
  projectId: string;
  canReport: boolean;
  now?: Date;
  snapshot?: FleetSnapshot;
}): Promise<FactoryAllocation> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - WINDOW_HOURS * 60 * 60_000).toISOString();
  const [snapshot, activity, arrivals] = await Promise.all([
    input.snapshot ?? fleetSnapshot(now),
    getDb().all<{ account_id: string; event_type: string; n: number }>(
      `SELECT e.account_id, e.event_type, COUNT(*) AS n
         FROM bin_events e
         LEFT JOIN bins b ON b.id = e.bin_id
        WHERE e.project_id = ? AND e.at >= ? AND e.account_id IS NOT NULL
          AND (b.kind LIKE 'FACTORY%' OR e.workload_class LIKE 'FACTORY%')
          AND e.event_type IN ('DISPATCH_SENT', 'PROVIDER_ALLOWANCE')
        GROUP BY e.account_id, e.event_type`,
      [input.projectId, since],
    ),
    /*
     * An arrival is a fire whose bin a session then took: the assignment at the
     * generation after the one the fire named. Read from Brain's own events,
     * never from anything a worker said. `worker_sessions` is not the source —
     * it holds one row per connector credential, first observation winning, so
     * it counts connectors rather than arrivals.
     */
    getDb().all<{ account_id: string; n: number }>(
      `SELECT e.account_id, COUNT(*) AS n
         FROM bin_events e
         JOIN bins b ON b.id = e.bin_id
        WHERE e.project_id = ? AND e.at >= ? AND e.account_id IS NOT NULL
          AND e.event_type = 'DISPATCH_SENT' AND b.kind LIKE 'FACTORY%'
          AND EXISTS (SELECT 1 FROM bin_events a
                       WHERE a.bin_id = e.bin_id AND a.event_type = 'BIN_ASSIGNED'
                         AND a.lease_generation = e.lease_generation + 1)
        GROUP BY e.account_id`,
      [input.projectId, since],
    ),
  ]);

  const counts = new Map<string, { fires: number; arrivals: number; providerRefusals: number }>();
  const countFor = (id: string) => {
    let count = counts.get(id);
    if (!count) {
      count = { fires: 0, arrivals: 0, providerRefusals: 0 };
      counts.set(id, count);
    }
    return count;
  };
  for (const row of activity) {
    const count = countFor(row.account_id);
    if (row.event_type === 'DISPATCH_SENT') count.fires = Number(row.n);
    else count.providerRefusals = Number(row.n);
  }
  for (const row of arrivals) countFor(row.account_id).arrivals = Number(row.n);

  return {
    windowHours: WINDOW_HOURS,
    reportExpiresAfterHours: ALLOWANCE_REPORT_MAX_AGE_MS / 3_600_000,
    canReport: input.canReport,
    repositories: listRepositoryGrants().map((grant) => {
      const work = factoryProbeWork(input.projectId, grant.remote);
      const decision = routeBin({
        bin: work,
        candidates: snapshot.candidates,
        fleetPolicy: snapshot.fleetPolicy,
        fleetInFlight: snapshot.fleetInFlight,
        now: nowIso,
      });
      /*
       * The accounts listed are the ones the router's own scope predicate says
       * could take this work — project, family, repository, capabilities — so
       * the account the preview names is always one the card lists.
       */
      const inScope = snapshot.candidates.filter((candidate) => servesBinScope(candidate, work));
      const verdicts = new Map(decision.considered.map((one) => [one.routineId, one.verdict]));
      const byAccount = new Map<string, {
        name: string;
        report: AllowanceReport | null;
        unavailable: string[];
        anyAvailable: boolean;
      }>();
      for (const candidate of inScope) {
        const entry = byAccount.get(candidate.account.id) ?? {
          name: candidate.account.name,
          report: candidate.allowanceReport ?? null,
          unavailable: [],
          anyAvailable: false,
        };
        const verdict = verdicts.get(candidate.routine.id);
        if (verdict === undefined || verdict === 'selected') entry.anyAvailable = true;
        else entry.unavailable.push(`${candidate.routine.name}: ${verdict}`);
        byAccount.set(candidate.account.id, entry);
      }
      return {
        grantId: grant.id,
        remote: grant.remote,
        nextAccountId: decision.ok ? decision.account.id : null,
        explanation: decision.reason,
        accounts: [...byAccount.entries()].map(([id, entry]) => ({
          id,
          name: entry.name,
          remainingPercent: entry.report?.remainingPercent ?? null,
          reportedAt: entry.report?.reportedAt ?? null,
          reportFresh: freshAllowancePercent(entry.report, nowIso) !== null,
          ...countFor(id),
          unavailable: entry.anyAvailable ? null : entry.unavailable.join('; ') || null,
        })),
      };
    }),
  };
}
