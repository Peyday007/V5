/**
 * Finding a compliant position for a role whose economics are held back (S-0106, COM-13-5).
 *
 * "Brain should find compliant positions (including authorized licensed partners) before counting their
 * economics." The role reader (`exclusions.ts`) assesses every opening and holds back the economics of one
 * that is NEEDS_POSITION or UNKNOWN; until this module, the funnel printed that and nothing acted on it.
 *
 * Each pass of the cash tick (`operate.ts`) reads the project's openings through the same reader the funnel
 * and probe r01.com-13-5 use, and for every opening held back — a regulated role without a compliant
 * position, or any opening whose settled cash the funnel is holding back — keeps exactly one cash need
 * (`needs.ts`, keyed per opening, so a loop raises it once) and hands it one research idea through the
 * ordinary capture path (`createCandidate`): find what the activity requires for its product and location,
 * and name authorized licensed partners who can hold it. The archive, the judgment and the standing
 * authority decide what is spent, exactly as for any other captured question. When the record later shows a
 * compliant position, the need is closed by Brain reading the row. Nothing here excludes an opening, counts
 * an economics figure, or relaxes what the reader requires.
 */
import { getDb } from '../../db/database.ts';
import { listCapitalForProject, listConstraintsForProject } from '../../repos/industry.ts';
import { listNeeds, setNeedCandidate } from '../../repos/cashPortfolio.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { assessRole, OPENING_ROLE_COLUMNS, openingRoleText, ownerStatementsFor, roleRecordWithStatements, type OpeningRoleRow, type RoleAssessment, type RolePosition } from './exclusions.ts';
import { closeNeed, raiseNeed } from './needs.ts';

const BRAIN = 'BRAIN';

/** The request key of the need that seeks one opening's compliant position. */
export function positionNeedKey(opportunityId: string): string {
  return `regulated-position:${opportunityId}`;
}

export interface PositionSought {
  opportunityId: string;
  position: RolePosition;
  /** The need that carries the search; null when it could not be raised. */
  needId: string | null;
  /** The research idea started for it this pass, when one was. */
  candidateId: string | null;
  /** Why no need could be raised, when one could not. */
  refused: string | null;
}

export interface PositionPass {
  sought: PositionSought[];
  /** Needs closed because the opening's record now shows a compliant position. */
  settled: string[];
}

function describe(a: RoleAssessment): { performs: string; lacking: string | null; unstated: string | null } {
  return {
    performs: a.activities.length > 0 ? a.activities.map((one) => one.toLowerCase().replace(/_/g, ' ')).join(', ') : 'an activity the reader did not recognise',
    lacking: a.missing.length > 0 ? a.missing.join(', ') : null,
    unstated: a.unknown.length > 0 ? a.unknown.join(', ') : null,
  };
}

/** The research question one held-back opening is sent to answer. Pure; exported for tests. */
export function positionQuestion(opening: { title: string; buyingSignal?: string | null }, a: RoleAssessment): string {
  const { performs, lacking, unstated } = describe(a);
  const signal = (opening.buyingSignal ?? opening.title).replace(/\s+/g, ' ').trim().slice(0, 200);
  return (
    `For this specific opening — "${signal}" — establish from published sources what performing ${performs} ` +
    `requires for this product where its buyers are (licensing, registration, contracts, consumer-protection and ` +
    `advertising rules)${lacking ? `, given that the record says it lacks ${lacking}` : ''}${unstated ? `, and what is true of ${unstated}, which nobody has stated` : ''}; ` +
    'then name authorized licensed partners who hold what it lacks and how such a partner is engaged. ' +
    'Judge the role by what it performs, not by its label.'
  );
}

/**
 * Keep one position search per held-back opening of a project, and close the ones whose opening now has a
 * compliant position. Idempotent: a second pass over an unchanged project raises and starts nothing.
 */
export async function seekCompliantPositions(projectId: string): Promise<PositionPass> {
  const db = getDb();
  const [rows, capital, constraints, statements, settled, open] = await Promise.all([
    db.all<OpeningRoleRow>(`SELECT ${OPENING_ROLE_COLUMNS} FROM cash_opportunities WHERE project_id = ?`, [projectId]),
    listCapitalForProject(projectId),
    listConstraintsForProject(projectId),
    ownerStatementsFor(projectId),
    db.all<{ opportunity_id: string }>(
      `SELECT DISTINCT opportunity_id FROM cash_money_entries WHERE project_id = ? AND kind = 'SETTLEMENT' AND opportunity_id IS NOT NULL`,
      [projectId],
    ),
    listNeeds({ projectId, states: ['OPEN'] }),
  ]);
  const withSettlement = new Set(settled.map((row) => row.opportunity_id));
  const openByKey = new Map(open.filter((need) => need.requestKey).map((need) => [need.requestKey!, need]));
  const pass: PositionPass = { sought: [], settled: [] };

  for (const row of rows) {
    const assessment = assessRole(
      roleRecordWithStatements(
        capital.filter((c) => c.opportunityId === row.id),
        constraints.filter((c) => c.opportunityId === row.id),
        openingRoleText(row),
        statements,
      ),
    );
    const key = positionNeedKey(row.id);
    const existing = openByKey.get(key) ?? null;

    if (assessment.countEconomics) {
      if (existing) {
        const closed = await closeNeed({
          needId: existing.id,
          to: 'RESOLVED',
          resolution: `The opening's record now shows a compliant position (${assessment.position}): ${assessment.reason}`,
          actorUserId: BRAIN,
          verifiedBy: 'BRAIN_READ_THE_ROW',
        });
        if (closed.ok) pass.settled.push(existing.id);
      }
      continue;
    }
    // Held back: a regulated role without a position, or settled cash the funnel will not count.
    if (!assessment.regulated && !withSettlement.has(row.id)) continue;

    let need = existing;
    let refused: string | null = null;
    if (!need) {
      const { performs, lacking, unstated } = describe(assessment);
      const raised = await raiseNeed({
        projectId,
        opportunityId: row.id,
        actorRef: 'brain:regulated-role',
        blockedAction: `count the economics of "${row.title.slice(0, 120)}"`,
        whyItMatters:
          `This opening performs ${performs}. Its economics are not counted until a compliant position exists` +
          `${lacking ? `; the record says it lacks ${lacking}` : ''}${unstated ? `; nobody has stated ${unstated}` : ''}. ` +
          'It is assessed, not excluded: a compliant position, its own or an authorized licensed partner\'s, lets it count.',
        recommendedPath:
          'Establish what this role needs for its product and location, then hold it directly or operate through an ' +
          'authorized licensed partner under a written contract. Relabelling the role is not a position: it is judged by what it performs.',
        setupEffort: 'Research into the activity\'s requirements, then an agreement with a licensed partner.',
        nextStep: unstated
          ? `Research the ${unstated} requirements for this activity where the buyer is, and name licensed partners authorized to perform it.`
          : `Name an authorized licensed partner who holds ${lacking ?? 'what the role lacks'} and agree a contract with them.`,
        completionCondition:
          'The opening\'s record shows a compliant position: every requirement held, or an authorized licensed partner ' +
          'holding the licence under a contract that is in place.',
        requestKey: key,
      });
      if (raised.ok) need = raised.value;
      else refused = raised.reason;
    }

    let candidateId: string | null = null;
    if (need && !need.candidateId) {
      const candidate = await createCandidate({
        projectId,
        visibility: 'SHARED',
        title: `Compliant position for "${row.title.slice(0, 100)}"`,
        statement: positionQuestion({ title: row.title, buyingSignal: row.buying_signal }, assessment),
      });
      if (await setNeedCandidate(need.id, candidate.id)) candidateId = candidate.id;
    }
    pass.sought.push({ opportunityId: row.id, position: assessment.position, needId: need?.id ?? null, candidateId, refused });
  }
  return pass;
}
