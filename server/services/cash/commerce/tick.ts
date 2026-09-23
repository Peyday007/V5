/**
 * The commercial journey's share of the durable tick.
 *
 * Two things, both idempotent by rows and neither able to act on the world:
 *
 *   * conclude every running demand test whose own declared thresholds now
 *     give a verdict — arithmetic over recorded contacts and responses;
 *   * prepare a demand test for the opening `select.ts` chooses, when it can
 *     be formed from recorded facts alone and nothing is under way on it.
 *
 * Preparing writes a plan and contacts nobody. Everything after it is either a
 * person's authorization or a recorded act. The pass never grants itself
 * authority, never contacts anybody and never records money.
 */
import { getDb } from '../../../db/database.ts';
import { getCashMode } from '../../../repos/cashMode.ts';
import { commerceNow, listDemandTests } from '../../../repos/cashCommerce.ts';
import { concludeReadyTests, prepareDemandTest } from './demand.ts';
import { selectOpening } from './select.ts';

export interface CommercePass {
  concluded: number;
  prepared: string | null;
  /** Why nothing was prepared, when nothing was. */
  notPrepared: string | null;
}

export async function operateCommerce(projectId: string, now?: string): Promise<CommercePass> {
  const mode = await getCashMode(projectId);
  if (!mode) return { concluded: 0, prepared: null, notPrepared: 'No sprint.' };
  const tests = await listDemandTests(projectId);
  const concluded = await concludeReadyTests(projectId, tests);

  /*
   * One Brain-prepared test at a time, per sprint. A test is asking people for
   * their time; preparing a second one while the first has not been run would
   * hand a person a queue of outreach to perform rather than one decision.
   */
  const live = (await listDemandTests(projectId)).filter(
    (one) => one.state === 'PREPARED' || one.state === 'RUNNING',
  );
  if (live.length > 0) {
    return { concluded, prepared: null, notPrepared: 'A demand test is already live.' };
  }
  if (mode.state !== 'ACTIVE') {
    return { concluded, prepared: null, notPrepared: `The sprint is ${mode.state.toLowerCase()}; no new tests.` };
  }
  /*
   * A cheap question first. Selecting reads every live opening's card, and on
   * a sprint where no opening has a buyer, a route and an offer recorded —
   * which is production today — that is forty card reads every tick to learn
   * the same answer. One statement asks whether any opening could possibly be
   * testable, from the same two places the card reads (the column, or a
   * recorded fact beside it), and the full selection runs only when one could.
   * The briefing still derives the decisive gap in full whenever it is read.
   */
  if (!(await anyTestableCandidate(projectId))) {
    return {
      concluded,
      prepared: null,
      notPrepared: 'No live opening has a buyer, a route and an offer all recorded.',
    };
  }
  const selection = await selectOpening({ projectId, now: now ?? commerceNow() });
  const target = selection.selected;
  if (!target || !target.testable || target.inMotion) {
    return { concluded, prepared: null, notPrepared: selection.decisiveGap ?? 'Nothing is testable.' };
  }
  const made = await prepareDemandTest(
    {
      projectId,
      opportunityId: target.opportunityId,
      ownerUserId: target.ownerUserId,
      preparedBy: 'BRAIN',
      actorRef: 'brain:commerce',
    },
    target,
  );
  return made.ok
    ? { concluded, prepared: made.value.id, notPrepared: null }
    : { concluded, prepared: null, notPrepared: made.reason };
}

const ANSWERED = (column: string, field: string): string =>
  `((o.${column} IS NOT NULL AND TRIM(o.${column}) <> '') OR EXISTS (
     SELECT 1 FROM cash_card_facts f
      WHERE f.opportunity_id = o.id AND f.field = '${field}' AND TRIM(f.value) <> ''))`;

async function anyTestableCandidate(projectId: string): Promise<boolean> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT o.id FROM cash_opportunities o
      WHERE o.project_id = ?
        AND o.state IN ('DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING')
        AND ${ANSWERED('payer', 'payer')}
        AND ${ANSWERED('reachable_channel', 'access')}
        AND ${ANSWERED('offer_scope', 'offer')}
      LIMIT 1`,
    [projectId],
  );
  return rows.length > 0;
}
