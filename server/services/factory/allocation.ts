/** Build's account allocation: a replayable routing preview and observed activity. */
import { getDb } from '../../db/database.ts';
import type { AllowanceReport } from '../../repos/allowance.ts';
import { listRepositoryGrants } from './repositoryEnvelope.ts';
import { factoryProbeWork, repositoryIdOfRemote } from './onboard.ts';
import { fleetSnapshot, type FleetSnapshot } from '../dispatch/candidates.ts';
import { freshAllowancePercent, routeBin } from '../dispatch/router.ts';

export interface FactoryAllocation {
  windowHours: 24;
  reportExpiresAfterHours: 6;
  canReport: boolean;
  repositories: {
    grantId: string;
    remote: string;
    nextAccountId: string | null;
    explanation: string;
    accounts: {
      id: string;
      name: string;
      remainingPercent: number | null;
      reportedAt: string | null;
      reportFresh: boolean;
      fires: number;
      arrivals: number;
      providerRefusals: number;
    }[];
  }[];
}

interface CountRow { account_id: string; n: number }

/** Read only: no probe fire or credential is needed to test a routing choice. */
export async function factoryAllocation(input: {
  projectId: string;
  canReport: boolean;
  now?: Date;
  snapshot?: FleetSnapshot;
}): Promise<FactoryAllocation> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
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
    getDb().all<CountRow>(
      `SELECT s.account_id, COUNT(*) AS n
         FROM worker_sessions s JOIN bins b ON b.id = s.bin_id
        WHERE b.project_id = ? AND b.kind LIKE 'FACTORY%' AND s.observed_at >= ?
        GROUP BY s.account_id`,
      [input.projectId, since],
    ),
  ]);
  const reports = new Map(snapshot.candidates
    .filter((candidate) => candidate.allowanceReport !== null && candidate.allowanceReport !== undefined)
    .map((candidate) => [candidate.account.id, candidate.allowanceReport!]));
  const counts = new Map<string, { fires: number; arrivals: number; providerRefusals: number }>();
  const countFor = (id: string) => {
    let count = counts.get(id);
    if (!count) { count = { fires: 0, arrivals: 0, providerRefusals: 0 }; counts.set(id, count); }
    return count;
  };
  for (const row of activity) {
    const count = countFor(row.account_id);
    if (row.event_type === 'DISPATCH_SENT') count.fires = Number(row.n);
    else count.providerRefusals = Number(row.n);
  }
  for (const row of arrivals) countFor(row.account_id).arrivals = Number(row.n);

  return {
    windowHours: 24,
    reportExpiresAfterHours: 6,
    canReport: input.canReport,
    repositories: listRepositoryGrants().map((grant) => {
      const work = factoryProbeWork(input.projectId, grant.remote);
      const repositoryId = repositoryIdOfRemote(grant.remote);
      // Only rows configured for this project's repository and Factory work
      // appear on this card. A research connection is never a Factory account.
      const candidates = snapshot.candidates.filter((candidate) =>
        candidate.account.kind === 'CAPACITY' &&
        candidate.servesProjects.includes(input.projectId) &&
        (candidate.servesFamilies === null || candidate.servesFamilies.includes('FACTORY')) &&
        (candidate.servesRepositories === null ||
          (repositoryId !== null && candidate.servesRepositories.includes(repositoryId))) &&
        ['repository', 'repository-write'].every((cap) => candidate.routine.capabilities.includes(cap)),
      );
      const decision = routeBin({
        bin: work,
        candidates: snapshot.candidates,
        fleetPolicy: snapshot.fleetPolicy,
        fleetInFlight: snapshot.fleetInFlight,
        now: nowIso,
      });
      const accounts = new Map<string, typeof candidates[number]['account']>();
      for (const candidate of candidates) accounts.set(candidate.account.id, candidate.account);
      return {
        grantId: grant.id,
        remote: grant.remote,
        nextAccountId: decision.ok ? decision.account.id : null,
        explanation: decision.reason,
        accounts: [...accounts.values()].map((account) => {
          const report: AllowanceReport | undefined = reports.get(account.id);
          return {
            id: account.id,
            name: account.name,
            remainingPercent: report?.remainingPercent ?? null,
            reportedAt: report?.reportedAt ?? null,
            reportFresh: freshAllowancePercent(report, nowIso) !== null,
            ...countFor(account.id),
          };
        }),
      };
    }),
  };
}
