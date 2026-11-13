/**
 * Production probe for COM-13-5: regulated roles are assessed by rights and
 * obligations, never excluded by category.
 *
 * Reads the rows Brain holds (cash_opportunities, capital_structures,
 * opportunity_constraints) and assesses each opening's role through the same
 * reader `assessOpportunityRole` uses, the single reader a figure's economics
 * pass through. It passes only when real rows show the
 * behaviour: at least one opening performs a regulated activity, none of them
 * is excluded by category, and economics are counted only where a compliant
 * position (its own, or an authorized licensed partner's) is established. With
 * no regulated role in the rows the answer is a failure — "nothing to look at"
 * is not a demonstration (§39) — never a pass.
 */
import { getDb } from '../../db/database.ts';
import { listCapitalForProject, listConstraintsForProject } from '../../repos/industry.ts';
import { registerProbe, type ProbeResult } from '../factory/program/probes.ts';
import { assessRole, OPENING_ROLE_COLUMNS, openingRoleText, ownerStatementsFor, roleRecordWithStatements, type OpeningRoleRow, type RoleAssessment } from './exclusions.ts';

export const REGULATED_ROLE_PROBE = 'r01.com-13-5';

/*
 * Openings are enumerated from cash_opportunities, where production records every one, unioned with any
 * opening a capital_structures or opportunity_constraints row names. Reading capital_structures alone
 * (2026-11-10) saw nothing on production: those rows exist only for openings a research claim declared a
 * capital requirement for, so every real opening was invisible to the assessment. Each one is assessed
 * through the same reader assessOpportunityRole uses (roleRecordFromRows + assessRole), with its project's
 * rows loaded once.
 */
export async function regulatedRolesAssessedFromRows(): Promise<ProbeResult> {
  const db = getDb();
  const openings = await db.all<{ project_id: string; opportunity_id: string }>(
    `SELECT project_id, id AS opportunity_id FROM cash_opportunities
     UNION
     SELECT project_id, opportunity_id FROM capital_structures
     UNION
     SELECT project_id, opportunity_id FROM opportunity_constraints WHERE opportunity_id IS NOT NULL
     ORDER BY project_id, opportunity_id`,
  );
  if (openings.length === 0) return { ok: false, detail: 'no openings in cash_opportunities, capital_structures or opportunity_constraints: no role to assess on production records' };
  const byProject = new Map<string, string[]>();
  for (const o of openings) byProject.set(o.project_id, [...(byProject.get(o.project_id) ?? []), o.opportunity_id]);
  const regulated: Array<{ id: string; assessment: RoleAssessment }> = [];
  for (const [projectId, ids] of byProject) {
    const [rows, capital, constraints, statements] = await Promise.all([
      db.all<OpeningRoleRow>(`SELECT ${OPENING_ROLE_COLUMNS} FROM cash_opportunities WHERE project_id = ?`, [projectId]),
      listCapitalForProject(projectId),
      listConstraintsForProject(projectId),
      ownerStatementsFor(projectId),
    ]);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = rowById.get(id);
      const assessment = assessRole(
        roleRecordWithStatements(
          capital.filter((c) => c.opportunityId === id),
          constraints.filter((c) => c.opportunityId === id),
          row ? openingRoleText(row) : null,
          statements,
        ),
      );
      if (assessment.excluded !== false) return { ok: false, detail: `opening ${id} was excluded by category` };
      const compliant = assessment.position === 'COMPLIANT' || assessment.position === 'COMPLIANT_VIA_PARTNER';
      if (assessment.countEconomics !== compliant) {
        return { ok: false, detail: `opening ${id}: economics counted=${assessment.countEconomics} with position ${assessment.position}` };
      }
      if (assessment.regulated) regulated.push({ id, assessment });
    }
  }
  if (regulated.length === 0) return { ok: false, detail: `${openings.length} opening(s) read; none performs a regulated activity, so the behaviour is not yet demonstrated` };
  const by = (p: RoleAssessment['position']): number => regulated.filter((r) => r.assessment.position === p).length;
  return {
    ok: true,
    detail: `${regulated.length} of ${openings.length} opening(s) are regulated roles, all assessed and none excluded: ${by('COMPLIANT')} compliant, ${by('COMPLIANT_VIA_PARTNER')} via partner, ${by('NEEDS_POSITION')} needing a position (economics held back), ${by('UNKNOWN')} unknown`,
  };
}

registerProbe(REGULATED_ROLE_PROBE, regulatedRolesAssessedFromRows);
