/** Person-reported subscription balance, kept apart from measured dispatch use. */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { FleetAllowanceReportRow } from '../domain/types.ts';
import { recordIdentityEvent } from './identity.ts';

export interface AllowanceReport {
  accountId: string;
  remainingPercent: number;
  reportedAt: string;
}

function mapReport(row: FleetAllowanceReportRow): AllowanceReport {
  return {
    accountId: row.account_id,
    remainingPercent: Number(row.remaining_percent),
    reportedAt: row.reported_at,
  };
}

/** The newest report per account; older reports remain available for audit. */
export async function latestAllowanceReports(): Promise<Map<string, AllowanceReport>> {
  const rows = await getDb().all<FleetAllowanceReportRow>(
    `SELECT r.*
       FROM fleet_allowance_reports r
      WHERE r.id = (SELECT next.id FROM fleet_allowance_reports next
                     WHERE next.account_id = r.account_id
                     ORDER BY next.reported_at DESC, next.rowid DESC LIMIT 1)`,
  );
  return new Map(rows.map((row) => [row.account_id, mapReport(row)]));
}

export async function recordAllowanceReport(input: {
  accountId: string;
  remainingPercent: number;
  reportedBy: string;
  projectId: string;
}): Promise<AllowanceReport> {
  if (!Number.isInteger(input.remainingPercent) || input.remainingPercent < 0 || input.remainingPercent > 100) {
    throw new RangeError('Remaining allowance must be an integer from 0 to 100.');
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
      actorType: 'HUMAN', actorId: input.reportedBy,
      action: 'REPORT_FLEET_ALLOWANCE', targetType: 'FLEET_ACCOUNT', targetId: input.accountId,
      projectId: input.projectId, result: 'SUCCESS',
      metadata: { source: 'PERSON_REPORTED', remainingPercent: input.remainingPercent, reportedAt },
    });
  });
  return { accountId: input.accountId, remainingPercent: input.remainingPercent, reportedAt };
}
