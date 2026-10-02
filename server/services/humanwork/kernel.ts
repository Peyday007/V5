/**
 * The tick's half of human work, fleet-wide and derived from rows.
 *
 * Two things, and neither decides anything a person owns:
 *
 *   1. An engagement a project administrator approved for a team member that
 *      has not reached them yet is put on their Brain page. The answering
 *      transition normally does this in the same breath as the approval; this
 *      reaches one whose tick died halfway.
 *
 *   2. A no-charge engagement whose every acceptance condition is read by
 *      Brain from rows — nothing a person's review could add — and reads MET
 *      right now is recorded as accepted, by BRAIN. Anything that costs money,
 *      or has a condition a person judges, waits for a person.
 *
 * It also records, once per milestone, that a due date passed, so follow-up is
 * on the record rather than in somebody's memory.
 */
import { listEngagements, listHumanWorkEvents, listOpenOrders, recordHumanWorkEvent } from '../../repos/humanWork.ts';
import { deliverApprovedInBrain } from './engage.ts';
import { acceptResult, evaluateAcceptance } from './deliver.ts';

export interface HumanWorkTickReport {
  delivered: string[];
  accepted: string[];
  overdue: string[];
}

export async function runHumanWorkTick(options: { now?: string; limit?: number } = {}): Promise<HumanWorkTickReport> {
  const now = options.now ?? new Date().toISOString();
  const report: HumanWorkTickReport = { delivered: [], accepted: [], overdue: [] };
  for (const order of await listOpenOrders(options.limit ?? 200)) {
    const engagement = (await listEngagements(order.id)).find((one) => ['APPROVED', 'ENGAGED'].includes(one.state));
    if (!engagement) continue;

    if (engagement.state === 'APPROVED' && engagement.assigneeUserId) {
      if (await deliverApprovedInBrain(engagement)) report.delivered.push(engagement.id);
      continue;
    }

    // ENGAGED
    const brainRead = order.acceptance.every((one) => one.check !== 'PERSON_REVIEW');
    if (brainRead && engagement.compensationCents === 0) {
      const readings = await evaluateAcceptance(order, engagement);
      if (readings.length && readings.every((one) => one.verdict === 'MET')) {
        const accepted = await acceptResult({ orderId: order.id, actor: 'BRAIN', userId: null, note: 'every condition read MET from rows' });
        if (accepted.ok) report.accepted.push(order.id);
        continue;
      }
    }

    const events = await listHumanWorkEvents(order.id);
    for (const item of engagement.terms.schedule ?? []) {
      if (!item.due || item.due >= now.slice(0, item.due.length)) continue;
      const already = events.some(
        (event) => event.kind === 'DEADLINE_PASSED' && event.engagementId === engagement.id && event.detail['milestone'] === item.milestone,
      );
      if (already) continue;
      await recordHumanWorkEvent({
        projectId: order.projectId,
        orderId: order.id,
        engagementId: engagement.id,
        kind: 'DEADLINE_PASSED',
        summary: `"${item.milestone}" was due ${item.due} and the result has not been accepted.`,
        detail: { milestone: item.milestone, due: item.due },
        actor: 'BRAIN',
      });
      report.overdue.push(`${engagement.id}:${item.milestone}`);
    }
  }
  return report;
}
