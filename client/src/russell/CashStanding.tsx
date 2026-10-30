/**
 * Standing on the Cash page: what is actionable, what waits on what, what is
 * stopped and what would reopen it, and what was reconsidered.
 *
 * Every block here renders *inside* an existing `rs-cash-*` section (§36): the
 * actionable, dormant and reconsidered blocks inside the portfolio, the
 * blocker groups inside Brain's needs, and the research progress inside the
 * research detail. None adds a top-level section, and each renders for both
 * roles — the owner reads the owner's standing surface, a member reads the
 * frontier's, which the server built from the redacted per-piece standings.
 *
 * Nothing here derives a standing, a count or a sentence. The server composed
 * all of them; this file chooses which of two payloads to read and pages a
 * list. The reconsider control is offered where the server's capability and
 * the piece's own state both say yes, and otherwise is disabled with the
 * server's reason rather than removed (§35).
 */
import { useState } from 'react';
import { CashApi, type Placement } from '../lib/cashApi.ts';
import { decisionLines, explanationFor } from '../lib/cashDecision.ts';
import type { CashPage } from './cashPage.ts';
import type {
  BlockerGroup,
  ReconsiderEligibility,
  StandingHistoryEntry,
} from '../../../server/services/cash/standingSurface.ts';
import type { CashReopenCondition } from '../../../server/domain/types.ts';
import type { CashView } from '../../../server/services/cash/view.ts';

export const STANDING_LABEL: Record<string, string> = {
  ADVANCING: 'Moving',
  WAITING: 'Waiting',
  DORMANT: 'Stopped, can reopen',
  NOT_WORTH_PURSUING: 'Stopped',
  DONE: 'Done',
};

/** The page size of the actionable list, if the server did not send one. */
const DEFAULT_PAGE = 25;

/** One row the standing blocks render, from whichever payload this reader has. */
interface StandingRow {
  id: string;
  title: string;
  kind: string | null;
  sentence: string;
  keys: string[];
}

function rowsFor(page: CashPage, which: 'ACTIONABLE' | 'DORMANT'): StandingRow[] {
  const work = page.full?.myCurrentWork;
  if (work) {
    const list: Placement[] =
      (which === 'ACTIONABLE' ? work.actionable : work.dormant) ?? [];
    return list.map((placement) => {
      const standing = placement.standing;
      return {
        id: placement.opportunity.id,
        title: placement.opportunity.title,
        kind: standing?.kind ?? null,
        sentence: standing?.because ?? placement.because,
        keys:
          standing?.kind === 'WAITING'
            ? standing.on.map(String)
            : standing?.kind === 'DORMANT'
              ? standing.reopenWhen.map(String)
              : [],
      };
    });
  }
  const kinds =
    which === 'ACTIONABLE' ? new Set(['ADVANCING', 'WAITING']) : new Set(['DORMANT', 'NOT_WORTH_PURSUING']);
  return page.frontier.opportunities
    .filter((one) => one.standing && !one.standing.withheld && kinds.has(one.standing.kind ?? ''))
    .map((one) => ({
      id: one.id,
      title: one.title,
      kind: one.standing.kind,
      sentence: one.standing.sentence,
      keys: one.standing.keys,
    }));
}

function historyFor(page: CashPage, id: string): { entries: StandingHistoryEntry[]; total: number } {
  const history = page.full?.myCurrentWork.standingSurface?.history ?? page.frontier.standing?.history;
  return { entries: history?.byPiece[id] ?? [], total: history?.totals[id] ?? 0 };
}

/** The recorded standing changes for one piece, newest first. */
export function StandingHistory({ page, id }: { page: CashPage; id: string }): JSX.Element | null {
  const { entries, total } = historyFor(page, id);
  if (entries.length === 0) return null;
  return (
    <details className="rs-standing-history">
      <summary>
        Standing history ({total} {total === 1 ? 'change' : 'changes'} recorded
        {total > entries.length ? `, the latest ${entries.length} shown` : ''})
      </summary>
      <ul className="rs-standing-list">
        {entries.map((entry, index) => (
          <li key={`${entry.at}-${index}`}>
            <span className="rs-badge">{STANDING_LABEL[entry.kind] ?? entry.kind}</span>{' '}
            <span className="rs-item-meta">
              {new Date(entry.at).toLocaleString()}
              {entry.keys.length > 0 ? ` · ${entry.keys.join(', ')}` : ''}
            </span>
            {entry.because ? <p className="rs-item-meta">{entry.because}</p> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One piece's decision, in words: why, what binds it, what is missing, what reopens it. */
export function DecisionExplained({ page, id }: { page: CashPage; id: string }): JSX.Element | null {
  const explanation = explanationFor(page, id);
  if (!explanation) return null;
  return (
    <div className="rs-decision-explained" data-stance={explanation.stance}>
      <p className="rs-item-meta">
        <strong>{explanation.headline}</strong>
      </p>
      <dl className="rs-decision-lines">
        {decisionLines(explanation).map((line) => (
          <div key={line.label}>
            <dt className="rs-item-meta">{line.label}</dt>
            <dd>{line.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The standing sentence for one piece in the portfolio list. */
export function StandingLine({ page, id }: { page: CashPage; id: string }): JSX.Element | null {
  const placement = page.full?.myCurrentWork.placements.find((p) => p.opportunity.id === id);
  const shared = page.frontier.opportunities.find((one) => one.id === id)?.standing;
  const kind = placement?.standing?.kind ?? shared?.kind ?? null;
  const sentence = placement?.standing?.because ?? shared?.sentence ?? null;
  if (!sentence) return null;
  return (
    <div className="rs-standing">
      <p className="rs-item-meta">
        {kind ? <strong>{STANDING_LABEL[kind] ?? kind}. </strong> : null}
        {sentence}
      </p>
      <DecisionExplained page={page} id={id} />
      <StandingHistory page={page} id={id} />
    </div>
  );
}

/**
 * Every actionable piece, unbounded and paged.
 *
 * The five above are a highlight. This is the list — every piece that is moving
 * or waiting on something named, in the server's rank order. Paging is a view
 * of the list and never a limit on it: every page is reachable.
 */
export function ActionableNow({ page }: { page: CashPage }): JSX.Element {
  const rows = rowsFor(page, 'ACTIONABLE');
  const size = page.full?.myCurrentWork.standingSurface?.actionablePageSize ?? DEFAULT_PAGE;
  const [pageIndex, setPageIndex] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(pageIndex, pages - 1);
  const shown = rows.slice(current * size, current * size + size);
  const byKind = page.full?.myCurrentWork.byStanding ?? page.frontier.standing?.byKind;
  const withheld = page.full ? 0 : (page.frontier.standing?.withheld ?? 0);
  return (
    <div className="rs-cash-actionable">
      <h4>Actionable now</h4>
      <p className="rs-item-meta">
        {rows.length} {rows.length === 1 ? 'piece is' : 'pieces are'} moving or waiting on something
        named.
        {byKind
          ? ` ${byKind.ADVANCING} moving, ${byKind.WAITING} waiting, ${byKind.DORMANT} stopped with a ` +
            `way back, ${byKind.NOT_WORTH_PURSUING} stopped, ${byKind.DONE} done.`
          : ''}
        {withheld > 0
          ? ` ${withheld} ${withheld === 1 ? 'piece has' : 'pieces have'} been taken on by somebody; how ${
              withheld === 1 ? 'it is' : 'they are'
            } going is theirs.`
          : ''}
      </p>
      {rows.length === 0 ? (
        <p className="rs-hint">Nothing is moving or waiting right now.</p>
      ) : (
        <>
          <ul className="rs-standing-list">
            {shown.map((row) => (
              <li key={row.id} className="rs-group">
                <p className="rs-item-title">{row.title}</p>
                <p className="rs-badge">{row.kind ? (STANDING_LABEL[row.kind] ?? row.kind) : '—'}</p>
                <p className="rs-decision-why">{row.sentence}</p>
                <DecisionExplained page={page} id={row.id} />
                <StandingHistory page={page} id={row.id} />
              </li>
            ))}
          </ul>
          {pages > 1 ? (
            <p className="rs-actions rs-standing-pager">
              <button type="button" disabled={current === 0} onClick={() => setPageIndex(current - 1)}>
                Previous
              </button>{' '}
              <span className="rs-item-meta">
                Page {current + 1} of {pages} · {current * size + 1}–
                {Math.min(rows.length, current * size + size)} of {rows.length}
              </span>{' '}
              <button
                type="button"
                disabled={current >= pages - 1}
                onClick={() => setPageIndex(current + 1)}
              >
                Next
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The reconsider control: offered where the server allows, disabled with its reason elsewhere. */
export function ReconsiderControl({
  page,
  id,
  onChanged,
}: {
  page: CashPage;
  id: string;
  onChanged(): void;
}): JSX.Element {
  const eligibility: ReconsiderEligibility | undefined =
    page.full?.myCurrentWork.standingSurface?.reconsider[id];
  const capable = page.capabilities.mayReconsider === true;
  const enabled = capable && eligibility?.allowed === true;
  const why = !capable
    ? (page.capabilities.reconsiderRefusal ?? 'This page was not told whether reconsidering is allowed here.')
    : (eligibility?.reason ?? 'The server sent no reading of whether this piece can be reconsidered.');
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await CashApi.act(id, 'reconsider', {
        reason,
        ...(eligibility?.conditionId ? { conditionId: eligibility.conditionId } : {}),
      });
      setAsking(false);
      setReason('');
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rs-actions rs-reconsider">
      {asking && enabled ? (
        <>
          <label>
            Why is this worth looking at again?
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <button type="button" disabled={busy || reason.trim() === ''} onClick={() => void run()}>
            Reconsider
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" disabled={!enabled} onClick={() => setAsking(true)}>
          Reconsider
        </button>
      )}
      <p className="rs-hint">{why}</p>
      {problem ? <p className="rs-error">{problem}</p> : null}
    </div>
  );
}

function ReopenConditions({ conditions }: { conditions: CashReopenCondition[] }): JSX.Element | null {
  if (conditions.length === 0) return null;
  return (
    <ul className="rs-standing-list rs-reopen-conditions">
      {conditions.map((condition) => (
        <li key={condition.id} className="rs-item-meta">
          {condition.blockerKey} — recorded from {condition.recordedFrom.toLowerCase().replace(/_/g, ' ')}
          {condition.triggeredAt ? `; met ${new Date(condition.triggeredAt).toLocaleString()}` : '; not met yet'}
        </li>
      ))}
    </ul>
  );
}

/** The stopped pieces, each with what would reopen it, and the control. */
export function DormantPieces({ page, onChanged }: { page: CashPage; onChanged(): void }): JSX.Element {
  const rows = rowsFor(page, 'DORMANT');
  const surface = page.full?.myCurrentWork.standingSurface;
  const reopenOn = surface?.reopenOn ?? page.frontier.standing?.reopenOn ?? [];
  return (
    <div className="rs-cash-dormant">
      <h4>Stopped, and what would reopen them</h4>
      {rows.length === 0 ? (
        <p className="rs-hint">Nothing is stopped.</p>
      ) : (
        <>
          {reopenOn.length > 0 ? (
            <ul className="rs-standing-list rs-reopen-groups">
              {reopenOn.map((one) => (
                <li key={one.key} className="rs-item-meta">
                  {one.sentence} {one.noticed}
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="rs-standing-list">
            {rows.map((row) => (
              <li key={row.id} className="rs-group rs-dormant-piece">
                <p className="rs-item-title">{row.title}</p>
                <p className="rs-badge">{row.kind ? (STANDING_LABEL[row.kind] ?? row.kind) : '—'}</p>
                <p className="rs-decision-why">{row.sentence}</p>
                {row.keys.length > 0 ? (
                  <p className="rs-item-meta">Reopens when: {row.keys.join(', ')}</p>
                ) : null}
                <ReopenConditions conditions={surface?.reopenConditions[row.id] ?? []} />
                <StandingHistory page={page} id={row.id} />
                <ReconsiderControl page={page} id={row.id} onChanged={onChanged} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  ADVANCED: 'moving now',
  WAITING: 'waiting now',
  DORMANT_AGAIN: 'stopped again',
  UNKNOWN: 'not told',
};

/** What was reconsidered in the window, and where each piece stands now. */
export function ReconsideredRecently({ page }: { page: CashPage }): JSX.Element {
  const entries =
    page.full?.myCurrentWork.standingSurface?.reconsidered ?? page.frontier.standing?.reconsidered ?? [];
  return (
    <div className="rs-cash-reconsidered">
      <h4>Reconsidered recently</h4>
      {entries.length === 0 ? (
        <p className="rs-hint">Nothing was reconsidered in the last fourteen days.</p>
      ) : (
        <ul className="rs-standing-list">
          {entries.map((entry) => (
            <li key={`${entry.opportunityId}-${entry.at}`} className="rs-item-meta">
              <strong>{entry.title}</strong> — {new Date(entry.at).toLocaleString()}, by{' '}
              {entry.via.toLowerCase().replace(/_/g, ' ')}
              {entry.blockerKey ? ` (${entry.blockerKey})` : ''}; {OUTCOME_LABEL[entry.outcome] ?? entry.outcome}.
              {entry.summary ? ` ${entry.summary}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "17 openings wait on CAPABILITY:SEND_A_MESSAGE", grouped by the one fact that would move them. */
export function SharedBlockers({ page }: { page: CashPage }): JSX.Element {
  const groups: BlockerGroup[] =
    page.full?.myCurrentWork.standingSurface?.waitingOn ?? page.frontier.standing?.waitingOn ?? [];
  return (
    <div className="rs-cash-blockers">
      <h4>What openings are waiting on</h4>
      {groups.length === 0 ? (
        <p className="rs-hint">No opening is waiting on a shared fact.</p>
      ) : (
        <ul className="rs-standing-list">
          {groups.map((one) => (
            <li key={one.key} className="rs-group">
              <p className="rs-item-title">{one.sentence}</p>
              <p className="rs-item-meta">
                Satisfied when {one.satisfiedWhen}. {one.noticed}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where the deep dives are, counted by the dive's own refusal per piece. */
export function ResearchProgressBlock({ page }: { page: CashPage }): JSX.Element {
  const progress = page.frontier.standing?.refinement;
  return (
    <div className="rs-cash-refinement">
      <h4>Qualification research</h4>
      {!progress ? (
        <p className="rs-hint">This page was not sent a reading of the deep dives.</p>
      ) : (
        <>
          <p className="rs-item-meta">
            {progress.sprint.sentence} {progress.evaluating} {progress.evaluating === 1 ? 'piece is' : 'pieces are'}{' '}
            still being evaluated.
          </p>
          {progress.byRefusal.length > 0 ? (
            <ul className="rs-standing-list">
              {progress.byRefusal.map((one) => (
                <li key={one.kind} className="rs-item-meta">
                  {one.count} — {one.label}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * What the goal screen did, in words, and the small openings that survive the
 * live goal's limits. Counts come from rows; a count nothing has recorded says
 * so rather than reading as a measurement.
 */
export function ScreeningReading({ page }: { page: CashPage }): JSX.Element | null {
  // The client's hand-written payload type predates this field; the server sends it.
  const screening = (page.full?.myCurrentWork as { screening?: CashView['myCurrentWork']['screening'] } | undefined)?.screening;
  if (!screening) return null;
  const { metrics, candidateSet } = screening;
  const decided = metrics.decisions.REJECT + metrics.decisions.HOLD + metrics.decisions.PRIORITIZE;
  return (
    <div className="rs-screening">
      <h4>What the goal screen did</h4>
      <p className="rs-item-meta">
        {decided === 0
          ? 'No decision has been recorded yet. '
          : `${metrics.decisions.REJECT} rejected, ${metrics.decisions.HOLD} held, ${metrics.decisions.PRIORITIZE} prioritized. `}
        {metrics.questionsSkipped} {metrics.questionsSkipped === 1 ? 'question was' : 'questions were'} skipped because no
        answer could change the decision; {metrics.research.needsWithdrawn} need(s) and {metrics.research.missionsCancelled}{' '}
        mission(s) were released; {metrics.claudeJobsAvoided.total} research job(s) were avoided.
      </p>
      {metrics.notes.map((note) => (
        <p key={note} className="rs-hint">{note}</p>
      ))}
      {candidateSet ? (
        <p className="rs-item-meta">
          {candidateSet.note} {candidateSet.excluded.length > 0 ? `${candidateSet.excluded.length} left out for breaking a limit of the goal.` : ''}
        </p>
      ) : (
        <p className="rs-hint">No live goal, so no candidate set was built.</p>
      )}
    </div>
  );
}
