/**
 * Production probe for COM-13-3: every outreach mechanism is modelled as the
 * full funnel, and messages are not buyers.
 *
 * Reads the outcome rows Brain holds (`cash_outcomes`), builds each project's
 * mechanisms with `mechanismsFromRows` (the one reader the funnel report uses),
 * and checks the clauses against what that produces: permission gates every
 * figure after it, each stage can only narrow the one before it, buyers do not
 * change when the messages sent do, the named ways to reach demand are all
 * considered, and no recorded mechanism is dropped from the comparison. With no
 * mechanism in the rows the answer is a failure — "nothing to look at" is not a
 * demonstration (§39). Written by the quant campaign and adopted into the
 * protected module (§97): probes.ts defines it, and no campaign can change it.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';
import {
  considerOutreachWays,
  mechanismsFromRows,
  modelOutreachFunnel,
  outreachEvidenceFor,
  OUTREACH_WAYS,
  searchOutreachMix,
  type OutreachFigure,
} from '../../../cash/funnel.ts';

export const OUTREACH_FUNNEL_PROBE = 'r01.com-13-3';

const known = (f: OutreachFigure): boolean => f.basis !== 'UNKNOWN' && f.high !== null && f.low !== null;

export async function outreachFunnelHoldsOnRows(): Promise<ProbeResult> {
  const projects = await getDb().all<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM cash_outcomes WHERE kind IN ('CONTACT_RESULT', 'ACCEPTED_PRICE', 'REFUNDED') ORDER BY project_id`,
  );
  let mechanismCount = 0;
  let withBuyers = 0;
  for (const { project_id: projectId } of projects) {
    const mechanisms = await mechanismsFromRows(projectId, await outreachEvidenceFor(projectId));
    mechanismCount += mechanisms.length;
    for (const mechanism of mechanisms) {
      const at = `project ${projectId} mechanism "${mechanism.mode}"`;
      const r = modelOutreachFunnel(mechanism);
      if (r.permitted !== true) {
        for (const f of [r.reachedProspects, r.responders, r.qualified, r.buyers, r.firstPurchaseRevenueCents]) {
          if (f.basis !== 'UNKNOWN') return { ok: false, detail: `${at}: a figure is stated although permission is not established` };
        }
      }
      // Each stage narrows the one before it; a figure that grows down the funnel is a miscount.
      const chain = [r.stages.uniqueProspects, r.reachedProspects, r.responders, r.qualified, r.buyers, r.settledBuyers, r.fulfilledBuyers];
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1]!;
        const b = chain[i]!;
        if (known(a) && known(b) && b.high! > a.high! + 1e-9) return { ok: false, detail: `${at}: funnel stage ${i} exceeds the stage before it` };
      }
      // Messages are effort: scaling them must not move a single buyer or dollar.
      const scaled = modelOutreachFunnel({ ...mechanism, messagesSent: (mechanism.messagesSent ?? 1) * 1000 });
      if (JSON.stringify(scaled.buyers) !== JSON.stringify(r.buyers) || JSON.stringify(scaled.revenueCents) !== JSON.stringify(r.revenueCents)) {
        return { ok: false, detail: `${at}: buyers or revenue moved with the number of messages sent` };
      }
      if (known(r.buyers)) withBuyers += 1;
    }
    const mix = searchOutreachMix(mechanisms);
    if (mix.ranked.length + mix.unranked.length !== mechanisms.length) {
      return { ok: false, detail: `project ${projectId}: the mix dropped a recorded mechanism instead of ranking or listing it` };
    }
    const ways = considerOutreachWays(mechanisms);
    if (OUTREACH_WAYS.some((w) => !ways.some((c) => c.key === w.key))) {
      return { ok: false, detail: `project ${projectId}: a named way to reach demand is not considered` };
    }
  }
  if (mechanismCount === 0) return { ok: false, detail: 'no outreach outcome rows: no mechanism to model on production records' };
  return {
    ok: true,
    detail: `${mechanismCount} mechanism(s) across ${projects.length} project(s) modelled as the full funnel from rows; ${withBuyers} with a stated buyer count, the rest unknown at a named stage; messages sent moved no figure`,
  };
}

