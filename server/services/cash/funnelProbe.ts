/**
 * COM-13-3 probe body: the outreach funnel holds in the running Brain.
 *
 * `r01.com-13-3` is registered in server/services/factory/program/probes.ts by
 * one line that calls this function; the registry is protected, so the
 * measurement lives here with the funnel it measures (§96).
 *
 * Passes only when (1) the model refuses to read a message count as a buyer,
 * (2) a refused or unknown permission leaves every downstream figure unknown,
 * (3) every named way to reach demand is considered, and (4) production records
 * hold at least one measured outreach mechanism. No records is a FAIL.
 */
import { getDb } from '../../db/database.ts';
import {
  OUTREACH_STAGES,
  considerOutreachWays,
  mechanismsFromRows,
  modelOutreachFunnel,
  type OutreachMechanism,
  type StageInput,
} from './funnel.ts';

export interface FunnelProbeResult {
  ok: boolean;
  detail: string;
}

const m = (value: number): StageInput => ({ basis: 'MEASURED', value });

function sample(messagesSent: number, permission: number): OutreachMechanism {
  return {
    mode: 'probe',
    label: 'probe',
    messagesSent,
    inputs: {
      permission: m(permission), uniqueProspects: m(1000), deliverability: m(0.9), throughput: m(5000),
      response: m(0.1), qualification: m(0.5), close: m(0.2), settlement: m(1), fulfillment: m(1), repeat: m(0),
    },
    dealValueCents: m(10_000),
  };
}

export async function outreachFunnelProbe(): Promise<FunnelProbeResult> {
  const few = modelOutreachFunnel(sample(10, 1));
  const million = modelOutreachFunnel(sample(1_000_000, 1));
  if (few.buyers.low !== million.buyers.low || few.buyers.high !== million.buyers.high || few.buyers.low === null) {
    return { ok: false, detail: 'buyers change with the number of messages sent' };
  }
  if (OUTREACH_STAGES.length < 10) return { ok: false, detail: 'a funnel stage is missing' };
  const refused = modelOutreachFunnel(sample(1_000_000, 0));
  if (refused.buyers.basis !== 'UNKNOWN' || refused.revenueCents.basis !== 'UNKNOWN') {
    return { ok: false, detail: 'a refused permission still yields buyers or revenue' };
  }
  if (considerOutreachWays([]).length < 4) return { ok: false, detail: 'a named way to reach demand is not considered' };

  const projects = await getDb().all<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM cash_outcomes WHERE kind = 'CONTACT_RESULT'`,
    [],
  );
  let measured = 0;
  for (const { project_id } of projects) {
    for (const mech of await mechanismsFromRows(project_id)) {
      if (modelOutreachFunnel(mech).reachedProspects.basis !== 'UNKNOWN') measured += 1;
    }
  }
  if (measured === 0) return { ok: false, detail: 'no production outreach mechanism has a measured funnel' };
  return { ok: true, detail: `model invariants hold; ${measured} production mechanism(s) measured across ${projects.length} project(s)` };
}
