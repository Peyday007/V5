/**
 * Production probe for COM-13-5: regulated roles are assessed by rights and
 * obligations, never excluded by category.
 *
 * Reads the rows Brain holds (capital_structures, opportunity_constraints) and
 * assesses each opening's role with `assessOpportunityRole`, the single reader
 * a figure's economics pass through. It passes only when real rows show the
 * behaviour: at least one opening performs a regulated activity, none of them
 * is excluded by category, and economics are counted only where a compliant
 * position (its own, or an authorized licensed partner's) is established. With
 * no regulated role in the rows the answer is a failure — "nothing to look at"
 * is not a demonstration (§39) — never a pass.
 */
import { getDb } from '../../db/database.ts';
import { registerProbe, type ProbeResult } from '../factory/program/probes.ts';
import { assessOpportunityRole, type RoleAssessment } from './exclusions.ts';

export const REGULATED_ROLE_PROBE = 'r01.com-13-5';

export async function regulatedRolesAssessedFromRows(): Promise<ProbeResult> {
  const openings = await getDb().all<{ project_id: string; opportunity_id: string }>(
    `SELECT DISTINCT project_id, opportunity_id FROM capital_structures ORDER BY project_id, opportunity_id`,
  );
  if (openings.length === 0) return { ok: false, detail: 'no capital_structures rows: no role to assess on production records' };
  const regulated: Array<{ id: string; assessment: RoleAssessment }> = [];
  for (const o of openings) {
    const assessment = await assessOpportunityRole({ projectId: o.project_id, opportunityId: o.opportunity_id });
    if (assessment.excluded !== false) return { ok: false, detail: `opening ${o.opportunity_id} was excluded by category` };
    const compliant = assessment.position === 'COMPLIANT' || assessment.position === 'COMPLIANT_VIA_PARTNER';
    if (assessment.countEconomics !== compliant) {
      return { ok: false, detail: `opening ${o.opportunity_id}: economics counted=${assessment.countEconomics} with position ${assessment.position}` };
    }
    if (assessment.regulated) regulated.push({ id: o.opportunity_id, assessment });
  }
  if (regulated.length === 0) return { ok: false, detail: `${openings.length} opening(s) read; none performs a regulated activity, so the behaviour is not yet demonstrated` };
  const by = (p: RoleAssessment['position']): number => regulated.filter((r) => r.assessment.position === p).length;
  return {
    ok: true,
    detail: `${regulated.length} of ${openings.length} opening(s) are regulated roles, all assessed and none excluded: ${by('COMPLIANT')} compliant, ${by('COMPLIANT_VIA_PARTNER')} via partner, ${by('NEEDS_POSITION')} needing a position (economics held back), ${by('UNKNOWN')} unknown`,
  };
}

registerProbe(REGULATED_ROLE_PROBE, regulatedRolesAssessedFromRows);
