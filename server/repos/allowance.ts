/**
 * Person-reported subscription allowance, kept apart from measured dispatch use.
 *
 * A row here says "somebody looked at this account's Claude usage screen and it
 * read N% remaining, at this instant". It is append-only, so a routing decision
 * can be explained afterwards from the reading that was current when it was
 * made, and nothing in Brain writes one except a person through Build.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { AllowanceReport, FleetAllowanceReportRow } from '../domain/types.ts';
import { recordIdentityEvent } from './identity.ts';

export type { AllowanceReport } from '../domain/types.ts';

function mapReport(row: FleetAllowanceReportRow): AllowanceReport {
  return {
    accountId: row.account_id,
    remainingPercent: Number(row.remaining_percent),
    reportedAt: row.reported_at,
  };
}

/** The newest report per account; older reports remain for the audit. */
export async function latestAllowanceReports(): Promise<Map<string, AllowanceReport>> {
  // `rowid` is rewritten to `seq` on Postgres; the pg table declares it.
  const rows = await getDb().all<FleetAllowanceReportRow>(
    `SELECT r.id, r.account_id, r.remaining_percent, r.reported_at, r.reported_by
       FROM fleet_allowance_reports r
      WHERE r.id = (SELECT newest.id FROM fleet_allowance_reports newest
                     WHERE newest.account_id = r.account_id
                     ORDER BY newest.reported_at DESC, newest.rowid DESC LIMIT 1)`,
  );
  return new Map(rows.map((row) => [row.account_id, mapReport(row)]));
}

export async function recordAllowanceReport(input: {
  accountId: string;
  remainingPercent: number;
  reportedBy: string;
  projectId: string;
}): Promise<AllowanceReport> {
  if (
    !Number.isInteger(input.remainingPercent) ||
    input.remainingPercent < 0 ||
    input.remainingPercent > 100
  ) {
    throw new RangeError('Remaining allowance must be a whole number from 0 to 100.');
  }
  const reportedAt = nowIso();
  await getDb().transaction(async () => {
    await getDb().run(
      `INSERT INTO fleet_allowance_reports
         (id, account_id, remaining_percent, reported_at, reported_by)
       VALUES (?, ?, ?, ?, ?)`,
      [newId('allw'), input.accountId, input.remainingPercent, reportedAt, input.reportedBy],
    );
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: input.reportedBy,
      action: 'REPORT_FLEET_ALLOWANCE',
      targetType: 'FLEET_ACCOUNT',
      targetId: input.accountId,
      projectId: input.projectId,
      result: 'SUCCESS',
      metadata: { source: 'PERSON_REPORTED', remainingPercent: input.remainingPercent, reportedAt },
    });
  });
  return { accountId: input.accountId, remainingPercent: input.remainingPercent, reportedAt };
}
